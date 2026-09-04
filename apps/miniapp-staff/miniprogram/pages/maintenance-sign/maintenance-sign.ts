/**
 * 养护单查验签字：把《房屋修理养护任务单》正反面按**纸上的格子**画出来，签字落在纸上对应的格。
 *
 * 版面尺寸全部来自 @pms/shared-types 的 maintenance-sheet-geometry（和 Web 打印稿同一份，
 * 单位 mm）；表格数据由 sheet-model.ts 摊成「行 × 格」，这里只做 mm → rpx 的换算
 * （data.k = 1mm 等于多少 rpx），WXML 里 `{{w * k}}rpx`。缩放只改 k，不重算表格。
 * 2026-09-04 前是一版「分区卡片」，Mike 要求做成和 Web 端一样的实体单。
 */
import { maintenance, type MaintenanceSignSession } from '@pms/api-client';
import {
  BACK_LEFT_W,
  BACK_RIGHT,
  MAIN_LEFT,
  PAGE,
  PERF_LEFT,
  STUB_LEFT,
  STUB_W,
  TABLE_W,
  UNIT_LINE,
  VOUCHER_SPLIT,
} from '@pms/shared-types';
import { buildPages, parseDate, SHEET_CONSTANTS, type SheetPage, type SignSlot } from './sheet-model';

/**
 * 100% 时 1mm = 4.4rpx：主表 160mm 正好铺满 702rpx（屏宽 750 去掉两侧 24 边距）。
 * 默认落在 1.8 倍：标签 22rpx、值 27rpx，站着也看得清；再小就要眯眼。存根和背面靠横向滚动。
 */
const BASE_K = 4.4;
const ZOOMS = [1, 1.4, 1.8, 2.4, 3.2];
const DEFAULT_ZOOM_INDEX = 2;

