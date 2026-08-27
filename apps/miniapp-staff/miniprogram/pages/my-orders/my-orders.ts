import { repairs } from '@pms/api-client';
import { withOrderLabels } from '@pms/miniapp-ui';
import { WorkOrderStatus, type WorkOrderListItem } from '@pms/shared-types';
import { setTabBadge, syncTabBar } from '../../utils/tabbar';
import { refreshUnread, topUpQuietly } from '../../utils/unread';

type OrderRow = WorkOrderListItem & {
  typeLabel: string;
  createdAtText: string;
  stayText: string;
  stayTone: string;
  /** 卡片右下角写清下一步该干什么，而不是笼统的「查看详情」 */
  actionText: string;
  reporterText: string;
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
    /** 已完结区的搜索：输入中的词 / 已发出去的词 / 结果（null = 没在搜，显示 done） */
    doneKeyword: '',
    doneQ: '',
    doneResults: null as OrderRow[] | null,
    doneSearching: false,
    doneCapped: false,
  },

  onShow() {
    syncTabBar(this, 'mine');
    this.load();
    // 「我的」那一格的未读角标：新工单派下来时，人得在这一屏就看见
    refreshUnread(this);
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

  onDoneKeyword(e: WechatMiniprogram.Input) {
    this.setData({ doneKeyword: e.detail.value });
  },

  /**
   * 搜已完结的单走服务端：手上列表只带最近 100 条，去年修过的单本地是搜不到的。
   * 服务端 q 同时匹配 单号 / 地址（198/47/201 逐段）/ 描述 / 报修人 / 维修工，和后台工单池一个口径。
   */
  async onSearchDone() {
    const q = this.data.doneKeyword.trim();
    if (!q) return this.onClearDoneSearch();
    this.setData({ doneSearching: true, doneOpen: true });
    try {
      const list = await repairs.list({ scope: 'mine', q });
      const rows = withOrderLabels(list)
        .map((item) => ({ ...item, actionText: '查看详情' }))
        .filter((item) => ACTIVE_STATUSES.indexOf(item.status) < 0);
      this.setData({ doneQ: q, doneResults: rows, doneCapped: list.length >= 100 });
    } catch (e: any) {
      wx.showToast({ icon: 'none', title: e?.message || '搜索失败' });
    } finally {
      this.setData({ doneSearching: false });
    }
  },

  onClearDoneSearch() {
    this.setData({ doneKeyword: '', doneQ: '', doneResults: null, doneCapped: false });
  },

  onTapItem(e: WechatMiniprogram.BaseEvent) {
    // 同工单池：勾过「总是保持」的人在这里静默补额度（见 utils/unread.ts）
    topUpQuietly();
    wx.navigateTo({ url: `/pages/order-detail/order-detail?id=${e.currentTarget.dataset.id}` });
  },
});
