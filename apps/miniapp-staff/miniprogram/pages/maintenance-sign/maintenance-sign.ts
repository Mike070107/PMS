import { maintenance, type MaintenanceSignSession } from '@pms/api-client';

type DisplayLine = Record<string, string>;

interface DisplayOrder {
  no: string;
  workOrderNo: string;
  unitName: string;
  addressText: string;
  reporterName: string;
  reportedOn: string;
  presentTime: string;
  faultPart: string;
  repairItem: string;
  appointOn: string;
  startOn: string;
  finishOn: string;
  partCategory: string;
  feeCategory: string;
  shareMethod: string;
  repairDateText: string;
  totalText: string;
  materialTotalText: string;
  voucherIssue: string;
  fillerName: string;
  fillerSignUrl: string;
  repairerName: string;
  repairerSignUrl: string;
  inspectorName: string;
  inspectorSignUrl: string;
  ownerSignUrl: string;
  items: DisplayLine[];
  materials: DisplayLine[];
  scrapNote: string;
  serviceRecord: string;
  followUpRecord: string;
}

const PART_LABELS: Record<string, string> = {
  self: '自用部位', shared: '共用部位', public: '公共设施',
};
const FEE_LABELS: Record<string, string> = {
  owner: '业主自理', repair_fund: '修缮基金', elevator_fund: '电梯水泵基金', public_fund: '公共设施基金',
};
const SHARE_LABELS: Record<string, string> = {
  natural: '自然幢', door: '门牌幢', zone: '住宅区域',
};

function text(value: unknown, fallback = '—'): string {
  const result = value === null || value === undefined ? '' : String(value).trim();
  return result || fallback;
}

function numberText(value: unknown): string {
  return value === null || value === undefined || value === '' ? '—' : String(value);
}

function money(value: unknown): string {
  const cents = Number(value);
  return Number.isFinite(cents) ? `¥${(cents / 100).toFixed(2)}` : '—';
}

