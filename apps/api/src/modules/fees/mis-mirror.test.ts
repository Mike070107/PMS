import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { MisMirror1794500000000 } from '../../migrations/1794500000000-MisMirror';
import { MisMirrorService } from './mis-mirror.service';

async function fixture() {
  const pg = new PGlite();
  const migration = new MisMirror1794500000000();
  await migration.up({ query: (sql: string) => pg.query(sql) } as any);
  const dataSource: any = { query: async (sql: string, params?: any[]) => (await pg.query(sql, params)).rows };
  const misFees: any = {
    residentialScope: async () => [{ id: 1, name: '枫桦苑一期', offices: ['01'] }],
    collectionCommunities: async () => [{ id: 1, name: '枫桦苑一期', offices: ['01'] }],
  };
  const service: any = new MisMirrorService(dataSource, misFees, {} as any);
  await pg.query(`INSERT INTO mis_sync_state(tenant_id,source_table,last_success_at,initialized_at) VALUES(1,'bill',now(),now())`);
  const add = (id: number, sId: number, zhId: number, amount: number, paid: string | null = null, refund: string | null = null, feeName = '管理费') => pg.query(
    `INSERT INTO mis_mirror_bill(zj_id,office_code,s_id,zh_id,owner_name,room_no,address,fee_code,fee_name,period,amount_cents,paid_date,refund_date,payment_method,source_updated_at)
     VALUES($1,'01',$2,$3,$4,$5,$6,'01',$7,'202610',$8,$9,$10,'现金',now())`,
    [id, sId, zhId, `业主${zhId}`, String(sId), `枫桦苑一期${sId}号`, feeName, amount, paid, refund],
  );
  await add(1, 1, 1, 10000);
  await add(2, 1, 1, 20000);
  await add(3, 2, 2, 150000);
  await add(4, 3, 3, 300000);
  await add(5, 4, 4, 600000);
  await add(6, 5, 5, 50000, '2026-11-08');
  await add(7, 6, 6, 30000, null, '2026-11-08');
  return { pg, service, migration };
}

test('镜像迁移可 up/down，金额分档按户聚合后分档', async () => {
  const { pg, service, migration } = await fixture();
  try {
    const result: any = await service.residential({ view: 'amount-brackets' }, { id: 1, tenantId: 1 }, { scopeAll: true } as any);
    assert.deepEqual(result.buckets.map((row: any) => [row.key, row.count, row.amountCents]), [
      ['le500', 1, 30000],
      ['500to2000', 1, 150000],
      ['2000to5000', 1, 300000],
      ['gt5000', 1, 600000],
    ]);
    assert.deepEqual(result.total, { count: 4, amountCents: 1080000 });
    assert.equal(result.source, 'mirror');
    const dashboard: any = await service.residential({ view: 'dashboard' }, { id: 1, tenantId: 1 }, { scopeAll: true } as any);
    assert.equal(dashboard.summary.unpaidCents, 1080000);
    assert.equal(dashboard.summary.unpaidHouses, 4);
    const houses: any = await service.residential({ view: 'households', status: 'unpaid' }, { id: 1, tenantId: 1 }, { scopeAll: true } as any);
    assert.equal(houses.total, 4);
    assert.equal(houses.rows.length, 4);
    assert.equal(houses.rows[0].amountCents, 30000);
    const today: any = await service.today({ date: '2026-11-08' }, { id: 1, tenantId: 1 }, { scopeAll: true } as any);
    assert.equal(today.paidCents, 50000);
    assert.equal(today.refundedCents, 30000);
    await migration.down({ query: (sql: string) => pg.query(sql) } as any);
  } finally { await pg.close(); }
});

test('镜像未初始化时明确报错，不返回全 0 假装有数据', async () => {
  const pg = new PGlite();
  const migration = new MisMirror1794500000000();
  await migration.up({ query: (sql: string) => pg.query(sql) } as any);
  try {
    const service: any = new MisMirrorService(
      { query: async (sql: string, params?: any[]) => (await pg.query(sql, params)).rows } as any,
      { residentialScope: async () => [{ id: 1, name: '枫桦苑一期', offices: ['01'] }] } as any,
      {} as any,
    );
    await assert.rejects(() => service.residential({ view: 'dashboard' }, { id: 1, tenantId: 1 }, { scopeAll: true } as any), /镜像尚未完成初始化/);
  } finally { await pg.close(); }
});
