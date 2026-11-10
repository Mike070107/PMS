// Synthetic-only transport for the statistics regression fixture.
// Every unexpected call fails closed: this fixture never reaches a real server.
const w = window as any;
w.__calls = [];
w.__annualFail = false;
w.__annualUnavailable = false;
w.__optionsUnavailable = false;
w.__detailFail = false;
w.__billsFail = false;
w.__blobs = [];
w.__requestPlans = [];
w.__pendingRequests = [];
w.__finishedRequests = [];

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const OFFICES = [
  { officeCode: '01', name: '枫桦景苑一期', communityId: 1, communityName: '枫桦景苑一期' },
  { officeCode: '02', name: '枫桦景苑二期A', communityId: 2, communityName: '枫桦景苑二期' },
  { officeCode: '03', name: '枫桦景苑二期B', communityId: 2, communityName: '枫桦景苑二期' },
  { officeCode: '04', name: '上海新家', communityId: 16, communityName: '上海新家' },
];
// 旧 MIS 收费项目分类树：代收费 / 其它 / 日常收费 / 停车收费（后端 P1.2 在 feeItems 里带 category）。
const FEE_ITEMS = [
  { code: '01', name: '管理费', category: '日常收费' },
  { code: '02', name: '租金', category: '日常收费' },
  { code: '03', name: '保洁保安费', category: '日常收费' },
  { code: '04', name: '泊位费', category: '停车收费' },
  { code: '05', name: '临时停车费', category: '停车收费' },
  { code: '06', name: '保安费', category: '日常收费' },
  { code: '07', name: '保洁费', category: '日常收费' },
  { code: '08', name: '保安保洁费', category: '日常收费' },
  { code: '09', name: '网络费', category: '其它' },
  { code: '10', name: '青客租金', category: '其它' },
  { code: '11', name: '青客未签约租金', category: '其它' },
  { code: '12', name: '水费', category: '代收费' },
  { code: '13', name: '电费', category: '代收费' },
  { code: '14', name: '停车管理费', category: '停车收费' },
  { code: '15', name: '空房租金', category: '日常收费' },
  { code: '16', name: '置业泊位费', category: '停车收费' },
];
// MIS FWXZK 房屋性质字典（outputs/mis-db-sync-20261106/data/0043_dbo.FWXZK.csv，01–13 共 13 项）。
const NATURES = [
  { code: '01', name: '商品房' }, { code: '02', name: '售后公房' }, { code: '03', name: '使用权房' },
  { code: '04', name: '商铺' }, { code: '05', name: '配套用房' }, { code: '06', name: '空房' },
  { code: '07', name: '居住' }, { code: '08', name: '非居住' }, { code: '09', name: '系统' },
  { code: '10', name: '非系统' }, { code: '11', name: '代管' }, { code: '12', name: '非代管' },
  { code: '13', name: '私房' },
];
const OPTIONS = {
  offices: OFFICES,
  feeItems: FEE_ITEMS,
  natures: NATURES,
  paymentMethods: [
    { id: '现金', name: '现金' }, { id: '微信', name: '微信' }, { id: '支付宝', name: '支付宝' },
    { id: '银行', name: '银行' }, { id: '转账', name: '转账' },
  ],
  yearRange: { min: 2004, max: 2027 },
  dataAsOf: '2026-11-09T21:00:00+08:00',
  sourceMode: 'mirror',
  available: true,
  message: null as string | null,
};

// 验收基准：02 管理处管理费欠费 2011=921.00 / 2012=307.00 / 2014=477.90 / 2025=16,595.00 / 2026=726,881.20
const ARREARS_CELLS: Record<string, Record<number, number>> = {
  '01': { 2014: 100000 },
  '02': { 2011: 92100, 2012: 30700, 2014: 47790, 2025: 1659500, 2026: 72688120 },
  '04': { 2020: 5000 },
};
const RECEIVED_CELLS: Record<string, Record<number, number>> = {
  // P1.3：实收按「应收年月」归年；01 管理处 2004 应收年度 ¥982.40（含 06 空房 ¥100.00，
  // 收款项在 2006/2009/2013 收回，验证跨年）。
  // 旧系统实收报表不按应收截止年月截断：2027 列仍有金额（¥1,600.00）。
  '01': { 2004: 98240, 2027: 160000 },
  '02': { 2014: 120000, 2025: 16595000, 2026: 726881200 },
};

/** 实收 01×2004 的 23 条逐笔已收流水，合计 98240 分（含 06 空房 ¥100.00，与单元格一致）。 */
function received2004Rows() {
  const count = 23;
  const total = 98240;
  const base = 3600;
  return Array.from({ length: count }, (_, index) => {
    const last = index === count - 1;
    const paidYears = ['2006-03-15', '2009-07-01', '2013-11-20'];
    return {
      zjId: 2004000 + index + 1,
      sId: 800 + index,
      address: `宝秀路${719 + index}号${101 + index}室`,
      ownerName: `合成业主${index + 1}`,
      areaSqm: 79.67,
      period: `2004${String((index % 12) + 1).padStart(2, '0')}`,
      amountCents: last ? total - base * (count - 1) : base,
      paidDate: paidYears[index % paidYears.length],
      refundDate: null,
      paymentMethod: index % 2 ? '银行' : '现金',
      cashier: '合成收费员',
      receiptNo: null,
      invoiceNo: null,
    };
  });
}

function receivedCellCents(officeCode: string, year: number): number {
  return RECEIVED_CELLS[officeCode]?.[year] ?? 0;
}

function annualResponse(type: string, officeCodes: string[], yearFrom: number, yearTo: number) {
  const columns: number[] = [];
  for (let year = yearFrom; year <= yearTo; year += 1) columns.push(year);
  const source = type === 'arrears' ? ARREARS_CELLS : RECEIVED_CELLS;
  const selected = officeCodes.length ? OFFICES.filter((office) => officeCodes.includes(office.officeCode)) : OFFICES;
  const rows = selected.map((office) => {
    const cells: Record<string, number> = {};
    for (const year of columns) cells[String(year)] = source[office.officeCode]?.[year] ?? 0;
    const totalCents = columns.reduce((sum, year) => sum + cells[String(year)], 0);
    return { officeCode: office.officeCode, officeName: office.name, cells, totalCents };
  });
  const subtotalCells: Record<string, number> = {};
  for (const year of columns) subtotalCells[String(year)] = rows.reduce((sum, row) => sum + row.cells[String(year)], 0);
  const subtotal = {
    cells: subtotalCells,
    totalCents: columns.reduce((sum, year) => sum + subtotalCells[String(year)], 0),
  };
  return { type, columns, rows, subtotal, dataAsOf: OPTIONS.dataAsOf, available: true, message: null };
}

// P2 收费汇总：行=收费项目、列=房屋性质净额；行尾收款/退款/调整/净额。
// 夹具数值自洽：net = received - refund + adjust，同时等于各 nature 单元格之和。
const FEE_NATURE_ROWS = [
  { feeCode: '01', feeName: '管理费', cells: { '01': 11915220 }, receivedCents: 11915220, refundCents: 0, adjustCents: 0, netCents: 11915220 },
  { feeCode: '04', feeName: '泊位费', cells: { '01': -60000, '06': 3090000 }, receivedCents: 3105000, refundCents: 15000, adjustCents: -60000, netCents: 3030000 },
  { feeCode: '14', feeName: '停车管理费', cells: { '06': 324000 }, receivedCents: 324000, refundCents: 0, adjustCents: 0, netCents: 324000 },
  { feeCode: '16', feeName: '置业泊位费', cells: { '06': 30000 }, receivedCents: 30000, refundCents: 0, adjustCents: 0, netCents: 30000 },
];

