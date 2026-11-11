import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { BadRequestException, ServiceUnavailableException, ValidationPipe } from '@nestjs/common';
import { PGlite } from '@electric-sql/pglite';
import { MisMirror1794500000000 } from '../../migrations/1794500000000-MisMirror';
import { MisMirrorBillNature1795300000000 } from '../../migrations/1795300000000-MisMirrorBillNature';
import {
  ANNUAL_ROOM_ID_RE,
  annualIdInput,
  annualRoomId,
  annualSourceId,
} from './annual-source-id.util';
import { StatisticsBillsQueryDto } from './dto';
import { StatisticsService } from './statistics.service';

/**
 * Round18 年度下钻 ID 精度回归（仅本地 PGlite 合成夹具，不连 MIS/生产/外网）。
 *
 * 年度 service/dto/annual-source-id.util 的共同契约：
 * - 真实 StatisticsService + PGlite：年度单元格 → 房屋明细 → 逐笔账单（arrears/received 两种 type）
 *   的 sId/zjId 必须是字符串；相邻 >2^53 / 18 位 ID 在响应里不得被 Number 合并或错选；
 * - 合计守恒：单元格金额 = detail.totalCents = 各房屋金额之和 = 该房屋 bills.totalCents；
 * - 年份/收费项目/房屋性质/收款日期筛选与授权范围行为不变；
 * - PG 输出 ID 走 ::text；HTTP query 的 sId 保留 positive18 字符串，不经 Number；
 * - unsafe Number/数组/指数/空白/19 位/0/负数 400；旧 safe Number 内部调用兼容但响应 ID 仍是字符串。
 *
 * 原 8 项曾在旧源码真实 RED；补充源 ID 守卫、DB 前拒绝与 NULL 兼容后共 13 项。
 * 合成数据只证明本地契约，不代替真实 MIS/生产验收。
 */

const tenantId = 1;
const user = { id: 7, tenantId } as never;
const scopeAll = { scopeAll: true } as never;
const scopeCommunityTwo = { scopeAll: false, communityIds: [2] } as never;

const communities = [
  { id: 1, name: '枫桦景苑一期' },
  { id: 2, name: '枫桦景苑二期' },
  { id: 16, name: '上海新家' },
];

// 相邻 >2^53 的 18 位 ID：Number 全部舍入到 1000000000000000000，旧实现会把两户/两笔合并。
const S_A = '999999999999999998';
const S_B = '999999999999999999';
const S_C = '501';
const S_D = '601';
const Z_A1 = '999999999999999998';
const Z_A2 = '999999999999999999';
const Z_B1 = '999999999999999997';
const Z_C1 = '42';
const Z_D1 = '43';
const Z_R1 = '999999999999999994';
const Z_R2 = '999999999999999995';

async function makeDatabase() {
  const pg = new PGlite();
  const runner = { query: (sql: string) => pg.query(sql) } as any;
  await new MisMirror1794500000000().up(runner);
  await new MisMirrorBillNature1795300000000().up(runner);
  return pg;
}

interface BillInput {
  zjId: string;
  officeCode: string;
  sId: string;
  ownerName: string;
  roomNo: string;
  address: string;
  feeCode: string;
  feeName: string;
  natureCode: string;
  period: string;
  amountCents: number;
  paidDate?: string | null;
}

