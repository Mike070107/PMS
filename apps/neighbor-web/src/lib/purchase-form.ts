/**
 * 采购申请 → 纸面《材料申购单》的数据映射（2026-11：采购流程审批环节导出 Excel）。
 *
 * 版式与旧后台「下载申购单」完全一致，实际写文件仍用 @legacy/lib/purchaseRequestForm，
 * 这里只把审批列表上的 PurchaseRequestView 摊平成那张表要的字段，方便单测。
 */
import dayjs from 'dayjs';
import type { PurchaseRequestView } from '@pms/shared-types';
import type { PurchaseFormData } from '@legacy/lib/purchaseRequestForm';

export function purchaseFormOf(request: PurchaseRequestView, areaName: string): PurchaseFormData {
  return {
    areaName: (areaName || '').trim(),
    requestNo: request.requestNo,
    // 审批人先看经办人（办公室汇总的人），没有才退回申请人
    applicantName: request.officeReviewerName || request.applicantName || '',
    dateText: request.createdAt ? dayjs(request.createdAt).format('YYYY/M/D') : '',
    reason:
      (request.reason || '').trim() ||
      (request.workOrderNo ? `来源工单 ${request.workOrderNo}` : ''),
    // 已驳回的行不再采购，导出时不该出现在申购单上
    items: request.items
      .filter((item) => !item.rejectReason)
      .map((item) => ({
        name: item.materialName || item.name,
        spec: item.spec || '',
        qty: item.qty,
        unit: item.unit || '',
        note: item.note || '',
        sourceOrderNo: item.sourceWorkOrderNo || '',
        photoUrl: item.photoUrl || item.photoUrls?.[0] || undefined,
      })),
  };
}
