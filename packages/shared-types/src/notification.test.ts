import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyNotification } from './notification';

test('新工单待接归为需处理的工单消息', () => {
  assert.deepEqual(classifyNotification('order_assigned'), {
    category: 'work_order',
    categoryLabel: '工单',
    categoryTone: 'blue',
    priority: 'action',
    priorityLabel: '待处理',
    important: true,
  });
});

test('已派单给业主的状态同步是普通通知', () => {
  const result = classifyNotification('order_dispatched');
  assert.equal(result.category, 'work_order');
  assert.equal(result.priority, 'normal');
  assert.equal(result.important, false);
});

test('审批、库存差异和系统异常能正确分开', () => {
  assert.equal(classifyNotification('purchase_pending_manager').category, 'approval');
  assert.equal(classifyNotification('receipt_qty_variance').category, 'inventory');
  assert.equal(classifyNotification('system_alert').category, 'system');
  assert.equal(classifyNotification('system_alert').priority, 'action');
});

test('新事件可按前缀归类，但不擅自标成待处理', () => {
  const result = classifyNotification('order_future_event');
  assert.equal(result.category, 'work_order');
  assert.equal(result.priority, 'normal');
});

