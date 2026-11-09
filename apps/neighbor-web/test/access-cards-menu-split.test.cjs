const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '../src');
const source = file => fs.readFileSync(path.join(root, file), 'utf8');
const grants = (view = true, edit = false) => ({ pages: { business: { view, edit } }, communityIds: [22], scopeAll: false });
function harness(access, pathname = '/access-cards', states = {}) {
  let component = '', index = 0;
  const effects = [], requests = [], navigations = [], writes = [];
  const session = { token: 'synthetic', generation: 1, user: { name: '合成账号' }, access };
  const jsx = (type, props) => ({ type, props });
  const react = { Suspense: 'Suspense', lazy: f => ({ lazy: String(f) }), useState(v) { const i = index++; return [states[component]?.[i] ?? (typeof v === 'function' ? v() : v), value => writes.push({ component, index: i, value })]; }, useEffect: f => effects.push(f), useMemo: f => f(), useCallback: f => f, useRef: v => ({ current: v }) };
  const cache = {};
  function load(file) {
    if (cache[file]) return cache[file];
    const module = { exports: {} };
    vm.runInNewContext(ts.transpileModule(source(file).replaceAll('import.meta.env.BASE_URL', JSON.stringify('/')), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
      module, exports: module.exports, sessionStorage: { getItem: () => null }, crypto: { randomUUID: () => 'synthetic-id' },
      window: { location: { pathname, origin: 'http://synthetic.invalid' }, setTimeout: () => 1, clearTimeout() {} },
      require(id) {
        if (id === 'react') return react;
        if (id === 'react/jsx-runtime') return { jsx, jsxs: jsx };
        if (id === 'react-router-dom') return { Route: 'Route', Routes: 'Routes', Navigate: 'Navigate', Outlet: 'Outlet', useLocation: () => ({ pathname }), useNavigate: () => p => navigations.push(p) };
        if (id === '@/lib/auth') return { useSession: () => session, auth: { getAccess: () => access, captureIdentity: () => ({ token: 'synthetic', generation: 1 }), isCurrent: () => true } };
        if (id === '@/lib/perm') return { can: (k, action) => !!access?.pages?.[k]?.[action] };
        if (id === '@/lib/access-card-status') return load('lib/access-card-status.ts');
        if (id === '@/lib/page-access') return load('lib/page-access.ts');
        if (id === '@/components/UiPreferencesProvider') return { useUiPreferences: () => ({ preferences: {}, update() {} }) };
        if (id === '@/lib/address-tree') return { useAddressTree: () => ({ communities: [] }) };
        if (id === '@/lib/parking-fields') return { groupByPlate: () => [], normPlate: x => x };
        if (id === '@pms/api-client') return { request: async o => { requests.push(o); return { accessCards: [] }; }, address: { tree: async () => [] }, accessCardIssuance: new Proxy({}, { get: (_, key) => async (...args) => { requests.push({ key, args }); return key === 'createParkingQuery' ? { id: 1, status: 'completed', rows: [] } : { agents: [], history: [] }; } }) };
        return { default: id, Loading: 'Loading', Btn: 'Btn', Card: 'Card', Sheet: 'Sheet', ErrorNote: 'ErrorNote', Toaster: 'Toaster', toast() {} };
      }
    });
    return cache[file] = module.exports;
  }
  return { load, render(file) { component = path.basename(file, '.tsx'); index = 0; return load(file).default(); }, effects, requests, navigations, writes };
}
function nodes(n) { if (Array.isArray(n)) return n.flatMap(nodes); if (!n || typeof n !== 'object') return []; return [n, ...nodes(n.props?.children), ...nodes(n.props?.element)]; }
function text(n) { if (Array.isArray(n)) return n.map(text).join(''); if (n == null || typeof n === 'boolean') return ''; return typeof n === 'object' ? text(n.props?.children) : String(n); }