async function seed(pg: PGlite) {
  await pg.query(
    `INSERT INTO mis_sync_state(tenant_id,source_table,last_success_at,initialized_at)
     VALUES($1,'bill',$2,now())`,
    [tenantId, '2026-11-09T21:30:00+08:00'],
  );
  for (const [sId, roomNo, area] of [
    [S_A, '101', 88.5],
    [S_B, '102', 90],
    [S_C, '501', 60],
    [S_D, '601', 70],
  ] as Array<[string, string, number]>) {
    await pg.query(
      `INSERT INTO mis_mirror_room(s_id,room_no,nature,area_sqm) VALUES($1,$2,'01',$3)`,
      [sId, roomNo, area],
    );
  }
  const addBill = async (input: BillInput) => {
    await pg.query(
      `INSERT INTO mis_mirror_bill(zj_id,office_code,s_id,owner_name,room_no,address,fee_code,fee_name,
        period,amount_cents,paid_date,refund_date,payment_method,cashier,source_updated_at,nature_code)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NULL,NULL,NULL,now(),$12)`,
      [
        input.zjId, input.officeCode, input.sId, input.ownerName, input.roomNo, input.address,
        input.feeCode, input.feeName, input.period, input.amountCents, input.paidDate ?? null,
        input.natureCode,
      ],
    );
  };

  // ── 欠费（paid_date 为空）──
  // 户 A：两笔 18 位相邻 zjId，旧 Number 会合并成同一 zjId。
  await addBill({ zjId: Z_A1, officeCode: '02', sId: S_A, ownerName: '业主A', roomNo: '101', address: '永德路A', feeCode: '01', feeName: '管理费', natureCode: '01', period: '202601', amountCents: 150000 });
  await addBill({ zjId: Z_A2, officeCode: '02', sId: S_A, ownerName: '业主A', roomNo: '101', address: '永德路A', feeCode: '01', feeName: '管理费', natureCode: '01', period: '202602', amountCents: 250000 });
  // 户 B：与户 A 的 sId 相邻（18 位），旧 Number 会把两户 sId 合并。
  await addBill({ zjId: Z_B1, officeCode: '02', sId: S_B, ownerName: '业主B', roomNo: '102', address: '永德路B', feeCode: '02', feeName: '租金', natureCode: '04', period: '202603', amountCents: 300000 });
  // 普通小 ID 户 C：确认大 ID 修复不改变普通行。
  await addBill({ zjId: Z_C1, officeCode: '02', sId: S_C, ownerName: '业主C', roomNo: '501', address: '永德路C', feeCode: '01', feeName: '管理费', natureCode: '01', period: '202601', amountCents: 100000 });
  // 越权管理处（不属于 scope 小区2）数据，用于授权范围回归。
  await addBill({ zjId: Z_D1, officeCode: '01', sId: S_D, ownerName: '业主D', roomNo: '601', address: '剑川路D', feeCode: '01', feeName: '管理费', natureCode: '01', period: '202601', amountCents: 70000 });

  // ── 实收（paid_date 非空，按 period 年归属）──
  await addBill({ zjId: Z_R1, officeCode: '02', sId: S_A, ownerName: '业主A', roomNo: '101', address: '永德路A', feeCode: '01', feeName: '管理费', natureCode: '01', period: '202601', amountCents: 60000, paidDate: '2026-05-01' });
  await addBill({ zjId: Z_R2, officeCode: '02', sId: S_A, ownerName: '业主A', roomNo: '101', address: '永德路A', feeCode: '01', feeName: '管理费', natureCode: '01', period: '202602', amountCents: 40000, paidDate: '2026-05-02' });
  await addBill({ zjId: '44', officeCode: '02', sId: S_C, ownerName: '业主C', roomNo: '501', address: '永德路C', feeCode: '01', feeName: '管理费', natureCode: '01', period: '202601', amountCents: 50000, paidDate: '2026-06-01' });
  await addBill({ zjId: '45', officeCode: '02', sId: S_B, ownerName: '业主B', roomNo: '102', address: '永德路B', feeCode: '02', feeName: '租金', natureCode: '04', period: '202601', amountCents: 70000, paidDate: '2026-07-01' });
}

function makeService(
  pg: PGlite,
  statements?: string[],
  bound?: Array<{ sql: string; params?: unknown[] }>,
) {
  const communityRepo = { find: async () => communities } as any;
  const dataSource = {
    query: async (sql: string, params?: unknown[]) => {
      statements?.push(sql);
      bound?.push({ sql, params });
      return (await pg.query(sql, params as any[])).rows;
    },
  } as any;
  return new StatisticsService(dataSource, communityRepo);
}

function annualCell(result: any, officeCode: string, year: number): number {
  const row = result.rows.find((item: any) => item.officeCode === officeCode);
  assert.ok(row, `缺少管理处 ${officeCode} 行`);
  return row.cells[String(year)];
}

function assertStringIds(rows: any[], key: 'sId' | 'zjId') {
  for (const row of rows) {
    assert.equal(typeof row[key], 'string', `${key} 必须是字符串（PG bigint 经 ::text/helper 输出），实际 ${typeof row[key]}`);
    assert.match(row[key], /^-?\d{1,18}$/, `${key} 必须是数字字符串`);
  }
}

