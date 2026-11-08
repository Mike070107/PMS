import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { TelemetryService } from './telemetry.service';
import { PageViews1794200000000 } from '../../migrations/1794200000000-PageViews';
import { LoginAttempts1794200000001 } from '../../migrations/1794200000001-LoginAttempts';
import { maskAccount, loginFailureReasonOf } from './login-attempt.util';
import { ObservabilityService } from '../observability/observability.service';
import { loginAttemptOf } from '../observability/observability.interceptor';

const runner = (pg: PGlite): any => ({ query: (sql: string, params?: any[]) => pg.query(sql, params) });

async function fixture() {
  const pg = new PGlite();
  for (const migration of [new PageViews1794200000000(), new LoginAttempts1794200000001()]) await migration.up(runner(pg));
  const query = async (sql: string, params?: any[]) => (await pg.query(sql, params)).rows;
  const service = new TelemetryService({ query } as any, { findOne: async () => ({ name: '张三' }) } as any, { query } as any);
  return { pg, service, query };
}

test('迁移 page_views/login_attempts 可 up/down，页面写入按用户+路径+同秒去重且跳过 /login、/intro', async () => {
  const f = await fixture();
  try {
    const at = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString();
    const user: any = { id: 1, tenantId: 1 };
    const req: any = { ip: '10.0.0.8', headers: { 'user-agent': 'UA-test' } };
    const first = await f.service.recordPageViews(user, { views: [
      { path: '/bills?tab=1', at },
      { path: '/fees', at },
      { path: '/login', at },
      { path: '/intro', at },
    ] }, req);
    assert.deepEqual(first, { ok: true, received: 4, recorded: 2, deduped: 0, skipped: 2 });
    const rows: any[] = await f.query('SELECT user_name,path,page_key,ip,user_agent,created_at FROM page_views ORDER BY path');
    assert.deepEqual(rows.map((r) => [r.user_name, r.path, r.page_key, r.ip, r.user_agent]), [['张三', '/bills', 'bills', '10.0.0.8', 'UA-test'], ['张三', '/fees', 'fees', '10.0.0.8', 'UA-test']]);
    assert.equal(new Date(rows[0].created_at).getTime() % 1000, 0, 'created_at 必须截断到秒');
    const second = await f.service.recordPageViews(user, { views: [{ path: '/bills', at }, { path: '/fees', at }] }, req);
    assert.deepEqual(second, { ok: true, received: 2, recorded: 0, deduped: 2, skipped: 0 });
    assert.equal(((await f.query('SELECT COUNT(*)::int AS n FROM page_views')) as any[])[0].n, 2);
    // 迁移可 down
    await new LoginAttempts1794200000001().down(runner(f.pg));
    await new PageViews1794200000000().down(runner(f.pg));
    await assert.rejects(f.pg.query('SELECT * FROM page_views'));
  } finally { await f.pg.close(); }
});

test('页面使用统计按北京时间天聚合、topPages/topUsers 排序与 topPage 正确', async () => {
  const f = await fixture();
  try {
    const insert = (tenantId: number, userId: number, userName: string, path: string, at: string) =>
      f.query(`INSERT INTO page_views(tenant_id,user_id,user_name,path,page_key,created_at) VALUES($1,$2,$3,$4,$5,$6)`, [tenantId, userId, userName, path, null, at]);
    // 北京时间 11-05 / 11-06；tenant2 数据不得混入
    await insert(1, 1, '张三', '/bills', '2026-11-05T02:00:00Z');
    await insert(1, 1, '张三', '/bills', '2026-11-05T02:01:00Z');
    await insert(1, 1, '张三', '/fees', '2026-11-06T02:00:00Z');
    await insert(1, 2, '李四', '/logs', '2026-11-05T03:00:00Z');
    await insert(2, 3, '外部', '/bills', '2026-11-05T02:00:00Z');
    const out: any = await f.service.pageUsage({ id: 1, tenantId: 1 } as any, { from: '2026-11-01', to: '2026-11-07' } as any);
    assert.equal(out.totalViews, 4);
    assert.equal(out.uniqueUsers, 2);
    assert.deepEqual(out.days, [{ day: '2026-11-05', views: 3, users: 2 }, { day: '2026-11-06', views: 1, users: 1 }]);
    assert.deepEqual(out.topPages.map((p: any) => [p.path, p.name, p.views, p.users]), [['/bills', '账单与待缴', 2, 1], ['/fees', '物业费', 1, 1], ['/logs', '日志', 1, 1]]);
    assert.deepEqual(out.topUsers.map((u: any) => [u.userId, u.name, u.views, u.pages, u.topPage]), [[1, '张三', 3, 2, '/bills'], [2, '李四', 1, 1, '/logs']]);
    assert.match(out.topUsers[0].topPageName, /账单/);
    // 时间窗排除
    const narrow: any = await f.service.pageUsage({ id: 1, tenantId: 1 } as any, { from: '2026-11-06', to: '2026-11-06' } as any);
    assert.deepEqual([narrow.totalViews, narrow.uniqueUsers, narrow.days.length], [1, 1, 1]);
    await assert.rejects(f.service.pageUsage({ id: 1, tenantId: 1 } as any, { from: '2026-11-08', to: '2026-11-01' } as any), /日期/);
  } finally { await f.pg.close(); }
});

