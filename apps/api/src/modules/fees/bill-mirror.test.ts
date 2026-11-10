import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { ServiceUnavailableException } from '@nestjs/common';
import { PGlite } from '@electric-sql/pglite';
import { MisMirror1794500000000 } from '../../migrations/1794500000000-MisMirror';
import { MisMirrorFailureCount1794600000000 } from '../../migrations/1794600000000-MisMirrorFailureCount';
import { MisMirrorBillNature1795300000000 } from '../../migrations/1795300000000-MisMirrorBillNature';
import { MisMirrorP4Extras1795500000000 } from '../../migrations/1795500000000-MisMirrorP4Extras';
import { MisMirrorOwnerReportFields1795600000000 } from '../../migrations/1795600000000-MisMirrorOwnerReportFields';
import { MisMirrorChargeStandard1795700000000 } from '../../migrations/1795700000000-MisMirrorChargeStandard';
import { MisMirrorService } from './mis-mirror.service';

/**
 * Round17：账单镜像 numeric(18,0) 精确关联回归（仅本地 PGlite 合成夹具，不连 MIS/生产）。
 *
 * 覆盖 Lead 契约：
 * - bill-mirror.util.billMirrorRows：recordsets[0] 数组 + 4 个必填 zjId/lId/sId/zhId 字符串 numeric18，
 *   after 存在时 BigInt 严格递增且 > after，整批校验后才允许 upsert；
 * - billCursorId：PG bigint 字符串 / safe integer Number 兼容，unsafe Number 或损坏 state 503；
 * - service billSelect/reloadAll 四个 ID 源端 CONVERT(varchar(20))，游标保持字符串，MAX(zj_id)::text；
 * - 坏源/坏 ID/倒序或重复 keyset 整批拒绝，不 upsert、不推进成功水位。
 *
 * 边界（不在本测试内承诺）：reloadAll 维度部分先提交、账单再分批，整次 reload 不是单事务原子；
 * bills 分页/读取之外的其它 Number 路径（如住户明细 houseKey）本轮不扩。
 */

const BIG = '9007199254740993'; // 2^53 + 1：JS Number 会舍入到 ...992
const BIG_START = '9007199254740494'; // BIG - 499，用于造 500 行满批
const BATCH_SIZE = 500; // 与 service BATCH_SIZE 对齐
const MAX18 = '999999999999999999';
const SEED_SUCCESS_AT = '2026-11-01T00:00:00Z';
const MISSING = Symbol('missing-recordset');

/** 运行时拼接路径：Lead 实现 bill-mirror.util.ts 前本文件仍可整体加载并逐条得到 RED。 */
function billModule(): {
  billMirrorRows: (result: unknown, after?: string) => Record<string, any>[];
  billCursorId: (value: unknown) => string;
} {
  return require('./bill-mirror' + '.util');
}

function is503(error: unknown): boolean {
  const candidate = error as { getStatus?: () => number };
  return error instanceof ServiceUnavailableException || candidate?.getStatus?.() === 503;
}

/** 与 upsertBills 列一一对应的账单行；四个 ID 默认全部为字符串 numeric18。 */
function billRow(zjId: string, overrides: Record<string, unknown> = {}) {
  return {
    zjId,
    lId: '9007199254740992',
    sId: '999999999999999998',
    zhId: '999999999999999999',
    officeCode: '02',
    ownerName: '合成业主',
    roomNo: '101',
    address: '合成路1号101',
    feeCode: '01',
    feeName: '管理费',
    natureCode: '01',
    period: '202610',
    amountCents: 12340,
    paidDate: '2026-10-01',
    refundDate: null,
    paymentMethod: '现金',
    cashier: '收款员',
    incomeCents: 0,
    receiptWarehouseNo: null,
    invoiceNo: null,
    receiptVoucherNo: null,
    sourceUpdatedAt: '2026-11-01T00:00:00',
    ...overrides,
  };
}

