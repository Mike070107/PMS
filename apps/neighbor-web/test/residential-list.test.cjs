// Isolated real-source hook/JSX regression. Synthetic fixtures, never live MIS.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
function harness() {
  let cursor = 0, dirty = false, timerId = 0;
  const slots = [], effects = [], timers = new Map(), requests = [];
  const session = { user: { id: 1 }, access: { scopeAll: true }, actingOffice: null };
  const react = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], value => { const next = typeof value === 'function' ? value(slots[i]) : value; if (next !== slots[i]) { slots[i] = next; dirty = true; } }]; },
    useRef(initial) { const i = cursor++; return slots[i] ?? (slots[i] = { current: initial }); },
    useEffect(fn, deps) { const i = cursor++; const prev = slots[i]; if (!prev || deps.some((d, j) => d !== prev.deps[j])) { effects.push(() => { prev?.cleanup?.(); slots[i] = { deps, cleanup: fn() }; }); } },
  };
  const helperSource = fs.readFileSync(path.resolve(__dirname, '../src/lib/residential-bills.ts'), 'utf8');
  const helperModule = { exports: {} };
  vm.runInNewContext(ts.transpileModule(helperSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { module: helperModule, exports: helperModule.exports, require, console });
  let source = fs.readFileSync(path.resolve(__dirname, '../src/pages/ResidentialBills.tsx'), 'utf8');
  const anchor = ' const s=dash.data?.summary';
  assert.equal(source.split(anchor).length, 2);
  source = source.replace(anchor, ' globalThis.__port={tab,community,filter,ready,valid,page,status,list,meta,dash,checked,detail,setTab,setCommunity,setFrom,setTo,setPage,setFee,setCategory,setTerm,setStatus,setChecked,setDetail};\n' + anchor);
  const module = { exports: {} };
  const sandbox = { module, exports: module.exports, console, Error,
    setTimeout(fn) { timers.set(++timerId, fn); return timerId; }, clearTimeout(id) { timers.delete(id); },
    crypto: { randomUUID: () => 'synthetic-only' },
    require(id) {
      if (id === 'react') return react;
      if (id === 'react/jsx-runtime') return require(id);
      if (id === '@pms/api-client') return { request: o => { assert.ok(!o.method || o.method === 'GET', 'probe must never write'); return new Promise((resolve, reject) => requests.push({ o, resolve, reject })); } };
      if (id === '@/lib/auth') return { useSession: () => session };
      if (id === '@/lib/perm') return { can: () => false };
      if (id === '@/lib/residential-bills') return helperModule.exports;
      return { __esModule: true, default: () => null, FollowupCell:'FollowupCell', Card: 'Card', Empty: 'Empty', ErrorNote: 'ErrorNote', Sheet: 'Sheet', toast() {} };
    },
  };
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText, sandbox);
  function render() { let n = 0, ui; do { dirty = false; cursor = 0; ui = module.exports.default(); while (effects.length) effects.shift()(); assert.ok(++n < 40, 'hooks settle'); } while (dirty); return { ...sandbox.__port, ui }; }
  function flushTimers() { const jobs = [...timers.values()]; timers.clear(); jobs.forEach(fn => fn()); }
  async function settle() { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); return render(); }
  async function metadata(data = options) { render(); flushTimers(); requests.at(-1).resolve(data); return settle(); }
  async function respond(data = households) { flushTimers(); requests.at(-1).resolve(data); return settle(); }
  return { render, flushTimers, settle, metadata, respond, requests, session };
}
const options = { available: true, message: '', communities: [{ id: 17, name: '合成测试小区' }], feeItems: [{ code: 'P', name: '物业费' }] };
const row = { houseKey: 'SYNTHETIC:17:1', address: '合成测试小区/1号101室', ownerName: '合成责任人', amountCents: 12345, periodFrom: '202601', periodTo: '202612', billCount: 1, phoneMasked: '测试无真实号码' };
const households = { rows: [row], total: 41, amountCents: 12345, queriedAt: '2026-11-05T00:00:00Z' };
function text(node) { if (node == null || typeof node === 'boolean') return ''; if (typeof node !== 'object') return String(node); if (Array.isArray(node)) return node.map(text).join(''); if (node.type?.name === 'State') { const v = node.props.value; return v.loading ? '正在读取MIS' : v.error || text(node.props.children); } return text(node.props?.children); }
function nodes(node, predicate) { if (!node || typeof node !== 'object') return []; if (Array.isArray(node)) return node.flatMap(n => nodes(n, predicate)); return [...(predicate(node) ? [node] : []), ...nodes(node.props?.children, predicate)]; }
const householdRequests = h => h.requests.filter(r => r.o.query?.view === 'households');

test('切换到overview后选小区/账期只请求dashboard/trend/communities，没有households', async () => {
  const h = harness(); let p = await h.metadata(); p.setTab('overview'); p.setCommunity('17'); p.setFrom('2026-01'); p.setTo('2026-12'); p = h.render(); h.flushTimers();
  assert.equal(p.tab, 'overview'); assert.equal(p.ready, true); assert.equal(householdRequests(h).length, 0);
  assert.deepEqual(h.requests.filter(r => r.o.query?.view).map(r => r.o.query.view).sort(), ['communities', 'dashboard', 'trend'], 'overview 固定读取 总览/趋势/小区对比 三个视图，不得额外请求 households');
  assert.doesNotMatch(text(p.ui), /待缴责任对象|合成责任人/);
});

