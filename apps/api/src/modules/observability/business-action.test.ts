import assert from 'node:assert/strict';
import test from 'node:test';
import { businessActionCodesByArea, listBusinessActions, resolveBusinessAction } from './business-action';
import { apiEndpointLabel, buildApiErrorAlert } from './alert-presentation';

test('区分 AI 随手拍报修与普通填表报修', () => {
  assert.equal(
    resolveBusinessAction('POST', '/api/v1/repair-requests', { entryMode: 'quick_ai' }).code,
    'repair_create_quick_ai',
  );
  assert.equal(
    resolveBusinessAction('POST', '/repair-requests', { entryMode: 'form' }).label,
    '填写表单报修',
  );
});

test('筛选下拉按业务模块分组，code 不重复且含报修两种入口', () => {
  const groups = listBusinessActions();
  const areas = groups.map((group) => group.area);
  assert.equal(new Set(areas).size, areas.length, '业务模块不能重复出现');
  assert.ok(areas.includes('收费') && areas.includes('工单') && areas.includes('报修'));
  for (const group of groups) {
    const codes = group.actions.map((item) => item.code);
    assert.equal(new Set(codes).size, codes.length, `${group.area} 下的 action code 重复了`);
    assert.ok(group.actions.every((item) => item.label), `${group.area} 下有缺中文名的操作`);
  }
  const repair = groups.find((group) => group.area === '报修')!.actions.map((item) => item.code);
  assert.ok(repair.includes('repair_create_quick_ai') && repair.includes('repair_create_form'));
});

test('按业务模块取 action code，和实际记录下来的 code 对得上', () => {
  const fee = businessActionCodesByArea('收费');
  assert.ok(fee.includes(resolveBusinessAction('POST', '/fees/cashier/charges').code));
  assert.ok(fee.includes(resolveBusinessAction('POST', '/fees/cashier/receipts/SJ01/refund').code));
  assert.ok(!fee.includes(resolveBusinessAction('POST', '/work-orders/1/assign').code));
  assert.deepEqual(businessActionCodesByArea('不存在的模块'), []);
});

test('工单、库存和盘点操作转成稳定业务事件', () => {
  const assigned = resolveBusinessAction('POST', '/api/v1/work-orders/38/assign', { assigneeId: 9 });
  assert.equal(assigned.code, 'work_order_assign');
  assert.equal(assigned.objectId, 38);
  assert.equal(assigned.detail?.assigneeId, 9);
  assert.equal(resolveBusinessAction('PATCH', '/stocks/12', { warehouseId: 2 }).label, '修改库存');
  assert.equal(resolveBusinessAction('POST', '/stocktakes/7/review').label, '复核盘点');
  assert.equal(resolveBusinessAction('POST', '/work-orders/38/progress').label, '添加维修进度');
  assert.equal(resolveBusinessAction('POST', '/work-orders/38/transfer-request').code, 'work_order_transfer_request');
  assert.equal(resolveBusinessAction('POST', '/work-orders/38/rollback').label, '撤回工单处理节点');
  assert.equal(resolveBusinessAction('POST', '/repair-experiences').label, '新增维修经验');
  assert.equal(resolveBusinessAction('PUT', '/repair-experiences/6').label, '编辑维修经验');
  const voided = resolveBusinessAction('POST', '/api/v1/work-orders/38/void', {
    reason: '重复录入',
    confirmReversal: true,
  });
  assert.equal(voided.code, 'work_order_void');
  assert.equal(voided.label, '作废工单');
  assert.equal(
    resolveBusinessAction('DELETE', '/api/v1/work-orders/38', { confirmation: '永久删除' }).label,
    '永久删除工单',
  );
  assert.equal(voided.objectId, 38);
});

test('日志详情只摘要业务索引，不记联系人和表单原文', () => {
  const event = resolveBusinessAction('POST', '/repair-requests', {
    entryMode: 'form',
    communityId: 3,
    contactPhone: '13800000000',
    content: '不应进日志的报修原文',
  });
  assert.deepEqual(event.detail, { communityId: 3, entryMode: 'form' });
});

test('公寓收费提交进入日志管理且不记录住户隐私', () => {
  const event = resolveBusinessAction('POST', '/api/v1/fees/cashier/charges', {
    houseId: 900,
    ownerName: '不应进入日志',
    ownerPhone: '13800000000',
    paymentMethod: 'wechat',
    items: [{ feeCode: 'rent', amountCents: 120000 }],
  });
  assert.equal(event.code, 'apartment_charge_create');
  assert.equal(event.label, '办理公寓收费');
  assert.deepEqual(event.detail, { houseId: 900, itemCount: 1 });
});

test('暂未配置中文名的接口也按路由分别统计，不再全部混成一个事件', () => {
  const upload = resolveBusinessAction('POST', '/api/v1/upload');
  const notice = resolveBusinessAction('POST', '/api/v1/notifications/templates/test');
  assert.equal(upload.label, '新增/提交附件');
  assert.notEqual(upload.code, notice.code);
});

test('接口告警直接说明业务动作、失败次数、状态码和原因', () => {
  assert.equal(
    apiEndpointLabel('/api/v1/external-access/apps/1/sync'),
    '外部访问应用同步',
  );
  assert.deepEqual(buildApiErrorAlert({
    source: 'admin-web',
    errors: 5,
    requests: 32,
    path: '/api/v1/external-access/apps/1/sync',
    statusCode: 503,
    reason: 'Cloudflare 自动发布尚未配置完整，请补充服务器环境变量',
  }), {
    title: '外部访问应用同步失败',
    message: '最近10分钟，管理后台的“外部访问应用同步”失败 5 次（HTTP 503，共 32 次请求）。原因：Cloudflare 自动发布尚未配置完整，请补充服务器环境变量。请到日志管理查看并处理。',
  });
});
