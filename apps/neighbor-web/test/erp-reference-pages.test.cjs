const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, 'src', file), 'utf8');
const text = n => n == null || typeof n === 'boolean' ? '' : typeof n !== 'object' ? String(n) : Array.isArray(n) ? n.map(text).join('') : text(n.props?.children);
const nodes = n => !n || typeof n !== 'object' ? [] : Array.isArray(n) ? n.flatMap(nodes) : [n, ...nodes(n.props?.children)];
function load(file, deps = {}) {
 const module = { exports: {} };
 const code = ts.transpileModule(read(file), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
 vm.runInNewContext(code, { module, exports: module.exports, require: id => id in deps ? deps[id] : require(id), console });
 return module.exports;
}
const hooks = values => { let i=0; return { useState: init => [i < values.length ? values[i++] : (i++, typeof init === 'function' ? init() : init), () => {}], useMemo: fn => fn(), useEffect() {}, useId: () => 'chart-test' }; };
function reports(values) {
 return load('pages/Reports.tsx', { react: hooks(values), '@pms/api-client': {}, '@/lib/auth': { useSession: () => ({ access: { scopeAll: true } }) }, '@/lib/format': { money: v => `¥${v.toFixed(2)}` }, '@/components/Icon': { __esModule: true, default:'Icon' }, '@/components/DateInput': {__esModule:true,default:'DateInput'}, '@/components/ui': { Loading:'Loading' }, '@/legacy/components/FeeReportCharts': { FeeTrendChart:'FeeTrendChart', FeeBreakdownChart:'FeeBreakdownChart' }, './erp-reference-pages.css': {} }).default();
}
test('Reports loading and errors do not render manufactured KPI zeros or charts', () => {
 const loading = reports([[], '2026-11-01', '2026-11-05', 0, null, '']);
 assert.ok(nodes(loading).some(n => n.type === 'Loading'));
 assert.equal(nodes(loading).filter(n => n.props?.className === 'stat').length, 0);
 const error = reports([[], '2026-11-01', '2026-11-05', 0, null, '真实读取失败']);
 assert.ok(text(error).includes('真实读取失败'));
 assert.equal(nodes(error).some(n => n.type === 'FeeTrendChart'), false);
});
test('Reports preserves server totals, real signed trend and all breakdown sources without generating curve points', () => {
 const totals = { netCents: -1234, refundedCents: 500, receiptCount: 3, houseCount: 2 };
 const report = { totals, growth: {netCents:0,receiptCount:0,houseCount:0}, trend:[{day:'2026-11-01',amountCents:-1234,count:3}], byFee:[],byMethod:[],byCommunity:[],byCashier:[] };
 const tree = reports([[], '2026-11-01', '2026-11-05', 0, report, '']);
 assert.equal(nodes(tree).filter(n => n.props?.className === 'stat').length, 4);
 assert.ok(text(tree).includes('¥-12.34'));
 const trend = nodes(tree).find(n => n.type === 'FeeTrendChart');
 assert.equal(trend.props.rows.length, 1);
 assert.equal(trend.props.rows[0].amountCents, -1234);
 assert.equal(nodes(tree).filter(n => n.type === 'DateInput' && n.props.type === 'date').length, 2);
 assert.ok(nodes(tree).some(n => n.type === 'select' && n.props.value === 0));
});
test('Reused breakdown chart gives zero no visible amount and signed amounts opposite sides of baseline', () => {
 const { FeeBreakdownChart } = load('legacy/components/FeeReportCharts.tsx', { react:hooks([]), antd:{Spin:'Spin',Empty:'Empty'}, '@pms/shared-types':{formatFeeMoney: v => String(v)} });
 const tree = FeeBreakdownChart({ loading:false, rows:[{key:'zero',name:'零',amountCents:0,count:0,share:null},{key:'plus',name:'正',amountCents:100,count:1,share:100},{key:'minus',name:'负',amountCents:-100,count:1,share:-100}] });
 const bars = nodes(tree).filter(n => n.type === 'i');
 assert.equal(bars[0].props.style.width, '0%');
 assert.equal(bars[1].props.style.left, '50%');
 assert.equal(bars[2].props.style.left, '0%');
});
test('Reports reuses the existing signed trend chart with accessible stable target and responsive breakdown cards', () => {
 const source = read('pages/Reports.tsx');
 assert.match(source, /FeeTrendChart/);
 assert.match(source, /data-testid="reports-trend-chart"/);
 assert.match(source, /erp-report-breakdowns/);
 assert.match(source, /<table/);
 assert.doesNotMatch(source, /Math\.max\(2,.*amountCents/);
});
test('Existing chart renders actual signed values on distinct Y positions with focus detail and zero baseline', () => {
 const chart = load('legacy/components/FeeReportCharts.tsx', { react: hooks([]), antd: { Spin: 'Spin', Empty: 'Empty' }, '@pms/shared-types': { formatFeeMoney: cents => `¥${cents / 100}` } });
 const tree = chart.FeeTrendChart({ rows: [{bucket:'a',amountCents:12000,count:2},{bucket:'b',amountCents:0,count:0},{bucket:'c',amountCents:-4000,count:1}], loading:false,label:b=>b });
 const points = nodes(tree).filter(n => n.type === 'circle');
 assert.equal(new Set(points.map(n => n.props.cy)).size, 3);
 assert.ok(points.every(n => n.props.tabIndex === 0 && typeof n.props.onFocus === 'function'));
 assert.ok(points[2].props['aria-label'].includes('-40'));
 assert.ok(nodes(tree).some(n => n.props?.className === 'fees-chart-zero'));
});