function batchOf(startInclusive: string, count: number, overrides: (index: number) => Record<string, unknown> = () => ({})) {
  const start = BigInt(startInclusive);
  return Array.from({ length: count }, (_, index) => billRow(String(start + BigInt(index)), overrides(index)));
}

function records(rows: unknown) {
  return { recordsets: [rows] };
}

const BUILDINGS = [
  { lId: '9007199254740992', officeCode: '02', road: '合成路', lane: null, buildingNo: '1' },
  { lId: '9007199254740993', officeCode: '03', road: '合成路', lane: null, buildingNo: '2' },
];
const ROOMS = [
  { sId: '999999999999999998', lId: '9007199254740992', roomNo: '101', nature: '01', areaSqm: 88.5 },
  { sId: '999999999999999997', lId: '9007199254740993', roomNo: '102', nature: '01', areaSqm: 90 },
];
const OWNERS = [
  { zhId: '999999999999999999', sId: '999999999999999998', name: '合成甲', mobile: null, phone2: null, ownerNote: null, moveInDate: null, billingStartDate: null, sourceUpdatedAt: null },
  { zhId: '999999999999999998', sId: '999999999999999997', name: '合成乙', mobile: null, phone2: null, ownerNote: null, moveInDate: null, billingStartDate: null, sourceUpdatedAt: null },
];
const MINIMAL_BUILDINGS = [{ lId: '11', officeCode: '02', road: '合成路', lane: null, buildingNo: '1' }];
const MINIMAL_ROOMS = [{ sId: '21', lId: '11', roomNo: '101', nature: '01', areaSqm: 88.5 }];
const MINIMAL_OWNERS = [{ zhId: '31', sId: '21', name: '合成甲', mobile: null, phone2: null, ownerNote: null, moveInDate: null, billingStartDate: null, sourceUpdatedAt: null }];

interface FixtureOptions {
  /** 依次作为 readNewBillBatch/reloadAll 账单批的 recordsets[0]；MISSING 表示缺结果集。 */
  mainResults?: unknown[];
  /** sweep readUpdatedBillBatch 的 recordsets[0]；MISSING 表示缺结果集。 */
  sweepResult?: unknown | typeof MISSING;
  dimension?: 'minimal' | 'full';
  /** 覆盖 SELECT * FROM mis_sync_state ... source_table='bill' 的返回（模拟异常/旧 state）。 */
  billStateOverride?: Record<string, unknown>;
}

