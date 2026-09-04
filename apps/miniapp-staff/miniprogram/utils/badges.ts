/**
 * 底部 tab 角标的**统一刷新入口**。
 *
 * 原来每格角标只在它自己的页面加载时设：在别的页接了单、完了工，回来那格还是旧数
 * （2026-09-04 反馈「我已经接单了，角标没变」）。现在任何 tab 页 onShow、切回前台、
 * 接单 / 完工之后都调这一个，一次把工单池 / 派单台 / 在手工单 / 养护单 / 审批 / 我的
 * 几格一起对准。
 *
 * 规矩：
 *   · 只读缓存里的权限决定拉哪几样 —— 没权限的接口会 403，白打一次还留错误日志；
 *   · 拉不到就保持原样：宁可漏一个角标，也不要挂一个错的；
 *   · 各页面加载完仍会按自己列表的条数设一次，两边口径一致（见 API badgeCounts 的注释）。
 *
 * 另外挂一个 60 秒的定时器：人停在某一页不动，办公室这时派了单过来，角标也该跟上。
 * 定时器只在页面栈顶是 tab 页时才真的去拉（内页没有 tabBar，拉了也没处显示）。
 */
import { maintenance, purchases, repairs } from '@pms/api-client';
import { PurchaseRequestStatus } from '@pms/shared-types';
import { readCachedAccess, setTabBadge } from './tabbar';
import { hasToken, refreshUnread } from './unread';

const POLL_MS = 60 * 1000;
let pollTimer: number | null = null;

/**
 * 刷新 page 所在 tabBar 上的全部角标。返回未读消息数（「我的」页要显示这个数）。
 * page 必须是 tab 页实例；内页传进来拿不到 tabBar，会原样返回 0。
 */
export async function refreshTabBadges(page: any): Promise<number> {
  ensurePolling();
  if (!page || !hasToken()) return 0;
  const { pages } = readCachedAccess();
  const can = (key: string) => (pages ? !!pages[key] : true);

  const unreadTask = refreshUnread(page);

  if (can('app:pool') || can('app:dispatch') || can('app:my-orders')) {
    repairs
      .badgeCounts()
      .then(({ pool, dispatch, mine }) => {
        if (can('app:pool')) setTabBadge(page, 'pool', pool);
        if (can('app:dispatch')) setTabBadge(page, 'dispatch', dispatch);
        if (can('app:my-orders')) setTabBadge(page, 'mine', mine);
      })
      .catch(() => undefined);
  }

  if (can('app:maintenance-sign') || can('app:maintenance-inspect')) {
    maintenance
      .signTasks()
      .then((list) => setTabBadge(page, 'maintenance', list.length))
      .catch(() => undefined);
  }

  // 审批页先看经理那一步（采购申请必须先过经理），角标口径跟着它
  if (can('app:approve-manager') || can('app:approve-purchaser')) {
    const status = can('app:approve-manager')
      ? PurchaseRequestStatus.MANAGER_REVIEW
      : PurchaseRequestStatus.PURCHASER_REVIEW;
    purchases
      .listRequests({ status })
      .then((list) => setTabBadge(page, 'approvals', list.length))
      .catch(() => undefined);
  }

  return unreadTask;
}

/** 页面栈顶是 tab 页才有 tabBar 可更新 */
function currentTabPage(): any {
  const pages = getCurrentPages();
  const page = pages[pages.length - 1] as any;
  return page && typeof page.getTabBar === 'function' && page.getTabBar() ? page : null;
}

function ensurePolling() {
  if (pollTimer !== null) return;
  pollTimer = setInterval(() => {
    const page = currentTabPage();
    if (page) refreshTabBadges(page);
  }, POLL_MS) as unknown as number;
}

/** 切回前台时立刻对一次：人在后台的这段时间可能派了新单、别人接走了单 */
export function refreshBadgesOnForeground() {
  const page = currentTabPage();
  if (page) refreshTabBadges(page);
}
