import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { MisMirror1794500000000 } from '../../migrations/1794500000000-MisMirror';
import { MisMirrorOwnerReportFields1795600000000 } from '../../migrations/1795600000000-MisMirrorOwnerReportFields';
import { MisMirrorChargeStandard1795700000000 } from '../../migrations/1795700000000-MisMirrorChargeStandard';
import { MisMirrorService } from './mis-mirror.service';

type Source = '楼表' | '室表' | '业主表' | 'WYDJ';
const ids = {
  楼表: { lId: 'L_ID' }, 室表: { sId: 'S_ID', lId: 'L_ID' },
  业主表: { zhId: 'ZH_ID', sId: 'S_ID' }, WYDJ: {},
};
const standard = (id: string, owner: string) => ({ standardId: id, zhId: owner, zlId: null, feeCode: '01', je: '1.2345', bz: null, isHistory: false });
const originals = (): Record<Source, any[]> => ({
  楼表: [{ lId: '9007199254740992', officeCode: '01' }, { lId: '9007199254740993', officeCode: '02' }],
  室表: [{ sId: '9007199254740994', lId: '9007199254740992', roomNo: '合成甲室' }, { sId: '9007199254740995', lId: '9007199254740993', roomNo: '合成乙室' }],
  业主表: [{ zhId: '999999999999999998', sId: '9007199254740994', name: '合成甲' }, { zhId: '999999999999999999', sId: '9007199254740995', name: '合成乙' }],
  WYDJ: [standard('9007199254740996', '999999999999999998'), standard('9007199254740997', '999999999999999999')],
});

async function fixture() {
  const pg = new PGlite();
  const runner = { query: (sql: string) => pg.query(sql) } as any;
  await new MisMirror1794500000000().up(runner);
  await new MisMirrorOwnerReportFields1795600000000().up(runner);
  await new MisMirrorChargeStandard1795700000000().up(runner);
  let rows = originals();
  const replies: Partial<Record<Source, unknown>> = {};
  const captured: string[] = [];
  let transactions = 0;
  let unlocks = 0;
  const service: any = new MisMirrorService({
    query: async (sql: string, params?: any[]) => {
      if (sql.includes('pg_try_advisory_lock')) return [{ ok: true }];
      if (sql.includes('pg_advisory_unlock')) { unlocks++; return []; }
      return (await pg.query(sql, params)).rows;
    },
    transaction: async (work: any) => {
      transactions++;
      return pg.transaction(async (tx) => work({ query: async (sql: string, params?: any[]) => (await tx.query(sql, params)).rows }));
    },
  } as any, { mirrorRead: async (sql: string) => {
    captured.push(sql);
    const source = (Object.keys(rows) as Source[]).find((name) => sql.includes(`FROM dbo.${name}`));
    if (!source) return { recordsets: [[]] };
    if (Object.prototype.hasOwnProperty.call(replies, source)) return replies[source];
    // 本地驱动模型：numeric 未显式转 varchar 时返回 Number；不是实际 SQL Server 验收。
    return { recordsets: [rows[source].map((row) => {
      const transported = { ...row };
      for (const [alias, column] of Object.entries(ids[source])) {
        if (!sql.includes(`CONVERT(varchar(20),${column}) AS ${alias}`)) transported[alias] = Number(row[alias]);
      }
      return transported;
    })] };
  } } as any, {} as any);
  service.syncSmallDimensions = async () => undefined;
  service.syncExtraMirrors = async () => ({ rows: 0 });
  const snapshot = async () => Promise.all([
    pg.query('SELECT l_id::text,office_code FROM mis_mirror_building ORDER BY l_id'),
    pg.query('SELECT s_id::text,l_id::text,room_no FROM mis_mirror_room ORDER BY s_id'),
    pg.query('SELECT zh_id::text,s_id::text,name FROM mis_mirror_owner ORDER BY zh_id'),
    pg.query('SELECT wy_dj_id::text,zh_id::text,je::text FROM mis_mirror_charge_standard ORDER BY wy_dj_id'),
    pg.query('SELECT * FROM mis_sync_state ORDER BY source_table'),
    pg.query('SELECT * FROM mis_mirror_bill ORDER BY zj_id'),
  ]).then((results) => results.map((result) => result.rows));
  return { pg, service, replies, captured, snapshot, rows: () => rows, setRows: (next: Record<Source, any[]>) => { rows = next; }, transactions: () => transactions, unlocks: () => unlocks };
}

