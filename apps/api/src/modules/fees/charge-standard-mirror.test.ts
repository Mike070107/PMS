import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { MisMirror1794500000000 } from '../../migrations/1794500000000-MisMirror';
import { MisMirrorOwnerReportFields1795600000000 } from '../../migrations/1795600000000-MisMirrorOwnerReportFields';
import { MisMirrorService } from './mis-mirror.service';
import { MisMirrorChargeStandard1795700000000 } from '../../migrations/1795700000000-MisMirrorChargeStandard';
import { chargeStandardMirrorParams } from './charge-standard-mirror.util';

test('收费标准迁移缺失应在任何 MIS 读取前返回 503，保留原镜像并解锁', async () => {
  const pg = new PGlite();
  const runner = { query: (sql: string) => pg.query(sql) } as any;
  let sourceReads = 0;
  let unlocks = 0;
  try {
    await new MisMirror1794500000000().up(runner);
    await new MisMirrorOwnerReportFields1795600000000().up(runner);
    await pg.query(`INSERT INTO mis_mirror_owner(zh_id,name) VALUES(1,'合成旧住户')`);
    const service = new MisMirrorService({ query: async (sql: string, params?: any[]) => {
      if (sql.includes('pg_try_advisory_lock')) return [{ ok: true }];
      if (sql.includes('pg_advisory_unlock')) { unlocks++; return []; }
      return (await pg.query(sql, params)).rows;
    } } as any, { mirrorRead: async () => { sourceReads++; throw new Error('不应读取 MIS'); } } as any, {} as any);
    await assert.rejects(service.reloadAll(1), (error: any) => error.getStatus?.() === 503 && error.message.includes('1795700000000'));
    assert.equal(sourceReads, 0);
    assert.equal(unlocks, 1);
    assert.deepEqual((await pg.query('SELECT zh_id,name FROM mis_mirror_owner')).rows, [{ zh_id: 1, name: '合成旧住户' }]);
  } finally { await pg.close(); }
});

const sourceRow = (overrides: Record<string, unknown> = {}) => ({
  standardId: '9007199254740993', zhId: '999999999999999999', zlId: null, feeCode: '01',
  je: '0.0049', bz: '1.2345', isHistory: false, ...overrides,
});

async function standardFixture() {
  const pg = new PGlite();
  const runner = { query: (sql: string) => pg.query(sql) } as any;
  await new MisMirror1794500000000().up(runner);
  await new MisMirrorOwnerReportFields1795600000000().up(runner);
  await new MisMirrorChargeStandard1795700000000().up(runner);
  let rows: any[] = [];
  let sourceFailure: unknown;
  let missingResultSet = false;
  let unlocks = 0;
  const captured: string[] = [];
  const run = async (sql: string, params?: any[]) => {
    if (sql.includes('pg_try_advisory_lock')) return [{ ok: true }];
    if (sql.includes('pg_advisory_unlock')) { unlocks++; return []; }
    return (await pg.query(sql, params)).rows;
  };
  const service: any = new MisMirrorService({ query: run,
    transaction: (work: any) => pg.transaction(async (tx) => work({
      query: async (sql: string, params?: any[]) => (await tx.query(sql, params)).rows,
    })),
  } as any, { mirrorRead: async (sql: string) => {
    captured.push(sql);
    if (sql.includes('FROM dbo.WYDJ')) {
      if (sourceFailure) throw sourceFailure;
      return missingResultSet ? { recordsets: [] } : { recordsets: [rows] };
    }
    if (sql.includes('FROM dbo.楼表')) return { recordsets: [[{ lId: '502', officeCode: '01' }]] };
    if (sql.includes('FROM dbo.室表')) return { recordsets: [[{ sId: '502', lId: '502', roomNo: '新合成室' }]] };
    if (sql.includes('FROM dbo.业主表')) return { recordsets: [[{ zhId: '902', sId: '502', name: '新合成住户' }]] };
    return { recordsets: [[]] };
  } } as any, {} as any);
  service.syncSmallDimensions = async () => undefined;
  service.syncExtraMirrors = async () => ({ rows: 0 });
  return { pg, runner, service, captured, setRows: (next: any[]) => { rows = next; },
    setFailure: (error: unknown) => { sourceFailure = error; },
    setMissingResultSet: (missing: boolean) => { missingResultSet = missing; },
    unlocks: () => unlocks };
}

