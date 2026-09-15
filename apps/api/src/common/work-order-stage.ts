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

/**
 * 报修地址允许改到什么时候（2026-09-15 Mike 要的）。
 *
 * 和类型/截止日期不一样，**开工之后也得能改**：地址认错（语音听岔、报修人说错）
 * 往往就是维修工到了现场才发现的 —— 这时候不给改，只能作废重报，
 * 之前的进度、用料、照片全白做。
 * 但完工之后不给改：那是在改已经发生过的事实，统计和业主验收都会对不上。
 */
export const ADDRESS_EDITABLE_STATUSES: WorkOrderStatus[] = [
  WorkOrderStatus.CREATED,
  WorkOrderStatus.DISPATCHED,
  WorkOrderStatus.IN_PROGRESS,
  WorkOrderStatus.WAITING_MATERIAL,
];

export function canEditWorkOrderAddress(status: WorkOrderStatus): boolean {
  return ADDRESS_EDITABLE_STATUSES.includes(status);
}

/** 拦下来时给用户看的原因；可改时返回 null */
export function workOrderAddressLockReason(status: WorkOrderStatus): string | null {
  if (canEditWorkOrderAddress(status)) return null;
  if (status === WorkOrderStatus.VOIDED) return '工单已作废，不能再改地址';
  if (status === WorkOrderStatus.CANCELLED) return '工单已撤单，不能再改地址';
  return '工单已完工，不能再改地址；地址确实报错了请作废后重报';
}