/** annualDetailBills 目前把 filters 摊平到顶层；兼容将来收进 filters 对象，两者都断言归一后的 string。 */
function normalizedResponseSId(result: any): unknown {
  return result?.filters?.sId ?? result?.sId;
}

// ───────────────────────── 真实 service + PGlite：两种 type 的守恒 ─────────────────────────

test('arrears 单元格→房屋→bills：18 位相邻 sId/zjId 不合并，ID 为字符串且各级金额守恒', async () => {
  const pg = await makeDatabase();
  try {
    await seed(pg);
    const bound: Array<{ sql: string; params?: unknown[] }> = [];
    const service = makeService(pg, undefined, bound);
    const annual: any = await service.annual({
      type: 'arrears', officeCodes: ['02'], feeCodes: ['01'], natures: ['01'], yearFrom: 2026, yearTo: 2026,
    } as never, user, scopeAll);
    const cell = annualCell(annual, '02', 2026);
    assert.equal(cell, 500000); // 户 A 400000 + 户 C 100000

    const detail: any = await service.annualDetail({
      type: 'arrears', officeCode: '02', year: 2026, feeCodes: ['01'], natures: ['01'],
    } as never, user, scopeAll);
    assert.equal(detail.available, true);
    assert.equal(detail.detailKind, 'arrears');
    assert.equal(detail.totalCents, cell);
    assert.deepEqual(detail.rows.map((row: any) => [row.sId, row.amountCents]), [
      [S_A, 400000],
      [S_C, 100000],
    ]);
    assertStringIds(detail.rows, 'sId');
    assert.equal(detail.rows.reduce((sum: number, row: any) => sum + row.amountCents, 0), cell);

    const bills: any = await service.annualDetailBills({
      type: 'arrears', officeCode: '02', sId: S_A, year: 2026, feeCodes: ['01'], natures: ['01'],
    } as never, user, scopeAll);
    assert.equal(bills.available, true);
    assert.equal(bills.totalCents, 400000);
    assert.deepEqual(bills.rows.map((row: any) => row.zjId), [Z_A1, Z_A2]);
    assertStringIds(bills.rows, 'zjId');
    assert.deepEqual(bills.rows.map((row: any) => row.amountCents), [150000, 250000]);
    assert.equal(bills.rows.reduce((sum: number, row: any) => sum + row.amountCents, 0), detail.rows[0].amountCents);

    // 实际绑定 SQL 参数必须是未舍入的 sId 字符串，而不是 helper 之外的 Number 形状。
    const billsQuery = bound.find((item) => item.sql.includes('b.zj_id::text') && item.sql.includes('FROM mis_mirror_bill b'));
    assert.ok(billsQuery, '未捕获 annualDetailBills 实际 SQL');
    const boundSId = (billsQuery.params ?? []).find((value) => value === S_A);
    assert.strictEqual(boundSId, S_A, `bills SQL 绑定的 sId 必须是原串，实际参数 ${JSON.stringify(billsQuery.params)}`);
    assert.equal(typeof boundSId, 'string', 'bills SQL 绑定的 sId 必须是 string');
    assert.equal((billsQuery.params ?? []).includes(Number(S_A)), false, '不得绑定被 Number 舍入的 sId');
    assert.strictEqual(normalizedResponseSId(bills), S_A, '响应 sId（filters.sId 或顶层）必须保留 string 原串');
    assert.equal(typeof normalizedResponseSId(bills), 'string');
  } finally {
    await pg.close();
  }
});

