import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { FeedbackService } from './feedback.service';
import { Observability1788570000000 } from '../../migrations/1788570000000-Observability';
import { UserFeedback1788656400000 } from '../../migrations/1788656400000-UserFeedback';
import { UserFeedbackUnified1794700000000 } from '../../migrations/1794700000000-UserFeedbackUnified';

const users = [
  { id: 7, tenantId: 1, name: '张三', phone: '13800000001' },
  { id: 8, tenantId: 1, name: '李四', phone: '13800000002' },
];

async function fixture() {
  const pg = new PGlite();
  const runner: any = { query: (sql: string, params?: any[]) => pg.query(sql, params) };
  for (const migration of [
    new Observability1788570000000(),
    new UserFeedback1788656400000(),
    new UserFeedbackUnified1794700000000(),
  ]) await migration.up(runner);
  const feedbackRepo: any = {
    manager: {
      query: async (sql: string, params: any[]) => (await pg.query(sql, params)).rows,
    },
  };
  const userRepo: any = {
    find: async (options: any) => {
      const ids: number[] = (options.where.id as any)?._value ?? (options.where.id as any)?.value ?? [];
      return users.filter((user) => user.tenantId === options.where.tenantId && ids.includes(user.id));
    },
  };
  const service: any = new (FeedbackService as any)(feedbackRepo, userRepo, {}, {}, {}, {}, {});
  const unified = (tenantId: number, userId: number, name: string, content: string, kind: string, status: string, source: string, createdAt: string, attachments: any[] = []) =>
    pg.query(
      `INSERT INTO user_feedback(tenant_id,user_id,user_name,user_phone,content,kind,attachments,context,source,status,created_at) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11)`,
      [tenantId, userId, name, null, content, kind, JSON.stringify(attachments), null, source, status, createdAt],
    );
  const legacy = (tenantId: number, source: string, actor: number, message: string, detail: any, createdAt: string) =>
    pg.query(
      `INSERT INTO system_logs(tenant_id,category,level,source,action,success,actor_user_id,user_agent,request_path,message,detail,created_at) VALUES($1,'feedback','warning',$2,'user_feedback',false,$3,$4,$5,$6,$7::jsonb,$8)`,
      [tenantId, source, actor, 'WechatUA/1.0', '/pages/work-orders/45', message, JSON.stringify(detail), createdAt],
    );
  return { pg, service, unified, legacy };
}

