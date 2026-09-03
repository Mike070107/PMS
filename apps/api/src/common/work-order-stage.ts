import { WorkOrderStatus } from './enums';

/**
 * 工单类型 / 要求完成截止日期只允许在「待维修阶段」（待派单、已派单）改，
 * 开工后锁定：维修工已经按类型领了料、按截止排了班，事后再改会让轨迹和统计对不上号。
 * 后台详情据此把这两项置灰，接口据此拦（2026-08-26 要求）。
 * 前端用的同名函数在 packages/shared-types/src/index.ts，两边要一起改。
 */
export const REPAIR_TYPE_AND_SLA_EDITABLE_STATUSES: WorkOrderStatus[] = [
  WorkOrderStatus.CREATED,
  WorkOrderStatus.DISPATCHED,
];

export function canEditRepairTypeAndSla(status: WorkOrderStatus): boolean {
  return REPAIR_TYPE_AND_SLA_EDITABLE_STATUSES.includes(status);
}

/** 拦下来时给用户看的原因；可改时返回 null */
export function repairTypeAndSlaLockReason(status: WorkOrderStatus): string | null {
  if (canEditRepairTypeAndSla(status)) return null;
  return status === WorkOrderStatus.COMPLETED || status === WorkOrderStatus.CANCELLED || status === WorkOrderStatus.VOIDED
    ? '工单已完结，不能再修改'
    : '已开始维修，不能再修改';
}
