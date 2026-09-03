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

/** 各状态的中文名，撤回预览、轨迹文案共用一份，别再各写各的 */
export const WORK_ORDER_STATUS_LABELS: Record<WorkOrderStatus, string> = {
  [WorkOrderStatus.CREATED]: '待派单/待接单',
  [WorkOrderStatus.DISPATCHED]: '已派单',
  [WorkOrderStatus.IN_PROGRESS]: '维修中',
  [WorkOrderStatus.WAITING_MATERIAL]: '等待材料',
  [WorkOrderStatus.DONE_PENDING_REVIEW]: '待验收',
  [WorkOrderStatus.COMPLETED]: '已完成',
  [WorkOrderStatus.CANCELLED]: '已撤单',
  [WorkOrderStatus.VOIDED]: '已作废',
};

export function workOrderStatusLabel(status: WorkOrderStatus): string {
  return WORK_ORDER_STATUS_LABELS[status] ?? status;
}

/**
 * 可以被「撤回上一步」撤销的业务动作。
 * 纯记录类动作（维修进度、催单、改类型、改时限）不在其中——它们没改变流程节点，
 * 撤回时必须跳过，否则会把「加了一条进度」当成上一步、退出一个莫名其妙的状态。
 */
export const ROLLBACKABLE_ACTIONS = [
  'assign',
  'auto_dispatch',
  'accept',
  'claim',
  'complete',
  'need_material',
  'transfer_request',
  'review',
  'auto_review_complete',
  'cancel',
] as const;

export type RollbackableAction = (typeof ROLLBACKABLE_ACTIONS)[number];

/**
 * 没有 before_snapshot 的历史日志（快照机制上线前的老单）里，哪些动作还能安全撤回。
 *
 * 判定标准是「不靠快照也能确定恢复成什么」：完工/验收退回上一状态是确定的；
 * 而转单、改派要恢复原负责人、原报修类型、原派单时间，缺了快照只能靠猜——
 * 猜错就是把工单挂到错的维修工头上，宁可拒绝并提示人工处理。
 */
export const LEGACY_SAFE_ROLLBACK_ACTIONS: readonly string[] = [
  'complete',
  'review',
  'auto_review_complete',
  'accept',
  'claim',
  'cancel',
  'need_material',
];

export interface RollbackCandidateLog {
  id: number;
  action: string;
  fromStatus: WorkOrderStatus | null;
  toStatus: WorkOrderStatus;
  revertedByLogId?: number | null;
  beforeSnapshot?: { status?: WorkOrderStatus } | null;
}

export interface RollbackResolution {
  /** 被撤销的那条业务日志 */
  log: RollbackCandidateLog;
  targetStatus: WorkOrderStatus;
  /** true=按快照恢复（精确）；false=老日志走兼容推导，只能恢复状态 */
  usedSnapshot: boolean;
}

export interface RollbackResolveResult {
  resolution?: RollbackResolution;
  /** 不能撤回时给用户看的原因，直接可展示 */
  blockedReason?: string;
}

/**
 * 找出「上一笔真实业务操作」并算出撤回目标状态。
 *
 * 关键点：目标状态**只从被撤销动作的 before 快照里取**，不再按当前状态硬编码退一格。
 * 同样是「维修中」，可能来自待派单主动认领、等待材料接回、或定向派单后接单，
 * 硬编码一律退到「已派单」在后两种情况下都是错的（2026-09-03 之前的行为）。
 *
 * @param logs 该工单的全部日志，**必须按 id 倒序**（最新在前）
 */
export function resolveRollback(
  current: WorkOrderStatus,
  logs: readonly RollbackCandidateLog[],
): RollbackResolveResult {
  const actions: readonly string[] = ROLLBACKABLE_ACTIONS;
  // 已经被撤回过的动作不能再撤第二次；否则连点两下就会连退两级。
  const candidate = logs.find(
    (log) =>
      actions.includes(log.action) && !log.revertedByLogId && log.toStatus === current,
  );
  if (!candidate) {
    return {
      blockedReason:
        current === WorkOrderStatus.CREATED
          ? '当前已经是最早的待派单/待接单节点，不能继续撤回'
          : '找不到可安全恢复的上一处理节点，请联系管理员核对工单轨迹',
    };
  }

  const snapshotStatus = candidate.beforeSnapshot?.status;
  if (snapshotStatus) {
    return { resolution: { log: candidate, targetStatus: snapshotStatus, usedSnapshot: true } };
  }

  if (!LEGACY_SAFE_ROLLBACK_ACTIONS.includes(candidate.action)) {
    return {
      blockedReason:
        '这一步是本次改造前记录的，缺少原维修工/原报修类型等信息，自动撤回可能恢复成错误的负责人。请在派单台手工调整。',
    };
  }
  const fallback = workOrderRollbackTarget(current, candidate.fromStatus);
  if (!fallback) {
    return { blockedReason: '找不到可安全恢复的上一处理节点，请联系管理员核对工单轨迹' };
  }
  return { resolution: { log: candidate, targetStatus: fallback, usedSnapshot: false } };
}