test('标准迁移幂等且不初始化水位；回退清除标准成功水位但不影响其他来源', async () => {
  const { pg, runner } = await standardFixture();
  const migration = new MisMirrorChargeStandard1795700000000();
  try {
    await migration.up(runner);
    assert.deepEqual((await pg.query(`SELECT * FROM mis_sync_state WHERE source_table='charge_standard'`)).rows, []);
    const columns: any[] = (await pg.query(`SELECT column_name,numeric_precision,numeric_scale,is_nullable FROM information_schema.columns
      WHERE table_name='mis_mirror_charge_standard' AND column_name IN ('je','bz') ORDER BY column_name`)).rows;
    assert.deepEqual(columns, [
      { column_name: 'bz', numeric_precision: 19, numeric_scale: 4, is_nullable: 'YES' },
      { column_name: 'je', numeric_precision: 19, numeric_scale: 4, is_nullable: 'YES' },
    ]);
    await pg.query(`INSERT INTO mis_sync_state(tenant_id,source_table,initialized_at) VALUES(1,'charge_standard',now()),(2,'charge_standard',now()),(1,'bill',now())`);
    await migration.down(runner);
    await migration.down(runner);
    assert.deepEqual((await pg.query(`SELECT tenant_id,source_table FROM mis_sync_state`)).rows, [{ tenant_id: 1, source_table: 'bill' }]);
    await migration.up(runner);
    assert.equal((await pg.query(`SELECT * FROM mis_mirror_charge_standard`)).rows.length, 0);
    assert.equal((await pg.query(`SELECT * FROM mis_sync_state WHERE source_table='charge_standard'`)).rows.length, 0);
  } finally { await pg.close(); }
});

test('手工重灌保留大 ID、四位 JE/BZ、负数、NULL、历史和租赁行，不将金额逐行转分', async () => {
  const { pg, service, captured, setRows } = await standardFixture();
  setRows([
    sourceRow(), sourceRow({ standardId: '9007199254740994' }),
    sourceRow({ standardId: '3', zlId: '9007199254740995', feeCode: null, je: null, bz: null, isHistory: null }),
    sourceRow({ standardId: '4', je: '-0.0049', bz: '0.0000', isHistory: true }),
    sourceRow({ standardId: '5', je: '922337203685477.5807', bz: '-922337203685477.5808', isHistory: true }),
  ]);
  try {
    const result = await service.reloadAll(1);
    assert.equal(result.chargeStandardRows, 5);
    const sql = captured.find((text) => text.includes('FROM dbo.WYDJ')) ?? '';
    for (const field of ['ID', 'ZH_ID', 'ZL_ID']) assert.ok(sql.includes(`CONVERT(varchar(20),${field})`));
    for (const field of ['JE', 'BZ']) assert.ok(sql.includes(`CONVERT(varchar(40),${field},2)`));
    assert.doesNotMatch(sql, /ROUND|\*\s*100|\bWHERE\b/i, '源精度和历史/租赁/空值行不能丢失');
    const read = async (id: string) => (await pg.query(`SELECT wy_dj_id::text,zh_id::text,zl_id::text,fee_code,je::text,bz::text,is_history FROM mis_mirror_charge_standard WHERE wy_dj_id=$1`, [id])).rows[0];
    assert.deepEqual(await read('9007199254740993'), { wy_dj_id: '9007199254740993', zh_id: '999999999999999999', zl_id: null, fee_code: '01', je: '0.0049', bz: '1.2345', is_history: false });
    assert.deepEqual(await read('3'), { wy_dj_id: '3', zh_id: '999999999999999999', zl_id: '9007199254740995', fee_code: null, je: null, bz: null, is_history: null });
    assert.equal((await read('4') as any).je, '-0.0049');
    assert.equal((await read('5') as any).bz, '-922337203685477.5808');
    assert.deepEqual((await pg.query(`SELECT SUM(je)::text AS raw,ROUND(SUM(je),2)::text AS display FROM mis_mirror_charge_standard WHERE is_history=false`)).rows, [{ raw: '0.0098', display: '0.01' }], '同一个费项/业主单元格先 SUM(JE)，不能逐源行舍入');
    const states: any[] = (await pg.query(`SELECT initialized_at IS NOT NULL AS initialized,last_success_at IS NOT NULL AS succeeded,synced_rows::text FROM mis_sync_state WHERE tenant_id=1 AND source_table='charge_standard'`)).rows;
    assert.deepEqual(states, [{ initialized: true, succeeded: true, synced_rows: '5' }]);
  } finally { await pg.close(); }
});

