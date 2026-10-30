import { meters, upload } from '@pms/api-client';
import type { MeterOcrResp, MeterRow, ReadingResult } from '@pms/api-client';
import { getSession } from '../../utils/session';
import {
  formatMeterTime,
  formatMeterValue,
  meterErrText,
  sanitizeReadingInput,
} from '../../utils/meter';

interface LocationInfo {
  latitude?: number;
  longitude?: number;
  accuracy?: number;
}

interface Roi {
  x: number;
  y: number;
  w: number;
  h: number;
}

const DEFAULT_ROI: Roi = { x: 0.08, y: 0.36, w: 0.84, h: 0.16 };

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function previewUsage(meter: MeterRow | null, text: string) {
  if (!meter || !text) return { usageText: '', amountText: '' };
  const current = Number(text);
  if (!Number.isFinite(current)) return { usageText: '', amountText: '' };
  const previous = meter.lastReadingValue ?? (meter.initialReading === null ? null : Number(meter.initialReading));
  if (previous === null) return { usageText: '首次抄表，提交后从这次读数起算', amountText: '' };
  let diff = current - previous;
  if (diff < -0.0005) return { usageText: `小于上次读数 ${previous}，请核对`, amountText: '' };
  diff = Math.round(diff * 1000) / 1000;
  const usable = Math.round(diff * Number(meter.multiplier || 1) * 1000) / 1000;
  const usageText = `${usable} ${meter.unit}`;
  const amountText =
    meter.billingEnabled && meter.unitPriceCents > 0 && usable > 0
      ? `¥${((usable * meter.unitPriceCents) / 100).toFixed(2)}`
      : '';
  return { usageText, amountText };
}