test('统一列表：user_feedback 与历史异常反馈读时合并，kind/status/日期/分页/租户隔离都生效', async () => {
  const f = await fixture();
  try {
    await f.unified(1, 7, '张三', '意见一', 'suggestion', 'pending', 'web', '2026-11-02T02:00:00Z');
    await f.unified(1, 7, '张三', '异常二', 'error', 'handled', 'miniapp-staff', '2026-11-03T02:00:00Z', [
      { url: '/api/v1/upload/file?key=uploads/2026/11/03/a.jpg', name: 'a.jpg', size: 1024, mime: 'image/jpeg' },
    ]);
    await f.unified(1, 8, '李四', '异常三', 'error', 'pending', 'miniapp-owner', '2026-11-04T02:00:00Z');
    await f.unified(2, 7, '张三', '别的公司', 'error', 'pending', 'web', '2026-11-05T02:00:00Z');
    await f.legacy(1, 'miniapp-staff', 7, '历史异常四', {
      feedbackType: 'error',
      feedbackStatus: 'new',
      errorMessage: '点击失败',
      version: '1.2.3',
      pageTitle: '/bills',
      attachments: [{ type: 'image', url: '/api/v1/upload/file?key=uploads/old.jpg' }],
    }, '2026-11-06T02:00:00Z');
    await f.legacy(1, 'admin-web', 8, '历史建议五', { feedbackType: 'suggestion', feedbackStatus: 'resolved' }, '2026-11-07T02:00:00Z');

    const all = await f.service.list({ page: 1, pageSize: 20 }, { id: 99, tenantId: 1 });
    assert.equal(all.total, 5, '只统计本租户：3 条统一表 + 2 条历史');
    assert.deepEqual(all.rows.map((row: any) => row.id), ['log-2', 'log-1', 3, 2, 1], '按时间倒序合并，历史 id 用 log- 前缀');
    const legacyError = all.rows[1];
    assert.equal(legacyError.kind, 'error');
    assert.equal(legacyError.userName, '张三');
    assert.equal(legacyError.userPhone, '13800000001');
    assert.equal(legacyError.status, 'pending');
    assert.equal(legacyError.source, 'miniapp-staff');
    assert.equal(legacyError.origin, 'legacy');
    assert.equal(legacyError.context.page, '/bills');
    assert.equal(legacyError.context.userAgent, 'WechatUA/1.0');
    assert.equal(legacyError.context.appVersion, '1.2.3');
    assert.equal(legacyError.context.recentErrors[0].message, '点击失败');
    assert.equal(legacyError.recentErrors[0].message, '点击失败', '顶层 recentErrors 供前端日志表直接展示');
    assert.deepEqual(legacyError.attachments, [{ url: '/api/v1/upload/file?key=uploads/old.jpg', name: null, size: null, mime: null }]);
    assert.equal(all.rows[0].source, 'web', '历史 admin-web 来源统一成 web');
    assert.equal(all.rows[0].status, 'handled', 'resolved 映射为 handled');
    assert.equal(all.rows[2].origin, 'unified');
    assert.equal(all.rows[2].source, 'miniapp-owner');
    assert.equal(all.rows[3].attachments[0].size, 1024);

    const pendingErrors = await f.service.list({ kind: 'error', status: 'pending', page: 1, pageSize: 20 }, { id: 99, tenantId: 1 });
    assert.equal(pendingErrors.total, 2);
    assert.deepEqual(pendingErrors.rows.map((row: any) => row.id), ['log-1', 3]);

    const handled = await f.service.list({ status: 'handled' }, { id: 99, tenantId: 1 });
    assert.equal(handled.total, 2);
    assert.deepEqual(handled.rows.map((row: any) => row.id), ['log-2', 2]);

    const ranged = await f.service.list({ from: '2026-11-04', to: '2026-11-05' }, { id: 99, tenantId: 1 });
    assert.equal(ranged.total, 1, '按中国自然日过滤');
    assert.equal(ranged.rows[0].id, 3);

    const page2 = await f.service.list({ page: 2, pageSize: 2 }, { id: 99, tenantId: 1 });
    assert.equal(page2.total, 5);
    assert.deepEqual(page2.rows.map((row: any) => row.id), [3, 2]);

    const otherTenant = await f.service.list({}, { id: 7, tenantId: 2 });
    assert.equal(otherTenant.total, 1);
    assert.equal(otherTenant.rows[0].content, '别的公司');

    await assert.rejects(f.service.list({ from: '2026-11-07', to: '2026-11-01' }, { id: 99, tenantId: 1 }), /开始日期不能晚于/);
  } finally {
    await f.pg.close();
  }
});

test('迁移：扩展列可重复执行，down 可回滚', async () => {
  const pg = new PGlite();
  const runner: any = { query: (sql: string, params?: any[]) => pg.query(sql, params) };
  try {
    await new UserFeedback1788656400000().up(runner);
    const migration = new UserFeedbackUnified1794700000000();
    await migration.up(runner);
    await migration.up(runner); // 幂等：重复执行不报错
    const columns = await pg.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'user_feedback'`);
    const names = columns.rows.map((row: any) => row.column_name);
    for (const column of ['kind', 'attachments', 'context', 'source']) assert.ok(names.includes(column), `缺列 ${column}`);
    await migration.down(runner);
    const after = await pg.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'user_feedback'`);
    const afterNames = after.rows.map((row: any) => row.column_name);
    for (const column of ['kind', 'attachments', 'context', 'source']) assert.ok(!afterNames.includes(column), `down 未删除 ${column}`);
  } finally {
    await pg.close();
  }
});
