const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '../../..');
const ts = createRequire(path.join(root, 'apps/api/package.json'))('typescript');
function fixture(storageThrows = false) {
  const storage = new Map();
  const wx = { getStorageSync: key => { if (storageThrows) throw Error('storage unavailable'); return storage.get(key); }, setStorageSync: (key, value) => { if (storageThrows) throw Error('storage unavailable'); storage.set(key, value); } };
  function load(file, shared) {
    const exports = {};
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, {
      exports, wx, require: id => { assert.equal(id, '@pms/shared-types'); return shared; },
    });
    return exports;
  }
  const shared = load('packages/shared-types/src/work-order-sort.ts');
  return { ...load('apps/miniapp-staff/miniprogram/utils/work-order-sort.ts', shared), storage };
}
const item = (id, communityId, summaryAddress, createdAt, urgent = false) => ({ id, communityId, summaryAddress, createdAt, urgent });
const rows = [
  item(1, 1, '春园10号101', '2026-11-10T10:00:00Z'),
  item(2, 1, '春园2号101', '2026-11-11T10:00:00Z'),
  item(3, 2, '秋园1号101', '2026-11-12T10:00:00Z'),
  item(4, 1, '春园2号102', '2026-11-13T10:00:00Z'),
];
test('三模式覆盖报修正倒序和同小区楼栋自然序，且不修改输入', () => {
  const f = fixture();
  assert.deepEqual(Array.from(f.sortWorkOrders(rows, 'reported_asc'), row => row.id), [1, 2, 3, 4]);
  assert.deepEqual(Array.from(f.sortWorkOrders(rows, 'reported_desc'), row => row.id), [4, 3, 2, 1]);
  assert.deepEqual(Array.from(f.sortWorkOrders(rows, 'address'), row => row.id), [2, 4, 1, 3]);
  assert.deepEqual(rows.map(row => row.id), [1, 2, 3, 4]);
});
test('全列表排序不插紧急或待料组；坏时间置后、相同排序键稳定', () => {
  const f = fixture(); const data = [...rows, item(5, 1, '春园20号', 'invalid', true)];
  assert.deepEqual(Array.from(f.sortWorkOrders(data, 'reported_desc'), row => row.id), [4, 3, 2, 1, 5]);
  assert.deepEqual(Array.from(f.sortWorkOrders([item(2, 1, '同址', null), item(1, 1, '同址', null)], 'address'), row => row.id), [1, 2]);
});
test('默认在手按小区楼栋，工单池/派单台最新；偏好按租户用户及逻辑页面隔离', () => {
  const f = fixture(); const me = { tenantId: 1, id: 7 };
  assert.equal(f.readWorkOrderSort(me, 'my-orders'), 'address');
  assert.equal(f.readWorkOrderSort(me, 'pool'), 'reported_desc');
  assert.equal(f.readWorkOrderSort(me, 'dispatch'), 'reported_desc');
  f.saveWorkOrderSort(me, 'pool', 'reported_asc');
  assert.equal(f.readWorkOrderSort(me, 'pool'), 'reported_asc');
  assert.equal(f.readWorkOrderSort(me, 'dispatch'), 'reported_desc');
  assert.equal(f.readWorkOrderSort({ tenantId: 1, id: 8 }, 'pool'), 'reported_desc');
  assert.equal(f.readWorkOrderSort({ tenantId: 2, id: 7 }, 'pool'), 'reported_desc');
  f.saveWorkOrderSort(null, 'pool', 'address');
  assert.equal(f.storage.size, 1, '未取得本人身份不得写共用偏好');
  for (const key of f.storage.keys()) f.storage.set(key, 'malformed');
  assert.equal(f.readWorkOrderSort(me, 'pool'), 'reported_desc');
});

