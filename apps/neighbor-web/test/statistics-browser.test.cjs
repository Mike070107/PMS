const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const { createRequire } = require('node:module');
const ts = require('typescript');

const app = path.resolve(__dirname, '..');
const esbuild = createRequire(require.resolve('vite/package.json'))('esbuild');
const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const evidenceDir = path.resolve(app, '../../../..', 'pms-statistics-evidence');
// 应收截止默认「当前年份 12 月」，与旧系统截图口径一致（镜像同步月份不能当截止月）。
const expectedAsOfPeriod = `${new Date().getFullYear()}12`;
// MIS FWXZK 全字典 01–13。实收报表默认 13 项（含 06 空房）；欠费报表默认 12 项（排除 06）。
const allNatures = '01,02,03,04,05,06,07,08,09,10,11,12,13';
const receivedDefaultNatures = allNatures;
const expectedDefaultNatures = '01,02,03,04,05,07,08,09,10,11,12,13';
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function loadStatisticsLib() {
  const source = fs.readFileSync(path.join(app, 'src/lib/statistics.ts'), 'utf8');
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { module, exports: module.exports });
  return module.exports;
}

test('统计汇总金额/CSV 纯函数：整数分格式化、UTF-8 BOM、筛选参数', () => {
  const lib = loadStatisticsLib();
  assert.equal(lib.fmtCents(74518210), '¥745,182.10');
  assert.equal(lib.fmtCents(0), '¥0.00');
  assert.equal(lib.fmtCents(null), '¥0.00');
  assert.equal(lib.fmtCents(15930), '¥159.30');
  assert.equal(lib.fmtArea(79.67), '79.67 ㎡');
  assert.equal(lib.fmtPeriod('202410'), '2024-10');

  const filters = {
    type: 'arrears', officeCodes: ['02'], feeCodes: ['01'], natures: ['01', '04'],
    yearFrom: 2004, yearTo: 2026, asOfPeriod: '202611', paidDateFrom: '2026-01-01', paidDateTo: '2026-03-31',
  };
  const query = lib.annualQueryParams(filters);
  assert.deepEqual(JSON.parse(JSON.stringify(query)), {
    type: 'arrears', officeCodes: '02', feeCodes: '01', natures: '01,04',
    yearFrom: 2004, yearTo: 2026, asOfPeriod: '202611',
  });

  // 收费项目分类树：顺序 代收费/其它/日常收费/停车收费；旧数据缺 category 时按 code 兜底。
  const grouped = lib.groupFeeItems([
    { code: '01', name: '管理费' }, { code: '12', name: '水费' }, { code: '04', name: '泊位费' },
    { code: '13', name: '电费' }, { code: '09', name: '网络费' }, { code: '15', name: '空房租金' },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(grouped.map((group) => group.category))), ['代收费', '其它', '日常收费', '停车收费']);
  assert.deepEqual(JSON.parse(JSON.stringify(grouped.map((group) => group.items.map((item) => item.code)))), [['12', '13'], ['09'], ['01', '15'], ['04']]);

  // 收款日期范围：欠费不传；实收才传；明细与年度使用同一组参数。
  assert.equal(lib.annualQueryParams({ ...filters, type: 'arrears' }).paidDateFrom, undefined);
  assert.equal(lib.annualQueryParams({ ...filters, type: 'received' }).paidDateFrom, '2026-01-01');
  assert.equal(lib.annualQueryParams({ ...filters, type: 'received' }).paidDateTo, '2026-03-31');
  assert.equal(lib.annualQueryParams({ ...filters, type: 'received' }).asOfPeriod, undefined, '实收年度不带应收截止年月');
  assert.equal(lib.annualQueryParams({ ...filters, type: 'arrears' }).asOfPeriod, '202611', '欠费年度仍带应收截止年月');
  const detailParams = lib.detailQueryParams({
    type: 'arrears', officeCode: '02', year: 2014, feeCodes: ['01'], natures: ['01', '04'],
    asOfPeriod: '202612', paidDateFrom: '2026-01-01', paidDateTo: '2026-03-31',
  });
  assert.equal(detailParams.asOfPeriod, '202612');
  assert.equal(detailParams.paidDateFrom, undefined);
  assert.equal(detailParams.paidDateTo, undefined);
  const receivedDetail = lib.detailQueryParams({
    type: 'received', officeCode: '02', year: 2014, feeCodes: ['01'], natures: ['01'],
    asOfPeriod: '202612', paidDateFrom: '2026-01-01', paidDateTo: '2026-03-31',
  });
  assert.equal(receivedDetail.asOfPeriod, undefined, '实收明细不带应收截止年月');
  assert.equal(receivedDetail.paidDateFrom, '2026-01-01');
  assert.equal(receivedDetail.paidDateTo, '2026-03-31');

  // P2：收费汇总请求参数（日期必填、收款方式多选、收款人、所属年度起止）。
  const collectionQuery = {
    type: 'fee-nature', officeCodes: ['02'], feeCodes: ['01', '04'], natures: ['01', '06'],
    paymentMethods: ['现金', '微信'], cashier: ' 合成收费员 ', dateFrom: '2026-10-01', dateTo: '2026-10-31',
    subjectYearFrom: '2025', subjectYearTo: '2026',
  };
  const collectionParams = lib.collectionQueryParams(collectionQuery);
  assert.deepEqual(JSON.parse(JSON.stringify(collectionParams)), {
    dateFrom: '2026-10-01', dateTo: '2026-10-31', officeCodes: '02', feeCodes: '01,04',
    natures: '01,06', paymentMethods: '现金,微信', cashier: '合成收费员', yearFrom: '2025', yearTo: '2026',
  });
  const cellDetail = lib.collectionDetailParams(collectionQuery, { feeCode: '04', natureCode: '01', kind: 'all' });
  assert.equal(cellDetail.feeCodes, '04');
  assert.equal(cellDetail.natures, '01');
  assert.equal(cellDetail.kind, 'all');
  assert.equal(cellDetail.dateFrom, '2026-10-01');
  assert.equal(cellDetail.limit, 200);
  const rowDetail = lib.collectionDetailParams(collectionQuery, { feeCode: '04', kind: 'received' });
  assert.equal(rowDetail.natures, '01,06', '行尾金额不限定房屋性质');
  assert.equal(rowDetail.kind, 'received');
  const dailyQuery = {
    type: 'daily', officeCodes: ['02'], feeCodes: ['01', '04'], natures: ['01', '06'],
    dateFrom: '2026-10-01', dateTo: '2026-10-10',
  };
  const dailyParams = lib.dailyQueryParams(dailyQuery);
  assert.deepEqual(JSON.parse(JSON.stringify(dailyParams)), {
    dateFrom: '2026-10-01', dateTo: '2026-10-10', officeCodes: '02', feeCodes: '01,04', natures: '01,06',
  });
  const dailyDetail = lib.collectionDetailParams(dailyQuery, { feeCode: '04', kind: 'received', date: '2026-10-09' });
  assert.equal(dailyDetail.dateFrom, '2026-10-09');
  assert.equal(dailyDetail.dateTo, '2026-10-09');
  assert.equal(dailyDetail.feeCodes, '04');
  assert.equal(dailyDetail.kind, 'received');

  const feeNature = {
    columns: [{ code: '01', name: '商品房' }, { code: '06', name: '空房' }],
    natures: [{ code: '01', name: '商品房' }, { code: '06', name: '空房' }],
    rows: [{ feeCode: '04', feeName: '泊位费', cells: { '01': -60000, '06': 3090000 }, receivedCents: 3105000, refundCents: 15000, adjustCents: -60000, netCents: 3030000 }],
    subtotal: { feeCode: '', feeName: '总计', cells: { '01': -60000, '06': 3090000 }, receivedCents: 3105000, refundCents: 15000, adjustCents: -60000, netCents: 3030000 },
    dataAsOf: '2026-11-09T21:00:00+08:00',
  };
  const feeCsv = lib.feeNatureCsv(feeNature, { ...collectionQuery, officeCodes: ['02'], feeCodes: ['04'], natures: ['01', '06'], paymentMethods: ['现金', '微信'] });
  assert.equal(feeCsv.charCodeAt(0), 0xFEFF);
  assert.ok(feeCsv.includes('收费汇总'));
  assert.ok(feeCsv.includes('01 商品房,06 空房,收款,退款,调整,净额'));
  assert.ok(feeCsv.includes('泊位费,-600.00,30900.00,31050.00,150.00,-600.00,30300.00'));
  assert.ok(feeCsv.includes('总计,-600.00,30900.00,31050.00,150.00,-600.00,30300.00'));

  const daily = {
    columns: [{ code: '01', name: '管理费' }],
    rows: [{ date: '2026-10-01', cells: { '01': 8000000 }, totalCents: 8000000 }],
    subtotal: { cells: { '01': 8000000 }, totalCents: 8000000 },
    dataAsOf: '2026-11-09T21:00:00+08:00',
  };
  const dailyCsvText = lib.dailyCsv(daily, dailyQuery);
  assert.equal(dailyCsvText.charCodeAt(0), 0xFEFF);
  assert.ok(dailyCsvText.includes('收款日报表'));
  assert.ok(dailyCsvText.includes('日期,管理费,合计'));
  assert.ok(dailyCsvText.includes('2026-10-01,80000.00,80000.00'));
  assert.ok(dailyCsvText.includes('合计,80000.00,80000.00'));

  // P2-C：欠收与溢收 / 收缴考核请求参数与 CSV。
  const arrearsQuery = {
    type: 'arrears-prepaid', tab: 'arrears', officeCodes: ['02'], feeCodes: ['01', '04'], natures: ['01', '06'],
    asOfPeriod: '202610', paidDateTo: '2026-11-09',
  };
  assert.deepEqual(JSON.parse(JSON.stringify(lib.arrearsPrepaidSummaryParams(arrearsQuery))), {
    asOfPeriod: '202610', paidDateTo: '2026-11-09', officeCodes: '02', feeCodes: '01,04', natures: '01,06', groupBy: 'office',
  });
  const arrearsDetailParams = lib.arrearsPrepaidDetailParams(arrearsQuery, 20, 200);
  assert.equal(arrearsDetailParams.tab, 'arrears');
  assert.equal(arrearsDetailParams.offset, 20);
  assert.equal(arrearsDetailParams.limit, 200);
  const billsParams = lib.arrearsBillsParams({ ...arrearsQuery, tab: 'prepaid' }, { sId: 2, feeCode: '01' });
  assert.equal(billsParams.tab, 'prepaid');
  assert.equal(billsParams.sId, 2);
  assert.equal(billsParams.feeCode, '01');
  assert.equal(billsParams.asOfPeriod, '202610');

  const assessmentQuery = {
    type: 'assessment', officeCodes: ['02'], feeCodes: ['01'], natures: ['01', '04'], year: '2026', paidDateTo: '2026-11-09',
  };
  const assessmentParams = lib.assessmentQueryParams(assessmentQuery, 0, 200);
  assert.equal(assessmentParams.year, '2026');
  assert.equal(assessmentParams.paidDateTo, '2026-11-09');
  assert.equal(assessmentParams.feeCodes, '01');
  assert.equal(assessmentParams.limit, 200);

  const arrearsDetail = {
    rows: [{ sId: 1, address: '永德路228弄3号402', ownerName: '朱全锋', areaSqm: 88.5, feeCode: '04', feeName: '泊位费', natureCode: '06', periodFrom: '201404', periodTo: '202011', months: 16, amountCents: 1582500 }],
    totals: { amountCents: 1582500, rows: 1 }, count: 1,
  };
  const arrearsCsvText = lib.arrearsPrepaidCsv(arrearsDetail, arrearsQuery);
  assert.equal(arrearsCsvText.charCodeAt(0), 0xFEFF);
  assert.ok(arrearsCsvText.includes('欠收统计'));
  assert.ok(arrearsCsvText.includes('欠费年月范围'));
  assert.ok(arrearsCsvText.includes('2014-04~2020-11'));
  assert.ok(arrearsCsvText.includes('15825.00'));

  const assessmentReport = {
    rows: [{
      officeCode: '02', officeName: '二期A', sId: 21, address: '宝秀路701号701', ownerName: '陆乾一', areaSqm: 630.98,
      months: Array.from({ length: 12 }, (_, index) => ({ month: index + 1, receivableCents: index === 0 ? 1000000 : 0, receivedCents: index === 0 ? 500000 : 0 })),
      totalReceivableCents: 1000000, totalReceivedCents: 500000, ratePct: 50,
    }],
    summary: { receivableCents: 1000000, receivedCents: 500000, ratePct: 50, payableHouseholds: 1, paidHouseholds: 1, householdRatePct: 100 },
    count: 1,
  };
  const assessmentCsvText = lib.assessmentCsv(assessmentReport, assessmentQuery);
  assert.equal(assessmentCsvText.charCodeAt(0), 0xFEFF);
  assert.ok(assessmentCsvText.includes('收缴考核'));
  assert.ok(assessmentCsvText.includes('1月应收,1月收款'));
  assert.ok(assessmentCsvText.includes('10000.00,5000.00'));
  assert.ok(assessmentCsvText.includes('50.00%'));
  assert.ok(assessmentCsvText.includes('合计'));

  // P2-D：收款分析 / 收费月报表请求参数与 CSV。
  const analysisQuery = {
    type: 'collection-analysis', officeCodes: ['02'], feeCodes: ['01', '04'], natures: ['01', '06'],
    asOfPeriod: '202611', dateFrom: '2026-11-01', dateTo: '2026-11-10', sort: 'currentArrears',
  };
  const analysisParams = lib.collectionAnalysisParams(analysisQuery, 0, 200);
  assert.equal(analysisParams.asOfPeriod, '202611');
  assert.equal(analysisParams.dateFrom, '2026-11-01');
  assert.equal(analysisParams.sort, 'currentArrears');
  assert.equal(analysisParams.limit, 200);
  const analysisDetailParams = lib.collectionAnalysisDetailParams(analysisQuery, 201);
  assert.equal(analysisDetailParams.sId, 201);
  assert.equal(analysisDetailParams.feeCodes, '01,04');
  const analysisReport = {
    rows: [{ sId: 201, officeCode: '02', officeName: '二期A', address: '宝秀路701号701', ownerName: '陆乾一', areaSqm: 630.98, historyArrearsCents: 0, currentYearArrearsCents: 1514300, currentMonthReceivableCents: 166430, prepaidCents: 90000, periodReceivedCents: 15000 }],
    totals: { historyArrearsCents: 0, currentYearArrearsCents: 1514300, currentMonthReceivableCents: 166430, prepaidCents: 90000, periodReceivedCents: 15000 },
    count: 1,
  };
  const analysisCsvText = lib.collectionAnalysisCsv(analysisReport, analysisQuery);
  assert.equal(analysisCsvText.charCodeAt(0), 0xFEFF);
  assert.ok(analysisCsvText.includes('收款分析'));
  assert.ok(analysisCsvText.includes('15143.00'));
  assert.ok(analysisCsvText.includes('150.00'));

  const monthlyQuery = { type: 'monthly-report', officeCodes: ['02'], feeCodes: ['01'], natures: ['01'], asOfPeriod: '202611' };
  assert.deepEqual(JSON.parse(JSON.stringify(lib.monthlyReportParams(monthlyQuery))), {
    asOfPeriod: '202611', officeCodes: '02', feeCodes: '01', natures: '01', groupBy: 'office',
  });
  const monthlyReport = {
    rows: [{ key: '02', label: '二期A', monthReceivableCents: 15213860, monthAdjustCents: -110000, cumulativeReceivableCents: 2899940950, oldArrearsReceivableCents: 9921090, totalReceivableCents: 2909862040, monthReceivedCents: 15314220, prepaidInCents: 7054720, prepaidBalanceCents: 29882290, monthArrearsCents: 6202090, cumulativeArrearsCents: 70235030, recoveryRatePct: 0.53 }],
    totals: { monthReceivableCents: 15213860, monthAdjustCents: -110000, cumulativeReceivableCents: 2899940950, oldArrearsReceivableCents: 9921090, totalReceivableCents: 2909862040, monthReceivedCents: 15314220, prepaidInCents: 7054720, prepaidBalanceCents: 29882290, monthArrearsCents: 6202090, cumulativeArrearsCents: 70235030, recoveryRatePct: 0.53 },
    pendingColumns: ['本期实收分项'],
  };
  const monthlyCsvText = lib.monthlyReportCsv(monthlyReport, monthlyQuery);
  assert.equal(monthlyCsvText.charCodeAt(0), 0xFEFF);
  assert.ok(monthlyCsvText.includes('收费月报表（核心指标）'));
  assert.ok(monthlyCsvText.includes('月应收,月调整,累计应收'));
  assert.ok(monthlyCsvText.includes('0.53%'));
  assert.ok(monthlyCsvText.includes('合计'));

  // P3-A：房产汇总 / 住户台账 / 楼房台账参数与 CSV。
  assert.deepEqual(JSON.parse(JSON.stringify(lib.propertySummaryParams({ type: 'property-summary', officeCodes: ['01', '02'] }))), { officeCodes: '01,02' });
  const ownerQuery = { type: 'owner-ledger', officeCodes: ['01'], natures: ['01', '06'], keyword: ' 宝秀路 ' };
  const ownerParams = lib.ownerLedgerParams(ownerQuery, 0, 200);
  assert.equal(ownerParams.keyword, '宝秀路');
  assert.equal(ownerParams.natures, '01,06');
  assert.equal(ownerParams.limit, 200);
  const buildingQuery = { type: 'building-ledger', officeCodes: ['01'], keyword: '228弄' };
  const buildingParams = lib.buildingLedgerParams(buildingQuery, 200, 200);
  assert.equal(buildingParams.keyword, '228弄');
  assert.equal(buildingParams.offset, 200);
  const propertyReport = {
    rows: [{ officeCode: '01', officeName: '一期', buildingCount: 12, roomCount: 480, ownerCount: 456, totalAreaSqm: 52340.5, natureCounts: { '01': '300' } }],
    total: { buildingCount: 12, roomCount: 480, ownerCount: 456, totalAreaSqm: 52340.5, natureCounts: { '01': 300 } },
    natures: [{ code: '01', name: '商品房' }],
  };
  const propertyCsvText = lib.propertySummaryCsv(propertyReport, { type: 'property-summary', officeCodes: ['01'] });
  assert.equal(propertyCsvText.charCodeAt(0), 0xFEFF);
  assert.ok(propertyCsvText.includes('房产汇总'));
  assert.ok(propertyCsvText.includes('01 商品房'));
  assert.ok(propertyCsvText.includes('合计,12,480,456,52340.5,300'));
  const ownerReport = { rows: [{ sId: 1, officeCode: '01', officeName: '一期', address: '宝秀路701号701', ownerName: null, mobile: null, phone2: null, areaSqm: 90, natureCode: '01', natureName: '商品房', roomNo: '701' }], count: 1 };
  const ownerCsvText = lib.ownerLedgerCsv(ownerReport, ownerQuery);
  assert.equal(ownerCsvText.charCodeAt(0), 0xFEFF);
  assert.ok(ownerCsvText.includes('住户台账'));
  assert.ok(ownerCsvText.includes('宝秀路701号701'));
  const buildingReport = { rows: [{ lId: 1, officeCode: '01', officeName: '一期', road: '宝秀路', lane: '228弄', buildingNo: '6', roomCount: 48, ownerCount: 45, areaSqm: 4800.5 }], count: 1, totals: { buildingCount: 1, roomCount: 48, ownerCount: 45, areaSqm: 4800.5 } };
  const buildingCsvText = lib.buildingLedgerCsv(buildingReport, buildingQuery);
  assert.equal(buildingCsvText.charCodeAt(0), 0xFEFF);
  assert.ok(buildingCsvText.includes('楼房台账'));
  assert.ok(buildingCsvText.includes('228弄'));
  assert.ok(buildingCsvText.includes('合计,,,,1,48,45,4800.5'));

  // P4-A：减免/签报请求参数与 CSV。
  const reliefQuery = {
    type: 'relief', officeCodes: ['01'], feeCodes: ['01'], dateFrom: '2026-01-01', dateTo: '2026-11-10', keyword: ' 宝秀路 ',
  };
  const reliefParams = lib.reliefParams(reliefQuery, 0, 200);
  assert.equal(reliefParams.dateFrom, '2026-01-01');
  assert.equal(reliefParams.keyword, '宝秀路');
  assert.equal(reliefParams.limit, 200);
  const reliefReport = {
    rows: [{ id: 1, docNo: 'JM202603001', officeCode: '01', officeName: '一期', address: '宝秀路701号701', ownerName: '陆乾一', feeCode: '01', feeName: '管理费', oldReceivableCents: 1200000, receivableCents: 960000, reliefCents: 240000, reliefStartDate: '2026-03-01', reliefEndDate: '2026-03-31', reliefDate: '2026-03-05', method: '减免单' }],
    totals: { count: 1, oldReceivableCents: 1200000, receivableCents: 960000, reliefCents: 240000 },
    count: 1,
  };
  const reliefCsvText = lib.reliefCsv(reliefReport, reliefQuery);
  assert.equal(reliefCsvText.charCodeAt(0), 0xFEFF);
  assert.ok(reliefCsvText.includes('减免情况统计'));
  assert.ok(reliefCsvText.includes('减免金额'));
  assert.ok(reliefCsvText.includes('2400.00'));

  const signoffQuery = {
    type: 'signoffs', officeCodes: ['01'], types: ['减免签报'], status: 'voided', dateFrom: '2026-01-01', dateTo: '2026-11-10', keyword: '',
  };
  const signoffParams = lib.signoffsParams(signoffQuery, 0, 200);
  assert.equal(signoffParams.status, 'voided');
  assert.equal(signoffParams.types, '减免签报');
  const signoffReport = {
    rows: [{ id: 1, docNo: 'QB202603001', title: '管理费减免签报', type: '减免签报', officeCode: '01', officeName: '一期', address: '宝秀路701号701', ownerName: '陆乾一', draftDate: '2026-03-02', approveDate: '2026-03-04', result: '同意', voided: false, ended: true, adjustAmountCents: -240000, feeCode: '01' }],
    totals: { count: 1, voidedCount: 0, endedCount: 1, adjustAmountCents: -240000 },
    count: 1,
  };
  const signoffsCsvText = lib.signoffsCsv(signoffReport, signoffQuery);
  assert.equal(signoffsCsvText.charCodeAt(0), 0xFEFF);
  assert.ok(signoffsCsvText.includes('签报情况统计'));
  assert.ok(signoffsCsvText.includes('调整金额'));
  assert.ok(signoffsCsvText.includes('-2400.00'));

  const annual = {
    type: 'arrears',
    columns: [2011, 2014],
    rows: [{ officeCode: '02', officeName: '枫桦景苑二期A', cells: { 2011: 92100, 2014: 47790 }, totalCents: 139890 }],
    subtotal: { cells: { 2011: 92100, 2014: 47790 }, totalCents: 139890 },
    dataAsOf: '2026-11-09T21:00:00+08:00',
  };
  const csv = lib.annualCsv(annual, {
    dataAsOf: annual.dataAsOf,
    filters,
    offices: [{ officeCode: '02', name: '枫桦景苑二期A', communityId: 2, communityName: '枫桦景苑二期' }],
    feeItems: [{ code: '01', name: '管理费' }],
    natures: [{ code: '01', name: '商品房' }, { code: '04', name: '配套用房' }],
  });
  assert.equal(csv.charCodeAt(0), 0xFEFF, 'CSV 必须带 UTF-8 BOM');
  assert.ok(csv.includes('项目欠费年度汇总'));
  assert.ok(csv.includes('管理处,2011,2014,合计'), 'CSV 要有年度表头和合计列');
  assert.ok(csv.includes('枫桦景苑二期A,921.00,477.90,1398.90'));
  assert.ok(csv.includes('小计,921.00,477.90,1398.90'));
  assert.ok(csv.includes('管理费'));
});

