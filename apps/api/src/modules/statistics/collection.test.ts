import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { BadRequestException, RequestMethod, ValidationPipe } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { PGlite } from '@electric-sql/pglite';
import { PERMISSION_KEY } from '../../common/require-permission.decorator';
import { MisMirror1794500000000 } from '../../migrations/1794500000000-MisMirror';
import { MisMirrorBillNature1795300000000 } from '../../migrations/1795300000000-MisMirrorBillNature';
import { MisMirrorFeeItemCategory1795400000000 } from '../../migrations/1795400000000-MisMirrorFeeItemCategory';
import { CollectionStatisticsService } from './collection.service';
import {
  CollectionDailyQueryDto,
  CollectionDetailQueryDto,
  CollectionMonthlyQueryDto,
  CollectionSummaryQueryDto,
} from './dto';
import { StatisticsController } from './statistics.controller';
import { STATISTICS_NATURE_OPTIONS } from './statistics.util';

const tenantId = 1;
const user = { id: 7, tenantId } as never;
const scopeAll = { scopeAll: true } as never;
const scopeCommunityTwo = { scopeAll: false, communityIds: [2] } as never;

const communities = [
  { id: 1, name: '枫桦景苑一期' },
  { id: 2, name: '枫桦景苑二期' },
  { id: 16, name: '上海新家' },
];

const FEE_ITEMS: Array<[string, string, string]> = [
  ['01', '管理费', '日常收费'], ['02', '租金', '日常收费'], ['03', '保洁保安费', '日常收费'],
  ['04', '泊位费', '停车收费'], ['05', '临时停车费', '停车收费'], ['06', '保安费', '日常收费'],
  ['07', '保洁费', '日常收费'], ['08', '保安保洁费', '日常收费'], ['09', '网络费', '代收费'],
  ['10', '青客租金', '其它'], ['11', '青客未签约租金', '其它'], ['12', '水费', '代收费'],
  ['13', '电费', '代收费'], ['14', '停车管理费', '停车收费'], ['15', '空房租金', '其它'],
  ['16', '置业泊位费', '停车收费'],
];

const PAYMENT_METHODS: Array<[number, string]> = [
  [1, '现金'], [2, '微信'], [3, '支付宝'], [4, '转账'], [5, '其他'],
];

async function makeDatabase() {
  const pg = new PGlite();
  const migration = new MisMirror1794500000000();
  await migration.up({ query: (sql: string) => pg.query(sql) } as any);
  const nature = new MisMirrorBillNature1795300000000();
  await nature.up({ query: (sql: string) => pg.query(sql) } as any);
  const feeCategory = new MisMirrorFeeItemCategory1795400000000();
  await feeCategory.up({ query: (sql: string) => pg.query(sql) } as any);
  return pg;
}

function serviceFor(pg: PGlite) {
  const communityRepo = { find: async () => communities } as any;
  return new CollectionStatisticsService(
    { query: async (sql: string, params?: unknown[]) => (await pg.query(sql, params as any[])).rows } as any,
    communityRepo,
  );
}

interface BillInput {
  officeCode: string;
  sId: number;
  feeCode: string;
  feeName: string;
  natureCode: string | null;
  period: string;
  amountCents: number;
  paidDate?: string | null;
  refundDate?: string | null;
  paymentMethod?: string | null;
  cashier?: string | null;
  address?: string;
  ownerName?: string;
}

/**
 * P2-B 验收夹具（§6 A1/A2/A3，02 管理处 2026-10）：
 * 收款块 15,374,220、退款块 15,000（成对负数行不重复计）、调整块 -60,000、净额 15,314,220。
 * 泊位费收款/退款行为 nature 空（不落性质列），调整行为 nature 01。
 */
