import assert from 'node:assert/strict';
import test from 'node:test';
import { workOrderStatusText } from '../../../../../packages/shared-types/src';
import { WorkOrderStatus } from '../../common/enums';
import {
  assertWorkOrderTransition,
  canTransitionWorkOrder,
  workOrderRollbackTarget,
} from './work-order-state-machine';

test('allows the supported repair lifecycle transitions', () => {
  assert.equal(
    canTransitionWorkOrder(
      WorkOrderStatus.CREATED,
      WorkOrderStatus.IN_PROGRESS,
      'claim',
    ),
    true,
  );
  assert.equal(
    canTransitionWorkOrder(
      WorkOrderStatus.CREATED,
      WorkOrderStatus.DISPATCHED,
      'assign',
    ),
    true,
  );
  assert.equal(
    canTransitionWorkOrder(
      WorkOrderStatus.WAITING_MATERIAL,
      WorkOrderStatus.IN_PROGRESS,
      'claim',
    ),
    true,
  );
  assert.equal(
    canTransitionWorkOrder(
      WorkOrderStatus.DONE_PENDING_REVIEW,
      WorkOrderStatus.COMPLETED,
      'review',
    ),
    true,
  );
  assert.equal(
    canTransitionWorkOrder(
      WorkOrderStatus.IN_PROGRESS,
      WorkOrderStatus.CREATED,
      'transfer',
    ),
    true,
  );
  assert.equal(
    canTransitionWorkOrder(
      WorkOrderStatus.DISPATCHED,
      WorkOrderStatus.CREATED,
      'transfer',
    ),
    false,
  );
});

test('rejects a target state reached through the wrong action', () => {
  assert.equal(
    canTransitionWorkOrder(
      WorkOrderStatus.CREATED,
      WorkOrderStatus.COMPLETED,
      'review',
    ),
    false,
  );
  assert.throws(() =>
    assertWorkOrderTransition(
      WorkOrderStatus.COMPLETED,
      WorkOrderStatus.CANCELLED,
      'cancel',
    ),
  );
});

test('shows created orders as pending dispatch or pending acceptance by routing result', () => {
  assert.equal(workOrderStatusText('created', []), '待派单');
  assert.equal(workOrderStatusText('created', [18]), '待接单');
  assert.equal(workOrderStatusText('in_progress', [18]), '维修中');
});

test('rolls work orders back one real business step, including branch states', () => {
  assert.equal(
    workOrderRollbackTarget(WorkOrderStatus.DISPATCHED),
    WorkOrderStatus.CREATED,
  );
  assert.equal(
    workOrderRollbackTarget(WorkOrderStatus.IN_PROGRESS),
    WorkOrderStatus.DISPATCHED,
  );
  assert.equal(
    workOrderRollbackTarget(WorkOrderStatus.WAITING_MATERIAL, WorkOrderStatus.IN_PROGRESS),
    WorkOrderStatus.IN_PROGRESS,
  );
  assert.equal(
    workOrderRollbackTarget(WorkOrderStatus.DONE_PENDING_REVIEW, WorkOrderStatus.WAITING_MATERIAL),
    WorkOrderStatus.WAITING_MATERIAL,
  );
  assert.equal(
    workOrderRollbackTarget(WorkOrderStatus.COMPLETED),
    WorkOrderStatus.DONE_PENDING_REVIEW,
  );
  assert.equal(
    workOrderRollbackTarget(WorkOrderStatus.CANCELLED, WorkOrderStatus.DISPATCHED),
    WorkOrderStatus.DISPATCHED,
  );
  assert.equal(workOrderRollbackTarget(WorkOrderStatus.CREATED), null);
  assert.equal(workOrderRollbackTarget(WorkOrderStatus.CANCELLED, WorkOrderStatus.COMPLETED), null);
});
