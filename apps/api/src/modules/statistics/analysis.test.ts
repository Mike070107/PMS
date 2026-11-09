import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { BadRequestException, RequestMethod, ValidationPipe } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { PGlite } from '@electric-sql/pglite';
import { PERMISSION_KEY } from '../../common/require-permission.decorator';
import { MisMirror1794500000000 } from '../../migrations/1794500000000-MisMirror';
import { MisMirrorBillNature1795300000000 } from '../../migrations/1795300000000-MisMirrorBillNature';
import { AnalysisStatisticsService } from './analysis.service';
import { MONTHLY_REPORT_PENDING_COLUMNS, periodMonthBounds } from './analysis.util';
import { roundRatePct } from './arrears.util';
import {
  CollectionAnalysisDetailQueryDto,
  CollectionAnalysisQueryDto,
  MonthlyReportQueryDto,
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

const ASOF = '202610';
const OCT = { dateFrom: '2026-10-01', dateTo: '2026-10-31' };

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
  return new AnalysisStatisticsService(
    { query: async (sql: string, params?: unknown[]) => (await pg.query(sql, params as any[])).rows } as any,
    communityRepo,
  );
}

interface BillInput {
  officeCode: string;
  sId: number;
  feeCode: string;
  natureCode: string | null;
  period: string;
  amountCents: number;
  paidDate?: string | null;
  refundDate?: string | null;
  address?: string;
  ownerName?: string;
  areaSqm?: number;
}

async function baseSetup(pg: PGlite) {
  await pg.query(
    `INSERT INTO mis_sync_state(tenant_id,source_table,last_success_at,initialized_at)
     VALUES($1,'bill',$2,now())`,
    [tenantId, '2026-11-09T21:30:00+08:00'],
  );
  for (const [code, name] of FEE_ITEMS) {
    await pg.query(`INSERT INTO mis_mirror_fee_item(fee_code,fee_name) VALUES($1,$2)`, [code, name]);
  }
}

function billInserter(pg: PGlite) {
  let nextZj = 1;
  return async (input: BillInput) => {
    await pg.query(
      `INSERT INTO mis_mirror_bill(zj_id,office_code,s_id,owner_name,room_no,address,fee_code,fee_name,
        period,amount_cents,paid_date,refund_date,source_updated_at,nature_code)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now(),$13)`,
      [
        nextZj++, input.officeCode, input.sId, input.ownerName ?? '合成业主', String(input.sId),
        input.address ?? `合成路${input.sId}号`, input.feeCode,
        FEE_ITEMS.find(([code]) => code === input.feeCode)?.[1] ?? input.feeCode,
        input.period, input.amountCents, input.paidDate ?? null, input.refundDate ?? null, input.natureCode,
      ],
    );
    if (input.areaSqm !== undefined) {
      await pg.query(
        `INSERT INTO mis_mirror_room(s_id,room_no,nature,area_sqm) VALUES($1,$2,$3,$4)
         ON CONFLICT (s_id) DO UPDATE SET area_sqm=EXCLUDED.area_sqm`,
        [input.sId, String(input.sId), input.natureCode, input.areaSqm],
      );
    }
  };
}

/**
 * 收款分析验收夹具（§4.8，02 管理处 asOf=202610，收款区间 2026-10）：
 * 前 5 户 5 指标与文档实测一致；另加 01 历年欠收户与费项/性质过滤户、排除行。
 */