async function makeFixture(options: FixtureOptions = {}) {
  const pg = new PGlite();
  const runner = { query: (sql: string) => pg.query(sql) } as any;
  await new MisMirror1794500000000().up(runner);
  await new MisMirrorFailureCount1794600000000().up(runner);
  await new MisMirrorBillNature1795300000000().up(runner);
  await new MisMirrorP4Extras1795500000000().up(runner);
  await new MisMirrorOwnerReportFields1795600000000().up(runner);
  await new MisMirrorChargeStandard1795700000000().up(runner);
  const reads: Array<{ sql: string; params: Record<string, any> }> = [];
  const queries: string[] = [];
  const main = [...(options.mainResults ?? [])];
  const dimensions = options.dimension ?? 'minimal';
  const dataSource = {
    query: async (sql: string, params: any[] = []) => {
      queries.push(sql);
      if (sql.includes('pg_try_advisory_lock')) return [{ ok: true }];
      if (sql.includes('pg_advisory_unlock')) return [];
      if (options.billStateOverride && sql.includes('FROM mis_sync_state') && sql.includes("source_table='bill'")) {
        return [{
          tenant_id: 1,
          source_table: 'bill',
          initialized_at: '2026-11-01T00:00:00Z',
          last_success_at: SEED_SUCCESS_AT,
          last_updated_at: '2026-11-01T00:00:00Z',
          last_id: '0',
          ...options.billStateOverride,
        }];
      }
      return (await pg.query(sql, params)).rows;
    },
    transaction: (work: any) => pg.transaction(async (tx) => work({
      query: async (sql: string, params?: any[]) => (await tx.query(sql, params)).rows,
    })),
  };
  const service: any = new MisMirrorService(dataSource as any, {
    mirrorRead: async (sql: string, params: Record<string, any> = {}) => {
      reads.push({ sql, params });
      if (sql.includes('FROM dbo.楼表')) return records(dimensions === 'full' ? BUILDINGS : MINIMAL_BUILDINGS);
      if (sql.includes('FROM dbo.室表')) return records(dimensions === 'full' ? ROOMS : MINIMAL_ROOMS);
      if (sql.includes('FROM dbo.业主表')) return records(dimensions === 'full' ? OWNERS : MINIMAL_OWNERS);
      if (sql.includes('FROM dbo.WYDJ')) return records([]);
      if (sql.includes('FROM dbo.WYZJ') && sql.includes('w.ZJ_ID > @lastId')) {
        const next = main.shift();
        if (next === MISSING) return undefined;
        return records(Array.isArray(next) ? next : []);
      }
      if (sql.includes('FROM dbo.WYZJ') && sql.includes('w.updatedate >')) {
        if (options.sweepResult === MISSING) return undefined;
        if (options.sweepResult !== undefined) return options.sweepResult;
        return records([]);
      }
      return records([]);
    },
  } as any, {} as any);
  service.syncSmallDimensions = async () => undefined;
  service.syncExtraMirrors = async () => ({ rows: 0 });
  return { pg, service, reads, queries };
}

async function seedBillState(pg: PGlite, input: { lastId?: string; lastSuccessAt?: string; lastUpdatedAt?: string } = {}) {
  await pg.query(
    `INSERT INTO mis_sync_state(tenant_id,source_table,initialized_at,last_success_at,last_id,last_updated_at)
     VALUES(1,'bill',now(),$1,$2,$3)`,
    [input.lastSuccessAt ?? SEED_SUCCESS_AT, input.lastId ?? '0', input.lastUpdatedAt ?? '2026-11-01T00:00:00Z'],
  );
}

/** 15 分钟补漏未到期（syncBills 只跑主增量），用于把失败点收敛到主批/sweep 指定位置。 */
async function seedSweepDone(pg: PGlite) {
  await pg.query(
    `INSERT INTO mis_sync_state(tenant_id,source_table,last_updated_at,last_success_at)
     VALUES(1,'bill_sweep',now(),now())`,
  );
}

async function readBillState(pg: PGlite) {
  const rows = (await pg.query(
    `SELECT last_id::text AS "lastId",last_success_at,synced_rows::int AS "syncedRows"
       FROM mis_sync_state WHERE tenant_id=1 AND source_table='bill'`,
  )).rows as any[];
  const row = rows[0];
  return {
    lastId: row?.lastId ?? null,
    lastSuccessAt: row?.last_success_at ? new Date(row.last_success_at).toISOString() : null,
    syncedRows: row ? Number(row.syncedRows) : null,
  };
}

async function billCount(pg: PGlite): Promise<number> {
  const rows = (await pg.query('SELECT COUNT(*)::int AS c FROM mis_mirror_bill')).rows as any[];
  return Number(rows[0].c);
}

async function sweepState(pg: PGlite) {
  const rows = (await pg.query(
    `SELECT last_success_at FROM mis_sync_state WHERE tenant_id=1 AND source_table='bill_sweep'`,
  )).rows as any[];
  return rows[0] ?? null;
}

/** 断言 SQL 对指定列做了源端 varchar(20) 转换（不绑死空格/别名顺序）。 */
function assertVarchar20Cast(sql: string, tableAlias: string, column: string) {
  const pattern = new RegExp(
    `CONVERT\\s*\\(\\s*varchar\\s*\\(\\s*20\\s*\\)\\s*,\\s*${tableAlias}\\.${column}\\s*\\)`,
    'i',
  );
  assert.match(sql, pattern, `${tableAlias}.${column} 必须在源端 CONVERT(varchar(20)) 后传输`);
}

