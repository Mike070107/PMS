import { meters, upload } from '@pms/api-client';
import type { MeterOcrResp, MeterRow, ReadingResult } from '@pms/api-client';
import { getSession } from '../../utils/session';
import { fitRoiToFrame, meterCropPlan, frameRoi as computeFrameRoi } from '../../utils/crop';
import { pickReadingCandidate } from '../../utils/meter-crop';
import { renderMeterCrop } from '../../utils/meter-crop-canvas';
import {
  formatMeterTime,
  formatMeterValue,
  meterErrText,
  sanitizeReadingInput,
  readingTextError,
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
    manualMode: false,
    photoPath: '',
    photoKey: '',
    recognitionImageKey: '',
    recognitionRoi: null as Roi | null,
    recognitionTransform: null as { scale: number; x: number; y: number; rotate: number } | null,
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
    valueError: '',
    valueFocus: false,
    cropValueFocus: false,
    recognitionStatus: '',
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
    let id = Number(options?.id || 0);
    // 微信扫普通链接二维码会带 q=https%3A...%2Fm%2F1234；小程序码则带 scene=m=xxx。
    const q = options?.q ? decodeURIComponent(String(options.q)) : '';
    const scene = options?.scene ? decodeURIComponent(String(options.scene)) : '';
    const qrMatch = q.match(/\/m\/([A-Za-z0-9]+)/);
    const token = (qrMatch?.[1] || scene.replace(/^m=/i, '')).trim();
    if (!id && !token) {
      wx.showToast({ icon: 'none', title: '缺少仪表编号' });
      setTimeout(() => wx.navigateBack(), 800);
      return;
    }
    this.setData({ clientRequestId: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}` });
    try {
      const session = await getSession(this);
      if (!session.canSeeMeters) {
        wx.showToast({ icon: 'none', title: '没有抄表权限' });
        setTimeout(() => wx.navigateBack(), 900);
        return;
      }
      if (!id && token) {
        const found = await meters.lookup(token);
        if (found.rows.length !== 1) {
          wx.showModal({
            title: '没有找到这块表',
            content: '二维码不在你的数据范围内，或已经失效。请从抄表列表里选择这块表。',
            showCancel: false,
            success: () => wx.navigateBack(),
          });
          return;
        }
        id = found.rows[0].id;
      }
      this.setData({ id });
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
            photoKey: '',
            recognitionImageKey: '',
            recognitionRoi: null,
            recognitionTransform: null,
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
            photoKey: '',
            recognitionImageKey: '',
            recognitionRoi: null,
            recognitionTransform: null,
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
    const token = ((this as any).cropToken || 0) + 1;
    (this as any).cropToken = token;
    this.setData({
      uploading: true,
      recognizing: true,
      manualMode: false,
      error: '',
      autoBoxText: '正在上传全景原图…',
    });
    try {
      const stored = await upload.uploadTempFile(path);
      // 即使用户已点“手动框选”，上传完成的 key 也要留下，手动确认后可再次识别
      if (this.data.photoPath !== path) return;
      this.setData({ photoKey: stored.objectKey, uploading: false });
      if (token !== (this as any).cropToken) return;
      // 全景原图上传只负责留档。用户先把字轮/液晶读数放进红框，再生成识别图。
      this.setData({
        cropCanUse: false,
        recognizing: false,
        imgDirty: true,
        autoBoxText: '全景原图已留档。拖动、缩放、旋转图片，把完整读数放进红框后点识别',
      });
    } catch (e) {
      if (token !== (this as any).cropToken) return;
      this.setData({
        uploading: false,
        recognizing: false,
        autoBoxText: '',
        error: `全景原图上传失败：${meterErrText(e)}。原图还在本机，可以重试或手工输入。`,
      });
    }
  },

  /** 在全图 OCR 的候选里，只取落在红框内的数字；这样保留整图上下文，避免裁图后 OCR 变差 */
  pickCandidate(result: MeterOcrResp): MeterOcrResp['candidates'][number] | null {
    const expected = this.data.meter
      ? Number(this.data.meter.integerDigits) + Number(this.data.meter.decimalDigits)
      : 0;
    return pickReadingCandidate(
      result.candidates || [],
      this.frameRoi(),
      this.data.photoWidth,
      this.data.photoHeight,
      expected,
      this.data.meter?.meterNo || '',
    ) as MeterOcrResp['candidates'][number] | null;
  },

  async recognizeRoi() {
    if (this.data.recognizing) return;
    if (!this.data.photoKey) {
      wx.showToast({ icon: 'none', title: '原图还在上传，请稍候再识别' });
      return;
    }
    const token = ((this as any).cropToken || 0) + 1;
    (this as any).cropToken = token;
    const originalKey = this.data.photoKey;
    const roi = this.frameRoi();
    const transform = { scale: this.data.imgScale, x: this.data.imgX, y: this.data.imgY, rotate: this.data.imgRotate };
    (this as any).gesture = null;
    this.setData({ recognizing: true, ocr: null, error: '', digitWarning: '', recognitionStatus: '正在裁切、扶正红框图片…' });
    let recognitionPath = '';
    try {
      const plan = meterCropPlan(this.data.frame, transform,
        this.data.photoDisplayWidth, this.data.photoDisplayHeight, this.data.photoWidth, this.data.photoHeight);
      recognitionPath = await renderMeterCrop(this, this.data.photoPath, plan, () => token === (this as any).cropToken);
      if (token !== (this as any).cropToken) return;
      this.setData({ recognitionStatus: '正在上传裁切图…' });
      const recognition = await upload.uploadTempFile(recognitionPath);
      if (token !== (this as any).cropToken) return;
      this.setData({ recognitionImageKey: recognition.objectKey, recognitionRoi: roi, recognitionTransform: transform, recognitionStatus: 'AI 正在识别红框读数…' });
      const result = await meters.ocr(this.data.id, {
        imageKey: originalKey,
        recognitionImageKey: recognition.objectKey,
        roi,
      });
      if (token !== (this as any).cropToken) return;
      // 服务端已完成位数、表号、歧义判断，端上不能重新选值或抬高置信度。
      const chosen = result.ok && result.value !== null
        ? result.candidates.find((item) => item.value === result.value && item.digits === result.digits)
        : null;
      const meter = this.data.meter;
      let valueText = this.data.valueText;
      let digitWarning = result.needsReview && result.ok
        ? '识别结果仅供参考，请逐位对照原图核对；不正确可直接修改读数。' : '';
      let error = '';
      let ocr: MeterOcrResp = result;
      if (chosen && chosen.value !== null) {
        ocr = {
          ...result,
          ok: true,
          value: chosen.value,
          digits: chosen.digits,
          confidence: result.confidence,
        };
        if (meter) {
          const expected = Number(meter.integerDigits) + Number(meter.decimalDigits);
          const actual = (chosen.digits || '').length;
          if (actual && actual !== expected) {
            // 位数不一致不把输入框清空：先按档案位数填入识别值并明确警告，
            // 用户能直接看到/修改，不会被“位数不对”卡死。
            valueText = formatMeterValue(chosen.value, meter.integerDigits, meter.decimalDigits);
            digitWarning = `识别到 ${actual} 位数字，档案是 ${meter.integerDigits} 位整数 + ${meter.decimalDigits} 位小数，位数不一致。已按档案位数填入，请对照原图核对后再提交。`;
          } else {
            valueText = formatMeterValue(chosen.value, meter.integerDigits, meter.decimalDigits);
          }
        }
      } else {
        // 识别失败保留已输入的读数。
        ocr = { ...result, ok: false, value: null, digits: null };
        error = result.error || '红框内读数无法确定，请调整画面后重试，或手工输入';
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
        cropCanUse: !readingTextError(valueText),
        autoBoxText: result.ok ? '识别仅供参考，请逐位核对；原图可随时查看' : '请调整红框后重试，或直接手工填写读数',
        error,
      });
    } catch (e) {
      if (token !== (this as any).cropToken) return;
      this.setData({ error: meterErrText(e) });
    } finally {
      if (recognitionPath) wx.getFileSystemManager().unlink({ filePath: recognitionPath, fail: () => undefined });
      if (token === (this as any).cropToken) {
        this.setData({ recognizing: false });
      }
    }
  },

  /**
   * 右上角手动框选：立刻让当前上传/识别结果失效，停止转圈；
   * 图片回到全景，用户自己拖/缩放/旋转，再点识别。
   */
  onManualSelect() {
    (this as any).cropToken = ((this as any).cropToken || 0) + 1;
    wx.hideLoading();
    this.setData({
      uploading: false,
      recognizing: false,
      manualMode: true,
      ocr: null,
      valueText: '',
      usageText: '',
      amountText: '',
      digitWarning: '',
      cropCanUse: false,
      error: '',
      imgScale: 1,
      imgX: 0,
      imgY: 0,
      imgRotate: 0,
      imgTouched: true,
      imgDirty: true,
      autoBoxText: '手动模式：拖动/缩放/旋转图片，把读数放进红框后点识别',
    });
  },

  onPhotoTouchStart(event: any) {
    if (this.data.recognizing) return;
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
    if (this.data.recognizing) return;
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
    if (this.data.recognizing) return;
    this.setData({ imgScale: 1, imgX: 0, imgY: 0, imgRotate: 0, imgTouched: true, imgDirty: true, cropCanUse: false });
  },

  onUseCropResult() {
    const valueError = readingTextError(this.data.valueText);
    if (valueError) { this.setData({ valueError, cropValueFocus: true }); return; }
    if (this.data.recognizing || this.data.uploading) return;
    this.setData({ cropOpen: false, valueError: '', cropValueFocus: false });
  },

  onCancelRecognition() {
    (this as any).cropToken = ((this as any).cropToken || 0) + 1;
    this.setData({ recognizing: false, recognitionStatus: '', autoBoxText: '已停止等待识别，原图和填写内容保留，可调整后重试' });
  },

  onRotateStep(event: any) {
    if (this.data.recognizing) return;
    const step = Number(event.currentTarget?.dataset?.step) || 90;
    const imgRotate = ((this.data.imgRotate + step + 540) % 360) - 180;
    this.setData({ imgRotate, imgTouched: true, imgDirty: true, cropCanUse: false, autoBoxText: '请把全部读数放入红框，小数点也要保留' });
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
    (this as any).cropToken = ((this as any).cropToken || 0) + 1;
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
      recognitionImageKey: '',
      recognitionRoi: null,
      recognitionTransform: null,
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
      valueError: '',
      valueFocus: false,
      cropValueFocus: false,
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
    this.setData({ valueText, valueError: '', valueFocus: false, usageText: preview.usageText, amountText: preview.amountText });
    return valueText;
  },

  /** 识别结果允许在裁剪页直接手改；改完不必重拍 */
  onCropValueInput(event: any) {
    (this as any).cropToken = ((this as any).cropToken || 0) + 1;
    const valueText = sanitizeReadingInput(event.detail.value);
    const preview = previewUsage(this.data.meter, valueText);
    this.setData({
      valueText,
      usageText: preview.usageText,
      amountText: preview.amountText,
      digitWarning: '',
      valueError: '',
      cropValueFocus: false,
      cropCanUse: !readingTextError(valueText),
      recognizing: false,
      imgDirty: false,
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
    const valueError = readingTextError(this.data.valueText);
    if (valueError) {
      this.setData({ valueError, valueFocus: true });
      wx.pageScrollTo({ selector: '#meter-reading-value', duration: 200 });
      return;
    }
    const value = Number(this.data.valueText);
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
              raw: { candidates: this.data.ocr.candidates, digits: this.data.ocr.digits, predictedValue: this.data.ocr.value, roi: this.frameRoi(),
                recognitionImageKey: this.data.recognitionImageKey || undefined,
                imageTransform: this.data.recognitionTransform || undefined,
                recognitionRoi: this.data.recognitionRoi || undefined,
              },
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