async function seed(pg: PGlite) {
  await pg.query(
    `INSERT INTO mis_sync_state(tenant_id,source_table,last_success_at,initialized_at)
     VALUES($1,'bill',$2,now())`,
    [tenantId, '2026-11-09T21:30:00+08:00'],
  );
  for (const [code, name, category] of FEE_ITEMS) {
    await pg.query(`INSERT INTO mis_mirror_fee_item(fee_code,fee_name,category) VALUES($1,$2,$3)`, [code, name, category]);
  }
  for (const [id, name] of PAYMENT_METHODS) {
    await pg.query(`INSERT INTO mis_mirror_payment_method(method_id,method_name) VALUES($1,$2)`, [id, name]);
  }
  let nextZj = 1;
  const addBill = async (input: BillInput) => {
    await pg.query(
      `INSERT INTO mis_mirror_bill(zj_id,office_code,s_id,owner_name,room_no,address,fee_code,fee_name,
        period,amount_cents,paid_date,refund_date,payment_method,cashier,source_updated_at,nature_code)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now(),$15)`,
      [
        nextZj++, input.officeCode, input.sId, input.ownerName ?? '合成业主', String(input.sId),
        input.address ?? `合成路${input.sId}号`, input.feeCode, input.feeName, input.period,
        input.amountCents, input.paidDate ?? null, input.refundDate ?? null,
        input.paymentMethod ?? null, input.cashier ?? null, input.natureCode,
      ],
    );
  };

  // ── 02 管理处 2026-10 验收数据 ──
  await addBill({ officeCode: '02', sId: 501, feeCode: '01', feeName: '管理费', natureCode: '01', period: '202610', amountCents: 11_915_220, paidDate: '2026-10-05', paymentMethod: '微信', cashier: '赵丽萍', address: '永德路228弄501号', ownerName: '二期业主501' });
  // 泊位费收款：nature 为空 → 不算任何性质，但计入收款块。
  await addBill({ officeCode: '02', sId: 502, feeCode: '04', feeName: '泊位费', natureCode: null, period: '202610', amountCents: 3_105_000, paidDate: '2026-10-06', paymentMethod: '现金', cashier: '刘微微' });
  // 负调整（真实负现金流，不是退款）。
  await addBill({ officeCode: '02', sId: 502, feeCode: '04', feeName: '泊位费', natureCode: '01', period: '202610', amountCents: -60_000, paidDate: '2026-10-07', paymentMethod: '现金', cashier: '刘微微' });
  // 成对退款：原收款正行 + 成对负数行（都不要重复计入退款块，只计正行 15,000）。
  await addBill({ officeCode: '02', sId: 502, feeCode: '04', feeName: '泊位费', natureCode: null, period: '202609', amountCents: 15_000, paidDate: '2026-09-01', refundDate: '2026-10-19', paymentMethod: '微信', cashier: '刘微微' });
  await addBill({ officeCode: '02', sId: 502, feeCode: '04', feeName: '泊位费', natureCode: null, period: '202609', amountCents: -15_000, paidDate: '2026-09-01', refundDate: '2026-10-19', paymentMethod: '微信', cashier: '刘微微' });
  await addBill({ officeCode: '02', sId: 503, feeCode: '14', feeName: '停车管理费', natureCode: null, period: '202610', amountCents: 324_000, paidDate: '2026-10-08', paymentMethod: '支付宝', cashier: '伍庆中' });
  await addBill({ officeCode: '02', sId: 504, feeCode: '16', feeName: '置业泊位费', natureCode: null, period: '202610', amountCents: 30_000, paidDate: '2026-10-09', paymentMethod: '转账', cashier: '伍庆中' });
  // ── 区间边界与未缴行 ──
  await addBill({ officeCode: '02', sId: 501, feeCode: '01', feeName: '管理费', natureCode: '01', period: '202609', amountCents: 9_900, paidDate: '2026-09-30', paymentMethod: '微信', cashier: '赵丽萍' });
  await addBill({ officeCode: '02', sId: 501, feeCode: '01', feeName: '管理费', natureCode: '01', period: '202611', amountCents: 8_800, paidDate: '2026-11-01', paymentMethod: '微信', cashier: '赵丽萍' });
  await addBill({ officeCode: '02', sId: 501, feeCode: '01', feeName: '管理费', natureCode: '01', period: '202610', amountCents: 123_456, paidDate: null });
  // ── 12 月：付款方式/收款人空值 + 跨所属年度（period=202501）──
  await addBill({ officeCode: '02', sId: 501, feeCode: '01', feeName: '管理费', natureCode: '01', period: '202501', amountCents: 7_000, paidDate: '2026-12-05', paymentMethod: '微信', cashier: '赵丽萍' });
  await addBill({ officeCode: '02', sId: 501, feeCode: '01', feeName: '管理费', natureCode: '01', period: '202612', amountCents: 100, paidDate: '2026-12-10', paymentMethod: null, cashier: null });
  // ── 其它管理处（范围测试）──
  await addBill({ officeCode: '01', sId: 719, feeCode: '01', feeName: '管理费', natureCode: '01', period: '202610', amountCents: 2_500, paidDate: '2026-10-05', paymentMethod: '现金', cashier: '张三', address: '宝秀路719号719', ownerName: '宝秀路业主' });
  await addBill({ officeCode: '03', sId: 901, feeCode: '01', feeName: '管理费', natureCode: '01', period: '202610', amountCents: 700, paidDate: '2026-10-05', paymentMethod: null, cashier: null });
}

