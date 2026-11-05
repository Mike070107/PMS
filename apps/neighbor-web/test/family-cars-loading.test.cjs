// Executes the real FamilyList TSX with an isolated hook runner, not React E2E.
// Synthetic deferred requests only; import/approval/sync calls are forbidden.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
function harness(allowDetails = false) {
  let cursor = 0, dirty = false, kw = '', dead = false, writesAfterUnmount = 0;
  const slots = [], effects = [], requests = [];
  const same = (a, b) => a && b && a.length === b.length && a.every((x, i) => x === b[i]);
  const react = {
    Fragment: Symbol.for('react.fragment'),
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], v => { if (dead) writesAfterUnmount++; const next = typeof v === 'function' ? v(slots[i]) : v; if (next !== slots[i]) { slots[i] = next; dirty = true; } }]; },
    useRef(initial) { const i = cursor++; return slots[i] ?? (slots[i] = { current: initial }); },
    useCallback(fn, deps) { const i = cursor++; if (!same(slots[i]?.deps, deps)) slots[i] = { deps, fn }; return slots[i].fn; },
    useEffect(fn, deps) { const i = cursor++; const prev = slots[i]; if (!same(prev?.deps, deps)) effects.push(() => { prev?.cleanup?.(); slots[i] = { deps, cleanup: fn() }; }); },
  };
  const module = { exports: {} };
  const source = fs.readFileSync(path.resolve(__dirname, '../src/pages/FamilyCars.tsx'), 'utf8') + '\nexport { FamilyList };';
  const sandbox = { module, exports: module.exports, Error, console, require(id) {
    if (id === 'react') return react;
    if (id === 'react/jsx-runtime') return require(id);
    if (id === '@pms/api-client') return { request: o => { assert.ok(o.url === '/family-cars' || (allowDetails && /^\/family-cars\/\d+(\/materials)?$/.test(o.url)), 'never call sync/import'); assert.ok(!o.method || o.method === 'GET'); return new Promise((resolve, reject) => requests.push({ o, resolve, reject })); } };
    if (id === '@/lib/perm') return { can: () => false };
    if (id === '@/components/ui') return { Loading: 'Loading', toast() {} };
    return { __esModule: true, default: () => null, useSession() {} };
  } };
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText, sandbox);
  function render() { let ui, n = 0; do { dirty = false; cursor = 0; ui = module.exports.FamilyList({ kw }); while (effects.length) effects.shift()(); assert.ok(++n < 30); } while (dirty); return ui; }
  return { requests, render, query(v) { kw = v; return render(); }, async settle() { for (let i = 0; i < 6; i++) await Promise.resolve(); return dead ? null : render(); }, unmount() { dead = true; for (const s of slots) s?.cleanup?.(); }, get writesAfterUnmount() { return writesAfterUnmount; } };
}
function nodes(n, predicate) { if (!n || typeof n !== 'object') return []; if (Array.isArray(n)) return n.flatMap(x => nodes(x, predicate)); return [...(predicate(n) ? [n] : []), ...nodes(n.props?.children, predicate)]; }
function text(n) { if (n == null || typeof n === 'boolean') return ''; if (typeof n !== 'object') return String(n); if (Array.isArray(n)) return n.map(text).join(''); return (n.type === 'Loading' ? '正在加载' : '') + text(n.props?.children); }
function click(ui, label) { const b = nodes(ui, n => n.type === 'button' && text(n) === label)[0]; assert.ok(b, `button ${label}`); b.props.onClick({ stopPropagation() {} }); }
const paged = (rows, total = rows.length, page = 1, pageSize = 20) => ({ rows, today: '2026-11-05', total, page, pageSize });
const row = plate => ({ id: 1, plate, status: 'active', statusLabel: '已生效', garages: [] });


