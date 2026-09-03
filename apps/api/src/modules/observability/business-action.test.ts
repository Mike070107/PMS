import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveBusinessAction } from './business-action';

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

test('暂未配置中文名的接口也按路由分别统计，不再全部混成一个事件', () => {
  const upload = resolveBusinessAction('POST', '/api/v1/upload');
  const notice = resolveBusinessAction('POST', '/api/v1/notifications/templates/test');
  assert.equal(upload.label, '新增/提交附件');
  assert.notEqual(upload.code, notice.code);
});
