import { compareStaffWorkOrders, type StaffSortableWorkOrder, type StaffWorkOrderSort } from '@pms/shared-types';

export type WorkOrderSort = StaffWorkOrderSort;
export type WorkOrderSortPage = 'my-orders' | 'pool' | 'dispatch';
type SortIdentity = { tenantId: number | null; id: number } | null | undefined;

export const WORK_ORDER_SORT_OPTIONS: Array<{ value: WorkOrderSort; label: string }> = [
  { value: 'reported_asc', label: '报修时间正序' },
  { value: 'reported_desc', label: '报修时间倒序' },
  { value: 'address', label: '小区楼栋顺序' },
];

export function workOrderSortIndex(sort: WorkOrderSort): number {
  return Math.max(0, WORK_ORDER_SORT_OPTIONS.findIndex((item) => item.value === sort));
}

function preferenceKey(me: SortIdentity, page: WorkOrderSortPage): string | null {
  return me?.id && me.tenantId != null
    ? `pms.staff.work-order-sort.${me.tenantId}.${me.id}.${page}`
    : null;
}

export function readWorkOrderSort(me: SortIdentity, page: WorkOrderSortPage): WorkOrderSort {
  const fallback = page === 'my-orders' ? 'address' : 'reported_desc';
  const key = preferenceKey(me, page);
  if (!key) return fallback;
  try {
    const value = wx.getStorageSync(key);
    return WORK_ORDER_SORT_OPTIONS.some((item) => item.value === value) ? value : fallback;
  } catch {
    return fallback;
  }
}

export function saveWorkOrderSort(me: SortIdentity, page: WorkOrderSortPage, sort: WorkOrderSort): void {
  const key = preferenceKey(me, page);
  if (!key) return;
  try { wx.setStorageSync(key, sort); } catch { /* 存储不可用仍允许本次排序。 */ }
}

/** 与 API 共用比较器，必须取全量候选排序后截断，端上不得额外插队/折叠重排。 */
export function sortWorkOrders<T extends StaffSortableWorkOrder>(rows: T[], sort: WorkOrderSort): T[] {
  return rows.slice().sort((a, b) => compareStaffWorkOrders(a, b, sort));
}