test('页面使用下钻：按 path 查逐条 events（分页/总数/字段）与 users 聚合', async () => {
  const f = await fixture();
  try {
    const insert = (tenantId: number, userId: number, userName: string, path: string, at: string, ip: string | null = '1.1.1.1') =>
      f.query(`INSERT INTO page_views(tenant_id,user_id,user_name,path,page_key,created_at,ip) VALUES($1,$2,$3,$4,$5,$6,$7)`, [tenantId, userId, userName, path, null, at, ip]);
    await insert(1, 1, '张三', '/bills', '2026-11-05T02:00:00Z');
    await insert(1, 1, '张三', '/bills', '2026-11-05T02:01:00Z');
    await insert(1, 2, '李四', '/bills', '2026-11-06T03:00:00Z');
    await insert(1, 2, '李四', '/fees', '2026-11-06T04:00:00Z');
    await insert(2, 3, '外部', '/bills', '2026-11-05T02:00:00Z');
    const user: any = { id: 1, tenantId: 1 };
    const base: any = { from: '2026-11-01', to: '2026-11-07', path: '/bills' };
    const first: any = await f.service.pageUsageDrilldown(user, { ...base, pageSize: 2 } as any);
    assert.deepEqual(Object.keys(first).sort(), ['page', 'pageSize', 'rows', 'total']);
    assert.deepEqual([first.total, first.page, first.pageSize, first.rows.length], [3, 1, 2, 2]);
    assert.deepEqual(first.rows.map((r: any) => [r.userId, r.userName, r.path, r.pageName, r.ip]), [
      [2, '李四', '/bills', '账单与待缴', '1.1.1.1'],
      [1, '张三', '/bills', '账单与待缴', '1.1.1.1'],
    ]);
    assert.ok(first.rows.every((r: any) => r.at.endsWith('+08:00')), '明细时间必须返回北京时间 ISO');
    assert.equal(first.rows[0].at, '2026-11-06T11:00:00+08:00');
    const second: any = await f.service.pageUsageDrilldown(user, { ...base, page: 2, pageSize: 2 } as any);
    assert.deepEqual([second.total, second.rows.length, second.rows[0].at], [3, 1, '2026-11-05T10:00:00+08:00']);
    const users: any = await f.service.pageUsageDrilldown(user, { ...base, groupBy: 'users' } as any);
    assert.deepEqual([users.total, users.rows.length], [2, 2]);
    assert.deepEqual(users.rows, [
      { userId: 1, userName: '张三', views: 2, lastAt: '2026-11-05T10:01:00+08:00' },
      { userId: 2, userName: '李四', views: 1, lastAt: '2026-11-06T11:00:00+08:00' },
    ]);
  } finally { await f.pg.close(); }
});

