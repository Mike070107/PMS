const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const apiRequire = createRequire(path.resolve(__dirname, '../../api/package.json'));
const ts = apiRequire('typescript');

function fixture() {
  const cache = new Map();
  const storage = new Map();
  let definition;
  const wx = {
    getStorageSync: key => storage.get(key),
    setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: key => storage.delete(key),
  };
  function load(relative) {
    const filename = path.resolve(__dirname, relative);
    if (cache.has(filename)) return cache.get(filename);
    const exports = {};
    cache.set(filename, exports);
    const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText;
    vm.runInNewContext(code, {
      exports, wx, console,
      Component: value => { definition = value; },
      require: name => {
        if (name === '@pms/shared-types') return load('../../../packages/shared-types/src/pages.ts');
        if (name === '@pms/api-client') return { auth: {} };
        if (name.endsWith('/unread')) return {};
        if (name.startsWith('.')) return load(path.relative(__dirname, path.resolve(path.dirname(filename), name + '.ts')));
        throw new Error('Unexpected runtime dependency: ' + name);
      },
    }, { filename });
    return exports;
  }
  const pages = load('../../../packages/shared-types/src/pages.ts');
  const roles = load('../miniprogram/utils/roles.ts');
  const tabbar = load('../miniprogram/utils/tabbar.ts');
  load('../miniprogram/custom-tab-bar/index.ts');
  const component = { data: { ...definition.data }, setData(change) { Object.assign(this.data, change); } };
  for (const [name, method] of Object.entries(definition.methods)) component[name] = method.bind(component);
  const remember = permissions => {
    tabbar.rememberAccess({ getTabBar: () => component }, permissions);
    return tabbar.readCachedAccess();
  };
  return { pages, roles, tabbar, component, storage, remember, session: load('../miniprogram/utils/session.ts') };
}

test('服务端已授予抄表：刷新旧缓存后，底部入口恢复且路由保留', () => {
  const f = fixture();
  f.storage.set('pms.staff.pages', { 'app:pool': true });
  const access = f.remember({ 'app:pool': { view: true }, 'app:meters': { view: true } });
  assert.equal(access.pages['app:meters'], true);
  assert.equal(f.roles.canSeeTab('meters', access), true);
  assert.equal(f.component.data.tabs.find(tab => tab.key === 'meters')?.pagePath, '/pages/meters/meters');
});

test('员工权限缓存与共用注册表完整一致，包含仅有抄表权限的账号', () => {
  const f = fixture();
  assert.deepEqual([...f.tabbar.STAFF_APP_PAGE_KEYS].sort(), [...f.pages.STAFF_APP_PAGE_KEYS].sort());
  const access = f.remember({ 'app:meters': { view: true } });
  assert.equal(f.roles.hasPmsAppAccess(access.pages), true);
  assert.equal(f.component.data.tabs.some(tab => tab.key === 'meters'), true);
  const session = f.session.buildSession({ access: { pages: { 'app:meters': { view: true, edit: true } } } });
  assert.equal(session.hasPmsAppAccess, true);
  assert.equal(session.canSeeMeters, true);
  assert.equal(session.canSubmitReading, true);
});

test('逐项单独授权：派单、在手、养护、库存、各类审批、收费入口完整保留', () => {
  const grants = {
    'app:dispatch': 'dispatch', 'app:pool': 'pool', 'app:my-repairs': 'pool',
    'app:my-orders': 'mine', 'app:maintenance-sign': 'maintenance', 'app:maintenance-inspect': 'maintenance',
    'app:inventory': 'materials', 'app:materials': 'materials', 'app:stocktakes': 'materials',
    'app:approve-manager': 'approvals', 'app:approve-purchase-manager': 'approvals',
    'app:approve-business-manager': 'approvals', 'app:approve-purchaser': 'approvals',
    'app:family-car-approve': 'approvals', 'app:apartment-cashier': 'cashier',
  };
  const f = fixture();
  for (const [key, tab] of Object.entries(grants)) {
    f.remember({ [key]: { view: true } });
    assert.equal(f.component.data.tabs.some(item => item.key === tab), true, key);
  }
  const session = f.session.buildSession({ access: { pages: { 'app:order-rollback': { view: true }, 'app:order-void': { view: true } } } });
  assert.equal(session.hasPmsAppAccess, true);
  assert.equal(session.canRollback, true);
  assert.equal(session.canVoid, true);
});

test('所有底部入口都能通过服务端授权→缓存→组件显示，原生路由均已注册', () => {
  const f = fixture();
  f.remember(Object.fromEntries(f.pages.STAFF_APP_PAGE_KEYS.map(key => [key, { view: true }])));
  const keys = Array.from(f.component.data.tabs, tab => tab.key);
  assert.deepEqual(keys, ['dispatch', 'pool', 'mine', 'maintenance', 'materials', 'approvals', 'meters', 'cashier', 'more', 'me']);
  const app = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../miniprogram/app.json'), 'utf8'));
  for (const tab of f.component.data.tabs) assert.ok(app.pages.includes(tab.pagePath.slice(1).split('?')[0]), tab.key);
  const metersRoute = 'pages/meters/meters';
  assert.ok(app.tabBar.list.some(tab => tab.pagePath === metersRoute));
});

test('无抄表授权不显示；撤销授权清旧缓存；外部应用专用账号仍无 PMS 入口', () => {
  const f = fixture();
  f.remember({ 'app:meters': { view: true } });
  f.remember({ 'app:pool': { view: true }, 'app:meters': { view: false } });
  assert.equal(f.component.data.tabs.some(tab => tab.key === 'meters'), false);
  const access = f.remember({ 'app:external-app': { view: true } });
  assert.equal(f.roles.hasPmsAppAccess(access.pages), false);
  assert.equal(f.component.data.tabs.length, 0);
});