async function seedAnalysis(pg: PGlite) {
  await baseSetup(pg);
  const add = billInserter(pg);
  const top5: Array<{
    sId: number; address: string; owner: string; area: number;
    current: number; month: number; prepaid: number; received: number;
  }> = [
    { sId: 701, address: '宝秀路701号701', owner: '陆乾一', area: 630.98, current: 1_514_300, month: 166_430, prepaid: 90_000, received: 15_000 },
    { sId: 723, address: '宝秀路723-725号723-725', owner: '杨凤林', area: 344.37, current: 826_400, month: 82_640, prepaid: 0, received: 0 },
    { sId: 311101, address: '永德路228弄31号1101', owner: '邱解平', area: 120, current: 374_000, month: 44_150, prepaid: 13_500, received: 0 },
    { sId: 231001, address: '永德路228弄23号1001', owner: '周福顺', area: 121, current: 361_600, month: 42_910, prepaid: 74_250, received: 81_000 },
    { sId: 221101, address: '永德路228弄22号1101', owner: '杜剑烨', area: 122, current: 347_000, month: 34_700, prepaid: 0, received: 0 },
  ];
  for (const house of top5) {
    // 当月应收（同时计入当年欠收）：period=asOf 未缴。
    await add({ officeCode: '02', sId: house.sId, feeCode: '01', natureCode: '01', period: ASOF, amountCents: house.month, address: house.address, ownerName: house.owner, areaSqm: house.area });
    // 当年其余月份欠收：把 (current-month) 平摊到 202601–202609。
    const rest = house.current - house.month;
    const perMonth = Math.floor(rest / 9);
    const remainder = rest - perMonth * 9;
    for (let month = 1; month <= 9; month += 1) {
      await add({
        officeCode: '02', sId: house.sId, feeCode: '01', natureCode: '01',
        period: `2026${String(month).padStart(2, '0')}`,
        amountCents: month === 9 ? perMonth + remainder : perMonth,
        address: house.address, ownerName: house.owner,
      });
    }
    if (house.prepaid > 0) {
      await add({ officeCode: '02', sId: house.sId, feeCode: '01', natureCode: '01', period: '202611', amountCents: house.prepaid, paidDate: '2026-09-20', address: house.address, ownerName: house.owner });
    }
    if (house.received > 0) {
      await add({ officeCode: '02', sId: house.sId, feeCode: '01', natureCode: '01', period: '202601', amountCents: house.received, paidDate: house.received === 81_000 ? '2026-10-10' : '2026-10-05', address: house.address, ownerName: house.owner });
    }
  }
  // 01 管理处：历年欠收 500,000 + 当年欠收 10,000（用于 sort=historyArrears/范围过滤）。
  await add({ officeCode: '01', sId: 900, feeCode: '01', natureCode: '01', period: '202512', amountCents: 500_000 });
  await add({ officeCode: '01', sId: 900, feeCode: '01', natureCode: '01', period: '202601', amountCents: 10_000 });
  // 费项/性质过滤户：fee02 nature04 欠 1,000。
  await add({ officeCode: '02', sId: 998, feeCode: '02', natureCode: '04', period: '202601', amountCents: 1_000 });
  // 不计入任何指标：负金额未缴、退款标记行。
  await add({ officeCode: '02', sId: 999, feeCode: '01', natureCode: '01', period: ASOF, amountCents: -5_000 });
  await add({ officeCode: '02', sId: 999, feeCode: '01', natureCode: '01', period: ASOF, amountCents: 99_999, paidDate: '2026-10-01', refundDate: '2026-10-20' });
}

