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
import { ArrearsStatisticsService } from './arrears.service';
import { roundRatePct } from './arrears.util';
import {
  ArrearsPrepaidDetailQueryDto,
  ArrearsPrepaidSummaryQueryDto,
  CollectionAssessmentQueryDto,
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
const CUTOFF = '2026-11-09';

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
  return new ArrearsStatisticsService(
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
  address?: string;
  ownerName?: string;
  areaSqm?: number | null;
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
        input.address ?? `合成路${input.sId}号`, input.feeCode, input.feeName, input.period,
        input.amountCents, input.paidDate ?? null, input.refundDate ?? null, input.natureCode,
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

/** 小夹具：验证欠收/溢收边界（paid_date 截止日、refund、负数、未来未缴）。 */
async function seedSmall(pg: PGlite) {
  await baseSetup(pg);
  const add = billInserter(pg);
  // 未缴 → 欠收。
  await add({ officeCode: '02', sId: 1, feeCode: '01', feeName: '管理费', natureCode: '01', period: '202610', amountCents: 1000, address: 'A', ownerName: '甲', areaSqm: 80 });
  // 截止日之后才收款 → 仍算欠收。
  await add({ officeCode: '02', sId: 1, feeCode: '01', feeName: '管理费', natureCode: '01', period: '202609', amountCents: 3000, paidDate: '2026-11-10' });
  // 截止日当天收款 + period 未来 → 溢收。
  await add({ officeCode: '02', sId: 2, feeCode: '04', feeName: '泊位费', natureCode: '02', period: '202611', amountCents: 2000, paidDate: '2026-11-09', address: 'B', ownerName: '乙' });
  // 退款标记行 / 负数调整行 / 未来未缴行 / 已收当期行：两个页签都不计。
  await add({ officeCode: '02', sId: 3, feeCode: '01', feeName: '管理费', natureCode: '01', period: '202611', amountCents: 4000, paidDate: '2026-10-01', refundDate: '2026-10-20' });
  await add({ officeCode: '02', sId: 3, feeCode: '01', feeName: '管理费', natureCode: '01', period: '202610', amountCents: -500, paidDate: '2026-10-01' });
  await add({ officeCode: '02', sId: 3, feeCode: '01', feeName: '管理费', natureCode: '01', period: '202612', amountCents: 600 });
  await add({ officeCode: '02', sId: 3, feeCode: '01', feeName: '管理费', natureCode: '01', period: '202610', amountCents: 700, paidDate: '2026-10-01' });
}

/**
 * 验收夹具（§4.10）：欠收/溢收按管理处金额与 02 明细前 5。
 * 每个管理处金额=目标值；02 用真实明细房屋 + 低于前 5 的填充行，保证明细排序仍是验收前 5。
 */
async function seedAcceptance(pg: PGlite) {
  await baseSetup(pg);
  const add = billInserter(pg);
  const arrearsTop5 = [
    { sId: 3402, fee: '04', name: '泊位费', address: '永德路228弄3号402', owner: '朱全锋', area: 88.5, amount: 1_582_500, periods: ['201404', '201501', '201502', '201503', '201504', '201505', '201506', '201507', '201508', '201509', '201510', '201511', '201512', '202001', '202010', '202011'], split: { first: 1_500_000, rest: 5_500 } },
    { sId: 701, fee: '01', name: '管理费', address: '宝秀路701号701', owner: '陆乾一', area: 630.98, amount: 1_514_300, periods: ['202601', '202602', '202603', '202604', '202605', '202606', '202607', '202608', '202609', '202610'], split: { first: 0, rest: 151_430 } },
    { sId: 723, fee: '01', name: '管理费', address: '宝秀路723-725号723-725', owner: '杨凤林', area: 344.37, amount: 826_400, periods: ['202601', '202602', '202603', '202604', '202605', '202606', '202607', '202608', '202609', '202610'], split: { first: 0, rest: 82_640 } },
    { sId: 3101, fee: '14', name: '停车管理费', address: '永德路228弄3号101', owner: '陈刚', area: 90, amount: 819_500, periods: ['201201', '201202', '201203', '201204', '201205', '201206', '201207', '201208', '201209', '201210', '201211'], split: { first: 0, rest: 74_500 } },
    { sId: 251403, fee: '01', name: '管理费', address: '永德路228弄25号1403', owner: '阮柳洪', area: 100.5, amount: 533_940, periods: Array.from({ length: 22 }, (_, index) => `2025${String(index + 1).padStart(2, '0')}`).map((_, index) => index < 12 ? `2025${String(index + 1).padStart(2, '0')}` : `2026${String(index - 11).padStart(2, '0')}`), split: { first: 0, rest: 24_270 } },
  ];
  for (const house of arrearsTop5) {
    // 显式逐笔插入（保证金额合计=amount）。
    const amounts = house.periods.map((_, index) => index === 0 && house.split.first > 0 ? house.split.first : house.split.rest);
    const diff = house.amount - amounts.reduce((sum, value) => sum + value, 0);
    amounts[amounts.length - 1] += diff;
    for (let index = 0; index < house.periods.length; index += 1) {
      await add({
        officeCode: '02', sId: house.sId, feeCode: house.fee, feeName: house.name,
        natureCode: '01', period: house.periods[index], amountCents: amounts[index],
        address: house.address, ownerName: house.owner,
        areaSqm: index === 0 ? house.area : undefined,
      });
      if (index === 0 && house.area != null) {
        await pg.query(`UPDATE mis_mirror_room SET area_sqm=$1 WHERE s_id=$2`, [house.area, house.sId]);
      }
    }
  }
  // 02 欠收填充：129 户×500,000 + 1 户 458,390 = 64,958,390，均低于验收第 5 名。
  for (let index = 0; index < 129; index += 1) {
    await add({ officeCode: '02', sId: 9000 + index, feeCode: '01', feeName: '管理费', natureCode: '01', period: '202610', amountCents: 500_000 });
  }
  await add({ officeCode: '02', sId: 9200, feeCode: '01', feeName: '管理费', natureCode: '01', period: '202610', amountCents: 458_390 });

  // 02 溢收前 5（period > 202610，paid_date <= 2026-11-09）。
  const prepaidTop5 = [
    { sId: 331202, fee: '01', name: '管理费', address: '永德路228弄33号1202', owner: '邹庆萍', area: 88, amount: 523_180, periods: Array.from({ length: 14 }, (_, index) => index < 2 ? `2026${String(11 + index).padStart(2, '0')}` : `2027${String(index - 1).padStart(2, '0')}`), per: 37_370 },
    { sId: 1103, fee: '04', name: '泊位费', address: '永德路228弄1号103', owner: '王晶', area: 90, amount: 330_000, periods: Array.from({ length: 12 }, (_, index) => index < 2 ? `2026${String(11 + index).padStart(2, '0')}` : `2027${String(index - 1).padStart(2, '0')}`), per: 27_500 },
    { sId: 53403, fee: '04', name: '泊位费', address: '永德路228弄53号403', owner: '沈天威', area: 91, amount: 315_000, periods: Array.from({ length: 12 }, (_, index) => index < 2 ? `2026${String(11 + index).padStart(2, '0')}` : `2027${String(index - 1).padStart(2, '0')}`), per: 26_250 },
    { sId: 1502, fee: '04', name: '泊位费', address: '永德路228弄1号502', owner: '高萍', area: 92, amount: 315_000, periods: Array.from({ length: 11 }, (_, index) => index < 2 ? `2026${String(11 + index).padStart(2, '0')}` : `2027${String(index - 1).padStart(2, '0')}`), per: 28_636 },
    { sId: 32601, fee: '01', name: '管理费', address: '永德路228弄32号601', owner: '宫建新', area: 93, amount: 306_600, periods: Array.from({ length: 14 }, (_, index) => index < 2 ? `2026${String(11 + index).padStart(2, '0')}` : `2027${String(index - 1).padStart(2, '0')}`), per: 21_900 },
  ];
  for (const house of prepaidTop5) {
    const amounts = house.periods.map(() => house.per);
    amounts[amounts.length - 1] += house.amount - amounts.reduce((sum, value) => sum + value, 0);
    for (let index = 0; index < house.periods.length; index += 1) {
      await add({
        officeCode: '02', sId: house.sId, feeCode: house.fee, feeName: house.name,
        natureCode: '01', period: house.periods[index], amountCents: amounts[index],
        paidDate: '2026-10-15', address: house.address, ownerName: house.owner,
      });
      if (index === 0) await pg.query(`INSERT INTO mis_mirror_room(s_id,room_no,nature,area_sqm) VALUES($1,$2,$3,$4) ON CONFLICT (s_id) DO UPDATE SET area_sqm=EXCLUDED.area_sqm`, [house.sId, String(house.sId), '01', house.area]);
    }
  }
  // 02 溢收填充：104 户×300,000 + 1 户 262,650 = 31,462,650，均低于验收第 5 名。
  for (let index = 0; index < 104; index += 1) {
    await add({ officeCode: '02', sId: 9500 + index, feeCode: '01', feeName: '管理费', natureCode: '01', period: '202611', amountCents: 300_000, paidDate: '2026-10-15' });
  }
  await add({ officeCode: '02', sId: 9700, feeCode: '01', feeName: '管理费', natureCode: '01', period: '202611', amountCents: 262_650, paidDate: '2026-10-15' });

  // 01/03/04：单笔达到验收合计（欠收未缴 + 溢收已收）。
  await add({ officeCode: '01', sId: 101, feeCode: '01', feeName: '管理费', natureCode: '01', period: '202610', amountCents: 87_340_540 });
  await add({ officeCode: '01', sId: 102, feeCode: '01', feeName: '管理费', natureCode: '01', period: '202611', amountCents: 36_416_380, paidDate: '2026-10-01' });
  await add({ officeCode: '03', sId: 301, feeCode: '01', feeName: '管理费', natureCode: '01', period: '202610', amountCents: 95_436_170 });
  await add({ officeCode: '03', sId: 302, feeCode: '01', feeName: '管理费', natureCode: '01', period: '202611', amountCents: 33_911_360, paidDate: '2026-10-01' });
  await add({ officeCode: '04', sId: 401, feeCode: '01', feeName: '管理费', natureCode: '01', period: '202610', amountCents: 35_608_500 });
  await add({ officeCode: '04', sId: 402, feeCode: '01', feeName: '管理费', natureCode: '01', period: '202611', amountCents: 57_957_200, paidDate: '2026-10-01' });
}

/** 收缴考核验收夹具（§4.11）：四管理处应收/已收年度数 + 02 明细前 5 房屋。 */
async function seedAssessment(pg: PGlite) {
  await baseSetup(pg);
  const add = billInserter(pg);
  const houses: Array<{ office: string; sId: number; address: string; owner: string; area: number; receivable: number; received: number }> = [
    { office: '02', sId: 701, address: '宝秀路701号701', owner: '陆乾一', area: 630.98, receivable: 2_072_160, received: 255_000 },
    { office: '02', sId: 723, address: '宝秀路723-725号723-725', owner: '杨凤林', area: 344.37, receivable: 991_680, received: 0 },
    { office: '02', sId: 251003, address: '永德路228弄25号1003', owner: '石文明', area: 127.78, receivable: 926_240, received: 926_240 },
    { office: '02', sId: 211101, address: '永德路228弄21号1101', owner: '盛爱民', area: 151.89, receivable: 757_200, received: 411_000 },
    { office: '02', sId: 321201, address: '永德路228弄32号1201', owner: '陈惠峰', area: 175.70, receivable: 730_560, received: 330_000 },
  ];
  for (const house of houses) {
    await pg.query(
      'INSERT INTO mis_mirror_room(s_id,room_no,nature,area_sqm) VALUES($1,$2,$3,$4) ON CONFLICT (s_id) DO UPDATE SET area_sqm=EXCLUDED.area_sqm',
      [house.sId, String(house.sId), '01', house.area],
    );
    if (house.received > 0) {
      await add({ officeCode: house.office, sId: house.sId, feeCode: '01', feeName: '管理费', natureCode: '01', period: '202601', amountCents: house.received, paidDate: '2026-06-01', address: house.address, ownerName: house.owner });
    }
    if (house.receivable - house.received > 0) {
      await add({ officeCode: house.office, sId: house.sId, feeCode: '01', feeName: '管理费', natureCode: '01', period: '202601', amountCents: house.receivable - house.received, address: house.address, ownerName: house.owner });
    }
  }
  // 02 填充：253 户×700,000（已收 428,000）+ 1 户 379,480（已收 32,960），合计 177,479,480/108,316,960。
  for (let index = 0; index < 253; index += 1) {
    const sId = 10_000 + index;
    await add({ officeCode: '02', sId, feeCode: '01', feeName: '管理费', natureCode: '01', period: '202603', amountCents: 428_000, paidDate: '2026-06-01' });
    await add({ officeCode: '02', sId, feeCode: '01', feeName: '管理费', natureCode: '01', period: '202603', amountCents: 272_000 });
  }
  await add({ officeCode: '02', sId: 10_500, feeCode: '01', feeName: '管理费', natureCode: '01', period: '202604', amountCents: 32_960, paidDate: '2026-06-01' });
  await add({ officeCode: '02', sId: 10_500, feeCode: '01', feeName: '管理费', natureCode: '01', period: '202604', amountCents: 379_480 - 32_960 });
  // 其它管理处（单户达到验收应收/已收，已收 paid_date=2026-06-01 用于 paidDateTo 过滤测试）。
  const offices: Array<[string, number, number, number]> = [
    ['01', 1001, 172_533_960, 107_879_970],
    ['03', 3001, 220_343_200, 114_369_960],
    ['04', 4001, 764_566_200, 662_436_700],
  ];
  for (const [office, sId, receivable, received] of offices) {
    await add({ officeCode: office, sId, feeCode: '01', feeName: '管理费', natureCode: '01', period: '202601', amountCents: received, paidDate: '2026-06-01', address: `${office}合成户`, ownerName: `${office}业主` });
    await add({ officeCode: office, sId, feeCode: '01', feeName: '管理费', natureCode: '01', period: '202601', amountCents: receivable - received });
  }
  // 跨年：2025 年一户，只出现在 2025 年查询。
  await add({ officeCode: '01', sId: 1002, feeCode: '01', feeName: '管理费', natureCode: '01', period: '202501', amountCents: 1000, paidDate: '2025-06-01' });
}

test('欠收与溢收汇总：四管理处金额 = §4.10 验收数，合计一致', async () => {
  const pg = await makeDatabase();
  try {
    await seedAcceptance(pg);
    const service = serviceFor(pg);
    const summary: any = await service.arrearsPrepaidSummary({ asOfPeriod: ASOF, paidDateTo: CUTOFF } as never, user, scopeAll);
    assert.equal(summary.available, true);
    assert.equal(summary.groupBy, 'office');
    assert.deepEqual(
      summary.rows.map((row: any) => [row.key, row.arrearsCents, row.prepaidCents]),
      [
        ['03', 95_436_170, 33_911_360],
        ['01', 87_340_540, 36_416_380],
        ['02', 70_235_030, 33_252_430],
        ['04', 35_608_500, 57_957_200],
      ],
    );
    assert.deepEqual(summary.total, {
      arrearsCents: 288_620_240,
      arrearsRows: 202,
      prepaidCents: 161_537_370,
      prepaidRows: 171,
    });
    assert.equal(summary.filters.paidDateTo, CUTOFF);

    const byFee: any = await service.arrearsPrepaidSummary({ asOfPeriod: ASOF, paidDateTo: CUTOFF, groupBy: 'fee' } as never, user, scopeAll);
    const fee01 = byFee.rows.find((row: any) => row.key === '01');
    const fee04 = byFee.rows.find((row: any) => row.key === '04');
    assert.equal(fee01.label, '管理费');
    assert.deepEqual([fee01.arrearsCents, fee01.prepaidCents], [286_218_240, 160_577_370]);
    assert.deepEqual([fee04.arrearsCents, fee04.prepaidCents], [1_582_500, 960_000]);
  } finally {
    await pg.close();
  }
});

test('欠收明细：02 前 5 房屋与月份/范围正确；分页合计不变；溢收 tab 与逐笔合计=单元格', async () => {
  const pg = await makeDatabase();
  try {
    await seedAcceptance(pg);
    const service = serviceFor(pg);
    const arrears: any = await service.arrearsPrepaidDetail({ asOfPeriod: ASOF, paidDateTo: CUTOFF, tab: 'arrears', officeCodes: ['02'] } as never, user, scopeAll);
    assert.equal(arrears.tab, 'arrears');
    assert.equal(arrears.totals.amountCents, 70_235_030);
    assert.equal(arrears.count, arrears.totals.rows);
    const top5 = arrears.rows.slice(0, 5);
    assert.deepEqual(
      top5.map((row: any) => [row.address, row.ownerName, row.feeCode, row.periodFrom, row.periodTo, row.months, row.amountCents]),
      [
        ['永德路228弄3号402', '朱全锋', '04', '201404', '202011', 16, 1_582_500],
        ['宝秀路701号701', '陆乾一', '01', '202601', '202610', 10, 1_514_300],
        ['宝秀路723-725号723-725', '杨凤林', '01', '202601', '202610', 10, 826_400],
        ['永德路228弄3号101', '陈刚', '14', '201201', '201211', 11, 819_500],
        ['永德路228弄25号1403', '阮柳洪', '01', '202501', '202610', 22, 533_940],
      ],
    );
    assert.equal(top5[1].areaSqm, 630.98);
    assert.equal(top5[1].periodRange, '202601-202610');

    // 分页：rows 变化，totals/count 不变。
    const page: any = await service.arrearsPrepaidDetail({ asOfPeriod: ASOF, paidDateTo: CUTOFF, tab: 'arrears', officeCodes: ['02'], limit: 3, offset: 0 } as never, user, scopeAll);
    assert.equal(page.rows.length, 3);
    assert.deepEqual(page.totals, arrears.totals);
    assert.equal(page.count, arrears.count);

    // 逐笔：朱全锋 04 合计 = 明细单元格 1,582,500，且 16 个不同所属年月。
    const bills: any = await service.arrearsPrepaidBills({
      tab: 'arrears', asOfPeriod: ASOF, paidDateTo: CUTOFF, sId: 3402, feeCode: '04',
    } as never, user, scopeAll);
    assert.equal(bills.totalCents, 1_582_500);
    assert.equal(bills.rows.length, 16);
    assert.equal(new Set(bills.rows.map((row: any) => row.period)).size, 16);

    const prepaid: any = await service.arrearsPrepaidDetail({ asOfPeriod: ASOF, paidDateTo: CUTOFF, tab: 'prepaid', officeCodes: ['02'] } as never, user, scopeAll);
    const prepaidTop = prepaid.rows.slice(0, 2);
    assert.deepEqual(
      prepaidTop.map((row: any) => [row.address, row.ownerName, row.feeCode, row.periodFrom, row.periodTo, row.months, row.amountCents]),
      [
        ['永德路228弄33号1202', '邹庆萍', '01', '202611', '202712', 14, 523_180],
        ['永德路228弄1号103', '王晶', '04', '202611', '202710', 12, 330_000],
      ],
    );
    const prepaidBills: any = await service.arrearsPrepaidBills({
      tab: 'prepaid', asOfPeriod: ASOF, paidDateTo: CUTOFF, sId: 331202, feeCode: '01',
    } as never, user, scopeAll);
    assert.equal(prepaidBills.totalCents, 523_180);
  } finally {
    await pg.close();
  }
});

test('欠收/溢收边界：paid_date 截止日、退款标记、负数、未来未缴、口径过滤', async () => {
  const pg = await makeDatabase();
  try {
    await seedSmall(pg);
    const service = serviceFor(pg);
    const summary: any = await service.arrearsPrepaidSummary({ asOfPeriod: ASOF, paidDateTo: CUTOFF } as never, user, scopeAll);
    assert.equal(summary.total.arrearsCents, 4000); // 1000 未缴 + 3000 截止后收款
    assert.equal(summary.total.prepaidCents, 2000); // 截止当天收款且 period 未来
    assert.deepEqual(summary.rows.map((row: any) => [row.key, row.arrearsCents, row.prepaidCents]), [['02', 4000, 2000]]);

    const detail: any = await service.arrearsPrepaidDetail({ asOfPeriod: ASOF, paidDateTo: CUTOFF, tab: 'arrears' } as never, user, scopeAll);
    assert.equal(detail.rows.length, 1);
    assert.deepEqual(
      [detail.rows[0].sId, detail.rows[0].periodFrom, detail.rows[0].periodTo, detail.rows[0].months, detail.rows[0].amountCents],
      [1, '202609', '202610', 2, 4000],
    );
    // 房屋性质 / 收费项目 / 管理处过滤。
    const nature02: any = await service.arrearsPrepaidSummary({ asOfPeriod: ASOF, paidDateTo: CUTOFF, natures: ['02'] } as never, user, scopeAll);
    assert.deepEqual([nature02.total.arrearsCents, nature02.total.prepaidCents], [0, 2000]);
    const fee01: any = await service.arrearsPrepaidSummary({ asOfPeriod: ASOF, paidDateTo: CUTOFF, feeCodes: ['01'] } as never, user, scopeAll);
    assert.deepEqual([fee01.total.arrearsCents, fee01.total.prepaidCents], [4000, 0]);
    const office01: any = await service.arrearsPrepaidSummary({ asOfPeriod: ASOF, paidDateTo: CUTOFF, officeCodes: ['01'] } as never, user, scopeAll);
    assert.deepEqual([office01.total.arrearsCents, office01.total.prepaidCents], [0, 0]);
  } finally {
    await pg.close();
  }
});

test('收缴考核：四管理处 2026 应收/已收/收缴率对齐 §4.11，12 月合计=年度，户数率正确', async () => {
  const pg = await makeDatabase();
  try {
    await seedAssessment(pg);
    const service = serviceFor(pg);
    const full: any = await service.collectionAssessment({ year: 2026, limit: 500 } as never, user, scopeAll);
    assert.equal(full.available, true);
    for (const [office, receivable, received] of [
      ['01', 172_533_960, 107_879_970],
      ['03', 220_343_200, 114_369_960],
      ['04', 764_566_200, 662_436_700],
    ] as Array<[string, number, number]>) {
      const row = full.rows.find((item: any) => item.officeCode === office);
      assert.ok(row, office);
      assert.equal(row.totalReceivableCents, receivable);
      assert.equal(row.totalReceivedCents, received);
      assert.equal(row.months.reduce((sum: number, month: any) => sum + month.receivableCents, 0), receivable);
      assert.equal(row.months.reduce((sum: number, month: any) => sum + month.receivedCents, 0), received);
    }

    const office02: any = await service.collectionAssessment({ year: 2026, officeCodes: ['02'], limit: 500 } as never, user, scopeAll);
    assert.deepEqual(office02.summary, {
      receivableCents: 182_957_320,
      receivedCents: 110_239_200,
      ratePct: 60.25,
      payableHouseholds: 259,
      paidHouseholds: 258,
      householdRatePct: 99.61,
    });
    const top5 = office02.rows.slice(0, 5);
    assert.deepEqual(
      top5.map((row: any) => [row.address, row.ownerName, row.areaSqm, row.totalReceivableCents, row.totalReceivedCents]),
      [
        ['宝秀路701号701', '陆乾一', 630.98, 2_072_160, 255_000],
        ['宝秀路723-725号723-725', '杨凤林', 344.37, 991_680, 0],
        ['永德路228弄25号1003', '石文明', 127.78, 926_240, 926_240],
        ['永德路228弄21号1101', '盛爱民', 151.89, 757_200, 411_000],
        ['永德路228弄32号1201', '陈惠峰', 175.70, 730_560, 330_000],
      ],
    );
    // summary 不受分页影响。
    const paged: any = await service.collectionAssessment({ year: 2026, officeCodes: ['02'], limit: 2, offset: 0 } as never, user, scopeAll);
    assert.equal(paged.rows.length, 2);
    assert.deepEqual(paged.summary, office02.summary);
    assert.equal(paged.count, office02.count);
    assert.equal(office02.count, 259);

    // 年度过滤：2025 只有跨年一户 1000。
    const previous: any = await service.collectionAssessment({ year: 2025 } as never, user, scopeAll);
    assert.equal(previous.rows.length, 1);
    assert.equal(previous.summary.receivableCents, 1000);
    // paidDateTo 过滤已收：2026-05-31 时全部已收被排除。
    const cutoff: any = await service.collectionAssessment({ year: 2026, officeCodes: ['02'], paidDateTo: '2026-05-31' } as never, user, scopeAll);
    assert.equal(cutoff.summary.receivedCents, 0);
    assert.equal(cutoff.summary.ratePct, 0);
  } finally {
    await pg.close();
  }
});

test('欠收/溢收与考核：权限范围、未镜像、分页 totals、DTO', async () => {
  const pg = await makeDatabase();
  try {
    await seedSmall(pg);
    const service = serviceFor(pg);
    const scoped: any = await service.arrearsPrepaidSummary({ asOfPeriod: ASOF, paidDateTo: CUTOFF } as never, user, scopeCommunityTwo);
    assert.deepEqual(scoped.filters.officeCodes, ['02', '03']);
    assert.equal(scoped.total.arrearsCents, 4000);
    const outOfScope: any = await service.arrearsPrepaidDetail({ asOfPeriod: ASOF, paidDateTo: CUTOFF, officeCodes: ['01'] } as never, user, scopeCommunityTwo);
    assert.deepEqual(outOfScope.rows, []);
    assert.equal(outOfScope.totals.amountCents, 0);
    const emptyAssessment: any = await service.collectionAssessment({ year: 2026 } as never, user, { scopeAll: false, communityIds: [] } as never);
    assert.equal(emptyAssessment.available, true);
    assert.deepEqual(emptyAssessment.rows, []);
    assert.equal(emptyAssessment.summary.receivableCents, 0);
    await assert.rejects(
      service.arrearsPrepaidSummary({ asOfPeriod: ASOF } as never, { id: 7 } as never, scopeAll),
      /tenant scope is required/,
    );

    const pipe = new ValidationPipe({ whitelist: true, transform: true });
    const transform = (value: Record<string, unknown>, metatype: any) =>
      pipe.transform(value, { type: 'query', metatype });
    await assert.rejects(transform({}, ArrearsPrepaidSummaryQueryDto), BadRequestException);
    await assert.rejects(transform({ asOfPeriod: '2026-10' }, ArrearsPrepaidSummaryQueryDto), BadRequestException);
    await assert.rejects(transform({ asOfPeriod: ASOF, groupBy: 'bogus' }, ArrearsPrepaidSummaryQueryDto), BadRequestException);
    await assert.rejects(transform({ asOfPeriod: ASOF, tab: 'bogus' }, ArrearsPrepaidDetailQueryDto), BadRequestException);
    await assert.rejects(transform({ year: '2003' }, CollectionAssessmentQueryDto), BadRequestException);
    const parsed = (await transform({
      asOfPeriod: ASOF, paidDateTo: CUTOFF, officeCodes: '01,02', feeCodes: '01', natures: '01,04', groupBy: 'fee',
    }, ArrearsPrepaidSummaryQueryDto)) as ArrearsPrepaidSummaryQueryDto;
    assert.deepEqual(parsed.officeCodes, ['01', '02']);
    assert.deepEqual(parsed.natures, ['01', '04']);
    assert.equal(parsed.groupBy, 'fee');
  } finally {
    await pg.close();
  }
});

test('未镜像：available:false + message，聚合 null；比率函数边界', async () => {
  const pg = await makeDatabase();
  try {
    const service = serviceFor(pg);
    const summary: any = await service.arrearsPrepaidSummary({ asOfPeriod: ASOF } as never, user, scopeAll);
    assert.equal(summary.available, false);
    assert.equal(summary.total, null);
    assert.match(summary.message, /镜像/);
    const detail: any = await service.arrearsPrepaidDetail({ asOfPeriod: ASOF } as never, user, scopeAll);
    assert.equal(detail.available, false);
    assert.equal(detail.totals, null);
    const assessment: any = await service.collectionAssessment({ year: 2026 } as never, user, scopeAll);
    assert.equal(assessment.available, false);
    assert.equal(assessment.summary, null);
    assert.equal(roundRatePct(1, 0), 0);
    assert.equal(roundRatePct(110_239_200, 182_957_320), 60.25);
  } finally {
    await pg.close();
  }
});

test('P2-C 接口复用 business:view，GET 路由正确', () => {
  const handlers = StatisticsController.prototype as unknown as Record<string, any>;
  for (const key of ['arrearsPrepaidSummary', 'arrearsPrepaidDetail', 'arrearsPrepaidBills', 'collectionAssessment']) {
    assert.deepEqual(Reflect.getMetadata(PERMISSION_KEY, handlers[key]), {
      items: [{ pageKey: 'business', action: 'view' }],
    });
    assert.equal(Reflect.getMetadata(METHOD_METADATA, handlers[key]), RequestMethod.GET, key);
  }
  assert.equal(Reflect.getMetadata(PATH_METADATA, handlers.arrearsPrepaidSummary), 'arrears-prepaid/summary');
  assert.equal(Reflect.getMetadata(PATH_METADATA, handlers.arrearsPrepaidDetail), 'arrears-prepaid/detail');
  assert.equal(Reflect.getMetadata(PATH_METADATA, handlers.arrearsPrepaidBills), 'arrears-prepaid/detail/bills');
  assert.equal(Reflect.getMetadata(PATH_METADATA, handlers.collectionAssessment), 'collection-assessment');
});