test('received 单元格→房屋→bills：18 位相邻 sId/zjId 不合并，ID 为字符串且各级金额守恒', async () => {
  const pg = await makeDatabase();
  try {
    await seed(pg);
    const service = makeService(pg);
    const annual: any = await service.annual({
      type: 'received', officeCodes: ['02'], feeCodes: ['01'], natures: ['01'], yearFrom: 2026, yearTo: 2026,
    } as never, user, scopeAll);
    const cell = annualCell(annual, '02', 2026);
    assert.equal(cell, 150000); // 户 A 100000 + 户 C 50000

    const detail: any = await service.annualDetail({
      type: 'received', officeCode: '02', year: 2026, feeCodes: ['01'], natures: ['01'],
    } as never, user, scopeAll);
    assert.equal(detail.available, true);
    assert.equal(detail.detailKind, 'received');
    assert.equal(detail.totalCents, cell);
    // 实收明细按「房屋 × 应收年月」聚合：户 A 两个月两行，sId 仍必须是同一 18 位字符串。
    assert.deepEqual(detail.rows.map((row: any) => [row.sId, row.period, row.amountCents]), [
      [S_A, '202601', 60000],
      [S_A, '202602', 40000],
      [S_C, '202601', 50000],
    ]);
    assertStringIds(detail.rows, 'sId');
    // 实收聚合行没有单笔标识：既有 null 语义必须保留（不能被 helper 变成字符串/抛错）。
    assert.ok(detail.rows.every((row: any) => row.zjId === null), 'received detail zjId 应保持 null');
    assert.equal(detail.rows.reduce((sum: number, row: any) => sum + row.amountCents, 0), cell);

    const bills: any = await service.annualDetailBills({
      type: 'received', officeCode: '02', sId: S_A, year: 2026, feeCodes: ['01'], natures: ['01'],
    } as never, user, scopeAll);
    assert.equal(bills.totalCents, 100000);
    assert.deepEqual(bills.rows.map((row: any) => row.zjId), [Z_R1, Z_R2]);
    assertStringIds(bills.rows, 'zjId');
    assert.equal(bills.rows.reduce((sum: number, row: any) => sum + row.amountCents, 0), 100000);
    assert.strictEqual(normalizedResponseSId(bills), S_A, 'received bills 的响应 sId 也必须是原串 string');
    assert.equal(typeof normalizedResponseSId(bills), 'string');
  } finally {
    await pg.close();
  }
});

test('相邻 18 位户 A/B 在同一下钻里保持两户独立（sId 不重复、金额不串户）', async () => {
  const pg = await makeDatabase();
  try {
    await seed(pg);
    const service = makeService(pg);
    const detail: any = await service.annualDetail({
      type: 'arrears', officeCode: '02', year: 2026,
    } as never, user, scopeAll);
    assert.deepEqual(detail.rows.map((row: any) => [row.sId, row.amountCents]), [
      [S_A, 400000],
      [S_B, 300000],
      [S_C, 100000],
    ]);
    assertStringIds(detail.rows, 'sId');
    assert.equal(new Set(detail.rows.map((row: any) => row.sId)).size, detail.rows.length, '两户 sId 不得合并');
    assert.equal(new Set([S_A, S_B]).size, 2);
  } finally {
    await pg.close();
  }
});

// ───────────────────────── 筛选/权限保持不变 ─────────────────────────