/** 收费月报表验收夹具（§4.4，asOf=202610，四管理处 9 指标 = 文档实测表）。 */
async function seedMonthlyReport(pg: PGlite) {
  await baseSetup(pg);
  const add = billInserter(pg);
  const offices: Array<{
    office: string; monthReceivable: number; monthAdjust: number; cumulativeReceivable: number;
    oldArrears: number; monthReceived: number; prepaidIn: number; prepaidBalance: number;
    monthArrears: number; cumulativeArrears: number;
  }> = [
    { office: '01', monthReceivable: 14_590_330, monthAdjust: -75_000, cumulativeReceivable: 2_478_340_466, oldArrears: 33_865_830, monthReceived: 15_246_910, prepaidIn: 7_210_960, prepaidBalance: 33_437_560, monthArrears: 5_560_990, cumulativeArrears: 87_340_540 },
    { office: '02', monthReceivable: 15_213_860, monthAdjust: -110_000, cumulativeReceivable: 2_899_940_950, oldArrears: 9_921_090, monthReceived: 15_314_220, prepaidIn: 7_054_720, prepaidBalance: 29_882_290, monthArrears: 6_202_090, cumulativeArrears: 70_235_030 },
    { office: '03', monthReceivable: 18_547_350, monthAdjust: -47_770, cumulativeReceivable: 3_559_990_790, oldArrears: 7_424_950, monthReceived: 16_243_810, prepaidIn: 7_390_860, prepaidBalance: 29_562_020, monthArrears: 8_973_510, cumulativeArrears: 95_436_170 },
    { office: '04', monthReceivable: 63_820_600, monthAdjust: -598_600, cumulativeReceivable: 6_733_135_600, oldArrears: 3_093_000, monthReceived: 46_508_500, prepaidIn: 11_168_600, prepaidBalance: 48_066_200, monthArrears: 32_251_900, cumulativeArrears: 35_608_500 },
  ];
  for (const item of offices) {
    const currentUnpaid = item.cumulativeArrears - item.oldArrears;
    // 旧欠应收（未缴、<=上年12）。
    await add({ officeCode: item.office, sId: 100, feeCode: '01', natureCode: '01', period: '202512', amountCents: item.oldArrears });
    // 当年未缴 = (累计欠收 - 旧欠)，其中当月欠收单独一行。
    await add({ officeCode: item.office, sId: 101, feeCode: '01', natureCode: '01', period: '202601', amountCents: currentUnpaid - item.monthArrears });
    await add({ officeCode: item.office, sId: 102, feeCode: '01', natureCode: '01', period: ASOF, amountCents: item.monthArrears });
    // 月应收包含：当月欠收（未缴）+ 预收转入 + 其余已收的当月应收。
    // 其余已收的当月应收支付日放在区间外（2026-12-01），避免混进本期实收/预收转入。
    const deferredPaid = item.monthReceivable - item.monthArrears - item.prepaidIn;
    await add({ officeCode: item.office, sId: 103, feeCode: '01', natureCode: '01', period: ASOF, amountCents: deferredPaid, paidDate: '2026-12-01' });
    // 累计应收：未缴正数（累计欠收）+ 已收正数（本期实收 / 预收转入 / 其余已收）。
    const paidTotal = item.cumulativeReceivable - item.cumulativeArrears;
    const otherPaid = paidTotal - item.monthReceived - item.prepaidIn - deferredPaid;
    await add({ officeCode: item.office, sId: 104, feeCode: '01', natureCode: '01', period: '202601', amountCents: item.monthReceived, paidDate: '2026-10-05' });
    await add({ officeCode: item.office, sId: 105, feeCode: '01', natureCode: '01', period: ASOF, amountCents: item.prepaidIn, paidDate: '2026-09-20' });
    await add({ officeCode: item.office, sId: 106, feeCode: '01', natureCode: '01', period: '202601', amountCents: otherPaid, paidDate: '2026-06-01' });
    // 月调整（负数，未缴）。
    await add({ officeCode: item.office, sId: 107, feeCode: '01', natureCode: '01', period: ASOF, amountCents: item.monthAdjust });
    // 预收余额（period>asOf、付款早于下月）。
    await add({ officeCode: item.office, sId: 108, feeCode: '01', natureCode: '01', period: '202611', amountCents: item.prepaidBalance, paidDate: '2026-09-25' });
  }
}

