import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { PGlite } from '@electric-sql/pglite';
import { PERMISSION_KEY } from '../../common/require-permission.decorator';
import { MisMirror1794500000000 } from '../../migrations/1794500000000-MisMirror';
import { MisMirrorBillNature1795300000000 } from '../../migrations/1795300000000-MisMirrorBillNature';
import { MisMirrorFeeItemCategory1795400000000 } from '../../migrations/1795400000000-MisMirrorFeeItemCategory';
import { StatisticsAnnualDetailQueryDto, StatisticsAnnualQueryDto } from './dto';
import { StatisticsController } from './statistics.controller';
import { StatisticsService } from './statistics.service';
import { STATISTICS_NATURE_OPTIONS } from './statistics.util';

const tenantId = 1;
const user = { id: 7, tenantId } as never;
const scopeAll = { scopeAll: true } as never;
const scopeCommunityTwo = { scopeAll: false, communityIds: [2] } as never;

/** 旧系统默认勾选：FWXZK 除「06 空房」外全部。 */
const NATURES_WITHOUT_VACANT = ['01', '02', '03', '04', '05', '07', '08', '09', '10', '11', '12', '13'];

const communities = [
  { id: 1, name: '枫桦景苑一期' },
  { id: 2, name: '枫桦景苑二期' },
  { id: 16, name: '上海新家' },
];

/** SETUPSFXM 16 项收费项目 + 旧系统分类（09 网络费故意置空，验证空分类归「其它」）。 */
const FEE_ITEMS: Array<[string, string, string | null]> = [
  ['01', '管理费', '日常收费'], ['02', '租金', '日常收费'], ['03', '保洁保安费', '日常收费'],
  ['04', '泊位费', '停车收费'], ['05', '临时停车费', '停车收费'], ['06', '保安费', '日常收费'],
  ['07', '保洁费', '日常收费'], ['08', '保安保洁费', '日常收费'], ['09', '网络费', null],
  ['10', '青客租金', '其它'], ['11', '青客未签约租金', '其它'], ['12', '水费', '代收费'],
  ['13', '电费', '代收费'], ['14', '停车管理费', '停车收费'], ['15', '空房租金', '其它'],
  ['16', '置业泊位费', '停车收费'],
];

/** 旧系统分类顺序：代收费、其它、日常收费、停车收费；同分类按 code。 */
const FEE_ITEM_ORDER = ['12', '13', '09', '10', '11', '15', '01', '02', '03', '06', '07', '08', '04', '05', '14', '16'];

