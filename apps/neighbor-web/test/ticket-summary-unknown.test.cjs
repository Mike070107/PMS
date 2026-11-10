const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

function load(relative, dependencies = {}) {
  const filename = path.resolve(__dirname, relative);
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { module, exports: module.exports, require: name => dependencies[name] || require(name) }, { filename });
  return module.exports;
}
const lib = load('../src/lib/statistics.ts');
const Table = load('../src/components/statistics/TicketSummaryTable.tsx', { '@/lib/statistics': lib }).default;
const query = { type: 'ticket-summary', dateFrom: '2026-10-01', dateTo: '2026-10-31', officeCodes: ['02'], feeCodes: [], paymentMethods: [], cashier: '=cashier' };
function fixture(value, ready) {
  const row = { feeCode: '01', feeName: '=SUM(A1)', methods: { 现金: 12345 }, receivedCents: 12345, refundCents: 0,
    netCents: 12345, ticketAmountCents: value, ticketTaxCents: value, ticketIncomeCents: value, ticketCount: value, rows: 1 };
  const cashier = { cashier: '=cashier', methods: { 现金: 12345 }, netCents: 12345, rows: 1 };
  return { available: true, partial: ready === false, ticketBlockReady: ready, ticketDataAsOf: ready ? '2026-11-01T00:00:00Z' : null,
    methodColumns: [{ key: '现金', label: '现金' }], rows: [row], totals: { ...row }, cashierRows: [cashier], cashierTotals: cashier };
}
function ticketSection(html) { return html.split('data-testid="ticket-summary-ticket-table"')[1].split('</table>')[0]; }

for (const value of [null, undefined]) {
  test(`summary unknown ${value} stays unknown in real production CSV and table`, () => {
    const report = fixture(value, false);
    const html = renderToStaticMarkup(React.createElement(Table, { report }));
    const section = ticketSection(html);
    assert.equal((section.match(/—/g) || []).length, 8);
    assert.doesNotMatch(section, /¥0\.00|>0</);
    const csv = lib.ticketSummaryCsv(report, query);
    assert.equal(csv.charCodeAt(0), 0xFEFF);
    assert.match(csv, /'\=SUM\(A1\),123\.45,123\.45/);
    assert.match(csv, /票据口径.*未就绪/);
    assert.match(csv, /收费项目,票据金额,税额,不含税收入,票据张数/);
    assert.match(csv, /'\=SUM\(A1\),,,,\r?\n/);
    assert.doesNotMatch(csv, /0\.00|\bnull\b|undefined/);
    assert.match(csv, /其中：按收款人/);
    assert.match(csv, /'\=cashier,123\.45,123\.45,1/);
    assert.match(html, /票据.*未就绪|镜像.*未同步/);
    assert.match(html, /¥123\.45/);
  });
}

test('summary ready zero stays calculable 0.00 and visible zero, unlike unknown', () => {
  const report = fixture(0, true);
  const csv = lib.ticketSummaryCsv(report, query);
  assert.match(csv, /'\=SUM\(A1\),0\.00,0\.00,0\.00,0/);
  const html = renderToStaticMarkup(React.createElement(Table, { report }));
  const section = ticketSection(html);
  assert.equal((section.match(/¥0\.00/g) || []).length, 6);
  assert.equal((section.match(/>0</g) || []).length, 2);
  assert.doesNotMatch(section, /—/);
  assert.doesNotMatch(html, /未就绪/);
});

test('legacy warning or partial metadata cannot make stale ticket zeros look ready', () => {
  const warned = { ...fixture(0, undefined), message: '票据镜像尚未同步，暂无法生成该报表' };
  const partial = { ...fixture(0, undefined), partial: true };
  for (const report of [warned, partial]) {
    assert.equal(lib.ticketSummaryTicketReady(report), false);
    assert.doesNotMatch(lib.ticketSummaryCsv(report, query), /0\.00|\bnull\b|undefined/);
    assert.equal((ticketSection(renderToStaticMarkup(React.createElement(Table, { report }))).match(/—/g) || []).length, 8);
  }
  const legacyReady = { ...fixture(0, undefined), message: null };
  assert.equal(lib.ticketSummaryTicketReady(legacyReady), true, 'legacy clean numeric response keeps real zero');
  assert.match(lib.ticketSummaryCsv(legacyReady, query), /'\=SUM\(A1\),0\.00,0\.00,0\.00,0/);
});

test('summary block readiness overrides stale zeros; absent values never stringify as null', () => {
  const report = fixture(0, false);
  const csv = lib.ticketSummaryCsv(report, query);
  assert.doesNotMatch(csv, /0\.00|\bnull\b|undefined/);
  const html = renderToStaticMarkup(React.createElement(Table, { report }));
  assert.equal((ticketSection(html).match(/—/g) || []).length, 8);
  const absent = fixture(undefined, undefined);
  const absentCsv = lib.ticketSummaryCsv(absent, query);
  assert.doesNotMatch(absentCsv, /0\.00|\bnull\b|undefined/);
  assert.match(renderToStaticMarkup(React.createElement(Table, { report: absent })), /未就绪/);
});