const OCTOBER = { dateFrom: '2026-10-01', dateTo: '2026-10-31' };
/** 验收基准固定 02 管理处（全部管理处会把 01/03 的 3,200 分算进来）。 */
const OCT_02 = { ...OCTOBER, officeCodes: ['02'] };

function rowsOf(result: any, keys: string[]) {
  return result.rows.map((row: any) => keys.map((key) => row[key]));
}

test('验收 A1/A2/A3：02 管理处 2026-10 收款/退款/调整四类拆分', async () => {
  const pg = await makeDatabase();
  try {
    await seed(pg);
    const service = serviceFor(pg);
    const summary: any = await service.collectionSummary(OCT_02 as never, user, scopeAll);
    assert.equal(summary.available, true);
    assert.equal(summary.groupBy, 'fee');
    const fee01 = summary.rows.find((row: any) => row.key === '01');
    const fee04 = summary.rows.find((row: any) => row.key === '04');
    const fee14 = summary.rows.find((row: any) => row.key === '14');
    const fee16 = summary.rows.find((row: any) => row.key === '16');
    assert.deepEqual(
      [fee01.receivedCents, fee01.refundCents, fee01.adjustCents, fee01.netCents],
      [11_915_220, 0, 0, 11_915_220],
    );
    // 成对退款只计原收款正行 15,000，负数行不重复计（否则会是 30,000）。
    assert.deepEqual(
      [fee04.receivedCents, fee04.refundCents, fee04.adjustCents, fee04.netCents],
      [3_105_000, 15_000, -60_000, 3_045_000],
    );
    assert.deepEqual([fee14.receivedCents, fee14.netCents], [324_000, 324_000]);
    assert.deepEqual([fee16.receivedCents, fee16.netCents], [30_000, 30_000]);
    assert.deepEqual(summary.total, {
      receivedCents: 15_374_220,
      refundCents: 15_000,
      adjustCents: -60_000,
      netCents: 15_314_220,
      countReceived: 4,
      countRefund: 1,
      countAdjust: 1,
      count: 6,
    });
    assert.deepEqual(summary.rows.map((row: any) => row.key), ['01', '04', '14', '16']);
    assert.deepEqual(summary.filters.paymentMethods, null);
    assert.deepEqual(summary.filters.yearFrom, null);
    // 02 单管理处条件（范围矩阵口径）：与合计一致。
    const only02: any = await service.collectionSummary({ ...OCTOBER, officeCodes: ['02'] } as never, user, scopeAll);
    assert.deepEqual(only02.total, summary.total);
  } finally {
    await pg.close();
  }
});

test('summary 分组：office/method/cashier 名称与空值「未记录」，行按净额降序', async () => {
  const pg = await makeDatabase();
  try {
    await seed(pg);
    const service = serviceFor(pg);
    const byMethod: any = await service.collectionSummary({ ...OCT_02, groupBy: 'method' } as never, user, scopeAll);
    assert.deepEqual(rowsOf(byMethod, ['key', 'label', 'receivedCents', 'refundCents', 'adjustCents', 'netCents']), [
      ['微信', '微信', 11_915_220, 15_000, 0, 11_915_220],
      ['现金', '现金', 3_105_000, 0, -60_000, 3_045_000],
      ['支付宝', '支付宝', 324_000, 0, 0, 324_000],
      ['转账', '转账', 30_000, 0, 0, 30_000],
    ]);
    // 空收款方式/收款人只在 12 月数据里出现。
    const december: any = await service.collectionSummary({ dateFrom: '2026-12-01', dateTo: '2026-12-31', groupBy: 'method' } as never, user, scopeAll);
    assert.deepEqual(rowsOf(december, ['key', 'label']), [['微信', '微信'], ['', '未记录']]);
    const byCashier: any = await service.collectionSummary({ dateFrom: '2026-12-01', dateTo: '2026-12-31', groupBy: 'cashier' } as never, user, scopeAll);
    assert.deepEqual(rowsOf(byCashier, ['key', 'label']), [['赵丽萍', '赵丽萍'], ['', '未记录']]);
  } finally {
    await pg.close();
  }
});

