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
 * 不做定时轮询：角标只在 tab 页 onShow、小程序切回前台、下拉刷新
 * 以及接单/完工等明确业务动作后更新，避免无人操作时持续请求服务器。
 */
import { approvals, maintenance, repairs } from '@pms/api-client';
import { canSeeTab } from './roles';
import { readCachedAccess, setTabBadge } from './tabbar';
import { hasToken, refreshUnread } from './unread';

/** 卡片和底栏共享待签字口径；缓存按登录令牌和养护权限隔离，不写入持久存储。 */
let maintenanceSnapshot: { scope: string; count: number } | null = null;
const maintenanceRequests = new Map<string, Promise<number>>();

function maintenanceScope() {
  const { pages } = readCachedAccess();
  let token = '';
  try { token = getApp<{ getToken(): string | undefined }>()?.getToken() || ''; } catch { /* 未登录 */ }
  const sign = pages ? !!pages['app:maintenance-sign'] : true;
  const inspect = pages ? !!pages['app:maintenance-inspect'] : true;
  return { key: JSON.stringify([token, sign, inspect]), allowed: !!token && (sign || inspect) };
}

function renderMaintenanceBadge(page: any, count: number) {
  setTabBadge(page, 'maintenance', count);
  if ('maintenanceBadge' in (page.data || {})) {
    page.setData({ maintenanceCount: count, maintenanceBadge: count > 99 ? '99+' : count > 0 ? String(count) : '' });
  }
}

/** 页面切回/换账号时先同步缓存，不联网；新账号和撤权绝不显示旧人的数。 */
export function syncMaintenanceBadge(page: any): void {
  const scope = maintenanceScope();
  renderMaintenanceBadge(page, scope.allowed && maintenanceSnapshot?.scope === scope.key ? maintenanceSnapshot.count : 0);
}

async function refreshMaintenanceBadge(page: any): Promise<void> {
  const scope = maintenanceScope();
  syncMaintenanceBadge(page);
  if (!scope.allowed) return;
  try {
    // 前台切回和页面onShow可能同时刷新；同一账号/权限只发一次现有请求。
    let request = maintenanceRequests.get(scope.key);
    if (!request) {
      request = maintenance.signTasks().then((list) => list.length)
        .finally(() => maintenanceRequests.delete(scope.key));
      maintenanceRequests.set(scope.key, request);
    }
    const count = await request;
    const current = maintenanceScope();
    if (!current.allowed || current.key !== scope.key) return;
    maintenanceSnapshot = { scope: scope.key, count };
    renderMaintenanceBadge(page, count);
  } catch {
    // 同一账号的瞬时失败保留上次成功数；没有可用快照时保持空白。
  }
}

/**
 * 刷新 page 所在 tabBar 上的全部角标。返回未读消息数（「我的」页要显示这个数）。
 * page 必须是 tab 页实例；内页传进来拿不到 tabBar，会原样返回 0。
 */
export async function refreshTabBadges(page: any): Promise<number> {
  if (!page) return 0;
  void refreshMaintenanceBadge(page);
  if (!hasToken()) return 0;
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

  if (canSeeTab('approvals', { pages })) {
    approvals.list({ pageSize: 1 })
      .then(result => setTabBadge(page, 'approvals', result.tabs.pending))
      // A failed request must retain the previous badge, never turn unknown counts into zero.
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

/** 切回前台时立刻对一次：人在后台的这段时间可能派了新单、别人接走了单 */
export function refreshBadgesOnForeground() {
  const page = currentTabPage();
  if (page) refreshTabBadges(page);
}