test('手工重灌楼室业主均按字符串传输 numeric18，邻接大 ID 不合并且收费标准可精确关联', async () => {
  const f = await fixture();
  try {
    await f.service.reloadAll(1);
    for (const source of ['楼表', '室表', '业主表'] as const) {
      const sql = f.captured.find((query) => query.includes(`FROM dbo.${source}`)) ?? '';
      for (const [alias, column] of Object.entries(ids[source])) assert.ok(sql.includes(`CONVERT(varchar(20),${column}) AS ${alias}`), `${source}.${column} 必须在源端转字符串`);
    }
    const joined = await f.pg.query(`SELECT c.wy_dj_id::text,c.zh_id::text,o.s_id::text,r.l_id::text,b.office_code,o.name,r.room_no
      FROM mis_mirror_charge_standard c JOIN mis_mirror_owner o ON o.zh_id=c.zh_id
      JOIN mis_mirror_room r ON r.s_id=o.s_id JOIN mis_mirror_building b ON b.l_id=r.l_id ORDER BY c.wy_dj_id`);
    assert.deepEqual(joined.rows, [
      { wy_dj_id: '9007199254740996', zh_id: '999999999999999998', s_id: '9007199254740994', l_id: '9007199254740992', office_code: '01', name: '合成甲', room_no: '合成甲室' },
      { wy_dj_id: '9007199254740997', zh_id: '999999999999999999', s_id: '9007199254740995', l_id: '9007199254740993', office_code: '02', name: '合成乙', room_no: '合成乙室' },
    ]);
    assert.equal(f.transactions(), 1);
    assert.equal(f.unlocks(), 1);
  } finally { await f.pg.close(); }
});

test('维度缺结果集或非字符串/缺失/越界 ID 在事务前失败，重复主键事务回滚且保留旧镜像和水位', async () => {
  const f = await fixture();
  try {
    await f.service.reloadAll(1);
    await f.pg.query(`INSERT INTO mis_mirror_bill(zj_id,office_code,amount_cents) VALUES(42,'01',12345)`);
    const before = await f.snapshot();
    let failures = 0;
    for (const source of ['楼表', '室表', '业主表'] as const) {
      const first = f.rows()[source][0];
      const invalidReplies: unknown[] = [undefined, null, {}, { recordsets: [] }, { recordsets: [null] }, { recordsets: [{}] }, { recordsets: [[null]] }, { recordsets: [[[]]] }];
      for (const alias of Object.keys(ids[source])) {
        for (const value of [undefined, null, 1, 9007199254740993, '', '1.0', '1e2', ' 1', '1000000000000000000']) invalidReplies.push({ recordsets: [[{ ...first, [alias]: value }]] });
        const missing = { ...first }; delete missing[alias];
        invalidReplies.push({ recordsets: [[missing]] });
      }
      for (const reply of invalidReplies) {
        f.replies[source] = reply;
        await assert.rejects(f.service.reloadAll(1), (error: any) => error.getStatus?.() === 503 && error.message.includes(source) && !error.message.includes('999999999999999999'));
        failures++;
        assert.equal(f.transactions(), 1, '源结构损坏不能开始替换事务');
      }
      delete f.replies[source];
    }
    assert.deepEqual(await f.snapshot(), before);
    const duplicate = { ...f.rows().业主表[0], name: '合成重复主键' };
    f.setRows({ ...f.rows(), 业主表: [duplicate, duplicate] });
    await assert.rejects(f.service.reloadAll(1), /duplicate key/i);
    assert.equal(f.transactions(), 2);
    assert.deepEqual(await f.snapshot(), before);
    assert.equal(f.unlocks(), failures + 2);
  } finally { await f.pg.close(); }
});

test('源 numeric18 零和负 ID 不被擅自排除；真实空维度与空标准可提交零行快照', async () => {
  const f = await fixture();
  try {
    f.setRows({ 楼表: [{ lId: '0', officeCode: '01' }], 室表: [{ sId: '-1', lId: '0' }], 业主表: [{ zhId: '-2', sId: '-1' }], WYDJ: [standard('-3', '-2')] });
    await f.service.reloadAll(1);
    assert.deepEqual((await f.pg.query(`SELECT c.zh_id::text,r.s_id::text,b.l_id::text FROM mis_mirror_charge_standard c
      JOIN mis_mirror_owner o ON o.zh_id=c.zh_id JOIN mis_mirror_room r ON r.s_id=o.s_id JOIN mis_mirror_building b ON b.l_id=r.l_id`)).rows,
    [{ zh_id: '-2', s_id: '-1', l_id: '0' }]);
    f.setRows({ 楼表: [], 室表: [], 业主表: [], WYDJ: [] });
    await f.service.reloadAll(1);
    const stored = await f.snapshot();
    assert.deepEqual(stored.slice(0, 4), [[], [], [], []]);
    assert.equal((await f.pg.query<{ synced_rows: number }>(`SELECT synced_rows FROM mis_sync_state WHERE source_table='charge_standard'`)).rows[0].synced_rows, 0);
  } finally { await f.pg.close(); }
});