function dateText(value: unknown): string {
  if (!value) return '—';
  const raw = String(value);
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function dateTimeText(value: unknown): string {
  if (!value) return '有效期未知';
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return String(value);
  return `${dateText(value)} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function toDisplay(session: MaintenanceSignSession): DisplayOrder {
  const order = session.order || {};
  return {
    no: text(order.paperNo || session.paperNo || order.orderNo || session.orderNo),
    workOrderNo: text(order.workOrderNo),
    unitName: text(order.unitName || session.unitName),
    addressText: text(order.addressText || session.addressText),
    reporterName: text(order.reporterName),
    reportedOn: dateText(order.reportedOn),
    presentTime: text(order.presentTime),
    faultPart: text(order.faultPart),
    repairItem: text(order.repairItem || session.repairItem),
    appointOn: dateText(order.appointOn),
    startOn: dateText(order.startOn),
    finishOn: dateText(order.finishOn),
    partCategory: text(PART_LABELS[String(order.partCategory || '')]),
    feeCategory: text(FEE_LABELS[String(order.feeCategory || '')]),
    shareMethod: text(SHARE_LABELS[String(order.shareMethod || '')]),
    repairDateText: text(order.repairDateText),
    totalText: money(order.totalCents),
    materialTotalText: money(order.materialTotalCents),
    voucherIssue: text(order.voucherIssue),
    fillerName: text(order.fillerName),
    fillerSignUrl: String(order.fillerSignUrl || ''),
    repairerName: text(order.repairerName),
    repairerSignUrl: String(order.repairerSignUrl || ''),
    inspectorName: text(order.inspectorName || session.signerName),
    inspectorSignUrl: String(order.inspectorSignUrl || ''),
    ownerSignUrl: String(order.ownerSignUrl || ''),
    items: Array.isArray(order.items)
      ? order.items.map((item: Record<string, unknown>) => ({
          part: text(item.part),
          name: text(item.name),
          surveyQty: numberText(item.surveyQty),
          actualQty: numberText(item.actualQty),
          actualHours: numberText(item.actualHours),
          quotaCode: text(item.quotaCode),
          laborFee: money(item.laborFeeCents),
          materialFee: money(item.materialFeeCents),
          quality: text(item.quality),
          note: text(item.note),
        }))
      : [],
    materials: Array.isArray(order.materials)
      ? order.materials.map((item: Record<string, unknown>) => ({
          name: text(item.name),
          spec: text(item.spec),
          unit: text(item.unit),
          pickQty: numberText(item.pickQty),
          usedQty: numberText(item.usedQty),
          returnQty: numberText(item.returnQty),
          amount: money(item.amountCents),
          note: text(item.note),
        }))
      : [],
    scrapNote: text(order.scrapNote),
    serviceRecord: text(order.serviceRecord),
    followUpRecord: text(order.followUpRecord),
  };
}

Page({
  data: {
    token: '',
    orderId: 0,
    external: false,
    loading: true,
    error: '',
    slotLabel: '查验员',
    alreadySigned: false,
    expiresText: '',
    order: null as DisplayOrder | null,
    zoomClass: 'sign-preview--normal',
    zoomText: '100%',
    zoomLevel: 1,
    padOpen: false,
    hasInk: false,
    draftImage: '',
    submitting: false,
  },

  canvasContext: null as WechatMiniprogram.CanvasContext | null,
  drawing: false,
  pinchStartDistance: 0,
  pinchStartScale: 1,

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
      const session = this.data.external
        ? await maintenance.signSession(this.data.token)
        : await maintenance.internalSignSession(this.data.orderId);
      this.setData({
        loading: false,
        error: '',
        slotLabel: session.slotLabel,
        alreadySigned: session.signed,
        expiresText: this.data.external && session.expiresAt
          ? `${dateTimeText(session.expiresAt)} 前有效`
          : '',
        order: toDisplay(session),
      });
    } catch (error: any) {
      this.setData({ loading: false, error: error?.message || '签字凭证已过期，请返回重新打开' });
    }
  },

  zoomOut() {
    const next = Math.max(0, this.data.zoomLevel - 1);
    this.applyZoom(next);
  },

  zoomIn() {
    const next = Math.min(2, this.data.zoomLevel + 1);
    this.applyZoom(next);
  },

  applyZoom(level: number) {
    const classes = ['sign-preview--small', 'sign-preview--normal', 'sign-preview--large'];
    const labels = ['85%', '100%', '120%'];
    this.setData({ zoomLevel: level, zoomClass: classes[level], zoomText: labels[level] });
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
    context.beginPath();
    context.moveTo(point.x, point.y);
  },

  moveStroke(event: any) {
    if (!this.drawing || !this.canvasContext) return;
    const point = event.touches?.[0];
    if (!point) return;
    this.canvasContext.lineTo(point.x, point.y);
    this.canvasContext.stroke();
    this.canvasContext.draw(true);
    if (!this.data.hasInk) this.setData({ hasInk: true });
  },

  endStroke() {
    this.drawing = false;
  },

  clearPad() {
    const context = this.canvasContext;
    if (!context) return;
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
            this.setData({
              draftImage: `data:image/png;base64,${base64}`,
              padOpen: false,
            });
          },
          fail: () => wx.showToast({ icon: 'none', title: '签名读取失败，请重试' }),
        });
      },
      fail: () => wx.showToast({ icon: 'none', title: '签名生成失败，请重试' }),
    }, this);
  },

  onPreviewTouchStart(event: any) {
    if (event.touches?.length !== 2) return;
    const [a, b] = event.touches;
    this.pinchStartDistance = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    this.pinchStartScale = [0.85, 1, 1.2][this.data.zoomLevel] || 1;
  },

  onPreviewTouchMove(event: any) {
    if (event.touches?.length !== 2 || !this.pinchStartDistance) return;
    const [a, b] = event.touches;
    const distance = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    const scale = this.pinchStartScale * distance / this.pinchStartDistance;
    const level = scale < 0.93 ? 0 : scale > 1.1 ? 2 : 1;
    if (level !== this.data.zoomLevel) this.applyZoom(level);
  },

  onPreviewTouchEnd() {
    this.pinchStartDistance = 0;
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