function feeNatureResponse(query: any) {
  const feeCodes = String(query?.feeCodes ?? '').split(',').filter(Boolean);
  const selected = feeCodes.length ? FEE_NATURE_ROWS.filter((row) => feeCodes.includes(row.feeCode)) : FEE_NATURE_ROWS;
  const cellsOf = (row: { cells: Record<string, number> }) => {
    const cells: Record<string, number> = {};
    for (const nature of NATURES) cells[nature.code] = row.cells[nature.code] ?? 0;
    return cells;
  };
  const rows = selected.map((row) => ({ ...row, cells: cellsOf(row) }));
  const subtotal = {
    feeCode: '', feeName: '总计',
    cells: Object.fromEntries(NATURES.map((nature) => [nature.code, rows.reduce((sum, row) => sum + row.cells[nature.code], 0)])),
    receivedCents: rows.reduce((sum, row) => sum + row.receivedCents, 0),
    refundCents: rows.reduce((sum, row) => sum + row.refundCents, 0),
    adjustCents: rows.reduce((sum, row) => sum + row.adjustCents, 0),
    netCents: rows.reduce((sum, row) => sum + row.netCents, 0),
  };
  return {
    columns: NATURES, natures: NATURES, rows, subtotal,
    dataAsOf: OPTIONS.dataAsOf, available: true, message: null,
  };
}

