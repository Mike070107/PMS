import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { PGlite } from '@electric-sql/pglite';
import { PERMISSION_KEY } from '../../common/require-permission.decorator';
import { MisMirror1794500000000 } from '../../migrations/1794500000000-MisMirror';
import { StatisticsAnnualDetailQueryDto, StatisticsAnnualQueryDto } from './dto';
import { StatisticsController } from './statistics.controller';
import { StatisticsService } from './statistics.service';

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

const ROOMS: Array<[number, string, number]> = [
  [501, '01', 88.5],
  [719, '01', 79.67],
  [720, '01', 90],
  [721, '01', 100],
  [722, '04', 60],
  [801, '01', 80],
  [901, '01', 81],
  [1001, '01', 82],
  [1002, '04', 50],
  [1101, '01', 83],
];

async function makeDatabase() {
  const pg = new PGlite();
  const migration = new MisMirror1794500000000();
  await migration.up({ query: (sql: string) => pg.query(sql) } as any);
  return pg;
}

function makeService(dataSource: { query: (sql: string, params?: unknown[]) => Promise<any[]> }) {
  const communityRepo = { find: async () => communities } as any;
  return new StatisticsService(dataSource as any, communityRepo);
}

function serviceFor(pg: PGlite) {
  return makeService({ query: async (sql, params) => (await pg.query(sql, params as any[])).rows });
}

interface BillInput {
  officeCode: string;
  sId: number;
  period: string;
  amountCents: number;
  feeCode?: string;
  feeName?: string;
  address?: string;
  ownerName?: string;
  paidDate?: string | null;
  refundDate?: string | null;
  paymentMethod?: string | null;
  cashier?: string | null;
}

