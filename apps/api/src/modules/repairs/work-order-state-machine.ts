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

/**
 * 办公室“撤回上一步”的目标状态。
 *
 * 等待材料、待验收和已撤单都是旁路节点，必须优先按真正进入该节点时的来源返回；
 * 其余节点按标准主流程退一格。created 没有再早的可操作节点。
 */
export function workOrderRollbackTarget(
  current: WorkOrderStatus,
  previousFrom?: WorkOrderStatus | null,
): WorkOrderStatus | null {
  if (current === WorkOrderStatus.DISPATCHED) return WorkOrderStatus.CREATED;
  if (current === WorkOrderStatus.IN_PROGRESS) return WorkOrderStatus.DISPATCHED;
  if (current === WorkOrderStatus.WAITING_MATERIAL) {
    return previousFrom === WorkOrderStatus.DISPATCHED || previousFrom === WorkOrderStatus.IN_PROGRESS
      ? previousFrom
      : null;
  }
  if (current === WorkOrderStatus.DONE_PENDING_REVIEW) {
    return previousFrom === WorkOrderStatus.IN_PROGRESS || previousFrom === WorkOrderStatus.WAITING_MATERIAL
      ? previousFrom
      : null;
  }
  if (current === WorkOrderStatus.COMPLETED) return WorkOrderStatus.DONE_PENDING_REVIEW;
  if (current === WorkOrderStatus.CANCELLED) {
    return previousFrom && [
      WorkOrderStatus.CREATED,
      WorkOrderStatus.DISPATCHED,
      WorkOrderStatus.IN_PROGRESS,
      WorkOrderStatus.WAITING_MATERIAL,
    ].includes(previousFrom)
      ? previousFrom
      : null;
  }
  return null;
}