test('重复重灌替换标准快照并删除源已删行，真实空结果集仍初始化零行水位', async () => {
  const { pg, service, setRows } = await standardFixture();
  try {
    setRows([sourceRow(), sourceRow({ standardId: '2' })]);
    await service.reloadAll(1);
    setRows([sourceRow({ je: '2.3456' })]);
    await service.reloadAll(1);
    assert.deepEqual((await pg.query(`SELECT wy_dj_id::text,je::text FROM mis_mirror_charge_standard`)).rows, [{ wy_dj_id: '9007199254740993', je: '2.3456' }]);
    setRows([]);
    assert.equal((await service.reloadAll(1)).chargeStandardRows, 0);
    assert.equal((await pg.query(`SELECT * FROM mis_mirror_charge_standard`)).rows.length, 0);
    assert.deepEqual((await pg.query(`SELECT synced_rows::text,initialized_at IS NOT NULL AS initialized,last_success_at IS NOT NULL AS succeeded FROM mis_sync_state WHERE source_table='charge_standard'`)).rows, [{ synced_rows: '0', initialized: true, succeeded: true }]);
  } finally { await pg.close(); }
});

test('标准源失败/无结果集/损坏传输/重复 ID 落库失败均保留四张镜像、账单和成功水位', async () => {
  const { pg, service, setRows, setFailure, setMissingResultSet, unlocks } = await standardFixture();
  const snapshot = async () => {
    const all: unknown[][] = [];
    for (const table of ['mis_mirror_building','mis_mirror_room','mis_mirror_owner','mis_mirror_charge_standard','mis_mirror_bill','mis_sync_state']) {
      all.push((await pg.query(`SELECT * FROM ${table} ORDER BY 1,2`)).rows);
    }
    return all;
  };
  try {
    await pg.query(`INSERT INTO mis_mirror_building(l_id,office_code) VALUES(501,'01')`);
    await pg.query(`INSERT INTO mis_mirror_room(s_id,l_id,room_no) VALUES(501,501,'原合成室')`);
    await pg.query(`INSERT INTO mis_mirror_owner(zh_id,s_id,name) VALUES(901,501,'原合成住户')`);
    await pg.query(`INSERT INTO mis_mirror_charge_standard(wy_dj_id,zh_id,fee_code,je) VALUES(1,901,'01',0.0049)`);
    await pg.query(`INSERT INTO mis_mirror_bill(zj_id,office_code,amount_cents) VALUES(1,'01',12345)`);
    await pg.query(`INSERT INTO mis_sync_state(tenant_id,source_table,initialized_at,last_success_at,synced_rows) VALUES(1,'charge_standard','2000-01-01','2000-01-01',1),(1,'bill','2000-01-01','2000-01-01',1)`);
    const before = await snapshot();
    const failure = new Error('synthetic WYDJ timeout');
    setFailure(failure);
    await assert.rejects(service.reloadAll(1), (error) => error === failure);
    assert.deepEqual(await snapshot(), before);
    setFailure(undefined); setMissingResultSet(true);
    await assert.rejects(service.reloadAll(1), /未返回结果集/);
    assert.deepEqual(await snapshot(), before);
    setMissingResultSet(false); setRows([sourceRow({ je: 0.0049 })]);
    await assert.rejects(service.reloadAll(1), /源字段 JE 格式无效/);
    assert.deepEqual(await snapshot(), before);
    setRows([sourceRow(), sourceRow()]);
    await assert.rejects(service.reloadAll(1), /duplicate key value/);
    assert.deepEqual(await snapshot(), before, '真实事务失败必须回滚维度替换、标准删除/插入及标准水位');
    assert.equal(unlocks(), 4);
  } finally { await pg.close(); }
});

test('标准源类型校验拒绝 JS 数值金额/ID、缺列、伪空值和精度/范围丢失，不泄露源值', () => {
  assert.deepEqual(chargeStandardMirrorParams(sourceRow({ standardId: '-1', zhId: '0' })),
    ['-1', '0', null, '01', '0.0049', '1.2345', false], 'numeric(18,0) 不擅自排除源零/负 ID');
  const bad = [
    sourceRow({ standardId: 9007199254740993 }), sourceRow({ standardId: '1000000000000000000' }),
    sourceRow({ zhId: null }), sourceRow({ zlId: 10 }), sourceRow({ feeCode: 1 }),
    sourceRow({ je: 0.0049 }), sourceRow({ je: '0.005' }), sourceRow({ je: '0.00001' }),
    sourceRow({ je: 'NaN' }), sourceRow({ je: '1,000.0000' }), sourceRow({ je: '922337203685477.5808' }),
    sourceRow({ bz: '-922337203685477.5809' }), sourceRow({ isHistory: '0' }), sourceRow({ je: undefined }),
    null, [], {},
  ];
  for (const row of bad) assert.throws(() => chargeStandardMirrorParams(row), (error: any) => error.getStatus?.() === 503 && !error.message.includes('9007199254740993'));
  const missing = sourceRow() as Record<string, unknown>;
  delete missing.bz;
  assert.throws(() => chargeStandardMirrorParams(missing), /源字段 bz 格式无效/);
});
