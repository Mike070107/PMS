import { repairs } from '@pms/api-client';
import { withOrderLabels } from '@pms/miniapp-ui';
import { WorkOrderStatus, type WorkOrderListItem } from '@pms/shared-types';

type OrderRow = WorkOrderListItem & {
  typeLabel: string;
  createdAtText: string;
  stayDays: number;
  stayText: string;
  stayTone: string;
  statusText: string;
};

/**
 * 状态分组：业主关心的是「这单还要不要我管」，不是七种状态各是什么。
 * - 处理中：已提交到修完之前，业主等着就行
 * - 待验收：**要业主动手**，所以单独一组，还要在标签上标出条数
 * - 已结束：完成和撤单都归这儿，翻旧单时才会点进来
 */
const TABS: Array<{ key: string; label: string; statuses: WorkOrderStatus[] }> = [
  { key: 'all', label: '全部', statuses: [] },
  {
    key: 'active',
    label: '处理中',
    statuses: [
      WorkOrderStatus.CREATED,
      WorkOrderStatus.DISPATCHED,
      WorkOrderStatus.IN_PROGRESS,
      WorkOrderStatus.WAITING_MATERIAL,
    ],
  },
  { key: 'review', label: '待验收', statuses: [WorkOrderStatus.DONE_PENDING_REVIEW] },
  {
    key: 'done',
    label: '已结束',
    statuses: [WorkOrderStatus.COMPLETED, WorkOrderStatus.CANCELLED],
  },
];

Page({
  data: {
    tabs: TABS.map((item) => ({ key: item.key, label: item.label, count: 0 })),
    tabKey: 'all',
    list: [] as OrderRow[],
    loading: false,
    loaded: false,
    loggedIn: false,
  },

  /** 全量放实例上，切分组只在本地过滤，不重新请求 */
  all: [] as OrderRow[],

  onShow() {
    this.load();
  },

  async load() {
    // 未登录就别发请求：401 会被请求层踢回首页，用户只会看到页面莫名跳走
    if (!wx.getStorageSync('pms.access_token')) {
      this.all = [];
      this.setData({ loggedIn: false, list: [], loaded: true });
      return;
    }
    this.setData({ loggedIn: true, loading: true });
    try {
      const list = await repairs.list({ scope: 'mine' });
      this.all = withOrderLabels(list) as OrderRow[];
      this.applyTab();
      this.setData({ loaded: true });
    } catch (e: any) {
      wx.showToast({ icon: 'none', title: e?.message || '加载失败' });
    } finally {
      this.setData({ loading: false });
    }
  },

  onPickTab(e: WechatMiniprogram.BaseEvent) {
    const key = String(e.currentTarget.dataset.key || 'all');
    if (key === this.data.tabKey) return;
    this.setData({ tabKey: key });
    this.applyTab();
  },

  applyTab() {
    const tab = TABS.find((item) => item.key === this.data.tabKey) ?? TABS[0];
    const list = tab.statuses.length
      ? this.all.filter((item) => tab.statuses.indexOf(item.status) >= 0)
      : this.all;
    this.setData({
      list,
      // 每个分组的条数直接标在标签上，业主不用点进去数
      tabs: TABS.map((item) => ({
        key: item.key,
        label: item.label,
        count: item.statuses.length
          ? this.all.filter((row) => item.statuses.indexOf(row.status) >= 0).length
          : this.all.length,
      })),
    });
  },

  onTapItem(e: WechatMiniprogram.BaseEvent) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: `/pages/order-detail/order-detail?id=${id}` });
  },

  onTapCreate() {
    wx.switchTab({ url: '/pages/index/index' });
  },

  onTapLogin() {
    wx.switchTab({ url: '/pages/index/index' });
  },

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh());
  },
});
