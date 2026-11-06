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
