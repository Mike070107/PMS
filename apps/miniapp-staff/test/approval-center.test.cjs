const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, response, tap, tick, deferred } = require('./support/approval-center-fixture.cjs');
const transfer = { key: 'transfer:9', category: 'transfer', id: 9, title: 'TR-TEST-9', subtitle: '发货仓 → 接收仓', at: '2026-11-18T10:00:00Z', result: '待处理', detail: { lines: '维修胶 ×3' } };
const purchase = status => ({ key: `purchase:${status}`, category: 'purchase', id: status === 'manager_review' ? 1 : 2, at: transfer.at, detail: { id: status === 'manager_review' ? 1 : 2, requestNo: 'PR-SYNTHETIC', status, items: [], createdAt: transfer.at } });

test('审批中心同时保留经理和采购阶段，逐卡分派原有审批接口', async () => {
  const f = fixture({ list: async () => response([purchase('manager_review'), purchase('purchaser_review'), transfer]) });
  await f.page.load();
  assert.equal(f.page.data.list.length, 2);
  assert.equal(f.page.data.genericRows.length, 1);
  await f.page.onApprove(tap({ id: 1 }));
  await tick();
  await f.page.onApprove(tap({ id: 2 }));
  assert.equal(f.calls.filter(c => c[0] === 'managerApprove').length, 1);
  assert.equal(f.calls.filter(c => c[0] === 'purchaserApprove').length, 1);
});

test('待审批/已审批和分类点击以服务端分类计数刷新，已审批无待办按钮', async () => {
  const f = fixture({ list: async q => response([transfer], { tabs: { pending: 12, done: 3 } }) });
  await f.page.load();
  f.page.onCenterTab(tap({ tab: 'done' }));
  await tick();
  assert.equal(f.calls.at(-1)[1].tab, 'done');
  assert.equal(f.page.data.list.length, 0);
  assert.equal(f.page.data.genericRows.length, 1);
  f.page.onCenterCategory(tap({ category: 'transfer' }));
  await tick();
  assert.equal(f.calls.at(-1)[1].category, 'transfer');
  assert.equal(f.page.data.centerTabs.pending, 12);
  assert.deepEqual(f.badges.at(-1), ['approvals', 12]);
});

test('快速切换分类：旧请求迟到不能覆盖新列表或结束新加载态', async () => {
  const first = deferred(), second = deferred(); let n = 0;
  const f = fixture({ list: () => (++n === 1 ? first.promise : second.promise) });
  const oldLoad = f.page.load(); await tick();
  f.page.onCenterCategory(tap({ category: 'transfer' })); await tick();
  first.resolve(response([purchase('manager_review')])); await oldLoad;
  assert.equal(f.page.data.loadingCenter, true);
  second.resolve(response([transfer])); await tick();
  assert.equal(f.page.data.loadingCenter, false);
  assert.equal(f.page.data.centerRows[0].key, transfer.key);
});

test('加载失败保留原计数/筛选/关键字，显示重试错误而非零待办', async () => {
  let fail = false;
  const f = fixture({ list: async () => { if (fail) throw new Error('连接中断，请重试'); return response([transfer], { tabs: { pending: 12, done: 3 } }); } });
  await f.page.load(); fail = true;
  f.page.onSearchInput({ detail: { value: '维修胶' } });
  await f.page.load();
  assert.equal(f.page.data.keyword, '维修胶');
  assert.equal(f.page.data.centerTabs.pending, 12);
  assert.match(f.page.data.centerError, /连接中断/);
  assert.equal(f.page.data.centerRows.length, 1);
  fail = false; f.page.onRetryCenter(); await tick();
  assert.equal(f.page.data.centerError, '');
});

test('加载更多追加原行，不重复请求；搜索从第一页重查', async () => {
  const f = fixture({ list: async q => response([{ ...transfer, id: q.page }], { page: q.page, hasMore: q.page === 1 }) });
  await f.page.load();
  f.page.onLoadMoreCenter(); f.page.onLoadMoreCenter(); await tick();
  assert.equal(f.calls.filter(c => c[0] === 'list').length, 2);
  assert.equal(f.page.data.centerRows.length, 2);
  f.page.onSearchInput({ detail: { value: 'TR-TEST' } });
  f.page.onSearchCenter(); await tick();
  assert.equal(f.calls.at(-1)[1].page, 1);
  assert.equal(f.calls.at(-1)[1].q, 'TR-TEST');
  assert.equal(f.page.data.centerRows.length, 1);
});

