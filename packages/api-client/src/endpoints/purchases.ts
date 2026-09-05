import type { PurchaseRequestStatus, PurchaseRequestView } from '@pms/shared-types';
import { request } from '../request';

export const listRequests = (query: { status?: PurchaseRequestStatus } = {}) =>
  request<PurchaseRequestView[]>({ url: '/purchase-requests', query: query as any });

/** 办公室汇总：把若干张待汇总的申请合并成一张提交经理（单张也走这里） */
export const submitToManager = (data: { requestIds: number[] }) =>
  request<PurchaseRequestView>({ method: 'POST', url: '/purchase-requests/submit-to-manager', data });

/** 物业经理审批通过 → 流转到采购经理 */
export const managerApprove = (id: number | string) =>
  request<PurchaseRequestView>({
    method: 'POST',
    url: `/purchase-requests/${id}/manager-approve`,
  });

/** 采购经理审批通过 → 可下单 */
export const purchaserApprove = (id: number | string) =>
  request<PurchaseRequestView>({
    method: 'POST',
    url: `/purchase-requests/${id}/purchaser-approve`,
  });

export const reject = (id: number | string, data: { reason: string }) =>
  request<PurchaseRequestView>({
    method: 'POST',
    url: `/purchase-requests/${id}/reject`,
    data,
  });

export const rejectItem = (
  id: number | string,
  data: { lineId: string; reason: string },
) =>
  request<PurchaseRequestView>({
    method: 'POST',
    url: `/purchase-requests/${id}/reject-item`,
    data,
  });

export const updateItems = (
  id: number | string,
  data: { items: Array<{ lineId: string; materialId?: number; name: string; qty: number; unit?: string; estUnitCostCents?: number }> },
) =>
  request<PurchaseRequestView>({
    method: 'PATCH',
    url: `/purchase-requests/${id}/items`,
    data,
  });
