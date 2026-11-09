import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { BadRequestException, RequestMethod, ValidationPipe } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { PGlite } from '@electric-sql/pglite';
import { PERMISSION_KEY } from '../../common/require-permission.decorator';
import { MisMirror1794500000000 } from '../../migrations/1794500000000-MisMirror';
import { MisMirrorBillNature1795300000000 } from '../../migrations/1795300000000-MisMirrorBillNature';
import { CollectionStatisticsService } from './collection.service';
import {
  CollectionDailyQueryDto,
  CollectionDetailQueryDto,
  CollectionMonthlyQueryDto,
  CollectionSummaryQueryDto,
} from './dto';
import { StatisticsController } from './statistics.controller';

const tenantId = 1;
const user = { id: 7, tenantId } as never;
const scopeAll = { scopeAll: true } as never;
const scopeCommunityTwo = { scopeAll: false, communityIds: [2] } as never;

const communities = [
  { id: 1, name: '枫桦景苑一期' },
  { id: 2, name: '枫桦景苑二期' },
  { id: 16, name: '上海新家' },
];

const FEE_ITEMS: Array<[string, string]> = [
  ['01', '管理费'], ['02', '租金'], ['03', '保洁保安费'], ['04', '泊位费'],
  ['05', '临时停车费'], ['06', '保安费'], ['07', '保洁费'], ['08', '保安保洁费'],
  ['09', '网络费'], ['10', '青客租金'], ['11', '青客未签约租金'], ['12', '水费'],
  ['13', '电费'], ['14', '停车管理费'], ['15', '空房租金'], ['16', '置业泊位费'],
];

