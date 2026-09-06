/**
 * 采购申请详情 / 编辑页（2026-09-06 Mike：小程序端也要能点开看详情、编辑、补照片）。
 *
 * 从「审批」页的卡片进来。看：全部照片、名称 / 型号 / 备注、数量金额、来源工单、申请原因、审批到哪一步。
 * 改：申请还在「办公室汇总」且本人有材料编辑权时，每行可改名称 / 型号 / 数量 / 单位 / 备注、补删照片，
 * 改完可直接「提交到下一环」。审批人的通过 / 驳回仍在审批页做，这里不重复放。
 * 打开这页即把指向这张申请的未读站内信标已读（服务端在 GET 里做）。
 */
import { purchases, upload } from '@pms/api-client';
import { formatDateTimeCn } from '@pms/miniapp-ui';
import {
  PURCHASE_STATUS_LABELS,
  PurchaseRequestStatus,
  type PurchaseRequestItem,
  type PurchaseRequestView,
} from '@pms/shared-types';
import { getSession } from '../../utils/session';

interface LineRow extends PurchaseRequestItem {
  lineId: string;
  sourceText: string;
  amountText: string;
  photoUrl: string;
  photoUrls: string[];
}

interface EditDraft {
  lineId: string;
  name: string;
  spec: string;
  qty: string;
  unit: string;
  note: string;
  photoUrls: string[];
}

/** 和后台改明细同一上限（服务端也按 4 截） */
const MAX_PHOTOS = 4;

const yuan = (cents?: number) => `¥${((cents || 0) / 100).toFixed(2)}`;

function toLine(item: PurchaseRequestItem, index: number, requestId: number): LineRow {
  const photoUrls = (item.photoUrls || []).filter(Boolean);
  const photoUrl = item.photoUrl || photoUrls[0] || '';
  return {
    ...item,
    lineId: item.lineId || `${requestId}-${index + 1}`,
    photoUrls: photoUrls.length ? photoUrls : photoUrl ? [photoUrl] : [],
    photoUrl,
    sourceText: item.sourceWorkOrderNo || item.sourceRequestNo || '手工申请',
    amountText: item.estUnitCostCents != null ? yuan(item.estUnitCostCents * item.qty) : '未估价',
  };
}

