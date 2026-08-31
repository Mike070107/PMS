/**
 * 「还在手上要干」还是「已经完结」—— 只此一份判断。
 *
 * 工单池的「已完结」档和「在手工单」页分的是同一条线：一个列已完结的，
 * 一个列没完结的，两边各写一份的话，某个状态被漏在中间就会两处都看不到那张单。
 */
import { WorkOrderStatus } from '@pms/shared-types';

/** 还要人动手的四个状态；其余（待验收/已完成/已撤单）都归「已完结」 */
export const ACTIVE_STATUSES: string[] = [
  WorkOrderStatus.CREATED,
  WorkOrderStatus.DISPATCHED,
  WorkOrderStatus.IN_PROGRESS,
  WorkOrderStatus.WAITING_MATERIAL,
];

export function isActiveOrder(status: string): boolean {
  return ACTIVE_STATUSES.indexOf(status) >= 0;
}