/** 室表当前性质故意全部镜像为 06 空房：统计必须用 bill.nature_code，不能回退室表性质。 */
const ROOMS: Array<[number, string, number]> = [
  [501, '06', 88.5],
  [719, '06', 79.67],
  [720, '06', 90],
  [721, '06', 100],
  [722, '06', 60],
  [801, '06', 80],
  [802, '06', 81],
  [901, '06', 82],
  [1001, '06', 83],
  [1002, '06', 50],
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
  /** 收费明细行发生时的房屋性质 WYZJ.FWXZ_DH；null 表示旧数据/源缺失。 */
  natureCode: string | null;
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
 * 生产验收基准的合成夹具（金额单位：分）。
 * 01（一期）按行级 FWXZ_DH：剔除 06 空房后 = 66226900，含 06 = 89461320；
 * 02（二期A）管理费欠费 = 74518210，2026 = 68303800(01) + 4384320(04)。
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
  for (const [methodId, methodName] of [[1, '现金'], [2, '微信'], [3, '支付宝'], [4, '转账']]) {
    await pg.query(`INSERT INTO mis_mirror_payment_method(method_id,method_name) VALUES($1,$2)`, [methodId, methodName]);
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
      `INSERT INTO mis_mirror_bill(zj_id,office_code,s_id,owner_name,room_no,address,fee_code,fee_name,period,amount_cents,paid_date,refund_date,payment_method,cashier,source_updated_at,nature_code)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now(),$15)`,
      [
        nextZj++, input.officeCode, input.sId, input.ownerName ?? '合成业主', String(input.sId),
        input.address ?? `合成路${input.sId}号`, input.feeCode ?? '01', input.feeName ?? '管理费',
        input.period, input.amountCents, input.paidDate ?? null, input.refundDate ?? null,
        input.paymentMethod ?? null, input.cashier ?? null, input.natureCode,
      ],
    );
  };

  // ── 02 管理处（二期A）：验收基准与旧系统截图逐格一致 ──
  await addBill({ officeCode: '02', sId: 501, natureCode: '01', period: '201101', amountCents: 92100 });
  await addBill({ officeCode: '02', sId: 501, natureCode: '01', period: '201205', amountCents: 30700 });
  await addBill({ officeCode: '02', sId: 719, natureCode: '01', period: '201410', amountCents: 15930, address: '宝秀路719号719', ownerName: '宝秀路业主' });
  await addBill({ officeCode: '02', sId: 719, natureCode: '01', period: '201411', amountCents: 15930, address: '宝秀路719号719', ownerName: '宝秀路业主' });
  await addBill({ officeCode: '02', sId: 719, natureCode: '01', period: '201412', amountCents: 15930, address: '宝秀路719号719', ownerName: '宝秀路业主' });
  await addBill({ officeCode: '02', sId: 720, natureCode: '01', period: '202501', amountCents: 1659500 });
  await addBill({ officeCode: '02', sId: 721, natureCode: '01', period: '202601', amountCents: 68303800, address: '永德路228弄21号', ownerName: '二期业主' });
  await addBill({ officeCode: '02', sId: 722, natureCode: '04', period: '202602', amountCents: 4384320, address: '永德路228弄22号', ownerName: '沿街商铺' });
  // 其它收费项目：验证收费项目筛选。
  await addBill({ officeCode: '02', sId: 501, natureCode: '01', period: '202603', amountCents: 1234, feeCode: '02', feeName: '租金' });
  // 实收：正常收款 + 负数退款行（净额 600），另有 2025 年一笔。
  await addBill({
    officeCode: '02', sId: 501, natureCode: '01', period: '202601', amountCents: 1000,
    paidDate: '2026-03-01', paymentMethod: '现金', cashier: '张三',
  });
  await addBill({
    officeCode: '02', sId: 501, natureCode: '01', period: '202601', amountCents: -400,
    paidDate: '2026-03-02', refundDate: '2026-03-02', paymentMethod: '现金', cashier: '张三',
  });
  await addBill({ officeCode: '02', sId: 501, natureCode: '01', period: '202401', amountCents: 200, paidDate: '2025-05-01' });

  // ── 01 管理处（一期）：旧系统截图 ¥662,269.00（不含 06 空房） ──
  await addBill({ officeCode: '01', sId: 801, natureCode: '01', period: '200401', amountCents: 44440 });
  await addBill({ officeCode: '01', sId: 801, natureCode: '01', period: '200502', amountCents: 48030 });
  // 2007–2018 收费时点性质为 06 空房：旧报表不计入「房屋性质」勾选口径。
  await addBill({ officeCode: '01', sId: 801, natureCode: '06', period: '200701', amountCents: 5432180 });
  for (let year = 2008; year <= 2015; year += 1) {
    await addBill({ officeCode: '01', sId: 801, natureCode: '06', period: `${year}01`, amountCents: 2122680 });
  }
  for (let year = 2016; year <= 2018; year += 1) {
    await addBill({ officeCode: '01', sId: 801, natureCode: '06', period: `${year}01`, amountCents: 273600 });
  }
  await addBill({ officeCode: '01', sId: 801, natureCode: '01', period: '202401', amountCents: 466920 });
  await addBill({ officeCode: '01', sId: 801, natureCode: '01', period: '202501', amountCents: 1088520 });
  await addBill({ officeCode: '01', sId: 801, natureCode: '01', period: '202601', amountCents: 48186870 });
  await addBill({ officeCode: '01', sId: 802, natureCode: '04', period: '202602', amountCents: 16392120 });

  // ── 其它管理处：范围/小计/截止过滤 ──
  await addBill({ officeCode: '03', sId: 901, natureCode: '01', period: '202601', amountCents: 5000 });
  await addBill({ officeCode: '04', sId: 1001, natureCode: '01', period: '202601', amountCents: 7000 });
  await addBill({ officeCode: '04', sId: 1001, natureCode: '01', period: '202612', amountCents: 888 });
  // 行级性质缺失（历史/源 NULL）：不传 natures 时计入，传 natures 时排除。
  await addBill({ officeCode: '04', sId: 1002, natureCode: null, period: '202701', amountCents: 999900 });
}

/**
 * P1.3 实收验收夹具（离群大额，避免干扰欠费夹具）：
 * 列按 period 年度归年；默认房屋性质（13 项除 06）下 01–04 合计 =
 * 2,364,387,516 / 2,817,727,390 / 3,448,229,110 / 6,673,943,800；
 * 06 与 nature_code=NULL 行默认被 IN 语义排除（NULL 合计 176,230,750 对照生产 12,609 行）。
 */