const materialsRows = [{ ...row('合成A'), fileCount: 2 }, { ...row('合成B'), id: 2, fileCount: 0 }];
const filesResponse = (id = 1, name = '当前图片') => ({ id, plate: id === 1 ? '合成A' : '合成B', files: [
  { index: 0, fileName: name, contentType: 'image/png', fileUrl: '/synthetic/image.png', source: 'intake' },
  { index: 1, fileName: '合成PDF', contentType: 'application/pdf', fileUrl: '/synthetic/doc.pdf', source: 'family' },
] });
test('独立办理资料列按点击只读加载，图片/PDF与空资料可查看，不触发原详情同步', async () => {
  const h = harness(true); h.render(); h.requests[0].resolve(paged(materialsRows, 45)); let ui = await h.settle();
  assert.equal(h.requests.length, 1); assert.ok(nodes(ui, n => n.type === 'th' && text(n) === '办理资料').length);
  assert.match(text(ui), /查看资料（2）/); assert.match(text(ui), /暂无资料/);
  const b = nodes(ui, n => n.type === 'button' && text(n) === '查看资料（2）')[0]; let stopped = false;
  b.props.onClick({ stopPropagation() { stopped = true; } }); ui = h.render(); assert.equal(stopped, true);
  assert.equal(h.requests[1].o.url, '/family-cars/1/materials'); assert.match(text(ui), /正在读取办理资料/);
  h.requests[1].resolve(filesResponse()); ui = await h.settle();
  assert.ok(nodes(ui, n => n.type === 'img' && n.props.src === '/synthetic/image.png').length);
  assert.ok(nodes(ui, n => n.type === 'a' && n.props.href === '/synthetic/doc.pdf' && n.props.target === '_blank').length);
  assert.equal(nodes(ui, n => n.type === 'td' && n.props.colSpan === 9).length, 1);
  click(ui, '暂无资料'); h.render(); assert.equal(h.requests[2].o.url, '/family-cars/2/materials');
  h.requests[2].resolve({ id: 2, plate: '合成B', files: [] }); ui = await h.settle(); assert.match(text(ui), /还没有办理资料/);
  assert.equal(h.requests.some(r => /^\/family-cars\/\d+$/.test(r.o.url)), false);
});
for (const lateError of [false, true]) test(`资料A→B→A隔离迟到${lateError ? '错误' : '成功'}，失败可重试，筛选后关闭`, async () => {
  const h = harness(true); h.render(); h.requests[0].resolve(paged(materialsRows, 45)); let ui = await h.settle();
  click(ui, '查看资料（2）'); ui = h.render(); const old = h.requests.at(-1);
  click(ui, '暂无资料'); ui = h.render(); const middle = h.requests.at(-1);
  click(ui, '查看资料（2）'); ui = h.render(); const fresh = h.requests.at(-1);
  lateError ? old.reject(new Error('过期资料错误')) : old.resolve(filesResponse(1, '过期图片'));
  middle.resolve({ id: 2, plate: '合成B', files: [] }); ui = await h.settle();
  assert.match(text(ui), /正在读取办理资料/); assert.doesNotMatch(text(ui), /过期资料错误|过期图片|还没有办理资料/);
  fresh.reject(new Error('网络暂时异常')); ui = await h.settle(); assert.match(text(ui), /网络暂时异常/);
  click(ui, '重试资料'); h.render(); const retry = h.requests.at(-1); assert.equal(retry.o.url, '/family-cars/1/materials');
  h.query('另一条件'); retry.resolve(filesResponse()); ui = await h.settle();
  assert.equal(nodes(ui, n => n.props?.['data-testid'] === 'family-cars-materials').length, 0);
});
for (const lateError of [false, true]) test(`资料卸载后迟到${lateError ? '错误' : '成功'}不写状态`, async () => {
  const h = harness(true); h.render(); h.requests[0].resolve(paged(materialsRows)); let ui = await h.settle();
  click(ui, '查看资料（2）'); h.render(); const pending = h.requests.at(-1); h.unmount();
  lateError ? pending.reject(new Error('卸载错误')) : pending.resolve(filesResponse()); await h.settle(); assert.equal(h.writesAfterUnmount, 0);
});
test('翻页关闭已展开业务详情并隔离迟到详情', async () => {
  const h = harness(true); h.render(); h.requests[0].resolve(paged(materialsRows, 45)); let ui = await h.settle();
  click(ui, '办理详情'); h.render(); const detail = h.requests.at(-1); assert.equal(detail.o.url, '/family-cars/1');
  click(ui, '下一页'); h.render(); const nextList = h.requests.at(-1);
  detail.resolve({ ...materialsRows[0], files: [], log: [] }); nextList.resolve(paged(materialsRows, 45, 2)); ui = await h.settle();
  assert.equal(nodes(ui, n => n.type === 'input' && n.props.placeholder?.includes('备注')).length, 0);
});

