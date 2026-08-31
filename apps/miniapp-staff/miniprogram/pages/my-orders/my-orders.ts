import { repairs } from '@pms/api-client';
import { withOrderLabels } from '@pms/miniapp-ui';
import { WorkOrderStatus, type WorkOrderListItem } from '@pms/shared-types';
import { getSession } from '../../utils/session';
import { setTabBadge, syncTabBar } from '../../utils/tabbar';
import { refreshUnread, topUpQuietly } from '../../utils/unread';

type OrderRow = WorkOrderListItem & {
  typeLabel: string;
  createdAtText: string;
  stayDays: number;
  stayText: string;
  stayTone: string;
  timeText: string;
  urgent: boolean;
  /** 「PVC 管 DN50 ×2 米」，等待材料的单才有 */
  missingText: string;
  /** 卡片右下角写清下一步该干什么，而不是笼统的「查看详情」 */
  actionText: string;
  reporterText: string;
  /** 「我报的」卡片：这单现在在谁手上 */
  assigneeText?: string;

  /* ---- 卡片数据网格用的四个短值（data-first-ui）：由 withOrderLabels 一并算好 ----
     工单池那页用的是同一份，改口径去 packages/miniapp-ui/src/format.ts，别在页面里再算一遍 */
  /** 「已等」/「用时」—— 第一格的标签，完结了就换说法 */
  statStayLabel: string;
  /** 「8天」/「今天」—— 网格里放大到 44rpx 的那个数 */
  statStay: string;
  /** 「王女士」—— 报修人姓名，不带身份后缀 */
  statReporter: string;
  /** 「业主」「保安代报」—— 身份，压在姓名下面当说明 */
  statReporterHint: string;
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
    /**
     * 页头那个红数字：在手的单里压了 3 天以上的（stayTone 的 danger 档）。
     * 和工单池同一口径，两屏之间的数才对得上
     */
    overdueCount: 0,
    done: [] as OrderRow[],
    doneOpen: false,
    /**
     * 我替住户/巡查报的单（不管派给了谁）。派给别人之后在手和池子里都看不到，
     * 报单的人会以为单子丢了；默认收起，不和手上要干的活抢位置
     */
    reported: [] as OrderRow[],
    reportedOpen: false,
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
        overdueCount: active.filter((item) => item.stayTone === 'danger').length,
        done: rows.filter((item) => ACTIVE_STATUSES.indexOf(item.status) < 0),
        loaded: true,
      });
      setTabBadge(this, 'mine', active.length);
      this.loadReported(new Set(rows.map((item) => item.id)));
    } catch (e: any) {
      wx.showToast({ icon: 'none', title: e?.message || '加载失败' });
    }
  },

  /** 我报的单：能报修的人才拉；已经在手上的那些不重复列 */
  async loadReported(shown: Set<number>) {
    try {
      const session = await getSession();
      if (!session.canReport) return;
      const list = await repairs.list({ scope: 'reported' });
      const reported = withOrderLabels(list)
        .filter((item) => !shown.has(item.id))
        .map((item) => ({
          ...item,
          actionText: '看进度',
          assigneeText: item.assigneeName || '还没人接',
        }));
      this.setData({ reported });
    } catch {
      // 这一块是附加信息，拉不到不影响在手工单
    }
  },

  onToggleReported() {
    this.setData({ reportedOpen: !this.data.reportedOpen });
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
