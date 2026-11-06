// Read-only source isolation: real TS/TSX + JSX, no API/DB, no browser/E2E claim.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const nativeRequire = require;
function load(file, deps = {}, suffix = '') {
  // Substitute Vite's build-time BASE_URL only; all business code runs unchanged.
  const source = fs.readFileSync(file, 'utf8').replaceAll('import.meta.env.BASE_URL', JSON.stringify('/')) + '\n' + suffix;
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, URLSearchParams, console, require(id) {
    if (id.endsWith('.css')) return {};
    if (id in deps) return deps[id];
    if (id.startsWith('.')) return load(path.resolve(path.dirname(file), id + '.ts'));
    if (id.startsWith('@/')) throw Error('Unexpected internal dependency: ' + id);
    if (id === '@pms/shared-types') return shared;
    return nativeRequire(id);
  } }, { filename: file });
  return module.exports;
}
const shared = load(path.resolve(root, '../../packages/shared-types/src/index.ts'), { './pages': {}, './address': {}, './natural-order': {} });
const format = load(path.join(root, 'src/lib/format.ts'));
const ui = load(path.join(root, 'src/components/ui.tsx'), { '@/lib/format': format, react: {} });
const text = n => n == null || typeof n === 'boolean' ? '' : typeof n !== 'object' ? String(n) : Array.isArray(n) ? n.map(text).join('') : text(n.props?.children);
function nodes(n) {
  if (!n || typeof n !== 'object') return [];
  if (Array.isArray(n)) return n.flatMap(nodes);
  return [n, ...nodes(n.props?.children), ...nodes(n.props?.headExtra)];
}
function hooks(values) {
  let i = 0;
  return { useState(init) { const at = i++; return [at < values.length ? values[at] : typeof init === 'function' ? init() : init, () => {}]; }, useRef: v => ({current:v}), useMemo: fn => fn(), useCallback: fn => fn, useEffect() {} };
}
const base = { requestId: 1, communityId: 1, assigneeId: null, assigneeName: null, candidateIds: [], createdAt: '2026-01-01T00:00:00Z', slaDueAt: '2000-01-01T00:00:00Z', summaryContent: '隔离测试', urgent: false };
const orders = [
  { ...base, id: 1, orderNo: 'unmatched', summaryAddress: 'unmatched', status: 'created', repairType: null },
  { ...base, id: 2, orderNo: 'candidate', summaryAddress: 'candidate', status: 'created', repairType: 'plumbing', candidateIds: [11, 12] },
  { ...base, id: 3, orderNo: 'assigned', summaryAddress: 'assigned', status: 'dispatched', assigneeId: 11, assigneeName: '测试工甲', candidateIds: [11] },
  { ...base, id: 4, orderNo: 'accepted', summaryAddress: 'accepted', status: 'in_progress', assigneeId: 11, assigneeName: '测试工甲', candidateIds: [11], acceptedAt: '2026-01-02T00:00:00Z' },
];
const stubs = { ...ui, Card: 'Card', ErrorNote: 'ErrorNote', Loading: 'Loading', Sheet: 'Sheet', toast() {} };
function component(file, values, query = '', suffix = '') {
  return load(path.join(root, 'src', file), {
    react: hooks(values),
    'react-router-dom': { useSearchParams: () => [new URLSearchParams(query), () => {}], useNavigate: () => () => {} },
    '@pms/api-client': { repairs: {}, request() { throw Error('No requests allowed'); } },
    '@/lib/format': format, '@/lib/address-tree': { useAddressTree: () => ({ communities: [] }) },
    '@/lib/auth': { useSession: () => ({ user: {}, access: {} }) },
    '@/components/ui': stubs,
    ...Object.fromEntries(['NewOrderSheet', 'WorkOrderSheet', 'AddressSearch', 'ToneIcon', 'Icon', 'MaterialPicker', 'HousePicker'].map(k => ['@/components/' + k, { __esModule: true, default: k }])),
  }, suffix);
}
function workOrders(query) { return component('pages/WorkOrders.tsx', [orders, ''], query).default(); }
function chip(tree, label) { const n = nodes(tree).find(n => n.type === 'button' && n.props.className?.includes('chip') && text(n).startsWith(label)); assert.ok(n, 'missing chip ' + label); return n; }
function rows(tree) { return nodes(tree).filter(n => n.type === 'tr' && n.props.className?.startsWith('row')).map(n => n.key); }
function cards(tree) { return nodes(tree).filter(n => n.props?.className?.startsWith('wc ')).map(n => n.key); }