test('筛选与授权范围不变：year/fee/nature/paidDate 生效，越权 detail 仍 403', async () => {
  const pg = await makeDatabase();
  try {
    await seed(pg);
    const service = makeService(pg);

    // 行级房屋性质选中 04 商铺：只有户 B。
    const shopAnnual: any = await service.annual({
      type: 'arrears', officeCodes: ['02'], feeCodes: ['02'], natures: ['04'], yearFrom: 2026, yearTo: 2026,
    } as never, user, scopeAll);
    assert.equal(annualCell(shopAnnual, '02', 2026), 300000);
    const shopDetail: any = await service.annualDetail({
      type: 'arrears', officeCode: '02', year: 2026, feeCodes: ['02'], natures: ['04'],
    } as never, user, scopeAll);
    assert.deepEqual(shopDetail.rows.map((row: any) => row.sId), [S_B]);
    assertStringIds(shopDetail.rows, 'sId');
    const shopBills: any = await service.annualDetailBills({
      type: 'arrears', officeCode: '02', sId: S_B, year: 2026, feeCodes: ['02'], natures: ['04'],
    } as never, user, scopeAll);
    assert.deepEqual(shopBills.rows.map((row: any) => row.zjId), [Z_B1]);
    assertStringIds(shopBills.rows, 'zjId');

    // 实收收款日期上界：只保留 2026-05-01 的 60000。
    const cutoffAnnual: any = await service.annual({
      type: 'received', officeCodes: ['02'], feeCodes: ['01'], natures: ['01'], yearFrom: 2026, yearTo: 2026,
      paidDateTo: '2026-05-01',
    } as never, user, scopeAll);
    assert.equal(annualCell(cutoffAnnual, '02', 2026), 60000);
    const cutoffDetail: any = await service.annualDetail({
      type: 'received', officeCode: '02', year: 2026, feeCodes: ['01'], natures: ['01'], paidDateTo: '2026-05-01',
    } as never, user, scopeAll);
    assert.deepEqual(cutoffDetail.rows.map((row: any) => [row.sId, row.amountCents]), [[S_A, 60000]]);
    assertStringIds(cutoffDetail.rows, 'sId');
    const cutoffBills: any = await service.annualDetailBills({
      type: 'received', officeCode: '02', sId: S_A, year: 2026, feeCodes: ['01'], natures: ['01'],
      paidDateTo: '2026-05-01',
    } as never, user, scopeAll);
    assert.deepEqual(cutoffBills.rows.map((row: any) => row.zjId), [Z_R1]);
    assertStringIds(cutoffBills.rows, 'zjId');

    // 小区 2 账号只看 02/03；01 管理处的下钻仍拒绝。
    const scopedAnnual: any = await service.annual({
      type: 'arrears', feeCodes: ['01'], yearFrom: 2026, yearTo: 2026,
    } as never, user, scopeCommunityTwo);
    assert.deepEqual(scopedAnnual.rows.map((row: any) => row.officeCode), ['02', '03']);
    await assert.rejects(
      service.annualDetail({ type: 'arrears', officeCode: '01', year: 2026 } as never, user, scopeCommunityTwo),
      (error: unknown) => (error as any)?.getStatus?.() === 403,
    );
    await assert.rejects(
      service.annualDetailBills({ type: 'arrears', officeCode: '01', sId: S_D, year: 2026 } as never, user, scopeCommunityTwo),
      (error: unknown) => (error as any)?.getStatus?.() === 403,
    );
  } finally {
    await pg.close();
  }
});

// ───────────────────────── PG 输出与 DTO HTTP 字符串 ─────────────────────────

test('PG 输出：detail 的 s_id 与 bills 的 zj_id 走 ::text 后再返回字符串', async () => {
  const pg = await makeDatabase();
  try {
    await seed(pg);
    const statements: string[] = [];
    const service = makeService(pg, statements);

    statements.length = 0;
    await service.annualDetail({ type: 'arrears', officeCode: '02', year: 2026 } as never, user, scopeAll);
    const arrearsDetailSql = statements.find((sql) => sql.includes('MIN(b.period)')) ?? '';
    assert.ok(arrearsDetailSql, '未捕获 arrears detail 实际 SQL');
    assert.match(arrearsDetailSql, /b\.s_id\s*\)?\s*::\s*text/i, 'arrears detail SQL 必须把 s_id 转 ::text 输出');

    // 实收明细是另一条 buildReceivedDetailSql，也必须实际走 s_id::text。
    statements.length = 0;
    await service.annualDetail({ type: 'received', officeCode: '02', year: 2026 } as never, user, scopeAll);
    const receivedDetailSql = statements.find((sql) => sql.includes('GROUP BY b.s_id, b.period')) ?? '';
    assert.ok(receivedDetailSql, '未捕获 received detail 实际 SQL');
    assert.match(receivedDetailSql, /b\.s_id\s*\)?\s*::\s*text/i, 'received detail SQL 必须把 s_id 转 ::text 输出');

    statements.length = 0;
    await service.annualDetailBills({ type: 'arrears', officeCode: '02', sId: S_A, year: 2026 } as never, user, scopeAll);
    const billsSql = statements.find((sql) => sql.includes('b.zj_id')) ?? '';
    assert.ok(billsSql, '未捕获 bills 实际 SQL');
    assert.match(billsSql, /b\.zj_id\s*\)?\s*::\s*text/i, 'bills SQL 必须把 zj_id 转 ::text 输出');
  } finally {
    await pg.close();
  }
});