function buildFixture() {
  fs.mkdirSync(evidenceDir, { recursive: true });
  const build = esbuild.buildSync({
    entryPoints: [path.join(__dirname, 'statistics-browser.tsx')],
    bundle: true,
    format: 'iife',
    jsx: 'automatic',
    write: false,
    outfile: path.join(evidenceDir, 'fixture.js'),
    alias: {
      '@': path.join(app, 'src'),
      '@pms/api-client': path.join(__dirname, 'statistics-browser-api.ts'),
      '@pms/shared-types': path.join(app, '../../packages/shared-types/src/index.ts'),
    },
    define: {
      'process.env.NODE_ENV': '"development"',
      'import.meta.env.VITE_LEGACY_BASE': '""',
      'import.meta.env.BASE_URL': '"/"',
      'import.meta.env.VITE_API_BASE_URL': '"/api/v1"',
    },
  });
  for (const file of build.outputFiles) fs.writeFileSync(file.path, file.contents);
  fs.writeFileSync(
    path.join(evidenceDir, 'fixture.html'),
    '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="fixture.js"></script>',
  );
}

/** 起静态服务 + 无头 Chrome，把 CDP 辅助函数交给用例；结束后一律关闭。 */
async function withPage(run, query = '') {
  buildFixture();
  const server = http.createServer((request, response) => {
    const name = request.url.split('?')[0].slice(1);
    if (!['fixture.html', 'fixture.css', 'fixture.js'].includes(name)) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.setHeader('Content-Type', name.endsWith('js') ? 'text/javascript' : name.endsWith('css') ? 'text/css' : 'text/html;charset=utf-8');
    response.end(fs.readFileSync(path.join(evidenceDir, name)));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/fixture.html${query}`;
  const profile = path.join(evidenceDir, 'chrome-' + Date.now() + '-' + Math.random().toString(16).slice(2));
  const child = spawn(chrome, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu', url], { stdio: 'ignore' });
  let socket;
  try {
    // Chrome 刚写出 DevToolsActivePort 时文件可能仍被占用（EBUSY），重试到能读出端口为止。
    const portFile = path.join(profile, 'DevToolsActivePort');
    let port = 0;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try {
        const parsed = Number(fs.readFileSync(portFile, 'utf8').split('\n')[0].trim());
        if (Number.isInteger(parsed) && parsed > 0) { port = parsed; break; }
      } catch { /* 文件还没写完/被锁，稍后重试 */ }
      await pause(100);
    }
    assert.ok(port > 0, 'Chrome 没有暴露 DevTools 端口');
    let tabs;
    for (let attempt = 0; attempt < 150; attempt += 1) {
      tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      if (tabs.find((tab) => tab.url === url)) break;
      await pause(100);
    }
    const tab = tabs.find((item) => item.url === url);
    assert.ok(tab, 'Chrome 没有打开统计夹具页面');
    socket = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));

    let nextId = 0;
    const pending = new Map();
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      }
    });
    const call = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => reject(Error(method + ' 超时')), 15000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        message.error ? reject(Error(JSON.stringify(message.error))) : resolve(message.result);
      });
      socket.send(JSON.stringify({ id, method, params }));
    });
    const js = async (expression) => {
      const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const waitFor = async (expression, label, timeout = 15000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (await js(expression)) return;
        await pause(80);
      }
      assert.fail('等待超时：' + label);
    };
    const screenshot = async (name) => {
      const shot = await call('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(evidenceDir, name), Buffer.from(shot.data, 'base64'));
    };
    await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await run({ js, call, waitFor, screenshot });
  } finally {
    socket?.close();
    child.kill();
    await new Promise((resolve) => server.close(resolve));
  }
}

test('统计汇总：默认年度表、筛选参数、三级下钻、错误重试、CSV 导出、窄屏卡片', { timeout: 180000 }, async () => {
  await withPage(async ({ js, call, waitFor, screenshot }) => {
    await waitFor("!!document.querySelector('.stats')", '统计页挂载', 25000);
    await waitFor("!!document.querySelector('.stats-annual-table')", '默认年度汇总表', 25000);

    // 报表目录：四张启用、其余灰字「待接入」，不是假按钮；收费汇总/收款日报表已启用。
    assert.equal(await js("document.querySelector('[data-report-type=received]').classList.contains('on')"), true);
    assert.ok(await js("!!document.querySelector('[data-report-type=arrears]')"));
    assert.ok(await js("!!document.querySelector('[data-report-type=\"fee-nature\"]')"), '收费汇总已启用');
    assert.ok(await js("!!document.querySelector('[data-report-type=daily]')"), '收款日报表已启用');
    assert.ok(await js("!!document.querySelector('[data-report-type=\"arrears-prepaid\"]')"), '欠收与溢收汇总已启用');
    assert.ok(await js("!!document.querySelector('[data-report-type=assessment]')"), '收缴考核已启用');
    assert.ok(await js("!!document.querySelector('[data-report-type=\"collection-analysis\"]')"), '收款分析已启用');
    assert.ok(await js("!!document.querySelector('[data-report-type=\"monthly-report\"]')"), '收费月报表（核心指标）已启用');
    assert.ok(await js("!!document.querySelector('[data-report-type=\"property-summary\"]')"), '房产汇总已启用');
    assert.ok(await js("!!document.querySelector('[data-report-type=\"owner-ledger\"]')"), '住户台账已启用');
    assert.ok(await js("!!document.querySelector('[data-report-type=\"building-ledger\"]')"), '楼房台账已启用');
    assert.ok(await js("!!document.querySelector('[data-report-type=relief]')"), '减免情况统计已启用');
    assert.ok(await js("!!document.querySelector('[data-report-type=signoffs]')"), '签报情况统计已启用');
    assert.ok(await js("document.querySelectorAll('.stats-report-pending').length >= 10"), '待接入报表要用灰字列出');
    assert.equal(
      await js("[...document.querySelectorAll('.stats-report-pending')].some((e) => ['收费汇总', '收款日报表', '欠收与溢收汇总', '收缴考核', '收款分析', '收费月报表（核心指标）', '房产汇总', '住户台账', '楼房台账', '减免情况统计', '签报情况统计'].includes(e.textContent.trim()))"),
      false,
      '已启用报表不能仍列在待接入',
    );
    assert.ok(await js("[...document.querySelectorAll('.stats-report-pending')].every((e) => (e.title || '').includes('待接入'))"));

    // 默认实收年度表：年度表头 2004..2026 + 合计、4 个管理处行、合计/小计、数据截止。
    const headers = await js("[...document.querySelectorAll('.stats-annual-table thead th')].map((e) => e.textContent.trim())");
    assert.ok(headers.includes('2004') && headers.includes('2027') && headers.includes('合计'), '年度表头缺失：' + JSON.stringify(headers.slice(0, 6)));
    assert.equal(await js("document.querySelectorAll('.stats-annual-table tbody tr[data-office-row]').length"), 4);
    assert.ok(await js("!!document.querySelector('[data-testid=stats-subtotal-row]')"));
    assert.ok((await js("document.querySelector('[data-office-row=\"02\"]').textContent")).includes('¥7,435,962.00'), '实收 02 合计应按后端返回');
    const bodyText = await js('document.body.textContent');
    assert.ok(bodyText.includes('数据截止'), '要显示数据截止时间');
    assert.ok(bodyText.includes('项目实收年度汇总'));
    assert.ok(bodyText.includes('按收费发生时点性质统计'), '筛选面板要说明房屋性质按收费时点统计');
    assert.equal(await js("document.querySelectorAll('[data-nature-code]').length"), 13, '房屋性质应渲染 FWXZK 全字典 01–13');
    assert.deepEqual(
      await js("[...document.querySelectorAll('[data-nature-code]')].map((el) => el.getAttribute('data-nature-code'))"),
      ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12', '13'],
      '房屋性质按 code 顺序展示',
    );
    assert.equal(await js("document.querySelector('[data-nature-code=\"06\"]').checked"), true, '实收报表默认勾选 06 空房（13 项全选）');
    assert.equal(await js("document.querySelector('[data-nature-code=\"05\"]').checked"), true);
    assert.equal(await js("document.querySelector('[data-nature-code=\"13\"]').checked"), true);
    const receivedQuery = await js("window.__calls.filter((c) => c.url === '/statistics/annual').slice(-1)[0].query");
    assert.equal(receivedQuery.type, 'received');
    assert.equal(receivedQuery.asOfPeriod, undefined, '实收报表不能带应收截止年月，否则 2027/2028 列被截断');
    assert.equal(receivedQuery.paidDateTo, undefined, '收款日期默认留空，不限制实收');
    assert.equal(receivedQuery.paidDateFrom, undefined, '收款日期默认留空，不限制实收');
    assert.equal(receivedQuery.natures, receivedDefaultNatures, '实收默认房屋性质 = 全部 13 项（含 06 空房）');
    assert.ok(receivedQuery.natures.split(',').includes('06'), '实收默认请求必须带 06 空房');
    assert.ok(receivedQuery.natures.split(',').includes('05') && receivedQuery.natures.split(',').includes('07'), '默认请求要含 05/07 等性质');
    assert.equal(receivedQuery.feeCodes.split(',').length, 16, '默认收费项目仍是 16 项扁平 feeCodes');
    assert.ok(bodyText.includes('实收年度按「应收年月」归年'), '实收报表要说明按应收年月归年');
    assert.equal(await js("!!document.querySelector('[data-testid=asof-period-field]')"), false, '实收报表不展示应收截止年月');
    assert.ok(await js("!!document.querySelector('[data-testid=asof-period-hint]')"), '实收报表要提示应收截止年月仅欠费使用');
    await js("document.querySelector('[data-nature-code=\"06\"]').scrollIntoView({ block: 'center' })");
    await pause(200);
    await screenshot('statistics-received-natures-1440.png');
    await js("document.querySelector('.stats-filter-body').scrollTop = 0");
    assert.equal(await js("document.querySelector('[data-office-code=\"01\"][data-year=\"2004\"]').textContent.trim()"), '¥982.40', '实收 2004 单元格含 06 空房 ¥100.00');
    assert.equal(await js("document.querySelector('[data-office-code=\"01\"][data-year=\"2027\"]').textContent.trim()"), '¥1,600.00', '实收 2027 列不能被应收截止年月截断');
    assert.ok((await js("document.querySelector('[data-office-row=\"01\"]').textContent")).includes('¥2,582.40'));
    assert.ok((await js("document.querySelector('[data-testid=stats-subtotal-row]').textContent")).includes('¥982.40'), '实收小计含 06 空房金额');
    await js("(() => { const el = document.querySelector('.stats-table-scroll'); el.scrollLeft = el.scrollWidth; })()");
    await pause(250);
    await screenshot('statistics-received-2027-1440.png');
    await js("(() => { const el = document.querySelector('.stats-table-scroll'); el.scrollLeft = 0; })()");
    await screenshot('statistics-received-1440.png');

    // P1.3：实收点单元格直接是逐笔清单（detailKind=received），合计=单元格，不可再下钻。
    await js("document.querySelector('[data-office-code=\"01\"][data-year=\"2004\"]').click()");
    await waitFor("!!document.querySelector('.sheet')", '实收逐笔清单抽屉');
    await waitFor("!!document.querySelector('[data-testid=stats-received-total]')", '实收逐笔合计');
    assert.ok((await js("document.querySelector('.sheet .sh-h').textContent")).includes('项目实收年度汇总 · 管理处 01 · 2004 年度'), '实收下钻标题');
    assert.equal(await js("document.querySelector('[data-testid=stats-received-count]').textContent.trim()"), '23 笔');
    assert.deepEqual(
      await js("[...document.querySelectorAll('.stats-received-table thead th')].map((e) => e.textContent.trim())"),
      ['序号', '地址', '业主姓名', '建筑面积', '应收年月', '实收金额', '收款日期', '入库单编号', '票据编号'],
      '实收逐笔清单列名/顺序',
    );
    assert.equal(await js("document.querySelectorAll('.stats-received-table tbody tr').length"), 23, '实收逐笔清单 23 行');
    assert.equal(await js("document.querySelector('.stats-received-table tbody tr td:first-child').textContent.trim()"), '1', '序号列存在');
    assert.equal(await js("document.querySelector('[data-testid=stats-received-total]').textContent.trim()"), '¥982.40', '实收合计=单元格（含 06 空房）');
    assert.equal(await js("document.querySelector('[data-testid=stats-detail-cell-amount]').textContent.trim()"), '¥982.40');
    assert.equal(await js("[...document.querySelectorAll('.stats-received-table tbody tr')].every((row) => row.children[7].textContent.trim() === '—' && row.children[8].textContent.trim() === '—')"), true, '入库单/票据编号缺镜像显示—');
    const receivedDetailQuery = await js("window.__calls.filter((c) => c.url === '/statistics/annual/detail').slice(-1)[0].query");
    assert.equal(receivedDetailQuery.type, 'received');
    assert.equal(receivedDetailQuery.officeCode, '01');
    assert.equal(receivedDetailQuery.year, 2004);
    assert.equal(receivedDetailQuery.asOfPeriod, undefined, '实收明细不能带应收截止年月');
    assert.equal(receivedDetailQuery.paidDateFrom, undefined);
    assert.equal(receivedDetailQuery.paidDateTo, undefined);
    const billsBeforeReceivedClick = await js("window.__calls.filter((c) => c.url === '/statistics/annual/detail/bills').length");
    await js("document.querySelector('.stats-received-table tbody tr').click()");
    await pause(300);
    assert.equal(await js("window.__calls.filter((c) => c.url === '/statistics/annual/detail/bills').length"), billsBeforeReceivedClick, '实收逐笔清单行不可再下钻请求 bills');
    assert.equal(await js("!!document.querySelector('.stats-bills-table')"), false);
    await screenshot('statistics-received-detail-1440.png');
    await js("document.querySelector('[data-testid=stats-received-total]').scrollIntoView({ block: 'center' })");
    await pause(250);
    await screenshot('statistics-received-detail-total-1440.png');
    await js("document.querySelector('.sheet .x').click()");
    await waitFor("!document.querySelector('.sheet')", '关闭实收逐笔抽屉');

    // 悬浮筛选可收纳：收起后数据区变宽、面板消失；localStorage 记住状态。
    assert.ok(await js("!!document.querySelector('.stats-filter-float')"), '桌面默认展开筛选浮层');
    assert.equal(await js("localStorage.getItem('statistics.filters.collapsed')"), null);
    const widthExpanded = await js("document.querySelector('.stats-main').clientWidth");
    await js("document.querySelector('[data-testid=stats-filter-toggle]').click()");
    await pause(300);
    assert.equal(await js("!!document.querySelector('.stats-filters')"), false, '收起后筛选面板应隐藏');
    assert.equal(await js("localStorage.getItem('statistics.filters.collapsed')"), '1', '收起状态应写入 localStorage');
    const widthCollapsed = await js("document.querySelector('.stats-main').clientWidth");
    assert.ok(widthCollapsed > widthExpanded, `收起后数据区应变宽（${widthExpanded} → ${widthCollapsed}）`);
    assert.ok((await js("document.querySelector('[data-testid=stats-filter-toggle]').textContent")).includes('筛选'));
    await screenshot('statistics-filters-collapsed-1440.png');
    await js("document.querySelector('[data-testid=stats-filter-toggle]').click()");
    await pause(300);
    assert.ok(await js("!!document.querySelector('.stats-filters')"), '再次点击应展开筛选');
    assert.equal(await js("localStorage.getItem('statistics.filters.collapsed')"), '0');

    // 收费项目分类树：4 组按旧 MIS 顺序；组级全选/半选；搜索保留分组结构。
    const feeGroupOrder = await js("[...document.querySelectorAll('[data-fee-category]')].map((e) => e.getAttribute('data-fee-category'))");
    assert.deepEqual(feeGroupOrder, ['代收费', '其它', '日常收费', '停车收费']);
    assert.ok((await js("document.querySelector('[data-fee-category=\"代收费\"]').textContent")).includes('水费'));
    assert.ok((await js("document.querySelector('[data-fee-category=\"代收费\"]').textContent")).includes('电费'));
    assert.ok((await js("document.querySelector('[data-fee-category=\"日常收费\"]').textContent")).includes('空房租金'));
    assert.ok((await js("document.querySelector('[data-fee-category=\"停车收费\"]').textContent")).includes('置业泊位费'));
    assert.equal(await js("document.querySelector('[data-fee-group-checkbox=\"日常收费\"]').checked"), true);
    await js("document.querySelector('[data-fee-group-checkbox=\"日常收费\"]').click()");
    await pause(200);
    assert.equal(await js("document.querySelector('[data-fee-group-checkbox=\"日常收费\"]').checked"), false, '组级取消后该组不全选');
    assert.equal(await js("document.querySelector('[data-fee-group-checkbox=\"日常收费\"]').indeterminate"), false);
    assert.ok((await js("document.querySelector('[data-fee-category=\"日常收费\"]').textContent")).includes('0/7'));
    await js("document.querySelector('[data-fee-code=\"01\"]').click()");
    await pause(200);
    assert.equal(await js("document.querySelector('[data-fee-group-checkbox=\"日常收费\"]').indeterminate"), true, '组内部分选中应为半选态');
    assert.equal(await js("document.querySelector('[data-fee-group-checkbox=\"日常收费\"]').checked"), false);
    assert.ok((await js("document.querySelector('[data-fee-category=\"日常收费\"]').textContent")).includes('1/7'), '组头显示已选/总数');
    await js("document.querySelector('[data-fee-group-checkbox=\"日常收费\"]').click()");
    await pause(200);
    assert.equal(await js("document.querySelector('[data-fee-group-checkbox=\"日常收费\"]').checked"), true, '再点组级复选框应全选该组');
    assert.equal(await js("document.querySelector('[data-fee-group-checkbox=\"日常收费\"]').indeterminate"), false);
    const setInputValue = (selector, value) => js(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await setInputValue('[data-testid=fee-search]', '水费');
    await pause(250);
    assert.deepEqual(await js("[...document.querySelectorAll('[data-fee-category]')].map((e) => e.getAttribute('data-fee-category'))"), ['代收费'], '搜索只保留命中的分组');
    assert.equal(await js("document.querySelectorAll('[data-fee-code=\"01\"]').length"), 0, '搜索时隐藏未命中项目');
    await setInputValue('[data-testid=fee-search]', '');
    await pause(250);
    assert.equal(await js("document.querySelectorAll('[data-fee-category]').length"), 4, '清空搜索恢复 4 个分组');
    await screenshot('statistics-fee-groups-1440.png');

    // 编号独立列 + 管理处名称分列；表头/单元格对齐一致；表格线；左两列 sticky。
    const headTexts = await js("[...document.querySelectorAll('.stats-annual-table thead th')].map((e) => e.textContent.trim())");
    assert.deepEqual(headTexts.slice(0, 2), ['编号', '管理处'], '首列应为编号、第二列管理处');
    assert.equal(await js("document.querySelector('.stats-annual-table tbody td.stats-index-col').textContent.trim()"), '01');
    const officeCell = await js("document.querySelector('.stats-annual-table tbody td.stats-office-col').textContent");
    assert.ok(officeCell.includes('枫桦景苑一期'));
    assert.equal(officeCell.includes('01'), false, '管理处名称列不再混排编号');
    const align = await js(`(() => {
      const th = [...document.querySelectorAll('.stats-annual-table thead th')].find((e) => e.textContent.trim() === '2004');
      const totalTh = [...document.querySelectorAll('.stats-annual-table thead th')].pop();
      return {
        yearTh: getComputedStyle(th).textAlign,
        yearTd: getComputedStyle(document.querySelector('.stats-annual-table tbody td.stats-year-col')).textAlign,
        totalTh: getComputedStyle(totalTh).textAlign,
        totalTd: getComputedStyle(document.querySelector('.stats-annual-table tbody td.stats-total-col')).textAlign,
        indexTh: getComputedStyle(document.querySelector('.stats-annual-table thead th.stats-index-col')).textAlign,
        indexTd: getComputedStyle(document.querySelector('.stats-annual-table tbody td.stats-index-col')).textAlign,
        officeTh: getComputedStyle(document.querySelector('.stats-annual-table thead th.stats-office-col')).textAlign,
        officeTd: getComputedStyle(document.querySelector('.stats-annual-table tbody td.stats-office-col')).textAlign,
      };
    })()`);
    assert.equal(align.yearTh, 'right', '年度表头应右对齐');
    assert.equal(align.yearTd, 'right', '年度单元格应右对齐');
    assert.equal(align.totalTh, 'right', '合计表头应右对齐');
    assert.equal(align.totalTd, 'right', '合计单元格应右对齐');
    assert.equal(align.indexTh, align.indexTd, '编号表头与单元格对齐一致');
    assert.equal(align.officeTh, 'left', '管理处表头应左对齐');
    assert.equal(align.officeTd, 'left', '管理处单元格应左对齐');
    const borders = await js(`(() => {
      const td = document.querySelector('.stats-annual-table tbody td');
      const th = document.querySelector('.stats-annual-table thead th');
      return {
        td: parseFloat(getComputedStyle(td).borderBottomWidth) + parseFloat(getComputedStyle(td).borderRightWidth),
        th: parseFloat(getComputedStyle(th).borderBottomWidth),
      };
    })()`);
    assert.ok(borders.td > 0 && borders.th > 0, '表头/单元格应有表格线');
    assert.equal(await js("getComputedStyle(document.querySelector('.stats-annual-table tbody td.stats-index-col')).position"), 'sticky');
    assert.equal(await js("getComputedStyle(document.querySelector('.stats-annual-table tbody td.stats-office-col')).position"), 'sticky');
    assert.equal(await js("getComputedStyle(document.querySelector('.stats-annual-table tbody td.stats-office-col')).left"), '56px', '管理处列应紧贴编号列左侧固定');

    // 切到项目欠费年度汇总：02×2014=¥477.90，02 合计 ¥745,182.10（生产验收基准）。
    await js("document.querySelector('[data-report-type=arrears]').click()");
    await waitFor("document.querySelector('[data-office-code=\"02\"][data-year=\"2014\"]')?.textContent.includes('¥477.90')", '欠费 02×2014 单元格');
    assert.ok(await js("!!document.querySelector('[data-testid=asof-period-field]')"), '欠费报表展示应收截止年月');
    assert.equal(await js("!!document.querySelector('[data-testid=asof-period-hint]')"), false);
    assert.ok((await js("document.querySelector('[data-office-row=\"02\"]').textContent")).includes('¥745,182.10'));
    assert.ok((await js('document.body.textContent')).includes('项目欠费年度汇总'));
    assert.ok((await js('document.body.textContent')).includes('已知差异'), '01 管理处差异要在页面标注');
    for (const [year, amount] of [['2011', '¥921.00'], ['2012', '¥307.00'], ['2014', '¥477.90'], ['2025', '¥16,595.00'], ['2026', '¥726,881.20']]) {
      assert.equal(await js(`document.querySelector('[data-office-code="02"][data-year="${year}"]').textContent.trim()`), amount, `02×${year} 年度金额应对上生产验收基准`);
    }
    await screenshot('statistics-arrears-1440.png');
    // 报表默认房屋性质自动切换：实收 13 项（含 06）→ 欠费 12 项（排除 06）。
    await waitFor("(() => { const list = window.__calls.filter((c) => c.url === '/statistics/annual'); const last = list[list.length - 1]; return last && last.query.type === 'arrears' && last.query.natures === '" + expectedDefaultNatures + "'; })()", '欠费默认房屋性质自动排除 06');
    assert.equal(await js("document.querySelector('[data-nature-code=\"06\"]').checked"), false, '切到欠费后 06 空房不勾选');
    assert.equal(await js("[...document.querySelectorAll('[data-nature-code]')].filter((el) => el.checked).length"), 12);
    await js("document.querySelector('[data-nature-code=\"06\"]').scrollIntoView({ block: 'center' })");
    await pause(200);
    await screenshot('statistics-arrears-natures-1440.png');
    await js("document.querySelector('.stats-filter-body').scrollTop = 0");
    // 再切回实收：默认值自动恢复 13 项（含 06）。
    await js("document.querySelector('[data-report-type=received]').click()");
    await waitFor("(() => { const list = window.__calls.filter((c) => c.url === '/statistics/annual'); const last = list[list.length - 1]; return last && last.query.type === 'received' && last.query.natures === '" + receivedDefaultNatures + "'; })()", '实收默认房屋性质自动包含 06');
    assert.equal(await js("document.querySelector('[data-nature-code=\"06\"]').checked"), true, '切回实收后 06 空房恢复勾选');
    // 用户手动改过房屋性质后切换报表：保留用户选择，不强制套默认值。
    await js("document.querySelector('[data-action=natures-clear]').click()");
    await pause(200);
    await js("document.querySelector('[data-nature-code=\"01\"]').click()");
    await pause(200);
    await js("document.querySelector('[data-report-type=arrears]').click()");
    await waitFor("(() => { const list = window.__calls.filter((c) => c.url === '/statistics/annual'); const last = list[list.length - 1]; return last && last.query.type === 'arrears' && last.query.natures === '01'; })()", '手动房屋性质在切换报表后保留');
    assert.equal(await js("document.querySelector('[data-nature-code=\"01\"]').checked"), true, '手动选择 01 保留');
    assert.equal(await js("[...document.querySelectorAll('[data-nature-code]')].filter((el) => el.checked).length"), 1);
    // 重置按当前报表类型（欠费）恢复默认：12 项、06 不勾。
    await js("document.querySelector('[data-action=filters-reset]').click()");
    await pause(250);
    assert.equal(await js("document.querySelector('[data-nature-code=\"06\"]').checked"), false, '欠费重置后 06 不勾');
    assert.equal(await js("[...document.querySelectorAll('[data-nature-code]')].filter((el) => el.checked).length"), 12, '欠费重置恢复 12 项');
    await js("document.querySelector('[data-testid=stats-submit]').click()");
    await waitFor("(() => { const list = window.__calls.filter((c) => c.url === '/statistics/annual'); const last = list[list.length - 1]; return last && last.query.natures === '" + expectedDefaultNatures + "'; })()", '欠费重置后请求恢复默认房屋性质');

    // 筛选变更不自动请求；勾 02 管理处 + 管理费后点「统计」，请求参数正确。
    const beforeCalls = await js("window.__calls.filter((c) => c.url === '/statistics/annual').length");
    await js("document.querySelector('[data-action=offices-clear]').click()");
    await js("document.querySelector('[data-office-code=\"02\"]').click()");
    await js("document.querySelector('[data-action=fees-clear]').click()");
    await js("document.querySelector('[data-fee-code=\"01\"]').click()");
    await pause(300);
    assert.equal(await js("window.__calls.filter((c) => c.url === '/statistics/annual').length"), beforeCalls, '改筛选不能自动请求');
    await js("document.querySelector('[data-testid=stats-submit]').click()");
    await waitFor("(() => { const list = window.__calls.filter((c) => c.url === '/statistics/annual'); const last = list[list.length - 1]; return last && last.query.officeCodes === '02' && last.query.feeCodes === '01'; })()", '筛选后的年度请求');
    const annualQuery = await js("window.__calls.filter((c) => c.url === '/statistics/annual').slice(-1)[0].query");
    assert.equal(annualQuery.type, 'arrears');
    assert.equal(annualQuery.officeCodes, '02');
    assert.equal(annualQuery.feeCodes, '01');
    assert.equal(annualQuery.natures, expectedDefaultNatures, '筛选后仍默认排除 06 空房');
    assert.ok(!annualQuery.natures.split(',').includes('06'));
    assert.equal(annualQuery.yearFrom, 2004);
    assert.equal(annualQuery.yearTo, 2027);
    assert.equal(annualQuery.asOfPeriod, expectedAsOfPeriod);
    assert.equal(annualQuery.paidDateTo, undefined, '欠费报表不传收款截止日期');
    await waitFor("document.querySelectorAll('.stats-annual-table tbody tr[data-office-row]').length === 1", '筛选后只剩 02');
    assert.equal(await js("document.querySelector('[data-office-code=\"02\"][data-year=\"2014\"]').textContent.trim()"), '¥477.90');
    await screenshot('statistics-filtered-1440.png');

    // 三级下钻：单元格 → 房屋明细（合计与单元格一致）→ 逐笔账单。
    await js("document.querySelector('[data-office-code=\"02\"][data-year=\"2014\"]').click()");
    await waitFor("!!document.querySelector('.sheet')", '明细抽屉');
    await waitFor("!!document.querySelector('[data-testid=stats-detail-total]')", '明细合计');
    assert.equal(await js("document.querySelector('[data-testid=stats-detail-cell-amount]').textContent.trim()"), '¥477.90');
    assert.equal(await js("document.querySelector('[data-testid=stats-detail-total]').textContent.trim()"), '¥477.90', '明细合计必须等于单元格');
    assert.equal(
      await js("getComputedStyle([...document.querySelectorAll('.stats-detail-table thead th')].find((e) => e.classList.contains('stats-num'))).textAlign"),
      'right',
      '明细表头金额列应右对齐',
    );
    assert.equal(await js("getComputedStyle(document.querySelector('.stats-detail-table tbody td.stats-num')).textAlign"), 'right', '明细金额单元格应右对齐');
    const sheetText = await js("document.querySelector('.sheet').textContent");
    assert.ok(sheetText.includes('宝秀路719号719'));
    assert.ok(sheetText.includes('79.67 ㎡'));
    assert.ok(sheetText.includes('201410-201412'));
    assert.ok(sheetText.includes('欠费年月范围'));
    const detailQuery = await js("window.__calls.filter((c) => c.url === '/statistics/annual/detail').slice(-1)[0].query");
    assert.equal(detailQuery.type, 'arrears');
    assert.equal(detailQuery.officeCode, '02');
    assert.equal(detailQuery.year, 2014);
    assert.equal(detailQuery.feeCodes, '01');
    assert.equal(detailQuery.asOfPeriod, expectedAsOfPeriod, '明细必须带与年度表相同的应收截止');
    assert.equal(detailQuery.paidDateTo, undefined, '欠费明细不传收款截止日期');
    assert.equal(detailQuery.natures, expectedDefaultNatures, '明细与年度表用同一组房屋性质（默认排除 06）');
    assert.ok(!detailQuery.natures.split(',').includes('06'));
    await screenshot('statistics-detail-1440.png');

    await js("document.querySelector('.stats-detail-table tbody tr').click()");
    await waitFor("!!document.querySelector('[data-testid=stats-bills-total]')", '逐笔账单表');
    assert.equal(await js("document.querySelectorAll('.stats-bills-row').length"), 3);
    assert.deepEqual(
      await js("[...document.querySelectorAll('.stats-bills-row')].map((row) => row.children[0].textContent.trim())"),
      ['2024-10', '2024-11', '2024-12'],
    );
    assert.deepEqual(
      await js("[...document.querySelectorAll('.stats-bills-row')].map((row) => row.children[2].textContent.trim())"),
      ['¥159.30', '¥159.30', '¥159.30'],
    );
    assert.equal(await js("document.querySelector('[data-testid=stats-bills-total]').textContent.trim()"), '¥477.90');
    const billsQuery = await js("window.__calls.filter((c) => c.url === '/statistics/annual/detail/bills').slice(-1)[0].query");
    assert.equal(billsQuery.sId, 719, 'detail 行 sId 是数字，逐笔请求必须原样带回来');
    assert.equal(billsQuery.asOfPeriod, expectedAsOfPeriod, '逐笔必须带与年度表相同的应收截止');
    assert.equal(billsQuery.paidDateTo, undefined, '欠费逐笔不传收款截止日期');
    await screenshot('statistics-bills-1440.png');
    await js("document.querySelector('.sheet .x').click()");
    await waitFor("!document.querySelector('.sheet')", '关闭明细抽屉');

    // 错误态：可见错误 + 重试；恢复后重试能取回表格。
    await js('window.__annualFail = true');
    await js("document.querySelector('[data-testid=stats-submit]').click()");
    await waitFor("document.body.textContent.includes('统计读取失败')", '统计错误态');
    assert.ok(await js("[...document.querySelectorAll('.stats-result button')].some((e) => e.textContent.trim() === '重试')"), '错误态要有重试');
    await screenshot('statistics-error-1440.png');
    await js('window.__annualFail = false');
    await js("(() => { const button = [...document.querySelectorAll('.stats-result button')].find((e) => e.textContent.trim() === '重试'); button.click(); })()");
    await waitFor("!!document.querySelector('.stats-annual-table')", '重试后恢复年度表');

    // 未镜像：annual.available=false + message 时优先显示后端说明，不渲染空表/通用「暂无数据」。
    await js('window.__annualUnavailable = true');
    await js("document.querySelector('[data-testid=stats-submit]').click()");
    await waitFor("document.body.textContent.includes('MIS 镜像本期未同步')", '未镜像说明');
    assert.equal(await js("!!document.querySelector('.stats-annual-table')"), false, '未镜像时不能渲染空表');
    assert.equal(await js("document.body.textContent.includes('当前筛选没有可汇总的数据')"), false, '未镜像时不能只说暂无数据');
    await screenshot('statistics-unavailable-1440.png');
    await js('window.__annualUnavailable = false');
    await js("document.querySelector('[data-testid=stats-submit]').click()");
    await waitFor("!!document.querySelector('.stats-annual-table')", '未镜像恢复后年度表');

    // 导出 CSV：UTF-8 BOM、含当前报表/筛选与合计行。
    await js("(() => { window.__blobs = []; const original = window.URL.createObjectURL.bind(window.URL); window.URL.createObjectURL = (blob) => { window.__blobs.push(blob); return original(blob); }; })()");
    await js("document.querySelector('[data-testid=stats-export]').click()");
    await waitFor("window.__blobs.length >= 1", 'CSV Blob');
    const csv = await js("(async () => { const blob = window.__blobs[0]; const bytes = new Uint8Array(await blob.arrayBuffer()).slice(0, 3); const text = await blob.text(); return { bom: [...bytes], report: text.includes('项目欠费年度汇总'), header: text.includes('管理处,2004'), subtotal: text.includes('小计'), length: text.length }; })()");
    assert.deepEqual(csv.bom, [0xEF, 0xBB, 0xBF], 'CSV 必须带 UTF-8 BOM');
    assert.ok(csv.report, 'CSV 应含当前报表名');
    assert.ok(csv.header, 'CSV 应含年度表头');
    assert.ok(csv.subtotal, 'CSV 应含小计行');
    assert.ok(csv.length > 200);
    // 等导出 toast 消失再截窄屏图，避免浮层遮住表格表头。
    await pause(2600);

    // 窄屏（≤900）：清理记忆后重载，筛选应默认收起为顶部「筛选」按钮；点开为浮层抽屉，卡片模式保持。
    await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 900, deviceScaleFactor: 1, mobile: false });
    await js("localStorage.removeItem('statistics.filters.collapsed')");
    await call('Page.reload', { ignoreCache: true });
    await pause(900);
    await waitFor("!!document.querySelector('.stats')", '窄屏重载统计页', 25000);
    await waitFor("document.querySelectorAll('.stats-office-card').length >= 1", '窄屏卡片', 25000);
    assert.equal(await js("!!document.querySelector('.stats-filters')"), false, '窄屏默认收起筛选面板');
    assert.ok((await js("document.querySelector('[data-testid=stats-filter-toggle]').textContent")).includes('筛选'));
    assert.ok(await js('document.documentElement.scrollWidth <= innerWidth + 1'), '390 窄屏出现横向溢出');
    assert.equal(await js("getComputedStyle(document.querySelector('.stats-table-scroll')).display"), 'none');
    assert.notEqual(await js("getComputedStyle(document.querySelector('.stats-annual-cards')).display"), 'none');
    await js("document.querySelector('.stats-annual-cards').scrollIntoView({ block: 'center' })");
    await pause(200);
    await screenshot('statistics-390-collapsed.png');
    await js('window.scrollTo(0, 0)');
    await js("document.querySelector('[data-testid=stats-filter-toggle]').click()");
    await waitFor("!!document.querySelector('.stats-filters')", '窄屏筛选浮层', 8000);
    assert.equal(await js("getComputedStyle(document.querySelector('.stats-filter-mask')).display"), 'block', '窄屏筛选浮层应有遮罩');
    await screenshot('statistics-390-filters-open.png');
    await js("document.querySelector('[data-testid=stats-filter-toggle]').click()");
    await pause(300);
    assert.equal(await js("!!document.querySelector('.stats-filters')"), false, '窄屏再次点击应收起筛选');

    await call('Emulation.setDeviceMetricsOverride', { width: 320, height: 900, deviceScaleFactor: 1, mobile: false });
    await pause(350);
    assert.ok(await js('document.documentElement.scrollWidth <= innerWidth + 1'), '320 窄屏出现横向溢出');
    assert.ok(await js("!!document.querySelector('.stats-card-year')"));
    await screenshot('statistics-320.png');

    // 重置按当前报表类型恢复默认：窄屏重载后是实收报表 → 房屋性质 13 项（含 06 空房）；重置自身不自动请求。
    await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await pause(400);
    if (!(await js("!!document.querySelector('.stats-filters')"))) {
      await js("document.querySelector('[data-testid=stats-filter-toggle]').click()");
      await waitFor("!!document.querySelector('.stats-filters')", '桌面筛选面板恢复', 8000);
    }
    const callsBeforeReset = await js("window.__calls.filter((c) => c.url === '/statistics/annual').length");
    await js("document.querySelector('[data-action=filters-reset]').click()");
    await pause(250);
    assert.equal(await js("window.__calls.filter((c) => c.url === '/statistics/annual').length"), callsBeforeReset, '重置不自动请求');
    assert.equal(await js("document.querySelector('[data-nature-code=\"06\"]').checked"), true, '实收重置后 06 空房勾选（13 项）');
    assert.equal(await js("document.querySelector('[data-nature-code=\"05\"]').checked"), true);
    assert.equal(await js("[...document.querySelectorAll('[data-nature-code]')].filter((el) => el.checked).length"), 13);
    assert.equal(await js("document.querySelector('[data-fee-code=\"01\"]').checked"), true);
    assert.equal(await js("document.querySelector('[data-office-code=\"02\"]').checked"), true, '重置后管理处恢复全选');
    await js("document.querySelector('[data-testid=stats-submit]').click()");
    const resetQueryExpr = `(() => {
      const list = window.__calls.filter((c) => c.url === '/statistics/annual');
      const last = list[list.length - 1];
      return last && last.query.natures === '${receivedDefaultNatures}' && last.query.officeCodes.includes('02') && last.query.feeCodes.includes('01');
    })()`;
    await waitFor(resetQueryExpr, '重置后的实收年度请求');
    await waitFor("!!document.querySelector('.stats-annual-table')", '重置后年度表');
    await js('window.scrollTo(0, 0)');
    await pause(200);
    await screenshot('statistics-reset-default-1440.png');

    // 收款日期范围：实收请求带 paidDateFrom/paidDateTo；欠费不带；from>to 时 toast 且不发请求。
    const typeRangeDate = async (index, text) => {
      const stateKey = index === 0 ? 'dateFrom' : 'dateTo';
      const keyEvent = (type, params) => call('Input.dispatchKeyEvent', { type, ...params });
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await js(`document.querySelectorAll('.stats-date-range input')[${index}].focus()`);
        // 先清空输入（Ctrl+A / Backspace），再整段插入日期并回车，避免和上一次值拼接。
        await keyEvent('keyDown', { key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
        await keyEvent('keyUp', { key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
        await keyEvent('keyDown', { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
        await keyEvent('keyUp', { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
        await call('Input.insertText', { text });
        await pause(150);
        await keyEvent('keyDown', { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
        await keyEvent('keyUp', { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
        await pause(350);
        // 以 React 草稿状态（data-date-*）为准，避免只改到 DOM input 但提交时状态还没跟上。
        const committed = await js(`document.querySelector('.stats-date-range').dataset.${stateKey}`);
        if (committed === text) return;
      }
      assert.fail(`收款日期输入未生效：${text}`);
    };
    await js("document.querySelector('[data-report-type=received]').click()");
    await waitFor("document.querySelector('[data-report-type=received]').classList.contains('on')", '切回实收报表');
    await typeRangeDate(0, '2026-01-01');
    await typeRangeDate(1, '2026-03-31');
    assert.deepEqual(
      await js("[...document.querySelectorAll('.stats-date-range input')].map((el) => el.value)"),
      ['2026-01-01', '2026-03-31'],
      '收款日期范围（从/至）应可输入',
    );
    await js("document.querySelector('[data-testid=stats-submit]').click()");
    await waitFor(
      "(() => { const list = window.__calls.filter((c) => c.url === '/statistics/annual'); const last = list[list.length - 1]; return last && last.query.type === 'received' && last.query.paidDateFrom === '2026-01-01' && last.query.paidDateTo === '2026-03-31'; })()",
      '实收请求带收款日期范围',
    );
    await screenshot('statistics-date-range-1440.png');
    // 收款日期范围只做筛选：实收逐笔清单请求带 from/to，年度列仍按应收年月归年。
    assert.equal(await js("document.querySelector('[data-office-code=\"01\"][data-year=\"2004\"]').textContent.trim()"), '¥982.40', '年度列仍按应收年度');
    await js("document.querySelector('[data-office-code=\"01\"][data-year=\"2004\"]').click()");
    await waitFor("!!document.querySelector('.stats-received-table')", '带日期范围的实收逐笔清单');
    const rangedDetailQuery = await js("window.__calls.filter((c) => c.url === '/statistics/annual/detail').slice(-1)[0].query");
    assert.equal(rangedDetailQuery.type, 'received');
    assert.equal(rangedDetailQuery.asOfPeriod, undefined, '实收明细不能带应收截止年月');
    assert.equal(rangedDetailQuery.paidDateFrom, '2026-01-01');
    assert.equal(rangedDetailQuery.paidDateTo, '2026-03-31');
    await js("document.querySelector('.sheet .x').click()");
    await waitFor("!document.querySelector('.sheet')", '关闭实收逐笔抽屉（日期范围）');
    await js("document.querySelector('[data-report-type=arrears]').click()");
    await waitFor("(() => { const list = window.__calls.filter((c) => c.url === '/statistics/annual'); const last = list[list.length - 1]; return last && last.query.type === 'arrears'; })()", '切换欠费报表');
    const arrearsQuery = await js("window.__calls.filter((c) => c.url === '/statistics/annual').slice(-1)[0].query");
    assert.equal(arrearsQuery.paidDateFrom, undefined, '欠费报表不带收款日期起');
    assert.equal(arrearsQuery.paidDateTo, undefined, '欠费报表不带收款日期止');
    await typeRangeDate(0, '2026-06-01');
    assert.equal(
      await js("document.querySelector('.stats-date-range').dataset.dateFrom"),
      '2026-06-01',
      '非法范围输入应写入筛选状态',
    );
    const beforeInvalid = await js("window.__calls.filter((c) => c.url === '/statistics/annual').length");
    await js("document.querySelector('[data-testid=stats-submit]').click()");
    await waitFor("document.body.textContent.includes('收款日期起不能晚于收款日期至')", '收款日期范围错误提示');
    await pause(400);
    assert.equal(await js("window.__calls.filter((c) => c.url === '/statistics/annual').length"), beforeInvalid, '非法收款日期范围不应发请求');
    await screenshot('statistics-date-range-invalid-1440.png');
  });
});

test('P2 收费汇总：费项×性质矩阵、行尾四块、总计、单元格下钻合计、筛选与导出、窄屏', { timeout: 180000 }, async () => {
  await withPage(async ({ js, call, waitFor, screenshot }) => {
    await waitFor("!!document.querySelector('.stats')", '统计页挂载', 25000);
    await waitFor("!!document.querySelector('.stats-annual-table')", '默认年度表', 25000);

    // 启用收费汇总（目录按钮，不再灰字）。
    await js("document.querySelector('[data-report-type=\"fee-nature\"]').click()");
    await waitFor("!!document.querySelector('[data-testid=fee-nature-table]')", '收费汇总矩阵', 25000);
    assert.equal(await js("document.querySelector('[data-report-type=\"fee-nature\"]').classList.contains('on')"), true);
    assert.ok((await js('document.body.textContent')).includes('收费汇总'));

    // 请求参数：日期必填默认本月、收款方式来自 options、所属年度/收款人默认不限。
    const query = await js("window.__calls.filter((c) => c.url === '/statistics/collection/fee-nature').slice(-1)[0].query");
    assert.ok(query.dateFrom && query.dateTo, '收费汇总日期必填且默认本月');
    assert.equal(typeof query.dateFrom, 'string');
    assert.equal(query.paymentMethods, '现金,微信,支付宝,银行,转账', '默认勾选全部收款方式');
    assert.equal(query.cashier, undefined, '收款人默认不限');
    assert.equal(query.yearFrom, undefined, '所属年度默认不限');
    assert.equal(query.yearTo, undefined);

    // 表头：收费项目 + 13 个房屋性质 + 收款/退款/调整/净额。
    const headers = await js("[...document.querySelectorAll('[data-testid=fee-nature-table] thead th')].map((th) => th.textContent.trim())");
    assert.equal(headers.length, 18, '收费汇总 18 列');
    assert.equal(headers[0], '收费项目');
    assert.ok(headers.includes('01 商品房') && headers.includes('06 空房'));
    assert.deepEqual(headers.slice(-4), ['收款', '退款', '调整', '净额']);
    assert.equal(await js("document.querySelectorAll('[data-testid=fee-nature-table] tbody tr[data-fee-row]').length"), 4);
    assert.equal(await js("document.querySelector('[data-fee-row=\"01\"] [data-nature-code=\"01\"]').textContent.trim()"), '¥119,152.20');
    assert.equal(await js("document.querySelector('[data-fee-row=\"04\"] [data-nature-code=\"01\"]').textContent.trim()"), '¥-600.00', '调整/净额可为负');
    assert.equal(await js("document.querySelector('[data-fee-row=\"04\"] [data-nature-code=\"06\"]').textContent.trim()"), '¥30,900.00');
    assert.ok((await js("document.querySelector('[data-testid=fee-nature-subtotal]').textContent")).includes('¥152,992.20'), '总计净额');
    assert.ok((await js("document.querySelector('[data-testid=fee-nature-subtotal]').textContent")).includes('¥153,742.20'), '总计收款');
    assert.ok((await js("document.querySelector('[data-testid=fee-nature-hint]').textContent")).includes('按收款日期统计收款/退款/调整'));
    await screenshot('statistics-fee-nature-1440.png');

    // 点房屋性质单元格：明细合计=单元格，kind=all、费项/性质/日期同源。
    await js("document.querySelector('[data-fee-row=\"01\"] [data-nature-code=\"01\"]').click()");
    await waitFor("!!document.querySelector('[data-testid=collection-detail-table]')", '收费汇总明细抽屉');
    assert.ok((await js("document.querySelector('[data-testid=collection-detail-summary]').textContent")).includes('¥119,152.20'), '明细合计=单元格');
    const cellQuery = await js("window.__calls.filter((c) => c.url === '/statistics/collection/detail').slice(-1)[0].query");
    assert.equal(cellQuery.kind, 'all');
    assert.equal(cellQuery.feeCodes, '01');
    assert.equal(cellQuery.natures, '01');
    assert.equal(cellQuery.dateFrom, query.dateFrom);
    assert.equal(cellQuery.dateTo, query.dateTo);
    await screenshot('statistics-fee-nature-detail-1440.png');

    // kind 过滤：切换「收款」请求参数与合计跟着单元格口径走。
    await js("document.querySelector('.sheet [data-kind=\"received\"]').click()");
    await waitFor("(() => { const list = window.__calls.filter((c) => c.url === '/statistics/collection/detail'); const last = list[list.length - 1]; return last && last.query.kind === 'received'; })()", '明细 kind=received 请求');
    await waitFor("(document.querySelector('[data-testid=collection-detail-summary]')?.textContent || '').includes('¥119,152.20')", '收款筛选合计');
    await js("document.querySelector('.sheet .x').click()");
    await waitFor("!document.querySelector('.sheet')", '关闭明细抽屉');

    // 筛选：取消一个收款方式后提交，请求带 paymentMethods（不含微信），且不自动请求。
    const beforeFilterSubmit = await js("window.__calls.filter((c) => c.url === '/statistics/collection/fee-nature').length");
    await js("document.querySelector('[data-payment-method=\"微信\"]').click()");
    await pause(200);
    assert.equal(await js("window.__calls.filter((c) => c.url === '/statistics/collection/fee-nature').length"), beforeFilterSubmit, '改筛选不自动请求');
    await js("document.querySelector('[data-testid=stats-submit]').click()");
    await waitFor("(() => { const list = window.__calls.filter((c) => c.url === '/statistics/collection/fee-nature'); const last = list[list.length - 1]; return last && last.query.paymentMethods === '现金,支付宝,银行,转账'; })()", '收费汇总筛选请求');
    await waitFor("!!document.querySelector('[data-testid=fee-nature-table]')", '筛选后矩阵');

    // 导出：当前报表 CSV、BOM、含房屋性质表头/四块列/总计。
    await js("(() => { window.__blobs = []; const original = window.URL.createObjectURL.bind(window.URL); window.URL.createObjectURL = (blob) => { window.__blobs.push(blob); return original(blob); }; })()");
    await js("document.querySelector('[data-testid=stats-export]').click()");
    await waitFor("window.__blobs.length >= 1", '收费汇总 CSV Blob');
    const exported = await js("(async () => { const blob = window.__blobs[0]; const bytes = new Uint8Array(await blob.arrayBuffer()).slice(0, 3); const text = await blob.text(); return { bom: [...bytes], report: text.includes('收费汇总'), header: text.includes('01 商品房') && text.includes('净额'), row: text.includes('泊位费') && text.includes('30300.00'), total: text.includes('总计') }; })()");
    assert.deepEqual(exported.bom, [0xEF, 0xBB, 0xBF]);
    assert.ok(exported.report && exported.header && exported.row && exported.total, '收费汇总 CSV 内容');
    await pause(2600);

    // 窄屏：页面不横向溢出，宽表在内部滚动。
    await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 900, deviceScaleFactor: 1, mobile: false });
    await pause(500);
    if (await js("!!document.querySelector('.stats-filter-float')")) {
      await js("document.querySelector('[data-testid=stats-filter-toggle]').click()");
      await pause(300);
    }
    assert.ok(await js('document.documentElement.scrollWidth <= innerWidth + 1'), '收费汇总 390 页面横向溢出');
    assert.ok(await js("(() => { const el = document.querySelector('.stats-matrix-scroll'); return el && el.scrollWidth > el.clientWidth; })()"), '宽表应在内部横向滚动');
    await screenshot('statistics-fee-nature-390.png');
    await call('Emulation.setDeviceMetricsOverride', { width: 320, height: 900, deviceScaleFactor: 1, mobile: false });
    await pause(400);
    assert.ok(await js('document.documentElement.scrollWidth <= innerWidth + 1'), '收费汇总 320 页面横向溢出');
    await screenshot('statistics-fee-nature-320.png');
  });
});

test('P2 收款日报表：日期×收费项目矩阵、合计行列、单元格收款明细下钻、导出', { timeout: 180000 }, async () => {
  await withPage(async ({ js, call, waitFor, screenshot }) => {
    await waitFor("!!document.querySelector('.stats')", '统计页挂载', 25000);
    await waitFor("!!document.querySelector('.stats-annual-table')", '默认年度表', 25000);
    await js("document.querySelector('[data-report-type=daily]').click()");
    await waitFor("!!document.querySelector('[data-testid=daily-table]')", '收款日报表矩阵', 25000);
    assert.equal(await js("document.querySelector('[data-report-type=daily]').classList.contains('on')"), true);
    assert.ok((await js('document.body.textContent')).includes('收款日报表'));

    const query = await js("window.__calls.filter((c) => c.url === '/statistics/daily').slice(-1)[0].query");
    assert.ok(query.dateFrom && query.dateTo, '日报表日期必填且默认本月');
    const headers = await js("[...document.querySelectorAll('[data-testid=daily-table] thead th')].map((th) => th.textContent.trim())");
    assert.equal(headers[0], '日期');
    assert.equal(headers[headers.length - 1], '合计');
    assert.ok(headers.includes('管理费') && headers.includes('泊位费'), '日报表列=选中的收费项目：' + JSON.stringify(headers));
    const month = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
    const rows = await js("[...document.querySelectorAll('[data-testid=daily-table] tbody tr[data-daily-date]')].map((row) => row.getAttribute('data-daily-date'))");
    assert.deepEqual(rows, [`${month}-01`, `${month}-03`, `${month}-09`, `${month}-14`, `${month}-20`], '无收款日期不显示 0 行');
    assert.equal(await js(`document.querySelector('[data-daily-date="${month}-01"] button').textContent.trim()`), '¥80,000.00');
    assert.ok((await js("document.querySelector('[data-testid=daily-subtotal]').textContent")).includes('¥153,742.20'), '日报表合计');
    assert.ok((await js("document.querySelector('[data-testid=daily-report-hint]').textContent")).includes('没有收款的日期不显示 0 行'));
    await screenshot('statistics-daily-1440.png');

    // 点单元格：当日+费项收款明细（kind=received、dateFrom=dateTo=当天）。
    await js(`document.querySelector('[data-daily-date="${month}-01"] button').click()`);
    await waitFor("!!document.querySelector('[data-testid=collection-detail-table]')", '日报表明细抽屉');
    assert.ok((await js("document.querySelector('[data-testid=collection-detail-summary]').textContent")).includes('¥80,000.00'), '明细合计=单元格');
    const detailQuery = await js("window.__calls.filter((c) => c.url === '/statistics/collection/detail').slice(-1)[0].query");
    assert.equal(detailQuery.kind, 'received');
    assert.equal(detailQuery.feeCodes, '01');
    assert.equal(detailQuery.dateFrom, `${month}-01`);
    assert.equal(detailQuery.dateTo, `${month}-01`);
    assert.equal(await js("document.querySelectorAll('[data-testid=collection-detail-table] tbody tr[data-row-kind=\"received\"]').length"), 1);
    await screenshot('statistics-daily-detail-1440.png');
    await js("document.querySelector('.sheet .x').click()");
    await waitFor("!document.querySelector('.sheet')", '关闭日报表明细');

    // 导出当前日报表 CSV。
    await js("(() => { window.__blobs = []; const original = window.URL.createObjectURL.bind(window.URL); window.URL.createObjectURL = (blob) => { window.__blobs.push(blob); return original(blob); }; })()");
    await js("document.querySelector('[data-testid=stats-export]').click()");
    await waitFor("window.__blobs.length >= 1", '日报表 CSV Blob');
    const exported = await js(`(async () => { const blob = window.__blobs[0]; const bytes = new Uint8Array(await blob.arrayBuffer()).slice(0, 3); const text = await blob.text(); return { bom: [...bytes], report: text.includes('收款日报表'), header: text.includes('日期,'), row: text.includes('${month}-01'), total: text.includes('合计,') }; })()`);
    assert.deepEqual(exported.bom, [0xEF, 0xBB, 0xBF]);
    assert.ok(exported.report && exported.header && exported.row && exported.total, '收款日报表 CSV 内容');
  });
});

test('P2-C 欠收与溢收汇总：两页签、合计/小计、查看逐笔合计、CSV、窄屏内部滚动', { timeout: 180000 }, async () => {
  await withPage(async ({ js, call, waitFor, screenshot }) => {
    await waitFor("!!document.querySelector('.stats')", '统计页挂载', 25000);
    await waitFor("!!document.querySelector('.stats-annual-table')", '默认年度表', 25000);
    await js("document.querySelector('[data-report-type=\"arrears-prepaid\"]').click()");
    await waitFor("!!document.querySelector('[data-testid=arrears-prepaid-table]')", '欠收明细表', 25000);
    const month = `${new Date().getFullYear()}${String(new Date().getMonth() + 1).padStart(2, '0')}`;
    const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
    const summaryQuery = await js("window.__calls.filter((c) => c.url === '/statistics/arrears-prepaid/summary').slice(-1)[0].query");
    assert.equal(summaryQuery.asOfPeriod, month);
    assert.equal(summaryQuery.paidDateTo, today);
    assert.equal(summaryQuery.groupBy, 'office');
    const detailQuery = await js("window.__calls.filter((c) => c.url === '/statistics/arrears-prepaid/detail').slice(-1)[0].query");
    assert.equal(detailQuery.tab, 'arrears');
    assert.equal(detailQuery.asOfPeriod, month);
    assert.equal(detailQuery.paidDateTo, today);

    assert.equal(await js("document.querySelector('[data-arrears-tab=\"arrears\"]').getAttribute('aria-selected')"), 'true');
    assert.ok(await js("!!document.querySelector('[data-arrears-tab=\"prepaid\"]')"));
    const bodyText = await js('document.body.textContent');
    assert.ok(bodyText.includes('欠收') && bodyText.includes('溢收'));
    assert.ok((await js("document.querySelector('[data-testid=arrears-summary-chips]').textContent")).includes('枫桦景苑一期'));
    assert.ok((await js("document.querySelector('[data-testid=arrears-prepaid-total]').textContent")).includes('¥39,232.00'), '欠收明细合计');
    assert.ok((await js("document.querySelector('[data-testid=arrears-prepaid-total]').textContent")).includes('3'));
    assert.ok((await js("document.querySelector('[data-s-id=\"1\"]').textContent")).includes('永德路228弄3号402'));
    assert.ok((await js("document.querySelector('[data-s-id=\"1\"]').textContent")).includes('2014-04 ~ 2020-11'));
    await screenshot('statistics-arrears-prepaid-1440.png');

    // 查看 → 逐笔抽屉，合计=行金额。
    await js("document.querySelector('[data-s-id=\"1\"] [data-view-bills]').click()");
    await waitFor("!!document.querySelector('[data-testid=arrears-bills-table]')", '逐笔抽屉');
    assert.ok((await js("document.querySelector('.sheet').textContent")).includes('¥15,825.00'));
    const billsQuery = await js("window.__calls.filter((c) => c.url === '/statistics/arrears-prepaid/detail/bills').slice(-1)[0].query");
    assert.equal(billsQuery.tab, 'arrears');
    assert.equal(billsQuery.sId, 1);
    assert.equal(billsQuery.feeCode, '04');
    await screenshot('statistics-arrears-bills-1440.png');
    await js("document.querySelector('.sheet .x').click()");
    await waitFor("!document.querySelector('.sheet')", '关闭逐笔抽屉');

    // 溢收页签：请求 tab=prepaid、合计=溢收金额。
    await js("document.querySelector('[data-arrears-tab=\"prepaid\"]').click()");
    await waitFor("(() => { const list = window.__calls.filter((c) => c.url === '/statistics/arrears-prepaid/detail'); const last = list[list.length - 1]; return last && last.query.tab === 'prepaid'; })()", '溢收明细请求');
    await waitFor("document.querySelector('[data-testid=arrears-prepaid-table] tbody tr[data-s-id]')?.textContent.includes('永德路228弄33号1202')", '溢收明细表');
    assert.ok((await js("document.querySelector('[data-testid=arrears-prepaid-total]').textContent")).includes('¥8,531.80'), '溢收明细合计');
    assert.ok((await js("document.querySelector('[data-testid=arrears-prepaid-table]').textContent")).includes('收费年月范围'));
    await screenshot('statistics-prepaid-1440.png');

    // CSV：BOM、当前页签、收费年月范围、合计。
    await js("(() => { window.__blobs = []; const original = window.URL.createObjectURL.bind(window.URL); window.URL.createObjectURL = (blob) => { window.__blobs.push(blob); return original(blob); }; })()");
    await js("document.querySelector('[data-testid=stats-export]').click()");
    await waitFor("window.__blobs.length >= 1", '欠收溢收 CSV Blob');
    const exported = await js("(async () => { const blob = window.__blobs[0]; const bytes = new Uint8Array(await blob.arrayBuffer()).slice(0, 3); const text = await blob.text(); return { bom: [...bytes], tab: text.includes('溢收统计'), range: text.includes('收费年月范围'), total: text.includes('合计') }; })()");
    assert.deepEqual(exported.bom, [0xEF, 0xBB, 0xBF]);
    assert.ok(exported.tab && exported.range && exported.total, '欠收与溢收 CSV 内容');
    await pause(2600);

    // 宽表内部滚动、页面 390 不横向溢出。
    await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 900, deviceScaleFactor: 1, mobile: false });
    await pause(500);
    if (await js("!!document.querySelector('.stats-filter-float')")) {
      await js("document.querySelector('[data-testid=stats-filter-toggle]').click()");
      await pause(300);
    }
    assert.ok(await js('document.documentElement.scrollWidth <= innerWidth + 1'), '欠收溢收 390 页面横向溢出');
    await screenshot('statistics-arrears-prepaid-390.png');
  });
});

test('P2-C 收缴考核：12 月应收/收款表头、指标卡、合计/收缴率、CSV、窄屏内部滚动', { timeout: 180000 }, async () => {
  await withPage(async ({ js, call, waitFor, screenshot }) => {
    await waitFor("!!document.querySelector('.stats')", '统计页挂载', 25000);
    await waitFor("!!document.querySelector('.stats-annual-table')", '默认年度表', 25000);
    await js("document.querySelector('[data-report-type=assessment]').click()");
    await waitFor("!!document.querySelector('[data-testid=assessment-table]')", '收缴考核表', 25000);
    const query = await js("window.__calls.filter((c) => c.url === '/statistics/collection-assessment').slice(-1)[0].query");
    assert.equal(query.year, String(new Date().getFullYear()));
    assert.ok(query.feeCodes.includes('01'));
    assert.ok(query.natures.length > 0);
    assert.ok(query.paidDateTo);

    const cards = await js("document.querySelector('[data-testid=assessment-cards]').textContent");
    assert.ok(cards.includes('应收合计') && cards.includes('已收合计') && cards.includes('金额收缴率'));
    assert.ok(cards.includes('应缴 / 已缴户数') && cards.includes('按户数收缴率'));
    assert.ok(cards.includes('¥30,005.60'), '应收合计指标卡');
    assert.ok(cards.includes('¥10,000.00'), '已收合计指标卡');
    assert.ok(cards.includes('33.33%'), '金额收缴率指标卡');
    assert.ok(cards.includes('66.67%'), '按户数收缴率指标卡');

    const headers = await js("[...document.querySelectorAll('[data-testid=assessment-table] thead th')].map((th) => th.textContent.trim()).filter(Boolean)");
    assert.equal(headers.length, 42, '收缴考核表头：首行 18 个（含 12 个月分组）+ 次行 24 个');
    assert.ok(headers.includes('1 月') && headers.includes('12 月'));
    assert.ok(headers.includes('合计应收') && headers.includes('合计已收') && headers.includes('收缴率'));
    assert.ok((await js("document.querySelector('[data-testid=assessment-table]').textContent")).includes('宝秀路701号701'));
    assert.ok((await js("document.querySelector('[data-testid=assessment-table]').textContent")).includes('24.13%'));
    assert.ok((await js("document.querySelector('[data-testid=assessment-total]').textContent")).includes('33.33%'), '合计行收缴率');
    await screenshot('statistics-assessment-1440.png');

    // CSV：BOM、12 月表头、合计、收缴率。
    await js("(() => { window.__blobs = []; const original = window.URL.createObjectURL.bind(window.URL); window.URL.createObjectURL = (blob) => { window.__blobs.push(blob); return original(blob); }; })()");
    await js("document.querySelector('[data-testid=stats-export]').click()");
    await waitFor("window.__blobs.length >= 1", '收缴考核 CSV Blob');
    const exported = await js("(async () => { const blob = window.__blobs[0]; const bytes = new Uint8Array(await blob.arrayBuffer()).slice(0, 3); const text = await blob.text(); return { bom: [...bytes], title: text.includes('收缴考核'), months: text.includes('1月应收') && text.includes('12月收款'), total: text.includes('合计'), rate: text.includes('33.33%') }; })()");
    assert.deepEqual(exported.bom, [0xEF, 0xBB, 0xBF]);
    assert.ok(exported.title && exported.months && exported.total && exported.rate, '收缴考核 CSV 内容');
    await pause(2600);

    // 宽表内部横向滚动、表头 sticky；页面 390 不横向溢出。
    await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 900, deviceScaleFactor: 1, mobile: false });
    await pause(500);
    if (await js("!!document.querySelector('.stats-filter-float')")) {
      await js("document.querySelector('[data-testid=stats-filter-toggle]').click()");
      await pause(300);
    }
    assert.ok(await js('document.documentElement.scrollWidth <= innerWidth + 1'), '收缴考核 390 页面横向溢出');
    assert.ok(await js("(() => { const el = document.querySelector('.stats-assessment-scroll'); return el && el.scrollWidth > el.clientWidth; })()"), '考核宽表应内部滚动');
    await screenshot('statistics-assessment-390.png');
  });
});

test('P2-D 收款分析（按户）：请求参数/合计/点行逐笔/排序/CSV/窄屏', { timeout: 180000 }, async () => {
  await withPage(async ({ js, call, waitFor, screenshot }) => {
    await waitFor("!!document.querySelector('.stats')", '统计页挂载', 25000);
    await waitFor("!!document.querySelector('.stats-annual-table')", '默认年度表', 25000);
    await js("document.querySelector('[data-report-type=\"collection-analysis\"]').click()");
    await waitFor("!!document.querySelector('[data-testid=collection-analysis-table]')", '收款分析表', 25000);
    const month = `${new Date().getFullYear()}${String(new Date().getMonth() + 1).padStart(2, '0')}`;
    const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
    const query = await js("window.__calls.filter((c) => c.url === '/statistics/collection-analysis').slice(-1)[0].query");
    assert.equal(query.asOfPeriod, month);
    assert.ok(query.dateFrom && query.dateFrom.endsWith('-01'), '收款日期默认本月 1 日');
    assert.equal(query.dateTo, today);
    assert.equal(query.sort, 'currentArrears');
    assert.equal(query.limit, 200);

    const headers = await js("[...document.querySelectorAll('[data-testid=collection-analysis-table] thead th')].map((th) => th.textContent.trim())");
    assert.deepEqual(headers, ['序号', '地址', '业主', '建筑面积', '历年欠收', '当年欠收', '当月应收', '预缴', '区间实收']);
    assert.equal(await js("document.querySelectorAll('[data-testid=collection-analysis-table] tbody tr[data-s-id]').length"), 3);
    assert.ok((await js("document.querySelector('[data-s-id=\"201\"]').textContent")).includes('陆乾一'), '默认按当年欠收降序');
    assert.ok((await js("document.querySelector('[data-testid=collection-analysis-total]').textContent")).includes('¥27,147.00'), '当年欠收合计');
    assert.ok((await js("document.querySelector('[data-testid=collection-analysis-total]').textContent")).includes('¥2,500.00'), '历年欠收合计');
    await screenshot('statistics-collection-analysis-1440.png');

    // 点行 → 该户逐笔，合计按类型分组。
    await js("document.querySelector('[data-s-id=\"201\"]').click()");
    await waitFor("!!document.querySelector('[data-testid=analysis-detail-table]')", '收款分析逐笔抽屉');
    const summary = await js("document.querySelector('[data-testid=analysis-detail-summary]').textContent + document.querySelector('[data-testid=analysis-detail-totals]').textContent");
    assert.ok(summary.includes('收款') && summary.includes('¥900.00') && summary.includes('退款') && summary.includes('欠收'));
    const detailQuery = await js("window.__calls.filter((c) => c.url === '/statistics/collection-analysis/detail').slice(-1)[0].query");
    assert.equal(detailQuery.sId, 201);
    assert.equal(detailQuery.asOfPeriod, month);
    assert.ok((await js("document.querySelector('[data-testid=analysis-detail-table]').textContent")).includes('15,143.00'));
    await screenshot('statistics-collection-analysis-detail-1440.png');
    await js("document.querySelector('.sheet .x').click()");
    await waitFor("!document.querySelector('.sheet')", '关闭逐笔抽屉');

    // 排序：切换历年欠收降序 → 请求 sort=historyArrears 且重排。
    await js("(() => { const el = document.querySelector('[data-testid=analysis-sort]'); const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; setter.call(el, 'historyArrears'); el.dispatchEvent(new Event('change', { bubbles: true })); })()");
    await pause(200);
    await js("document.querySelector('[data-testid=stats-submit]').click()");
    await waitFor("(() => { const list = window.__calls.filter((c) => c.url === '/statistics/collection-analysis'); const last = list[list.length - 1]; return last && last.query.sort === 'historyArrears'; })()", '收款分析排序请求');
    await waitFor("document.querySelector('[data-testid=collection-analysis-table] tbody tr[data-s-id]')?.textContent.includes('邱解平')", '历年欠收降序首行');

    // CSV：BOM、收款分析表头、合计。
    await js("(() => { window.__blobs = []; const original = window.URL.createObjectURL.bind(window.URL); window.URL.createObjectURL = (blob) => { window.__blobs.push(blob); return original(blob); }; })()");
    await js("document.querySelector('[data-testid=stats-export]').click()");
    await waitFor("window.__blobs.length >= 1", '收款分析 CSV Blob');
    const exported = await js("(async () => { const blob = window.__blobs[0]; const bytes = new Uint8Array(await blob.arrayBuffer()).slice(0, 3); const text = await blob.text(); return { bom: [...bytes], title: text.includes('收款分析'), header: text.includes('历年欠收,当年欠收,当月应收,预缴,区间实收'), total: text.includes('合计') }; })()");
    assert.deepEqual(exported.bom, [0xEF, 0xBB, 0xBF]);
    assert.ok(exported.title && exported.header && exported.total, '收款分析 CSV 内容');
    await pause(2600);

    await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 900, deviceScaleFactor: 1, mobile: false });
    await pause(500);
    if (await js("!!document.querySelector('.stats-filter-float')")) {
      await js("document.querySelector('[data-testid=stats-filter-toggle]').click()");
      await pause(300);
    }
    assert.ok(await js('document.documentElement.scrollWidth <= innerWidth + 1'), '收款分析 390 页面横向溢出');
    await screenshot('statistics-collection-analysis-390.png');
  });
});

test('P2-D 收费月报表（核心指标）：11 列/合计行/回收率/提示/CSV/窄屏内部滚动', { timeout: 180000 }, async () => {
  await withPage(async ({ js, call, waitFor, screenshot }) => {
    await waitFor("!!document.querySelector('.stats')", '统计页挂载', 25000);
    await waitFor("!!document.querySelector('.stats-annual-table')", '默认年度表', 25000);
    await js("document.querySelector('[data-report-type=\"monthly-report\"]').click()");
    await waitFor("!!document.querySelector('[data-testid=monthly-report-table]')", '收费月报表', 25000);
    const month = `${new Date().getFullYear()}${String(new Date().getMonth() + 1).padStart(2, '0')}`;
    const query = await js("window.__calls.filter((c) => c.url === '/statistics/monthly-report').slice(-1)[0].query");
    assert.equal(query.asOfPeriod, month);
    assert.equal(query.groupBy, 'office');

    const headers = await js("[...document.querySelectorAll('[data-testid=monthly-report-table] thead th')].map((th) => th.textContent.trim())");
    assert.deepEqual(headers, ['管理处', '月应收', '月调整', '累计应收', '旧欠应收', '合计应收', '本期实收', '预收转入', '预收余额', '当月欠收', '累计欠收', '本期回收率']);
    assert.equal(await js("document.querySelectorAll('[data-testid=monthly-report-table] tbody tr[data-monthly-key]').length"), 4);
    assert.ok((await js("document.querySelector('[data-monthly-key=\"02\"]').textContent")).includes('0.53%'), '本期回收率两位小数');
    assert.ok((await js("document.querySelector('[data-testid=monthly-report-total]').textContent")).includes('0.59%'), '合计行回收率');
    const hint = await js("document.querySelector('[data-testid=monthly-report-hint]').textContent");
    assert.ok(hint.includes('核心指标版') && hint.includes('待旧系统截图确认'), '核心指标版提示');
    assert.ok((await js("document.querySelector('[data-testid=monthly-report-hint]').textContent")).includes('本期实收分项'));
    assert.ok((await js("document.querySelector('[data-testid=monthly-report-table]').textContent")).includes('合计'));
    await screenshot('statistics-monthly-report-1440.png');

    await js("(() => { window.__blobs = []; const original = window.URL.createObjectURL.bind(window.URL); window.URL.createObjectURL = (blob) => { window.__blobs.push(blob); return original(blob); }; })()");
    await js("document.querySelector('[data-testid=stats-export]').click()");
    await waitFor("window.__blobs.length >= 1", '收费月报表 CSV Blob');
    const exported = await js("(async () => { const blob = window.__blobs[0]; const bytes = new Uint8Array(await blob.arrayBuffer()).slice(0, 3); const text = await blob.text(); return { bom: [...bytes], title: text.includes('收费月报表（核心指标）'), header: text.includes('月应收,月调整,累计应收'), total: text.includes('合计'), rate: text.includes('0.53%') }; })()");
    assert.deepEqual(exported.bom, [0xEF, 0xBB, 0xBF]);
    assert.ok(exported.title && exported.header && exported.total && exported.rate, '收费月报表 CSV 内容');
    await pause(2600);

    await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 900, deviceScaleFactor: 1, mobile: false });
    await pause(500);
    if (await js("!!document.querySelector('.stats-filter-float')")) {
      await js("document.querySelector('[data-testid=stats-filter-toggle]').click()");
      await pause(300);
    }
    assert.ok(await js('document.documentElement.scrollWidth <= innerWidth + 1'), '收费月报表 390 页面横向溢出');
    assert.ok(await js("(() => { const el = document.querySelector('.stats-monthly-report-scroll'); return el && el.scrollWidth > el.clientWidth; })()"), '月报表宽表应内部滚动');
    await screenshot('statistics-monthly-report-390.png');
    await call('Emulation.setDeviceMetricsOverride', { width: 320, height: 900, deviceScaleFactor: 1, mobile: false });
    await pause(400);
    assert.ok(await js('document.documentElement.scrollWidth <= innerWidth + 1'), '收费月报表 320 页面横向溢出');
  });
});

test('P3-A 房产汇总：管理处行/合计/性质房屋数列/CSV/窄屏内部滚动', { timeout: 180000 }, async () => {
  await withPage(async ({ js, call, waitFor, screenshot }) => {
    await waitFor("!!document.querySelector('.stats')", '统计页挂载', 25000);
    await waitFor("!!document.querySelector('.stats-annual-table')", '默认年度表', 25000);
    await js("document.querySelector('[data-report-type=\"property-summary\"]').click()");
    await waitFor("!!document.querySelector('[data-testid=property-summary-table]')", '房产汇总表', 25000);
    const query = await js("window.__calls.filter((c) => c.url === '/statistics/property-summary').slice(-1)[0].query");
    assert.equal(query.officeCodes, '01,02,03,04');
    const headers = await js("[...document.querySelectorAll('[data-testid=property-summary-table] thead th')].map((th) => th.textContent.trim())");
    assert.equal(headers.length, 18, '房产汇总 5 个固定列 + 13 个性质列');
    assert.ok(headers.includes('01 商品房') && headers.includes('13 私房'));
    assert.equal(await js("document.querySelectorAll('[data-testid=property-summary-table] tbody tr[data-office-row]').length"), 4);
    const total = await js("document.querySelector('[data-testid=property-summary-total]').textContent");
    assert.ok(total.includes('30'), '楼栋数合计');
    assert.ok(total.includes('1,220'), '房屋数合计');
    assert.ok(total.includes('1,161'), '业主数合计');
    assert.ok(total.includes('150460.75'), '建筑面积合计');
    assert.ok(total.includes('165'), '空房 06 合计');
    await screenshot('statistics-property-summary-1440.png');

    await js("(() => { window.__blobs = []; const original = window.URL.createObjectURL.bind(window.URL); window.URL.createObjectURL = (blob) => { window.__blobs.push(blob); return original(blob); }; })()");
    await js("document.querySelector('[data-testid=stats-export]').click()");
    await waitFor("window.__blobs.length >= 1", '房产汇总 CSV Blob');
    const exported = await js("(async () => { const blob = window.__blobs[0]; const bytes = new Uint8Array(await blob.arrayBuffer()).slice(0, 3); const text = await blob.text(); return { bom: [...bytes], title: text.includes('房产汇总'), nature: text.includes('01 商品房'), total: text.includes('合计') }; })()");
    assert.deepEqual(exported.bom, [0xEF, 0xBB, 0xBF]);
    assert.ok(exported.title && exported.nature && exported.total, '房产汇总 CSV 内容');
    await pause(2600);

    await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 900, deviceScaleFactor: 1, mobile: false });
    await pause(500);
    if (await js("!!document.querySelector('.stats-filter-float')")) {
      await js("document.querySelector('[data-testid=stats-filter-toggle]').click()");
      await pause(300);
    }
    assert.ok(await js('document.documentElement.scrollWidth <= innerWidth + 1'), '房产汇总 390 页面横向溢出');
    assert.ok(await js("(() => { const el = document.querySelector('.stats-property-scroll'); return el && el.scrollWidth > el.clientWidth; })()"), '房产汇总宽表应内部滚动');
    await screenshot('statistics-property-summary-390.png');
  });
});

test('P3-A 住户台账/楼房台账：关键词/分页/空值/合计/CSV/窄屏', { timeout: 180000 }, async () => {
  await withPage(async ({ js, call, waitFor, screenshot }) => {
    const setKeyword = async (value) => {
      await js(`(() => { const el = document.querySelector('[data-testid=ledger-keyword]'); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await pause(150);
    };
    await waitFor("!!document.querySelector('.stats')", '统计页挂载', 25000);
    await waitFor("!!document.querySelector('.stats-annual-table')", '默认年度表', 25000);

    // 住户台账：默认 200 户 + 总数 201；空手机/电话显示「—」。
    await js("document.querySelector('[data-report-type=\"owner-ledger\"]').click()");
    await waitFor("!!document.querySelector('[data-testid=owner-ledger-table]')", '住户台账表', 25000);
    const ownerQuery = await js("window.__calls.filter((c) => c.url === '/statistics/owner-ledger').slice(-1)[0].query");
    assert.equal(ownerQuery.limit, 200);
    assert.equal(ownerQuery.offset, 0);
    assert.ok(ownerQuery.natures.length > 0);
    assert.equal(await js("document.querySelectorAll('[data-testid=owner-ledger-table] tbody tr[data-s-id]').length"), 200);
    assert.ok((await js('document.body.textContent')).includes('201 户'), '显示总条数');
    const firstRow = await js("document.querySelector('[data-testid=owner-ledger-table] tbody tr[data-s-id]').textContent");
    assert.ok((firstRow.match(/—/g) || []).length >= 3, '手机/电话/业主空值显示 —');
    await screenshot('statistics-owner-ledger-1440.png');

    // 加载更多：offset=200，追加第 201 行。
    await js("document.querySelector('.stats-load-more button').click()");
    await waitFor("(() => { const list = window.__calls.filter((c) => c.url === '/statistics/owner-ledger'); const last = list[list.length - 1]; return last && last.query.offset === 200; })()", '住户台账加载更多 offset=200');
    await waitFor("document.querySelectorAll('[data-testid=owner-ledger-table] tbody tr[data-s-id]').length === 201", '住户台账 201 行');

    // 关键词：提交后请求带 keyword，列表收窄。
    await setKeyword('合成业主199');
    await js("document.querySelector('[data-testid=stats-submit]').click()");
    await waitFor("(() => { const list = window.__calls.filter((c) => c.url === '/statistics/owner-ledger'); const last = list[list.length - 1]; return last && last.query.keyword === '合成业主199'; })()", '住户台账关键词请求');
    await waitFor("document.querySelectorAll('[data-testid=owner-ledger-table] tbody tr[data-s-id]').length === 1", '住户台账关键词结果');

    // CSV：BOM、住户台账列头。
    await js("(() => { window.__blobs = []; const original = window.URL.createObjectURL.bind(window.URL); window.URL.createObjectURL = (blob) => { window.__blobs.push(blob); return original(blob); }; })()");
    await js("document.querySelector('[data-testid=stats-export]').click()");
    await waitFor("window.__blobs.length >= 1", '住户台账 CSV Blob');
    const ownerCsv = await js("(async () => { const blob = window.__blobs[0]; const bytes = new Uint8Array(await blob.arrayBuffer()).slice(0, 3); const text = await blob.text(); return { bom: [...bytes], title: text.includes('住户台账'), header: text.includes('序号,管理处,地址,房号,业主,手机,电话,建筑面积,房屋性质') }; })()");
    assert.deepEqual(ownerCsv.bom, [0xEF, 0xBB, 0xBF]);
    assert.ok(ownerCsv.title && ownerCsv.header, '住户台账 CSV 内容');
    await pause(2600);

    // 楼房台账：行/合计/关键词。
    await setKeyword('');
    await js("document.querySelector('[data-report-type=\"building-ledger\"]').click()");
    await waitFor("!!document.querySelector('[data-testid=building-ledger-table]')", '楼房台账表', 25000);
    assert.equal(await js("document.querySelectorAll('[data-testid=building-ledger-table] tbody tr[data-l-id]').length"), 3);
    const buildingTotal = await js("document.querySelector('[data-testid=building-ledger-total]').textContent");
    assert.ok(buildingTotal.includes('140'), '房屋数合计');
    assert.ok(buildingTotal.includes('133'), '业主数合计');
    assert.ok(buildingTotal.includes('14000.75'), '建筑面积合计');
    await screenshot('statistics-building-ledger-1440.png');
    await setKeyword('229弄');
    await js("document.querySelector('[data-testid=stats-submit]').click()");
    await waitFor("(() => { const list = window.__calls.filter((c) => c.url === '/statistics/building-ledger'); const last = list[list.length - 1]; return last && last.query.keyword === '229弄'; })()", '楼房台账关键词请求');
    await waitFor("document.querySelectorAll('[data-testid=building-ledger-table] tbody tr[data-l-id]').length === 1", '楼房台账关键词结果');
    await js("(() => { window.__blobs = []; const original = window.URL.createObjectURL.bind(window.URL); window.URL.createObjectURL = (blob) => { window.__blobs.push(blob); return original(blob); }; })()");
    await js("document.querySelector('[data-testid=stats-export]').click()");
    await waitFor("window.__blobs.length >= 1", '楼房台账 CSV Blob');
    const buildingCsv = await js("(async () => { const blob = window.__blobs[0]; const bytes = new Uint8Array(await blob.arrayBuffer()).slice(0, 3); const text = await blob.text(); return { bom: [...bytes], title: text.includes('楼房台账'), header: text.includes('序号,管理处,路,弄/号,楼号,房屋数,业主数,建筑面积') }; })()");
    assert.deepEqual(buildingCsv.bom, [0xEF, 0xBB, 0xBF]);
    assert.ok(buildingCsv.title && buildingCsv.header, '楼房台账 CSV 内容');
    await pause(2600);

    await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 900, deviceScaleFactor: 1, mobile: false });
    await pause(500);
    if (await js("!!document.querySelector('.stats-filter-float')")) {
      await js("document.querySelector('[data-testid=stats-filter-toggle]').click()");
      await pause(300);
    }
    assert.ok(await js('document.documentElement.scrollWidth <= innerWidth + 1'), '台账 390 页面横向溢出');
    await screenshot('statistics-building-ledger-390.png');
    await call('Emulation.setDeviceMetricsOverride', { width: 320, height: 900, deviceScaleFactor: 1, mobile: false });
    await pause(400);
    assert.ok(await js('document.documentElement.scrollWidth <= innerWidth + 1'), '台账 320 页面横向溢出');
  });
});