async function seedReceived(pg: PGlite) {
  await pg.query(
    `INSERT INTO mis_sync_state(tenant_id,source_table,last_success_at,initialized_at)
     VALUES($1,'bill',$2,now())`,
    [tenantId, '2026-11-09T21:30:00+08:00'],
  );
  await pg.query(`INSERT INTO mis_mirror_fee_item(fee_code,fee_name,category) VALUES('01','管理费','日常收费')`);
  const rooms: Array<[number, string, number]> = [
    [2001, '01', 88.5],
    [2002, '01', 120],
    [2003, '06', 60],
    [2004, '01', 90],
    [2005, '01', 91],
    [2018, '01', 100.5],
  ];
  for (const [sId, nature, area] of rooms) {
    await pg.query(
      `INSERT INTO mis_mirror_room(s_id,room_no,nature,area_sqm) VALUES($1,$2,$3,$4)`,
      [sId, String(sId), nature, area],
    );
  }
  let nextZj = 900001;
  const addReceived = async (input: BillInput) => {
    await pg.query(
      `INSERT INTO mis_mirror_bill(zj_id,office_code,s_id,owner_name,room_no,address,fee_code,fee_name,period,amount_cents,paid_date,refund_date,payment_method,cashier,source_updated_at,nature_code)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now(),$15)`,
      [
        nextZj++, input.officeCode, input.sId, input.ownerName ?? '实收业主', String(input.sId),
        input.address ?? `应收路${input.sId}号`, input.feeCode ?? '01', input.feeName ?? '管理费',
        input.period, input.amountCents, input.paidDate ?? null, input.refundDate ?? null,
        input.paymentMethod ?? '现金', input.cashier ?? '收款员',
        input.natureCode,
      ],
    );
  };

  // 01 × 2004：17 户应收行合计 88,240；另 剑川路198弄25号201 金惠丽 200407–200412
  // 每月「+126.50 / -126.50」成对两行，旧系统按房屋×应收年月合并成一行显示 0.00
  // （MIS 29 行 → 旧系统下钻 23 行）。
  await addReceived({
    officeCode: '01', sId: 2001, natureCode: '01', period: '200401', amountCents: 3240,
    paidDate: '2020-05-01', address: '剑川路198弄1号101', ownerName: '一期2004业主',
    paymentMethod: '现金', cashier: '李四',
  });
  for (let index = 0; index < 11; index += 1) {
    await addReceived({
      officeCode: '01', sId: 2101 + index, natureCode: '01', period: '200402', amountCents: 5000,
      paidDate: '2004-02-01',
    });
  }
  for (let index = 0; index < 5; index += 1) {
    await addReceived({
      officeCode: '01', sId: 2112 + index, natureCode: '01', period: '200403', amountCents: 6000,
      paidDate: '2004-03-01',
    });
  }
  for (let month = 7; month <= 12; month += 1) {
    const period = `2004${String(month).padStart(2, '0')}`;
    await addReceived({
      officeCode: '01', sId: 2018, natureCode: '01', period, amountCents: 12650,
      paidDate: `${period.slice(0, 4)}-${period.slice(4)}-15`, address: '剑川路198弄25号201', ownerName: '金惠丽',
    });
    await addReceived({
      officeCode: '01', sId: 2018, natureCode: '01', period, amountCents: -12650,
      paidDate: `${period.slice(0, 4)}-${period.slice(4)}-20`, refundDate: `${period.slice(0, 4)}-${period.slice(4)}-20`,
      address: '剑川路198弄25号201', ownerName: '金惠丽',
    });
  }
  await addReceived({ officeCode: '01', sId: 2001, natureCode: '01', period: '200501', amountCents: 4170, paidDate: '2004-06-01' });
  await addReceived({ officeCode: '01', sId: 2002, natureCode: '01', period: '202701', amountCents: 2364295106, paidDate: '2026-01-15' });
  await addReceived({ officeCode: '01', sId: 2003, natureCode: null, period: '202702', amountCents: 176230750, paidDate: '2026-02-01' });
  await addReceived({ officeCode: '01', sId: 2003, natureCode: '06', period: '202703', amountCents: 12345, paidDate: '2026-02-02' });
  // 02：含负数退款调整行（refund_date 非空、金额为负），净额仍计入实收。
  await addReceived({ officeCode: '02', sId: 2004, natureCode: '01', period: '202501', amountCents: 2817727790, paidDate: '2026-01-01' });
  await addReceived({
    officeCode: '02', sId: 2004, natureCode: '01', period: '202512', amountCents: -400,
    paidDate: '2026-03-02', refundDate: '2026-03-02',
  });
  await addReceived({ officeCode: '02', sId: 2003, natureCode: '06', period: '202502', amountCents: 5000, paidDate: '2026-01-02' });
  await addReceived({ officeCode: '02', sId: 2003, natureCode: null, period: '202503', amountCents: 7000, paidDate: '2026-01-03' });
  // 03 / 04：验收基准里其它两个管理处。
  await addReceived({ officeCode: '03', sId: 2005, natureCode: '01', period: '202601', amountCents: 3448229110, paidDate: '2026-05-01' });
  await addReceived({ officeCode: '04', sId: 2001, natureCode: '01', period: '202401', amountCents: 6673943800, paidDate: '2026-06-01' });
  // 欠费行（paid_date 为空）：只用于验证 received 忽略 asOfPeriod 时 arrears 仍截断。
  await addReceived({ officeCode: '04', sId: 2001, natureCode: '01', period: '202701', amountCents: 500000 });
}

function annualOf(rows: any[], officeCode: string) {
  const row = rows.find((item) => item.officeCode === officeCode);
  assert.ok(row, `缺少管理处 ${officeCode} 行`);
  return row;
}

test('options：管理处/收费项目/FWXZK 字典/年度范围/镜像水位', async () => {
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
    // 05 名称改为 MIS 精确值；PMS 无同名小区，只展示、不映射。
    assert.deepEqual(result.offices[4], {
      officeCode: '05', name: '馨香北桥-二期', communityId: null, communityName: null,
    });
    assert.equal(result.feeItems.length, 16);
    assert.deepEqual(result.paymentMethods, [
      { id: 1, name: '现金' }, { id: 2, name: '微信' }, { id: 3, name: '支付宝' }, { id: 4, name: '转账' },
    ]);
    assert.deepEqual(result.feeItems.map((item: any) => item.code), FEE_ITEM_ORDER);
    assert.deepEqual(result.feeItems[0], { code: '12', name: '水费', category: '代收费' });
    // category 为空归「其它」，排序在代收费之后。
    assert.deepEqual(result.feeItems.find((item: any) => item.code === '09'), { code: '09', name: '网络费', category: '其它' });
    assert.deepEqual(result.feeItems.find((item: any) => item.code === '04'), { code: '04', name: '泊位费', category: '停车收费' });
    // FWXZK 字典按 code 排序全量返回；04=商铺、06=空房（旧口径曾把 06 算成商铺）。
    assert.deepEqual(result.natures, STATISTICS_NATURE_OPTIONS);
    assert.deepEqual(result.natures.find((item: any) => item.code === '04'), { code: '04', name: '商铺' });
    assert.deepEqual(result.natures.find((item: any) => item.code === '06'), { code: '06', name: '空房' });
    assert.deepEqual(result.yearRange, { min: 2004, max: 2027 });
  } finally {
    await pg.close();
  }
});

