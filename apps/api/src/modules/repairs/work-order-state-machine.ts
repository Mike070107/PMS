import { BadRequestException } from '@nestjs/common';
import { WorkOrderStatus } from '../../common/enums';

/**
 * 工单状态变化必须携带业务动作，避免只校验「目标状态」而绕过流程语义。
 * 新增状态或动作时只改这一张表，service 不再各自维护状态数组。
 */
export type WorkOrderTransitionAction =
  | 'assign'
  | 'accept'
  | 'claim'
  | 'complete'
  | 'need_material'
  | 'transfer'
  | 'review'
  | 'auto_review_complete'
  | 'cancel';

interface TransitionRule {
  from: readonly WorkOrderStatus[];
  to: WorkOrderStatus;
}

export const WORK_ORDER_TRANSITIONS: Record<
  WorkOrderTransitionAction,
  TransitionRule
> = {
  assign: {
    from: [
      WorkOrderStatus.CREATED,
      WorkOrderStatus.DISPATCHED,
      WorkOrderStatus.IN_PROGRESS,
      WorkOrderStatus.WAITING_MATERIAL,
    ],
    to: WorkOrderStatus.DISPATCHED,
  },
  accept: {
    from: [WorkOrderStatus.DISPATCHED],
    to: WorkOrderStatus.IN_PROGRESS,
  },
  claim: {
    from: [
      WorkOrderStatus.CREATED,
      WorkOrderStatus.DISPATCHED,
      WorkOrderStatus.WAITING_MATERIAL,
    ],
    to: WorkOrderStatus.IN_PROGRESS,
  },
  complete: {
    from: [WorkOrderStatus.IN_PROGRESS, WorkOrderStatus.WAITING_MATERIAL],
    to: WorkOrderStatus.DONE_PENDING_REVIEW,
  },
  need_material: {
    from: [WorkOrderStatus.DISPATCHED, WorkOrderStatus.IN_PROGRESS],
    to: WorkOrderStatus.WAITING_MATERIAL,
  },
  transfer: {
    from: [WorkOrderStatus.IN_PROGRESS],
    to: WorkOrderStatus.CREATED,
  },
  review: {
    from: [WorkOrderStatus.DONE_PENDING_REVIEW],
    to: WorkOrderStatus.COMPLETED,
  },
  auto_review_complete: {
    from: [WorkOrderStatus.DONE_PENDING_REVIEW],
    to: WorkOrderStatus.COMPLETED,
  },
  cancel: {
    from: [
      WorkOrderStatus.CREATED,
      WorkOrderStatus.DISPATCHED,
      WorkOrderStatus.IN_PROGRESS,
      WorkOrderStatus.WAITING_MATERIAL,
    ],
    to: WorkOrderStatus.CANCELLED,
  },
};

export function canTransitionWorkOrder(
  from: WorkOrderStatus,
  to: WorkOrderStatus,
  action: WorkOrderTransitionAction,
): boolean {
  const rule = WORK_ORDER_TRANSITIONS[action];
  return rule.to === to && rule.from.includes(from);
}

export function assertWorkOrderTransition(
  from: WorkOrderStatus,
  to: WorkOrderStatus,
  action: WorkOrderTransitionAction,
  message = '当前工单状态不允许执行此操作',
): void {
  if (!canTransitionWorkOrder(from, to, action)) {
    throw new BadRequestException(message);
  }
}
