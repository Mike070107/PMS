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
        this.setData({
          mode: 'preview',
          photoPath: path,
          photoWidth: info.width,
          photoHeight: info.height,
          readAt: now.toISOString(),
          readAtText: formatMeterTime(now),
          ocr: null,
          valueText: '',
          usageText: '',
          amountText: '',
          error: '',
        });
        void this.uploadAndRecognize(path);
      },
      fail: () => {
        this.setData({ photoPath: path, mode: 'preview', readAt: new Date().toISOString() });
        void this.uploadAndRecognize(path);
      },
    });
  },

  async uploadAndRecognize(path: string) {
    this.setData({ uploading: true, recognizing: true, error: '' });
    wx.showLoading({ title: '上传原图…', mask: true });
    try {
      const stored = await upload.uploadTempFile(path);
      this.setData({ photoKey: stored.objectKey, uploading: false });
      wx.showLoading({ title: '识别读数…', mask: true });
      const result = await meters.ocr(this.data.id, { imageKey: stored.objectKey });
      let valueText = this.data.valueText;
      if (result.ok && result.value !== null && this.data.meter) {
        valueText = formatMeterValue(result.value, this.data.meter.integerDigits, this.data.meter.decimalDigits);
      }
      const preview = previewUsage(this.data.meter, valueText);
      this.setData({
        ocr: result,
        valueText,
        usageText: preview.usageText,
        amountText: preview.amountText,
        recognizing: false,
        error: result.ok ? '' : result.error || '没有自动读出数字，请对照原图手工输入',
      });
    } catch (e) {
      this.setData({
        uploading: false,
        recognizing: false,
        error: `原图上传或识别失败：${meterErrText(e)}。原图还在本机，可以重试或手工输入。`,
      });
    } finally {
      wx.hideLoading();
    }
  },

  onRetryRecognize() {
    if (!this.data.photoPath) return;
    if (!this.data.photoKey) {
      void this.uploadAndRecognize(this.data.photoPath);
      return;
    }
    wx.showLoading({ title: '重新识别…', mask: true });
    this.setData({ recognizing: true, error: '' });
    meters
      .ocr(this.data.id, { imageKey: this.data.photoKey })
      .then((result) => {
        let valueText = this.data.valueText;
        if (result.ok && result.value !== null && this.data.meter) {
          valueText = formatMeterValue(result.value, this.data.meter.integerDigits, this.data.meter.decimalDigits);
        }
        const preview = previewUsage(this.data.meter, valueText);
        this.setData({
          ocr: result,
          valueText,
          usageText: preview.usageText,
          amountText: preview.amountText,
          error: result.ok ? '' : result.error || '没有自动读出数字，请手工输入',
        });
      })
      .catch((e) => this.setData({ error: meterErrText(e) }))
      .finally(() => {
        this.setData({ recognizing: false });
        wx.hideLoading();
      });
  },

  onRetake() {
    this.setData({
      mode: 'camera',
      photoPath: '',
      photoKey: '',
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
              raw: { candidates: this.data.ocr.candidates, digits: this.data.ocr.digits },
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