test('日期左闭右开 & 年度筛选 & 付款方式/收款人筛选', async () => {
  const pg = await makeDatabase();
  try {
    await seed(pg);
    const service = serviceFor(pg);
    const summary = (extra: Record<string, unknown> = {}) =>
      service.collectionSummary({ ...OCT_02, ...extra } as never, user, scopeAll) as Promise<any>;

    const singleDay: any = await summary({ dateFrom: '2026-10-05', dateTo: '2026-10-05' });
    assert.equal(singleDay.total.receivedCents, 11_915_220);
    const beforeStart: any = await summary({ dateFrom: '2026-10-01', dateTo: '2026-10-04' });
    assert.equal(beforeStart.total.receivedCents, 0);
    // 2026-11-01 的收款不在 10-31 区间（右开）。
    const throughLastDay: any = await summary({ dateFrom: '2026-10-01', dateTo: '2026-10-31' });
    assert.equal(throughLastDay.total.receivedCents, 15_374_220);

    // 收款方式/收款人筛选（仅 02 管理处现金）。
    const cashOnly: any = await summary({ paymentMethods: ['现金'] });
    assert.deepEqual([cashOnly.total.receivedCents, cashOnly.total.adjustCents], [3_105_000, -60_000]);
    const cashierOnly: any = await summary({ cashier: '伍庆中' });
    assert.deepEqual([cashierOnly.total.receivedCents, cashierOnly.total.count], [354_000, 2]);

    // 所属年度：12 月 7,000 分 period=202501；yearFrom=2026 排除它，yearTo=2025 只留它。
    const dec = { dateFrom: '2026-12-01', dateTo: '2026-12-31' };
    const decAll: any = await service.collectionSummary({ ...dec, officeCodes: ['02'] } as never, user, scopeAll);
    assert.equal(decAll.total.receivedCents, 7_100);
    const decCurrentYear: any = await service.collectionSummary({ ...dec, officeCodes: ['02'], yearFrom: 2026, yearTo: 2026 } as never, user, scopeAll);
    assert.equal(decCurrentYear.total.receivedCents, 100);
    const decOldYear: any = await service.collectionSummary({ ...dec, officeCodes: ['02'], yearTo: 2025 } as never, user, scopeAll);
    assert.equal(decOldYear.total.receivedCents, 7_000);
  } finally {
    await pg.close();
  }
});

test('collection/detail：四类行拆分、kind 过滤与 totals、原始金额、分页不影响合计', async () => {
  const pg = await makeDatabase();
  try {
    await seed(pg);
    const service = serviceFor(pg);
    const detail: any = await service.collectionDetail(OCT_02 as never, user, scopeAll);
    assert.equal(detail.available, true);
    assert.equal(detail.count, 6);
    assert.deepEqual(detail.totals, {
      receivedCents: 15_374_220, refundCents: 15_000, adjustCents: -60_000, netCents: 15_314_220,
    });
    // 明细行合计 = 收款块 + 调整块 + 退款块（退款行金额为正、单列展示）。
    assert.equal(
      detail.rows.reduce((sum: number, row: any) => sum + row.amountCents, 0),
      detail.totals.receivedCents + detail.totals.adjustCents + detail.totals.refundCents,
    );
    const refundRow = detail.rows.find((row: any) => row.rowKind === 'refund');
    assert.equal(refundRow.amountCents, 15_000); // 退款行金额为正，由 rowKind 标识
    assert.equal(refundRow.refundDate, '2026-10-19');
    const adjustRow = detail.rows.find((row: any) => row.rowKind === 'adjust');
    assert.equal(adjustRow.amountCents, -60_000);
    assert.equal(adjustRow.natureCode, '01');
    // 成对负数行不进入明细（避免双计）。
    assert.equal(detail.rows.filter((row: any) => row.zjId === 5).length, 0);
    assert.equal(detail.rows.some((row: any) => row.feeCode === '01' && row.amountCents === 123_456), false);

    const receivedOnly: any = await service.collectionDetail({ ...OCT_02, kind: 'received' } as never, user, scopeAll);
    assert.equal(receivedOnly.count, 4);
    assert.deepEqual(receivedOnly.totals, {
      receivedCents: 15_374_220, refundCents: 0, adjustCents: 0, netCents: 15_374_220,
    });
    const refundOnly: any = await service.collectionDetail({ ...OCT_02, kind: 'refund' } as never, user, scopeAll);
    assert.equal(refundOnly.count, 1);
    assert.deepEqual(refundOnly.totals, { receivedCents: 0, refundCents: 15_000, adjustCents: 0, netCents: -15_000 });
    const adjustOnly: any = await service.collectionDetail({ ...OCT_02, kind: 'adjust' } as never, user, scopeAll);
    assert.equal(adjustOnly.count, 1);
    assert.deepEqual(adjustOnly.totals, { receivedCents: 0, refundCents: 0, adjustCents: -60_000, netCents: -60_000 });

    const page: any = await service.collectionDetail({ ...OCT_02, limit: 2, offset: 0 } as never, user, scopeAll);
    assert.equal(page.rows.length, 2);
    assert.equal(page.count, 6);
    assert.deepEqual(page.totals, detail.totals);
    const beyond: any = await service.collectionDetail({ ...OCT_02, limit: 2, offset: 50 } as never, user, scopeAll);
    assert.deepEqual(beyond.rows, []);
    assert.equal(beyond.count, 6);
  } finally {
    await pg.close();
  }
});

