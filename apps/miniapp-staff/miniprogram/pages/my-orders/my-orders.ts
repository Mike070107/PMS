import { repairs } from '@pms/api-client';
import { withOrderLabels } from '@pms/miniapp-ui';
import { WorkOrderStatus, type WorkOrderListItem } from '@pms/shared-types';
import { setTabBadge, syncTabBar } from '../../utils/tabbar';

type OrderRow = WorkOrderListItem & {
  typeLabel: string;
  createdAtText: string;
  stayText: string;
  stayTone: string;
  /** 卡片右下角写清下一步该干什么，而不是笼统的「查看详情」 */
  actionText: string;
};

/** 还要人动手的状态，排在最上面；其余归到「已完结」折叠区 */
const ACTIVE_STATUSES: string[] = [
  WorkOrderStatus.CREATED,
  WorkOrderStatus.DISPATCHED,
  WorkOrderStatus.IN_PROGRESS,
  WorkOrderStatus.WAITING_MATERIAL,
];

const ACTION_TEXT: Record<string, string> = {
  [WorkOrderStatus.CREATED]: '去接单',
  [WorkOrderStatus.DISPATCHED]: '去接单',
  [WorkOrderStatus.IN_PROGRESS]: '去完工',
  [WorkOrderStatus.WAITING_MATERIAL]: '看缺料',
};

Page({
  data: {
    active: [] as OrderRow[],
    done: [] as OrderRow[],
    doneOpen: false,
    loaded: false,
  },

  onShow() {
    syncTabBar(this, 'mine');
    this.load();
  },

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh());
  },

  async load() {
    try {
      const list = await repairs.list({ scope: 'mine' });
      const rows = withOrderLabels(list).map((item) => ({
        ...item,
        actionText: ACTION_TEXT[item.status] || '查看详情',
      }));
      const active = rows.filter((item) => ACTIVE_STATUSES.indexOf(item.status) >= 0);
      // 急的排前面，和工单池同一套口径
      active.sort((a, b) => b.stayDays - a.stayDays || b.id - a.id);
      this.setData({
        active,
        done: rows.filter((item) => ACTIVE_STATUSES.indexOf(item.status) < 0),
        loaded: true,
      });
      setTabBadge(this, 'mine', active.length);
    } catch (e: any) {
      wx.showToast({ icon: 'none', title: e?.message || '加载失败' });
    }
  },

  onToggleDone() {
    this.setData({ doneOpen: !this.data.doneOpen });
  },

  onTapItem(e: WechatMiniprogram.BaseEvent) {
    wx.navigateTo({ url: `/pages/order-detail/order-detail?id=${e.currentTarget.dataset.id}` });
  },
});