test('页面使用下钻：按 userId 查 pages 聚合；未传 path/userId 时按 groupBy 返回全部聚合', async () => {
  const f = await fixture();
  try {
    const insert = (tenantId: number, userId: number, userName: string, path: string, at: string) =>
      f.query(`INSERT INTO page_views(tenant_id,user_id,user_name,path,page_key,created_at) VALUES($1,$2,$3,$4,$5,$6)`, [tenantId, userId, userName, path, null, at]);
    await insert(1, 1, '张三', '/bills', '2026-11-05T02:00:00Z');
    await insert(1, 1, '张三', '/bills', '2026-11-05T02:01:00Z');
    await insert(1, 1, '张三', '/fees', '2026-11-06T02:00:00Z');
    await insert(1, 2, '李四', '/logs', '2026-11-05T03:00:00Z');
    await insert(2, 3, '外部', '/bills', '2026-11-05T02:00:00Z');
    const user: any = { id: 1, tenantId: 1 };
    const base: any = { from: '2026-11-01', to: '2026-11-07' };
    const pages: any = await f.service.pageUsageDrilldown(user, { ...base, userId: 1, groupBy: 'pages' } as any);
    assert.deepEqual([pages.total, pages.rows.length], [2, 2]);
    assert.deepEqual(pages.rows, [
      { path: '/bills', pageName: '账单与待缴', views: 2, lastAt: '2026-11-05T10:01:00+08:00' },
      { path: '/fees', pageName: '物业费', views: 1, lastAt: '2026-11-06T10:00:00+08:00' },
    ]);
    const allUsers: any = await f.service.pageUsageDrilldown(user, { ...base, groupBy: 'users' } as any);
    assert.equal(allUsers.total, 2);
    assert.deepEqual(allUsers.rows.map((r: any) => [r.userId, r.views]), [[1, 3], [2, 1]]);
    const allPages: any = await f.service.pageUsageDrilldown(user, { ...base, groupBy: 'pages' } as any);
    assert.equal(allPages.total, 3);
    assert.deepEqual(allPages.rows.map((r: any) => [r.path, r.views]), [['/bills', 2], ['/fees', 1], ['/logs', 1]]);
    const events: any = await f.service.pageUsageDrilldown(user, { ...base } as any);
    assert.deepEqual([events.total, events.rows.length, events.pageSize], [4, 4, 20], '默认 groupBy=events、pageSize=20');
    assert.ok(!events.rows.some((r: any) => r.userId === 3), '其他公司数据不得混入');
  } finally { await f.pg.close(); }
});

test('页面使用下钻参数校验：默认近7天、pageSize≤100、非法 page/groupBy/路径/用户/日期拒绝', async () => {
  const f = await fixture();
  try {
    await f.query(`INSERT INTO page_views(tenant_id,user_id,user_name,path,page_key,created_at) VALUES(1,1,'张三','/today',null,$1)`, [new Date().toISOString()]);
    const user: any = { id: 1, tenantId: 1 };
    const out: any = await f.service.pageUsageDrilldown(user, {} as any);
    assert.deepEqual([out.page, out.pageSize], [1, 20]);
    assert.equal(out.total, 1, '不传 from/to 默认近 7 天');
    assert.deepEqual(out.rows.map((r: any) => r.path), ['/today']);
    await assert.rejects(f.service.pageUsageDrilldown(user, { pageSize: 101 } as any), /每页条数/);
    await assert.rejects(f.service.pageUsageDrilldown(user, { page: 0 } as any), /页码/);
    await assert.rejects(f.service.pageUsageDrilldown(user, { groupBy: 'bad' } as any), /groupBy/);
    await assert.rejects(f.service.pageUsageDrilldown(user, { path: 'bills' } as any), /路径/);
    await assert.rejects(f.service.pageUsageDrilldown(user, { userId: 0 } as any), /用户ID/);
    await assert.rejects(f.service.pageUsageDrilldown(user, { from: '2026-11-08', to: '2026-11-01' } as any), /日期/);
    await assert.rejects(f.service.pageUsageDrilldown(user, { from: '2026-13-01', to: '2026-11-07' } as any), /日期/);
    await assert.rejects(f.service.pageUsageDrilldown({ id: 1, tenantId: null } as any, {} as any), /公司/);
  } finally { await f.pg.close(); }
});

