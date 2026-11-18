const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('../../api/node_modules/typescript');
const read = p => fs.readFileSync(path.resolve(__dirname, '../miniprogram', p), 'utf8');
function fixture(route, session = {}, mode = 'more') {
  let definition, remembered, sessionForce;
  const calls = [];
  const wx = new Proxy({}, { get: (_, method) => options => calls.push({ method, ...options }) });
  const api = {
    repairExperiences: { access: async () => ({ canView: true }) },
    maintenance: { signTasks: async () => { calls.push({ method: 'signTasks' }); return []; } },
    purchases: { listRequests: async () => { calls.push({ method: 'listRequests' }); return []; } },
    meters: { list: async () => { calls.push({ method: 'meterList' }); return { rows: [], total: 0 }; }, summary: async () => null },
  };
  const dependencies = {
    '/session': { getSession: async (_, force) => { sessionForce = force; return { me: { name: '员工' }, roleNames: [], hasPmsAppAccess: true, canSeeMeters: false, canSignMaintenance: false, canInspectMaintenance: false, ...session }; } },
    '/tabbar': { cachedMeMode: () => mode, cachedApprovalMode: () => mode,
      rememberApprovalMode: value => { remembered = value; },
      syncTabBar: (_, key) => calls.push({ method: 'syncTabBar', key }), setTabBadge: () => {} },
    '/guide': { guideHandlers: () => ({ syncGuide() {} }) },
    '/badges': { refreshTabBadges: () => {}, syncMaintenanceBadge: () => {} },
  };
  vm.runInNewContext(ts.transpileModule(read(route + '.ts'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, {
    exports: {}, Page: value => { definition = value; }, wx, console,
    require: name => {
      if (name === '@pms/api-client') return api;
      if (name === '@pms/shared-types') return { USER_ROLE_LABELS: {}, PurchaseRequestStatus: {} };
      if (name === '@pms/miniapp-ui') return { formatDateTimeCn: () => '', maskPhone: () => '' };
      return Object.entries(dependencies).find(([suffix]) => name.endsWith(suffix))?.[1] || {};
    },
  });
  const page = { ...definition, data: structuredClone(definition.data), setData(patch) { Object.assign(this.data, patch); } };
  return { page, calls, get remembered() { return remembered; }, get sessionForce() { return sessionForce; } };
}

test('更多应用模板：抄表和养护单独立权限卡片，仅在更多模式渲染', () => {
  const template = read('pages/me/me.wxml');
  const more = template.slice(template.indexOf('mode === \'more\''), template.indexOf('<block wx:else>'));
  assert.match(more, /wx:if="{{canSeeMeters}}"[^>]*bindtap="onOpenMeters"/);
  assert.match(more, /wx:if="{{canSeeMaintenance}}"[^>]*bindtap="onOpenMaintenance"/);
  assert.match(more, /meter-glyph/); assert.match(more, /maintenance-glyph/);
  assert.match(more, /维修经验总结/);
});

for (const [label, grants] of Object.entries({ none: {}, meter: { canSeeMeters: true }, sign: { canSignMaintenance: true }, inspect: { canInspectMaintenance: true }, both: { canSeeMeters: true, canSignMaintenance: true } })) {
  test('更多会话权限映射与撤销刷新：' + label, async () => {
    const f = fixture('pages/me/me', grants);
    // Simulate a previous account/page snapshot; a fresh session must overwrite it.
    Object.assign(f.page.data, { canSeeMeters: true, canSeeMaintenance: true });
    await f.page.load();
    assert.equal(f.sessionForce, true);
    assert.equal(f.page.data.canSeeMeters, !!grants.canSeeMeters);
    assert.equal(f.page.data.canSeeMaintenance, !!(grants.canSignMaintenance || grants.canInspectMaintenance));
  });
}

test('抄表卡片：有权限 navigateTo 普通页，无权限不跳转且提示', () => {
  const f = fixture('pages/me/me');
  f.page.onOpenMeters(); assert.equal(f.calls.some(x => x.method === 'navigateTo'), false);
  assert.equal(f.calls.at(-1).method, 'showToast');
  f.page.data.canSeeMeters = true; f.page.onOpenMeters();
  assert.deepEqual(f.calls.at(-1), { method: 'navigateTo', url: '/pages/meters/meters' });
});

test('养护单卡片：显式指定养护模式，禁止无权限跳转', () => {
  const f = fixture('pages/me/me');
  f.page.onOpenMaintenance(); assert.equal(f.calls.some(x => x.method === 'navigateTo'), false);
  f.page.data.canSeeMaintenance = true; f.page.onOpenMaintenance();
  assert.equal(f.remembered, 'maintenance');
  assert.deepEqual(f.calls.at(-1), { method: 'navigateTo', url: '/pages/approvals/approvals?mode=maintenance' });
});

test('养护入口覆盖旧审批缓存，返回签字详情后仍为养护；审批入口反向隔离', async () => {
  const f = fixture('pages/approvals/approvals', { canSignMaintenance: true, canApprove: true }, 'approvals');
  f.page.onLoad({ mode: 'maintenance' }); await f.page.load(); await f.page.load();
  assert.equal(f.page.data.mode, 'maintenance');
  assert.equal(f.calls.filter(x => x.method === 'signTasks').length, 2);
  assert.equal(f.calls.some(x => x.method === 'listRequests'), false);
  assert.ok(f.calls.some(x => x.method === 'setNavigationBarTitle' && x.title === '养护单'));
  const g = fixture('pages/approvals/approvals', { canSignMaintenance: true, canApprove: true }, 'maintenance');
  g.page.onLoad({ mode: 'approvals' }); await g.page.load();
  assert.equal(g.page.data.mode, 'approvals');
  assert.equal(g.calls.some(x => x.method === 'signTasks'), false);
});

test('抄表普通页不再同步抄表底栏，进入时仍先校验权限', async () => {
  const f = fixture('pages/meters/meters', { canSeeMeters: false });
  f.page.onShow(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.page.data.canView, false);
  assert.equal(f.calls.some(x => x.method === 'meterList' || x.method === 'syncTabBar'), false);
  assert.doesNotMatch(read('pages/meters/meters.wxml'), /container--tabbar/);
});