test('搜索A→B→A不会恢复旧页；每页100从第二页回第一页', async () => {
  const h = harness(); h.query('A'); h.requests[0].resolve(paged([row('A')], 300)); let ui = await h.settle();
  click(ui, '下一页'); h.render(); h.requests[1].resolve(paged([row('A2')], 300, 2)); ui = await h.settle();
  h.query('B'); h.requests[2].resolve(paged([row('B')], 300)); await h.settle();
  h.query('A'); assert.equal(h.requests.length, 4); assert.equal(h.requests[3].o.query.page, 1);
  h.requests[3].resolve(paged([row('A')], 300)); ui = await h.settle(); click(ui, '下一页'); h.render();
  h.requests[4].resolve(paged([row('A2')], 300, 2)); ui = await h.settle();
  nodes(ui, n => n.type === 'select')[0].props.onChange({ target: { value: '100' } }); h.render();
  assert.equal(h.requests.length, 6); assert.equal(h.requests[5].o.query.page, 1); assert.equal(h.requests[5].o.query.pageSize, 100);
});

test('始终请求服务端分页，翻页、搜索、状态与大小变更仅发一次；钳制页不重发', async () => {
  const h = harness(); h.render();
  assert.equal(h.requests[0].o.query.page, 1); assert.equal(h.requests[0].o.query.pageSize, 20);
  h.requests[0].resolve(paged([row('第一页')], 41)); let ui = await h.settle();
  assert.match(text(ui), /共 41 辆/); click(ui, '下一页'); h.render();
  assert.equal(h.requests.length, 2); assert.equal(h.requests[1].o.query.page, 2);
  h.requests[1].resolve(paged([row('钳制页')], 1, 1)); ui = await h.settle();
  assert.equal(h.requests.length, 2); assert.match(text(ui), /第 1 \/ 1 页/);
  h.query('新搜索'); assert.equal(h.requests.length, 3); assert.equal(h.requests[2].o.query.page, 1);
  h.requests[2].resolve(paged([row('搜索')], 60)); ui = await h.settle();
  click(ui, '下一页'); h.render(); h.requests[3].resolve(paged([row('第二页')], 60, 2)); ui = await h.settle();
  click(ui, '已生效'); h.render(); assert.equal(h.requests.length, 5); assert.equal(h.requests[4].o.query.page, 1);
  h.requests[4].resolve(paged([row('状态')], 60)); ui = await h.settle();
  nodes(ui, n => n.type === 'select')[0].props.onChange({ target: { value: '50' } }); h.render();
  assert.equal(h.requests.length, 6); assert.equal(h.requests[5].o.query.page, 1); assert.equal(h.requests[5].o.query.pageSize, 50);
});
for (const response of [[row('旧API')], { rows: [row('旧API')], today: '2026-11-05' }]) test('旧服务无分页总数不回退全量、不伪造总数', async () => {
  const h = harness(); h.render(); h.requests[0].resolve(response); const ui = await h.settle();
  assert.match(text(ui), /升级.*重试/); assert.doesNotMatch(text(ui), /共.*辆|旧API/); assert.equal(h.requests.length, 1);
});

