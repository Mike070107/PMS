import { repairs } from '@pms/api-client';
import { withOrderLabels } from '@pms/miniapp-ui';
import { WorkOrderStatus, compareWorkOrderOldestFirst, type WorkOrderListItem } from '@pms/shared-types';
import { isActiveOrder } from '../../utils/order-status';
import { getSession } from '../../utils/session';
import { setTabBadge, syncTabBar } from '../../utils/tabbar';
import { topUpQuietly } from '../../utils/unread';
import { refreshTabBadges } from '../../utils/badges';
import { guideHandlers } from '../../utils/guide';

/**
 * 这一页只列「手上真正要干的活」。
 *
 * 「我报的」「已完结」2026-08-31 搬去了工单池的三档 Tab：这一屏是干活的地方，
 * 底下压着一摞已经结束的单，人得先翻过它们才看得到今天该干什么。
 * 要找自己报过的单、或者翻旧单，去「工单池 → 我报的 / 已完结」。
 */
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

  /* ---- 卡片数据网格用的四个短值（data-first-ui）：由 withOrderLabels 一并算好 ----
     工单池那页用的是同一份，改口径去 packages/miniapp-ui/src/format.ts，别在页面里再算一遍 */
  /** 「已等」/「用时」—— 第一格的标签，完结了就换说法 */
  statStayLabel: string;
  /** 「8天」/「今天」—— 网格里放大到 44rpx 的那个数 */
  statStay: string;
  /** 「王女士」—— 报修人姓名，不带身份后缀 */
  statReporter: string;
  /** 谁通过哪个入口提交，压在报修联系人下面 */
  statReporterHint: string;
  /** 紧急 / 普通分组的第一张卡，用于在列表里插入组标题 */
  groupStart?: boolean;
  groupLabel?: string;
};

const ACTION_TEXT: Record<string, string> = {
  [WorkOrderStatus.CREATED]: '去接单',
  [WorkOrderStatus.DISPATCHED]: '去接单',
  [WorkOrderStatus.IN_PROGRESS]: '去完工',
  [WorkOrderStatus.WAITING_MATERIAL]: '看缺料',
};

Page({
  ...guideHandlers(),
  data: {
    /** 指导层：说明文字默认收起，点右上角「?」展开，见 utils/guide.ts */
    guide: false,
    active: [] as OrderRow[],
    /**
     * 页头那个红数字：在手的单里压了 3 天以上的（stayTone 的 danger 档）。
     * 和工单池同一口径，两屏之间的数才对得上
     */
    overdueCount: 0,
    urgentCount: 0,
    normalCount: 0,
    waitingMaterialCount: 0,
    loaded: false,
  },

  onShow() {
    this.syncGuide();
    syncTabBar(this, 'mine');
    this.load();
    // 底部几格的角标一起对准：在详情页接了单、完了工回来，工单池 / 在手 / 我的的数才是新的
    refreshTabBadges(this);
  },

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh());
  },

  async load() {
    try {
      const [list, session] = await Promise.all([
        repairs.list({ scope: 'mine' }),
        getSession(this),
      ]);
      const myUserId = session.me?.id;
      const active: OrderRow[] = withOrderLabels(list)
        // 后端 scope=mine 已经按本人过滤；端上再核一次 assigneeId，防止旧接口、缓存或
        // 权限组合异常时把别人的地址和工单带进“在手工单”。取不到本人 id 时宁可不展示。
        .filter((item) => !!myUserId && item.assigneeId === myUserId && isActiveOrder(item.status))
        .map((item) => ({
          ...item,
          // 接单成功后 acceptedAt 已落库，即使极端情况下列表状态缓存仍是 dispatched，
          // 卡片也不能再误导用户去接第二次；有接单时间就只能进入完工流程。
          actionText: item.acceptedAt ? '去完工' : ACTION_TEXT[item.status] || '查看详情',
        }));
      // 在手工单与工单池同一口径（shared-types 一份实现）：紧急在前；其余按报修时间从早到晚，越老越靠前
      active.sort(compareWorkOrderOldestFirst);
      active.forEach((row, index) => {
        const previous = active[index - 1];
        row.groupStart = index === 0 || !!previous?.urgent !== !!row.urgent;
        row.groupLabel = row.urgent ? '紧急工单 · 先处理' : '普通工单';
      });
      this.setData({
        active,
        overdueCount: active.filter((item) => item.stayTone === 'danger').length,
        urgentCount: active.filter((item) => item.urgent).length,
        normalCount: active.filter((item) => !item.urgent).length,
        waitingMaterialCount: active.filter((item) => item.status === WorkOrderStatus.WAITING_MATERIAL).length,
        loaded: true,
      });
      setTabBadge(this, 'mine', active.length);
    } catch (e: any) {
      wx.showToast({ icon: 'none', title: e?.message || '加载失败' });
    }
  },

  /**
   * 点卡片上的报修照片 = 看大图（catchtap 已经拦住冒泡，不会顺带进详情）。
   * urls 用这张卡自己的那几张，别把整屏的图都串进去 —— 左右滑会滑到别人家的照片。
   */
  onPreviewShot(e: WechatMiniprogram.BaseEvent) {
    const urls = (e.currentTarget.dataset.urls || []) as string[];
    const current = e.currentTarget.dataset.url as string;
    if (!urls.length || !current) return;
    wx.previewImage({ current, urls });
  },

  onTapItem(e: WechatMiniprogram.BaseEvent) {
    // 同工单池：勾过「总是保持」的人在这里静默补额度（见 utils/unread.ts）
    topUpQuietly();
    wx.navigateTo({ url: `/pages/order-detail/order-detail?id=${e.currentTarget.dataset.id}` });
  },
});
