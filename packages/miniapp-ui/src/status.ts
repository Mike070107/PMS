import { WorkOrderStatus } from '@pms/shared-types';

export const statusLabel: Record<WorkOrderStatus, string> = {
  [WorkOrderStatus.CREATED]: '待派单',
  [WorkOrderStatus.DISPATCHED]: '已派单',
  [WorkOrderStatus.IN_PROGRESS]: '维修中',
  [WorkOrderStatus.WAITING_MATERIAL]: '等待材料',
  [WorkOrderStatus.DONE_PENDING_REVIEW]: '待验收',
  [WorkOrderStatus.COMPLETED]: '已完成',
  [WorkOrderStatus.CANCELLED]: '已撤单',
  [WorkOrderStatus.VOIDED]: '已作废',
};

export const statusColor: Record<WorkOrderStatus, string> = {
  [WorkOrderStatus.CREATED]: '#faad14',
  [WorkOrderStatus.DISPATCHED]: '#31558a',
  [WorkOrderStatus.IN_PROGRESS]: '#31558a',
  [WorkOrderStatus.WAITING_MATERIAL]: '#faad14',
  [WorkOrderStatus.DONE_PENDING_REVIEW]: '#722ed1',
  [WorkOrderStatus.COMPLETED]: '#52c41a',
  [WorkOrderStatus.CANCELLED]: '#8c8c8c',
  [WorkOrderStatus.VOIDED]: '#8c8c8c',
};
