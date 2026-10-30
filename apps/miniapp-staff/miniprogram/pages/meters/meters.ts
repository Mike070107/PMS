import { meters } from '@pms/api-client';
import type { MeterRow, MeterSummaryResp, MeterType } from '@pms/api-client';
import { getSession } from '../../utils/session';
import { syncTabBar } from '../../utils/tabbar';
import { formatMeterTime, meterErrText } from '../../utils/meter';

interface MeterCard extends MeterRow {
  unpaidYuan: string;
  lastReadingText: string;
}

interface SummaryView extends MeterSummaryResp {
  charges: MeterSummaryResp['charges'] & { outstandingYuan: string };
}

Page({
  data: {
    keyword: '',
    type: '' as '' | MeterType,
    due: false,
    rows: [] as MeterCard[],
    total: 0,
    page: 1,
    hasMore: false,
    summary: null as SummaryView | null,
    loading: false,
    error: '',
    canView: true,
    canSubmit: false,
    typeOptions: [
      { key: '', label: '全部' },
      { key: 'water', label: '水表' },
      { key: 'electricity', label: '电表' },
      { key: 'gas', label: '燃气' },
      { key: 'heat', label: '热量' },
    ],
  },

  onShow() {
    syncTabBar(this, 'meters');
    void this.load(true);
  },

  onPullDownRefresh() {
    void this.load(true).finally(() => wx.stopPullDownRefresh());
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loading) void this.load(false);
  },

  async load(reset = true) {
    if (this.data.loading) return;
    this.setData({ loading: true, error: '' });
    try {
      const session = await getSession(this, reset);
      if (!session.canSeeMeters) {
        this.setData({ canView: false, loading: false });
        return;
      }
      const type = this.data.type || undefined;
      const page = reset ? 1 : this.data.page + 1;
      const [list, summary] = await Promise.all([
        meters.list({
          keyword: this.data.keyword.trim() || undefined,
          meterType: type,
          due: this.data.due,
          page,
          pageSize: 50,
        }),
        reset ? meters.summary() : Promise.resolve(this.data.summary),
      ]);
      const pageRows: MeterCard[] = list.rows.map((row) => ({
        ...row,
        unpaidYuan: (row.unpaidCents / 100).toFixed(2),
        lastReadingText: row.lastReadingAt ? formatMeterTime(row.lastReadingAt) : '还没抄过',
      }));
      const rows = reset ? pageRows : [...this.data.rows, ...pageRows];
      const summaryView: SummaryView | null = summary
        ? {
            ...summary,
            charges: {
              ...summary.charges,
              outstandingYuan: (summary.charges.outstanding / 100).toFixed(2),
            },
          }
        : null;
      this.setData({
        rows,
        total: list.total,
        page,
        hasMore: rows.length < list.total,
        summary: summaryView,
        canSubmit: session.canSubmitReading,
        loading: false,
      });
    } catch (e) {
      this.setData({ error: meterErrText(e), loading: false });
    }
  },

  onKeyword(event: any) {
    this.setData({ keyword: event.detail.value });
  },

  onSearch() {
    void this.load(true);
  },

  onClearKeyword() {
    this.setData({ keyword: '' });
    void this.load(true);
  },

  onType(event: any) {
    const type = event.currentTarget.dataset.type || '';
    this.setData({ type });
    void this.load(true);
  },

  onToggleDue() {
    this.setData({ due: !this.data.due });
    void this.load(true);
  },

  onScan() {
    wx.scanCode({
      onlyFromCamera: false,
      scanType: ['qrCode', 'barCode'],
      success: async (res) => {
        const code = String(res.result || '').trim();
        if (!code) return;
        try {
          wx.showLoading({ title: '查找仪表' });
          const found = await meters.lookup(code);
          wx.hideLoading();
          if (!found.rows.length) {
            const modal = await wx.showModal({
              title: '没有找到这块表',
              content: `二维码/表号「${code}」不在你的数据范围内。可以按表号搜索，或联系管理员建档。`,
              confirmText: '按表号搜',
            });
            if (modal.confirm) {
              this.setData({ keyword: code });
              void this.load(true);
            }
            return;
          }
          if (found.rows.length === 1) {
            wx.navigateTo({ url: `/pages/meter-read/meter-read?id=${found.rows[0].id}` });
            return;
          }
          wx.showActionSheet({
            itemList: found.rows.map((row) => `${row.meterNo} · ${row.name || row.installAddress || '未命名'}`),
            success: (choice) => {
              const row = found.rows[choice.tapIndex];
              if (row) wx.navigateTo({ url: `/pages/meter-read/meter-read?id=${row.id}` });
            },
          });
        } catch (e) {
          wx.hideLoading();
          wx.showToast({ icon: 'none', title: meterErrText(e) });
        }
      },
      fail: () => undefined,
    });
  },

  onRead(event: any) {
    if (!this.data.canSubmit) {
      wx.showToast({ icon: 'none', title: '只有查看权限，不能提交读数' });
      return;
    }
    const id = event.currentTarget.dataset.id;
    if (id) wx.navigateTo({ url: `/pages/meter-read/meter-read?id=${id}` });
  },

  onDetail(event: any) {
    const id = event.currentTarget.dataset.id;
    if (id) wx.navigateTo({ url: `/pages/meter-detail/meter-detail?id=${id}` });
  },

  onOpenMe() {
    wx.switchTab({ url: '/pages/me/me' });
  },

  onRetry() {
    void this.load(true);
  },
});