// ───────────────────────────── util 契约 ─────────────────────────────

test('billMirrorRows：真实 recordsets[0] + 4 个字符串 numeric18 ID 通过（0/负数/18 位边界）', () => {
  const { billMirrorRows } = billModule();
  const rows = billMirrorRows(records([
    billRow(BIG),
    billRow('9007199254740994', { lId: '9007199254740992', sId: '999999999999999998', zhId: MAX18 }),
    billRow('0'),
    billRow('-2'),
    billRow('42'),
  ]));
  assert.equal(rows.length, 5);
  assert.doesNotThrow(() => billMirrorRows(records([])));
});

test('billMirrorRows：缺结果集/非对象行/Number 或缺失/坏格式 ID 一律 503 且不泄露源值', () => {
  const { billMirrorRows } = billModule();
  const invalidIds = [
    { zjId: 9007199254740993 },
    { lId: 1 },
    { sId: null },
    { zhId: undefined },
    { zjId: '1.0' },
    { lId: '1e3' },
    { sId: ' 1 2 ' },
    { zhId: ' 42 ' },
    { zhId: '１１' },
    { zjId: '1000000000000000000' },
    { zjId: '' },
  ];
  const replies: unknown[] = [
    undefined,
    null,
    {},
    { recordsets: [] },
    { recordsets: [null] },
    { recordsets: [{}] },
    { recordsets: [[null]] },
    { recordsets: [[[]]] },
    { recordsets: [[{ ...billRow(BIG), lId: undefined }]] },
    ...invalidIds.map((overrides) => records([billRow(BIG, overrides)])),
  ];
  for (const reply of replies) {
    assert.throws(
      () => billMirrorRows(reply),
      (error: unknown) => is503(error) && !String((error as Error).message).includes('900719925474099'),
      JSON.stringify(reply)?.slice(0, 80),
    );
  }
  // 四字段逐个缺失都要拒绝，而不是只查有值的那一个。
  for (const field of ['zjId', 'lId', 'sId', 'zhId']) {
    const missing: Record<string, unknown> = billRow(BIG);
    delete missing[field];
    assert.throws(() => billMirrorRows(records([missing])), is503, field);
  }
});

test('billMirrorRows(after)：BigInt 严格递增且 > after，整批在返回前校验，倒序/重复/回退全拒绝', () => {
  const { billMirrorRows } = billModule();
  assert.doesNotThrow(() => billMirrorRows(records([
    billRow('9007199254740993'),
    billRow('9007199254740994'),
    billRow('9007199254740995'),
  ]), '9007199254740992'));
  // 合法批量 > after 的相邻大 ID 不合并。
  assert.equal(billMirrorRows(records([billRow(BIG)]), '9007199254740992')[0].zjId, BIG);

  const badBatches: Array<[string, string[]]> = [
    ['等于 after', ['9007199254740992']],
    ['小于 after', ['9007199254740991']],
    ['批内重复', [BIG, BIG]],
    ['批内倒序', ['9007199254740994', BIG]],
    ['后一行损坏（整批拒绝）', [BIG, 'not-a-number']],
    ['后一行回退（整批拒绝）', [BIG, '42']],
  ];
  for (const [label, zjIds] of badBatches) {
    assert.throws(
      () => billMirrorRows(records(zjIds.map((zjId) => billRow(zjId))), '9007199254740992'),
      is503,
      label,
    );
  }
  // 既有 full reload 起点是 '0'：不把负 ID 纳入初始扫描。
  assert.throws(() => billMirrorRows(records([billRow('-1')]), '0'), is503);
  assert.doesNotThrow(() => billMirrorRows(records([billRow('-1')])));
});

