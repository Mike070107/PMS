import { meters } from '@pms/api-client';
import type { MeterChargeRow, MeterDetailResp, MeterReadingRow } from '@pms/api-client';
import { getSession } from '../../utils/session';
import { formatMeterTime, meterErrText } from '../../utils/meter';

interface ChargeView extends MeterChargeRow {
  receivableYuan: string;
  paidYuan: string;
}

interface ReadingView extends MeterReadingRow {
  readAtText: string;
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
      const view: DetailView = {
        ...detail,
        readings: detail.readings.map((reading) => ({
          ...reading,
          readAtText: formatMeterTime(reading.readAt),
        })),
        charges: detail.charges.map((charge) => ({
          ...charge,
          receivableYuan: (charge.receivableCents / 100).toFixed(2),
          paidYuan: (charge.paidCents / 100).toFixed(2),
        })),
        stats: { ...detail.stats, unpaidYuan: (detail.stats.unpaidCents / 100).toFixed(2) },
      };
      this.setData({
        detail: view,
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
    if (!reading) return;
    wx.showModal({
      title: `复核 ${reading.readingValueText} ${reading.unit}`,
      editable: true,
      placeholderText: '核对后的读数，可直接确认或改数',
      content: reading.readingValueText,
      confirmText: '复核通过',
      success: async (res: any) => {
        if (!res.confirm) return;
        const text = String(res.content || '').trim();
        const value = text ? Number(text) : undefined;
        if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
          wx.showToast({ icon: 'none', title: '读数格式不对' });
          return;
        }
        try {
          const result = await meters.reviewReading(reading.id, { readingValue: value });
          wx.showToast({
            icon: 'success',
            title: result.charge ? '复核通过，已出账' : '复核通过',
          });
          await this.load();
        } catch (e) {
          wx.showToast({ icon: 'none', title: meterErrText(e) });
        }
      },
    } as any);
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
