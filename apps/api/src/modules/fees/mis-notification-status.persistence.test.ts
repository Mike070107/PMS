import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { Logger } from '@nestjs/common';
import { PGlite } from '@electric-sql/pglite';
import { MisFeesService } from './mis-fees.service';
import { MisCollectionBatches1793800000000 } from '../../migrations/1793800000000-MisCollectionBatches';
import { MisCollectionFollowups1794000000000 } from '../../migrations/1794000000000-MisCollectionFollowups';
import { MisCollectionSms1793000001000 } from '../../migrations/1793000001000-MisCollectionSms';

/** 清单「通知状态」用真实 PostgreSQL WASM 跑 SQL：打印经批次快照关联、短信只认 submitted/delivered。 */
const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : String(value));

async function fixture() {
  const pg = new PGlite();
  const runner: any = { query: (sql: string, params?: any[]) => pg.query(sql, params) };
  for (const migration of [
    new MisCollectionBatches1793800000000(),
    new MisCollectionFollowups1794000000000(),
    new MisCollectionSms1793000001000(),
  ]) await migration.up(runner);
  const s: any = Object.create(MisFeesService.prototype);
  let queries = 0;
  s.batches = {
    manager: {
      query: async (sql: string, params: any[]) => {
        queries += 1;
        const result = await pg.query(sql, params);
        return result.rows || [];
      },
    },
  };
  const batch = (id: number, tenantId: number, houseKeys: string[]) =>
    pg.query('INSERT INTO mis_collection_batches(id,tenant_id,idempotency_key,community_ids,purpose,status,fingerprint,house_count,amount_cents,snapshot) VALUES($1,$2,$3,$4::integer[],$5,$6,$7,$8,$9,$10::jsonb)', [
      id, tenantId, `key-${id}`, [1], 'print', 'generated', `fp-${id}`, houseKeys.length, 1000, JSON.stringify({ notices: houseKeys.map((houseKey) => ({ houseKey, communityId: 1, amountCents: 1000, bills: [{ id: '1', amountCents: 1000 }] })) }),
    ]);
  const print = (tenantId: number, batchId: number, paper: 'A5' | 'A4', printedAt: string, requestKey: string) =>
    pg.query('INSERT INTO mis_collection_prints(tenant_id,batch_id,operator_id,page_count,notice_page_count,paper,printed_at,request_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [tenantId, batchId, 9, 1, 1, paper, printedAt, requestKey]);
  const sms = (tenantId: number, houseKey: string, status: string, submittedAt: string | null, deliveredAt: string | null) =>
    pg.query('INSERT INTO mis_collection_sms(tenant_id,batch_id,house_key,phone_tail,content,status,submitted_at,delivered_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [tenantId, 1, houseKey, '0001', 'fixture', status, submittedAt, deliveredAt]);
  return { pg, s, batch, print, sms, queries: () => queries, setQuery: (fn: any) => { s.batches.manager.query = fn; } };
}

test('通知状态：打印按批次快照关联 MAX(printed_at) 与最近纸张，短信只认 submitted/delivered 且用送达时间', async () => {
  const f = await fixture();
  try {
    const { pg, s } = f;
    await f.batch(11, 1, ['01:1:1', '01:1:2']);
    await f.batch(12, 1, ['01:1:1']);
    await f.batch(21, 2, ['01:1:1']);
    // 同一户在多个批次里打印：MAX(printed_at) 取 11-05，最近纸张 A4。
    await f.print(1, 11, 'A5', '2026-11-01T02:00:00Z', 'p-tenant1-batch11-a5');
    await f.print(1, 12, 'A4', '2026-11-05T02:00:00Z', 'p-tenant1-batch12-a4');
    await f.print(1, 11, 'A5', '2026-11-03T02:00:00Z', 'p-tenant1-batch11-house2');
    // 跨租户：批属于租户2而打印登记属于租户1，不得经快照关联到租户1清单；租户2自己的打印只对租户2可见。
    await f.print(1, 21, 'A4', '2026-11-07T02:00:00Z', 'p-cross-tenant-print');
    await f.print(2, 21, 'A5', '2026-11-06T02:00:00Z', 'p-tenant2-print');
    // 短信：queued（演练）/failed 不算通知；delivered 用 delivered_at 而不是 submitted_at。
    await f.sms(1, '01:1:1', 'submitted', '2026-11-02T02:00:00Z', null);
    await f.sms(1, '01:1:1', 'delivered', '2026-11-03T02:00:00Z', '2026-11-06T02:00:00Z');
    await f.sms(1, '01:1:2', 'queued', '2026-11-04T02:00:00Z', null);
    await f.sms(1, '01:1:2', 'failed', '2026-11-04T02:00:00Z', null);
    await f.sms(1, '01:1:3', 'submitted', '2026-11-05T02:00:00Z', null);
    await f.sms(2, '01:1:1', 'delivered', null, '2026-11-07T02:00:00Z');

    const tenant1 = await s.notificationStatus(['01:1:1', '01:1:2', '01:1:3', '01:1:1'], { id: 7, tenantId: 1 });
    assert.equal(tenant1.size, 3, '重复 houseKey 只查一次并返回一户一条');
    const one = tenant1.get('01:1:1');
    assert.equal(iso(one.printedAt), '2026-11-05T02:00:00.000Z', '打印时间取多批次 MAX(printed_at)');
    assert.equal(one.printedPaper, 'A4', '纸张取最近一次打印的版式');
    assert.equal(iso(one.smsAt), '2026-11-06T02:00:00.000Z', '送达短信显示 delivered_at，不是提交时间');
    assert.equal(one.smsStatus, 'delivered');
    const two = tenant1.get('01:1:2');
    assert.equal(iso(two.printedAt), '2026-11-03T02:00:00.000Z');
    assert.equal(two.printedPaper, 'A5');
    assert.equal(two.smsAt, null, 'queued/failed 不算已通知');
    assert.equal(two.smsStatus, null);
    const three = tenant1.get('01:1:3');
    assert.equal(three.printedAt, null);
    assert.equal(iso(three.smsAt), '2026-11-05T02:00:00.000Z');
    assert.equal(three.smsStatus, 'submitted');
    assert.ok(!JSON.stringify([...tenant1.values()]).includes('2026-11-07'), '跨租户打印/短信不得泄漏到租户1');

    const tenant2 = await s.notificationStatus(['01:1:1'], { id: 8, tenantId: 2 });
    assert.equal(iso(tenant2.get('01:1:1').printedAt), '2026-11-06T02:00:00.000Z');
    assert.equal(iso(tenant2.get('01:1:1').smsAt), '2026-11-07T02:00:00.000Z');
  } finally {
    await f.pg.close();
  }
});

test('通知状态：空数组不查库；内部大扫描不加通知查询；失败降级但必须 logger.warn', async () => {
  const f = await fixture();
  const warnCalls: any[] = [];
  const originalWarn = Logger.prototype.warn;
  try {
    const { s } = f;
    await f.batch(31, 1, ['01:1:9']);
    await f.print(1, 31, 'A5', '2026-11-02T02:00:00Z', 'p-empty-guard');
    const before = f.queries();
    const empty = await s.notificationStatus([], { id: 7, tenantId: 1 });
    assert.equal(empty.size, 0);
    assert.equal(f.queries(), before, '空数组不能查库');

    const rows = [{ houseKey: '01:1:9', amountCents: 1000 }];
    const internal = await s.withNotificationStatus(rows, { id: 7, tenantId: 1 }, { _aging: false } as any);
    assert.equal(internal[0].notifiedPrintedAt, null);
    const bigPage = await s.withNotificationStatus(rows, { id: 7, tenantId: 1 }, { pageSize: 5000 } as any);
    assert.equal(bigPage[0].notifiedPrintedAt, null);
    assert.equal(f.queries(), before, '内部大扫描/超50行分页不追加通知查询');

    Logger.prototype.warn = function (this: any, ...args: any[]) { warnCalls.push(args); } as any;
    f.setQuery(async () => { throw new Error('notification test boom'); });
    const failed = await s.notificationStatus(['01:1:9'], { id: 7, tenantId: 1 });
    assert.equal(failed.size, 0, 'SQL 失败只降级为未通知，不抛断清单');
    assert.equal(warnCalls.length, 1, '失败不能静默，必须 warn 一次');
    const message = String(warnCalls[0][0]);
    assert.match(message, /通知状态查询失败/);
    assert.match(message, /tenantId=1/);
    assert.match(message, /notification test boom/);
  } finally {
    Logger.prototype.warn = originalWarn;
    await f.pg.close();
  }
});

test('通知状态：近30天打印+短信计数与低响应抑制判定（>=2 次）', async () => {
  const f = await fixture();
  try {
    const { s } = f;
    const day = (offset: number) => new Date(Date.now() - offset * 86400000).toISOString();
    // A：近30天 2 次打印 + 1 次送达短信 = 3 次，应抑制。
    await f.batch(41, 1, ['01:2:1']);
    await f.print(1, 41, 'A4', day(10), 'p-count-a-older');
    await f.print(1, 41, 'A5', day(3), 'p-count-a-latest');
    // B：一次 40 天前打印（不计数）+ 近30天 1 次短信 = 1 次，不抑制。
    await f.batch(42, 1, ['01:2:2']);
    await f.print(1, 42, 'A5', day(40), 'p-count-b-old');
    // C：最近只有 queued/failed（不算通知），另有一条 45 天前的送达短信（显示状态但不计数）。
    await f.sms(1, '01:2:1', 'delivered', day(16), day(15));
    await f.sms(1, '01:2:2', 'submitted', day(5), null);
    await f.sms(1, '01:2:3', 'delivered', day(46), day(45));
    await f.sms(1, '01:2:3', 'queued', day(2), null);
    await f.sms(1, '01:2:3', 'failed', day(1), null);
    // 跨租户：租户2对同一 houseKey 的打印/短信不能计入租户1。
    await f.batch(51, 2, ['01:2:1']);
    await f.print(2, 51, 'A5', day(2), 'p-count-tenant2');
    await f.sms(2, '01:2:1', 'delivered', day(2), day(2));

    const status = await s.notificationStatus(['01:2:1', '01:2:2', '01:2:3'], { id: 7, tenantId: 1 });
    const a = status.get('01:2:1');
    assert.equal(a.printCount30d, 2, '近30天打印登记数');
    assert.equal(a.smsCount30d, 1, '近30天送达短信数');
    assert.equal(a.count30d, 3, '合计 = 打印 + 短信');
    assert.equal(a.suppressed, true, '>=2 次命中抑制');
    assert.equal(a.printedPaper, 'A5', '最近纸张仍取最近一次打印');
    assert.equal(a.smsStatus, 'delivered');
    const b = status.get('01:2:2');
    assert.equal(b.printCount30d, 0, '40 天前打印不计入近30天');
    assert.equal(b.smsCount30d, 1);
    assert.equal(b.count30d, 1);
    assert.equal(b.suppressed, false);
    const c = status.get('01:2:3');
    assert.equal(c.printCount30d, 0);
    assert.equal(c.smsCount30d, 0, '45 天前送达不计入近30天，queued/failed 从不算通知');
    assert.equal(c.count30d, 0);
    assert.equal(c.suppressed, false);
    assert.equal(c.smsStatus, 'delivered', '旧通知仍显示状态，只是不计数');

    // 清单行只透传计数与判定，页面据此显示「×N」和「低响应」。
    const rows = ['01:2:1', '01:2:2', '01:2:3'].map((houseKey) => ({ houseKey, amountCents: 1000 }));
    const page = await s.withNotificationStatus(rows, { id: 7, tenantId: 1 }, { pageSize: 20 } as any);
    assert.deepEqual(page.map((row: any) => [row.notifiedPrintCount30d, row.notifiedSmsCount30d, row.notifiedCount30d, row.notifySuppressed]), [[2, 1, 3, true], [0, 1, 1, false], [0, 0, 0, false]]);

    const tenant2 = await s.notificationStatus(['01:2:1'], { id: 8, tenantId: 2 });
    assert.deepEqual([tenant2.get('01:2:1').printCount30d, tenant2.get('01:2:1').smsCount30d, tenant2.get('01:2:1').count30d, tenant2.get('01:2:1').suppressed], [1, 1, 2, true], '租户2只看到自己的计数');
  } finally {
    await f.pg.close();
  }
});
