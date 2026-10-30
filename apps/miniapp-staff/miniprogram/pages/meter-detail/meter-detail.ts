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
      this.setData({ detail: view, canSubmit: session.canSubmitReading, loading: false });
    } catch (e) {
      this.setData({ loading: false, error: meterErrText(e) });
    }
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