test('HTTP query：positive18 sId 保留为字符串，不经 Number（含 safe 小 ID）', async () => {
  const pipe = new ValidationPipe({ whitelist: true, transform: true });
  const parsed: any = await pipe.transform(
    { type: 'arrears', officeCode: '02', year: '2026', sId: S_B },
    { type: 'query', metatype: StatisticsBillsQueryDto },
  );
  assert.strictEqual(parsed.sId, S_B);
  assert.equal(typeof parsed.sId, 'string');

  const safe: any = await pipe.transform(
    { type: 'arrears', officeCode: '02', year: '2026', sId: '42' },
    { type: 'query', metatype: StatisticsBillsQueryDto },
  );
  assert.strictEqual(safe.sId, '42');
  assert.equal(typeof safe.sId, 'string');

  const maxSafeLike: any = await pipe.transform(
    { type: 'arrears', officeCode: '02', year: '2026', sId: '9007199254740993' },
    { type: 'query', metatype: StatisticsBillsQueryDto },
  );
  assert.strictEqual(maxSafeLike.sId, '9007199254740993');
});

test('HTTP query 非法 sId：数组/指数/空白/19 位/小数/0/负数 一律 400', async () => {
  const pipe = new ValidationPipe({ whitelist: true, transform: true });
  const invalid = [
    ['1', '2'],
    '1e3',
    ' 42',
    '42 ',
    '\t42',
    '042',
    '1000000000000000000',
    '1.0',
    '0',
    '-1',
    'abc',
    '',
    ' ',
    '１２３',
  ];
  for (const sId of invalid) {
    await assert.rejects(
      pipe.transform(
        { type: 'arrears', officeCode: '02', year: '2026', sId },
        { type: 'query', metatype: StatisticsBillsQueryDto },
      ),
      (error: unknown) => error instanceof BadRequestException,
      `sId=${JSON.stringify(sId)} 必须 400`,
    );
  }
});

test('旧 safe Number 内部调用兼容且响应 ID 仍为字符串；unsafe Number 直接调用 400', async () => {
  const pg = await makeDatabase();
  try {
    await seed(pg);
    const service = makeService(pg);

    // 旧内部调用：sId 仍是 safe number 501，应继续可用，但返回 sId/zjId 必须是字符串。
    const detail: any = await service.annualDetail({
      type: 'arrears', officeCode: '02', year: 2026,
    } as never, user, scopeAll);
    const rowC = detail.rows.find((row: any) => row.sId === S_C);
    assert.ok(rowC, '普通小 ID 户仍应返回');
    assert.strictEqual(rowC.sId, S_C);

    const bills: any = await service.annualDetailBills({
      type: 'arrears', officeCode: '02', sId: 501 as any, year: 2026,
    } as never, user, scopeAll);
    assert.equal(bills.available, true);
    assert.deepEqual(bills.rows.map((row: any) => row.zjId), [Z_C1]);
    assertStringIds(bills.rows, 'zjId');
    // 旧 safe numeric 内部调用：响应 sId 必须是归一后的 string，而不是沿用入参 number。
    assert.strictEqual(normalizedResponseSId(bills), S_C);
    assert.equal(typeof normalizedResponseSId(bills), 'string');

    // unsafe Number（18 位边界被舍入的 Double）不能当成合法 sId 查询。
    await assert.rejects(
      service.annualDetailBills({
        type: 'arrears', officeCode: '02', sId: Number(S_B) as any, year: 2026,
      } as never, user, scopeAll),
      (error: unknown) => error instanceof BadRequestException,
    );
  } finally {
    await pg.close();
  }
});

// ───────────────────────── annual-source-id helper 契约 ─────────────────────────

function is503(error: unknown): boolean {
  return error instanceof ServiceUnavailableException || (error as any)?.getStatus?.() === 503;
}

test('annualIdInput 与 ANNUAL_ROOM_ID_RE：safe Number 转字符串，positive18 边界明确', () => {
  assert.strictEqual(annualIdInput(42), '42');
  assert.strictEqual(annualIdInput(Number.MAX_SAFE_INTEGER), '9007199254740991');
  assert.strictEqual(annualIdInput(S_A), S_A);
  assert.strictEqual(annualIdInput(2 ** 60), 2 ** 60, 'unsafe Number 不修补');
  assert.strictEqual(annualIdInput(null), null);

  assert.equal(ANNUAL_ROOM_ID_RE.test('1'), true);
  assert.equal(ANNUAL_ROOM_ID_RE.test(S_A), true);
  assert.equal(ANNUAL_ROOM_ID_RE.test('9007199254740993'), true);
  for (const invalid of ['0', '-1', '01', '042', '1e3', ' 42', '42 ', '1000000000000000000', '1.0', '', 'abc', '１２３']) {
    assert.equal(ANNUAL_ROOM_ID_RE.test(invalid), false, invalid);
  }
});