for (const [name, response] of [['分页对象', paged([row('合成A')])], ['分页空结果', paged([])]]) test(`兼容合法响应：${name}`, async () => {
  const h = harness(); h.render(); h.requests.at(-1).resolve(response); const ui = await h.settle(); assert.match(text(ui), response.rows.length === 0 ? /没有亲情车登记/ : /合成A/);
});
for (const response of [null, {}, { rows: null }, { rows: {} }, { rows: 'bad' }, [null], { rows: [null] }]) test(`畸形响应不得当作空数据：${JSON.stringify(response)}`, async () => {
  const h = harness(); h.render(); h.requests.at(-1).resolve(response); const ui = await h.settle(); assert.match(text(ui), /查询失败.*返回.*格式/); assert.doesNotMatch(text(ui), /没有亲情车登记|共\s*0\s*条/);
});
for (const lateError of [false, true]) test(`A→B→A状态与查询切换隔离迟到${lateError ? '错误' : '成功'}`, async () => {
  const h = harness(); let ui = h.query('A'); const old = h.requests.at(-1);
  click(ui, '已生效'); ui = h.query('B'); click(ui, '全部'); ui = h.query('A'); const fresh = h.requests.at(-1);
  lateError ? old.reject(new Error('旧错误不能显示')) : old.resolve(paged([row('旧记录不能显示')]));
  ui = await h.settle(); assert.match(text(ui), /加载|查询中/); assert.doesNotMatch(text(ui), /旧错误|旧记录/);
  fresh.resolve(paged([row('最新合成车')])); ui = await h.settle(); assert.match(text(ui), /最新合成车/);
  for (const r of h.requests.filter(r => r !== old && r !== fresh)) lateError ? r.reject(new Error('更晚旧错误')) : r.resolve(paged([]));
  ui = await h.settle(); assert.match(text(ui), /最新合成车/); assert.doesNotMatch(text(ui), /更晚旧错误|没有亲情车登记/);
});
for (const lateError of [false, true]) test(`卸载后迟到${lateError ? '错误' : '成功'}不写状态`, async () => {
  const h = harness(); h.render(); h.unmount(); lateError ? h.requests[0].reject(new Error('卸载错误')) : h.requests[0].resolve([]); await h.settle(); assert.equal(h.writesAfterUnmount, 0);
});
test('英文内部错误转成可操作中文，不泄露运行时原文', async () => {
  const h = harness(); h.render(); h.requests[0].reject(new Error('invalid input syntax for integer')); const ui = await h.settle(); assert.match(text(ui), /查询失败.*服务或网络/); assert.doesNotMatch(text(ui), /invalid input|没有亲情车登记/);
});

test('失败显示中文原因和重试，保留查询/状态；只有成功空响应显示空态', async () => {
  const h = harness(); let ui = h.query('合成车牌'); click(ui, '已生效'); ui = h.render();
  assert.match(text(ui), /加载|查询中/); assert.doesNotMatch(text(ui), /没有亲情车登记|共\s*0\s*条/);
  h.requests.at(-1).reject(new Error('服务查询失败，请稍后再试')); ui = await h.settle();
  assert.match(text(ui), /查询失败/); assert.match(text(ui), /服务查询失败，请稍后再试/);
  assert.doesNotMatch(text(ui), /没有亲情车登记|共\s*0\s*条|列表空/);
  click(ui, '重试'); ui = h.render(); assert.match(text(ui), /加载|查询中/);
  assert.equal(h.requests.at(-1).o.query.q, '合成车牌'); assert.equal(h.requests.at(-1).o.query.status, 'active');
  h.requests.at(-1).resolve(paged([])); ui = await h.settle(); assert.match(text(ui), /没有亲情车登记/);
});