test('登录历史查询 login_attempts：status 过滤、失败原因/方式/脱敏账号、未知租户失败可见', async () => {
  const f = await fixture();
  try {
    const insert = (tenantId: number | null, userId: number | null, name: string | null, status: string, reason: string | null, method: string, at: string, account: string | null) =>
      f.query(`INSERT INTO login_attempts(tenant_id,user_id,user_name,account_masked,ip,user_agent,method,status,reason,message,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [tenantId, userId, name, account, '1.2.3.4', 'UA', method, status, reason, reason ? '文案' : '登录成功', at]);
    await insert(1, 1, '张三', 'success', null, 'password', '2026-11-05T01:00:00Z', 'ad***in');
    await insert(1, null, null, 'failed', 'no_permission', 'wechat', '2026-11-06T02:00:00Z', 'wx***01');
    await insert(null, null, null, 'failed', 'invalid_credentials', 'password', '2026-11-05T03:00:00Z', '13****5678');
    const failed: any[] = await f.service.loginHistory({ id: 1, tenantId: 1 } as any, { from: '2026-11-01', to: '2026-11-07', status: 'failed' } as any);
    assert.equal(failed.length, 2, '本租户失败与未知租户失败都要可见');
    assert.deepEqual(failed.map((r) => [r.status, r.reason, r.reasonText, r.method]), [['failed', 'no_permission', '无后台页面权限', 'wechat'], ['failed', 'invalid_credentials', '账号或密码错误', 'password']]);
    assert.ok(failed.every((r) => r.at.endsWith('+08:00')), '时间必须返回北京时间 ISO');
    assert.equal(failed[1].accountMasked, '13****5678');
    assert.equal((await f.service.loginHistory({ id: 1, tenantId: 1 } as any, { from: '2026-11-01', to: '2026-11-07', status: 'success' } as any)).length, 1);
    const all: any[] = await f.service.loginHistory({ id: 1, tenantId: 1 } as any, { from: '2026-11-01', to: '2026-11-07', limit: 2 } as any);
    assert.equal(all.length, 2);
  } finally { await f.pg.close(); }
});

test('登录尝试由既有登录审计旁路写入：失败原因枚举、账号脱敏、不写密码', async () => {
  let savedAttempt: any = null, savedLog: any = null;
  const logRepo: any = { save: async (row: any) => { savedLog = row; return row; }, create: (x: any) => x };
  const attemptRepo: any = { create: (x: any) => x, save: async (row: any) => { savedAttempt = row; return row; } };
  const userRepo: any = { findOne: async () => ({ id: 7, tenantId: 1, name: '张三' }) };
  const service: any = new ObservabilityService(logRepo, {} as any, userRepo, {} as any, {} as any, {} as any, {} as any, attemptRepo);
  await service.recordLogin({ tenantId: null, source: 'admin-web', action: 'web_password_login', success: false, actorUserId: null, account: '13812345678', ipAddress: '1.2.3.4', userAgent: 'UA', statusCode: 401, durationMs: 12, message: 'invalid account or password' });
  await new Promise((r) => setImmediate(r));
  assert.equal(savedAttempt.status, 'failed');
  assert.equal(savedAttempt.reason, 'invalid_credentials');
  assert.equal(savedAttempt.accountMasked, '138****5678');
  assert.equal(savedAttempt.method, 'password');
  assert.ok(!JSON.stringify(savedAttempt).includes('13812345678'), '登录尝试不得写明文账号');
  assert.equal(savedLog.detail.account, '138****5678', 'system_logs 也按脱敏账号记录，管理员仍能看到失败');
  assert.equal(maskAccount('abcdef'), 'a***f');
  assert.equal(loginFailureReasonOf('web_password_login', '这个账号还不能登录网页后台。请让管理员在「角色管理」里勾上页面'), 'no_permission');
  assert.equal(loginFailureReasonOf('web_qr_login', 'ticket expired'), 'invalid_wechat_ticket');
  assert.equal(loginFailureReasonOf('web_password_login', 'account is disabled'), 'account_disabled');
  assert.deepEqual(loginAttemptOf('/api/v1/auth/qr-login/status', { status: 'expired' }, 200), { action: 'web_qr_login', success: false, message: '微信登录票据无效或已过期' });
  assert.equal(loginAttemptOf('/api/v1/auth/qr-login/status', { status: 'pending' }, 200), null, 'pending 轮询不记失败');
  assert.deepEqual(loginAttemptOf('/api/v1/auth/qr-login/status', { status: 'confirmed' }, 200), { action: 'web_qr_login', success: true, message: null });
});