test('collection/fee-nature：费项×性质净额矩阵，空性质不落列但计入行块', async () => {
  const pg = await makeDatabase();
  try {
    await seed(pg);
    const service = serviceFor(pg);
    const matrix: any = await service.collectionFeeNature(OCT_02 as never, user, scopeAll);
    assert.equal(matrix.available, true);
    assert.deepEqual(matrix.natures, STATISTICS_NATURE_OPTIONS);
    assert.equal(matrix.natures.length, 13);
    assert.deepEqual(matrix.columns.map((column: any) => column.code), FEE_ITEMS.map(([code]) => code));
    const fee01 = matrix.rows.find((row: any) => row.feeCode === '01');
    const fee04 = matrix.rows.find((row: any) => row.feeCode === '04');
    assert.equal(fee01.cells['01'], 11_915_220);
    assert.equal(fee01.netCents, 11_915_220);
    // 泊位费：收款/退款 nature 为空 → 不进任何性质列；调整 nature 01 进「01 商品房」。
    assert.equal(fee04.cells['01'], -60_000);
    assert.equal(fee04.cells['04'], 0);
    assert.deepEqual(
      [fee04.receivedCents, fee04.refundCents, fee04.adjustCents, fee04.netCents],
      [3_105_000, 15_000, -60_000, 3_045_000],
    );
    assert.deepEqual(matrix.subtotal.cells['01'], 11_855_220);
    assert.deepEqual(
      [matrix.subtotal.receivedCents, matrix.subtotal.refundCents, matrix.subtotal.adjustCents, matrix.subtotal.netCents],
      [15_374_220, 15_000, -60_000, 15_314_220],
    );

    // 性质筛选：只保留 nature 01 行（空性质收款/退款被排除）。
    const nature01: any = await service.collectionFeeNature({ ...OCT_02, natures: ['01'] } as never, user, scopeAll);
    const fee04Nature01 = nature01.rows.find((row: any) => row.feeCode === '04');
    assert.deepEqual(
      [fee04Nature01.receivedCents, fee04Nature01.refundCents, fee04Nature01.adjustCents, fee04Nature01.netCents],
      [0, 0, -60_000, -60_000],
    );
    assert.equal(nature01.subtotal.receivedCents, 11_915_220);
    assert.equal(nature01.subtotal.netCents, 11_855_220);
  } finally {
    await pg.close();
  }
});

