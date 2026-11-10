const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

// Execute the production pure functions, without a server or synthetic transport.
const filename = path.resolve(__dirname, '../src/lib/statistics.ts');
const moduleUnderTest = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { module: moduleUnderTest, exports: moduleUnderTest.exports }, { filename });
const { REPORTS, PENDING_REPORTS, annualQueryParams, detailQueryParams, collectionDetailTotal } = moduleUnderTest.exports;
const plain = value => JSON.parse(JSON.stringify(value));
const base = {
  officeCodes: ['01', '02'], feeCodes: ['01', '04'], natures: ['01', '06'],
  yearFrom: 2025, yearTo: 2026, asOfPeriod: '202610',
  paidDateFrom: '2026-01-01', paidDateTo: '2026-10-31',
};

test('annual received menu explains period-year receipt-flow semantics, not paid-year net receipts', () => {
  const hint = REPORTS.find(report => report.type === 'received').hint;
  assert.match(hint, /应收年月.*年度/);
  assert.match(hint, /已收流水/);
  assert.doesNotMatch(hint, /按收款日期年度|退款红冲负数/);
});

test('all 30 legacy statistics menus retain an implemented or honestly pending identity', () => {
  // Golden menu inventory: legacy ApplicationModule parent 179, reviewed 2026-11-10.
  // Shared abilities are not an acceptance of the four dedicated old arrears/prepaid templates.
  const legacy = [
    ['房产汇总', 'property-summary'], ['住户台帐', 'owner-ledger'], ['楼室台帐', 'building-ledger'],
    ['应收帐销账情况'], ['收款分析', 'collection-analysis'], ['收款日报表', 'daily'],
    ['收款汇总表', 'ticket-summary'], ['综合月报表B', null, '综合月报表 B/C'],
    ['欠收与溢收汇总', 'arrears-prepaid'], ['收费汇总', 'fee-nature'], ['物业收款汇总'],
    ['收退款明细统计'], ['空房情况统计'], ['日常收费项目收款日报表', 'daily-fees'],
    ['分等综合月报表'], ['项目实收年度汇总', 'received'], ['项目欠费年度汇总', 'arrears'],
    ['签报情况统计', 'signoffs'], ['能耗环比分析图表'], ['能耗同比分析图表'], ['能耗分析统计图表'],
    ['开票数据统计', 'ticket-items'], ['减免情况统计', 'relief'], ['收费标准汇总'], ['月报表'],
    ['项目欠费统计'], ['项目欠费汇总统计'], ['项目溢收统计'], ['项目溢收汇总统计'],
    ['收缴考核', 'assessment'],
  ];
  assert.equal(legacy.length, 30);
  assert.equal(new Set(legacy.map(([name]) => name)).size, 30);
  for (const [name, type, pendingName] of legacy) {
    assert.ok(type ? REPORTS.some(report => report.type === type) : PENDING_REPORTS.includes(pendingName || name),
      `${name} must retain an explicit current or pending identity; shared APIs do not prove old-template acceptance`);
  }
  assert.equal(new Set(PENDING_REPORTS).size, PENDING_REPORTS.length, 'no duplicate disabled labels');
});

for (const type of ['received', 'arrears']) {
  test(`annual ${type} and detail retain identical applied multi-select/date scope`, () => {
    const query = { ...base, type };
    const annual = annualQueryParams(query);
    const detail = detailQueryParams({ ...query, officeCode: '02', year: 2025 });
    assert.equal(annual.officeCodes, '01,02');
    assert.equal(detail.officeCode, '02');
    assert.equal(detail.year, 2025);
    for (const key of ['type', 'feeCodes', 'natures', 'asOfPeriod', 'paidDateFrom', 'paidDateTo']) {
      assert.equal(detail[key], annual[key], key);
    }
    assert.equal(annual.feeCodes, '01,04');
    assert.equal(annual.natures, '01,06');
    assert.equal(annual.asOfPeriod, type === 'arrears' ? '202610' : undefined);
    assert.equal(annual.paidDateFrom, type === 'received' ? '2026-01-01' : undefined);
    assert.equal(annual.paidDateTo, type === 'received' ? '2026-10-31' : undefined);
    const snapshot = plain(annual);
    query.feeCodes = ['16'];
    query.natures = ['13'];
    query.paidDateFrom = '2026-11-01';
    assert.deepEqual(plain(annual), snapshot, 'a later draft must not mutate issued parameters');
  });
}

test('annual empty dates stay omitted and blank multi-select means all', () => {
  const query = { ...base, type: 'received', officeCodes: [], feeCodes: [], natures: [], paidDateFrom: '', paidDateTo: '' };
  const annual = annualQueryParams(query);
  assert.equal(annual.officeCodes, '');
  assert.equal(annual.feeCodes, '');
  assert.equal(annual.natures, '');
  assert.equal(annual.paidDateFrom, undefined);
  assert.equal(annual.paidDateTo, undefined);
  assert.equal(annual.asOfPeriod, undefined);
});

test('collection classified totals use independent whole-query totals, not the displayed page sum', () => {
  const response = { rows: [{ amountCents: 1 }], totalCents: 999, available: true,
    totals: { receivedCents: 8000000, refundCents: 15000, adjustCents: -60000, netCents: 7925000 } };
  assert.equal(collectionDetailTotal(response, 'received'), 8000000);
  assert.equal(collectionDetailTotal(response, 'refund'), 15000);
  assert.equal(collectionDetailTotal(response, 'adjust'), -60000);
  assert.equal(collectionDetailTotal(response, 'all'), 7925000);
});

test('collection totals distinguish unavailable, absent, legacy and genuine zero', () => {
  const totals = { receivedCents: 0, refundCents: 0, adjustCents: 0, netCents: 0 };
  for (const kind of ['all', 'received', 'refund', 'adjust']) {
    assert.equal(collectionDetailTotal({ available: false, totals, totalCents: 999 }, kind), null);
    assert.equal(collectionDetailTotal({}, kind), null);
    assert.equal(collectionDetailTotal({ available: true, totals }, kind), 0);
  }
  assert.equal(collectionDetailTotal({ totalCents: -15000 }, 'all'), -15000);
  assert.equal(collectionDetailTotal({ totalCents: 0 }, 'received'), 0);
});