test('收款分析：02 前 5 户 5 指标 = §4.8 验收，排序/分页/合计正确', async () => {
  const pg = await makeDatabase();
  try {
    await seedAnalysis(pg);
    const service = serviceFor(pg);
    const result: any = await service.collectionAnalysis({ asOfPeriod: ASOF, ...OCT, officeCodes: ['02'] } as never, user, scopeAll);
    assert.equal(result.available, true);
    assert.deepEqual(
      result.rows.slice(0, 5).map((row: any) => [
        row.address, row.ownerName, row.historyArrearsCents, row.currentYearArrearsCents,
        row.currentMonthReceivableCents, row.prepaidCents, row.periodReceivedCents,
      ]),
      [
        ['宝秀路701号701', '陆乾一', 0, 1_514_300, 166_430, 90_000, 15_000],
        ['宝秀路723-725号723-725', '杨凤林', 0, 826_400, 82_640, 0, 0],
        ['永德路228弄31号1101', '邱解平', 0, 374_000, 44_150, 13_500, 0],
        ['永德路228弄23号1001', '周福顺', 0, 361_600, 42_910, 74_250, 81_000],
        ['永德路228弄22号1101', '杜剑烨', 0, 347_000, 34_700, 0, 0],
      ],
    );
    assert.equal(result.rows[0].areaSqm, 630.98);
    assert.equal(result.rows[0].officeName, '枫桦景苑二期A');
    // 合计 = 夹具全部房屋（含费项/性质过滤户；负金额/退款行不计）。
    assert.deepEqual(result.totals, {
      historyArrearsCents: 0,
      currentYearArrearsCents: 3_424_300,
      currentMonthReceivableCents: 370_830,
      prepaidCents: 177_750,
      periodReceivedCents: 96_000,
    });
    assert.equal(result.count, 7);

    // 分页不影响 totals。
    const page: any = await service.collectionAnalysis({ asOfPeriod: ASOF, ...OCT, officeCodes: ['02'], limit: 2, offset: 0 } as never, user, scopeAll);
    assert.equal(page.rows.length, 2);
    assert.deepEqual(page.totals, result.totals);
    assert.equal(page.count, result.count);

    // 历年欠收排序：01 历年户排第一。
    const history: any = await service.collectionAnalysis({ asOfPeriod: ASOF, ...OCT, officeCodes: ['01', '02'], sort: 'historyArrears' } as never, user, scopeAll);
    assert.equal(history.rows[0].sId, 900);
    assert.equal(history.rows[0].historyArrearsCents, 500_000);
    assert.equal(history.totals.historyArrearsCents, 500_000);
    assert.equal(history.totals.currentYearArrearsCents, 3_434_300);
    // 地址排序 / 收费项目 / 房屋性质过滤。
    const byAddress: any = await service.collectionAnalysis({ asOfPeriod: ASOF, ...OCT, officeCodes: ['02'], sort: 'address' } as never, user, scopeAll);
    assert.equal(byAddress.rows.length, result.rows.length);
    const fee02: any = await service.collectionAnalysis({ asOfPeriod: ASOF, ...OCT, officeCodes: ['02'], feeCodes: ['02'] } as never, user, scopeAll);
    assert.equal(fee02.totals.currentYearArrearsCents, 1_000);
    const nature04: any = await service.collectionAnalysis({ asOfPeriod: ASOF, ...OCT, officeCodes: ['02'], natures: ['04'] } as never, user, scopeAll);
    assert.equal(nature04.totals.currentYearArrearsCents, 1_000);
  } finally {
    await pg.close();
  }
});

test('收款分析日期边界左闭右开；明细 rowKind/totals/逐笔对应', async () => {
  const pg = await makeDatabase();
  try {
    await seedAnalysis(pg);
    const service = serviceFor(pg);
    // 区间实收：10-05 只有 15,000；10-10 才有 81,000；10-04 截止为 0。
    const day5: any = await service.collectionAnalysis({ asOfPeriod: ASOF, dateFrom: '2026-10-05', dateTo: '2026-10-05', officeCodes: ['02'] } as never, user, scopeAll);
    assert.equal(day5.totals.periodReceivedCents, 15_000);
    const day4: any = await service.collectionAnalysis({ asOfPeriod: ASOF, dateFrom: '2026-10-01', dateTo: '2026-10-04', officeCodes: ['02'] } as never, user, scopeAll);
    assert.equal(day4.totals.periodReceivedCents, 0);
    const day10: any = await service.collectionAnalysis({ asOfPeriod: ASOF, dateFrom: '2026-10-10', dateTo: '2026-10-10', officeCodes: ['02'] } as never, user, scopeAll);
    assert.equal(day10.totals.periodReceivedCents, 81_000);

    const detail: any = await service.collectionAnalysisDetail({ asOfPeriod: ASOF, ...OCT, sId: 701 } as never, user, scopeAll);
    assert.equal(detail.available, true);
    assert.deepEqual(detail.totals, {
      historyArrearsCents: 0,
      currentYearArrearsCents: 1_514_300,
      currentMonthReceivableCents: 166_430,
      prepaidCents: 90_000,
      periodReceivedCents: 15_000,
    });
    const kinds = detail.rows.reduce((map: Record<string, number>, row: any) => {
      map[row.rowKind] = (map[row.rowKind] ?? 0) + 1;
      return map;
    }, {});
    assert.deepEqual(kinds, { arrears: 10, prepaid: 1, received: 1 });
    const prepaidRow = detail.rows.find((row: any) => row.rowKind === 'prepaid');
    assert.equal(prepaidRow.period, '202611');
    assert.equal(prepaidRow.amountCents, 90_000);
    const receivedRow = detail.rows.find((row: any) => row.rowKind === 'received');
    assert.equal(receivedRow.paidDate, '2026-10-05');
    assert.equal(receivedRow.amountCents, 15_000);
    assert.equal(detail.rows.filter((row: any) => row.amountCents === -5_000).length, 0);
    assert.equal(detail.rows.some((row: any) => row.refundDate != null), false);
    // 费项过滤后该户无 02 费项。
    const fee02Detail: any = await service.collectionAnalysisDetail({ asOfPeriod: ASOF, ...OCT, sId: 701, feeCodes: ['02'] } as never, user, scopeAll);
    assert.deepEqual(fee02Detail.rows, []);
    assert.equal(fee02Detail.totals.currentYearArrearsCents, 0);
  } finally {
    await pg.close();
  }
});