Page({
  data: {
    id: 0,
    loading: true,
    error: '',
    row: null as PurchaseRequestView | null,
    statusLabel: '',
    amountText: '',
    createdAtText: '',
    sourceText: '',
    applicantText: '',
    /** 审批链走到哪：「当前：物业经理审批（已过 办公室汇总）」 */
    flowText: '',
    lines: [] as LineRow[],
    canEdit: false,
    /** 已驳回 + 有材料编辑权：能「重新打开」回到办公室汇总改了再提 */
    canReopen: false,
    nextStepLabel: '',
    maxPhotos: MAX_PHOTOS,
    editOpen: false,
    edit: null as EditDraft | null,
    editError: '',
    uploading: false,
    saving: false,
    submitting: false,
  },

  onLoad(query: Record<string, string>) {
    this.setData({ id: Number(query.id) || 0 });
  },

  onShow() {
    void this.load();
  },

  async onPullDownRefresh() {
    await this.load();
    wx.stopPullDownRefresh();
  },

  noop() {},

  async load() {
    if (!this.data.id) {
      this.setData({ loading: false, error: '缺少申请单编号' });
      return;
    }
    this.setData({ loading: true, error: '' });
    try {
      const row = await purchases.get(this.data.id);
      const session = await getSession();
      const canEdit = row.status === PurchaseRequestStatus.OFFICE_REVIEW && !!session.canEditMaterials;
      const canReopen = row.status === PurchaseRequestStatus.REJECTED && !!session.canEditMaterials;
      const steps = row.steps || [];
      const current = steps.find((step) => step.state === 'current');
      const done = steps.filter((step) => step.state === 'done').map((step) => step.label);
      this.setData({
        row,
        statusLabel: PURCHASE_STATUS_LABELS[row.status] || row.status,
        amountText: yuan(row.estTotalCents),
        createdAtText: formatDateTimeCn(row.createdAt),
        sourceText: row.sourceWorkOrderNos?.length
          ? row.sourceWorkOrderNos.join('、')
          : row.workOrderId
            ? row.workOrderNo || '未知工单'
            : '办公室手工发起，无来源工单',
        applicantText: row.applicantName || '未知申请人',
        flowText: current
          ? `当前：${current.label}${done.length ? `（已过 ${done.join('、')}）` : ''}`
          : '',
        lines: (row.items || []).map((item, index) => toLine(item, index, row.id)),
        canEdit,
        canReopen,
        nextStepLabel: row.nextStepLabel || '物业经理审批',
        loading: false,
      });
    } catch (e) {
      this.setData({ loading: false, error: (e as Error)?.message || '加载失败' });
    }
  },

  onPreviewPhoto(e: WechatMiniprogram.BaseEvent) {
    const url = String(e.currentTarget.dataset.url || '');
    const urls = ((e.currentTarget.dataset.urls || []) as string[]).filter(Boolean);
    const list = urls.length ? urls : url ? [url] : [];
    if (!list.length) return;
    wx.previewImage({ current: url || list[0], urls: list });
  },

  /** 来源工单号可点：顺便看一眼现场情况 */
  onOpenSourceOrder(e: WechatMiniprogram.BaseEvent) {
    const id = Number(e.currentTarget.dataset.orderId);
    if (!id) return;
    wx.navigateTo({ url: `/pages/order-detail/order-detail?id=${id}` });
  },

  // ---------- 编辑一行 ----------

  onEditLine(e: WechatMiniprogram.BaseEvent) {
    if (!this.data.canEdit) return;
    const lineId = String(e.currentTarget.dataset.lineId || '');
    const line = this.data.lines.find((item) => item.lineId === lineId);
    if (!line) return;
    this.setData({
      editOpen: true,
      editError: '',
      edit: {
        lineId: line.lineId,
        name: line.name || '',
        spec: line.spec || '',
        qty: String(line.qty ?? ''),
        unit: line.unit || '',
        note: line.note || '',
        photoUrls: [...line.photoUrls],
      },
    });
  },

  onEditInput(e: WechatMiniprogram.Input) {
    const field = String(e.currentTarget.dataset.field || '');
    if (!field || !this.data.edit) return;
    this.setData({ [`edit.${field}`]: e.detail.value, editError: '' });
  },

  onCloseEdit() {
    if (this.data.saving || this.data.uploading) return;
    this.setData({ editOpen: false });
  },

  /** page-container 被系统返回 / 右滑关掉：等价于关闭编辑层 */
  onOverlayLeave() {
    if (this.data.editOpen) this.setData({ editOpen: false });
  },

  async onAddPhoto() {
    const edit = this.data.edit;
    if (!edit || this.data.uploading) return;
    const room = MAX_PHOTOS - edit.photoUrls.length;
    if (room <= 0) return;
    let res: WechatMiniprogram.ChooseMediaSuccessCallbackResult;
    try {
      res = await wx.chooseMedia({
        count: room,
        mediaType: ['image'],
        sourceType: ['album', 'camera'],
        sizeType: ['compressed'],
      });
    } catch {
      return; // 用户取消
    }
    if (!res.tempFiles?.length) return;
    this.setData({ uploading: true, editError: '' });
    try {
      const uploaded = await upload.uploadTempFiles(res.tempFiles.map((item) => item.tempFilePath));
      const photoUrls = [...edit.photoUrls, ...uploaded.map((item) => item.publicUrl)].slice(0, MAX_PHOTOS);
      this.setData({ 'edit.photoUrls': photoUrls });
    } catch (e) {
      this.setData({ editError: (e as Error)?.message || '照片上传失败，请重试' });
    } finally {
      this.setData({ uploading: false });
    }
  },

  onRemovePhoto(e: WechatMiniprogram.BaseEvent) {
    const index = Number(e.currentTarget.dataset.index);
    const edit = this.data.edit;
    if (!edit || !Number.isInteger(index)) return;
    this.setData({ 'edit.photoUrls': edit.photoUrls.filter((_, i) => i !== index) });
  },

  async onSaveEdit() {
    const { edit, row, lines } = this.data;
    if (!edit || !row || this.data.saving) return;
    const name = edit.name.trim();
    const qty = Number(edit.qty);
    if (!name) {
      this.setData({ editError: '请填材料名称' });
      return;
    }
    if (!Number.isFinite(qty) || qty <= 0) {
      this.setData({ editError: '数量要大于 0' });
      return;
    }
    this.setData({ saving: true, editError: '' });
    try {
      // 服务端要求整张单的行一起提交（不许增删行），没改的行原样带回
      const items = lines.map((line) =>
        line.lineId === edit.lineId
          ? {
              lineId: line.lineId,
              materialId: line.materialId,
              name,
              qty,
              unit: edit.unit.trim() || undefined,
              spec: edit.spec.trim(),
              note: edit.note.trim(),
              photoUrls: edit.photoUrls,
              estUnitCostCents: line.estUnitCostCents ?? 0,
            }
          : {
              lineId: line.lineId,
              materialId: line.materialId,
              name: line.name,
              qty: line.qty,
              unit: line.unit,
              spec: line.spec,
              note: line.note,
              photoUrls: line.photoUrls,
              estUnitCostCents: line.estUnitCostCents ?? 0,
            },
      );
      await purchases.updateItems(row.id, { items });
      this.setData({ editOpen: false });
      wx.showToast({ title: '已保存', icon: 'success' });
      await this.load();
    } catch (e) {
      // 既写在按钮上方，也弹一下：服务端拒绝（权限 / 校验）时不能让人觉得「点了没反应」
      const msg = (e as Error)?.message || '保存失败，请重试';
      this.setData({ editError: msg });
      wx.showToast({ title: msg, icon: 'none', duration: 3000 });
    } finally {
      this.setData({ saving: false });
    }
  },

  // ---------- 已驳回：重新打开 ----------

  /** 已驳回 → 回到办公室汇总（审批人签字清掉），改明细、补图后再提交（2026-09-06 Mike） */
  async onReopen() {
    const { row } = this.data;
    if (!row || this.data.submitting) return;
    this.setData({ submitting: true });
    try {
      await purchases.reopen(row.id);
      wx.showToast({ title: '已重新打开，改好后再提交', icon: 'none' });
      await this.load();
    } catch (e) {
      wx.showToast({ title: (e as Error)?.message || '重新打开失败', icon: 'none' });
    } finally {
      this.setData({ submitting: false });
    }
  },

  // ---------- 办公室汇总阶段：不买了 ----------

  async onRejectRequest() {
    const { row } = this.data;
    if (!row || this.data.submitting) return;
    const reason = await new Promise<string>((resolve) => {
      wx.showModal({
        title: '驳回这张申请',
        editable: true,
        placeholderText: '为什么不买了（必填，2 个字以上）',
        confirmText: '驳回',
        success: (res) => resolve(res.confirm ? String(res.content || '').trim() : ''),
        fail: () => resolve(''),
      });
    });
    if (!reason) return;
    if (reason.length < 2) {
      wx.showToast({ title: '请写清楚原因', icon: 'none' });
      return;
    }
    this.setData({ submitting: true });
    try {
      await purchases.reject(row.id, { reason });
      wx.showToast({ title: '已驳回', icon: 'success' });
      await this.load();
    } catch (e) {
      wx.showToast({ title: (e as Error)?.message || '驳回失败', icon: 'none' });
    } finally {
      this.setData({ submitting: false });
    }
  },

  // ---------- 提交到下一环 ----------

  async onSubmit() {
    const { row, nextStepLabel } = this.data;
    if (!row || this.data.submitting) return;
    const confirmed = await new Promise<boolean>((resolve) => {
      wx.showModal({
        title: '提交审批',
        content: `提交后进入「${nextStepLabel}」，之后不能再改明细。`,
        confirmText: '提交',
        success: (res) => resolve(!!res.confirm),
        fail: () => resolve(false),
      });
    });
    if (!confirmed) return;
    this.setData({ submitting: true });
    try {
      await purchases.submitToManager({ requestIds: [row.id] });
      wx.showToast({ title: '已提交', icon: 'success' });
      await this.load();
    } catch (e) {
      wx.showToast({ title: (e as Error)?.message || '提交失败', icon: 'none' });
    } finally {
      this.setData({ submitting: false });
    }
  },
});
