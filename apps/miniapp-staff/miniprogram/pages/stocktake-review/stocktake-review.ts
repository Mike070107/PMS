import { stocktakes } from '@pms/api-client';
import {
  STOCKTAKE_REASON_OPTIONS,
  STOCKTAKE_STATUS_LABELS,
  type StocktakeDetailView,
  type StocktakeItemView,
} from '@pms/shared-types';
import { getSession } from '../../utils/session';

interface DifferenceRow extends StocktakeItemView {
  title: string;
  bookActualText: string;
  differenceText: string;
  tone: string;
  reasonText: string;
}

const qty = (value: number) =>
  Number.isInteger(Number(value)) ? String(Number(value)) : String(Number(value).toFixed(2));

Page({
  data: {
    id: '',
    loading: true,
    busy: false,
    canEdit: false,
    detail: null as StocktakeDetailView | null,
    statusLabel: '',
    statusTone: '',
    totalCount: 0,
    countedCount: 0,
    uncountedCount: 0,
    sameCount: 0,
    surplusCount: 0,
    shortageCount: 0,
    differences: [] as DifferenceRow[],
    canSubmit: false,
    canReview: false,
    approved: false,
    showActions: false,
    reviewNote: '',
    errorMsg: '',
  },

  onLoad(query: Record<string, string>) {
    this.setData({ id: query.id || '' });
  },

  onShow() {
    this.load();
  },

  async load() {
    if (!this.data.id) return;
    this.setData({ loading: true, errorMsg: '' });
    try {
      const [detail, session] = await Promise.all([stocktakes.detail(this.data.id), getSession(this)]);
      const counted = detail.items.filter((item) => item.actualQty != null);
      const differences = counted
        .filter((item) => Number(item.differenceQty) !== 0)
        .map((item) => this.decorate(item));
      const surplusCount = differences.filter((item) => Number(item.differenceQty) > 0).length;
      const shortageCount = differences.filter((item) => Number(item.differenceQty) < 0).length;
      this.setData({
        detail,
        canEdit: session.canEditMaterials,
        statusLabel: STOCKTAKE_STATUS_LABELS[detail.status],
        statusTone:
          detail.status === 'approved'
            ? 'done'
            : detail.status === 'submitted'
              ? 'review'
              : detail.status === 'rejected'
                ? 'reject'
                : 'active',
        totalCount: detail.totalCount,
        countedCount: detail.countedCount,
        uncountedCount: detail.totalCount - detail.countedCount,
        sameCount: counted.length - differences.length,
        surplusCount,
        shortageCount,
        differences,
        canSubmit: detail.status === 'counting' && detail.countedCount === detail.totalCount,
        canReview: detail.status === 'submitted',
        approved: detail.status === 'approved',
        showActions:
          session.canEditMaterials &&
          (detail.status === 'submitted' || detail.status === 'counting' || detail.status === 'rejected'),
        reviewNote: detail.reviewNote || '',
      });
    } catch (e: any) {
      this.setData({ errorMsg: e?.message || '盘点汇总加载失败' });
    } finally {
      this.setData({ loading: false });
    }
  },

  decorate(item: StocktakeItemView): DifferenceRow {
    const difference = Number(item.differenceQty || 0);
    const reason = STOCKTAKE_REASON_OPTIONS.find((option) => option.value === item.reasonCode);
    return {
      ...item,
      title: [item.material.name, item.material.spec].filter(Boolean).join(' · '),
      bookActualText: `账面 ${qty(item.bookQty)} · 实盘 ${qty(Number(item.actualQty))}`,
      differenceText: `${difference > 0 ? '+' : ''}${qty(difference)}${item.material.unit}`,
      tone: difference > 0 ? 'plus' : 'minus',
      reasonText: reason?.label || '未填写原因',
    };
  },

  onNote(e: WechatMiniprogram.Input) {
    this.setData({ reviewNote: e.detail.value, errorMsg: '' });
  },

  onBackCheck() {
    wx.redirectTo({ url: `/pages/stocktake-count/stocktake-count?id=${this.data.id}` });
  },

  async onSubmit() {
    if (!this.data.canSubmit) {
      return wx.showToast({ icon: 'none', title: `还有 ${this.data.uncountedCount} 项未盘点` });
    }
    const confirm = await wx
      .showModal({
        title: '提交办公室复核？',
        content: '提交后现场人员不能再修改；复核通过后才会生成盘盈、盘亏库存流水。',
        confirmText: '提交复核',
      })
      .catch(() => null);
    if (!confirm?.confirm) return;
    this.setData({ busy: true, errorMsg: '' });
    try {
      await stocktakes.submit(this.data.id);
      wx.showToast({ title: '已提交复核' });
      await this.load();
    } catch (e: any) {
      this.setData({ errorMsg: e?.message || '提交复核失败' });
    } finally {
      this.setData({ busy: false });
    }
  },

  async onApprove() {
    const confirm = await wx
      .showModal({
        title: '确认复核通过？',
        content: `本次共有 ${this.data.differences.length} 项差异。通过后立即生成库存调整流水，不能撤回。`,
        confirmText: '复核通过',
      })
      .catch(() => null);
    if (!confirm?.confirm) return;
    await this.review(true);
  },

  async onReject() {
    if (!this.data.reviewNote.trim()) return this.setData({ errorMsg: '退回时请填写需要重新核对的原因' });
    const confirm = await wx
      .showModal({ title: '退回重新盘点？', content: '现场人员修改后可以再次提交复核。', confirmText: '确认退回' })
      .catch(() => null);
    if (!confirm?.confirm) return;
    await this.review(false);
  },

  async review(approved: boolean) {
    this.setData({ busy: true, errorMsg: '' });
    try {
      await stocktakes.review(this.data.id, {
        approved,
        note: this.data.reviewNote.trim() || undefined,
      });
      wx.showToast({ title: approved ? '已复核并调整库存' : '已退回重新盘点' });
      if (approved) await this.load();
      else wx.redirectTo({ url: `/pages/stocktake-count/stocktake-count?id=${this.data.id}` });
    } catch (e: any) {
      this.setData({ errorMsg: e?.message || '复核操作失败' });
    } finally {
      this.setData({ busy: false });
    }
  },
});