test('收费月报表核心 9 指标：四管理处与合计 = §4.4 验收数，pendingColumns 明确', async () => {
  const pg = await makeDatabase();
  try {
    await seedMonthlyReport(pg);
    const service = serviceFor(pg);
    const result: any = await service.monthlyReport({ asOfPeriod: ASOF } as never, user, scopeAll);
    assert.equal(result.available, true);
    assert.equal(result.groupBy, 'office');
    assert.deepEqual(result.pendingColumns, MONTHLY_REPORT_PENDING_COLUMNS);
    assert.equal(result.pendingColumns.length, 5);
    assert.deepEqual(
      result.rows.map((row: any) => [
        row.key, row.monthReceivableCents, row.monthAdjustCents, row.cumulativeReceivableCents,
        row.oldArrearsReceivableCents, row.monthReceivedCents, row.prepaidInCents,
        row.prepaidBalanceCents, row.monthArrearsCents, row.cumulativeArrearsCents,
      ]),
      [
        ['01', 14_590_330, -75_000, 2_478_340_466, 33_865_830, 15_246_910, 7_210_960, 33_437_560, 5_560_990, 87_340_540],
        ['02', 15_213_860, -110_000, 2_899_940_950, 9_921_090, 15_314_220, 7_054_720, 29_882_290, 6_202_090, 70_235_030],
        ['03', 18_547_350, -47_770, 3_559_990_790, 7_424_950, 16_243_810, 7_390_860, 29_562_020, 8_973_510, 95_436_170],
        ['04', 63_820_600, -598_600, 6_733_135_600, 3_093_000, 46_508_500, 11_168_600, 48_066_200, 32_251_900, 35_608_500],
      ],
    );
    assert.deepEqual(
      result.totals,
      {
        monthReceivableCents: 112_172_140,
        monthAdjustCents: -831_370,
        cumulativeReceivableCents: 15_671_407_806,
        oldArrearsReceivableCents: 54_304_870,
        totalReceivableCents: 15_725_712_676,
        monthReceivedCents: 93_313_440,
        prepaidInCents: 32_825_140,
        prepaidBalanceCents: 140_948_070,
        monthArrearsCents: 52_988_490,
        cumulativeArrearsCents: 288_620_240,
        recoveryRatePct: roundRatePct(93_313_440, 15_725_712_676),
      },
    );
    // 合计应收 = 累计应收 + 旧欠应收；回收率 = 本期实收 / 合计应收（两位小数）。
    assert.equal(result.totals.totalReceivableCents, result.totals.cumulativeReceivableCents + result.totals.oldArrearsReceivableCents);
    assert.equal(result.rows[0].totalReceivableCents, 2_478_340_466 + 33_865_830);
    assert.equal(result.rows[0].recoveryRatePct, roundRatePct(15_246_910, 2_478_340_466 + 33_865_830));
    assert.equal(result.rows[0].label, '枫桦景苑一期');

    // 管理处/收费项目/房屋性质过滤。
    const office02: any = await service.monthlyReport({ asOfPeriod: ASOF, officeCodes: ['02'] } as never, user, scopeAll);
    assert.deepEqual(office02.rows.map((row: any) => row.key), ['02']);
    assert.equal(office02.rows[0].cumulativeArrearsCents, 70_235_030);
    const fee02: any = await service.monthlyReport({ asOfPeriod: ASOF, feeCodes: ['02'] } as never, user, scopeAll);
    assert.ok(fee02.rows.every((row: any) => row.monthReceivableCents === 0));
    const nature05: any = await service.monthlyReport({ asOfPeriod: ASOF, natures: ['05'] } as never, user, scopeAll);
    assert.ok(nature05.rows.every((row: any) => row.cumulativeReceivableCents === 0));
  } finally {
    await pg.close();
  }
});