test('打开默认待缴清单，选择小区和账期后直接显示住户', async () => {
  const h = harness(); let p = await h.metadata(); p.setCommunity('17'); p.setFrom('2026-01'); p.setTo('2026-12'); h.render(); h.flushTimers();
  assert.ok(householdRequests(h).length > 0, '选择范围后仍停overview：根本未请求households，合成有记录响应也无处返回');
  householdRequests(h).at(-1).resolve(households); p = await h.settle();
  assert.equal(p.tab, 'houses'); assert.match(text(p.ui), /合成责任人/);
  assert.deepEqual(nodes(p.ui, n => n.type === 'button' && n.props['data-tab']).map(n => n.props['data-tab']), ['overview', 'houses', 'history']);
});

test('houses：选范围发unpaid/households并渲染合成记录，非MIS真实余额', async () => {
  const h = harness(); let p = await h.metadata(); p.setTab('houses'); p.setCommunity('17'); p.setFrom('2026-01'); p.setTo('2026-12'); h.render(); p = await h.respond();
  const q = householdRequests(h).at(-1).o.query;
  assert.equal(q.communityId, 17); assert.equal(q.periodFrom, '202601'); assert.equal(q.periodTo, '202612'); assert.equal(q.status, 'unpaid'); assert.equal(q.page, 1); assert.equal(q.pageSize, 20);
  assert.match(text(p.ui), /待缴责任对象 41 个/); assert.match(text(p.ui), /合成责任人/); assert.match(text(p.ui), /123\.45/);
});

test('houses：清空账期维持houses、去掉两端账期并重置分页/选择/明细', async () => {
  const h = harness(); let p = await h.metadata(); p.setTab('houses'); h.render(); p = await h.respond(); p.setPage(3); p.setChecked([row.houseKey]); p.setDetail(row); p = h.render();
  const button = nodes(p.ui, n => n.type === 'button' && text(n) === '含往年全部账期')[0]; button.props.onClick(); p = h.render(); h.flushTimers();
  assert.equal(p.tab, 'houses'); assert.equal(p.page, 1); assert.equal(p.checked.length, 0); assert.equal(p.detail, null);
  const q = householdRequests(h).at(-1).o.query; assert.equal(q.periodFrom, undefined); assert.equal(q.periodTo, undefined); assert.equal(q.page, 1);
});

test('houses：收费项目/分类/搜索/状态/工作处变化均重置分页，工作处变化清小区', async () => {
  const h = harness(); let p = await h.metadata(); p.setTab('houses'); p = h.render();
  for (const [setter, value] of [['setFee', 'P'], ['setCategory', 'property'], ['setTerm', '合成'], ['setStatus', 'paid'], ['setCommunity', '17']]) { p.setPage(3); p = h.render(); p[setter](value); p = h.render(); assert.equal(p.page, 1, setter); }
  p.setPage(3); h.render(); h.session.actingOffice = { id: 99 }; p = h.render(); assert.equal(p.page, 1); assert.equal(p.community, ''); assert.equal(p.tab, 'houses');
});

test('ready：非法倒序账期禁止请求；metadata unavailable禁止houses', async () => {
  const h = harness(); let p = await h.metadata(); p.setTab('houses'); p.setFrom('2026-12'); p.setTo('2026-01'); p = h.render(); h.flushTimers();
  assert.equal(p.ready, false); assert.equal(householdRequests(h).length, 0); assert.match(text(p.ui), /开始月份不能晚于结束月份/);
  const unavailable = harness(); p = await unavailable.metadata({ ...options, available: false, message: '合成来源未就绪' }); p.setTab('houses'); p = unavailable.render(); unavailable.flushTimers(); assert.equal(householdRequests(unavailable).length, 0); assert.match(text(p.ui), /合成来源未就绪/);
});

test('houses：loading/error/empty明确区分，失败不宣称零账单', async () => {
  const h = harness(); let p = await h.metadata(); p.setTab('houses'); p = h.render(); assert.equal(p.list.loading, true); assert.match(text(p.ui), /正在读取MIS/); assert.doesNotMatch(text(p.ui), /当前范围没有对应账单/);
  h.flushTimers(); householdRequests(h).at(-1).reject(new Error('合成MIS超时')); p = await h.settle(); assert.equal(p.list.error, '合成MIS超时'); assert.match(text(p.ui), /合成MIS超时/); assert.doesNotMatch(text(p.ui), /当前范围没有对应账单/);
  p.setTerm('成功空响应'); h.render(); p = await h.respond({ ...households, rows: [], total: 0, amountCents: 0 }); assert.match(text(p.ui), /当前范围没有对应账单/);
});

test('houses：已发出的旧范围请求成功/失败不覆盖新范围loading和记录', async () => {
  for (const rejectOld of [false, true]) {
    const h = harness(); let p = await h.metadata(); p.setTab('houses'); h.render(); h.flushTimers(); const old = householdRequests(h).at(-1);
    p = h.render(); p.setCommunity('17'); h.render(); h.flushTimers(); const fresh = householdRequests(h).at(-1);
    rejectOld ? old.reject(new Error('旧范围错误')) : old.resolve({ ...households, rows: [{ ...row, ownerName: '旧范围不可见' }] }); p = await h.settle(); assert.equal(p.list.loading, true); assert.equal(p.list.error, '');
    fresh.resolve(households); p = await h.settle(); assert.match(text(p.ui), /合成责任人/); assert.doesNotMatch(text(p.ui), /旧范围不可见|旧范围错误/);
  }
});
