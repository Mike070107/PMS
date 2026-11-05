const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '../src');
const grants = (...keys) => ({ pages: Object.fromEntries(keys.map(k => [k, { view: true, edit: true }])) });
function harness(access, pathname = '/family-cars', states = {}) {
  const effects = [], writes = [], requests = [], navigations = [], listeners = {};
  let component = '', index = 0;
  const session = { token: 'synthetic', generation: 1, user: { name: '测试' }, access };
  const jsx = (type, props) => ({ type, props });
  const react = { Fragment: 'Fragment', Suspense: 'Suspense', lazy: f => ({ lazy: String(f) }), useState(v) { const i = index++; return [states[component]?.[i] ?? (typeof v === 'function' ? v() : v), value => writes.push({ component, index: i, value })]; }, useMemo: f => f(), useRef: value => ({ current: value }), useCallback: f => f, useEffect: f => effects.push(f) };
  const cache = {};
  function load(file) {
    if (cache[file]) return cache[file];
    const module = { exports: {} };
    const source = fs.readFileSync(path.join(root, file), 'utf8').replaceAll('import.meta.env.BASE_URL', JSON.stringify('/'));
    vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
      module, exports: module.exports, sessionStorage: { getItem: () => null }, window: { location: { pathname }, addEventListener: (k, f) => { listeners[k] = f; }, removeEventListener() {}, setInterval: () => 1, clearInterval() {} },
      require(id) {
        if (id === 'react') return react;
        if (id === 'react/jsx-runtime') return { jsx, jsxs: jsx };
        if (id === 'react-router-dom') return { Route: 'Route', Routes: 'Routes', Navigate: 'Navigate', Outlet: 'Outlet', useLocation: () => ({ pathname }), useNavigate: () => p => navigations.push(p) };
        if (id === '@/lib/auth') return { useSession: () => session, auth: { getAccess: () => access, captureIdentity: () => ({ token: 'synthetic', generation: 1 }), isCurrent: () => true } };
        if (id === '@/lib/perm') return { can: (k, action) => !!access.pages?.[k]?.[action] };
        if (id === '@/lib/page-access') return load('lib/page-access.ts');
        if (id === '@/components/UiPreferencesProvider') return { useUiPreferences: () => ({ preferences: {}, update() {} }) };
        if (id === '@pms/api-client') return { notifications: { unreadCount: async () => ({ count: 0 }) }, request: async o => { requests.push(o); return o.url === '/family-cars' ? { rows: [], today: '2026-11-05', total: 0, page: 1, pageSize: 20 } : []; } };
        if (id === '@/lib/format') return { dayjs: () => ({ format: () => '测试日期' }) };
        return { default: id, Loading: 'Loading', Toaster: 'Toaster', toast() {} };
      }
    });
    return cache[file] = module.exports;
  }
  function render(file) { component = path.basename(file, '.tsx'); index = 0; return load(file).default(); }
  function expand(n) {
    if (Array.isArray(n)) return n.map(expand);
    if (!n || typeof n !== 'object') return n;
    if (typeof n.type === 'function') { component = n.type.name; index = 0; return expand(n.type(n.props)); }
    return { ...n, props: { ...n.props, children: expand(n.props?.children) } };
  }
  return { load, render, expand, effects, writes, requests, navigations, listeners };
}
function nodes(n) { if (Array.isArray(n)) return n.flatMap(nodes); if (!n || typeof n !== 'object') return []; return [n, ...nodes(n.props?.children), ...nodes(n.props?.element)]; }
function text(n) { if (Array.isArray(n)) return n.map(text).join(''); if (n == null || typeof n === 'boolean') return ''; return typeof n === 'object' ? text(n.props?.children) : String(n); }

test('family-car route, sidebar and CtrlK use the same narrow permission mapping', () => {
  for (const key of ['family-cars', 'family-cars-approve', 'app:family-car-approve', 'app:approve-business-manager', 'business', 'app:approve-manager', 'none']) {
    const allowed = !['business', 'app:approve-manager', 'none'].includes(key);
    const h = harness(grants(key), '/family-cars', { Shell: [false, true, '亲情车'] });
    const map = h.load('lib/page-access.ts');
    assert.equal(map.canViewPath('/family-cars', grants(key)), allowed, key);
    const shell = h.render('components/Shell.tsx');
    const menu = nodes(shell).find(n => n.type === 'nav');
    const link = nodes(menu).find(n => n.type === 'a' && n.props.href === '/family-cars');
    assert.equal(!!link, allowed, key + ' sidebar');
    const commands = nodes(shell).filter(n => n.props?.className === 'it');
    assert.equal(commands.some(n => text(n).includes('亲情车管理')), allowed, key + ' CtrlK');
    if (allowed) {
      assert.equal(link.props['aria-current'], 'page');
      const group = nodes(menu).find(n => n.type === 'button' && text(n) === '车辆管理');
      assert.equal(group.props['aria-expanded'], true);
      group.props.onClick(); assert.ok(h.writes.some(w => w.index === 4 && typeof w.value === 'function'));
      commands[0].props.onClick(); assert.deepEqual(h.navigations, ['/family-cars']);
      h.effects.find(f => String(f).includes('onKey'))();
      h.listeners.keydown({ ctrlKey: true, key: 'k', preventDefault() {} });
      assert.ok(h.writes.some(w => w.index === 1 && typeof w.value === 'function'));
    }
    const app = harness(grants(key), '/family-cars', { App: [{ token: 'synthetic', generation: 1 }, false, 0] }).render('App.tsx');
    const route = nodes(app).find(n => n.type === 'Route' && n.props.path === '/family-cars');
    assert.equal(!!route, allowed, key + ' protected route');
    if (route) {
      assert.equal(typeof route.props.element.type.lazy, 'string');
      assert.match(fs.readFileSync(path.join(root, 'App.tsx'), 'utf8'), /const FamilyCars = lazy\(\(\) => import\('@\/pages\/FamilyCars'\)\)/);
    }
  }
  const m = harness(grants()).load('lib/page-access.ts');
  for (const key of ['family-cars-approve', 'app:family-car-approve']) assert.equal(m.canViewPath('/plates', grants(key)), false);
  for (const key of ['business', 'family-cars', 'app:approve-business-manager', 'app:approve-manager']) assert.equal(m.canViewPath('/plates', grants(key)), true);
});