test('access cards menu uses 门禁发卡 and a separate 设备管理 child at its own route', () => {
  const h = harness(grants(), '/access-cards', { Shell: [false, true, '门禁'] });
  const nav = h.load('components/Shell.tsx').NAV.find(n => n.key === 'access-cards');
  assert.equal(nav.name, '门禁发卡'); assert.equal(nav.group, '门禁管理');
  assert.equal(nav.to, '/access-cards');
  const devices = h.load('components/Shell.tsx').NAV.find(n => n.key === 'access-devices');
  assert.equal(devices.name, '设备管理'); assert.equal(devices.group, '门禁管理');
  assert.equal(devices.to, '/access-devices');
  const shell = h.render('components/Shell.tsx');
  const menu = nodes(shell).find(n => n.type === 'nav');
  const group = nodes(menu).find(n => n.type === 'button' && text(n) === '门禁管理');
  assert.ok(group); assert.equal(group.props['aria-expanded'], true);
  const link = nodes(menu).find(n => n.type === 'a' && n.props.href === '/access-cards');
  assert.equal(text(link), '门禁发卡'); assert.equal(link.props['aria-current'], 'page');
  const devicesLink = nodes(menu).find(n => n.type === 'a' && n.props.href === '/access-devices');
  assert.equal(text(devicesLink), '设备管理');
  const command = nodes(shell).find(n => n.props?.className === 'it' && text(n).includes('门禁发卡'));
  assert.ok(command); command.props.onClick(); assert.deepEqual(h.navigations, ['/access-cards']);
  const app = harness(grants(), '/access-cards', { App: [{ token: 'synthetic', generation: 1 }, false, 0] }).render('App.tsx');
  assert.ok(nodes(app).some(n => n.type === 'Route' && n.props.path === '/access-cards'));
  assert.ok(nodes(app).some(n => n.type === 'Route' && n.props.path === '/access-devices'));
});

test('existing business view permission is identical for direct route, sidebar and command search; edit or role name alone never grants view', () => {
  for (const access of [grants(), grants(false, true), { pages: {}, roleNames: ['管理员'] }, { pages: { 'access-cards': { view: true } } }]) {
    const allowed = !!access.pages.business?.view;
    const h = harness(access, '/access-cards', { Shell: [false, true, '门禁'] });
    assert.equal(h.load('lib/page-access.ts').canViewPath('/access-cards', access), allowed);
    const shell = h.render('components/Shell.tsx');
    assert.equal(nodes(shell).some(n => n.type === 'a' && n.props.href === '/access-cards'), allowed);
    assert.equal(nodes(shell).some(n => n.props?.className === 'it' && text(n).includes('门禁发卡')), allowed);
    const app = harness(access, '/access-cards', { App: [{ token: 'synthetic', generation: 1 }, false, 0] }).render('App.tsx');
    assert.equal(nodes(app).some(n => n.type === 'Route' && n.props.path === '/access-cards'), allowed);
  }
});

test('existing card page keeps scoped house selection and business edit guards for device actions', async () => {
  for (const edit of [false, true]) {
    const h = harness(grants(true, edit), '/access-cards', { AccessCards: [[{ id: 22 }, { id: 99 }], { houseId: 3, communityName: '合成小区' }, [], []] });
    const ui = h.render('pages/AccessCards.tsx');
    assert.match(text(ui), /门禁发卡/);
    const picker = nodes(ui).find(n => n.type === '@/components/HousePicker');
    assert.deepEqual(Array.from(picker.props.communities, c => c.id), [22]);
    const start = nodes(ui).find(n => n.type === 'button' && text(n).includes('开始发卡'));
    assert.equal(!!start && !start.props.disabled, edit);
    if (start) await start.props.onClick();
    await Promise.resolve();
    assert.equal(h.requests.some(r => r.key === 'createBatch'), edit);
  }
  for (const edit of [false, true]) {
    const batch = { id: 5, items: [{ id: 6, icCardNo: 'synthetic', accessStatus: 'waiting_retry', cardStatus: 'card_completed' }] };
    const h = harness(grants(true, edit), '/access-cards', { AccessCards: [[], { houseId: 3 }, [], [], '', null, 1, batch] });
    const ui = h.render('pages/AccessCards.tsx');
    const retry = nodes(ui).find(n => n.type === 'button' && text(n).includes('重试下发'));
    assert.equal(!!retry && !retry.props.disabled, edit);
    if (retry) await retry.props.onClick();
    await Promise.resolve();
    assert.equal(h.requests.some(r => r.key === 'retryAccessUpload'), edit);
  }
});

test('vehicle search never requests access cards and contains no access-card tab, state or shortcut', async () => {
  const h = harness(grants(), '/vehicles', { Vehicles: ['沪ATEST1'] });
  const ui = h.render('pages/Vehicles.tsx');
  assert.doesNotMatch(text(ui), /门禁/);
  const search = nodes(ui).find(n => n.type === 'Btn' && text(n) === '查询');
  assert.ok(search); await search.props.onClick(); await Promise.resolve();
  assert.ok(h.requests.some(r => r.key === 'createParkingQuery'));
  assert.equal(h.requests.some(r => r.url === '/business/search'), false);
  assert.doesNotMatch(source('pages/Vehicles.tsx'), /interface AccessCard|loadCards|setCards|cardErr|setTab|serviceType: 'access_card'|\/access-cards|门禁/);
});