test('真实 stageOf/statusOf/Pill：未匹配、候选、已派、接单四类映射一致', () => {
  assert.deepEqual(orders.map(o => format.stageOf(o)), ['created', 'pending_accept', 'pending_accept', 'in_progress']);
  assert.deepEqual(orders.map(o => text(ui.Pill({ status: format.stageOf(o) }))), ['待派单', '待接单', '待接单', '维修中']);
  assert.equal(format.statusOf('dispatched').name, '待接单');
});
test('真实 BOARD_COLUMNS 与 stageOf 对齐：四类每单只落一列，没有 dispatched 重复列', () => {
  for (const o of orders) assert.equal(format.BOARD_COLUMNS.filter(s => s === format.stageOf(o)).length, 1);
  assert.equal(format.BOARD_COLUMNS.includes('dispatched'), false);
  assert.equal(new Set(format.BOARD_COLUMNS).size, 5);
});
test('兼容已有 candidateIds 数组、缺失、null、空数组；dispatched 不依赖候选字段', () => {
  for (const candidateIds of [undefined, null, []]) {
    assert.equal(format.stageOf({ status: 'created', candidateIds }), 'created');
    assert.equal(format.stageOf({ status: 'dispatched', candidateIds }), 'pending_accept');
  }
  assert.equal(format.stageOf({ status: 'created', candidateIds: [11] }), 'pending_accept');
  assert.equal(format.stageOf({ status: 'created', assigneeId: 11 }), 'pending_accept');
  assert.equal(format.stageOf({ status: 'in_progress', candidateIds: [11] }), 'in_progress');
});
test('RED: 手工派单未接 dispatched 必须属于进行中', () => {
  assert.equal(format.isActive('dispatched'), true);
});
test('RED: 手工派单未接 dispatched 也必须能判超时', () => {
  assert.equal(format.isOverdue(orders[2]), true);
});
test('真实 WorkOrders 单环节列表/计数/Pill 四类一致', () => {
  for (const [filter, keys, label] of [['created', ['1'], '待派单'], ['pending_accept', ['2', '3'], '待接单'], ['in_progress', ['4'], '维修中']]) {
    const tree = workOrders('view=list&filter=' + filter);
    assert.deepEqual(rows(tree), keys);
    assert.equal(text(chip(tree, label)), label + keys.length);
    const pills = nodes(tree).filter(n => n.type === ui.Pill);
    assert.deepEqual(pills.map(n => text(ui.Pill(n.props))), keys.map(() => label));
  }
});
test('RED: 真实 WorkOrders 进行中页签计数包含手工派单，总数4', () => {
  assert.equal(text(chip(workOrders('filter=active'), '进行中')), '进行中4');
});
test('RED: 真实 WorkOrders 默认进行中看板不应漏手工派单，计数应为4', () => {
  const tree = workOrders('filter=active');
  assert.deepEqual(cards(tree).sort(), ['1', '2', '3', '4']);
  assert.equal(text(chip(tree, '进行中')), '进行中4');
});
test('RED: 真实 WorkOrders 进行中列表不应漏手工派单', () => {
  assert.deepEqual(rows(workOrders('filter=active&view=list')).sort(), ['1', '2', '3', '4']);
});
test('RED: 真实 WorkOrders 超时看板不应漏手工派单', () => {
  assert.deepEqual(cards(workOrders('filter=overdue')).sort(), ['1', '2', '3', '4']);
});
test('真实 WorkOrders 全部看板不漏四类；待接单列包含候选与已派', () => {
  const tree = workOrders('filter=all');
  assert.deepEqual(cards(tree).sort(), ['1', '2', '3', '4']);
  const columns = nodes(tree).filter(n => n.props?.className === 'col');
  const pending = columns.find(n => nodes(n).some(p => p.type === ui.Pill && p.props.status === 'pending_accept'));
  assert.deepEqual(cards(pending).sort(), ['2', '3']);
  assert.equal(text(chip(tree, '待接单')), '待接单2');
});
function today() { return component('pages/Today.tsx', [orders, []]).default(); }
function todoCount(tree, title) { const row = nodes(tree).find(n => n.type === 'button' && text(n).includes(title)); assert.ok(row); return nodes(row).filter(n => n.type === 'b').at(-1).props.children; }
test('真实 Today 待派单1、待接单2正确；路由环节与列表一致', () => {
  const tree = today();
  assert.equal(todoCount(tree, '待派单工单'), 1);
  assert.equal(todoCount(tree, '待维修工接单'), 2);
});
test('RED: 真实 Today 超时卡片应包含手工派单，总数4', () => {
  assert.equal(todoCount(today(), '已超时工单'), 4);
});
test('RED: 真实 Today 进行中工单应包含手工派单，总数4', () => {
  const tree = today();
  const block = nodes(tree).find(n => n.type === 'div' && n.props.className === undefined && text(n).startsWith('进行中工单'));
  assert.ok(block);
  assert.equal(text(block), '进行中工单4 单');
});
test('真实 WorkOrderSheet 四类头部Pill与下一步分流正确', () => {
  for (const [i, expected, next] of [[0, '待派单', '派给维修工'], [1, '待接单', '改派维修工'], [2, '待接单', '代维修工接单'], [3, '维修中', '登记完工 · 用料扣料']]) {
    const detail = { workOrder: orders[i], request: {}, logs: [] };
    const m = component('components/WorkOrderSheet.tsx', [detail, false, '', 'info', null, false], '', 'exports.__NextActions = NextActions; exports.__InfoTab = InfoTab;');
    const tree = m.default({ id: orders[i].id, onClose() {}, onChanged() {} });
    const pill = nodes(tree).find(n => n.type === ui.Pill);
    assert.equal(text(ui.Pill(pill.props)), expected);
    const actions = m.__NextActions({ detail, moreOpen: false, onFlow() {}, toggleMore() {} });
    assert.ok(text(actions).includes(next), text(actions));
    const info = text(m.__InfoTab({ detail }));
    if (i === 0) assert.ok(info.includes('未识别到类型 · 转办公室派单'));
    if (i === 1) assert.ok(info.includes('已按工种自动通知 2 位维修工'));
    if (i >= 2) assert.ok(info.includes('已派 测试工甲'));
  }
});