test('调拨审批在弹窗等待和请求等待期间只执行一次，并明确扣库存/另行收货', async () => {
  const modal = deferred(), request = deferred();
  const f = fixture({ modal: () => modal.promise, decide: () => request.promise });
  const event = tap({ id: 9, category: 'transfer', approved: true });
  const action = f.page.onCenterDecision(event);
  await f.page.onCenterDecision(event);
  assert.equal(f.dialogs.length, 1);
  assert.match(f.dialogs[0].content, /扣减.*在途.*另行确认收货/);
  modal.resolve({ confirm: true }); await tick();
  await f.page.onCenterDecision(event);
  assert.equal(f.calls.filter(c => c[0] === 'decide').length, 1);
  request.resolve(); await action;
  assert.equal(f.page.data.centerBusyKey, '');
});

test('退回空原因不发请求；接口拒绝保留输入列表并释放按钮', async () => {
  const f = fixture({ modal: async () => ({ confirm: true, content: '' }) });
  await f.page.onCenterDecision(tap({ id: 9, category: 'transfer', approved: false }));
  assert.equal(f.calls.filter(c => c[0] === 'decide').length, 0);
  assert.equal(f.page.data.centerBusyKey, '');
  const failed = fixture({ list: async () => response([transfer]), decide: async () => { throw new Error('库存不足'); } });
  await failed.page.load();
  await failed.page.onCenterDecision(tap({ id: 9, category: 'transfer', approved: true }));
  assert.equal(failed.page.data.centerRows.length, 1);
  assert.equal(failed.toasts.at(-1).title, '库存不足');
});

test('养护入口可往返切换，审批中心深链不继承旧养护缓存', async () => {
  const f = fixture({ signs: [{ id: 5, createdAt: transfer.at, totalCents: 0 }] });
  f.setMode('maintenance');
  f.page.onLoad({ category: 'transfer' });
  await f.page.load();
  assert.equal(f.page.data.mode, 'approvals');
  assert.equal(f.page.data.category, 'transfer');
  // A different page stack may change global cache; it must not retarget this entry.
  f.setMode('maintenance'); await f.page.load();
  assert.equal(f.page.data.mode, 'approvals');
  f.page.onLoad({ mode: 'maintenance' }); await f.page.load();
  assert.equal(f.page.data.mode, 'maintenance');
  assert.equal(f.page.data.maintenanceList.length, 1);
  f.setMode('approvals'); await f.page.load();
  assert.equal(f.page.data.mode, 'maintenance');
  f.page.onLoad({ mode: 'approvals' }); await f.page.load();
  assert.equal(f.page.data.mode, 'approvals');
});

test('照片与PDF附件绝对地址完整，原详情入口沿用原流程', async () => {
  const f = fixture({ list: async () => response([{ ...transfer, category: 'vehicle', detail: { files: [{ fileName: '资料.pdf', contentType: 'application/pdf', fileUrl: '/private/document' }, { fileName: '照片.png', contentType: 'image/png', fileUrl: '/private/photo' }] } }]) });
  await f.page.load();
  assert.equal(f.page.data.genericRows[0].files[0].url, 'https://synthetic.invalid/private/document');
  assert.equal(f.page.data.genericRows[0].photos.length, 1);
  await f.page.onOpenApprovalFile(tap({ url: f.page.data.genericRows[0].files[0].url }));
  f.page.onOpenCenterDetail(tap({ id: 9, category: 'stocktake' }));
  assert.equal(f.routes[0], '/pages/stocktake-review/stocktake-review?id=9');
});

test('采购整单退回在弹窗前锁定，取消/失败均解锁；单项退回仍保留原因', async () => {
  const modal = deferred(); const f = fixture({ modal: () => modal.promise });
  const action = f.page.onReject(tap({ id: 2 }));
  await f.page.onReject(tap({ id: 2 }));
  assert.equal(f.dialogs.length, 1);
  modal.resolve({ confirm: false }); await action;
  assert.equal(f.page.data.busyId, 0);
  const line = fixture({ modal: async () => ({ confirm: true, content: '规格不符' }) });
  await line.page.onRejectItem(tap({ id: 2, line: 'line-1' }));
  assert.equal(line.calls.find(c => c[0] === 'rejectItem')[2].reason, '规格不符');
});
