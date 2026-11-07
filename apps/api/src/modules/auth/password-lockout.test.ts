import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { AuthService } from './auth.service';

function makeAttemptRepo(rows: any[]) {
  const match = (row: any, where: any) => {
    for (const key of ['accountKey', 'method', 'status', 'reason']) {
      if (where[key] !== undefined && row[key] !== where[key]) return false;
    }
    if ('tenantId' in where) {
      const wanted = where.tenantId;
      if (wanted && typeof wanted === 'object' && wanted._type === 'isNull') {
        if (row.tenantId !== null) return false;
      } else if (row.tenantId !== wanted) return false;
    }
    if (where.createdAt) {
      const value = where.createdAt.value ?? where.createdAt._value;
      if (new Date(row.createdAt) <= new Date(value)) return false;
    }
    return true;
  };
  return {
    create: (value: any) => ({ ...value }),
    save: async (value: any) => { const row = { ...value, id: rows.length + 1, createdAt: value.createdAt ?? new Date() }; rows.push(row); return row; },
    findOne: async ({ where, order }: any) => {
      const found = rows.filter((row) => match(row, where));
      if (order?.createdAt === 'DESC') found.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      return found[0] ?? null;
    },
    count: async ({ where }: any) => rows.filter((row) => match(row, where)).length,
  };
}

async function fixture() {
  const service: any = Object.create(AuthService.prototype);
  const user = {
    id: 7, tenantId: 1, name: '管理员', loginAccount: 'admin', role: 'superadmin', status: 'active',
    passwordHash: await bcrypt.hash('correct-password', 4),
  };
  const attempts: any[] = [];
  const logs: any[] = [];
  const notifications: any[] = [];
  service.userRepo = { findOne: async () => user };
  service.loginAttemptRepo = makeAttemptRepo(attempts);
  service.systemLogRepo = {
    create: (value: any) => value,
    save: async (value: any) => { logs.push(value); return value; },
    findOne: async ({ where }: any) => logs.find((row) => row.fingerprint === where.fingerprint) ?? null,
  };
  service.moduleRef = { get: () => ({ notifyUser: async (input: any) => { notifications.push(input); } }) };
  service.accessService = { userIdsWithPermission: async () => [99] };
  service.issueTokens = async () => ({ accessToken: 'access-token' });
  service.assertWebAdminAccess = async () => {};
  service.assertTenantActive = async () => {};
  service.logger = { warn() {} };
  return { service, attempts, logs, notifications };
}

const wrong = { account: 'Admin', password: 'wrong-password' };
const good = { account: 'Admin', password: 'correct-password' };

const statusOf = (error: any) => error.status ?? error.getStatus?.() ?? error.response?.statusCode;

test('连续5次密码错误后第6次返回429、retryAfterSeconds正确，且锁定期间正确密码也不校验', async () => {
  const { service, attempts, logs, notifications } = await fixture();
  const context = { ipAddress: '1.2.3.4', userAgent: 'Mozilla/5.0 Chrome/120 Windows NT' };
  for (let i = 0; i < 5; i += 1) {
    await assert.rejects(() => service.adminLogin(wrong, context), (error: any) => statusOf(error) === 401);
  }
  assert.equal(attempts.filter((row) => row.status === 'failed').length, 5);
  assert.equal(logs.filter((row) => row.action === 'password_lockout').length, 1);
  assert.equal(notifications.length, 1, '触发锁定只通知一次');
  assert.match(notifications[0].title, /密码登录异常/);
  assert.match(notifications[0].payload.content, /Admin/);
  assert.match(notifications[0].payload.content, /IP 1\.2\.3\.4/);
  assert.match(notifications[0].payload.content, /Chrome\/Windows/);

  let locked: any;
  await assert.rejects(() => service.adminLogin(good), (error: any) => { locked = error; return statusOf(error) === 429; });
  const body = locked.response;
  assert.equal(body.message, '密码错误次数过多，请 15 分钟后再试');
  assert.ok(body.retryAfterSeconds > 0 && body.retryAfterSeconds <= 900, `retryAfterSeconds=${body.retryAfterSeconds}`);
  assert.equal(attempts.filter((row) => row.status === 'success').length, 0);
  assert.equal(notifications.length, 1, '锁定期间不重复通知');
});

test('成功登录后失败计数清零', async () => {
  const { service, attempts } = await fixture();
  for (let i = 0; i < 4; i += 1) {
    await assert.rejects(() => service.adminLogin(wrong), (error: any) => statusOf(error) === 401);
  }
  assert.deepEqual(await service.adminLogin(good), { accessToken: 'access-token' });
  assert.ok(attempts.some((row) => row.status === 'success'), '成功登录写一条 success 作为清零水位');
  await assert.rejects(() => service.adminLogin(wrong), (error: any) => statusOf(error) === 401, '旧失败不计入新窗口');
});