test('billCursorId：PG bigint 字符串与安全整数 Number 兼容，unsafe Number/损坏 state 503', () => {
  const { billCursorId } = billModule();
  assert.equal(billCursorId('0'), '0');
  assert.equal(billCursorId('42'), '42');
  assert.equal(billCursorId(BIG), BIG);
  assert.equal(billCursorId(MAX18), MAX18);
  assert.equal(billCursorId(42), '42');
  assert.equal(billCursorId(Number.MAX_SAFE_INTEGER), '9007199254740991');
  // PGlite 对 safe int8 返回 Number，旧安全 state 也可能是 Number。
  assert.equal(billCursorId(9007199254740000), '9007199254740000');

  const bad = [
    2 ** 60,
    9007199254740992,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    1.5,
    '',
    ' 1',
    '1.0',
    '1e3',
    '1000000000000000000',
    null,
    undefined,
    {},
    [],
  ];
  for (const value of bad) {
    assert.throws(() => billCursorId(value), is503, String(value));
  }
});

// ───────────────────────────── 旧 service 的真实 RED 点 ─────────────────────────────

test('billSelect 增量 SQL：zjId/lId/sId/zhId 全部源端 CONVERT(varchar(20))', async () => {
  const f = await makeFixture({ mainResults: [[]] });
  try {
    await seedBillState(f.pg);
    await seedSweepDone(f.pg);
    await f.service.syncBills(1);
    const mainRead = f.reads.find((read) => read.sql.includes('w.ZJ_ID > @lastId'));
    assert.ok(mainRead, '缺少增量账单 SQL');
    assertVarchar20Cast(mainRead.sql, 'w', 'ZJ_ID');
    assertVarchar20Cast(mainRead.sql, 'l', 'L_ID');
    assertVarchar20Cast(mainRead.sql, 's', 'S_ID');
    assertVarchar20Cast(mainRead.sql, 'z', 'ZH_ID');
  } finally {
    await f.pg.close();
  }
});

test('syncBills 增量分页：>2^53 光标跨批保持字符串，满批+尾批完整落库且水位精确', async () => {
  const firstBatch = batchOf(BIG_START, BATCH_SIZE);
  const f = await makeFixture({
    mainResults: [firstBatch, [billRow('9007199254740994')]],
  });
  try {
    await seedBillState(f.pg, { lastId: '9007199254740000' });
    await seedSweepDone(f.pg);
    await f.service.syncBills(1);

    const mainReads = f.reads.filter((read) => read.sql.includes('w.ZJ_ID > @lastId'));
    assert.equal(mainReads.length, 2, '满批后必须再发一次 keyset 查询');
    assert.strictEqual(mainReads[0].params.lastId, '9007199254740000', '起始 state 游标必须转成字符串');
    assert.strictEqual(mainReads[1].params.lastId, BIG, '上一批末行 >2^53 游标不能经 Number 丢失精度');

    const rows = (await f.pg.query(
      `SELECT COUNT(*)::int AS c,MIN(zj_id)::text AS lo,MAX(zj_id)::text AS hi FROM mis_mirror_bill`,
    )).rows as any[];
    assert.deepEqual({ c: Number(rows[0].c), lo: rows[0].lo, hi: rows[0].hi }, {
      c: BATCH_SIZE + 1,
      lo: BIG_START,
      hi: '9007199254740994',
    });
    const state = await readBillState(f.pg);
    assert.equal(state.lastId, '9007199254740994');
    assert.equal(state.syncedRows, BATCH_SIZE + 1);
    assert.ok(state.lastSuccessAt, '成功批次应推进 bill last_success_at');
  } finally {
    await f.pg.close();
  }
});