// P2 日报：费项列=正收款；退款/调整按业务日另列，无业务日不补行。
// 日期跟随当前自然月；默认到今天时必须排除未来日期，整月验收显式改结束日。
const NOW = new Date();
const DAY = (day: number) => `${NOW.getFullYear()}-${String(NOW.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
const PAYMENT_DETAIL = { rowKind: 'received', feeCode: '01', feeName: '管理费', natureCode: '01', natureName: '商品房', ownerName: '合成业主1', period: `${NOW.getFullYear()}${String(NOW.getMonth() + 1).padStart(2, '0')}`, amountCents: 39800, paidDate: DAY(1), refundDate: null, paymentMethod: '微信', cashier: '合成收费员' };
// 8,000,000 分拆为 201 条整数分（200×39,800 + 40,000），矩阵合计不变，用于分页竞态。
const SPLIT_8000_ROWS = Array.from({ length: 201 }, (_, index) => ({
  ...PAYMENT_DETAIL,
  address: `宝秀路719号${101 + index}室`,
  amountCents: index === 200 ? 40000 : 39800,
  ownerName: `合成业主${index + 1}`,
}));
const COLLECTION_DETAIL_ROWS = [
  ...SPLIT_8000_ROWS,
  { rowKind: 'received', feeCode: '01', feeName: '管理费', natureCode: '01', natureName: '商品房', address: '宝秀路720号102室', ownerName: '合成业主2', period: `${NOW.getFullYear()}${String(NOW.getMonth() + 1).padStart(2, '0')}`, amountCents: 3915220, paidDate: DAY(3), refundDate: null, paymentMethod: '现金', cashier: '合成收费员' },
  { rowKind: 'adjust', feeCode: '04', feeName: '泊位费', natureCode: '01', natureName: '商品房', address: '宝秀路721号103室', ownerName: '合成业主3', period: `${NOW.getFullYear()}${String(NOW.getMonth() + 1).padStart(2, '0')}`, amountCents: -60000, paidDate: DAY(5), refundDate: null, paymentMethod: '现金', cashier: '合成收费员' },
  { rowKind: 'received', feeCode: '04', feeName: '泊位费', natureCode: '06', natureName: '空房', address: '宝秀路722号104室', ownerName: '合成业主4', period: `${NOW.getFullYear()}${String(NOW.getMonth() + 1).padStart(2, '0')}`, amountCents: 3105000, paidDate: DAY(9), refundDate: null, paymentMethod: '微信', cashier: '合成收费员' },
  { rowKind: 'refund', feeCode: '04', feeName: '泊位费', natureCode: '06', natureName: '空房', address: '宝秀路722号104室', ownerName: '合成业主4', period: `${NOW.getFullYear()}${String(NOW.getMonth() + 1).padStart(2, '0')}`, amountCents: 15000, paidDate: null, refundDate: DAY(8), paymentMethod: '微信', cashier: '合成收费员' },
  { rowKind: 'received', feeCode: '14', feeName: '停车管理费', natureCode: '06', natureName: '空房', address: '宝秀路730号112室', ownerName: '合成业主12', period: `${NOW.getFullYear()}${String(NOW.getMonth() + 1).padStart(2, '0')}`, amountCents: 324000, paidDate: DAY(14), refundDate: null, paymentMethod: '银行', cashier: '合成收费员' },
  { rowKind: 'received', feeCode: '16', feeName: '置业泊位费', natureCode: '06', natureName: '空房', address: '宝秀路741号123室', ownerName: '合成业主23', period: `${NOW.getFullYear()}${String(NOW.getMonth() + 1).padStart(2, '0')}`, amountCents: 30000, paidDate: DAY(20), refundDate: null, paymentMethod: '微信', cashier: '合成收费员' },
];

function collectionDetailResponse(query: any) {
  const feeCodes = String(query?.feeCodes ?? '').split(',').filter(Boolean);
  const natures = String(query?.natures ?? '').split(',').filter(Boolean);
  const kind = String(query?.kind ?? 'all');
  const dateFrom = query?.dateFrom ? String(query.dateFrom) : '';
  const dateTo = query?.dateTo ? String(query.dateTo) : '';
  const inRange = (value: string | null) => {
    if (!value) return false;
    if (dateFrom && value < dateFrom) return false;
    if (dateTo && value > dateTo) return false;
    return true;
  };
  const rows = COLLECTION_DETAIL_ROWS.filter((row) => {
    if (feeCodes.length && !feeCodes.includes(row.feeCode)) return false;
    if (natures.length && !natures.includes(row.natureCode)) return false;
    if (kind !== 'all' && row.rowKind !== kind) return false;
    if (kind === 'refund') return inRange(row.refundDate);
    if (kind === 'all' && row.rowKind === 'refund') return inRange(row.refundDate);
    return inRange(row.paidDate);
  });
  const receivedCents = rows.filter((row) => row.rowKind === 'received').reduce((sum, row) => sum + row.amountCents, 0);
  const refundCents = rows.filter((row) => row.rowKind === 'refund').reduce((sum, row) => sum + row.amountCents, 0);
  const adjustCents = rows.filter((row) => row.rowKind === 'adjust').reduce((sum, row) => sum + row.amountCents, 0);
  const offset = Number(query?.offset ?? 0);
  const limit = Number(query?.limit ?? 200);
  return {
    rows: rows.slice(offset, offset + limit),
    totals: { receivedCents, refundCents, adjustCents, netCents: kind === 'refund' ? -refundCents : receivedCents + adjustCents },
    count: rows.length,
    available: true, message: null,
  };
}

function dailyResponse(query: any) {
  const feeCodes = String(query?.feeCodes ?? '').split(',').filter(Boolean);
  const columns = FEE_ITEMS.filter((fee) => !feeCodes.length || feeCodes.includes(fee.code))
    .map((fee) => ({ code: fee.code, name: fee.name }));
  const events = collectionDetailResponse({ ...query, kind: 'all', limit: 1000, offset: 0 }).rows;
  const received = events.filter((row) => row.rowKind === 'received' && row.paidDate);
  const dates = [...new Set(events.map((row) => String(row.rowKind === 'refund' ? row.refundDate : row.paidDate)))].sort();
  const rows = dates.map((date) => {
    const cells: Record<string, number> = {};
    for (const column of columns) {
      cells[column.code] = received
        .filter((row) => row.paidDate === date && row.feeCode === column.code)
        .reduce((sum, row) => sum + row.amountCents, 0);
    }
    return {
      date, cells, totalCents: columns.reduce((sum, column) => sum + cells[column.code], 0),
      refundCents: events.filter((row) => row.rowKind === 'refund' && row.refundDate === date).reduce((sum, row) => sum + row.amountCents, 0),
      adjustCents: events.filter((row) => row.rowKind === 'adjust' && row.paidDate === date).reduce((sum, row) => sum + row.amountCents, 0),
    };
  });
  const subtotalCells = Object.fromEntries(columns.map((column) => [
    column.code, rows.reduce((sum, row) => sum + Number(row.cells[column.code] ?? 0), 0),
  ]));
  return {
    columns, rows,
    subtotal: { cells: subtotalCells, totalCents: rows.reduce((sum, row) => sum + row.totalCents, 0) },
    refundTotalCents: rows.reduce((sum, row) => sum + row.refundCents, 0),
    adjustTotalCents: rows.reduce((sum, row) => sum + row.adjustCents, 0),
    dataAsOf: OPTIONS.dataAsOf, available: true, message: null,
  };
}

// P2-C 欠收与溢收：按管理处汇总（数字与 docs §4.10 实测同量级）。
const ARREARS_PREPAID_OFFICES = [
  { officeCode: '01', officeName: '枫桦景苑一期', arrearsCents: 87340540, arrearsRows: 3705, prepaidCents: 36416380, prepaidRows: 2402 },
  { officeCode: '02', officeName: '枫桦景苑二期A', arrearsCents: 70235030, arrearsRows: 3394, prepaidCents: 33252430, prepaidRows: 2241 },
  { officeCode: '03', officeName: '枫桦景苑二期B', arrearsCents: 95436170, arrearsRows: 4082, prepaidCents: 33911360, prepaidRows: 2349 },
  { officeCode: '04', officeName: '上海新家', arrearsCents: 35608500, arrearsRows: 428, prepaidCents: 57957200, prepaidRows: 654 },
];

function arrearsPrepaidSummaryResponse() {
  const total = ARREARS_PREPAID_OFFICES.reduce((sum, row) => ({
    arrearsCents: sum.arrearsCents + row.arrearsCents,
    arrearsRows: sum.arrearsRows + row.arrearsRows,
    prepaidCents: sum.prepaidCents + row.prepaidCents,
    prepaidRows: sum.prepaidRows + row.prepaidRows,
  }), { arrearsCents: 0, arrearsRows: 0, prepaidCents: 0, prepaidRows: 0 });
  return { rows: ARREARS_PREPAID_OFFICES, total, dataAsOf: OPTIONS.dataAsOf, available: true, message: null };
}

const ARREARS_ROWS = [
  { sId: 1, address: '永德路228弄3号402', ownerName: '朱全锋', areaSqm: 88.5, feeCode: '04', feeName: '泊位费', natureCode: '06', periodFrom: '201404', periodTo: '202011', months: 16, amountCents: 1582500 },
  { sId: 2, address: '宝秀路701号701', ownerName: '陆乾一', areaSqm: 630.98, feeCode: '01', feeName: '管理费', natureCode: '04', periodFrom: '202601', periodTo: '202610', months: 10, amountCents: 1514300 },
  { sId: 3, address: '宝秀路723-725号723-725', ownerName: '杨凤林', areaSqm: 344.37, feeCode: '01', feeName: '管理费', natureCode: '04', periodFrom: '202601', periodTo: '202610', months: 10, amountCents: 826400 },
];
const PREPAID_ROWS = [
  { sId: 11, address: '永德路228弄33号1202', ownerName: '邹庆萍', areaSqm: 126.5, feeCode: '01', feeName: '管理费', natureCode: '01', periodFrom: '202611', periodTo: '202712', months: 14, amountCents: 523180 },
  { sId: 12, address: '永德路228弄1号103', ownerName: '王晶', areaSqm: 98.2, feeCode: '04', feeName: '泊位费', natureCode: '06', periodFrom: '202611', periodTo: '202710', months: 12, amountCents: 330000 },
];

function arrearsPrepaidDetailResponse(query: any) {
  const tab = query?.tab === 'prepaid' ? 'prepaid' : 'arrears';
  const rows = tab === 'prepaid' ? PREPAID_ROWS : ARREARS_ROWS;
  const totals = { amountCents: rows.reduce((sum, row) => sum + row.amountCents, 0), rows: rows.length };
  return {
    rows, totals, count: rows.length,
    dataAsOf: OPTIONS.dataAsOf, available: true, message: null,
  };
}

function arrearsBillsResponse(query: any) {
  const target = Number(query?.sId) === 2 ? 1514300 : 1582500;
  const rows = [
    { zjId: 1, period: '201404', amountCents: 500000, paidDate: null, refundDate: null },
    { zjId: 2, period: '201405', amountCents: 500000, paidDate: null, refundDate: null },
    { zjId: 3, period: '202011', amountCents: target - 1000000, paidDate: null, refundDate: null },
  ];
  return { rows, totalCents: rows.reduce((sum, row) => sum + row.amountCents, 0), available: true, message: null };
}

// P2-C 收缴考核：3 户 × 12 个月；合计/收缴率用于指标卡断言。
const ASSESSMENT_ROWS = [
  {
    officeCode: '02', officeName: '枫桦景苑二期A', sId: 21, address: '宝秀路701号701', ownerName: '陆乾一', areaSqm: 630.98,
    months: Array.from({ length: 12 }, (_, index) => ({
      month: index + 1,
      receivableCents: index === 0 ? 1000000 : index === 1 ? 100000 : index === 9 ? 1072160 : 0,
      receivedCents: index === 0 ? 1900000 : index === 1 ? 50000 : 0,
    })),
    totalReceivableCents: 2172160, totalReceivedCents: 1950000, ratePct: 89.77,
  },
  {
    officeCode: '02', officeName: '枫桦景苑二期A', sId: 22, address: '宝秀路723-725号723-725', ownerName: '杨凤林', areaSqm: 344.37,
    months: Array.from({ length: 12 }, (_, index) => ({
      month: index + 1,
      receivableCents: index === 0 ? 500000 : 0,
      receivedCents: index === 0 ? 500000 : 0,
    })),
    totalReceivableCents: 500000, totalReceivedCents: 500000, ratePct: 100,
  },
  {
    officeCode: '04', officeName: '上海新家', sId: 23, address: '上海新家1号101', ownerName: '合成业主', areaSqm: 90,
    months: Array.from({ length: 12 }, (_, index) => ({
      month: index + 1,
      receivableCents: index === 0 ? 428400 : index === 1 ? 100000 : 0,
      receivedCents: index === 1 ? 120000 : 0,
    })),
    totalReceivableCents: 528400, totalReceivedCents: 120000, ratePct: 22.71,
  },
];

function assessmentResponse() {
  const receivableCents = ASSESSMENT_ROWS.reduce((sum, row) => sum + row.totalReceivableCents, 0);
  const receivedCents = ASSESSMENT_ROWS.reduce((sum, row) => sum + row.totalReceivedCents, 0);
  return {
    rows: ASSESSMENT_ROWS,
    summary: {
      receivableCents, receivedCents,
      ratePct: Number(((receivedCents / receivableCents) * 100).toFixed(2)),
      payableHouseholds: 3, paidHouseholds: 3,
      householdRatePct: 100,
    },
    count: ASSESSMENT_ROWS.length, dataAsOf: OPTIONS.dataAsOf, available: true, message: null,
  };
}

// P2-D 收款分析（按户）：数值取自 docs §4.8 实测样例。
const ANALYSIS_ROWS = [
  { sId: 201, officeCode: '02', officeName: '枫桦景苑二期A', address: '宝秀路701号701', ownerName: '陆乾一', areaSqm: 630.98, historyArrearsCents: 0, currentYearArrearsCents: 1514300, currentMonthReceivableCents: 166430, prepaidCents: 90000, periodReceivedCents: 15000 },
  { sId: 202, officeCode: '02', officeName: '枫桦景苑二期A', address: '宝秀路723-725号723-725', ownerName: '杨凤林', areaSqm: 344.37, historyArrearsCents: 0, currentYearArrearsCents: 826400, currentMonthReceivableCents: 82640, prepaidCents: 0, periodReceivedCents: 0 },
  { sId: 203, officeCode: '02', officeName: '枫桦景苑二期A', address: '永德路228弄31号1101', ownerName: '邱解平', areaSqm: 120.4, historyArrearsCents: 250000, currentYearArrearsCents: 374000, currentMonthReceivableCents: 44150, prepaidCents: 13500, periodReceivedCents: 0 },
];

function collectionAnalysisResponse(query: any) {
  const sort = String(query?.sort ?? 'currentArrears');
  const rows = [...ANALYSIS_ROWS];
  if (sort === 'historyArrears') rows.sort((a, b) => b.historyArrearsCents - a.historyArrearsCents);
  else if (sort === 'address') rows.sort((a, b) => String(a.address).localeCompare(String(b.address), 'zh-CN'));
  else rows.sort((a, b) => b.currentYearArrearsCents - a.currentYearArrearsCents);
  const totals = rows.reduce((sum, row) => ({
    historyArrearsCents: sum.historyArrearsCents + row.historyArrearsCents,
    currentYearArrearsCents: sum.currentYearArrearsCents + row.currentYearArrearsCents,
    currentMonthReceivableCents: sum.currentMonthReceivableCents + row.currentMonthReceivableCents,
    prepaidCents: sum.prepaidCents + row.prepaidCents,
    periodReceivedCents: sum.periodReceivedCents + row.periodReceivedCents,
  }), { historyArrearsCents: 0, currentYearArrearsCents: 0, currentMonthReceivableCents: 0, prepaidCents: 0, periodReceivedCents: 0 });
  return { rows, totals, count: rows.length, dataAsOf: OPTIONS.dataAsOf, available: true, message: null };
}

function collectionAnalysisDetailResponse(query: any) {
  const sId = Number(query?.sId ?? 201);
  const rows = [
    { zjId: sId * 10 + 1, period: '202601', amountCents: 1514300, paidDate: null, refundDate: null, paymentMethod: null, cashier: null, feeCode: '01', feeName: '管理费', natureCode: '04', rowKind: 'unpaid' },
    { zjId: sId * 10 + 2, period: '202611', amountCents: 90000, paidDate: '2026-11-02', refundDate: null, paymentMethod: '微信', cashier: '合成收费员', feeCode: '01', feeName: '管理费', natureCode: '04', rowKind: 'received' },
    { zjId: sId * 10 + 3, period: '202611', amountCents: 15000, paidDate: null, refundDate: '2026-11-03', paymentMethod: '现金', cashier: '合成收费员', feeCode: '04', feeName: '泊位费', natureCode: '06', rowKind: 'refund' },
  ];
  // Dedicated paginated households keep the existing formal-entry fixture intact.
  if (sId >= 900) {
    const unpaid = rows.shift()!;
    rows.unshift(...Array.from({ length: 201 }, (_, i) => ({ ...unpaid, zjId: sId * 1000 + i, feeName: `目标${sId}`, amountCents: i === 200 ? 14300 : 7500 })));
    rows.push({ ...rows[0], zjId: sId * 1000 + 999, rowKind: 'adjust', amountCents: -5000 });
  }
  const totals = {
    receivedCents: 90000, refundCents: 15000, adjustCents: -5000, unpaidCents: 1514300, amountCents: 1584300, rows: rows.length,
  };
  const offset = Number(query?.offset ?? 0);
  return { rows: rows.slice(offset, offset + Number(query?.limit ?? 200)), totals, count: rows.length, available: true, message: null };
}

// P2-D 收费月报表（核心指标）：11 项核心指标 + 合计，其余列 pendingColumns。
const MONTHLY_ROWS = [
  { key: '01', label: '枫桦景苑一期', monthReceivableCents: 14590330, monthAdjustCents: -75000, cumulativeReceivableCents: 2478340466, oldArrearsReceivableCents: 33865830, totalReceivableCents: 2512206296, monthReceivedCents: 15246910, prepaidInCents: 7210960, prepaidBalanceCents: 33437560, monthArrearsCents: 5560990, cumulativeArrearsCents: 87340540, recoveryRatePct: 0.61 },
  { key: '02', label: '枫桦景苑二期A', monthReceivableCents: 15213860, monthAdjustCents: -110000, cumulativeReceivableCents: 2899940950, oldArrearsReceivableCents: 9921090, totalReceivableCents: 2909862040, monthReceivedCents: 15314220, prepaidInCents: 7054720, prepaidBalanceCents: 29882290, monthArrearsCents: 6202090, cumulativeArrearsCents: 70235030, recoveryRatePct: 0.53 },
  { key: '03', label: '枫桦景苑二期B', monthReceivableCents: 18547350, monthAdjustCents: -47770, cumulativeReceivableCents: 3559990790, oldArrearsReceivableCents: 7424950, totalReceivableCents: 3567415740, monthReceivedCents: 16243810, prepaidInCents: 7390860, prepaidBalanceCents: 29562020, monthArrearsCents: 8973510, cumulativeArrearsCents: 95436170, recoveryRatePct: 0.46 },
  { key: '04', label: '上海新家', monthReceivableCents: 63820600, monthAdjustCents: -598600, cumulativeReceivableCents: 6733135600, oldArrearsReceivableCents: 3093000, totalReceivableCents: 6736228600, monthReceivedCents: 46508500, prepaidInCents: 11168600, prepaidBalanceCents: 48066200, monthArrearsCents: 32251900, cumulativeArrearsCents: 35608500, recoveryRatePct: 0.69 },
];

function monthlyReportResponse() {
  const fields = ['monthReceivableCents', 'monthAdjustCents', 'cumulativeReceivableCents', 'oldArrearsReceivableCents', 'totalReceivableCents', 'monthReceivedCents', 'prepaidInCents', 'prepaidBalanceCents', 'monthArrearsCents', 'cumulativeArrearsCents'] as const;
  const totals: Record<string, number> = {};
  for (const field of fields) totals[field] = MONTHLY_ROWS.reduce((sum, row) => sum + Number(row[field]), 0);
  totals.recoveryRatePct = Number(((Number(totals.monthReceivedCents) / Number(totals.totalReceivableCents)) * 100).toFixed(2));
  return {
    rows: MONTHLY_ROWS, totals,
    pendingColumns: ['本期实收分项', '累计实收', '账面累计实收'],
    dataAsOf: OPTIONS.dataAsOf, available: true, message: null,
  };
}

// P3-A 房产汇总 / 住户台账 / 楼房台账。
const PROPERTY_ROWS = [
  { officeCode: '01', officeName: '枫桦景苑一期', buildingCount: 12, roomCount: 480, ownerCount: 456, totalAreaSqm: 52340.5, natureCounts: { '01': 300, '06': 40, '07': 140 } },
  { officeCode: '02', officeName: '枫桦景苑二期A', buildingCount: 8, roomCount: 320, ownerCount: 300, totalAreaSqm: 40120.25, natureCounts: { '01': 220, '06': 60, '07': 40 } },
  { officeCode: '03', officeName: '枫桦景苑二期B', buildingCount: 6, roomCount: 240, ownerCount: 230, totalAreaSqm: 31200, natureCounts: { '01': 180, '06': 30, '07': 30 } },
  { officeCode: '04', officeName: '上海新家', buildingCount: 4, roomCount: 180, ownerCount: 175, totalAreaSqm: 26800, natureCounts: { '01': 120, '06': 35, '07': 25 } },
];

function propertySummaryResponse() {
  const total = PROPERTY_ROWS.reduce((sum, row) => ({
    buildingCount: sum.buildingCount + row.buildingCount,
    roomCount: sum.roomCount + row.roomCount,
    ownerCount: sum.ownerCount + row.ownerCount,
    totalAreaSqm: sum.totalAreaSqm + row.totalAreaSqm,
    natureCounts: Object.fromEntries(NATURES.map((nature) => [nature.code, (sum.natureCounts[nature.code] ?? 0) + (row.natureCounts[nature.code] ?? 0)])),
  }), { buildingCount: 0, roomCount: 0, ownerCount: 0, totalAreaSqm: 0, natureCounts: {} as Record<string, number> });
  return { rows: PROPERTY_ROWS, total, natures: NATURES, dataAsOf: OPTIONS.dataAsOf, available: true, message: null };
}

function ownerLedgerRows() {
  // 201 户：第一行手机/电话为空，用于断言「—」；第 201 行用于加载更多。
  return Array.from({ length: 201 }, (_, index) => ({
    sId: 9001 + index,
    officeCode: index % 2 === 0 ? '01' : '02',
    officeName: index % 2 === 0 ? '枫桦景苑一期' : '枫桦景苑二期A',
    address: `宝秀路${700 + index}号${101 + index}室`,
    road: '宝秀路',
    lane: '228弄',
    buildingNo: String((index % 6) + 1),
    roomNo: `${101 + index}`,
    natureCode: index % 3 === 0 ? '06' : '01',
    natureName: index % 3 === 0 ? '空房' : '商品房',
    areaSqm: 60 + (index % 80),
    ownerName: index === 0 ? null : `合成业主${index + 1}`,
    mobile: index === 0 ? null : `1380000${String(index).padStart(4, '0')}`,
    phone2: index === 0 ? null : `021-6000${String(index).padStart(4, '0')}`,
  }));
}
const OWNER_LEDGER_ALL = ownerLedgerRows();

function ownerLedgerResponse(query: any) {
  const keyword = String(query?.keyword ?? '').trim();
  const filtered = keyword
    ? OWNER_LEDGER_ALL.filter((row) => [row.address, row.roomNo, row.ownerName, row.mobile, row.phone2].some((value) => String(value ?? '').includes(keyword)))
    : OWNER_LEDGER_ALL;
  const offset = Number(query?.offset ?? 0);
  const limit = Number(query?.limit ?? 200);
  return {
    rows: filtered.slice(offset, offset + limit),
    count: filtered.length,
    totals: { roomCount: filtered.length, areaSqm: filtered.reduce((sum, row) => sum + Number(row.areaSqm), 0) },
    dataAsOf: OPTIONS.dataAsOf, available: true, message: null,
  };
}

const BUILDING_ROWS = [
  { lId: 101, officeCode: '01', officeName: '枫桦景苑一期', road: '宝秀路', lane: '228弄', buildingNo: '6', roomCount: 48, ownerCount: 45, areaSqm: 4800.5 },
  { lId: 102, officeCode: '01', officeName: '枫桦景苑一期', road: '宝秀路', lane: '228弄', buildingNo: '7', roomCount: 40, ownerCount: 38, areaSqm: 4000 },
  { lId: 103, officeCode: '02', officeName: '枫桦景苑二期A', road: '永德路', lane: '229弄', buildingNo: '3', roomCount: 52, ownerCount: 50, areaSqm: 5200.25 },
];

function buildingLedgerResponse(query: any) {
  const keyword = String(query?.keyword ?? '').trim();
  const filtered = keyword
    ? BUILDING_ROWS.filter((row) => [row.road, row.lane, row.buildingNo].some((value) => String(value ?? '').includes(keyword)))
    : BUILDING_ROWS;
  const offset = Number(query?.offset ?? 0);
  const limit = Number(query?.limit ?? 200);
  return {
    rows: filtered.slice(offset, offset + limit),
    count: filtered.length,
    totals: {
      buildingCount: filtered.length,
      roomCount: filtered.reduce((sum, row) => sum + row.roomCount, 0),
      ownerCount: filtered.reduce((sum, row) => sum + row.ownerCount, 0),
      areaSqm: filtered.reduce((sum, row) => sum + row.areaSqm, 0),
    },
    dataAsOf: OPTIONS.dataAsOf, available: true, message: null,
  };
}

// P4-A 减免情况 / 签报情况。
const RELIEF_ROWS = [
  { id: 1, docNo: 'JM202603001', officeCode: '01', officeName: '枫桦景苑一期', zhId: 1001, address: '宝秀路701号701', ownerName: '陆乾一', feeCode: '01', feeName: '管理费', oldReceivableCents: 1200000, receivableCents: 960000, reliefCents: 240000, reliefStartDate: '2026-03-01', reliefEndDate: '2026-03-31', reliefDate: '2026-03-05', method: '减免单' },
  { id: 2, docNo: 'JM202604002', officeCode: '02', officeName: '枫桦景苑二期A', zhId: 1002, address: '宝秀路723-725号723-725', ownerName: '杨凤林', feeCode: '04', feeName: '泊位费', oldReceivableCents: 900000, receivableCents: 600000, reliefCents: 300000, reliefStartDate: '2026-04-01', reliefEndDate: '2026-04-30', reliefDate: '2026-04-08', method: '减免单' },
  { id: 3, docNo: 'JM202605003', officeCode: '01', officeName: '枫桦景苑一期', zhId: 1003, address: '永德路228弄31号1101', ownerName: '邱解平', feeCode: '01', feeName: '管理费', oldReceivableCents: 500000, receivableCents: 450000, reliefCents: 50000, reliefStartDate: '2026-05-01', reliefEndDate: '2026-05-31', reliefDate: '2026-05-06', method: '减免单' },
];

function reliefResponse(query: any) {
  const keyword = String(query?.keyword ?? '').trim();
  const dateFrom = String(query?.dateFrom ?? '');
  const dateTo = String(query?.dateTo ?? '');
  const filtered = RELIEF_ROWS.filter((row) => {
    if (keyword && ![row.docNo, row.address, row.ownerName, row.feeName].some((value) => String(value ?? '').includes(keyword))) return false;
    if (dateFrom && String(row.reliefDate) < dateFrom) return false;
    if (dateTo && String(row.reliefDate) > dateTo) return false;
    return true;
  });
  const totals = filtered.reduce((sum, row) => ({
    count: sum.count + 1,
    oldReceivableCents: sum.oldReceivableCents + row.oldReceivableCents,
    receivableCents: sum.receivableCents + row.receivableCents,
    reliefCents: sum.reliefCents + row.reliefCents,
  }), { count: 0, oldReceivableCents: 0, receivableCents: 0, reliefCents: 0 });
  return { rows: filtered, totals, count: filtered.length, limit: 200, offset: 0, dataAsOf: OPTIONS.dataAsOf, available: true, message: null };
}

const SIGNOFF_ROWS = [
  { id: 1, docNo: 'QB202603001', title: '管理费减免签报', type: '减免签报', detail: '因漏水减免一个月', officeCode: '01', officeName: '枫桦景苑一期', zhId: 1001, address: '宝秀路701号701', ownerName: '陆乾一', draftDate: '2026-03-02', approveDate: '2026-03-04', result: '同意', voided: false, ended: true, adjustAmountCents: -240000, feeCode: '01' },
  { id: 2, docNo: 'QB202604002', title: '泊位费调整签报', type: '租金调整', detail: '车位划线调整', officeCode: '02', officeName: '枫桦景苑二期A', zhId: 1002, address: '宝秀路723-725号723-725', ownerName: '杨凤林', draftDate: '2026-04-03', approveDate: '2026-04-06', result: '不同意', voided: true, ended: true, adjustAmountCents: 0, feeCode: '04' },
  { id: 3, docNo: 'QB202605003', title: '空房租金减免签报', type: '减免签报', detail: '空置期减免', officeCode: '01', officeName: '枫桦景苑一期', zhId: 1003, address: '永德路228弄31号1101', ownerName: '邱解平', draftDate: '2026-05-04', approveDate: null, result: '审批中', voided: false, ended: false, adjustAmountCents: -50000, feeCode: '15' },
];

function signoffsResponse(query: any) {
  const keyword = String(query?.keyword ?? '').trim();
  const status = String(query?.status ?? 'all');
  const types = String(query?.types ?? '').split(',').filter(Boolean);
  const dateFrom = String(query?.dateFrom ?? '');
  const dateTo = String(query?.dateTo ?? '');
  const filtered = SIGNOFF_ROWS.filter((row) => {
    if (keyword && ![row.docNo, row.title, row.address, row.ownerName, row.result, row.type].some((value) => String(value ?? '').includes(keyword))) return false;
    if (dateFrom && String(row.draftDate) < dateFrom) return false;
    if (dateTo && String(row.draftDate) > dateTo) return false;
    if (types.length && !types.includes(String(row.type))) return false;
    if (status === 'voided') return row.voided;
    if (status === 'open') return !row.voided && !row.ended;
    if (status === 'effective') return !row.voided && row.ended;
    return true;
  });
  const totals = {
    count: filtered.length,
    voidedCount: filtered.filter((row) => row.voided).length,
    endedCount: filtered.filter((row) => row.ended).length,
    adjustAmountCents: filtered.reduce((sum, row) => sum + row.adjustAmountCents, 0),
  };
  return { rows: filtered, totals, count: filtered.length, limit: 200, offset: 0, dataAsOf: OPTIONS.dataAsOf, available: true, message: null };
}

// P2-E 收款汇总表 / 票据情况统计。
const TICKET_SUMMARY_METHODS = [
  { key: '现金', label: '现金' }, { key: '支付宝', label: '支付宝' }, { key: '微信', label: '微信' },
  { key: '银联支付', label: '银联支付' }, { key: '转账', label: '转账' },
];
const TICKET_SUMMARY_ROWS = [
  { feeCode: '01', feeName: '管理费', methods: { '现金': 500000, '微信': 300000, '支付宝': 200000 }, receivedCents: 1000000, refundCents: 0, netCents: 1000000, ticketAmountCents: 1000000, ticketTaxCents: 50000, ticketIncomeCents: 950000, ticketCount: 5, rows: 6 },
  { feeCode: '04', feeName: '泊位费', methods: { '微信': 800000, '银联支付': 400000 }, receivedCents: 1200000, refundCents: 15000, netCents: 1185000, ticketAmountCents: 1200000, ticketTaxCents: 60000, ticketIncomeCents: 1140000, ticketCount: 4, rows: 5 },
  { feeCode: '14', feeName: '停车管理费', methods: { '转账': 300000 }, receivedCents: 300000, refundCents: 0, netCents: 300000, ticketAmountCents: 300000, ticketTaxCents: 15000, ticketIncomeCents: 285000, ticketCount: 2, rows: 2 },
];

function ticketSummaryResponse() {
  const totals = {
    methods: Object.fromEntries(TICKET_SUMMARY_METHODS.map((column) => [column.key, TICKET_SUMMARY_ROWS.reduce((sum, row) => sum + Number(row.methods[column.key as keyof typeof row.methods] ?? 0), 0)])),
    receivedCents: TICKET_SUMMARY_ROWS.reduce((sum, row) => sum + row.receivedCents, 0),
    refundCents: TICKET_SUMMARY_ROWS.reduce((sum, row) => sum + row.refundCents, 0),
    netCents: TICKET_SUMMARY_ROWS.reduce((sum, row) => sum + row.netCents, 0),
    ticketAmountCents: TICKET_SUMMARY_ROWS.reduce((sum, row) => sum + row.ticketAmountCents, 0),
    ticketTaxCents: TICKET_SUMMARY_ROWS.reduce((sum, row) => sum + row.ticketTaxCents, 0),
    ticketIncomeCents: TICKET_SUMMARY_ROWS.reduce((sum, row) => sum + row.ticketIncomeCents, 0),
    ticketCount: TICKET_SUMMARY_ROWS.reduce((sum, row) => sum + row.ticketCount, 0),
    rows: TICKET_SUMMARY_ROWS.reduce((sum, row) => sum + row.rows, 0),
  };
  const cashierRows = [
    { cashier: '张收费', methods: { '现金': 500000, '微信': 1100000 }, netCents: 1600000, rows: 7 },
    { cashier: '李收费', methods: { '支付宝': 200000 }, netCents: 200000, rows: 2 },
  ];
  const cashierTotals = {
    cashier: '',
    methods: Object.fromEntries(TICKET_SUMMARY_METHODS.map((column) => [column.key, cashierRows.reduce((sum, row) => sum + Number((row.methods as Record<string, number>)[column.key] ?? 0), 0)])),
    netCents: cashierRows.reduce((sum, row) => sum + row.netCents, 0),
    rows: cashierRows.reduce((sum, row) => sum + row.rows, 0),
  };
  return {
    methodColumns: TICKET_SUMMARY_METHODS, rows: TICKET_SUMMARY_ROWS, totals, cashierRows, cashierTotals,
    dataAsOf: OPTIONS.dataAsOf, available: true, message: null,
  };
}

const TICKET_ROWS = [
  { id: 1, ticketNo: 'PJ202611001', warehouseNo: 'RK202611001', officeCode: '01', officeName: '枫桦景苑一期', issueDate: '2026-11-01', payer: '陆乾一', amountCents: 500000, taxCents: 25000, preIssue: false, receiptDate: '2026-11-01', issuer: '张收费', payee: '张收费', voidDate: null, voidReason: null, writeoffDate: null, paymentMethod: '现金', invoiceNo: 'FP001', status: 'issued' },
  { id: 2, ticketNo: 'PJ202611002', warehouseNo: 'RK202611002', officeCode: '02', officeName: '枫桦景苑二期A', issueDate: '2026-11-02', payer: '杨凤林', amountCents: 800000, taxCents: 40000, preIssue: true, receiptDate: null, issuer: '李收费', payee: '李收费', voidDate: null, voidReason: null, writeoffDate: null, paymentMethod: '微信', invoiceNo: null, status: 'pre_issue' },
  { id: 3, ticketNo: 'PJ202610009', warehouseNo: 'RK202610009', officeCode: '01', officeName: '枫桦景苑一期', issueDate: '2026-10-20', payer: '邱解平', amountCents: 300000, taxCents: 15000, preIssue: false, receiptDate: '2026-10-20', issuer: '张收费', payee: '张收费', voidDate: '2026-10-21', voidReason: '开错', writeoffDate: null, paymentMethod: '现金', invoiceNo: 'FP002', status: 'voided' },
  { id: 4, ticketNo: 'PJ202609005', warehouseNo: 'RK202609005', officeCode: '02', officeName: '枫桦景苑二期A', issueDate: '2026-09-15', payer: '合成业主', amountCents: 600000, taxCents: 30000, preIssue: false, receiptDate: '2026-09-15', issuer: '李收费', payee: '李收费', voidDate: null, voidReason: null, writeoffDate: '2026-09-20', paymentMethod: '转账', invoiceNo: 'FP003', status: 'written_off' },
];

function ticketListResponse(query: any) {
  const keyword = String(query?.keyword ?? '').trim();
  const status = String(query?.status ?? 'all');
  const dateFrom = String(query?.dateFrom ?? '');
  const dateTo = String(query?.dateTo ?? '');
  const rows = TICKET_ROWS.filter((row) => {
    if (status !== 'all' && row.status !== status) return false;
    if (keyword && ![row.ticketNo, row.warehouseNo, row.payer, row.invoiceNo].some((value) => String(value ?? '').includes(keyword))) return false;
    if (dateFrom && String(row.issueDate) < dateFrom) return false;
    if (dateTo && String(row.issueDate) > dateTo) return false;
    return true;
  });
  return {
    rows,
    totals: {
      count: rows.length,
      amountCents: rows.reduce((sum, row) => sum + row.amountCents, 0),
      taxCents: rows.reduce((sum, row) => sum + row.taxCents, 0),
      voidedCount: rows.filter((row) => row.status === 'voided').length,
      preIssueCount: rows.filter((row) => row.status === 'pre_issue').length,
      writtenOffCount: rows.filter((row) => row.status === 'written_off').length,
    },
    statusCounts: Object.fromEntries(['issued', 'pre_issue', 'voided', 'written_off'].map((key) => [key, TICKET_ROWS.filter((row) => row.status === key).length])),
    count: rows.length, limit: 200, offset: 0, dataAsOf: OPTIONS.dataAsOf, available: true, message: null,
  };
}

// One-shot outcomes are captured on dispatch. Tests release a named request,
// never sleep hoping a race happened; unexpected URLs still fail closed below.
export async function request<T>(options: any): Promise<T> {
  w.__calls.push({ url: options.url, method: options.method ?? 'GET', query: options.query ?? null, at: Date.now() });
  const index = w.__requestPlans.findIndex((p: any) => p.url === options.url && (p.offset == null || p.offset === Number(options.query?.offset ?? 0)));
  const plan = index < 0 ? null : w.__requestPlans.splice(index, 1)[0];
  try {
    if (plan?.hold) await new Promise<void>((release) => w.__pendingRequests.push({ id: plan.id, release }));
    if (plan?.fail) throw Error('逐笔请求失败（合成）');
    if (plan?.unavailable) return { rows: [], totals: null, totalCents: null, count: null, available: false, message: '逐笔数据尚未同步（合成）' } as T;
    const result = await requestFixture<any>(options);
    return (plan?.unknown ? { ...result, totals: null, totalCents: null, count: null } : result) as T;
  } finally {
    if (plan?.id) w.__finishedRequests.push(plan.id);
  }
}

async function requestFixture<T>(options: any): Promise<T> {
  await pause(20);

  if (options.url === '/statistics/options') {
    if (w.__optionsUnavailable) {
      return { ...OPTIONS, available: false, message: 'MIS 镜像尚未完成首次同步（合成）' } as T;
    }
    return OPTIONS as T;
  }

  if (options.url === '/statistics/annual') {
    if (w.__annualFail) throw Error('统计读取失败：MIS 镜像暂不可用（合成）');
    const type = options.query?.type === 'arrears' ? 'arrears' : 'received';
    if (w.__annualUnavailable) {
      return {
        type, columns: [], rows: [], subtotal: null, dataAsOf: OPTIONS.dataAsOf,
        available: false, message: 'MIS 镜像本期未同步（合成）',
      } as T;
    }
    const officeCodes = String(options.query?.officeCodes ?? '').split(',').filter(Boolean);
    const yearFrom = Number(options.query?.yearFrom ?? OPTIONS.yearRange.min);
    const yearTo = Number(options.query?.yearTo ?? OPTIONS.yearRange.max);
    return annualResponse(type, officeCodes, yearFrom, yearTo) as T;
  }

  if (options.url === '/statistics/annual/detail') {
    if (w.__detailFail) throw Error('房屋明细读取失败（合成）');
    const officeCode = String(options.query?.officeCode ?? '');
    const year = Number(options.query?.year ?? 0);
    const type = options.query?.type === 'arrears' ? 'arrears' : 'received';
    if (type === 'received') {
      // P1.3：实收下钻直接是逐笔清单（detailKind:'received'），合计必须等于单元格。
      const rows = officeCode === '01' && year === 2004
        ? received2004Rows()
        : [{
          zjId: 9000 + year, sId: 900, address: `合成地址 ${officeCode} ${year}`, ownerName: '合成业主',
          areaSqm: 88.8, period: `${year}06`, amountCents: receivedCellCents(officeCode, year) || 10000,
          paidDate: `${year}-06-15`, refundDate: null, paymentMethod: '现金', cashier: '合成收费员',
          receiptNo: null, invoiceNo: null,
        }];
      const totalCents = rows.reduce((sum, row) => sum + row.amountCents, 0);
      return { detailKind: 'received', rows, totalCents, count: rows.length, available: true, message: null } as T;
    }
    const rows = officeCode === '02' && year === 2014
      ? [{
        sId: 719, address: '宝秀路719号719', ownerName: '合成业主', areaSqm: 79.67,
        periodRange: '201410-201412',
        amountCents: 47790,
      }]
      : [{
        sId: Number(`${officeCode || 9}${year}`), address: `合成地址 ${officeCode} ${year}`, ownerName: '合成业主',
        areaSqm: 88.8, periodRange: `${year}01-${year}12`, amountCents: 10000,
      }];
    const totalCents = rows.reduce((sum, row) => sum + row.amountCents, 0);
    return { detailKind: 'arrears', rows, totalCents, available: true, message: null } as T;
  }

  if (options.url === '/statistics/annual/detail/bills') {
    if (w.__billsFail) throw Error('逐笔账单读取失败（合成）');
    const rows = ['202410', '202411', '202412'].map((period, index) => ({
      zjId: index + 1, feeCode: '01', feeName: '管理费', period, amountCents: 15930,
      paidDate: null, refundDate: null, paymentMethod: null, cashier: null,
    }));
    return { rows, totalCents: 47790 } as T;
  }

  if (options.url === '/statistics/collection/fee-nature') {
    return feeNatureResponse(options.query) as T;
  }

  if (options.url === '/statistics/collection/detail') {
    return collectionDetailResponse(options.query) as T;
  }

  if (options.url === '/statistics/daily') {
    if (w.__dailyDelay) await pause(w.__dailyDelay);
    if (w.__dailyFail) throw Error('日报表读取失败（合成）');
    if (w.__dailyUnavailable) return { columns: [], rows: [], subtotal: null, refundTotalCents: null, adjustTotalCents: null, available: false, message: '日报镜像尚未完成首次同步（合成）' } as T;
    return dailyResponse(options.query) as T;
  }

  if (options.url === '/statistics/arrears-prepaid/summary') {
    return arrearsPrepaidSummaryResponse() as T;
  }

  if (options.url === '/statistics/arrears-prepaid/detail') {
    return arrearsPrepaidDetailResponse(options.query) as T;
  }

  if (options.url === '/statistics/arrears-prepaid/detail/bills') {
    return arrearsBillsResponse(options.query) as T;
  }

  if (options.url === '/statistics/collection-assessment') {
    return assessmentResponse() as T;
  }

  if (options.url === '/statistics/collection-analysis') {
    return collectionAnalysisResponse(options.query) as T;
  }

  if (options.url === '/statistics/collection-analysis/detail') {
    return collectionAnalysisDetailResponse(options.query) as T;
  }

  if (options.url === '/statistics/monthly-report') {
    return monthlyReportResponse() as T;
  }

  if (options.url === '/statistics/property-summary') {
    return propertySummaryResponse() as T;
  }

  if (options.url === '/statistics/owner-ledger') {
    return ownerLedgerResponse(options.query) as T;
  }

  if (options.url === '/statistics/building-ledger') {
    return buildingLedgerResponse(options.query) as T;
  }

  if (options.url === '/statistics/relief') {
    return reliefResponse(options.query) as T;
  }

  if (options.url === '/statistics/signoffs') {
    return signoffsResponse(options.query) as T;
  }

  if (options.url === '/statistics/ticket-summary') {
    return ticketSummaryResponse() as T;
  }

  if (options.url === '/statistics/ticket-items/summary' || options.url === '/statistics/ticket-items/detail' || /^\/statistics\/tickets\/\d+\/items$/.test(options.url)) {
    if (w.__ticketDelay) await pause(w.__ticketDelay);
    if (w.__ticketFail) throw Error('合成开票接口读取失败');
    if (w.__ticketUnavailable) return { available: false, rows: [], totals: null, count: null, coverage: null, message: '开票镜像尚未同步，不可视为零' } as T;
    return ticketItemsResponse(options.url, options.query ?? {}) as T;
  }

  if (options.url === '/statistics/tickets') {
    return ticketListResponse(options.query) as T;
  }

  throw Error('Unhandled synthetic request ' + String(options.url));
}

// Synthetic item rows: 2 distinct tickets span 2 fee groups; totals must not sum group ticket counts.
function ticketItemsResponse(url: string, query: Record<string, any>) {
  const data = Array.from({ length: 201 }, (_, index) => {
    const ticketId = index === 200 ? 1 : index % 2 + 1;
    return { itemId: index + 1, ticketId, ticketNo: `SYN-${ticketId}`, warehouseNo: '=unsafe', invoiceNo: 'INV-1',
      officeCode: ticketId === 1 ? '01' : '02', officeName: ticketId === 1 ? '枫桦景苑一期' : '枫桦景苑二期A',
      issueDate: ticketId === 1 ? '2022-11-25' : '2023-12-23', feeCode: index === 200 ? '04' : '01',
      feeName: index === 200 ? '泊位费' : '管理费', itemName: index === 0 ? '=HYPERLINK("https://invalid")' : '合成开票项目', project: '仅测试',
      amountCents: index === 200 ? -100 : 100, taxCents: 0, incomeCents: index === 200 ? -100 : 100 };
  });
  const totals = (rows: typeof data) => ({ ticketCount: new Set(rows.map(r => r.ticketId)).size, itemCount: rows.length,
    amountCents: rows.reduce((s, r) => s + r.amountCents, 0), taxCents: 0, incomeCents: rows.reduce((s, r) => s + r.incomeCents, 0) });
  const exactId = url.match(/\/tickets\/(\d+)\/items$/)?.[1];
  const scoped = data.filter(r => (!query.officeCodes || String(query.officeCodes).split(',').includes(r.officeCode))
    && (!query.feeCodes || String(query.feeCodes).split(',').includes(r.feeCode)) && (!exactId || r.ticketId === Number(exactId)));
  const dates = scoped.map(r => r.issueDate).sort();
  const coverage = { ...totals(scoped), dateFrom: dates[0] ?? null, dateTo: dates.at(-1) ?? null,
    nonzeroTaxItemCount: 0, unknownTaxItemCount: w.__ticketUnknownTax ? 1 : 0 };
  const filtered = scoped.filter(r => (!query.dateFrom || r.issueDate >= query.dateFrom) && (!query.dateTo || r.issueDate <= query.dateTo)
    && (!query.ticketNo || r.ticketNo === query.ticketNo) && (!query.keyword || `${r.ticketNo} ${r.warehouseNo} ${r.itemName} ${r.feeCode} ${r.invoiceNo}`.toLowerCase().includes(query.keyword.toLowerCase())));
  const base = { available: true, totals: totals(filtered), coverage, dataAsOf: w.__ticketPageChanged && Number(query.offset) > 0 ? '2026-11-10T03:01:00Z' : '2026-11-10T03:00:00Z' };
  if (url.endsWith('/summary')) {
    const groupBy = query.groupBy || 'fee';
    const groups = new Map<string, typeof data>();
    for (const row of filtered) { const key = groupBy === 'fee' ? row.feeCode : groupBy === 'office' ? row.officeCode : row.issueDate; groups.set(key, [...(groups.get(key) ?? []), row]); }
    return { ...base, groupBy, rows: [...groups].map(([key, rows]) => ({ key, label: groupBy === 'fee' ? rows[0].feeName : groupBy === 'office' ? rows[0].officeName : key, ...totals(rows) })) };
  }
  return { ...base, count: filtered.length, rows: exactId ? filtered : filtered.slice(Number(query.offset ?? 0), Number(query.offset ?? 0) + Number(query.limit ?? 200)),
    ticket: exactId ? { id: Number(exactId), ticketNo: `SYN-${exactId}`, payer: '合成付款人', address: '测试地址', issueDate: filtered[0]?.issueDate, officeName: filtered[0]?.officeName } : undefined };
}

// 统计页只用到 request；其余导出仅为兼容可能的公共模块静态导入。
export const configure = () => undefined;
export const auth = { me: async () => ({}), getToken: () => undefined };
export const notifications = { unreadCount: async () => ({ count: 0 }) };
export const address = { tree: async () => [] };
export const accessCardIssuance = { readiness: async () => ({}) };
