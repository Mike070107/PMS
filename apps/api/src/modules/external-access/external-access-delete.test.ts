import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { PERMISSION_KEY } from '../../common/require-permission.decorator';
import { ExternalAccessController } from './external-access.controller';
import { ExternalAccessService } from './external-access.service';
import { hashGatewaySecret } from './lan-gateway-security';

const DEVICE_TOKEN = 'a'.repeat(64);

type AppRow = {
  id: number;
  tenantId: number;
  agentId: number | null;
  name: string;
  enabled: boolean;
  publicHostname: string;
  cloudflareAppId?: string | null;
  cloudflareDnsRecordId?: string | null;
};

function fixture(options: { provider?: 'domestic' | 'cloudflare'; apps?: AppRow[]; agentEnabled?: boolean } = {}) {
  process.env.EXTERNAL_ACCESS_PROVIDER = options.provider ?? 'domestic';
  const rows: AppRow[] = options.apps ?? [
    { id: 6, tenantId: 1, agentId: 3, name: '临时只读数据库导出', enabled: false, publicHostname: 'db-export.prsznh.cn' },
    { id: 1, tenantId: 1, agentId: 3, name: '用友财务系统', enabled: true, publicHostname: 'caiwu.prsznh.cn' },
  ];
  const agent = {
    id: 3,
    tenantId: 1,
    deviceKey: 'lan-c73019f6f5daa4be2633',
    tokenHash: hashGatewaySecret(DEVICE_TOKEN),
    enabled: options.agentEnabled ?? true,
    desiredRevision: 17,
    appliedRevision: 17,
  };
  const deletedWhere: Array<{ id: number; tenantId: number }> = [];
  const revoked: Array<{ tenantId: number; appId: number }> = [];
  const cloudflareRemovals: Array<{ hostname: string; remaining: number[] }> = [];
  const service = Object.create(ExternalAccessService.prototype) as any;
  service.appRepo = {
    findOne: async ({ where }: any) =>
      rows.find(
        (row) =>
          row.id === where.id &&
          row.tenantId === where.tenantId &&
          (where.agentId === undefined || row.agentId === where.agentId),
      ) ?? null,
    find: async ({ where }: any) => rows.filter((row) => row.tenantId === where.tenantId),
    delete: async (where: { id: number; tenantId: number }) => {
      deletedWhere.push(where);
      const index = rows.findIndex((row) => row.id === where.id && row.tenantId === where.tenantId);
      if (index >= 0) rows.splice(index, 1);
    },
    save: async (row: AppRow) => row,
  };
  service.agentRepo = {
    findOne: async ({ where }: any) => {
      if (where.deviceKey !== undefined) return where.deviceKey === agent.deviceKey ? agent : null;
      return where.id === agent.id && where.tenantId === agent.tenantId ? agent : null;
    },
    save: async (saved: typeof agent) => saved,
  };
  service.accessService = {
    revokeExternalAppFromRoles: async (tenantId: number, appId: number) => {
      // 记录调用顺序：授权必须在记录删除之后才摘，但一定要摘。
      revoked.push({ tenantId, appId });
    },
  };
  service.cloudflare = {
    removeApp: async (app: AppRow, remaining: AppRow[]) => {
      cloudflareRemovals.push({ hostname: app.publicHostname, remaining: remaining.map((item) => item.id) });
    },
  };
  const user = { id: 9, tenantId: 1 } as any;
  return { service, user, agent, rows, deletedWhere, revoked, cloudflareRemovals };
}

test('后台删除接口挂着设置页的编辑权限，不能裸奔', () => {
  assert.deepEqual(Reflect.getMetadata(PERMISSION_KEY, ExternalAccessController.prototype.remove), {
    items: [{ pageKey: 'settings', action: 'edit' }],
  });
});

