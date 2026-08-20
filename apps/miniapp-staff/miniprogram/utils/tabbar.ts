/**
 * 自定义 tabBar 的三件事：告诉它「现在在第几屏」、给它「有几件事没处理」、
 * 以及把角色记下来（没权限的 tab 不显示）。
 *
 * 每个 tab 页在 onShow 里调一次 syncTabBar —— 微信不会自动同步选中态，
 * 漏掉的那一屏点进去后底部还高亮着上一个 tab，人就会怀疑自己点错了。
 */
export type TabKey = 'pool' | 'mine' | 'approvals' | 'me';

const ROLE_KEY = 'pms.staff.role';

function getTabBar(page: any) {
  return typeof page?.getTabBar === 'function' ? page.getTabBar() : null;
}

export function syncTabBar(page: any, key: TabKey) {
  const tabBar = getTabBar(page);
  if (tabBar && typeof tabBar.setActive === 'function') tabBar.setActive(key);
}

/** 角标：0 / 空表示不显示。数据加载完再调，别让角标比列表先变 */
export function setTabBadge(page: any, key: TabKey, count: number) {
  const tabBar = getTabBar(page);
  if (tabBar && typeof tabBar.setBadge === 'function') tabBar.setBadge(key, count);
}

/** 页面拿到 auth.me() 后顺手存一下角色，tabBar 据此决定藏哪个 tab */
export function rememberRole(page: any, role: string) {
  if (!role) return;
  if (wx.getStorageSync(ROLE_KEY) === role) return;
  wx.setStorageSync(ROLE_KEY, role);
  const tabBar = getTabBar(page);
  if (tabBar && typeof tabBar.applyRole === 'function') tabBar.applyRole(role);
}