Page({
  data: {
    id: 0,
    meter: null as MeterRow | null,
    loading: true,
    mode: 'camera' as 'camera' | 'preview' | 'done',
    cameraReady: false,
    cameraError: '',
    flash: 'off' as 'off' | 'on' | 'auto',
    photoPath: '',
    photoKey: '',
    photoWidth: 0,
    photoHeight: 0,
    photoDisplayWidth: 0,
    photoDisplayHeight: 0,
    roi: { ...DEFAULT_ROI } as Roi,
    roiX: 0,
    roiY: 0,
    roiW: 0,
    roiH: 0,
    roiDirty: false,
    autoBoxText: '',
    digitWarning: '',
    readAt: '',
    readAtText: '',
    location: {} as LocationInfo,
    locationText: '正在获取位置…',
    ocr: null as MeterOcrResp | null,
    recognizing: false,
    uploading: false,
    valueText: '',
    usageText: '',
    amountText: '',
    note: '',
    submitting: false,
    error: '',
    result: null as ReadingResult | null,
    resultChargeYuan: '',
    clientRequestId: '',
    canSubmit: false,
    lastReadingText: '',
    showOcrText: false,
  },

  async onLoad(options: any) {
    const id = Number(options?.id || 0);
    if (!id) {
      wx.showToast({ icon: 'none', title: '缺少仪表编号' });
      setTimeout(() => wx.navigateBack(), 800);
      return;
    }
    this.setData({ id, clientRequestId: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}` });
    try {
      const session = await getSession(this);
      if (!session.canSeeMeters) {
        wx.showToast({ icon: 'none', title: '没有抄表权限' });
        setTimeout(() => wx.navigateBack(), 900);
        return;
      }
      const detail = await meters.detail(id);
      this.setData({
        meter: detail.meter,
        canSubmit: session.canSubmitReading,
        loading: false,
        lastReadingText: detail.meter.lastReadingAt
          ? formatMeterTime(detail.meter.lastReadingAt)
          : '还没有抄表记录',
      });
      wx.setNavigationBarTitle({ title: `${detail.meter.meterTypeLabel}抄表` });
    } catch (e) {
      this.setData({ loading: false, error: meterErrText(e) });
    }
    this.initLocation();
  },

  onReady() {
    (this as any).cameraCtx = wx.createCameraContext();
    this.setData({ cameraReady: true });
  },

  onUnload() {
    (this as any).cameraCtx = null;
  },

  initLocation() {
    wx.getLocation({
      type: 'gcj02',
      isHighAccuracy: true,
      highAccuracyExpireTime: 4000,
      success: (res) => {
        this.setData({
          location: { latitude: res.latitude, longitude: res.longitude, accuracy: res.accuracy },
          locationText: `已记录位置（精度约 ${Math.round(res.accuracy || 0)} 米）`,
        });
      },
      fail: () => {
        this.setData({ locationText: '未获取定位，仍可抄表；后台会标记“无现场定位”' });
      },
    });
  },

  onCameraError(event: any) {
    this.setData({
      cameraError: event?.detail?.errMsg || '相机打不开，请检查微信的相机权限',
    });
  },

  toggleFlash() {
    const next = this.data.flash === 'off' ? 'on' : 'off';
    this.setData({ flash: next });
  },

  takePhoto() {
    const ctx = (this as any).cameraCtx;
    if (!ctx) {
      wx.showToast({ icon: 'none', title: '相机还没准备好' });
      return;
    }
    ctx.takePhoto({
      quality: 'high',
      success: (res: any) => this.handlePhoto(res.tempImagePath),
      fail: (error: any) => {
        this.setData({ cameraError: error?.errMsg || '拍照失败，请重试' });
      },
    });
  },

  chooseFromAlbum() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album'],
      sizeType: ['original', 'compressed'],
      success: (res) => {
        const file = res.tempFiles?.[0];
        if (file?.tempFilePath) this.handlePhoto(file.tempFilePath);
      },
    });
  },

  handlePhoto(path: string) {
    wx.getImageInfo({
      src: path,
      success: (info) => {
        const now = new Date();
        const win = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
        const displayWidth = Math.max(240, Number(win.windowWidth || 375) - 24);
        const displayHeight = Math.max(200, Math.round((displayWidth * info.height) / Math.max(1, info.width)));
        const roi = { ...DEFAULT_ROI };
        this.setData(
          {
            mode: 'preview',
            photoPath: path,
            photoWidth: info.width,
            photoHeight: info.height,
            photoDisplayWidth: displayWidth,
            photoDisplayHeight: displayHeight,
            roi,
            roiDirty: false,
            autoBoxText: '正在定位读数区域…',
            digitWarning: '',
            readAt: now.toISOString(),
            readAtText: formatMeterTime(now),
            ocr: null,
            valueText: '',
            usageText: '',
            amountText: '',
            error: '',
          },
          () => this.syncRoiPx(roi),
        );
        void this.uploadAndLocate(path);
      },
      fail: () => {
        const win = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
        const displayWidth = Math.max(240, Number(win.windowWidth || 375) - 24);
        this.setData(
          {
            mode: 'preview',
            photoPath: path,
            photoDisplayWidth: displayWidth,
            photoDisplayHeight: Math.round(displayWidth * 1.4),
            roi: { ...DEFAULT_ROI },
            readAt: new Date().toISOString(),
          },
          () => this.syncRoiPx(this.data.roi),
        );
        void this.uploadAndLocate(path);
      },
    });
  },

  /** 把归一化 ROI 换成 movable-view 需要的像素坐标 */
  syncRoiPx(roi: Roi) {
    const width = this.data.photoDisplayWidth;
    const height = this.data.photoDisplayHeight;
    if (!width || !height) return;
    // setData 改 x/y 也会触发 movable-view 的 change，不能把自动定位当成“人手拖动”
    (this as any).roiSyncing = true;
    this.setData(
      {
        roiX: Math.round(roi.x * width),
        roiY: Math.round(roi.y * height),
        roiW: Math.max(16, Math.round(roi.w * width)),
        roiH: Math.max(16, Math.round(roi.h * height)),
      },
      () => {
        setTimeout(() => { (this as any).roiSyncing = false; }, 80);
      },
    );
  },

  /** 先用整图 OCR 的文字框自动给红框；识别不到就给默认框，让人自己拖 */
  roiFromOcr(result: MeterOcrResp): Roi {
    const boxed = (result.candidates || []).filter((item) => Array.isArray(item.box) && item.box.length >= 4);
    const expected = this.data.meter
      ? Number(this.data.meter.integerDigits) + Number(this.data.meter.decimalDigits)
      : 0;
    const preferred = boxed.find((item) => (item.digits || '').length === expected) || boxed[0];
    const box = preferred?.box;
    const width = this.data.photoWidth;
    const height = this.data.photoHeight;
    if (!box || !width || !height) return { ...DEFAULT_ROI };
    const padX = 0.02;
    const padY = 0.015;
    const x = clamp(box[0] / width - padX, 0, 0.98);
    const y = clamp(box[1] / height - padY, 0, 0.98);
    const w = clamp((box[2] - box[0]) / width + padX * 2, 0.08, 1 - x);
    const h = clamp((box[3] - box[1]) / height + padY * 2, 0.05, 1 - y);
    return { x, y, w, h };
  },

  async uploadAndLocate(path: string) {
    this.setData({ uploading: true, recognizing: true, error: '' });
    wx.showLoading({ title: '上传全景原图…', mask: true });
    try {
      const stored = await upload.uploadTempFile(path);
      this.setData({ photoKey: stored.objectKey, uploading: false });
      wx.showLoading({ title: '定位读数区域…', mask: true });
      const full = await meters.ocr(this.data.id, { imageKey: stored.objectKey });
      const roi = this.roiFromOcr(full);
      const located = !!(full.candidates || []).find((item) => Array.isArray(item.box) && item.box.length >= 4);
      this.setData(
        {
          roi,
          roiDirty: false,
          autoBoxText: located
            ? '已自动框选读数区域，请核对红框；歪了可拖动，或用下面按钮调大小'
            : '没有自动找到读数区，请把红框拖到读数数字上',
        },
        () => this.syncRoiPx(roi),
      );
      wx.hideLoading();
      await this.recognizeRoi();
    } catch (e) {
      this.setData({
        uploading: false,
        recognizing: false,
        autoBoxText: '',
        error: `全景原图上传或定位失败：${meterErrText(e)}。原图还在本机，可以重试或手工输入。`,
      });
      wx.hideLoading();
    }
  },

  /** 在全图 OCR 的候选里，只取落在红框内的数字；这样保留整图上下文，避免裁图后 OCR 变差 */
  pickCandidate(result: MeterOcrResp): MeterOcrResp['candidates'][number] | null {
    const candidates = result.candidates || [];
    const boxed = candidates.filter((item) => Array.isArray(item.box) && item.box.length >= 4);
    if (!boxed.length) return candidates[0] || null;
    const width = this.data.photoWidth;
    const height = this.data.photoHeight;
    if (!width || !height) return boxed[0] || null;
    const roi = this.data.roi;
    const inside = boxed.filter((item) => {
      const box = item.box!;
      const cx = (box[0] + box[2]) / 2 / width;
      const cy = (box[1] + box[3]) / 2 / height;
      return cx >= roi.x && cx <= roi.x + roi.w && cy >= roi.y && cy <= roi.y + roi.h;
    });
    return inside.sort((a, b) => b.score - a.score)[0] || null;
  },

  async recognizeRoi(manageLoading = true) {
    if (!this.data.photoKey) return;
    this.setData({ recognizing: true, error: '', digitWarning: '' });
    if (manageLoading) wx.showLoading({ title: '识别红框内读数…', mask: true });
    try {
      // 注意：仍然对全景原图 OCR，只用红框过滤候选。
      // 裁剪后的小图在液晶屏上会丢上下文（实测会把 0224 1888 识别成反序），不能作为唯一输入。
      const result = await meters.ocr(this.data.id, { imageKey: this.data.photoKey });
      const chosen = this.pickCandidate(result);
      const meter = this.data.meter;
      let valueText = this.data.valueText;
      let digitWarning = '';
      let error = '';
      let ocr: MeterOcrResp = result;
      if (chosen && chosen.value !== null) {
        ocr = {
          ...result,
          ok: true,
          value: chosen.value,
          digits: chosen.digits,
          confidence: Math.round(chosen.score * 100),
        };
        if (meter) {
          const expected = Number(meter.integerDigits) + Number(meter.decimalDigits);
          const actual = (chosen.digits || '').length;
          if (actual && actual !== expected) {
            valueText = '';
            digitWarning = `识别到 ${actual} 位数字，档案是 ${meter.integerDigits} 位整数 + ${meter.decimalDigits} 位小数，位数不一致。请先核对档案位数，或手工输入读数；不要直接按当前位数提交。`;
          } else {
            valueText = formatMeterValue(chosen.value, meter.integerDigits, meter.decimalDigits);
          }
        }
      } else {
        valueText = '';
        ocr = { ...result, ok: false, value: null, digits: null };
        error = '红框内没有找到数字，请把红框对准读数后重试，或手工输入';
      }
      const preview = previewUsage(meter, valueText);
      this.setData({
        ocr,
        valueText,
        usageText: preview.usageText,
        amountText: preview.amountText,
        digitWarning,
        recognizing: false,
        roiDirty: false,
        error,
      });
    } catch (e) {
      this.setData({ error: meterErrText(e) });
    } finally {
      this.setData({ recognizing: false });
      if (manageLoading) wx.hideLoading();
    }
  },

  onRoiChange(event: any) {
    if ((this as any).roiSyncing) return;    const width = this.data.photoDisplayWidth;
    const height = this.data.photoDisplayHeight;
    if (!width || !height) return;
    const x = clamp(Number(event.detail?.x) || 0, 0, Math.max(0, width - this.data.roiW));
    const y = clamp(Number(event.detail?.y) || 0, 0, Math.max(0, height - this.data.roiH));
    this.setData({
      roi: {
        x: x / width,
        y: y / height,
        w: this.data.roi.w,
        h: this.data.roi.h,
      },
      roiDirty: true,
      autoBoxText: '红框已调整，点「识别框内」重新识别',
    });
  },

  resizeRoi(factor: number) {
    const roi = this.data.roi;
    const centerX = roi.x + roi.w / 2;
    const centerY = roi.y + roi.h / 2;
    const w = clamp(roi.w * factor, 0.08, 1);
    const h = clamp(roi.h * factor, 0.05, 1);
    const next = {
      x: clamp(centerX - w / 2, 0, 1 - w),
      y: clamp(centerY - h / 2, 0, 1 - h),
      w,
      h,
    };
    this.setData(
      { roi: next, roiDirty: true, autoBoxText: '红框已调整，点「识别框内」重新识别' },
      () => this.syncRoiPx(next),
    );
  },

  onRoiSmaller() {
    this.resizeRoi(0.85);
  },

  onRoiLarger() {
    this.resizeRoi(1.18);
  },

  onRecognizeRoi() {
    void this.recognizeRoi();
  },

  onRetryRecognize() {
    if (!this.data.photoPath) return;
    if (!this.data.photoKey) {
      void this.uploadAndLocate(this.data.photoPath);
      return;
    }
    void this.recognizeRoi();
  },

  onRetake() {
    this.setData({
      mode: 'camera',
      photoPath: '',
      photoKey: '',
      photoDisplayWidth: 0,
      photoDisplayHeight: 0,
      roi: { ...DEFAULT_ROI },
      roiX: 0,
      roiY: 0,
      roiW: 0,
      roiH: 0,
      roiDirty: false,
      autoBoxText: '',
      digitWarning: '',
      ocr: null,
      valueText: '',
      usageText: '',
      amountText: '',
      error: '',
      readAt: '',
      readAtText: '',
    });
  },

  onValueInput(event: any) {
    const valueText = sanitizeReadingInput(event.detail.value);
    const preview = previewUsage(this.data.meter, valueText);
    this.setData({ valueText, usageText: preview.usageText, amountText: preview.amountText });
    return valueText;
  },

  onNote(event: any) {
    this.setData({ note: event.detail.value });
  },

  toggleOcrText() {
    this.setData({ showOcrText: !this.data.showOcrText });
  },

  onPreviewPhoto() {
    if (this.data.photoPath) {
      wx.previewImage({ urls: [this.data.photoPath] });
    }
  },

  async submit() {
    if (!this.data.canSubmit) {
      wx.showToast({ icon: 'none', title: '只有查看权限，不能提交' });
      return;
    }
    if (!this.data.photoKey) {
      wx.showToast({ icon: 'none', title: '请先拍照，原图必须留档' });
      return;
    }
    if (this.data.roiDirty) {
      wx.showToast({ icon: 'none', title: '红框已调整，请先点“识别框内”' });
      return;
    }
    if (!this.data.valueText.trim()) {
      wx.showToast({ icon: 'none', title: '请填写或核对读数' });
      return;
    }
    const value = Number(this.data.valueText);
    if (!Number.isFinite(value) || value < 0) {
      wx.showToast({ icon: 'none', title: '读数格式不对' });
      return;
    }
    const meter = this.data.meter;
    if (!meter) return;
    const warning =
      this.data.ocr?.meterNoMatched === false
        ? '\n注意：识别到的表号与档案不一致，请再核对一次表身编号。'
        : this.data.digitWarning
          ? `\n注意：${this.data.digitWarning}`
          : '';
    const confirm = await wx.showModal({
      title: '确认提交这次抄表？',
      content: `表号 ${meter.meterNo}\n本次读数 ${this.data.valueText} ${meter.unit}\n${
        this.data.usageText ? `预计用量 ${this.data.usageText}\n` : ''
      }${this.data.amountText ? `预计金额 ${this.data.amountText}\n` : ''}拍照时间 ${this.data.readAtText || formatMeterTime(new Date())}${warning}`,
      confirmText: '读数无误',
      cancelText: '再核对',
    });
    if (!confirm.confirm) return;
    this.setData({ submitting: true, error: '' });
    try {
      const result = await meters.createReading(this.data.id, {
        readingValue: Math.round(value * 1000) / 1000,
        readAt: this.data.readAt || new Date().toISOString(),
        photoKey: this.data.photoKey,
        photoWidth: this.data.photoWidth || undefined,
        photoHeight: this.data.photoHeight || undefined,
        roi: this.data.roi,
        latitude: this.data.location.latitude,
        longitude: this.data.location.longitude,
        accuracy: this.data.location.accuracy,
        note: this.data.note || undefined,
        source: 'photo',
        clientRequestId: this.data.clientRequestId,
        ocr: this.data.ocr
          ? {
              provider: this.data.ocr.provider,
              status: this.data.ocr.ok ? 'success' : 'failed',
              confidence: this.data.ocr.confidence,
              text: this.data.ocr.texts,
              meterNo: this.data.ocr.meterNo || undefined,
              raw: { candidates: this.data.ocr.candidates, digits: this.data.ocr.digits, roi: this.data.roi },
            }
          : { status: 'skipped' as const },
      });
      this.setData({
        submitting: false,
        mode: 'done',
        result,
        resultChargeYuan: result.charge ? (result.charge.receivableCents / 100).toFixed(2) : '',
      });
      wx.vibrateShort({ type: 'light' });
    } catch (e) {
      this.setData({ submitting: false, error: meterErrText(e) });
      wx.showToast({ icon: 'none', title: '提交失败，原图和读数都还在' });
    }
  },

  onContinue() {
    wx.navigateBack({ delta: 1 });
  },

  onOpenDetail() {
    wx.redirectTo({ url: `/pages/meter-detail/meter-detail?id=${this.data.id}` });
  },
});
