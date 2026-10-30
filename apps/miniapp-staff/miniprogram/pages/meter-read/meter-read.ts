import { meters, upload } from '@pms/api-client';
import type { MeterOcrResp, MeterRow, ReadingResult } from '@pms/api-client';
import { getSession } from '../../utils/session';
import { fitRoiToFrame, frameRoi as computeFrameRoi } from '../../utils/crop';
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
    cropOpen: false,
    frame: { x: 0.1, y: 0.41, w: 0.8, h: 0.18 },
    imgScale: 1,
    imgX: 0,
    imgY: 0,
    imgRotate: 0,
    imgTouched: false,
    imgDirty: false,
    cropCanUse: false,
    photoPath: '',
    photoKey: '',
    photoWidth: 0,
    photoHeight: 0,
    photoDisplayWidth: 0,
    photoDisplayHeight: 0,
    photoRotate: 0,
    rotating: false,
    roi: { ...DEFAULT_ROI } as Roi,
    roiX: 0,
    roiY: 0,
    roiW: 0,
    roiH: 0,
    roiScale: 1,
    roiDirty: false,
    roiTouched: false,
    templateRoi: null as Roi | null,
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
      const lastWithRoi = detail.readings.find((item) => item.roi);
      this.setData({
        meter: detail.meter,
        templateRoi: lastWithRoi?.roi ?? null,
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

  async takeSystemPhoto() {
    try {
      const res = await wx.chooseMedia({
        count: 1,
        mediaType: ['image'],
        sourceType: ['camera'],
        sizeType: ['original'],
      });
      const file = res.tempFiles?.[0];
      if (file?.tempFilePath) this.handlePhoto(file.tempFilePath);
    } catch (e: any) {
      const msg = String(e?.errMsg || '');
      if (!/cancel/i.test(msg)) {
        wx.showToast({ icon: 'none', title: '相机打开失败，请检查微信相机权限，或从相册选照片' });
      }
    }
  },

  async chooseFromAlbum() {
    try {
      const res = await wx.chooseMedia({
        count: 1,
        mediaType: ['image'],
        sourceType: ['album'],
        sizeType: ['original'],
      });
      const file = res.tempFiles?.[0];
      if (file?.tempFilePath) this.handlePhoto(file.tempFilePath);
    } catch (e: any) {
      const msg = String(e?.errMsg || '');
      if (!/cancel/i.test(msg)) wx.showToast({ icon: 'none', title: '相册打开失败，请重试' });
    }
  },

  handlePhoto(path: string) {
    wx.getImageInfo({
      src: path,
      success: (info) => {
        const now = new Date();
        const win = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
        const maxWidth = Math.max(220, Number(win.windowWidth || 375));
        // 全屏裁剪页：图片尽量大，但给顶部/底部操作留空间
        const maxHeight = Math.max(260, Math.min(500, Math.round(Number(win.windowHeight || 700) * 0.55)));
        let displayWidth = maxWidth;
        let displayHeight = Math.round((displayWidth * info.height) / Math.max(1, info.width));
        if (displayHeight > maxHeight) {
          displayHeight = maxHeight;
          displayWidth = Math.max(180, Math.round((displayHeight * info.width) / Math.max(1, info.height)));
        }
        const roi = this.data.templateRoi || { ...DEFAULT_ROI };
        this.setData(
          {
            mode: 'preview',
            cropOpen: true,
            photoPath: path,
            photoWidth: info.width,
            photoHeight: info.height,
            photoDisplayWidth: displayWidth,
            photoDisplayHeight: displayHeight,
            imgScale: 1,
            imgX: 0,
            imgY: 0,
            imgRotate: 0,
            imgTouched: false,
            imgDirty: false,
            cropCanUse: false,
            photoRotate: 0,
            rotating: false,
            roi,
            roiDirty: false,
            roiTouched: false,
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
        const maxWidth = Math.max(220, Number(win.windowWidth || 375));
        const maxHeight = Math.max(260, Math.min(500, Math.round(Number(win.windowHeight || 700) * 0.55)));
        const displayWidth = Math.min(maxWidth, Math.round(maxHeight * 0.7));
        this.setData(
          {
            mode: 'preview',
            cropOpen: true,
            photoPath: path,
            photoDisplayWidth: displayWidth,
            photoDisplayHeight: Math.round(displayWidth * 1.4),
            imgScale: 1,
            imgX: 0,
            imgY: 0,
            imgRotate: 0,
            imgTouched: false,
            imgDirty: false,
            cropCanUse: false,
            photoRotate: 0,
            rotating: false,
            roi: this.data.templateRoi || { ...DEFAULT_ROI },
            roiDirty: false,
            roiTouched: false,
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
        roiScale: 1,
      },
      () => {
        setTimeout(() => { (this as any).roiSyncing = false; }, 80);
      },
    );
  },

  /** 固定红框在当前图片变换下对应的原图归一化区域（旋转后取轴对齐外接框） */
  frameRoi(): Roi {
    return computeFrameRoi(
      this.data.frame,
      { scale: this.data.imgScale, x: this.data.imgX, y: this.data.imgY, rotate: this.data.imgRotate },
      this.data.photoDisplayWidth,
      this.data.photoDisplayHeight,
    );
  },

  /** 自动把 OCR 找到的读数区移到固定红框里；用户之后可再缩放/旋转 */
  focusOnRoi(roi: Roi) {
    const next = fitRoiToFrame(
      this.data.frame,
      roi,
      this.data.photoDisplayWidth,
      this.data.photoDisplayHeight,
    );
    if (!next) return;
    this.setData({
      imgScale: next.scale,
      imgX: next.x,
      imgY: next.y,
      imgRotate: next.rotate,
      imgTouched: false,
      imgDirty: false,
    });
  },

  resetView() {
    this.setData({ imgScale: 1, imgX: 0, imgY: 0, imgRotate: 0, imgTouched: true, imgDirty: true });
  },

  /** 表号也是 8 位数字时，绝不能被当成读数；档案表号是唯一可信来源 */
  isMeterNoDigits(digits: string | null | undefined): boolean {
    const known = (this.data.meter?.meterNo || '').replace(/\D/g, '');
    const actual = (digits || '').replace(/\D/g, '');
    return !!known && !!actual && actual === known;
  },

  /** 红框被双指捏合后，实际识别区域要按中心缩放，而不是只改显示大小 */
  effectiveRoi(): Roi {
    const base = this.data.roi;
    const scale = clamp(Number(this.data.roiScale) || 1, 0.5, 3);
    const w = clamp(base.w * scale, 0.03, 1);
    const h = clamp(base.h * scale, 0.02, 1);
    const cx = base.x + base.w / 2;
    const cy = base.y + base.h / 2;
    return {
      x: clamp(cx - w / 2, 0, 1 - w),
      y: clamp(cy - h / 2, 0, 1 - h),
      w,
      h,
    };
  },

  /** 先用整图 OCR 的文字框自动给红框；识别不到就给默认框，让人自己拖 */
  roiFromOcr(result: MeterOcrResp): Roi {
    const boxed = (result.candidates || []).filter(
      (item) =>
        Array.isArray(item.box) &&
        item.box.length >= 4 &&
        !this.isMeterNoDigits(item.digits),
    );
    const expected = this.data.meter
      ? Number(this.data.meter.integerDigits) + Number(this.data.meter.decimalDigits)
      : 0;
    // 同为 8 位时，读数框通常比铭牌上的标准号框高得多；优先选面积最大的那个
    const preferred = boxed
      .filter((item) => !expected || (item.digits || '').length === expected)
      .sort((a, b) => {
        const area = (item: typeof a) => Math.abs((item.box![2] - item.box![0]) * (item.box![3] - item.box![1]));
        return area(b) - area(a);
      })[0] || boxed[0];
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
      const autoRoi = this.roiFromOcr(full);
      const keepUser = this.data.imgTouched;
      const located = (full.candidates || []).some(
        (item) =>
          Array.isArray(item.box) &&
          item.box.length >= 4 &&
          !this.isMeterNoDigits(item.digits),
      );
      if (!keepUser) this.focusOnRoi(autoRoi);
      this.setData({
        cropCanUse: false,
        autoBoxText: keepUser
          ? '已保留你调整的画面，正在识别'
          : located
            ? '已自动把读数移到红框里，可双指缩放/转动微调'
            : '没有自动找到读数区，请拖动/缩放图片把数字放进红框',
      });
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
    const candidates = (result.candidates || []).filter((item) => !this.isMeterNoDigits(item.digits));
    const boxed = candidates.filter((item) => Array.isArray(item.box) && item.box.length >= 4);
    if (!boxed.length) return candidates[0] || null;
    const width = this.data.photoWidth;
    const height = this.data.photoHeight;
    if (!width || !height) return boxed[0] || null;
    const roi = this.frameRoi();
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
        imgDirty: false,
        cropCanUse: !digitWarning && !!valueText,
        error,
      });
    } catch (e) {
      this.setData({ error: meterErrText(e) });
    } finally {
      this.setData({ recognizing: false });
      if (manageLoading) wx.hideLoading();
    }
  },

  onPhotoTouchStart(event: any) {
    const touches = event.touches || [];
    if (!touches.length) return;
    if (touches.length >= 2) {
      const midX = (touches[0].clientX + touches[1].clientX) / 2;
      const midY = (touches[0].clientY + touches[1].clientY) / 2;
      (this as any).gesture = {
        mode: 'pinch',
        startDist: Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY),
        startAngle: Math.atan2(touches[1].clientY - touches[0].clientY, touches[1].clientX - touches[0].clientX) * 180 / Math.PI,
        startMidX: midX,
        startMidY: midY,
        startScale: this.data.imgScale,
        startRotate: this.data.imgRotate,
        startX: this.data.imgX,
        startY: this.data.imgY,
      };
    } else {
      (this as any).gesture = {
        mode: 'pan',
        startTouchX: touches[0].clientX,
        startTouchY: touches[0].clientY,
        startX: this.data.imgX,
        startY: this.data.imgY,
      };
    }
  },

  onPhotoTouchMove(event: any) {
    const g = (this as any).gesture;
    const touches = event.touches || [];
    if (!g || !touches.length) return;
    if (touches.length >= 2 && g.mode === 'pinch') {
      const dist = Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
      const angle = Math.atan2(touches[1].clientY - touches[0].clientY, touches[1].clientX - touches[0].clientX) * 180 / Math.PI;
      const midX = (touches[0].clientX + touches[1].clientX) / 2;
      const midY = (touches[0].clientY + touches[1].clientY) / 2;
      let rotate = Number(g.startRotate) + angle - Number(g.startAngle);
      while (rotate > 180) rotate -= 360;
      while (rotate < -180) rotate += 360;
      this.setData({
        imgScale: clamp(Number(g.startScale) * (dist / Math.max(1, g.startDist)), 0.6, 5),
        imgRotate: Math.round(rotate),
        imgX: Number(g.startX) + (midX - Number(g.startMidX)),
        imgY: Number(g.startY) + (midY - Number(g.startMidY)),
        imgTouched: true,
        imgDirty: true,
        cropCanUse: false,
      });
      return;
    }
    if (touches.length === 1 && g.mode === 'pan') {
      this.setData({
        imgX: Number(g.startX) + (touches[0].clientX - Number(g.startTouchX)),
        imgY: Number(g.startY) + (touches[0].clientY - Number(g.startTouchY)),
        imgTouched: true,
        imgDirty: true,
        cropCanUse: false,
      });
    }
  },

  onPhotoTouchEnd() {
    (this as any).gesture = null;
  },

  onResetView() {
    this.setData({ imgScale: 1, imgX: 0, imgY: 0, imgRotate: 0, imgTouched: true, imgDirty: true, cropCanUse: false });
  },

  onUseCropResult() {
    if (!this.data.cropCanUse) return;
    this.setData({ cropOpen: false });
  },

  onRetakeCrop() {
    this.setData({ cropOpen: false });
    this.onRetake();
  },

  onRoiChange(event: any) {
    if (this.data.rotating) return;
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
      roiTouched: true,
      autoBoxText: '红框已调整，点「识别框内」重新识别',
    });
  },

  onRoiScale(event: any) {
    if (this.data.rotating) return;
    const scale = clamp(Number(event.detail?.scale) || 1, 0.5, 3);
    this.setData({
      roiScale: scale,
      roiDirty: true,
      roiTouched: true,
      autoBoxText: '红框大小已调整，点「识别框内」重新识别',
    });
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
      cropOpen: false,
      imgScale: 1,
      imgX: 0,
      imgY: 0,
      imgRotate: 0,
      imgTouched: false,
      imgDirty: false,
      cropCanUse: false,
      photoPath: '',
      photoKey: '',
      photoDisplayWidth: 0,
      photoDisplayHeight: 0,
      photoRotate: 0,
      rotating: false,
      roi: { ...DEFAULT_ROI },
      roiX: 0,
      roiY: 0,
      roiW: 0,
      roiH: 0,
      roiScale: 1,
      roiDirty: false,
      roiTouched: false,
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

  /** 识别结果允许在裁剪页直接手改；改完不必重拍 */
  onCropValueInput(event: any) {
    const valueText = sanitizeReadingInput(event.detail.value);
    const preview = previewUsage(this.data.meter, valueText);
    this.setData({
      valueText,
      usageText: preview.usageText,
      amountText: preview.amountText,
      digitWarning: '',
      error: '',
      cropCanUse: !!valueText,
    });
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
    if (this.data.imgDirty) {
      wx.showToast({ icon: 'none', title: '画面已调整，请先点“识别”' });
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
        roi: this.frameRoi(),
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
              orientation: this.data.ocr.orientation ?? 0,
              raw: { candidates: this.data.ocr.candidates, digits: this.data.ocr.digits, roi: this.frameRoi() },
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