function pageFixture(name, storageThrows = false) {
  const sort = fixture(storageThrows);
  const status = Object.fromEntries(['created', 'dispatched', 'in_progress', 'waiting_material', 'done_pending_review', 'completed', 'cancelled', 'voided'].map(x => [x.toUpperCase(), x]));
  let mode = 'pool', responder = async () => [];
  const session = { me: { tenantId: 1, id: 7 }, hasPmsAppAccess: true, canSeePool: true, canSeeDispatch: true, canSeeMyRepairs: true, canSeeMyOrders: true, canSeeDone: true, canAccept: true, canDispatch: true };
  const calls = [], toasts = [];
  let page;
  const shared = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(root, 'packages/shared-types/src/work-order-sort.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports: shared });
  const source = fs.readFileSync(path.join(root, `apps/miniapp-staff/miniprogram/pages/${name}/${name}.ts`), 'utf8');
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, {
    exports: {}, Page: config => { page = config; },
    wx: { showToast: value => toasts.push(value), setNavigationBarTitle() {}, reLaunch() {} },
    require(id) {
      if (id === '@pms/api-client') return { repairs: { list: q => { calls.push(q); return responder(q); } } };
      if (id === '@pms/shared-types') return { ...shared, WorkOrderStatus: status };
      if (id === '@pms/miniapp-ui') return { withOrderLabels: list => list.map(x => ({ ...x })) };
      if (id.endsWith('/work-order-sort')) return sort;
      if (id.endsWith('/order-status')) return { isActiveOrder: s => !['completed', 'cancelled', 'voided', 'done_pending_review'].includes(s) };
      if (id.endsWith('/session')) return { getSession: async () => session };
      if (id.endsWith('/tabbar')) return { cachedPoolMode: () => mode, setTabBadge() {}, syncTabBar() {}, takePoolTabTapped: () => false };
      if (id.endsWith('/notify-prompt')) return { notifyPromptHandlers: () => ({ checkNotifyPrompt() {} }) };
      if (id.endsWith('/guide')) return { guideHandlers: () => ({}) };
      if (id.endsWith('/badges')) return { refreshTabBadges() {} };
      if (id.endsWith('/unread')) return { topUpQuietly() {} };
      throw new Error(`unexpected module ${id}`);
    },
  });
  page.setData = (patch, cb) => { Object.assign(page.data, patch); if (cb) cb(); };
  return { page, session, sort, calls, toasts, setMode: value => { mode = value; }, respond: fn => { responder = fn; } };
}

test('自然小区名称在ID之前，同名按ID稳定、楼栋2在10前、同栋房号不抢报修时间', () => {
  const f = fixture();
  const data = [
    { ...rows[0], communityId: 1, communityName: '小区10', buildingNo: '2' },
    { ...rows[1], communityId: 99, communityName: '小区2', buildingNo: '10' },
    { ...rows[2], communityId: 99, communityName: '小区2', buildingNo: '2', summaryAddress: '2号999', createdAt: '2026-01-01' },
    { ...rows[3], communityId: 99, communityName: '小区2', buildingNo: '2', summaryAddress: '2号101', createdAt: '2026-01-02' },
  ];
  assert.deepEqual(Array.from(f.sortWorkOrders(data, 'address'), r => r.id), [3, 4, 2, 1]);
  const sameName = [{ ...data[0], communityName: '同名' }, { ...data[1], communityName: '同名' }];
  assert.deepEqual(Array.from(f.sortWorkOrders(sameName, 'address'), r => r.id), [1, 2]);
});

test('真实在手Page：全量150行、排序API参数、picker记忆和非法/同值/加载守卫', async () => {
  const f = pageFixture('my-orders');
  f.respond(async () => Array.from({ length: 150 }, (_, i) => ({ ...rows[i % 4], id: i + 1, assigneeId: 7, status: 'in_progress' })));
  await f.page.load();
  assert.equal(f.page.data.active.length, 150); assert.equal(f.calls[0].sort, 'address');
  for (const value of [-1, '', null, 'abc', 8, 1.2, '1.2']) await f.page.onPickSort({ detail: { value } });
  assert.equal(f.calls.length, 1);
  await f.page.onPickSort({ detail: { value: '1' } });
  assert.equal(f.calls.at(-1).sort, 'reported_desc');
  assert.equal(f.sort.readWorkOrderSort(f.session.me, 'my-orders'), 'reported_desc');
  await f.page.onPickSort({ detail: { value: '1' } }); assert.equal(f.calls.length, 2);
  f.page.data.loading = true; await f.page.onPickSort({ detail: { value: '0' } }); assert.equal(f.calls.length, 2);
});

test('真实共用池Page：工单池/派单台独立偏好；等待材料不拆组/隐藏；reported/done保持旧口径', async () => {
  const f = pageFixture('pool');
  f.respond(async () => rows.map((r, i) => ({ ...r, status: i === 2 ? 'waiting_material' : 'created', urgent: i === 0 })));
  await f.page.load();
  assert.equal(f.calls.at(-1).sort, 'reported_desc');
  assert.deepEqual(Array.from(f.page.data.list, r => r.id), [4, 3, 2, 1]);
  assert.equal(f.page.data.list.find(r => r.id === 3).claimable, true);
  assert.equal(f.page.data.showPriorityGroups, false);
  assert.equal(f.page.data.list.every(r => !r.inWaitingGroup), true);
  await f.page.onPickSort({ detail: { value: '2' } });
  assert.equal(f.calls.at(-1).sort, 'address');
  f.setMode('dispatch'); await f.page.load();
  assert.equal(f.page.data.dispatcher, true); assert.equal(f.calls.at(-1).sort, 'reported_desc');
  await f.page.onPickSort({ detail: { value: '0' } });
  f.setMode('pool'); await f.page.load(); assert.equal(f.calls.at(-1).sort, 'address');
  f.page.data.mainTab = 'reported'; await f.page.load();
  assert.equal(f.calls.at(-1).scope, 'reported'); assert.equal(f.calls.at(-1).sort, undefined);
  const n = f.calls.length; await f.page.onPickSort({ detail: { value: '0' } }); assert.equal(f.calls.length, n);
  f.page.data.mainTab = 'done'; f.respond(async () => rows.map(r => ({ ...r, status: 'completed' })));
  await f.page.load(); assert.equal(f.calls.at(-1).scope, 'done'); assert.equal(f.calls.at(-1).sort, undefined);
  assert.deepEqual(Array.from(f.page.data.list, r => r.id), [4, 3, 2, 1]);
});