test('行级房屋性质口径：01 剔除 06 空房后 = 66226900，与旧系统截图一致', async () => {
  const pg = await makeDatabase();
  try {
    await seed(pg);
    const service = serviceFor(pg);
    const office01: any = await service.annual({
      type: 'arrears', officeCodes: ['01'], feeCodes: ['01'], natures: NATURES_WITHOUT_VACANT,
      yearFrom: 2004, yearTo: 2026,
    } as never, user, scopeAll);
    const row01 = annualOf(office01.rows, '01');
    assert.equal(row01.totalCents, 66226900);
    assert.equal(row01.cells['2004'], 44440);
    assert.equal(row01.cells['2005'], 48030);
    // 2007 只有 06 空房行：剔除后为 0，不能把 06 算成商铺。
    assert.equal(row01.cells['2007'], 0);
    assert.equal(row01.cells['2014'], 0);
    assert.equal(row01.cells['2024'], 466920);
    assert.equal(row01.cells['2025'], 1088520);
    assert.equal(row01.cells['2026'], 64578990);

    const office02: any = await service.annual({
      type: 'arrears', officeCodes: ['02'], feeCodes: ['01'], natures: NATURES_WITHOUT_VACANT,
      yearFrom: 2004, yearTo: 2026,
    } as never, user, scopeAll);
    const row02 = annualOf(office02.rows, '02');
    assert.equal(row02.totalCents, 74518210);
    assert.equal(row02.cells['2011'], 92100);
    assert.equal(row02.cells['2012'], 30700);
    assert.equal(row02.cells['2014'], 47790);
    assert.equal(row02.cells['2025'], 1659500);
    assert.equal(row02.cells['2026'], 72688120);
    assert.equal(row02.cells['2020'], 0);

    const both: any = await service.annual({
      type: 'arrears', officeCodes: ['01', '02'], feeCodes: ['01'], natures: NATURES_WITHOUT_VACANT,
      yearFrom: 2004, yearTo: 2026,
    } as never, user, scopeAll);
    assert.equal(both.subtotal.totalCents, 140745110);
    // 2014：01 只有被剔除的 06 空房，小计 = 02 的 47790。
    assert.equal(both.subtotal.cells['2014'], 47790);
    // 2026：01=64578990 + 02=72688120。
    assert.equal(both.subtotal.cells['2026'], 137267110);
  } finally {
    await pg.close();
  }
});

test('含 06 空房时 01 = 89461320（对照旧系统差异 23234420）', async () => {
  const pg = await makeDatabase();
  try {
    await seed(pg);
    const service = serviceFor(pg);
    const withoutFilter: any = await service.annual({
      type: 'arrears', officeCodes: ['01'], feeCodes: ['01'], yearFrom: 2004, yearTo: 2026,
    } as never, user, scopeAll);
    const row01 = annualOf(withoutFilter.rows, '01');
    assert.equal(row01.totalCents, 89461320);
    assert.equal(row01.cells['2007'], 5432180);
    assert.equal(row01.cells['2008'], 2122680);
    assert.equal(row01.cells['2016'], 273600);

    const withVacant: any = await service.annual({
      type: 'arrears', officeCodes: ['01'], feeCodes: ['01'],
      natures: [...NATURES_WITHOUT_VACANT, '06'], yearFrom: 2004, yearTo: 2026,
    } as never, user, scopeAll);
    assert.equal(annualOf(withVacant.rows, '01').totalCents, 89461320);
  } finally {
    await pg.close();
  }
});

test('收费项目/房屋性质过滤按收费明细行：2026 = 商品房 + 商铺', async () => {
  const pg = await makeDatabase();
  try {
    await seed(pg);
    const service = serviceFor(pg);
    const allNatures: any = await service.annual({
      type: 'arrears', officeCodes: ['02'], feeCodes: ['01'], natures: NATURES_WITHOUT_VACANT,
      yearFrom: 2026, yearTo: 2026,
    } as never, user, scopeAll);
    assert.equal(annualOf(allNatures.rows, '02').cells['2026'], 72688120);

    const commodity: any = await service.annual({
      type: 'arrears', officeCodes: ['02'], feeCodes: ['01'], natures: ['01'], yearFrom: 2026, yearTo: 2026,
    } as never, user, scopeAll);
    assert.equal(annualOf(commodity.rows, '02').cells['2026'], 68303800);

    const shop: any = await service.annual({
      type: 'arrears', officeCodes: ['02'], feeCodes: ['01'], natures: ['04'], yearFrom: 2026, yearTo: 2026,
    } as never, user, scopeAll);
    assert.equal(annualOf(shop.rows, '02').cells['2026'], 4384320);

    const combined: any = await service.annual({
      type: 'arrears', officeCodes: ['02'], feeCodes: ['01'], natures: ['01', '04'], yearFrom: 2026, yearTo: 2026,
    } as never, user, scopeAll);
    assert.equal(annualOf(combined.rows, '02').cells['2026'], 72688120);

    const rent: any = await service.annual({
      type: 'arrears', officeCodes: ['02'], feeCodes: ['02'], yearFrom: 2026, yearTo: 2026,
    } as never, user, scopeAll);
    assert.equal(annualOf(rent.rows, '02').cells['2026'], 1234);

    // 一期 2026 = 01 商品房 48186870 + 04 商铺 16392120。
    const office01: any = await service.annual({
      type: 'arrears', officeCodes: ['01'], feeCodes: ['01'], natures: ['01'], yearFrom: 2026, yearTo: 2026,
    } as never, user, scopeAll);
    assert.equal(annualOf(office01.rows, '01').cells['2026'], 48186870);
    const office01Shop: any = await service.annual({
      type: 'arrears', officeCodes: ['01'], feeCodes: ['01'], natures: ['04'], yearFrom: 2026, yearTo: 2026,
    } as never, user, scopeAll);
    assert.equal(annualOf(office01Shop.rows, '01').cells['2026'], 16392120);
  } finally {
    await pg.close();
  }
});