test('reloadAll：起点 "0" 字符串、>2^53 游标保持字符串、MAX(zj_id)::text，账单/维度跨表精确关联', async () => {
  const chainA = { lId: '9007199254740992', sId: '999999999999999998', zhId: '999999999999999999', officeCode: '02' };
  const chainB = { lId: '9007199254740993', sId: '999999999999999997', zhId: '999999999999999998', officeCode: '03' };
  const firstBatch = batchOf(BIG_START, BATCH_SIZE, (index) => (index % 2 === 0 ? chainA : chainB));
  const f = await makeFixture({
    dimension: 'full',
    mainResults: [firstBatch, [billRow('9007199254740994', chainA)]],
  });
  try {
    await f.service.reloadAll(1);
    const mainReads = f.reads.filter((read) => read.sql.includes('w.ZJ_ID > @lastId'));
    assert.equal(mainReads.length, 2);
    assert.strictEqual(mainReads[0].params.lastId, '0', 'full reload 必须保持既有字符串起点 0（不扩到负 ID）');
    assert.strictEqual(mainReads[1].params.lastId, BIG, 'reloadAll 的 >2^53 游标也不能经 Number 丢失精度');
    assertVarchar20Cast(mainReads[0].sql, 'w', 'ZJ_ID');
    assertVarchar20Cast(mainReads[0].sql, 'l', 'L_ID');
    assertVarchar20Cast(mainReads[0].sql, 's', 'S_ID');
    assertVarchar20Cast(mainReads[0].sql, 'z', 'ZH_ID');
    // MAX(zj_id) 直接取文本，避免 PG driver 把 bigint 收成 Number。
    assert.ok(
      f.queries.some((sql) => /MAX\s*\(\s*zj_id\s*\)\s*::\s*text/i.test(sql)),
      'reloadAll 收尾 MAX(zj_id) 必须 ::text',
    );

    // 相邻 >2^53 维度 ID 在 PG bigint 精确保留，且账单经 owner→room→building 关联到正确管理处。
    const joined = (await f.pg.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE b.office_code <> d.office_code)::int AS mismatched
         FROM mis_mirror_bill b
         JOIN mis_mirror_owner o ON o.zh_id=b.zh_id
         JOIN mis_mirror_room r ON r.s_id=o.s_id
         JOIN mis_mirror_building d ON d.l_id=r.l_id`,
    )).rows as any[];
    assert.deepEqual({ total: Number(joined[0].total), mismatched: Number(joined[0].mismatched) }, {
      total: BATCH_SIZE + 1,
      mismatched: 0,
    });
    const buildings = (await f.pg.query('SELECT l_id::text AS "lId" FROM mis_mirror_building ORDER BY l_id')).rows as any[];
    assert.deepEqual(buildings.map((row) => row.lId), ['9007199254740992', '9007199254740993']);
    const state = await readBillState(f.pg);
    assert.equal(state.lastId, '9007199254740994');
    assert.ok(state.lastSuccessAt);
  } finally {
    await f.pg.close();
  }
});

test('syncBills：坏源（缺结果集/Number 或缺失 ID/倒序、重复 keyset）整批拒绝，不 upsert、不推进成功水位', async () => {
  const cases: Array<{ label: string; mainResults: unknown[] }> = [
    { label: '缺结果集', mainResults: [MISSING] },
    { label: 'Number zjId', mainResults: [[billRow(BIG as any, { zjId: 9007199254740993 as any })]] },
    { label: '缺失 sId', mainResults: [[billRow(BIG, { sId: undefined })]] },
    { label: '倒序 keyset', mainResults: [[billRow(BIG), billRow('9007199254740992')]] },
    { label: '重复 keyset', mainResults: [[billRow(BIG), billRow(BIG)]] },
  ];
  for (const testCase of cases) {
    const f = await makeFixture({ mainResults: testCase.mainResults });
    try {
      await seedBillState(f.pg);
      await seedSweepDone(f.pg);
      await assert.rejects(f.service.syncBills(1), is503, testCase.label);
      assert.equal(await billCount(f.pg), 0, `${testCase.label}：不得 upsert 任何账单`);
      const state = await readBillState(f.pg);
      assert.deepEqual({ lastId: state.lastId, lastSuccessAt: state.lastSuccessAt }, {
        lastId: '0',
        lastSuccessAt: new Date(SEED_SUCCESS_AT).toISOString(),
      }, `${testCase.label}：不得推进成功水位`);
    } finally {
      await f.pg.close();
    }
  }
});

test('reloadAll：首批账单坏源整批拒绝，不 upsert 账单也不推进成功水位（维度替换不在本测试承诺原子）', async () => {
  const cases: Array<{ label: string; mainResults: unknown[] }> = [
    { label: '缺结果集', mainResults: [MISSING] },
    { label: '坏 ID', mainResults: [[billRow(BIG, { zhId: 7 as any })]] },
  ];
  for (const testCase of cases) {
    const f = await makeFixture({ mainResults: testCase.mainResults });
    try {
      await seedBillState(f.pg);
      await assert.rejects(f.service.reloadAll(1), is503, testCase.label);
      assert.equal(await billCount(f.pg), 0, `${testCase.label}：不得 upsert 账单`);
      const state = await readBillState(f.pg);
      assert.equal(state.lastSuccessAt, new Date(SEED_SUCCESS_AT).toISOString(), `${testCase.label}：不得推进成功水位`);
    } finally {
      await f.pg.close();
    }
  }
});

test('sweep：坏源整批拒绝不推进水位；合法但非全局递增的按时间批可通过', async () => {
  // 坏 sweep：main 为空、无 bill_sweep 水位 → 15 分钟补漏到期。
  const bad = await makeFixture({ mainResults: [[]], sweepResult: records([billRow(BIG, { lId: 1 })]) });
  try {
    await seedBillState(bad.pg, { lastUpdatedAt: '2026-11-01T00:00:00Z' });
    await assert.rejects(bad.service.syncBills(1), is503);
    assert.equal(await billCount(bad.pg), 0);
    assert.equal((await readBillState(bad.pg)).lastSuccessAt, new Date(SEED_SUCCESS_AT).toISOString());
    assert.equal(await sweepState(bad.pg), null, '坏 sweep 不得写成功水位');
  } finally {
    await bad.pg.close();
  }

  // 合法 sweep：按 updatedate 排序、zjId 非全局递增，不得套用 keyset 递增校验。
  const good = await makeFixture({ mainResults: [[]], sweepResult: records([billRow(BIG), billRow('42')]) });
  try {
    await seedBillState(good.pg, { lastUpdatedAt: '2026-11-01T00:00:00Z' });
    await good.service.syncBills(1);
    assert.equal(await billCount(good.pg), 2);
    assert.ok((await sweepState(good.pg))?.last_success_at, '合法 sweep 应写成功水位');
  } finally {
    await good.pg.close();
  }
});

test('syncBills：旧安全整数 state 转字符串；unsafe/损坏 state 503 拒绝且不动成功水位', async () => {
  // PGlite/旧安全 state：last_id 可能直接是 safe Number。
  const safe = await makeFixture({ mainResults: [[]], billStateOverride: { last_id: 42 } });
  try {
    await seedBillState(safe.pg);
    await seedSweepDone(safe.pg);
    await safe.service.syncBills(1);
    const read = safe.reads.find((item) => item.sql.includes('w.ZJ_ID > @lastId'));
    assert.ok(read);
    assert.strictEqual(read.params.lastId, '42');
  } finally {
    await safe.pg.close();
  }

  for (const lastId of [2 ** 60, 1.5]) {
    const unsafe = await makeFixture({ mainResults: [[]], billStateOverride: { last_id: lastId } });
    try {
      await seedBillState(unsafe.pg);
      await seedSweepDone(unsafe.pg);
      await assert.rejects(unsafe.service.syncBills(1), is503, String(lastId));
      assert.equal(await billCount(unsafe.pg), 0);
      assert.equal((await readBillState(unsafe.pg)).lastSuccessAt, new Date(SEED_SUCCESS_AT).toISOString());
    } finally {
      await unsafe.pg.close();
    }
  }
});