function dateTimeText(value: unknown): string {
  const date = parseDate(value);
  if (!date) return '有效期未知';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}`;
}

Page({
  data: {
    token: '',
    orderId: 0,
    external: false,
    loading: true,
    error: '',
    slot: 'inspector' as SignSlot,
    slotLabel: '查验员',
    alreadySigned: false,
    expiresText: '',
    /** 纸面数据（每张纸正反两面） */
    pages: [] as SheetPage[],
    /** 1mm = 多少 rpx；缩放只改它 */
    k: BASE_K * ZOOMS[DEFAULT_ZOOM_INDEX],
    zoomIndex: DEFAULT_ZOOM_INDEX,
    zoomText: '180%',
    /** 纸张与版心位置（mm），WXML 里乘 k */
    geo: {
      pageW: PAGE.w,
      pageH: PAGE.h,
      tableW: TABLE_W,
      mainLeft: MAIN_LEFT,
      perfLeft: PERF_LEFT,
      stubLeft: STUB_LEFT,
      stubW: STUB_W,
      backMainLeft: PAGE.w - MAIN_LEFT - TABLE_W,
      backStubLeft: PAGE.w - STUB_LEFT - STUB_W,
      unitLeft: UNIT_LINE.left,
      unitW: UNIT_LINE.width,
      backLeftW: BACK_LEFT_W,
    },
    fsOf: SHEET_CONSTANTS.fsOf,
    addr: SHEET_CONSTANTS.addr,
    quotaSplit: SHEET_CONSTANTS.quotaSplit,
    voucherSplit: VOUCHER_SPLIT,
    backRight: BACK_RIGHT,
    padOpen: false,
    hasInk: false,
    draftImage: '',
    submitting: false,
  },

  order: null as Record<string, any> | null,
  canvasContext: null as WechatMiniprogram.CanvasContext | null,
  drawing: false,
  /**
   * 上一笔落点。旧版 canvas 每次 draw(true) 之后当前路径就被清空，下一段 lineTo 若没有
   * 先 moveTo 到上一点，会从 (0,0) 起笔 —— 这就是 2026-09-04 反馈的「随便写哪里都是
   * 从左上角放射出来的线」。所以每一小段都自己 moveTo(上一点) → lineTo(这一点)。
   */
  lastPoint: null as { x: number; y: number } | null,
  pinchStartDistance: 0,
  pinchStartIndex: DEFAULT_ZOOM_INDEX,

  onLoad(query: Record<string, string>) {
    const token = decodeURIComponent(query.token || '');
    const orderId = Number(query.id || 0);
    if (!token && !orderId) {
      this.setData({ loading: false, error: '签字凭证无效，请返回重新打开' });
      return;
    }
    this.setData({ token, orderId, external: !!token });
    this.loadSession();
  },

  async loadSession() {
    try {
      const session: MaintenanceSignSession = this.data.external
        ? await maintenance.signSession(this.data.token)
        : await maintenance.internalSignSession(this.data.orderId);
      this.order = session.order || {};
      this.setData({
        loading: false,
        error: '',
        slot: session.slot,
        slotLabel: session.slotLabel,
        alreadySigned: session.signed,
        expiresText: this.data.external && session.expiresAt
          ? `${dateTimeText(session.expiresAt)} 前有效`
          : '',
        pages: buildPages(this.order, session.slot, this.data.draftImage),
      });
    } catch (error: any) {
      this.setData({ loading: false, error: error?.message || '签字凭证已过期，请返回重新打开' });
    }
  },

  /** 草稿签名变了就重画一遍纸（只有目标格的图会变） */
  refreshPages() {
    if (!this.order) return;
    this.setData({ pages: buildPages(this.order, this.data.slot, this.data.draftImage) });
  },

  // ---------------- 缩放 ----------------

  zoomOut() { this.applyZoom(this.data.zoomIndex - 1); },
  zoomIn() { this.applyZoom(this.data.zoomIndex + 1); },

  applyZoom(index: number) {
    const next = Math.max(0, Math.min(ZOOMS.length - 1, index));
    if (next === this.data.zoomIndex) return;
    this.setData({
      zoomIndex: next,
      k: BASE_K * ZOOMS[next],
      zoomText: `${Math.round(ZOOMS[next] * 100)}%`,
    });
  },

  onPreviewTouchStart(event: any) {
    if (event.touches?.length !== 2) return;
    const [a, b] = event.touches;
    this.pinchStartDistance = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    this.pinchStartIndex = this.data.zoomIndex;
  },

  onPreviewTouchMove(event: any) {
    if (event.touches?.length !== 2 || !this.pinchStartDistance) return;
    const [a, b] = event.touches;
    const distance = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    const ratio = distance / this.pinchStartDistance;
    // 两指拉开 25% 进一档、捏拢 25% 退一档
    const steps = Math.round(Math.log(ratio) / Math.log(1.25));
    this.applyZoom(this.pinchStartIndex + steps);
  },

  onPreviewTouchEnd() {
    this.pinchStartDistance = 0;
  },

  // ---------------- 签字板 ----------------

  /** 纸上点了哪一格：只有本次要签的那一格（黄底）会打开签字板 */
  onCellTap(event: WechatMiniprogram.BaseEvent) {
    if (!event.currentTarget.dataset.target) return;
    this.openPad();
  },

  openPad() {
    this.setData({ padOpen: true, hasInk: false }, () => {
      const context = wx.createCanvasContext('maintenanceSignature', this);
      context.setStrokeStyle('#193f73');
      context.setLineWidth(4);
      context.setLineCap('round');
      context.setLineJoin('round');
      this.canvasContext = context;
    });
  },

  closePad() {
    this.drawing = false;
    this.setData({ padOpen: false });
  },

  startStroke(event: any) {
    const point = event.touches?.[0];
    const context = this.canvasContext;
    if (!point || !context) return;
    this.drawing = true;
    this.lastPoint = { x: point.x, y: point.y };
    // 点一下不拖也要留个点（签名里的「、」「丶」），否则只点不划什么都不出来
    context.beginPath();
    context.moveTo(point.x, point.y);
    context.lineTo(point.x + 0.5, point.y + 0.5);
    context.stroke();
    context.draw(true);
    if (!this.data.hasInk) this.setData({ hasInk: true });
  },

  moveStroke(event: any) {
    const context = this.canvasContext;
    const last = this.lastPoint;
    if (!this.drawing || !context || !last) return;
    const point = event.touches?.[0];
    if (!point) return;
    // 每一小段都从上一点起笔，见 lastPoint 的说明
    context.beginPath();
    context.moveTo(last.x, last.y);
    context.lineTo(point.x, point.y);
    context.stroke();
    context.draw(true);
    this.lastPoint = { x: point.x, y: point.y };
  },

  endStroke() {
    this.drawing = false;
    this.lastPoint = null;
  },

  clearPad() {
    const context = this.canvasContext;
    if (!context) return;
    this.lastPoint = null;
    context.clearRect(0, 0, 2000, 1000);
    context.draw();
    this.setData({ hasInk: false });
  },

  keepSignature() {
    if (!this.data.hasInk) {
      wx.showToast({ icon: 'none', title: '请先手写签名' });
      return;
    }
    wx.canvasToTempFilePath({
      canvasId: 'maintenanceSignature',
      fileType: 'png',
      quality: 1,
      success: (result) => {
        wx.getFileSystemManager().readFile({
          filePath: result.tempFilePath,
          encoding: 'base64',
          success: (file) => {
            const base64 = typeof file.data === 'string' ? file.data : '';
            if (!base64) {
              wx.showToast({ icon: 'none', title: '签名生成失败，请重试' });
              return;
            }
            this.setData({ draftImage: `data:image/png;base64,${base64}`, padOpen: false }, () => this.refreshPages());
          },
          fail: () => wx.showToast({ icon: 'none', title: '签名读取失败，请重试' }),
        });
      },
      fail: () => wx.showToast({ icon: 'none', title: '签名生成失败，请重试' }),
    }, this);
  },

  async submit() {
    if (!this.data.draftImage || this.data.submitting) {
      if (!this.data.draftImage) wx.showToast({ icon: 'none', title: `请先签署${this.data.slotLabel}` });
      return;
    }
    this.setData({ submitting: true });
    try {
      if (this.data.external) {
        await maintenance.submitSignature(this.data.token, this.data.draftImage);
      } else {
        await maintenance.submitInternalSignature(this.data.orderId, this.data.draftImage);
      }
      wx.showToast({ title: `${this.data.slotLabel}签字已保存`, icon: 'success', duration: 1200 });
      setTimeout(() => wx.navigateBack(), 900);
    } catch (error: any) {
      wx.showModal({
        title: '提交失败',
        content: error?.message || '请检查网络后重试',
        showCancel: false,
      });
    } finally {
      this.setData({ submitting: false });
    }
  },

  noop() {},
});
