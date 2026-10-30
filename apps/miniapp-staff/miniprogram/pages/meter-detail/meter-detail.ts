import { meters, METER_READING_STATUS_LABELS } from '@pms/api-client';
import type { MeterChargeRow, MeterDetailResp, MeterReadingRow } from '@pms/api-client';
import { getSession } from '../../utils/session';
import { formatMeterTime, meterErrText, readingTextError } from '../../utils/meter';

interface ChargeView extends MeterChargeRow {
  receivableYuan: string;
  paidYuan: string;
  outstandingYuan: string;
  hasPendingPayment: boolean;
}

interface ReadingView extends MeterReadingRow {
  readAtText: string;
  statusLabel: string;
}

interface DetailView extends Omit<MeterDetailResp, 'charges' | 'stats' | 'readings'> {
  readings: ReadingView[];
  charges: ChargeView[];
  stats: MeterDetailResp['stats'] & { unpaidYuan: string };
}

Page({
  data: {
    id: 0,
    detail: null as DetailView | null,
    loading: true,
    error: '',
    canSubmit: false,
    reviewTarget: null as ReadingView | null,
    reviewValue: '', reviewNote: '', reviewValueError: '', reviewError: '', reviewBusy: false, reviewFocus: false,
    canPay: false,
    payScope: '',
    payTarget: null as ChargeView | null,
    payAmount: '', payMethod: '', payReceipt: '', payNote: '',
    payAmountError: '', payMethodError: '', payError: '', payAmountFocus: false,
    payBusy: false, payPending: false,
    paymentMethods: [
      { value: 'wechat', label: '微信' }, { value: 'alipay', label: '支付宝' }, { value: 'cash', label: '现金' },
    ],
    otherPaymentMethods: [ { value: 'bank', label: '银行转账' }, { value: 'other', label: '其他' } ],
    canEditArchive: false,
    tab: 'archive' as 'archive' | 'readings' | 'charges',
    form: {
      name: '',
      ownerName: '',
      ownerPhone: '',
      installAddress: '',
      remark: '',
      latitude: null as number | null,
      longitude: null as number | null,
      locationName: '',
    },
    saving: false,
  },

  onLoad(options: any) {
    const id = Number(options?.id || 0);
    this.setData({ id });
  },

  onShow() {
    void this.load();
  },

  async load() {
    if (!this.data.id) return;
    this.setData({ loading: true, error: '' });
    try {
      const [detail, session] = await Promise.all([meters.detail(this.data.id), getSession(this)]);
      const payScope = `meter-pay:${session.me?.tenantId}:${session.me?.id}`;
      const view: DetailView = {
        ...detail,
        readings: detail.readings.map((reading) => ({
          ...reading,
          readAtText: formatMeterTime(reading.readAt),
          statusLabel: METER_READING_STATUS_LABELS[reading.status],
        })),
        charges: detail.charges.map((charge) => ({
          ...charge,
          receivableYuan: (charge.receivableCents / 100).toFixed(2),
          paidYuan: (charge.paidCents / 100).toFixed(2),
          outstandingYuan: (charge.outstandingCents / 100).toFixed(2),
          hasPendingPayment: !!wx.getStorageSync(`${payScope}:${charge.id}`),
        })),
        stats: { ...detail.stats, unpaidYuan: (detail.stats.unpaidCents / 100).toFixed(2) },
      };
      this.setData({
        detail: view,
        canPay: session.canCharge,
        payScope,
        canSubmit: session.canSubmitReading,
        canEditArchive: session.canSubmitReading,
        loading: false,
        form: {
          name: view.meter.name || '',
          ownerName: view.meter.ownerName || '',
          ownerPhone: view.meter.ownerPhone || '',
          installAddress: view.meter.installAddress || '',
          remark: view.meter.remark || '',
          latitude: view.meter.latitude,
          longitude: view.meter.longitude,
          locationName: view.meter.installAddress || view.meter.communityName || '',
        },
      });
    } catch (e) {
      this.setData({ loading: false, error: meterErrText(e) });
    }
  },

  onOpenPay(event: any) {
    if (!this.data.canPay || this.data.payBusy) return;
    const row = this.data.detail?.charges.find((item) => item.id === Number(event.currentTarget.dataset.id));
    if (!row) return;
    const pending = wx.getStorageSync(`${this.data.payScope}:${row.id}`);
    if (!pending && (row.status === 'paid' || row.status === 'void' || row.outstandingCents <= 0)) return;
    this.setData({ payTarget: row, payAmount: pending ? (pending.amountCents / 100).toFixed(2) : row.outstandingYuan,
      payMethod: pending?.method || '', payReceipt: pending?.receiptNo || '', payNote: pending?.note || '',
      payAmountError: '', payMethodError: '', payError: '', payPending: !!pending, payAmountFocus: false }, () => {
      wx.pageScrollTo({ selector: '#meter-pay-form', duration: 200 });
    });
  },

  onPayField(event: any) {
    if (this.data.payBusy || this.data.payPending) return;
    const field = event.currentTarget.dataset.field;
    if (!['payAmount', 'payReceipt', 'payNote'].includes(field)) return;
    this.setData({ [field]: event.detail.value, ...(field === 'payAmount' ? { payAmountError: '', payAmountFocus: false } : {}) });
  },

  onPayMethod(event: any) {
    if (this.data.payBusy || this.data.payPending) return;
    this.setData({ payMethod: event.currentTarget.dataset.value, payMethodError: '' });
  },

  onClosePay() { if (!this.data.payBusy) this.setData({ payTarget: null }); },

  async onSubmitPay() {
    const target = this.data.payTarget;
    if (!target || !this.data.canPay || this.data.payBusy) return;
    const key = `${this.data.payScope}:${target.id}`;
    const pending = wx.getStorageSync(key);
    const text = this.data.payAmount.trim();
    const amountCents = Math.round(Number(text) * 100);
    const amountError = pending ? '' : !/^\d+(?:\.\d{1,2})?$/.test(text) || !Number.isSafeInteger(amountCents) || amountCents < 1
      ? '请填写大于0的金额，最多两位小数' : amountCents > Math.min(target.outstandingCents, 100000000)
      ? `本次最多可收 ¥${(Math.min(target.outstandingCents, 100000000) / 100).toFixed(2)}` : '';
    const methodError = !pending && !['wechat','alipay','cash','bank','other'].includes(this.data.payMethod) ? '请选择收款方式' : '';
    this.setData({ payAmountError: amountError, payMethodError: methodError, payAmountFocus: !!amountError });
    if (amountError || methodError) {
      wx.pageScrollTo({ selector: amountError ? '#meter-pay-amount' : '#meter-pay-methods', duration: 200 });
      return;
    }
    const payload = pending || { clientRequestId: `pay-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`,
      amountCents, method: this.data.payMethod, receiptNo: this.data.payReceipt.trim(), note: this.data.payNote.trim() };
    this.setData({ payBusy: true, payError: '' });
    try {
      // 先持久化请求编号；断网、退出再进入仍按同一笔重试。
      wx.setStorageSync(key, payload);
      this.setData({ payPending: true });
      await meters.payCharge(target.id, payload);
      wx.removeStorageSync(key);
      this.setData({ payTarget: null, payPending: false });
      wx.showToast({ icon: 'success', title: '收款已登记' });
      await this.load();
    } catch (e: any) {
      if ([400, 422].includes(e?.httpStatus)) {
        wx.removeStorageSync(key); this.setData({ payPending: false });
      }
      this.setData({ payError: meterErrText(e) });
    } finally { this.setData({ payBusy: false }); }
  },

  onTab(event: any) {
    const tab = event.currentTarget.dataset.tab;
    if (tab) this.setData({ tab });
  },

  onField(event: any) {
    const field = event.currentTarget.dataset.field;
    if (!field) return;
    this.setData({ [`form.${field}`]: event.detail.value });
  },

  onChooseLocation() {
    wx.chooseLocation({
      latitude: this.data.form.latitude || undefined,
      longitude: this.data.form.longitude || undefined,
      success: (res) => {
        this.setData({
          'form.latitude': res.latitude,
          'form.longitude': res.longitude,
          'form.installAddress': res.address || res.name || this.data.form.installAddress,
          'form.locationName': res.name || res.address || '',
        });
      },
      fail: (e) => {
        if (!/cancel/i.test(String(e?.errMsg || ''))) {
          wx.showToast({ icon: 'none', title: '地图选点失败，请检查定位权限' });
        }
      },
    });
  },

  async saveMeter() {
    if (!this.data.canEditArchive || this.data.saving) return;
    const form = this.data.form;
    if (!form.name.trim()) {
      wx.showToast({ icon: 'none', title: '请填写仪表名称' });
      return;
    }
    this.setData({ saving: true });
    try {
      await meters.update(this.data.id, {
        name: form.name.trim(),
        ownerName: form.ownerName.trim(),
        ownerPhone: form.ownerPhone.trim(),
        installAddress: form.installAddress.trim(),
        remark: form.remark.trim(),
        latitude: form.latitude === null ? undefined : form.latitude,
        longitude: form.longitude === null ? undefined : form.longitude,
      });
      wx.showToast({ icon: 'success', title: '档案已保存' });
      await this.load();
    } catch (e) {
      wx.showToast({ icon: 'none', title: meterErrText(e) });
    } finally {
      this.setData({ saving: false });
    }
  },

  onReview(event: any) {
    const reading = this.data.detail?.readings.find((row) => row.id === Number(event.currentTarget.dataset.id));
    if (!reading || this.data.reviewBusy) return;
    this.setData({ reviewTarget: reading, reviewValue: reading.readingValueText, reviewNote: reading.reviewNote || '',
      reviewValueError: '', reviewError: '', reviewFocus: false }, () => wx.pageScrollTo({ selector: '#meter-review-form', duration: 200 }));
  },
  onReviewValue(event: any) { if (!this.data.reviewBusy) this.setData({ reviewValue: event.detail.value, reviewValueError: '', reviewFocus: false }); },
  onReviewNote(event: any) { if (!this.data.reviewBusy) this.setData({ reviewNote: event.detail.value }); },
  onCloseReview() { if (!this.data.reviewBusy) this.setData({ reviewTarget: null }); },

  async onSubmitReview() {
    const target = this.data.reviewTarget;
    if (!target || target.status !== 'pending' || !this.data.canSubmit || this.data.reviewBusy) return;
    const error = readingTextError(this.data.reviewValue);
    if (error) { this.setData({ reviewValueError: error, reviewFocus: true }); return; }
    this.setData({ reviewBusy: true, reviewError: '' });
    const apply = (row: MeterReadingRow) => this.setData({ reviewTarget: { ...row, readAtText: formatMeterTime(row.readAt),
      statusLabel: METER_READING_STATUS_LABELS[row.status] }, reviewValue: row.readingValueText });
    try {
      const result = await meters.reviewReading(target.id, { readingValue: Number(this.data.reviewValue), reviewNote: this.data.reviewNote.trim() || undefined });
      apply(result.reading);
      wx.showToast({ icon: 'success', title: result.charge ? '已复核，已出账' : '已复核' });
      await this.load();
    } catch (error) {
      try {
        const latest = await meters.reading(target.id);
        if (latest.reading.status === 'confirmed') { apply(latest.reading); await this.load(); return; }
      } catch { /* 仍保留原输入 */ }
      this.setData({ reviewError: meterErrText(error) });
    } finally { this.setData({ reviewBusy: false }); }
  },

  onReadingLocation(event: any) {
    const id = Number(event.currentTarget.dataset.id);
    const reading = this.data.reviewTarget?.id === id ? this.data.reviewTarget : this.data.detail?.readings.find((row) => row.id === id);
    if (!reading || reading.latitude === null || reading.longitude === null) return;
    wx.openLocation({ latitude: reading.latitude, longitude: reading.longitude, name: '本次抄表现场定位',
      address: `${reading.meterNo} · ${formatMeterTime(reading.readAt)}`, scale: 18,
      fail: () => wx.showToast({ icon: 'none', title: '地图打开失败，请重试' }) });
  },

  onRead() {
    wx.navigateTo({ url: `/pages/meter-read/meter-read?id=${this.data.id}` });
  },

  onNavigate() {
    const meter = this.data.detail?.meter;
    if (!meter || meter.latitude === null || meter.longitude === null) {
      wx.showToast({ icon: 'none', title: '这块表没有经纬度' });
      return;
    }
    wx.openLocation({
      latitude: meter.latitude,
      longitude: meter.longitude,
      name: meter.name || meter.meterNo,
      address: meter.installAddress || meter.communityName,
      scale: 18,
    });
  },

  onCall() {
    const phone = this.data.detail?.meter.ownerPhone;
    if (!phone) {
      wx.showToast({ icon: 'none', title: '没有登记使用人电话' });
      return;
    }
    wx.makePhoneCall({ phoneNumber: phone });
  },

  onPreviewPhoto(event: any) {
    const url = event.currentTarget.dataset.url;
    if (url) wx.previewImage({ urls: [url] });
  },

  onRetry() {
    void this.load();
  },
});
