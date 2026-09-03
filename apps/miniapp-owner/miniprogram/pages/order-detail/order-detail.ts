import { repairs } from '@pms/api-client';
import { buildTimeline, statusLabel } from '@pms/miniapp-ui';
import {
  formatDateTimeCn,
  REPAIR_TYPE_LABELS,
  WorkOrderStatus,
  type WorkOrderDetail,
} from '@pms/shared-types';

interface TimelineRow {
  id: number;
  label: string;
  note: string;
  at: string;
}

interface PageData {
  id: string;
  detail: WorkOrderDetail | null;
  typeLabel: string;
  createdAtText: string;
  currentStatusLabel: string;
  timeline: TimelineRow[];
  canReview: boolean;
  canCancel: boolean;
  canUrge: boolean;
  rating: number;
  comment: string;
  submitting: boolean;
}

const CANCEL_REASONS = [
  { code: 'self_resolved', label: '已自行解决' },
  { code: 'wrong_info', label: '信息填错了' },
  { code: 'duplicate', label: '重复提交' },
  { code: 'owner_cancel', label: '暂时不需要了' },
];

const ACTIVE_STATUSES: WorkOrderStatus[] = [
  WorkOrderStatus.CREATED,
  WorkOrderStatus.DISPATCHED,
  WorkOrderStatus.IN_PROGRESS,
  WorkOrderStatus.WAITING_MATERIAL,
];

Page<PageData, WechatMiniprogram.IAnyObject>({
  data: {
    id: '',
    detail: null,
    typeLabel: '',
    createdAtText: '',
    currentStatusLabel: '',
    timeline: [],
    canReview: false,
    canCancel: false,
    canUrge: false,
    rating: 5,
    comment: '',
    submitting: false,
  },

  onLoad(q: Record<string, string>) {
    this.setData({ id: q.id || '' });
    this.load();
  },

  async load() {
    if (!this.data.id) return;
    try {
      const detail = await repairs.detail(this.data.id);
      const status = detail.workOrder.status;
      const timelineLabels = {
        ...statusLabel,
        [WorkOrderStatus.CREATED]: detail.workOrder.candidateIds?.length ? '待接单' : '待派单',
      };
      this.setData({
        detail,
        // 中文类型名以后端为准，租户自建的类型端上认不出（会显示成 menjing 这种编码）
        typeLabel:
          detail.request?.repairTypeLabel ||
          REPAIR_TYPE_LABELS[detail.request?.repairType || ''] ||
          detail.request?.repairType ||
          '其它',
        createdAtText: formatDateTimeCn(detail.workOrder.createdAt),
        currentStatusLabel:
          status === WorkOrderStatus.CREATED
            ? detail.workOrder.candidateIds?.length ? '待接单' : '待派单'
            : '',
        timeline: buildTimeline(detail.logs, timelineLabels, { finished: [WorkOrderStatus.COMPLETED, WorkOrderStatus.CANCELLED].indexOf(status) >= 0 }),
        canReview: status === WorkOrderStatus.DONE_PENDING_REVIEW,
        canCancel: ACTIVE_STATUSES.indexOf(status) >= 0,
        canUrge: ACTIVE_STATUSES.indexOf(status) >= 0,
      });
    } catch (e: any) {
      wx.showToast({ icon: 'none', title: e?.message || '加载失败' });
    }
  },

  onPreviewImage(e: WechatMiniprogram.BaseEvent) {
    const urls = (e.currentTarget.dataset.urls as string[] | undefined) || this.data.detail?.request?.attachments || [];
    if (!urls.length) return;
    wx.previewImage({ current: e.currentTarget.dataset.url, urls });
  },

  setRating(e: WechatMiniprogram.BaseEvent) {
    this.setData({ rating: Number(e.currentTarget.dataset.n) });
  },

  onComment(e: WechatMiniprogram.Input) {
    this.setData({ comment: e.detail.value });
  },

  async onReview() {
    this.setData({ submitting: true });
    try {
      await repairs.review(this.data.id, {
        rating: this.data.rating,
        comment: this.data.comment || undefined,
      });
      wx.showToast({ title: '已验收，谢谢评价' });
      setTimeout(() => wx.navigateBack(), 800);
    } catch (e: any) {
      wx.showToast({ icon: 'none', title: e?.message || '提交失败' });
    } finally {
      this.setData({ submitting: false });
    }
  },

  async onUrge() {
    try {
      await repairs.urge(this.data.id);
      wx.showToast({ title: '已催单，物业会尽快处理' });
      this.load();
    } catch (e: any) {
      wx.showToast({ icon: 'none', title: e?.message || '催单失败' });
    }
  },

  async onCancel() {
    const res = await wx
      .showActionSheet({ itemList: CANCEL_REASONS.map((item) => item.label) })
      .catch(() => null);
    if (!res || res.tapIndex == null) return;
    const reason = CANCEL_REASONS[res.tapIndex];
    try {
      await repairs.cancel(this.data.id, { reasonCode: reason.code, note: reason.label });
      wx.showToast({ title: '已撤单' });
      this.load();
    } catch (e: any) {
      wx.showToast({ icon: 'none', title: e?.message || '撤单失败' });
    }
  },
});
