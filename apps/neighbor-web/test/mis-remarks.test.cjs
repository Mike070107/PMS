// Real TSX + real mapping/handlers; isolated hooks/API fixtures, not browser E2E.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { renderToStaticMarkup } = require('react-dom/server');
const text = n => n == null || typeof n === 'boolean' ? '' : typeof n !== 'object' ? String(n) : Array.isArray(n) ? n.map(text).join('') : text(n.props?.children);
const nodes = n => !n || typeof n !== 'object' ? [] : Array.isArray(n) ? n.flatMap(nodes) : [n, ...nodes(n.props?.children)];
function harness(file, props = {}) {
  let cursor = 0, dirty = false, ui;
  const slots = [], effects = [], requests = [];
  const react = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], value => { const next = typeof value === 'function' ? value(slots[i]) : value; if (!Object.is(next, slots[i])) { slots[i] = next; dirty = true; } }]; },
    useEffect(fn, deps) { const i = cursor++; if (!slots[i] || deps.some((x, k) => !Object.is(x, slots[i][k]))) { slots[i] = deps; effects.push(fn); } },
    useMemo(fn) { return fn(); }, useCallback(fn) { return fn; },
  };
  const module = { exports: {} };
  const stub = name => ({ __esModule: true, default: name });
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../src', file), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
    module, exports: module.exports, console, Error,
    require(id) {
      if (id === 'react-router-dom') return { useNavigate: () => () => {} };
      if (id === 'react') return react;
      if (id === 'react/jsx-runtime') return require(id);
      if (id === '@pms/api-client') return { address: { tree: () => Promise.resolve([]) }, request: o => { assert.ok(!o.method || o.method === 'GET', 'remarks must not write'); return new Promise((resolve, reject) => requests.push({ o, resolve, reject })); } };
      if (id === '@/lib/auth') return { useSession: () => ({ access: { scopeAll: true } }) };
      if (id === '@/lib/format') return { money: n => n.toFixed(2), payLabel: n => n || '—' };
      if (id === '@/components/ui') return { ErrorNote: 'ErrorNote', toast() {} };
      if (id.endsWith('.css')) return {};
      return stub(id.split('/').at(-1));
    },
  });
  function render() { let count = 0; do { cursor = 0; dirty = false; ui = module.exports.default(props); while (effects.length) effects.shift()(); assert.ok(++count < 30); } while (dirty); return ui; }
  const find = (type, match = () => true) => { const n = nodes(ui).find(n => n.type === type && match(n)); assert.ok(n, 'missing ' + type); return n; };
  render();
  return { render, find, nodes: () => nodes(ui), requests, async settle() { await new Promise(r => setImmediate(r)); return render(); } };
}
const house = { id: 712, roomNo: '502', buildingNo: '3', communityName: '合成小区', communityId: 21, lane: '228', owner: null };
const fixtures = ['  原始文本  ', undefined, null, '', ' \t\n ', '长备注' + '1234567890'.repeat(60) + '\n第二行\n<img src=x onerror="globalThis.__remarkExecuted=true"><script>globalThis.__remarkExecuted=true</script>'];
const rows = feeName => fixtures.map((remark, i) => ({ id: feeName + i, feeName, feeCode: 'P', period: '202601', amountCents: 12345, status: 'unpaid', paidAt: '2026-01-02', receiptNo: 'SYNTHETIC', remark }));
function assertRemarks(h, unpaid) {
  const remarks = h.nodes().filter(n => n.props?.className?.split(' ').includes('mis-remark-value'));
  assert.equal(remarks.length, fixtures.length, 'every real mapped/rendered row needs a remark');
  assert.deepEqual(remarks.map(text), fixtures.map(v => v?.trim() ? v : '—'));
  for (const n of remarks) {
    assert.equal(n.props.dangerouslySetInnerHTML, undefined);
    const html = renderToStaticMarkup(n);
    assert.ok(!html.includes('<script>') && !html.includes('<img '), 'HTML tags must remain escaped text');
  }
  if (unpaid) {
    const bills = h.nodes().filter(n => n.type === 'button' && n.props.className?.startsWith('billRow'));
    assert.equal(bills.length, fixtures.length);
    assert.ok(bills.every(n => nodes(n).some(x => text(x) === '备注')));
    assert.ok(bills.every(n => nodes(n).filter(x => x.props?.className === 'ba money').map(text).join() === '123.45'));
    assert.equal(nodes(bills[0].props.children).filter(n => ['ck', 'bt', 'ba money'].includes(n.props?.className)).length, 3);
    assert.match(bills[0].props.className, /sel/); bills[0].props.onClick(); h.render();
    assert.doesNotMatch(h.nodes().find(n => n.type === 'button' && n.props.className?.startsWith('billRow')).props.className, /sel/);
    const panel=h.find('MisCollectionPanel');assert.equal(panel.props.houseId,712);assert.equal(panel.props.bills.length,fixtures.length-1);assert.ok(['物业费','泊位费'].includes(panel.props.label));
  } else {
    assert.equal(h.nodes().filter(n => n.type === 'th').map(text).at(-1), '备注');
    assert.equal(h.nodes().filter(n => n.type === 'th').length, 7);
  }
}
test('真实 Cashier MIS mapping → 物业费/泊位费待缴行备注，保留原文、空值占位和只读/选择/金额', async () => {
  const h = harness('pages/Cashier.tsx');
  h.find('UniSearch').props.onPick({ kind: 'house', hit: house, all: { houses: [house], vehicles: [], accessCards: [] } });
  h.render();
  const req = h.requests.find(r => r.o.url === '/fees/mis/bills');
  assert.deepEqual(JSON.parse(JSON.stringify(req.o.query)), { houseId: 712, status: 'unpaid', page: 1, pageSize: 300 });
  req.resolve({ rows: [...rows('物业费'), ...rows('泊位费')] }); await h.settle();
  assertRemarks(h, true);
  h.find('button', n => n.props.className?.startsWith('projTab') && text(n).startsWith('泊位费')).props.onClick(); h.render();
  assertRemarks(h, true);
});
test('真实历史表置于横向滚动容器，局部样式保留换行并拆开长数字而非裁切', async () => {
  const h = harness('components/cashier/PaidHistory.tsx', { houseId: 712, label: '物业费', match: () => true });
  h.find('button', n => n.props.className === 'hist-hd').props.onClick(); h.render();
  h.requests[0].resolve({ rows: rows('物业费') }); await h.settle();
  const wrapper = h.nodes().find(n => n.props?.className?.includes('mis-paid-scroll'));
  assert.ok(wrapper && nodes(wrapper).some(n => n.type === 'table'), 'real history table must have its own horizontal scroll container');
  const css = fs.readFileSync(path.resolve(__dirname, '../src/components/cashier/mis-remarks.css'), 'utf8');
  assert.match(css, /white-space:\s*pre-wrap/); assert.match(css, /overflow-wrap:\s*anywhere/);
  assert.match(css, /\.mis-paid-scroll\s*\{[^}]*overflow-x:\s*auto/s);
  assert.match(css, /table-layout:\s*fixed/);
  assert.doesNotMatch(css, /line-clamp|text-overflow:\s*ellipsis|overflow:\s*hidden|grid-template-columns/);
  for (const file of ['pages/Cashier.tsx', 'components/cashier/PaidHistory.tsx']) assert.match(fs.readFileSync(path.resolve(__dirname, '../src', file), 'utf8'), /import ['"][^'"]*mis-remarks\.css['"]/);
});
test('真实 PaidHistory 延迟只读请求 → 物业费/泊位费历史独立备注列', async () => {
  for (const feeName of ['物业费', '泊位费']) {
    const h = harness('components/cashier/PaidHistory.tsx', { houseId: 712, label: feeName, match: n => n === feeName });
    assert.equal(h.requests.length, 0);
    h.find('button', n => n.props.className === 'hist-hd').props.onClick(); h.render();
    assert.deepEqual(JSON.parse(JSON.stringify(h.requests[0].o.query)), { houseId: 712, status: 'paid', page: 1, pageSize: 500 });
    h.requests[0].resolve({ rows: [...rows('物业费'), ...rows('泊位费')] }); await h.settle(); assertRemarks(h, false);
  }
});