test('真实两Page：同页旧请求不得覆盖新排序，切换账号重读默认并拒绝旧身份响应', async () => {
  for (const name of ['my-orders', 'pool']) {
    const f = pageFixture(name); let resolveOld;
    f.respond(() => new Promise(resolve => { resolveOld = resolve; }));
    const old = f.page.load(); await new Promise(setImmediate);
    assert.equal(typeof resolveOld, 'function');
    f.sort.saveWorkOrderSort(f.session.me, name === 'pool' ? 'pool' : 'my-orders', 'reported_asc');
    f.respond(async () => [{ ...rows[1], assigneeId: 7, status: 'in_progress' }]);
    await f.page.load(); resolveOld([{ ...rows[0], assigneeId: 7, status: 'in_progress' }]); await old;
    const resultKey = name === 'pool' ? 'list' : 'active';
    assert.deepEqual(Array.from(f.page.data[resultKey], r => r.id), [2]);
    f.session.me = { tenantId: 1, id: 8 };
    f.respond(async () => [{ ...rows[2], assigneeId: 8, status: 'in_progress' }]); await f.page.load();
    assert.equal(f.calls.at(-1).sort, name === 'pool' ? 'reported_desc' : 'address');
    assert.deepEqual(Array.from(f.page.data[resultKey], r => r.id), [3]);
    f.respond(() => new Promise(resolve => { resolveOld = resolve; }));
    const staleIdentity = f.page.load(); await new Promise(setImmediate);
    f.session.me = { tenantId: 2, id: 8 };
    resolveOld([{ ...rows[3], assigneeId: 8, status: 'in_progress' }]); await staleIdentity;
    assert.deepEqual(Array.from(f.page.data[resultKey], r => r.id), [3], '旧身份请求不能写入列表');
    assert.equal(f.page.data.loading, false);
  }
});

test('存储不可用仍可本次切换；显式临时偏好不跨身份或逻辑页面泄漏', async () => {
  for (const name of ['my-orders', 'pool']) {
    const f = pageFixture(name, true);
    f.respond(async () => rows.map(r => ({ ...r, assigneeId: 7, status: 'in_progress' })));
    await f.page.load();
    await f.page.onPickSort({ detail: { value: '0' } });
    assert.equal(f.calls.at(-1).sort, 'reported_asc'); assert.equal(f.page.data.sortMode, 'reported_asc');
    const override = { value: 'reported_asc', identity: '1.999', page: 'pool' };
    if (name === 'pool') await f.page.load(false, override); else await f.page.load(override);
    assert.equal(f.calls.at(-1).sort, name === 'pool' ? 'reported_desc' : 'address');
    if (name === 'pool') {
      f.setMode('dispatch'); await f.page.load(false, { value: 'address', identity: '1.7', page: 'pool' });
      assert.equal(f.calls.at(-1).sort, 'reported_desc');
    }
    f.respond(async () => { throw Error('expected list failure'); });
    const previous = f.page.data.sortMode;
    await f.page.onPickSort({ detail: { value: '0' } });
    assert.equal(f.page.data.loading, false); assert.equal(f.page.data.sortMode, previous);
    assert.equal(f.toasts.at(-1).title, 'expected list failure');
  }
});

test('两页原生三选项、加载禁用、报修/完结不露排序，无紧急/待料折叠模板', () => {
  for (const name of ['my-orders', 'pool']) {
    const source = fs.readFileSync(path.join(root, `apps/miniapp-staff/miniprogram/pages/${name}/${name}.wxml`), 'utf8');
    assert.match(source, /picker mode="selector" range="\{\{sortLabels\}\}" value="\{\{sortIndex\}\}" bindchange="onPickSort" disabled="\{\{loading\}\}"/);
    assert.doesNotMatch(source, /item\.groupStart|item\.waitingGroupStart|!item\.inWaitingGroup/);
    if (name === 'pool') assert.match(source, /wx:if="\{\{mainTab === 'pool'\}\}" class="work-hero__right"/);
  }
});