/**
 * 生产验收基准的合成夹具：
 * 02 管理处管理费欠费 = 2011 92100 + 2012 30700 + 2014 47790 + 2025 1659500 + 2026 72688120
 *                   = 74518210 分，与旧系统截图逐格一致；2026 = nature01 68303800 + nature04 4384320。
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
  for (const [sId, nature, area] of ROOMS) {
    await pg.query(
      `INSERT INTO mis_mirror_room(s_id,room_no,nature,area_sqm) VALUES($1,$2,$3,$4)`,
      [sId, String(sId), nature, area],
    );
  }
  let nextZj = 1;
  const addBill = async (input: BillInput) => {
    await pg.query(
      `INSERT INTO mis_mirror_bill(zj_id,office_code,s_id,owner_name,room_no,address,fee_code,fee_name,period,amount_cents,paid_date,refund_date,payment_method,cashier,source_updated_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now())`,
      [
        nextZj++, input.officeCode, input.sId, input.ownerName ?? '合成业主', String(input.sId),
        input.address ?? `合成路${input.sId}号`, input.feeCode ?? '01', input.feeName ?? '管理费',
        input.period, input.amountCents, input.paidDate ?? null, input.refundDate ?? null,
        input.paymentMethod ?? null, input.cashier ?? null,
      ],
    );
  };

  // 02 管理处：管理费欠费验收基准（全部性质）。
  await addBill({ officeCode: '02', sId: 501, period: '201101', amountCents: 92100 });
  await addBill({ officeCode: '02', sId: 501, period: '201205', amountCents: 30700 });
  await addBill({ officeCode: '02', sId: 719, period: '201410', amountCents: 15930, address: '宝秀路719号719', ownerName: '宝秀路业主' });
  await addBill({ officeCode: '02', sId: 719, period: '201411', amountCents: 15930, address: '宝秀路719号719', ownerName: '宝秀路业主' });
  await addBill({ officeCode: '02', sId: 719, period: '201412', amountCents: 15930, address: '宝秀路719号719', ownerName: '宝秀路业主' });
  await addBill({ officeCode: '02', sId: 720, period: '202501', amountCents: 1659500 });
  await addBill({ officeCode: '02', sId: 721, period: '202601', amountCents: 68303800, address: '永德路228弄21号', ownerName: '二期业主' });
  await addBill({ officeCode: '02', sId: 722, period: '202602', amountCents: 4384320, address: '永德路228弄22号', ownerName: '配套用房' });
  // 其它收费项目：验证收费项目筛选。
  await addBill({ officeCode: '02', sId: 501, period: '202603', amountCents: 1234, feeCode: '02', feeName: '租金' });
  // 实收：正常收款 + 负数退款行（净额 600），另有 2025 年一笔。
  await addBill({
    officeCode: '02', sId: 501, period: '202601', amountCents: 1000, paidDate: '2026-03-01',
    paymentMethod: '现金', cashier: '张三',
  });
  await addBill({
    officeCode: '02', sId: 501, period: '202601', amountCents: -400, paidDate: '2026-03-02',
    refundDate: '2026-03-02', paymentMethod: '现金', cashier: '张三',
  });
  await addBill({ officeCode: '02', sId: 501, period: '202401', amountCents: 200, paidDate: '2025-05-01' });
  // 其它管理处：验证管理处筛选/范围/小计。
  await addBill({ officeCode: '01', sId: 801, period: '202601', amountCents: 10000 });
  await addBill({ officeCode: '03', sId: 901, period: '202601', amountCents: 5000 });
  await addBill({ officeCode: '04', sId: 1001, period: '202601', amountCents: 7000 });
  await addBill({ officeCode: '04', sId: 1001, period: '202612', amountCents: 888 });
  await addBill({ officeCode: '04', sId: 1002, period: '202701', amountCents: 999900 });
  await addBill({ officeCode: '05', sId: 1101, period: '202601', amountCents: 3000 });
}

function annualOf(rows: any[], officeCode: string) {
  const row = rows.find((item) => item.officeCode === officeCode);
  assert.ok(row, `缺少管理处 ${officeCode} 行`);
  return row;
}

test('options：管理处/收费项目/房屋性质/年度范围/镜像水位', async () => {
  const pg = await makeDatabase();
  try {
    await seed(pg);
    const service = serviceFor(pg);
    const result: any = await service.options(user, scopeAll);
    assert.equal(result.available, true);
    assert.equal(result.sourceMode, 'mirror');
    assert.match(result.dataAsOf, /^2026-11-09T13:30:00\.000Z$/);
    assert.equal(result.offices.length, 5);
    assert.deepEqual(result.offices.map((office: any) => office.officeCode), ['01', '02', '03', '04', '05']);
    assert.deepEqual(result.offices[1], {
      officeCode: '02', name: '枫桦景苑二期A', communityId: 2, communityName: '枫桦景苑二期',
    });
    // 05 馨香北桥二期在 PMS 无同名小区，只展示、不映射。
    assert.deepEqual(result.offices[4], {
      officeCode: '05', name: '馨香北桥二期', communityId: null, communityName: null,
    });
    assert.equal(result.feeItems.length, 16);
    assert.deepEqual(result.feeItems[0], { code: '01', name: '管理费' });
    assert.deepEqual(result.natures, [
      { code: '01', name: '商品房' },
      { code: '04', name: '配套用房' },
    ]);
    assert.deepEqual(result.yearRange, { min: 2011, max: 2027 });
  } finally {
    await pg.close();
  }
});

test('年度欠费汇总命中生产验收基准（02=74518210、2026=72688120、明细 2014=47790）', async () => {
  const pg = await makeDatabase();
  try {
    await seed(pg);
    const service = serviceFor(pg);
    const result: any = await service.annual({
      type: 'arrears', feeCodes: ['01'], yearFrom: 2004, yearTo: 2026,
    } as never, user, scopeAll);
    assert.equal(result.available, true);
    assert.equal(result.columns[0], 2004);
    assert.equal(result.columns[result.columns.length - 1], 2026);
    assert.equal(result.columns.length, 23);
    const office02 = annualOf(result.rows, '02');
    assert.equal(office02.officeName, '枫桦景苑二期A');
    assert.equal(office02.totalCents, 74518210);
    assert.equal(office02.cells['2011'], 92100);
    assert.equal(office02.cells['2012'], 30700);
    assert.equal(office02.cells['2014'], 47790);
    assert.equal(office02.cells['2025'], 1659500);
    assert.equal(office02.cells['2026'], 72688120);
    assert.equal(office02.cells['2020'], 0);
    // 小计 = 各管理处同年之和：2026 = 72688120 + 10000 + 5000 + 7000 + 888 + 3000。
    assert.equal(result.subtotal.cells['2026'], 72714008);
    assert.equal(result.subtotal.cells['2014'], 47790);
    assert.equal(result.filters.type, 'arrears');
    assert.deepEqual(result.filters.officeCodes, ['01', '02', '03', '04', '05']);
    assert.equal(result.filters.feeCodes[0], '01');
  } finally {
    await pg.close();
  }
});

test('收费项目/房屋性质过滤：管理费 72688120 = 商品房 68303800 + 配套用房 4384320', async () => {
  const pg = await makeDatabase();
  try {
    await seed(pg);
    const service = serviceFor(pg);
    const allNatures: any = await service.annual({
      type: 'arrears', officeCodes: ['02'], feeCodes: ['01'], yearFrom: 2026, yearTo: 2026,
    } as never, user, scopeAll);
    assert.equal(annualOf(allNatures.rows, '02').cells['2026'], 72688120);

    const commodity: any = await service.annual({
      type: 'arrears', officeCodes: ['02'], feeCodes: ['01'], natures: ['01'], yearFrom: 2026, yearTo: 2026,
    } as never, user, scopeAll);
    assert.equal(annualOf(commodity.rows, '02').cells['2026'], 68303800);

    const supporting: any = await service.annual({
      type: 'arrears', officeCodes: ['02'], feeCodes: ['01'], natures: ['04'], yearFrom: 2026, yearTo: 2026,
    } as never, user, scopeAll);
    assert.equal(annualOf(supporting.rows, '02').cells['2026'], 4384320);

    const combined: any = await service.annual({
      type: 'arrears', officeCodes: ['02'], feeCodes: ['01'], natures: ['01', '04'], yearFrom: 2026, yearTo: 2026,
    } as never, user, scopeAll);
    assert.equal(annualOf(combined.rows, '02').cells['2026'], 72688120);

    const rent: any = await service.annual({
      type: 'arrears', officeCodes: ['02'], feeCodes: ['02'], yearFrom: 2026, yearTo: 2026,
    } as never, user, scopeAll);
    assert.equal(annualOf(rent.rows, '02').cells['2026'], 1234);
  } finally {
    await pg.close();
  }
});

test('实收年度汇总按付款年度分组，含负数退款行净额', async () => {
  const pg = await makeDatabase();
  try {
    await seed(pg);
    const service = serviceFor(pg);
    const result: any = await service.annual({
      type: 'received', officeCodes: ['02'], feeCodes: ['01'], yearFrom: 2025, yearTo: 2026,
    } as never, user, scopeAll);
    const office02 = annualOf(result.rows, '02');
    assert.equal(office02.cells['2025'], 200);
    assert.equal(office02.cells['2026'], 600);
    // 欠费口径不把已收/退款行算进来。
    const arrears: any = await service.annual({
      type: 'arrears', officeCodes: ['02'], feeCodes: ['01'], yearFrom: 2025, yearTo: 2026,
    } as never, user, scopeAll);
    assert.equal(annualOf(arrears.rows, '02').cells['2026'], 72688120);
  } finally {
    await pg.close();
  }
});

test('明细合计=单元格：02×2014 含宝秀路719号719（79.67㎡，201410-201412，47790）', async () => {
  const pg = await makeDatabase();
  try {
    await seed(pg);
    const service = serviceFor(pg);
    const annual: any = await service.annual({
      type: 'arrears', officeCodes: ['02'], feeCodes: ['01'], yearFrom: 2004, yearTo: 2026,
    } as never, user, scopeAll);
    const cell = annualOf(annual.rows, '02').cells['2014'];
    const detail: any = await service.annualDetail({
      type: 'arrears', officeCode: '02', year: 2014, feeCodes: ['01'],
    } as never, user, scopeAll);
    assert.equal(detail.available, true);
    assert.equal(detail.totalCents, cell);
    assert.equal(detail.rows.length, 1);
    assert.deepEqual(detail.rows[0], {
      sId: 719,
      address: '宝秀路719号719',
      ownerName: '宝秀路业主',
      areaSqm: 79.67,
      periodRange: '201410-201412',
      amountCents: 47790,
    });
  } finally {
    await pg.close();
  }
});

test('逐笔账单合计=房屋明细：02×2014 三笔各 15930', async () => {
  const pg = await makeDatabase();
  try {
    await seed(pg);
    const service = serviceFor(pg);
    const detail: any = await service.annualDetail({
      type: 'arrears', officeCode: '02', year: 2014, feeCodes: ['01'],
    } as never, user, scopeAll);
    const bills: any = await service.annualDetailBills({
      type: 'arrears', officeCode: '02', sId: 719, year: 2014, feeCodes: ['01'],
    } as never, user, scopeAll);
    assert.equal(bills.totalCents, detail.rows[0].amountCents);
    assert.deepEqual(bills.rows.map((row: any) => row.period), ['201410', '201411', '201412']);
    assert.deepEqual(bills.rows.map((row: any) => row.amountCents), [15930, 15930, 15930]);
    assert.equal(bills.rows[0].feeName, '管理费');
    assert.equal(bills.rows[0].paidDate, null);
    assert.equal(bills.rows[0].refundDate, null);
    assert.ok(bills.rows[0].zjId > 0);
  } finally {
    await pg.close();
  }
});

test('实收下钻保留收款日期/收款方式/收款人，负退款行也列出', async () => {
  const pg = await makeDatabase();
  try {
    await seed(pg);
    const service = serviceFor(pg);
    const bills: any = await service.annualDetailBills({
      type: 'received', officeCode: '02', sId: 501, year: 2026, feeCodes: ['01'],
    } as never, user, scopeAll);
    assert.equal(bills.totalCents, 600);
    assert.deepEqual(bills.rows.map((row: any) => row.amountCents), [1000, -400]);
    assert.deepEqual(bills.rows.map((row: any) => row.paidDate), ['2026-03-01', '2026-03-02']);
    assert.equal(bills.rows[1].refundDate, '2026-03-02');
    assert.equal(bills.rows[0].paymentMethod, '现金');
    assert.equal(bills.rows[0].cashier, '张三');
  } finally {
    await pg.close();
  }
});

test('asOfPeriod 过滤应收截止年月，单元格与明细同步归零', async () => {
  const pg = await makeDatabase();
  try {
    await seed(pg);
    const service = serviceFor(pg);
    const noCutoff: any = await service.annual({
      type: 'arrears', officeCodes: ['04'], feeCodes: ['01'], yearFrom: 2026, yearTo: 2027,
    } as never, user, scopeAll);
    assert.equal(annualOf(noCutoff.rows, '04').cells['2026'], 7888);
    assert.equal(annualOf(noCutoff.rows, '04').cells['2027'], 999900);

    // 截止 2026-11：排除 202612 的 888 分与 2027 年的 999900 分。
    const cutoff: any = await service.annual({
      type: 'arrears', officeCodes: ['04'], feeCodes: ['01'], yearFrom: 2026, yearTo: 2027,
      asOfPeriod: '202611',
    } as never, user, scopeAll);
    assert.equal(annualOf(cutoff.rows, '04').cells['2026'], 7000);
    assert.equal(annualOf(cutoff.rows, '04').cells['2027'], 0);

    // 下钻带上同一截止条件时，合计仍等于单元格。
    const detail: any = await service.annualDetail({
      type: 'arrears', officeCode: '04', year: 2026, feeCodes: ['01'], asOfPeriod: '202611',
    } as never, user, scopeAll);
    assert.equal(detail.totalCents, annualOf(cutoff.rows, '04').cells['2026']);
    assert.deepEqual(detail.rows.map((row: any) => row.sId), [1001]);

    const detailAfter2027: any = await service.annualDetail({
      type: 'arrears', officeCode: '04', year: 2027, feeCodes: ['01'], asOfPeriod: '202611',
    } as never, user, scopeAll);
    assert.deepEqual(detailAfter2027.rows, []);
    assert.equal(detailAfter2027.totalCents, annualOf(cutoff.rows, '04').cells['2027']);
  } finally {
    await pg.close();
  }
});

test('paidDateTo 收款截止日期只影响实收口径，且明细/账单同步过滤', async () => {
  const pg = await makeDatabase();
  try {
    await seed(pg);
    const service = serviceFor(pg);
    const noCutoff: any = await service.annual({
      type: 'received', officeCodes: ['02'], feeCodes: ['01'], yearFrom: 2026, yearTo: 2026,
    } as never, user, scopeAll);
    assert.equal(annualOf(noCutoff.rows, '02').cells['2026'], 600);

    const cutoff: any = await service.annual({
      type: 'received', officeCodes: ['02'], feeCodes: ['01'], yearFrom: 2026, yearTo: 2026,
      paidDateTo: '2026-03-01',
    } as never, user, scopeAll);
    assert.equal(annualOf(cutoff.rows, '02').cells['2026'], 1000);

    const detail: any = await service.annualDetail({
      type: 'received', officeCode: '02', year: 2026, feeCodes: ['01'], paidDateTo: '2026-03-01',
    } as never, user, scopeAll);
    assert.equal(detail.totalCents, annualOf(cutoff.rows, '02').cells['2026']);
    assert.deepEqual(detail.rows.map((row: any) => row.amountCents), [1000]);

    const bills: any = await service.annualDetailBills({
      type: 'received', officeCode: '02', sId: 501, year: 2026, feeCodes: ['01'], paidDateTo: '2026-03-01',
    } as never, user, scopeAll);
    assert.equal(bills.totalCents, detail.totalCents);
    assert.equal(bills.rows.length, 1);

    // 欠费口径没有收款日期，paidDateTo 不应把全部欠费过滤掉。
    const arrears: any = await service.annual({
      type: 'arrears', officeCodes: ['02'], feeCodes: ['01'], yearFrom: 2026, yearTo: 2026,
      paidDateTo: '2026-03-01',
    } as never, user, scopeAll);
    assert.equal(annualOf(arrears.rows, '02').cells['2026'], 72688120);
  } finally {
    await pg.close();
  }
});

test('权限范围：管理处按小区映射过滤，越权明细 403', async () => {
  const pg = await makeDatabase();
  try {
    await seed(pg);
    const service = serviceFor(pg);
    const options: any = await service.options(user, scopeCommunityTwo);
    assert.deepEqual(options.offices.map((office: any) => office.officeCode), ['02', '03']);
    assert.deepEqual(options.offices.map((office: any) => office.communityId), [2, 2]);

    const annual: any = await service.annual({ type: 'arrears', feeCodes: ['01'], yearFrom: 2004, yearTo: 2026 } as never, user, scopeCommunityTwo);
    assert.deepEqual(annual.rows.map((row: any) => row.officeCode), ['02', '03']);
    assert.equal(annualOf(annual.rows, '02').totalCents, 74518210);
    assert.equal(annual.rows.some((row: any) => row.officeCode === '01'), false);

    // 显式勾选越权管理处：范围收敛为空表，不泄露数据。
    const outOfScope: any = await service.annual({
      type: 'arrears', officeCodes: ['01'], feeCodes: ['01'], yearFrom: 2004, yearTo: 2026,
    } as never, user, scopeCommunityTwo);
    assert.deepEqual(outOfScope.rows, []);
    assert.equal(outOfScope.subtotal.totalCents, 0);

    await assert.rejects(
      service.annualDetail({ type: 'arrears', officeCode: '01', year: 2026 } as never, user, scopeCommunityTwo),
      /不在你的数据范围/,
    );
    await assert.rejects(
      service.annualDetailBills({ type: 'arrears', officeCode: '04', sId: 1001, year: 2026 } as never, user, scopeCommunityTwo),
      /不在你的数据范围/,
    );
  } finally {
    await pg.close();
  }
});

test('annual 只发一条账单聚合 SQL，不按管理处/年份 N+1', async () => {
  const pg = await makeDatabase();
  try {
    await seed(pg);
    const statements: string[] = [];
    const service = makeService({
      query: async (sql, params) => {
        statements.push(sql);
        return (await pg.query(sql, params as any[])).rows;
      },
    });
    await service.annual({ type: 'arrears', feeCodes: ['01'], yearFrom: 2004, yearTo: 2026 } as never, user, scopeAll);
    const aggregateSql = statements.filter((sql) => sql.includes('FROM mis_mirror_bill b'));
    assert.equal(aggregateSql.length, 1);
  } finally {
    await pg.close();
  }
});

test('镜像未同步时明确的空数组+message，不伪造 0', async () => {
  const pg = await makeDatabase();
  try {
    const service = serviceFor(pg);
    const options: any = await service.options(user, scopeAll);
    assert.equal(options.available, false);
    assert.equal(options.dataAsOf, null);
    assert.deepEqual(options.feeItems, []);
    assert.deepEqual(options.natures, []);
    assert.deepEqual(options.yearRange, { min: null, max: null });
    assert.match(options.message, /镜像/);

    const annual: any = await service.annual({ type: 'arrears', yearFrom: 2004, yearTo: 2026 } as never, user, scopeAll);
    assert.equal(annual.available, false);
    assert.deepEqual(annual.rows, []);
    assert.equal(annual.subtotal, null);
    assert.match(annual.message, /镜像/);

    const detail: any = await service.annualDetail({ type: 'arrears', officeCode: '02', year: 2026 } as never, user, scopeAll);
    assert.deepEqual(detail.rows, []);
    assert.equal(detail.totalCents, null);
    assert.match(detail.message, /镜像/);
  } finally {
    await pg.close();
  }
});

test('type 非法 400，列表参数解析为数组', async () => {
  const pipe = new ValidationPipe({ whitelist: true, transform: true });
  await assert.rejects(
    pipe.transform({ type: 'bogus' }, { type: 'query', metatype: StatisticsAnnualQueryDto }),
    (error: unknown) => error instanceof BadRequestException,
  );
  await assert.rejects(
    pipe.transform({ type: 'arrears', officeCode: '02' }, { type: 'query', metatype: StatisticsAnnualDetailQueryDto }),
    (error: unknown) => error instanceof BadRequestException,
  );
  const parsed = await pipe.transform(
    { type: 'arrears', officeCodes: '01,02', natures: '01,04', yearFrom: '2004', yearTo: '2026', asOfPeriod: '202612' },
    { type: 'query', metatype: StatisticsAnnualQueryDto },
  ) as StatisticsAnnualQueryDto;
  assert.deepEqual(parsed.officeCodes, ['01', '02']);
  assert.deepEqual(parsed.natures, ['01', '04']);
  assert.equal(parsed.yearFrom, 2004);
  assert.equal(parsed.yearTo, 2026);
  assert.equal(parsed.asOfPeriod, '202612');
});

test('报表接口复用 business:view 权限，不新增页面 key', () => {
  const handlers = StatisticsController.prototype as unknown as Record<string, object>;
  for (const key of ['options', 'annual', 'annualDetail', 'annualDetailBills']) {
    assert.deepEqual(Reflect.getMetadata(PERMISSION_KEY, handlers[key]!), {
      items: [{ pageKey: 'business', action: 'view' }],
    });
  }
});