const family = { id: 9, houseId: 2, plate: '沪ATEST1', roomKey: '228/6/502', ownerName: '合成业主', carOwnerName: '合成亲属', carOwnerPhone: '13800000000', relation: '子女', garages: ['phase1', 'main'], garageNumbers: { main: '91' }, startDate: '2026-01-01', endDate: '2026-12-31', daysLeft: 20, expiringSoon: true, status: 'manager', statusLabel: '待经理审核', files: [{ index: 0, fileName: '资料', contentType: 'image/png', fileUrl: '/synthetic.png' }], log: [{ at: '2026-01-01', userName: '测试', action: '提交' }] };

test('moved family component uses exactly the three backend manager edit grants, never legacy approval', () => {
  const failures = [];
  for (const key of ['family-cars-approve', 'app:family-car-approve', 'app:approve-business-manager', 'app:approve-manager', 'family-cars']) {
    for (const edit of [true, false]) {
      const access = grants('family-cars', key); access.pages[key].edit = edit;
      const h = harness(access, '/family-cars', { FamilyList: ['', [family], family] });
      const ui = h.expand(h.render('pages/FamilyCars.tsx'));
      const expected = edit && ['family-cars-approve', 'app:family-car-approve', 'app:approve-business-manager'].includes(key);
      if (text(ui).includes('经理审核通过（开通一年）') !== expected) failures.push(`${key} edit=${edit}`);
    }
  }
  assert.deepEqual(failures, []);
});

test('moved family page preserves search, filters, details, files, garages, validity and operation visibility', async () => {
  for (const status of ['manager', 'office', 'expired', 'active', 'opening']) {
    const row = { ...family, status };
    const h = harness(grants('family-cars', 'family-cars-approve'), '/family-cars', { FamilyCars: ['沪A', '沪A'], FamilyList: ['', [row], row] });
    const ui = h.expand(h.render('pages/FamilyCars.tsx'));
    assert.match(text(ui), /亲情车管理/);
    assert.ok(nodes(ui).some(n => n.type === 'input' && n.props.placeholder === '车牌 \/ 房号 \/ 姓名 \/ 电话'));
    assert.ok(nodes(ui).some(n => n.type === 'a' && n.props.href === '/synthetic.png'));
    assert.match(text(ui), /一期地面二期大车库 91/);
    assert.match(text(ui), /2026-01-01 ~ 2026-12-31/);
    assert.match(text(ui), /待办公室审核待经理审核开通中已生效已过期待上传资料/);
    assert.match(text(ui), /从旧停车库拉取/);
    const labels = { manager: '经理审核通过（开通一年）', office: '办公室审核通过', expired: '续登一年', active: '停用', opening: '失败重试' };
    assert.ok(text(ui).includes(labels[status]), status);
    h.effects.forEach(f => f()); await Promise.resolve();
    assert.ok(h.requests.some(r => r.url === '/family-cars' && r.query.q === '沪A'));
    assert.equal(h.requests.some(r => r.url === '/vehicle-intakes'), false);
  }
  const unauthorized = harness(grants('business'));
  assert.equal(unauthorized.render('pages/FamilyCars.tsx'), null);
});

test('family narrow layout keeps search shrinkable, filters in one scroll row and all nine table columns', () => {
  const h = harness(grants('family-cars'), '/family-cars', { FamilyList: ['', [family], family] });
  const ui = h.expand(h.render('pages/FamilyCars.tsx'));
  const header = nodes(ui).find(n => n.props?.className === 'ph');
  assert.equal(header.props.style.flexWrap, 'wrap');
  const form = nodes(ui).find(n => n.type === 'form'); assert.equal(form.props.style.minWidth, 0);
  const filters = nodes(ui).find(n => n.props?.className === 'quickMonths');
  assert.equal(filters.props.style.flexWrap, 'nowrap'); assert.equal(filters.props.style.overflowX, 'auto');
  const table = nodes(ui).find(n => n.props?.['data-testid'] === 'family-cars-table');
  assert.equal(nodes(table).filter(n => n.type === 'th').length, 9);
  assert.ok(nodes(ui).some(n => n.props?.className === 'card t-scroll' && n.props.style.overflowX === 'auto'));
  assert.ok(nodes(ui).filter(n => n.type === 'td' && n.props.colSpan).every(n => n.props.colSpan === 9));
});

test('old registration page contains only the original intake list and no family tab', () => {
  const h = harness(grants('business'), '/plates');
  const ui = h.render('pages/Plates.tsx');
  assert.match(text(ui), /车牌登记审核/);
  assert.equal(nodes(ui).some(n => n.props?.className === 'tabs'), false);
  assert.equal(nodes(ui).filter(n => typeof n.type === 'function').some(n => n.type.name === 'IntakeList'), true);
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'pages/Plates.tsx'), 'utf8'), /function FamilyList|interface FamilyCar/);
});