async function makeDatabase() {
  const pg = new PGlite();
  const migration = new MisMirror1794500000000();
  await migration.up({ query: (sql: string) => pg.query(sql) } as any);
  const nature = new MisMirrorBillNature1795300000000();
  await nature.up({ query: (sql: string) => pg.query(sql) } as any);
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
 * P2-A 合成夹具（金额单位：整数分）。
 * 2026-03 全管理处：实收 5600、退款 700、净额 4900、命中 10 行；
 * 04 月另有一笔 2000；2025-12-31 有一笔 500（日期边界）。
 * 含：负数退款行、正金额退款行（refund_date 非空）、未缴行（不应进任何实收报表）、
 * 未知收款方式/收款人空值、行级房屋性质 01/04/05。
 */
async function seed(pg: PGlite) {
  await pg.query(
    `INSERT INTO mis_sync_state(tenant_id,source_table,last_success_at,initialized_at)
     VALUES($1,'bill',$2,now())`,
    [tenantId, '2026-11-09T21:30:00+08:00'],
  );
  for (const [code, name] of FEE_ITEMS) {
    await pg.query(`INSERT INTO mis_mirror_fee_item(fee_code,fee_name) VALUES($1,$2)`, [code, name]);
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

  // ── 02 管理处：收款/退款主场景 ──
  await addBill({ officeCode: '02', sId: 501, feeCode: '01', feeName: '管理费', natureCode: '01', period: '202601', amountCents: 1000, paidDate: '2026-03-01', paymentMethod: '现金', cashier: '张三', address: '永德路228弄501号', ownerName: '二期业主501' });
  await addBill({ officeCode: '02', sId: 501, feeCode: '02', feeName: '租金', natureCode: '01', period: '202601', amountCents: 400, paidDate: '2026-03-01', paymentMethod: '微信', cashier: '李四' });
  await addBill({ officeCode: '02', sId: 502, feeCode: '01', feeName: '管理费', natureCode: '04', period: '202602', amountCents: 600, paidDate: '2026-03-02', paymentMethod: '现金', cashier: '张三' });
  // 负数退款行：金额 -400，退款日期 = 收款日期。
  await addBill({ officeCode: '02', sId: 501, feeCode: '01', feeName: '管理费', natureCode: '01', period: '202601', amountCents: -400, paidDate: '2026-03-02', refundDate: '2026-03-02', paymentMethod: '现金', cashier: '张三' });
  // 正金额退款行：源系统退款/红冲行金额可能为正，但净额仍应扣减 300。
  await addBill({ officeCode: '02', sId: 502, feeCode: '02', feeName: '租金', natureCode: '01', period: '202601', amountCents: 300, paidDate: '2026-03-05', refundDate: '2026-03-10', paymentMethod: '支付宝', cashier: '王五' });
  await addBill({ officeCode: '02', sId: 501, feeCode: '01', feeName: '管理费', natureCode: '01', period: '202603', amountCents: 2000, paidDate: '2026-04-01', paymentMethod: '现金', cashier: '张三' });
  // 未缴行：任何实收报表都不应包含。
  await addBill({ officeCode: '02', sId: 501, feeCode: '01', feeName: '管理费', natureCode: '01', period: '202604', amountCents: 999999, paidDate: null });
  // 日期边界：2025-12-31。
  await addBill({ officeCode: '02', sId: 501, feeCode: '13', feeName: '电费', natureCode: '01', period: '202512', amountCents: 500, paidDate: '2025-12-31', paymentMethod: '现金', cashier: '张三' });
  // 行级性质 05 + 收款人/方式齐全，用 03-20 区分日期。
  await addBill({ officeCode: '02', sId: 502, feeCode: '01', feeName: '管理费', natureCode: '05', period: '202603', amountCents: 100, paidDate: '2026-03-20', paymentMethod: '转账', cashier: '赵六' });

  // ── 01 管理处 ──
  await addBill({ officeCode: '01', sId: 719, feeCode: '01', feeName: '管理费', natureCode: '01', period: '202601', amountCents: 2500, paidDate: '2026-03-01', paymentMethod: '现金', cashier: '张三', address: '宝秀路719号719', ownerName: '宝秀路业主' });
  await addBill({ officeCode: '01', sId: 720, feeCode: '03', feeName: '保洁保安费', natureCode: '04', period: '202601', amountCents: 250, paidDate: '2026-03-01', paymentMethod: '转账', cashier: '赵六' });

  // ── 03 管理处：验证范围过滤 + 空收款方式/收款人 ──
  await addBill({ officeCode: '03', sId: 901, feeCode: '01', feeName: '管理费', natureCode: '01', period: '202601', amountCents: 700, paidDate: '2026-03-01', paymentMethod: '现金', cashier: '张三' });
  await addBill({ officeCode: '03', sId: 901, feeCode: '02', feeName: '租金', natureCode: '01', period: '202601', amountCents: 50, paidDate: '2026-03-01', paymentMethod: null, cashier: null });
}

const MARCH = { dateFrom: '2026-03-01', dateTo: '2026-03-31' };

function rowsOf(result: any, keys: string[]) {
  return result.rows.map((row: any) => keys.map((key) => row[key]));
}

test('collection/summary groupBy=fee：实收/退款拆分、行按金额降序、合计=分组之和', async () => {
  const pg = await makeDatabase();
  try {
    await seed(pg);
    const service = serviceFor(pg);
    const result: any = await service.collectionSummary(MARCH as never, user, scopeAll);
    assert.equal(result.available, true);
    assert.equal(result.groupBy, 'fee');
    assert.match(result.dataAsOf, /^2026-11-09T13:30:00\.000Z$/);
    assert.deepEqual(result.rows, [
      { key: '01', label: '管理费', receivedCents: 4900, refundCents: 400, count: 6 },
      { key: '02', label: '租金', receivedCents: 450, refundCents: 300, count: 3 },
      { key: '03', label: '保洁保安费', receivedCents: 250, refundCents: 0, count: 1 },
    ]);
    assert.deepEqual(result.total, { receivedCents: 5600, refundCents: 700, count: 10 });
    // 实收 - 退款 = 净额，且与逐笔明细合计一致。
    assert.equal(result.total.receivedCents - result.total.refundCents, 4900);
    assert.deepEqual(result.filters, {
      groupBy: 'fee',
      dateFrom: '2026-03-01',
      dateTo: '2026-03-31',
      officeCodes: ['01', '02', '03', '04', '05'],
      feeCodes: null,
      natures: null,
      paidDateTo: null,
    });
    // 不传 groupBy 默认按收费项目。
    const byDefault: any = await service.collectionSummary(MARCH as never, user, scopeAll);
    assert.equal(byDefault.groupBy, 'fee');
    assert.deepEqual(byDefault.rows, result.rows);
  } finally {
    await pg.close();
  }
});

test('collection/summary groupBy=office|method|cashier：管理处名称/空值未填写/合计一致', async () => {
  const pg = await makeDatabase();
  try {
    await seed(pg);
    const service = serviceFor(pg);

    const byOffice: any = await service.collectionSummary({ ...MARCH, groupBy: 'office' } as never, user, scopeAll);
    assert.deepEqual(rowsOf(byOffice, ['key', 'label', 'receivedCents', 'refundCents', 'count']), [
      ['01', '枫桦景苑一期', 2750, 0, 2],
      ['02', '枫桦景苑二期A', 2100, 700, 6],
      ['03', '枫桦景苑二期B', 750, 0, 2],
    ]);
    assert.deepEqual(byOffice.total, { receivedCents: 5600, refundCents: 700, count: 10 });

    const byMethod: any = await service.collectionSummary({ ...MARCH, groupBy: 'method' } as never, user, scopeAll);
    assert.deepEqual(rowsOf(byMethod, ['key', 'label', 'receivedCents', 'refundCents', 'count']), [
      ['现金', '现金', 4800, 400, 5],
      ['微信', '微信', 400, 0, 1],
      ['转账', '转账', 350, 0, 2],
      ['', '未填写', 50, 0, 1],
      ['支付宝', '支付宝', 0, 300, 1],
    ]);
    assert.deepEqual(byMethod.total, { receivedCents: 5600, refundCents: 700, count: 10 });

    const byCashier: any = await service.collectionSummary({ ...MARCH, groupBy: 'cashier' } as never, user, scopeAll);
    assert.deepEqual(rowsOf(byCashier, ['key', 'label', 'receivedCents', 'refundCents', 'count']), [
      ['张三', '张三', 4800, 400, 5],
      ['李四', '李四', 400, 0, 1],
      ['赵六', '赵六', 350, 0, 2],
      ['', '未填写', 50, 0, 1],
      ['王五', '王五', 0, 300, 1],
    ]);
    assert.deepEqual(byCashier.total, { receivedCents: 5600, refundCents: 700, count: 10 });
  } finally {
    await pg.close();
  }
});

test('日期边界：按事件日期（收款日/退款日）落在闭区间，退款日决定归属', async () => {
  const pg = await makeDatabase();
  try {
    await seed(pg);
    const service = serviceFor(pg);
    const day = async (dateFrom: string, dateTo = dateFrom) =>
      service.collectionSummary({ dateFrom, dateTo } as never, user, scopeAll) as Promise<any>;

    // 03-01 只有收款：1000+400+2500+250+700+50 = 4900。
    const first: any = await day('2026-03-01');
    assert.deepEqual(first.total, { receivedCents: 4900, refundCents: 0, count: 6 });
    // 03-02：收款 600 + 负数退款 400。
    const second: any = await day('2026-03-02');
    assert.deepEqual(second.total, { receivedCents: 600, refundCents: 400, count: 2 });
    // 03-10：正金额退款行按 refund_date 归属，实收 0、退款 300。
    const refundDay: any = await day('2026-03-10');
    assert.deepEqual(refundDay.total, { receivedCents: 0, refundCents: 300, count: 1 });
    // 03-09 还不含 03-10 的退款。
    const beforeRefund: any = await day('2026-03-01', '2026-03-09');
    assert.deepEqual(beforeRefund.total, { receivedCents: 5500, refundCents: 400, count: 8 });
    // 跨年边界 2025-12-31 必须包含（闭区间）。
    const boundary: any = await day('2025-12-31', '2026-01-01');
    assert.deepEqual(boundary.total, { receivedCents: 500, refundCents: 0, count: 1 });
    // 未缴行永远不进实收报表。
    const allMarch: any = await day('2026-03-01', '2026-03-31');
    assert.equal(allMarch.rows.some((row: any) => row.receivedCents === 999999), false);
  } finally {
    await pg.close();
  }
});

test('非法日期/跨度>366/from>to 直接调用 service 也 400', async () => {
  const pg = await makeDatabase();
  try {
    await seed(pg);
    const service = serviceFor(pg);
    await assert.rejects(
      service.collectionSummary({ dateTo: '2026-03-31' } as never, user, scopeAll),
      (error: unknown) => error instanceof BadRequestException,
    );
    await assert.rejects(
      service.collectionSummary({ dateFrom: '2026-02-30', dateTo: '2026-03-31' } as never, user, scopeAll),
      (error: unknown) => error instanceof BadRequestException,
    );
    await assert.rejects(
      service.collectionSummary({ dateFrom: '2026-04-01', dateTo: '2026-03-31' } as never, user, scopeAll),
      (error: unknown) => error instanceof BadRequestException,
    );
    await assert.rejects(
      service.collectionSummary({ dateFrom: '2024-01-01', dateTo: '2025-01-02' } as never, user, scopeAll),
      (error: unknown) => error instanceof BadRequestException,
    );
    await assert.rejects(
      service.monthly({ year: 2003 } as never, user, scopeAll),
      (error: unknown) => error instanceof BadRequestException,
    );
  } finally {
    await pg.close();
  }
});

test('筛选组合：管理处/收费项目/房屋性质/收款截止日', async () => {
  const pg = await makeDatabase();
  try {
    await seed(pg);
    const service = serviceFor(pg);
    const summary = (extra: Record<string, unknown>) =>
      service.collectionSummary({ ...MARCH, ...extra } as never, user, scopeAll) as Promise<any>;

    // 单管理处。
    const office01: any = await summary({ officeCodes: ['01'] });
    assert.deepEqual(office01.total, { receivedCents: 2750, refundCents: 0, count: 2 });
    assert.deepEqual(office01.filters.officeCodes, ['01']);

    // 单收费项目。
    const fee01: any = await summary({ feeCodes: ['01'] });
    assert.deepEqual(fee01.total, { receivedCents: 4900, refundCents: 400, count: 6 });
    assert.deepEqual(fee01.rows.map((row: any) => row.key), ['01']);

    // 行级房屋性质：04 商铺，仅 600+250 实收。
    const nature04: any = await summary({ natures: ['04'] });
    assert.deepEqual(nature04.total, { receivedCents: 850, refundCents: 0, count: 2 });

    // 01 与 04 组合 = 剔除 05 性质行后的实收/退款（5600 - 100 = 5500）。
    const combined: any = await summary({ natures: ['01', '04'] });
    assert.deepEqual(combined.total, { receivedCents: 5500, refundCents: 700, count: 9 });

    // 收款截止日：事件日期 <= paidDateTo。
    const cutoff: any = await summary({ paidDateTo: '2026-03-01' });
    assert.deepEqual(cutoff.total, { receivedCents: 4900, refundCents: 0, count: 6 });

    // 多条件叠加：02 管理处 + fee01 + nature01（03 月内只有 1000 收款 + 400 退款）。
    const mixed: any = await summary({ officeCodes: ['02'], feeCodes: ['01'], natures: ['01'], paidDateTo: '2026-03-31' });
    assert.deepEqual(mixed.total, { receivedCents: 1000, refundCents: 400, count: 2 });
    // 02 管理处 fee01 nature01：1000(03-01) + (-400 退款) + 2000(04-01，超出区间) ...
    // 03 月内 = 1000 收款 + 400 退款；2000 在 04 月不计。
    assert.deepEqual(mixed.rows, [{ key: '01', label: '管理费', receivedCents: 1000, refundCents: 400, count: 2 }]);

    // 组合筛选同样作用于 daily（含 04 月前的 03 月矩阵）。
    const daily: any = await service.daily({
      ...MARCH, officeCodes: ['02'], feeCodes: ['01', '02'], natures: ['01'], paidDateTo: '2026-03-31',
    } as never, user, scopeAll);
    assert.deepEqual(daily.columns.map((column: any) => column.code), ['01', '02']);
    assert.deepEqual(daily.rows.map((row: any) => [row.date, row.totalCents]), [
      ['2026-03-01', 1400],
      ['2026-03-02', -400],
      ['2026-03-10', -300],
    ]);
    assert.equal(daily.subtotal.totalCents, 700);

    const dailyDetail: any = await service.collectionDetail({
      ...MARCH, officeCodes: ['02'], feeCodes: ['01', '02'], natures: ['01'], paidDateTo: '2026-03-31',
    } as never, user, scopeAll);
    assert.equal(dailyDetail.totalCents, 700);
    assert.equal(dailyDetail.count, 4);
  } finally {
    await pg.close();
  }
});

test('collection/detail：净额行、退款行金额取 -|金额|、合计/条数不受分页影响', async () => {
  const pg = await makeDatabase();
  try {
    await seed(pg);
    const service = serviceFor(pg);
    const detail: any = await service.collectionDetail(MARCH as never, user, scopeAll);
    assert.equal(detail.available, true);
    assert.equal(detail.totalCents, 4900);
    assert.equal(detail.count, 10);
    assert.equal(detail.limit, 200);
    assert.equal(detail.offset, 0);
    assert.equal(detail.rows.length, 10);
    // 明细之和 = 实收 - 退款（summary 同条件）。
    const summary: any = await service.collectionSummary(MARCH as never, user, scopeAll);
    assert.equal(
      detail.rows.reduce((sum: number, row: any) => sum + row.amountCents, 0),
      summary.total.receivedCents - summary.total.refundCents,
    );

    // 负数退款行保留退款日期；正金额退款行的净额输出为 -300。
    const negative: any = detail.rows.find((row: any) => row.zjId === 4);
    assert.deepEqual(
      {
        amountCents: negative.amountCents, paidDate: negative.paidDate, refundDate: negative.refundDate,
        paymentMethod: negative.paymentMethod, cashier: negative.cashier, natureCode: negative.natureCode,
      },
      { amountCents: -400, paidDate: '2026-03-02', refundDate: '2026-03-02', paymentMethod: '现金', cashier: '张三', natureCode: '01' },
    );
    const positiveRefund: any = detail.rows.find((row: any) => row.zjId === 5);
    assert.equal(positiveRefund.amountCents, -300);
    assert.equal(positiveRefund.refundDate, '2026-03-10');

    // 字段完整性：带出管理处中文名、地址/业主/房屋、收费项目名称。
    const first: any = detail.rows.find((row: any) => row.zjId === 10);
    assert.deepEqual(
      {
        officeCode: first.officeCode, officeName: first.officeName, address: first.address,
        ownerName: first.ownerName, roomNo: first.roomNo, feeCode: first.feeCode,
        feeName: first.feeName, period: first.period, natureCode: first.natureCode,
      },
      {
        officeCode: '01', officeName: '枫桦景苑一期', address: '宝秀路719号719', ownerName: '宝秀路业主',
        roomNo: '719', feeCode: '01', feeName: '管理费', period: '202601', natureCode: '01',
      },
    );

    // 分页只影响 rows，不影响合计/条数；offset 超出也返回全量合计。
    const page: any = await service.collectionDetail({ ...MARCH, limit: 3, offset: 0 } as never, user, scopeAll);
    assert.equal(page.rows.length, 3);
    assert.equal(page.totalCents, 4900);
    assert.equal(page.count, 10);
    const lastPage: any = await service.collectionDetail({ ...MARCH, limit: 3, offset: 8 } as never, user, scopeAll);
    assert.equal(lastPage.rows.length, 2);
    assert.equal(lastPage.totalCents, 4900);
    const beyond: any = await service.collectionDetail({ ...MARCH, limit: 3, offset: 50 } as never, user, scopeAll);
    assert.deepEqual(beyond.rows, []);
    assert.equal(beyond.totalCents, 4900);
    assert.equal(beyond.count, 10);
  } finally {
    await pg.close();
  }
});

const daysInMonth = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();
const pad = (value: number) => String(value).padStart(2, '0');

test('daily：列=16 项收费项目，日期升序、成交净额矩阵，单元格可由 detail 同参复算', async () => {
  const pg = await makeDatabase();
  try {
    await seed(pg);
    const service = serviceFor(pg);
    const daily: any = await service.daily(MARCH as never, user, scopeAll);
    assert.equal(daily.available, true);
    assert.equal(daily.columns.length, 16);
    assert.deepEqual(daily.columns[0], { code: '01', name: '管理费' });
    assert.deepEqual(daily.columns[15], { code: '16', name: '置业泊位费' });
    assert.deepEqual(daily.rows.map((row: any) => row.date), ['2026-03-01', '2026-03-02', '2026-03-10', '2026-03-20']);
    assert.deepEqual(daily.rows.map((row: any) => [row.totalCents, row.cells['01'], row.cells['02'], row.cells['03']]), [
      [4900, 4200, 450, 250],
      [200, 200, 0, 0],
      [-300, 0, -300, 0],
      [100, 100, 0, 0],
    ]);
    assert.equal(daily.subtotal.totalCents, 4900);
    assert.equal(daily.subtotal.cells['01'], 4500);
    assert.equal(daily.subtotal.cells['02'], 150);
    assert.equal(daily.subtotal.cells['03'], 250);
    assert.ok(Object.values(daily.subtotal.cells).every((cents) => Number.isInteger(cents)));

    // 行合计 = detail 同日期区间的净额合计；单元格 = detail 同日期区间 + 同 feeCode。
    for (const row of daily.rows) {
      const perDate: any = await service.collectionDetail(
        { dateFrom: row.date, dateTo: row.date } as never, user, scopeAll,
      );
      assert.equal(perDate.totalCents, row.totalCents, `date ${row.date}`);
      // 有金额的收费项目数不会超过命中行数（同一费用可能多笔）。
      assert.ok(
        perDate.count >= Object.values(row.cells).filter((cents) => cents !== 0).length,
        `date ${row.date} count`,
      );
      for (const column of daily.columns) {
        const perCell: any = await service.collectionDetail(
          { dateFrom: row.date, dateTo: row.date, feeCodes: [column.code] } as never, user, scopeAll,
        );
        assert.equal(perCell.totalCents, row.cells[column.code], `date ${row.date} fee ${column.code}`);
      }
    }

    // feeCodes 过滤只保留勾选列。
    const onlyFee01: any = await service.daily({ ...MARCH, feeCodes: ['01'] } as never, user, scopeAll);
    assert.deepEqual(onlyFee01.columns, [{ code: '01', name: '管理费' }]);
    assert.deepEqual(onlyFee01.rows.map((row: any) => [row.date, row.totalCents]), [
      ['2026-03-01', 4200],
      ['2026-03-02', 200],
      ['2026-03-20', 100],
    ]);
    assert.equal(onlyFee01.subtotal.totalCents, 4500);

    // 单日矩阵与全月合计一致。
    const firstDay: any = await service.daily({ dateFrom: '2026-03-01', dateTo: '2026-03-01' } as never, user, scopeAll);
    assert.equal(firstDay.rows.length, 1);
    assert.equal(firstDay.subtotal.totalCents, 4900);
  } finally {
    await pg.close();
  }
});

test('monthly：固定 12 行、年度内月份归属、月度单元格可与 detail 复算', async () => {
  const pg = await makeDatabase();
  try {
    await seed(pg);
    const service = serviceFor(pg);
    const monthly: any = await service.monthly({ year: 2026 } as never, user, scopeAll);
    assert.equal(monthly.available, true);
    assert.equal(monthly.year, 2026);
    assert.equal(monthly.rows.length, 12);
    assert.deepEqual(monthly.rows.map((row: any) => row.month), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    assert.equal(monthly.rows[0].totalCents, 0);
    assert.deepEqual(
      [monthly.rows[2].totalCents, monthly.rows[2].cells['01'], monthly.rows[2].cells['02'], monthly.rows[2].cells['03']],
      [4900, 4500, 150, 250],
    );
    assert.equal(monthly.rows[3].totalCents, 2000);
    assert.equal(monthly.rows[3].cells['01'], 2000);
    assert.equal(monthly.rows[11].totalCents, 0);
    assert.equal(monthly.subtotal.totalCents, 6900);
    assert.equal(monthly.subtotal.cells['01'], 6500);
    assert.equal(monthly.subtotal.cells['02'], 150);
    assert.equal(monthly.subtotal.cells['03'], 250);

    // 2026 全年 detail 合计 = 月报表合计。
    const yearDetail: any = await service.collectionDetail(
      { dateFrom: '2026-01-01', dateTo: '2026-12-31' } as never, user, scopeAll,
    );
    assert.equal(yearDetail.totalCents, monthly.subtotal.totalCents);

    // 每个月合计 = detail 该月区间；非零单元格 = detail 该月 + 收费项目。
    for (const row of monthly.rows) {
      const from = `2026-${pad(row.month)}-01`;
      const to = `2026-${pad(row.month)}-${pad(daysInMonth(2026, row.month))}`;
      const perMonth: any = await service.collectionDetail({ dateFrom: from, dateTo: to } as never, user, scopeAll);
      assert.equal(perMonth.totalCents, row.totalCents, `month ${row.month}`);
      for (const [feeCode, cents] of Object.entries(row.cells)) {
        if (!cents) continue;
        const perCell: any = await service.collectionDetail(
          { dateFrom: from, dateTo: to, feeCodes: [feeCode] } as never, user, scopeAll,
        );
        assert.equal(perCell.totalCents, cents, `month ${row.month} fee ${feeCode}`);
      }
    }

    // 年度边界：2025-12-31 的 500 分只出现在 2025 年 12 月，不串到 2026。
    const previous: any = await service.monthly({ year: 2025 } as never, user, scopeAll);
    assert.equal(previous.rows[11].cells['13'], 500);
    assert.equal(previous.subtotal.totalCents, 500);
    const currentDecember: any = await service.monthly({ year: 2026, feeCodes: ['13'] } as never, user, scopeAll);
    assert.equal(currentDecember.subtotal.totalCents, 0);
  } finally {
    await pg.close();
  }
});

test('daily 全区间合计 = monthly 全合计 = detail 全年合计', async () => {
  const pg = await makeDatabase();
  try {
    await seed(pg);
    const service = serviceFor(pg);
    const daily: any = await service.daily({ dateFrom: '2026-01-01', dateTo: '2026-12-31' } as never, user, scopeAll);
    const monthly: any = await service.monthly({ year: 2026 } as never, user, scopeAll);
    const detail: any = await service.collectionDetail({ dateFrom: '2026-01-01', dateTo: '2026-12-31' } as never, user, scopeAll);
    assert.equal(daily.subtotal.totalCents, 6900);
    assert.equal(monthly.subtotal.totalCents, 6900);
    assert.equal(detail.totalCents, 6900);
    assert.equal(daily.rows.reduce((sum: number, row: any) => sum + row.totalCents, 0), 6900);
    assert.equal(monthly.rows.reduce((sum: number, row: any) => sum + row.totalCents, 0), 6900);
  } finally {
    await pg.close();
  }
});

test('权限范围：管理处按小区收敛；越权勾选收敛为空表；无租户 403', async () => {
  const pg = await makeDatabase();
  try {
    await seed(pg);
    const service = serviceFor(pg);
    const summary: any = await service.collectionSummary(MARCH as never, user, scopeCommunityTwo);
    assert.deepEqual(summary.filters.officeCodes, ['02', '03']);
    assert.deepEqual(summary.total, { receivedCents: 2850, refundCents: 700, count: 8 });

    const daily: any = await service.daily(MARCH as never, user, scopeCommunityTwo);
    assert.equal(daily.filters.officeCodes.length, 2);
    assert.equal(daily.subtotal.totalCents, 2150);

    const monthly: any = await service.monthly({ year: 2026 } as never, user, scopeCommunityTwo);
    assert.equal(monthly.subtotal.totalCents, 2150 + 2000);

    // 显式勾选范围外管理处：空表，不泄露数据。
    const outOfScope: any = await service.collectionSummary({ ...MARCH, officeCodes: ['01'] } as never, user, scopeCommunityTwo);
    assert.deepEqual(outOfScope.rows, []);
    assert.deepEqual(outOfScope.total, { receivedCents: 0, refundCents: 0, count: 0 });
    const outOfScopeDetail: any = await service.collectionDetail({ ...MARCH, officeCodes: ['01'] } as never, user, scopeCommunityTwo);
    assert.deepEqual(outOfScopeDetail.rows, []);
    assert.equal(outOfScopeDetail.totalCents, 0);
    assert.equal(outOfScopeDetail.count, 0);

    // 一个小区都没授权的账号：报表结构完整但全 0，不查账单。
    const noScope = { scopeAll: false, communityIds: [] } as never;
    const emptyMonthly: any = await service.monthly({ year: 2026 } as never, user, noScope);
    assert.equal(emptyMonthly.available, true);
    assert.equal(emptyMonthly.rows.length, 12);
    assert.equal(emptyMonthly.subtotal.totalCents, 0);
    const emptyDaily: any = await service.daily(MARCH as never, user, noScope);
    assert.deepEqual(emptyDaily.rows, []);
    assert.equal(emptyDaily.subtotal.totalCents, 0);
    assert.equal(emptyDaily.columns.length, 16);

    await assert.rejects(
      service.collectionSummary(MARCH as never, { id: 7 } as never, scopeAll),
      /tenant scope is required/,
    );
  } finally {
    await pg.close();
  }
});

test('镜像未同步：available:false + message，不伪造 0 金额', async () => {
  const pg = await makeDatabase();
  try {
    const service = serviceFor(pg);
    const summary: any = await service.collectionSummary(MARCH as never, user, scopeAll);
    assert.equal(summary.available, false);
    assert.equal(summary.dataAsOf, null);
    assert.deepEqual(summary.rows, []);
    assert.equal(summary.total, null);
    assert.match(summary.message, /镜像/);

    const detail: any = await service.collectionDetail(MARCH as never, user, scopeAll);
    assert.equal(detail.available, false);
    assert.deepEqual(detail.rows, []);
    assert.equal(detail.totalCents, null);
    assert.equal(detail.count, null);
    assert.match(detail.message, /镜像/);

    const daily: any = await service.daily(MARCH as never, user, scopeAll);
    assert.equal(daily.available, false);
    assert.deepEqual(daily.columns, []);
    assert.deepEqual(daily.rows, []);
    assert.equal(daily.subtotal, null);
    assert.match(daily.message, /镜像/);

    const monthly: any = await service.monthly({ year: 2026 } as never, user, scopeAll);
    assert.equal(monthly.available, false);
    assert.deepEqual(monthly.rows, []);
    assert.equal(monthly.subtotal, null);
    assert.match(monthly.message, /镜像/);
  } finally {
    await pg.close();
  }
});

test('每张报表只用聚合 SQL：summary/daily/monthly 各 1 条账单 SQL，detail 1 条行查询 + 1 条合计，无 N+1', async () => {
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
    const countBillSql = () => statements.filter((sql) => sql.includes('FROM mis_mirror_bill b')).length;

    statements.length = 0;
    await service.collectionSummary(MARCH as never, user, scopeAll);
    assert.equal(countBillSql(), 1);

    statements.length = 0;
    await service.collectionDetail(MARCH as never, user, scopeAll);
    assert.equal(countBillSql(), 2);

    statements.length = 0;
    await service.daily(MARCH as never, user, scopeAll);
    assert.equal(countBillSql(), 1);

    statements.length = 0;
    await service.monthly({ year: 2026 } as never, user, scopeAll);
    assert.equal(countBillSql(), 1);
    // 账单聚合 SQL 全部参数化：不把日期/代码拼进 SQL 字面量（字典查询是常量 SQL）。
    const billSql = statements.filter((sql) => sql.includes('FROM mis_mirror_bill b'));
    assert.ok(billSql.length > 0);
    assert.ok(billSql.every((sql) => /\$\d+/.test(sql)));
  } finally {
    await pg.close();
  }
});

test('DTO：日期必填/格式、groupBy 枚举、limit<=500、year 2004–2100，数组参数归一', async () => {
  const pipe = new ValidationPipe({ whitelist: true, transform: true });
  const transform = (value: Record<string, unknown>, metatype: any) =>
    pipe.transform(value, { type: 'query', metatype });

  await assert.rejects(
    transform({ dateTo: '2026-03-31' }, CollectionSummaryQueryDto),
    (error: unknown) => error instanceof BadRequestException,
  );
  await assert.rejects(
    transform({ dateFrom: '2026/03/01', dateTo: '2026-03-31' }, CollectionSummaryQueryDto),
    (error: unknown) => error instanceof BadRequestException,
  );
  await assert.rejects(
    transform({ ...MARCH, groupBy: 'bogus' }, CollectionSummaryQueryDto),
    (error: unknown) => error instanceof BadRequestException,
  );
  await assert.rejects(
    transform({ ...MARCH, limit: '501' }, CollectionDetailQueryDto),
    (error: unknown) => error instanceof BadRequestException,
  );
  await assert.rejects(
    transform({ ...MARCH, limit: '0' }, CollectionDetailQueryDto),
    (error: unknown) => error instanceof BadRequestException,
  );
  await assert.rejects(
    transform({ ...MARCH, offset: '-1' }, CollectionDetailQueryDto),
    (error: unknown) => error instanceof BadRequestException,
  );
  await assert.rejects(
    transform({ year: '2003' }, CollectionMonthlyQueryDto),
    (error: unknown) => error instanceof BadRequestException,
  );
  await assert.rejects(
    transform({ year: '2101' }, CollectionMonthlyQueryDto),
    (error: unknown) => error instanceof BadRequestException,
  );
  await assert.rejects(transform({}, CollectionMonthlyQueryDto), (error: unknown) => error instanceof BadRequestException);

  const summary = (await transform(
    { dateFrom: '2026-03-01', dateTo: '2026-03-31', officeCodes: '01,02', feeCodes: '01', natures: '01,04', groupBy: 'office', paidDateTo: '' },
    CollectionSummaryQueryDto,
  )) as CollectionSummaryQueryDto;
  assert.deepEqual(summary.officeCodes, ['01', '02']);
  assert.deepEqual(summary.feeCodes, ['01']);
  assert.deepEqual(summary.natures, ['01', '04']);
  assert.equal(summary.groupBy, 'office');
  assert.equal(summary.paidDateTo, undefined);

  const detail = (await transform({ ...MARCH, limit: '50', offset: '10' }, CollectionDetailQueryDto)) as CollectionDetailQueryDto;
  assert.equal(detail.limit, 50);
  assert.equal(detail.offset, 10);
  const daily = (await transform(MARCH, CollectionDailyQueryDto)) as CollectionDailyQueryDto;
  assert.equal(daily.dateFrom, '2026-03-01');
  assert.equal((await transform({ year: '2026', feeCodes: '01,02' }, CollectionMonthlyQueryDto) as CollectionMonthlyQueryDto).year, 2026);
});

test('P2-A 接口复用 business:view 权限，路由为 GET statistics/*，不新增页面 key', () => {
  const handlers = StatisticsController.prototype as unknown as Record<string, any>;
  for (const key of ['collectionSummary', 'collectionDetail', 'daily', 'monthly']) {
    assert.deepEqual(Reflect.getMetadata(PERMISSION_KEY, handlers[key]), {
      items: [{ pageKey: 'business', action: 'view' }],
    });
    assert.equal(Reflect.getMetadata(METHOD_METADATA, handlers[key]), RequestMethod.GET, key);
  }
  assert.equal(Reflect.getMetadata(PATH_METADATA, handlers.collectionSummary), 'collection/summary');
  assert.equal(Reflect.getMetadata(PATH_METADATA, handlers.collectionDetail), 'collection/detail');
  assert.equal(Reflect.getMetadata(PATH_METADATA, handlers.daily), 'daily');
  assert.equal(Reflect.getMetadata(PATH_METADATA, handlers.monthly), 'monthly');
  // P1 接口仍保留（回归）：annual/annualDetail/annualDetailBills/options。
  for (const key of ['options', 'annual', 'annualDetail', 'annualDetailBills']) {
    assert.deepEqual(Reflect.getMetadata(PERMISSION_KEY, handlers[key]), {
      items: [{ pageKey: 'business', action: 'view' }],
    });
  }
  // 控制器注入两个 service（P1 + P2-A），P1 接口行为不变。
  assert.equal(StatisticsController.length, 2);
});
