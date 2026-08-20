import assert from 'node:assert/strict';
import test from 'node:test';
import { WorkOrderStatus } from '../../common/enums';
import {
  assertWorkOrderTransition,
  canTransitionWorkOrder,
} from './work-order-state-machine';

test('allows the supported repair lifecycle transitions', () => {
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