test('P2-D：权限范围、未镜像、DTO/日期校验、区间边界助手', async () => {
  const pg = await makeDatabase();
  try {
    await seedAnalysis(pg);
    const service = serviceFor(pg);
    const scoped: any = await service.collectionAnalysis({ asOfPeriod: ASOF, ...OCT } as never, user, scopeCommunityTwo);
    assert.deepEqual(scoped.filters.officeCodes, ['02', '03']);
    assert.equal(scoped.totals.currentYearArrearsCents, 3_424_300);
    const outOfScope: any = await service.collectionAnalysisDetail({ asOfPeriod: ASOF, ...OCT, sId: 900, officeCodes: ['01'] } as never, user, scopeCommunityTwo);
    assert.deepEqual(outOfScope.rows, []);
    await assert.rejects(
      service.collectionAnalysis({ asOfPeriod: ASOF, ...OCT } as never, { id: 7 } as never, scopeAll),
      /tenant scope is required/,
    );
    assert.deepEqual(periodMonthBounds('202610'), {
      year: 2026, prevYearDec: '202512', monthStart: '2026-10-01', nextMonthStart: '2026-11-01',
    });
    assert.equal(periodMonthBounds('202612').nextMonthStart, '2027-01-01');

    const pipe = new ValidationPipe({ whitelist: true, transform: true });
    const transform = (value: Record<string, unknown>, metatype: any) =>
      pipe.transform(value, { type: 'query', metatype });
    await assert.rejects(transform({ ...OCT, asOfPeriod: '2026-10' }, CollectionAnalysisQueryDto), BadRequestException);
    await assert.rejects(transform({ dateFrom: OCT.dateFrom, dateTo: OCT.dateTo, asOfPeriod: ASOF, sort: 'bogus' }, CollectionAnalysisQueryDto), BadRequestException);
    await assert.rejects(transform({ ...OCT, asOfPeriod: ASOF }, CollectionAnalysisDetailQueryDto), BadRequestException);
    await assert.rejects(transform({ asOfPeriod: ASOF, groupBy: 'fee' }, MonthlyReportQueryDto), BadRequestException);
    await assert.rejects(
      service.collectionAnalysis({ asOfPeriod: ASOF, dateFrom: '2026-11-01', dateTo: '2026-10-01' } as never, user, scopeAll),
      (error: unknown) => error instanceof BadRequestException,
    );
  } finally {
    await pg.close();
  }
});

test('未镜像：两张报表 available:false + null 聚合', async () => {
  const pg = await makeDatabase();
  try {
    const service = serviceFor(pg);
    const analysis: any = await service.collectionAnalysis({ asOfPeriod: ASOF, ...OCT } as never, user, scopeAll);
    assert.equal(analysis.available, false);
    assert.equal(analysis.totals, null);
    assert.deepEqual(analysis.rows, []);
    assert.match(analysis.message, /镜像/);
    const monthly: any = await service.monthlyReport({ asOfPeriod: ASOF } as never, user, scopeAll);
    assert.equal(monthly.available, false);
    assert.equal(monthly.totals, null);
    assert.deepEqual(monthly.rows, []);
    assert.deepEqual(monthly.pendingColumns, MONTHLY_REPORT_PENDING_COLUMNS);
    assert.match(monthly.message, /镜像/);
  } finally {
    await pg.close();
  }
});

test('P2-D 接口复用 business:view，GET 路由正确', () => {
  const handlers = StatisticsController.prototype as unknown as Record<string, any>;
  for (const key of ['collectionAnalysis', 'collectionAnalysisDetail', 'monthlyReport']) {
    assert.deepEqual(Reflect.getMetadata(PERMISSION_KEY, handlers[key]), {
      items: [{ pageKey: 'business', action: 'view' }],
    });
    assert.equal(Reflect.getMetadata(METHOD_METADATA, handlers[key]), RequestMethod.GET, key);
  }
  assert.equal(Reflect.getMetadata(PATH_METADATA, handlers.collectionAnalysis), 'collection-analysis');
  assert.equal(Reflect.getMetadata(PATH_METADATA, handlers.collectionAnalysisDetail), 'collection-analysis/detail');
  assert.equal(Reflect.getMetadata(PATH_METADATA, handlers.monthlyReport), 'monthly-report');
});
