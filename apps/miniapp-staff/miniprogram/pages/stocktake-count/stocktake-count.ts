import { stocktakes, upload } from '@pms/api-client';
import {
  STOCKTAKE_REASON_OPTIONS,
  type StocktakeDetailView,
  type StocktakeItemView,
} from '@pms/shared-types';
import { guideHandlers } from '../../utils/guide';

interface CountRow extends StocktakeItemView {
  title: string;
  counted: boolean;
  qtyText: string;
  differenceText: string;
  differenceTone: string;
  searchText: string;
}

const cleanQty = (value: number | null | undefined) => {
  if (value == null) return '';
  return Number.isInteger(Number(value)) ? String(Number(value)) : String(Number(value).toFixed(2));
};

Page({
  onShow() { this.syncGuide(); },
  ...guideHandlers(),
  data: {
    /** 指导层：说明文字默认收起，点右上角「?」展开，见 utils/guide.ts */
    guide: false,
    id: '',
    loading: true,
    saving: false,
    uploading: false,
    detail: null as StocktakeDetailView | null,
    warehouseName: '',
    taskNo: '',
    progressText: '',
    progressPercent: 0,
    items: [] as CountRow[],
    visibleItems: [] as CountRow[],
    currentIndex: -1,
    current: null as CountRow | null,
    keyword: '',
    onlyUncounted: false,
    actualQty: '',
    reasonOptions: STOCKTAKE_REASON_OPTIONS.map((item) => item.label),
    reasonIndex: -1,
    note: '',
    attachments: [] as string[],
    differenceQty: null as number | null,
    differenceText: '',
    differenceTone: '',
    errorMsg: '',
  },

  pendingCode: '',

  onLoad(query: Record<string, string>) {
    this.pendingCode = query.code ? decodeURIComponent(query.code) : '';
    this.setData({ id: query.id || '' });
    this.load();
  },

  async load(preferredItemId?: number) {
    if (!this.data.id) return;
    this.setData({ loading: true, errorMsg: '' });
    try {
      const detail = await stocktakes.detail(this.data.id);
      if (!['counting', 'rejected'].includes(detail.status)) {
        wx.redirectTo({ url: `/pages/stocktake-review/stocktake-review?id=${detail.id}` });
        return;
      }
      const items = detail.items.map((item) => this.decorate(item));
      const progressPercent = detail.totalCount
        ? Math.min(100, Math.round((detail.countedCount / detail.totalCount) * 100))
        : 0;
      this.setData({
        detail,
        warehouseName: detail.warehouseName,
        taskNo: detail.taskNo,
        progressText: `${detail.countedCount} / ${detail.totalCount}`,
        progressPercent,
        items,
      });
      this.applyFilter();

      let index = preferredItemId ? items.findIndex((item) => item.id === preferredItemId) : -1;
      if (this.pendingCode) {
        const codeIndex = this.findByCode(this.pendingCode, items);
        if (codeIndex >= 0) index = codeIndex;
        else wx.showToast({ icon: 'none', title: '这个条码不在本次盘点清单里' });
        this.pendingCode = '';
      }
      if (index < 0) index = items.findIndex((item) => !item.counted);
      if (index < 0 && items.length) index = 0;
      if (index >= 0) this.selectIndex(index);
    } catch (e: any) {
      this.setData({ errorMsg: e?.message || '盘点清单加载失败' });
    } finally {
      this.setData({ loading: false });
    }
  },

  decorate(item: StocktakeItemView): CountRow {
    const difference = item.differenceQty == null ? null : Number(item.differenceQty);
    return {
      ...item,
      title: [item.material.name, item.material.spec].filter(Boolean).join(' · '),
      counted: item.actualQty != null,
      qtyText: item.actualQty == null ? '未盘' : `${cleanQty(item.actualQty)}${item.material.unit}`,
      differenceText:
        difference == null
          ? ''
          : difference === 0
            ? '一致'
            : `${difference > 0 ? '+' : ''}${cleanQty(difference)}${item.material.unit}`,
      differenceTone: difference == null || difference === 0 ? 'same' : difference > 0 ? 'plus' : 'minus',
      searchText: [
        item.material.code,
        item.material.name,
        item.material.spec,
        ...(item.material.aliases || []),
        item.locationLabel,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase(),
    };
  },

  applyFilter() {
    const keyword = this.data.keyword.trim().toLowerCase();
    this.setData({
      visibleItems: this.data.items.filter(
        (item) => (!this.data.onlyUncounted || !item.counted) && (!keyword || item.searchText.includes(keyword)),
      ),
    });
  },

  selectIndex(index: number) {
    const current = this.data.items[index];
    if (!current) return;
    const reasonIndex = STOCKTAKE_REASON_OPTIONS.findIndex((item) => item.value === current.reasonCode);
    this.setData(
      {
        currentIndex: index,
        current,
        actualQty: cleanQty(current.actualQty),
        reasonIndex,
        note: current.note || '',
        attachments: current.attachments || [],
        errorMsg: '',
      },
      () => this.refreshDifference(),
    );
  },

  onPickItem(e: WechatMiniprogram.BaseEvent) {
    const id = Number(e.currentTarget.dataset.id);
    const index = this.data.items.findIndex((item) => item.id === id);
    if (index >= 0) this.selectIndex(index);
  },

  onKeyword(e: WechatMiniprogram.Input) {
    this.setData({ keyword: e.detail.value }, () => this.applyFilter());
  },

  onToggleUncounted(e: WechatMiniprogram.CheckboxGroupChange) {
    this.setData({ onlyUncounted: (e.detail.value || []).includes('1') }, () => this.applyFilter());
  },

  onActual(e: WechatMiniprogram.Input) {
    this.setData({ actualQty: e.detail.value, errorMsg: '' }, () => this.refreshDifference());
  },

  onStep(e: WechatMiniprogram.BaseEvent) {
    const delta = Number(e.currentTarget.dataset.delta);
    const current = Number(this.data.actualQty || 0);
    this.setData({ actualQty: cleanQty(Math.max(0, current + delta)), errorMsg: '' }, () =>
      this.refreshDifference(),
    );
  },

  onClear() {
    this.setData({ actualQty: '0', errorMsg: '' }, () => this.refreshDifference());
  },

  onSame() {
    if (!this.data.current) return;
    this.setData({ actualQty: cleanQty(this.data.current.bookQty), reasonIndex: -1, errorMsg: '' }, () =>
      this.refreshDifference(),
    );
  },

  refreshDifference() {
    const current = this.data.current;
    const actual = Number(this.data.actualQty);
    if (!current || this.data.actualQty === '' || !Number.isFinite(actual)) {
      return this.setData({ differenceQty: null, differenceText: '', differenceTone: '' });
    }
    const difference = Number((actual - Number(current.bookQty)).toFixed(2));
    this.setData({
      differenceQty: difference,
      differenceText:
        difference === 0
          ? '与账面一致'
          : `${difference > 0 ? '盘盈' : '盘亏'} ${cleanQty(Math.abs(difference))}${current.material.unit}`,
      differenceTone: difference === 0 ? 'same' : difference > 0 ? 'plus' : 'minus',
      ...(difference === 0 ? { reasonIndex: -1 } : {}),
    });
  },

  onReason(e: WechatMiniprogram.PickerChange) {
    this.setData({ reasonIndex: Number(e.detail.value), errorMsg: '' });
  },

  onNote(e: WechatMiniprogram.Input) {
    this.setData({ note: e.detail.value });
  },

  async onScan() {
    const result = await wx.scanCode({ scanType: ['barCode', 'qrCode'] }).catch(() => null);
    if (!result?.result) return;
    const index = this.findByCode(result.result, this.data.items);
    if (index < 0) return wx.showToast({ icon: 'none', title: '这个条码不在本次盘点清单里' });
    this.selectIndex(index);
  },

  findByCode(code: string, items: CountRow[]) {
    const value = code.trim().toLowerCase();
    return items.findIndex(
      (item) =>
        item.material.code.toLowerCase() === value ||
        item.material.name.toLowerCase() === value ||
        (item.material.aliases || []).some((alias) => alias.toLowerCase() === value),
    );
  },

  async onChoosePhoto() {
    if (this.data.uploading || this.data.attachments.length >= 6) return;
    const result = await wx
      .chooseMedia({
        count: Math.min(3, 6 - this.data.attachments.length),
        mediaType: ['image'],
        sourceType: ['camera', 'album'],
        sizeType: ['compressed'],
      })
      .catch(() => null);
    if (!result?.tempFiles?.length) return;
    this.setData({ uploading: true });
    try {
      const uploaded = await upload.uploadTempFiles(result.tempFiles.map((item) => item.tempFilePath));
      this.setData({ attachments: [...this.data.attachments, ...uploaded.map((item) => item.publicUrl)] });
    } catch (e: any) {
      wx.showToast({ icon: 'none', title: e?.message || '照片上传失败' });
    } finally {
      this.setData({ uploading: false });
    }
  },

  onPreviewPhoto(e: WechatMiniprogram.BaseEvent) {
    const url = String(e.currentTarget.dataset.url || '');
    if (url) wx.previewImage({ current: url, urls: this.data.attachments });
  },

  onRemovePhoto(e: WechatMiniprogram.BaseEvent) {
    const next = this.data.attachments.slice();
    next.splice(Number(e.currentTarget.dataset.index), 1);
    this.setData({ attachments: next });
  },

  async onSaveNext() {
    const current = this.data.current;
    if (!current) return;
    const actual = Number(this.data.actualQty);
    if (this.data.actualQty === '' || !Number.isFinite(actual) || actual < 0) {
      return this.setData({ errorMsg: '请填写正确的实盘数量' });
    }
    const difference = Number((actual - Number(current.bookQty)).toFixed(2));
    const reason = this.data.reasonIndex >= 0 ? STOCKTAKE_REASON_OPTIONS[this.data.reasonIndex] : null;
    if (difference !== 0 && !reason) return this.setData({ errorMsg: '有盘盈或盘亏时请选择差异原因' });
    this.setData({ saving: true, errorMsg: '' });
    try {
      await stocktakes.countItem(this.data.id, current.id, {
        actualQty: actual,
        reasonCode: reason?.value,
        note: this.data.note.trim() || undefined,
        attachments: this.data.attachments,
      });
      const next = this.data.items.find((item, index) => index > this.data.currentIndex && !item.counted)
        || this.data.items.find((item, index) => index !== this.data.currentIndex && !item.counted);
      if (!next) {
        wx.redirectTo({ url: `/pages/stocktake-review/stocktake-review?id=${this.data.id}` });
        return;
      }
      await this.load(next.id);
    } catch (e: any) {
      this.setData({ errorMsg: e?.message || '保存盘点结果失败' });
    } finally {
      this.setData({ saving: false });
    }
  },

  onPrevious() {
    if (!this.data.items.length) return;
    const index = this.data.currentIndex > 0 ? this.data.currentIndex - 1 : this.data.items.length - 1;
    this.selectIndex(index);
  },

  onReview() {
    wx.navigateTo({ url: `/pages/stocktake-review/stocktake-review?id=${this.data.id}` });
  },
});