test('后台删除内网应用后，记录消失、角色授权被摘、代理拿到新修订号', async () => {
  const f = fixture();
  const result = await f.service.remove(6, f.user);

  assert.deepEqual(result, { ok: true, id: 6, name: '临时只读数据库导出' });
  assert.deepEqual(f.deletedWhere, [{ id: 6, tenantId: 1 }]);
  assert.deepEqual(f.rows.map((row) => row.id), [1]);
  assert.deepEqual(f.revoked, [{ tenantId: 1, appId: 6 }]);
  // 不下发新修订号，现场 frpc 会继续监听这条已删除的隧道端口。
  assert.equal(f.agent.desiredRevision, 18);
});

test('后台可以删掉仍在启用中的应用（管理员有权收回访问）', async () => {
  const f = fixture();
  const result = await f.service.remove(1, f.user);
  assert.equal(result.name, '用友财务系统');
  assert.deepEqual(f.revoked, [{ tenantId: 1, appId: 1 }]);
});

test('删除不存在的应用提示应用不存在，不动授权', async () => {
  const f = fixture();
  await assert.rejects(() => f.service.remove(99, f.user), /内网应用不存在/);
  assert.deepEqual(f.deletedWhere, []);
  assert.deepEqual(f.revoked, []);
});

test('删除跨企业的应用一样当作不存在，不会越界', async () => {
  const f = fixture();
  await assert.rejects(() => f.service.remove(6, { id: 9, tenantId: 2 } as any), /内网应用不存在/);
  assert.deepEqual(f.rows.map((row) => row.id), [6, 1]);
});

test('Cloudflare 模式先收走公网入口再删记录，剩余应用重建 ingress', async () => {
  const f = fixture({ provider: 'cloudflare' });
  await f.service.remove(6, f.user);
  assert.deepEqual(f.cloudflareRemovals, [{ hostname: 'db-export.prsznh.cn', remaining: [1] }]);
  assert.deepEqual(f.deletedWhere, [{ id: 6, tenantId: 1 }]);
});

test('助手只能删本机已停用的应用', async () => {
  const f = fixture();
  const result = await f.service.agentRemoveApp(f.agent.deviceKey, DEVICE_TOKEN, 6);
  assert.deepEqual(result, { ok: true, id: 6, name: '临时只读数据库导出' });
  assert.deepEqual(f.revoked, [{ tenantId: 1, appId: 6 }]);
});

test('助手删不掉仍在启用的应用，必须先由管理员停用', async () => {
  const f = fixture();
  await assert.rejects(
    () => f.service.agentRemoveApp(f.agent.deviceKey, DEVICE_TOKEN, 1),
    /仍在启用中/,
  );
  assert.deepEqual(f.deletedWhere, []);
  assert.deepEqual(f.rows.map((row) => row.id), [6, 1]);
});

test('助手删不掉别的电脑上的应用', async () => {
  const f = fixture({
    apps: [{ id: 8, tenantId: 1, agentId: 4, name: '别人的应用', enabled: false, publicHostname: 'other.prsznh.cn' }],
  });
  await assert.rejects(
    () => f.service.agentRemoveApp(f.agent.deviceKey, DEVICE_TOKEN, 8),
    /这台电脑上没有这个内网应用/,
  );
  assert.deepEqual(f.deletedWhere, []);
});

test('设备令牌不对时删除请求直接被拒', async () => {
  const f = fixture();
  await assert.rejects(
    () => f.service.agentRemoveApp(f.agent.deviceKey, 'b'.repeat(64), 6),
    /代理设备凭据无效/,
  );
  assert.deepEqual(f.deletedWhere, []);
});

test('代理被停用后，它的删除请求也不再受理', async () => {
  const f = fixture({ agentEnabled: false });
  await assert.rejects(
    () => f.service.agentRemoveApp(f.agent.deviceKey, DEVICE_TOKEN, 6),
    /代理设备凭据无效/,
  );
  assert.deepEqual(f.deletedWhere, []);
});