test('annualRoomId：positive18 转 string，非法/unsafe/数组 400', () => {
  assert.strictEqual(annualRoomId(S_B), S_B);
  assert.strictEqual(annualRoomId('9007199254740993'), '9007199254740993');
  assert.strictEqual(annualRoomId(501), '501');
  for (const invalid of [
    '0', '-1', '042', '1e3', ' 42', '42 ', '1.0', '1000000000000000000', '',
    ['1', '2'], null, undefined, Number(S_B), 2 ** 60, Number.NaN,
  ]) {
    assert.throws(
      () => annualRoomId(invalid),
      (error: unknown) => error instanceof BadRequestException,
      String(invalid),
    );
  }
});

test('annualSourceId：signed18 输出 string，safe Number 兼容，unsafe/坏格式 503', () => {
  assert.strictEqual(annualSourceId(S_A), S_A);
  assert.strictEqual(annualSourceId('0'), '0');
  assert.strictEqual(annualSourceId('-1'), '-1');
  assert.strictEqual(annualSourceId(42), '42');
  for (const invalid of [
    Number(S_B), 2 ** 60, Number.NaN, Number.POSITIVE_INFINITY, 1.5,
    '1000000000000000000', ' 42', '42 ', '1e3', '', null, undefined, ['1'],
  ]) {
    assert.throws(() => annualSourceId(invalid), is503, String(invalid));
  }
});

test('非法 sId 在 requireTenant→validatePaidDates→annualRoomId 阶段 400，且 DB 前 0 查询', async () => {
  const pg = await makeDatabase();
  try {
    await seed(pg);
    const statements: string[] = [];
    const service = makeService(pg, statements);
    for (const sId of ['0', '-1', '1e3', ' 42', '1000000000000000000', ['1', '2']] as any[]) {
      await assert.rejects(
        service.annualDetailBills({ type: 'arrears', officeCode: '02', sId, year: 2026 } as never, user, scopeAll),
        (error: unknown) => error instanceof BadRequestException,
        `sId=${JSON.stringify(sId)}`,
      );
    }
    assert.deepEqual(statements, [], '非法 sId 不允许触发任何 DB 查询');
    // requireTenant 最先：无租户仍 403，而不是被 sId 校验掩盖。
    await assert.rejects(
      service.annualDetailBills(
        { type: 'arrears', officeCode: '02', sId: 'bad', year: 2026 } as never,
        { id: 7 } as never,
        scopeAll,
      ),
      (error: unknown) => (error as any)?.getStatus?.() === 403,
    );
  } finally {
    await pg.close();
  }
});

test('source sId 为 NULL 的实收明细保留 null，不被 annualSourceId 转成字符串或抛错', async () => {
  const pg = await makeDatabase();
  try {
    await seed(pg);
    await pg.query(
      `INSERT INTO mis_mirror_bill(zj_id,office_code,s_id,owner_name,room_no,address,fee_code,fee_name,
        period,amount_cents,paid_date,refund_date,payment_method,cashier,source_updated_at,nature_code)
       VALUES('46','02',NULL,'无房户','','永德路无房屋','01','管理费','202601',1000,'2026-08-01',NULL,NULL,NULL,now(),'01')`,
    );
    const service = makeService(pg);
    const detail: any = await service.annualDetail({
      type: 'received', officeCode: '02', year: 2026, feeCodes: ['01'], natures: ['01'],
    } as never, user, scopeAll);
    const nullRow = detail.rows.find((row: any) => row.sId === null);
    assert.ok(nullRow, '源 s_id 为 NULL 的明细行应保留 sId=null');
    assert.equal(nullRow.zjId, null);
    assert.equal(nullRow.amountCents, 1000);
    assertStringIds(detail.rows.filter((row: any) => row.sId !== null), 'sId');
  } finally {
    await pg.close();
  }
});