test('daily：cells=收款块、退款/调整单列、只返回有收款日期', async () => {
  const pg = await makeDatabase();
  try {
    await seed(pg);
    const service = serviceFor(pg);
    const daily: any = await service.daily(OCT_02 as never, user, scopeAll);
    assert.equal(daily.available, true);
    assert.equal(daily.columns.length, 16);
    assert.deepEqual(daily.rows.map((row: any) => row.date), ['2026-10-05', '2026-10-06', '2026-10-08', '2026-10-09']);
    assert.deepEqual(daily.rows.map((row: any) => row.totalCents), [11_915_220, 3_105_000, 324_000, 30_000]);
    assert.equal(daily.subtotal.totalCents, 15_374_220);
    // 10-07 只有负调整、10-19 只有退款：不虚构日期行，但计入总额。
    assert.equal(daily.refundTotalCents, 15_000);
    assert.equal(daily.adjustTotalCents, -60_000);
    assert.equal(daily.rows.some((row: any) => row.date === '2026-10-07'), false);

    const single: any = await service.daily({ dateFrom: '2026-10-05', dateTo: '2026-10-05', officeCodes: ['02'] } as never, user, scopeAll);
    assert.equal(single.rows.length, 1);
    assert.equal(single.subtotal.totalCents, 11_915_220);
  } finally {
    await pg.close();
  }
});

test('权限范围：管理处按小区收敛；越权勾选空表；无租户 403', async () => {
  const pg = await makeDatabase();
  try {
    await seed(pg);
    const service = serviceFor(pg);
    const summary: any = await service.collectionSummary(OCTOBER as never, user, scopeCommunityTwo);
    assert.deepEqual(summary.filters.officeCodes, ['02', '03']);
    assert.equal(summary.total.receivedCents, 15_374_220 + 700);
    const outOfScope: any = await service.collectionSummary({ ...OCTOBER, officeCodes: ['01'] } as never, user, scopeCommunityTwo);
    assert.deepEqual(outOfScope.rows, []);
    assert.equal(outOfScope.total.receivedCents, 0);
    const outDetail: any = await service.collectionDetail({ ...OCTOBER, officeCodes: ['01'] } as never, user, scopeCommunityTwo);
    assert.deepEqual(outDetail.rows, []);
    assert.equal(outDetail.totals.receivedCents, 0);
    const emptyMatrix: any = await service.collectionFeeNature({ ...OCTOBER } as never, user, { scopeAll: false, communityIds: [] } as never);
    assert.equal(emptyMatrix.available, true);
    assert.equal(emptyMatrix.rows.length, 16);
    assert.equal(emptyMatrix.subtotal.netCents, 0);
    await assert.rejects(
      service.collectionSummary(OCT_02 as never, { id: 7 } as never, scopeAll),
      /tenant scope is required/,
    );
  } finally {
    await pg.close();
  }
});

test('非法日期/跨度>366/from>to 直接调用 service 也 400', async () => {
  const pg = await makeDatabase();
  try {
    await seed(pg);
    const service = serviceFor(pg);
    for (const query of [
      { dateTo: '2026-10-31' },
      { dateFrom: '2026-02-30', dateTo: '2026-10-31' },
      { dateFrom: '2026-11-01', dateTo: '2026-10-01' },
      { dateFrom: '2024-01-01', dateTo: '2025-01-02' },
    ]) {
      await assert.rejects(
        service.collectionSummary(query as never, user, scopeAll),
        (error: unknown) => error instanceof BadRequestException,
      );
    }
  } finally {
    await pg.close();
  }
});

test('镜像未同步：available:false + message，不伪造 0 金额', async () => {
  const pg = await makeDatabase();
  try {
    const service = serviceFor(pg);
    const summary: any = await service.collectionSummary(OCT_02 as never, user, scopeAll);
    assert.equal(summary.available, false);
    assert.equal(summary.total, null);
    assert.match(summary.message, /镜像/);
    const fake: any = await service.collectionFeeNature(OCT_02 as never, user, scopeAll);
    assert.equal(fake.available, false);
    assert.equal(fake.subtotal, null);
    assert.deepEqual(fake.rows, []);
    const detail: any = await service.collectionDetail(OCT_02 as never, user, scopeAll);
    assert.equal(detail.available, false);
    assert.equal(detail.totals, null);
    const daily: any = await service.daily(OCT_02 as never, user, scopeAll);
    assert.equal(daily.available, false);
    assert.equal(daily.subtotal, null);
    assert.equal(daily.refundTotalCents, null);
  } finally {
    await pg.close();
  }
});