test('P4-A 减免情况统计/签报情况统计：日期关键词参数/合计/状态标签/CSV/窄屏', { timeout: 180000 }, async () => {
  await withPage(async ({ js, call, waitFor, screenshot }) => {
    const setInput = async (selector, value) => {
      await js(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await pause(150);
    };
    const setSelect = async (selector, value) => {
      await js(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; setter.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
      await pause(150);
    };
    await waitFor("!!document.querySelector('.stats')", '统计页挂载', 25000);
    await waitFor("!!document.querySelector('.stats-annual-table')", '默认年度表', 25000);
    const year = String(new Date().getFullYear());
    const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();

    // 减免情况统计
    await js("document.querySelector('[data-report-type=relief]').click()");
    await waitFor("!!document.querySelector('[data-testid=relief-table]')", '减免情况表', 25000);
    const reliefQuery = await js("window.__calls.filter((c) => c.url === '/statistics/relief').slice(-1)[0].query");
    assert.equal(reliefQuery.dateFrom, `${year}-01-01`, '减免日期默认今年');
    assert.equal(reliefQuery.dateTo, today);
    assert.equal(await js("document.querySelectorAll('[data-testid=relief-table] tbody tr[data-relief-id]').length"), 3);
    const reliefTotal = await js("document.querySelector('[data-testid=relief-total]').textContent");
    assert.ok(reliefTotal.includes('¥26,000.00'), '原应收合计');
    assert.ok(reliefTotal.includes('¥20,100.00'), '现应收合计');
    assert.ok(reliefTotal.includes('¥5,900.00'), '减免金额合计');
    await screenshot('statistics-relief-1440.png');
    await setInput('[data-testid=ledger-keyword]', '泊位');
    await js("document.querySelector('[data-testid=stats-submit]').click()");
    await waitFor("(() => { const list = window.__calls.filter((c) => c.url === '/statistics/relief'); const last = list[list.length - 1]; return last && last.query.keyword === '泊位'; })()", '减免关键词请求');
    await waitFor("document.querySelectorAll('[data-testid=relief-table] tbody tr[data-relief-id]').length === 1", '减免关键词结果');
    await js("(() => { window.__blobs = []; const original = window.URL.createObjectURL.bind(window.URL); window.URL.createObjectURL = (blob) => { window.__blobs.push(blob); return original(blob); }; })()");
    await js("document.querySelector('[data-testid=stats-export]').click()");
    await waitFor("window.__blobs.length >= 1", '减免 CSV Blob');
    const reliefCsv = await js("(async () => { const blob = window.__blobs[0]; const bytes = new Uint8Array(await blob.arrayBuffer()).slice(0, 3); const text = await blob.text(); return { bom: [...bytes], title: text.includes('减免情况统计'), header: text.includes('减免金额'), amount: text.includes('3000.00') }; })()");
    assert.deepEqual(reliefCsv.bom, [0xEF, 0xBB, 0xBF]);
    assert.ok(reliefCsv.title && reliefCsv.header && reliefCsv.amount, '减免 CSV 内容');
    await pause(2600);

    // 签报情况统计
    await setInput('[data-testid=ledger-keyword]', '');
    await js("document.querySelector('[data-report-type=signoffs]').click()");
    await waitFor("!!document.querySelector('[data-testid=signoffs-table]')", '签报情况表', 25000);
    const signoffsQuery = await js("window.__calls.filter((c) => c.url === '/statistics/signoffs').slice(-1)[0].query");
    assert.equal(signoffsQuery.dateFrom, `${year}-01-01`);
    assert.equal(signoffsQuery.status, 'all');
    assert.ok(await js("!!document.querySelector('[data-signoff-type=\"减免签报\"]')"), '签报类型从数据 distinct');
    const bodyText = await js('document.body.textContent');
    assert.ok(bodyText.includes('作废') && bodyText.includes('生效') && bodyText.includes('未结束'), '状态标签');
    assert.equal(await js("document.querySelector('[data-status=\"voided\"]').textContent.includes('作废')"), true);
    const signoffTotal = await js("document.querySelector('[data-testid=signoffs-total]').textContent");
    assert.ok(signoffTotal.includes('¥-2,900.00'), '调整金额合计');
    assert.ok(signoffTotal.includes('3 件'), '件数合计');
    await screenshot('statistics-signoffs-1440.png');

    // 类型多选 + 状态筛选参数
    await js("document.querySelector('[data-signoff-type=\"减免签报\"]').click()");
    await js("document.querySelector('[data-testid=stats-submit]').click()");
    await waitFor("(() => { const list = window.__calls.filter((c) => c.url === '/statistics/signoffs'); const last = list[list.length - 1]; return last && last.query.types === '减免签报' && last.query.status === 'all'; })()", '签报类型请求');
    await waitFor("document.querySelectorAll('[data-testid=signoffs-table] tbody tr[data-signoff-id]').length === 2", '签报类型结果');
    await js("document.querySelector('[data-signoff-type=\"减免签报\"]').click()");
    await setSelect('[data-testid=signoff-status]', 'voided');
    await js("document.querySelector('[data-testid=stats-submit]').click()");
    await waitFor("(() => { const list = window.__calls.filter((c) => c.url === '/statistics/signoffs'); const last = list[list.length - 1]; return last && last.query.status === 'voided' && last.query.types === ''; })()", '签报作废状态请求');
    await waitFor("document.querySelectorAll('[data-testid=signoffs-table] tbody tr[data-signoff-id]').length === 1", '签报作废结果');
    assert.equal(await js("document.querySelector('[data-status=\"voided\"]')?.textContent.includes('作废')"), true);

    await js("(() => { window.__blobs = []; const original = window.URL.createObjectURL.bind(window.URL); window.URL.createObjectURL = (blob) => { window.__blobs.push(blob); return original(blob); }; })()");
    await js("document.querySelector('[data-testid=stats-export]').click()");
    await waitFor("window.__blobs.length >= 1", '签报 CSV Blob');
    const signoffCsv = await js("(async () => { const blob = window.__blobs[0]; const bytes = new Uint8Array(await blob.arrayBuffer()).slice(0, 3); const text = await blob.text(); return { bom: [...bytes], title: text.includes('签报情况统计'), header: text.includes('调整金额') }; })()");
    assert.deepEqual(signoffCsv.bom, [0xEF, 0xBB, 0xBF]);
    assert.ok(signoffCsv.title && signoffCsv.header, '签报 CSV 内容');
    await pause(2600);

    await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 900, deviceScaleFactor: 1, mobile: false });
    await pause(500);
    if (await js("!!document.querySelector('.stats-filter-float')")) {
      await js("document.querySelector('[data-testid=stats-filter-toggle]').click()");
      await pause(300);
    }
    assert.ok(await js('document.documentElement.scrollWidth <= innerWidth + 1'), '签报/减免 390 页面横向溢出');
    assert.ok(await js("(() => { const el = document.querySelector('.stats-signoffs-scroll'); return el && el.scrollWidth > el.clientWidth; })()"), '签报宽表内部滚动');
    await screenshot('statistics-signoffs-390.png');
    await call('Emulation.setDeviceMetricsOverride', { width: 320, height: 900, deviceScaleFactor: 1, mobile: false });
    await pause(400);
    assert.ok(await js('document.documentElement.scrollWidth <= innerWidth + 1'), '签报/减免 320 页面横向溢出');
  });
});

test('统计选项未就绪：优先显示后端 message，不渲染空表', { timeout: 60000 }, async () => {
  await withPage(async ({ js, waitFor, screenshot }) => {
    await waitFor("document.body.textContent.includes('MIS 镜像尚未完成首次同步')", '选项未就绪说明');
    assert.equal(await js("!!document.querySelector('.stats-annual-table')"), false, '选项未就绪时不能渲染年度表');
    assert.equal(await js("document.body.textContent.includes('当前筛选没有可汇总的数据')"), false, '未就绪时不能只说暂无数据');
    assert.ok(await js("[...document.querySelectorAll('button')].some((e) => e.textContent.trim() === '重试')"), '未就绪要有重试');
    await screenshot('statistics-options-unavailable.png');
  }, '?options-unavailable');
});
