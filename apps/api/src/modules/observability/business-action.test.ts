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
