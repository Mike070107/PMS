import { repairs } from '@pms/api-client';
import { withOrderLabels } from '@pms/miniapp-ui';
import type { WorkOrderListItem } from '@pms/shared-types';
import { setTabBadge, syncTabBar } from '../../utils/tabbar';

type OrderRow = WorkOrderListItem & {
  typeLabel: string;
  createdAtText: string;
  stayText: string;
  stayTone: string;
  /** 「PVC 管 DN50 ×2 米」，等待材料的单才有 */
  missingText: string;
};

Page({
  data: { list: [] as OrderRow[], loading: false, loaded: false, acceptingId: 0 },

  onShow() {
    syncTabBar(this, 'pool');
    this.load();
  },

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh());
  },

  async load() {
    this.setData({ loading: true });
    try {
      const list = await repairs.list({ scope: 'pool' });
      const rows = withOrderLabels(list);
      // 急的排前面：停留久的先冒出来，别让人自己一张张翻着找
      rows.sort((a, b) => b.stayDays - a.stayDays || b.id - a.id);
      this.setData({ list: rows, loaded: true });
      setTabBadge(this, 'pool', rows.length);
    } catch (e: any) {
      wx.showToast({ icon: 'none', title: e?.message || '加载失败' });
    } finally {
      this.setData({ loading: false });
    }
  },

  async onAccept(e: WechatMiniprogram.BaseEvent) {
    const id = Number(e.currentTarget.dataset.id);
    if (this.data.acceptingId) return;
    this.setData({ acceptingId: id });
    try {
      await repairs.accept(id);
      wx.showToast({ title: '已接单，去「在手工单」' });
      this.load();
    } catch (e2: any) {
      wx.showToast({ icon: 'none', title: e2?.message || '接单失败' });
    } finally {
      this.setData({ acceptingId: 0 });
    }
  },

  onTapItem(e: WechatMiniprogram.BaseEvent) {
    wx.navigateTo({ url: `/pages/order-detail/order-detail?id=${e.currentTarget.dataset.id}` });
  },
});