test('nature_code 为 NULL 的行：不传 natures 计入，传 natures 排除', async () => {
  const pg = await makeDatabase();
  try {
    await seed(pg);
    const service = serviceFor(pg);
    const included: any = await service.annual({
      type: 'arrears', officeCodes: ['04'], feeCodes: ['01'], yearFrom: 2027, yearTo: 2027,
    } as never, user, scopeAll);
    assert.equal(annualOf(included.rows, '04').cells['2027'], 999900);

    const excluded: any = await service.annual({
      type: 'arrears', officeCodes: ['04'], feeCodes: ['01'], natures: ['01'], yearFrom: 2027, yearTo: 2027,
    } as never, user, scopeAll);
    assert.equal(annualOf(excluded.rows, '04').cells['2027'], 0);

    const detailIncluded: any = await service.annualDetail({
      type: 'arrears', officeCode: '04', year: 2027, feeCodes: ['01'],
    } as never, user, scopeAll);
    assert.equal(detailIncluded.totalCents, 999900);
    const detailExcluded: any = await service.annualDetail({
      type: 'arrears', officeCode: '04', year: 2027, feeCodes: ['01'], natures: ['01'],
    } as never, user, scopeAll);
    assert.deepEqual(detailExcluded.rows, []);
    assert.equal(detailExcluded.totalCents, 0);

    const billsIncluded: any = await service.annualDetailBills({
      type: 'arrears', officeCode: '04', sId: 1002, year: 2027, feeCodes: ['01'],
    } as never, user, scopeAll);
    assert.equal(billsIncluded.totalCents, 999900);
    const billsExcluded: any = await service.annualDetailBills({
      type: 'arrears', officeCode: '04', sId: 1002, year: 2027, feeCodes: ['01'], natures: ['01'],
    } as never, user, scopeAll);
    assert.equal(billsExcluded.rows.length, 0);
    assert.equal(billsExcluded.totalCents, 0);
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
      type: 'arrears', officeCodes: ['02'], feeCodes: ['01'], natures: NATURES_WITHOUT_VACANT,
      yearFrom: 2004, yearTo: 2026,
    } as never, user, scopeAll);
    const cell = annualOf(annual.rows, '02').cells['2014'];
    const detail: any = await service.annualDetail({
      type: 'arrears', officeCode: '02', year: 2014, feeCodes: ['01'], natures: NATURES_WITHOUT_VACANT,
    } as never, user, scopeAll);
    assert.equal(detail.available, true);
    assert.equal(detail.detailKind, 'arrears');
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

test('明细按行级性质过滤：01×2026 商品房/商铺合计等于单元格', async () => {
  const pg = await makeDatabase();
  try {
    await seed(pg);
    const service = serviceFor(pg);
    const annual: any = await service.annual({
      type: 'arrears', officeCodes: ['01'], feeCodes: ['01'], natures: NATURES_WITHOUT_VACANT,
      yearFrom: 2026, yearTo: 2026,
    } as never, user, scopeAll);
    const cell = annualOf(annual.rows, '01').cells['2026'];
    const detail: any = await service.annualDetail({
      type: 'arrears', officeCode: '01', year: 2026, feeCodes: ['01'], natures: NATURES_WITHOUT_VACANT,
    } as never, user, scopeAll);
    assert.equal(detail.totalCents, cell);
    assert.deepEqual(detail.rows.map((row: any) => [row.sId, row.amountCents]), [[801, 48186870], [802, 16392120]]);
    assert.equal(detail.rows.reduce((sum: number, row: any) => sum + row.amountCents, 0), cell);

    const bills: any = await service.annualDetailBills({
      type: 'arrears', officeCode: '01', sId: 802, year: 2026, feeCodes: ['01'],
    } as never, user, scopeAll);
    assert.equal(bills.totalCents, 16392120);
    assert.equal(bills.rows.length, 1);
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

    // 06 空房行在传 natures 时不能出现在明细/逐笔里。
    const vacantDetail: any = await service.annualDetail({
      type: 'arrears', officeCode: '01', year: 2007, feeCodes: ['01'], natures: NATURES_WITHOUT_VACANT,
    } as never, user, scopeAll);
    assert.deepEqual(vacantDetail.rows, []);
    const vacantBills: any = await service.annualDetailBills({
      type: 'arrears', officeCode: '01', sId: 801, year: 2007, feeCodes: ['01'], natures: ['06'],
    } as never, user, scopeAll);
    assert.equal(vacantBills.rows.length, 1);
    assert.equal(vacantBills.totalCents, 5432180);
  } finally {
    await pg.close();
  }
});

test('实收年度汇总按应收年月 period 归年（不是收款日期年度），含负数退款净额', async () => {
  const pg = await makeDatabase();
  try {
    await seed(pg);
    const service = serviceFor(pg);
    const result: any = await service.annual({
      type: 'received', officeCodes: ['02'], feeCodes: ['01'], yearFrom: 2024, yearTo: 2026,
    } as never, user, scopeAll);
    const office02 = annualOf(result.rows, '02');
    // period=202401 但 2025-05-01 才收款：列按应收年月归 2024，不是按收款年度归 2025。
    assert.equal(office02.cells['2024'], 200);
    assert.equal(office02.cells['2025'], 0);
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

test('实收年度汇总按应收年月归年：01 2004=88240，默认性质各管理处合计对齐旧系统', async () => {
  const pg = await makeDatabase();
  try {
    await seedReceived(pg);
    const service = serviceFor(pg);
    const result: any = await service.annual({
      type: 'received', feeCodes: ['01'], natures: NATURES_WITHOUT_VACANT, yearFrom: 2004, yearTo: 2027,
    } as never, user, scopeAll);
    const office01 = annualOf(result.rows, '01');
    // period=200401 的 882.40 归 2004；旧实现按收款年度 2020 归年时 2004 只有 41.70。
    assert.equal(office01.cells['2004'], 88240);
    assert.equal(office01.cells['2005'], 4170);
    assert.equal(office01.cells['2020'], 0);
    assert.equal(office01.cells['2027'], 2364295106);
    assert.equal(office01.totalCents, 2364387516);
    assert.equal(annualOf(result.rows, '02').totalCents, 2817727390);
    assert.equal(annualOf(result.rows, '03').totalCents, 3448229110);
    assert.equal(annualOf(result.rows, '04').totalCents, 6673943800);
    assert.equal(annualOf(result.rows, '05').totalCents, 0);
    // 小计 = 01–04 四项之和（与旧截图 ¥153,042,878.16 一致）。
    assert.equal(result.subtotal.totalCents, 15304287816);
    assert.equal(result.subtotal.cells['2004'], 88240);

    // 不传 natures：06 空房与 nature_code=NULL 行按 IN 关掉后的口径计入。
    const allNatures: any = await service.annual({
      type: 'received', feeCodes: ['01'], yearFrom: 2004, yearTo: 2027,
    } as never, user, scopeAll);
    const office01All = annualOf(allNatures.rows, '01');
    assert.equal(office01All.cells['2027'], 2364295106 + 176230750 + 12345);
    assert.equal(office01All.totalCents, 2364387516 + 176230750 + 12345);
  } finally {
    await pg.close();
  }
});

test('实收下钻按房屋×应收年月聚合：01×2004 共 23 行，金惠丽成对冲抵合并为 0.00', async () => {
  const pg = await makeDatabase();
  try {
    await seedReceived(pg);
    const service = serviceFor(pg);
    const annual: any = await service.annual({
      type: 'received', officeCodes: ['01'], feeCodes: ['01'], natures: NATURES_WITHOUT_VACANT,
      yearFrom: 2004, yearTo: 2004,
    } as never, user, scopeAll);
    const cell = annualOf(annual.rows, '01').cells['2004'];
    const detail: any = await service.annualDetail({
      type: 'received', officeCode: '01', year: 2004, feeCodes: ['01'], natures: NATURES_WITHOUT_VACANT,
    } as never, user, scopeAll);
    assert.equal(detail.detailKind, 'received');
    assert.equal(detail.totalCents, cell);
    // MIS 29 行 → 每户每应收年月一行 = 23 行（6 组成对冲抵行合并后各 1 行）。
    assert.equal(detail.rows.length, 23);
    assert.equal(detail.rows.reduce((sum: number, row: any) => sum + row.amountCents, 0), 88240);

    const houseRow = detail.rows.find((row: any) => row.address === '剑川路198弄1号101' && row.period === '200401');
    assert.deepEqual(houseRow, {
      zjId: null,
      sId: 2001,
      address: '剑川路198弄1号101',
      ownerName: '一期2004业主',
      areaSqm: 88.5,
      period: '200401',
      amountCents: 3240,
      paidDate: '2020-05-01',
      refundDate: null,
      paymentMethod: null,
      cashier: null,
      receiptNo: null,
      invoiceNo: null,
    });

    // 剑川路198弄25号201 金惠丽：200407–200412 每月「+126.50 / -126.50」合并为一行 0.00。
    const goldRows = detail.rows.filter((row: any) => row.address === '剑川路198弄25号201');
    assert.deepEqual(goldRows.map((row: any) => row.period), ['200407', '200408', '200409', '200410', '200411', '200412']);
    assert.deepEqual(goldRows.map((row: any) => row.amountCents), [0, 0, 0, 0, 0, 0]);
    assert.ok(goldRows.every((row: any) => row.sId === 2018 && row.ownerName === '金惠丽' && row.areaSqm === 100.5));

    // 退款/红冲行（负数、refund_date 非空）聚合后仍在清单里，净额合计=单元格。
    const annual02: any = await service.annual({
      type: 'received', officeCodes: ['02'], feeCodes: ['01'], natures: NATURES_WITHOUT_VACANT,
      yearFrom: 2025, yearTo: 2025,
    } as never, user, scopeAll);
    const detail02: any = await service.annualDetail({
      type: 'received', officeCode: '02', year: 2025, feeCodes: ['01'], natures: NATURES_WITHOUT_VACANT,
    } as never, user, scopeAll);
    assert.equal(detail02.totalCents, annualOf(annual02.rows, '02').cells['2025']);
    assert.equal(detail02.rows.length, 2);
    assert.deepEqual(detail02.rows.map((row: any) => row.amountCents), [2817727790, -400]);
    assert.equal(detail02.rows[1].refundDate, '2026-03-02');
    assert.ok(detail02.rows.every((row: any) => row.zjId === null && row.paymentMethod === null && row.cashier === null));

    // nature_code=NULL / 06 行：默认性质过滤排除；不传 natures 时进入清单。
    const detailFiltered: any = await service.annualDetail({
      type: 'received', officeCode: '01', year: 2027, feeCodes: ['01'], natures: NATURES_WITHOUT_VACANT,
    } as never, user, scopeAll);
    assert.equal(detailFiltered.rows.length, 1);
    const detailAll: any = await service.annualDetail({
      type: 'received', officeCode: '01', year: 2027, feeCodes: ['01'],
    } as never, user, scopeAll);
    assert.equal(detailAll.rows.length, 3);
    assert.equal(detailAll.totalCents, detailFiltered.totalCents + 176230750 + 12345);
  } finally {
    await pg.close();
  }
});

test('received 忽略 asOfPeriod（列到 2027 不截断），arrears 仍按应收截止年月截断', async () => {
  const pg = await makeDatabase();
  try {
    await seedReceived(pg);
    const service = serviceFor(pg);
    const base = {
      type: 'received', officeCodes: ['01'], feeCodes: ['01'], natures: NATURES_WITHOUT_VACANT,
      yearFrom: 2004, yearTo: 2027,
    } as const;
    const noCutoff: any = await service.annual({ ...base } as never, user, scopeAll);
    const withCutoff: any = await service.annual({ ...base, asOfPeriod: '202612' } as never, user, scopeAll);
    assert.deepEqual(withCutoff.rows, noCutoff.rows);
    assert.deepEqual(withCutoff.subtotal, noCutoff.subtotal);
    // 旧系统实收报表列到 2027 且有金额：period 202701 的已收行不能被 202612 截断。
    assert.equal(annualOf(withCutoff.rows, '01').cells['2027'], 2364295106);
    assert.equal(withCutoff.subtotal.cells['2027'], 2364295106);

    const detail: any = await service.annualDetail({
      type: 'received', officeCode: '01', year: 2027, feeCodes: ['01'],
      natures: NATURES_WITHOUT_VACANT, asOfPeriod: '202612',
    } as never, user, scopeAll);
    assert.equal(detail.rows.length, 1);
    assert.equal(detail.rows[0].period, '202701');
    assert.equal(detail.totalCents, 2364295106);

    const bills: any = await service.annualDetailBills({
      type: 'received', officeCode: '01', sId: 2002, year: 2027, feeCodes: ['01'],
      natures: NATURES_WITHOUT_VACANT, asOfPeriod: '202612',
    } as never, user, scopeAll);
    assert.equal(bills.totalCents, 2364295106);

    // arrears 仍受 asOfPeriod 影响：202701 的欠费行会被 202611 截止年月排除。
    const arrears = { type: 'arrears', officeCodes: ['04'], feeCodes: ['01'], yearFrom: 2026, yearTo: 2027 } as const;
    const arrearsOpen: any = await service.annual({ ...arrears } as never, user, scopeAll);
    const arrearsCut: any = await service.annual({ ...arrears, asOfPeriod: '202611' } as never, user, scopeAll);
    assert.equal(annualOf(arrearsOpen.rows, '04').cells['2027'], 500000);
    assert.equal(annualOf(arrearsCut.rows, '04').cells['2027'], 0);
  } finally {
    await pg.close();
  }
});

test('paidDateFrom/paidDateTo 只过滤收款行，不改变按 period 归年', async () => {
  const pg = await makeDatabase();
  try {
    await seedReceived(pg);
    const service = serviceFor(pg);
    const noRange: any = await service.annual({
      type: 'received', officeCodes: ['01'], feeCodes: ['01'], natures: NATURES_WITHOUT_VACANT,
      yearFrom: 2004, yearTo: 2005,
    } as never, user, scopeAll);
    assert.equal(annualOf(noRange.rows, '01').cells['2004'], 88240);
    assert.equal(annualOf(noRange.rows, '01').cells['2005'], 4170);

    // 收款起始 2021：2004-period 那笔（2020 收款）被行过滤掉，列归年不变。
    const from2021: any = await service.annual({
      type: 'received', officeCodes: ['01'], feeCodes: ['01'], natures: NATURES_WITHOUT_VACANT,
      yearFrom: 2004, yearTo: 2005, paidDateFrom: '2021-01-01',
    } as never, user, scopeAll);
    assert.equal(annualOf(from2021.rows, '01').cells['2004'], 0);
    assert.equal(annualOf(from2021.rows, '01').cells['2005'], 0);

    // 收款截止 2020-12-31：2004-period 与 2005-period 的 2004 年收款都保留。
    const to2020: any = await service.annual({
      type: 'received', officeCodes: ['01'], feeCodes: ['01'], natures: NATURES_WITHOUT_VACANT,
      yearFrom: 2004, yearTo: 2005, paidDateTo: '2020-12-31',
    } as never, user, scopeAll);
    assert.equal(annualOf(to2020.rows, '01').cells['2004'], 88240);
    assert.equal(annualOf(to2020.rows, '01').cells['2005'], 4170);

    const detailFiltered: any = await service.annualDetail({
      type: 'received', officeCode: '01', year: 2004, feeCodes: ['01'], natures: NATURES_WITHOUT_VACANT,
      paidDateFrom: '2021-01-01',
    } as never, user, scopeAll);
    assert.deepEqual(detailFiltered.rows, []);
    assert.equal(detailFiltered.totalCents, annualOf(from2021.rows, '01').cells['2004']);
    const detailKept: any = await service.annualDetail({
      type: 'received', officeCode: '01', year: 2004, feeCodes: ['01'], natures: NATURES_WITHOUT_VACANT,
      paidDateTo: '2020-12-31',
    } as never, user, scopeAll);
    assert.equal(detailKept.totalCents, annualOf(to2020.rows, '01').cells['2004']);
    // 2004 全部 23 组收款行（17 户 + 金惠丽 6 个月）都在 2020-12-31 前收款。
    assert.equal(detailKept.rows.length, 23);
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

test('paidDateFrom 收款起始日期与 paidDateTo 组合过滤（仅实收）', async () => {
  const pg = await makeDatabase();
  try {
    await seed(pg);
    const service = serviceFor(pg);
    const fromOnly: any = await service.annual({
      type: 'received', officeCodes: ['02'], feeCodes: ['01'], yearFrom: 2026, yearTo: 2026,
      paidDateFrom: '2026-03-02',
    } as never, user, scopeAll);
    assert.equal(annualOf(fromOnly.rows, '02').cells['2026'], -400);

    const sameDay: any = await service.annual({
      type: 'received', officeCodes: ['02'], feeCodes: ['01'], yearFrom: 2026, yearTo: 2026,
      paidDateFrom: '2026-03-01', paidDateTo: '2026-03-01',
    } as never, user, scopeAll);
    assert.equal(annualOf(sameDay.rows, '02').cells['2026'], 1000);

    const range: any = await service.annual({
      type: 'received', officeCodes: ['02'], feeCodes: ['01'], yearFrom: 2026, yearTo: 2026,
      paidDateFrom: '2026-03-02', paidDateTo: '2026-03-02',
    } as never, user, scopeAll);
    assert.equal(annualOf(range.rows, '02').cells['2026'], -400);

    // 下钻带上同一范围时合计仍等于单元格。
    const detail: any = await service.annualDetail({
      type: 'received', officeCode: '02', year: 2026, feeCodes: ['01'],
      paidDateFrom: '2026-03-02', paidDateTo: '2026-03-02',
    } as never, user, scopeAll);
    assert.equal(detail.totalCents, annualOf(range.rows, '02').cells['2026']);
    const bills: any = await service.annualDetailBills({
      type: 'received', officeCode: '02', sId: 501, year: 2026, feeCodes: ['01'],
      paidDateFrom: '2026-03-02', paidDateTo: '2026-03-02',
    } as never, user, scopeAll);
    assert.equal(bills.totalCents, detail.totalCents);
    assert.equal(bills.rows.length, 1);
    assert.equal(bills.rows[0].amountCents, -400);

    // 欠费口径忽略收款日期范围。
    const arrears: any = await service.annual({
      type: 'arrears', officeCodes: ['02'], feeCodes: ['01'], yearFrom: 2026, yearTo: 2026,
      paidDateFrom: '2026-03-02', paidDateTo: '2026-03-02',
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
    assert.deepEqual(options.paymentMethods, []);
    // 房屋性质字典是 FWXZK 常量，与镜像是否有数据无关。
    assert.deepEqual(options.natures, STATISTICS_NATURE_OPTIONS);
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

test('type/日期非法 400，列表参数解析为数组', async () => {
  const pipe = new ValidationPipe({ whitelist: true, transform: true });
  await assert.rejects(
    pipe.transform({ type: 'bogus' }, { type: 'query', metatype: StatisticsAnnualQueryDto }),
    (error: unknown) => error instanceof BadRequestException,
  );
  await assert.rejects(
    pipe.transform({ type: 'received', paidDateFrom: '2026/03/01' }, { type: 'query', metatype: StatisticsAnnualQueryDto }),
    (error: unknown) => error instanceof BadRequestException,
  );
  await assert.rejects(
    pipe.transform({ type: 'received', paidDateTo: '2026-13-01' }, { type: 'query', metatype: StatisticsAnnualQueryDto }),
    (error: unknown) => error instanceof BadRequestException,
  );
  await assert.rejects(
    pipe.transform({ type: 'arrears', officeCode: '02' }, { type: 'query', metatype: StatisticsAnnualDetailQueryDto }),
    (error: unknown) => error instanceof BadRequestException,
  );
  const parsed = await pipe.transform(
    {
      type: 'arrears', officeCodes: '01,02', natures: '01,04', yearFrom: '2004', yearTo: '2026',
      asOfPeriod: '202612', paidDateFrom: '2026-03-01', paidDateTo: '2026-03-31',
    },
    { type: 'query', metatype: StatisticsAnnualQueryDto },
  ) as StatisticsAnnualQueryDto;
  assert.deepEqual(parsed.officeCodes, ['01', '02']);
  assert.deepEqual(parsed.natures, ['01', '04']);
  assert.equal(parsed.yearFrom, 2004);
  assert.equal(parsed.yearTo, 2026);
  assert.equal(parsed.asOfPeriod, '202612');
  assert.equal(parsed.paidDateFrom, '2026-03-01');
  assert.equal(parsed.paidDateTo, '2026-03-31');
});

test('报表接口复用 business:view 权限，不新增页面 key', () => {
  const handlers = StatisticsController.prototype as unknown as Record<string, object>;
  for (const key of ['options', 'annual', 'annualDetail', 'annualDetailBills']) {
    assert.deepEqual(Reflect.getMetadata(PERMISSION_KEY, handlers[key]!), {
      items: [{ pageKey: 'business', action: 'view' }],
    });
  }
});