test('报表 SQL 参数化且各 1 条聚合：summary/fee-nature/daily/monthly 1 条，detail 2 条', async () => {
  const pg = await makeDatabase();
  try {
    await seed(pg);
    const statements: string[] = [];
    const service = new CollectionStatisticsService(
      {
        query: async (sql: string, params?: unknown[]) => {
          statements.push(sql);
          return (await pg.query(sql, params as any[])).rows;
        },
      } as any,
      { find: async () => communities } as any,
    );
    const countBillSql = () => statements.filter((sql) => sql.includes('mis_mirror_bill b')).length;
    for (const [method, expected] of [
      [() => service.collectionSummary(OCT_02 as never, user, scopeAll), 1],
      [() => service.collectionFeeNature(OCT_02 as never, user, scopeAll), 1],
      [() => service.collectionDetail(OCT_02 as never, user, scopeAll), 2],
      [() => service.daily(OCT_02 as never, user, scopeAll), 1],
      [() => service.monthly({ year: 2026 } as never, user, scopeAll), 1],
    ] as Array<[() => Promise<unknown>, number]>) {
      statements.length = 0;
      await method();
      assert.equal(countBillSql(), expected);
      const billSql = statements.filter((sql) => sql.includes('mis_mirror_bill b'));
      assert.ok(billSql.every((sql) => /\$\d+/.test(sql)));
    }
  } finally {
    await pg.close();
  }
});

test('DTO：新筛选字段/kind 枚举/日期与年度校验', async () => {
  const pipe = new ValidationPipe({ whitelist: true, transform: true });
  const transform = (value: Record<string, unknown>, metatype: any) =>
    pipe.transform(value, { type: 'query', metatype });
  await assert.rejects(transform({ dateTo: '2026-10-31' }, CollectionSummaryQueryDto), BadRequestException);
  await assert.rejects(transform({ ...OCTOBER, groupBy: 'bogus' }, CollectionSummaryQueryDto), BadRequestException);
  await assert.rejects(transform({ ...OCT_02, kind: 'bogus' }, CollectionDetailQueryDto), BadRequestException);
  await assert.rejects(transform({ ...OCT_02, limit: '501' }, CollectionDetailQueryDto), BadRequestException);
  await assert.rejects(transform({ ...OCTOBER, yearFrom: '2003' }, CollectionSummaryQueryDto), BadRequestException);
  const parsed = (await transform({
    ...OCTOBER, officeCodes: '01,02', feeCodes: '01', natures: '01,04',
    paymentMethods: '现金,微信', cashier: '赵丽萍', yearFrom: '2025', yearTo: '2026', groupBy: 'office',
  }, CollectionSummaryQueryDto)) as CollectionSummaryQueryDto;
  assert.deepEqual(parsed.officeCodes, ['01', '02']);
  assert.deepEqual(parsed.paymentMethods, ['现金', '微信']);
  assert.equal(parsed.cashier, '赵丽萍');
  assert.equal(parsed.yearFrom, 2025);
  assert.equal(parsed.yearTo, 2026);
  const detail = (await transform({ ...OCT_02, kind: 'refund', limit: '50', offset: '10' }, CollectionDetailQueryDto)) as CollectionDetailQueryDto;
  assert.equal(detail.kind, 'refund');
  assert.equal(detail.limit, 50);
  assert.equal(detail.offset, 10);
  assert.equal((await transform(OCTOBER, CollectionDailyQueryDto) as CollectionDailyQueryDto).dateFrom, '2026-10-01');
  assert.equal((await transform({ year: '2026' }, CollectionMonthlyQueryDto) as CollectionMonthlyQueryDto).year, 2026);
});

test('P2 接口复用 business:view，GET 路由含 collection/fee-nature', () => {
  const handlers = StatisticsController.prototype as unknown as Record<string, any>;
  for (const key of ['collectionSummary', 'collectionFeeNature', 'collectionDetail', 'daily', 'monthly']) {
    assert.deepEqual(Reflect.getMetadata(PERMISSION_KEY, handlers[key]), {
      items: [{ pageKey: 'business', action: 'view' }],
    });
    assert.equal(Reflect.getMetadata(METHOD_METADATA, handlers[key]), RequestMethod.GET, key);
  }
  assert.equal(Reflect.getMetadata(PATH_METADATA, handlers.collectionSummary), 'collection/summary');
  assert.equal(Reflect.getMetadata(PATH_METADATA, handlers.collectionFeeNature), 'collection/fee-nature');
  assert.equal(Reflect.getMetadata(PATH_METADATA, handlers.collectionDetail), 'collection/detail');
});
