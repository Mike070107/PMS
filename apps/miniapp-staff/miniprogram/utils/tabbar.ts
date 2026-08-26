/**
 * 自定义 tabBar 的三件事：告诉它「现在在第几屏」、给它「有几件事没处理」、
 * 以及把角色记下来（没权限的 tab 不显示）。
 *
 * 每个 tab 页在 onShow 里调一次 syncTabBar —— 微信不会自动同步选中态，
 * 漏掉的那一屏点进去后底部还高亮着上一个 tab，人就会怀疑自己点错了。
 */
import { type TabKey } from './roles';

export { type TabKey };

/** access.pages 的精简缓存：只留员工端那几个入口的「可见」 */
const PAGES_KEY = 'pms.staff.pages';
const TAB_PAGE_KEYS = [
  'app:pool',
  'app:dispatch',
  'app:my-orders',
  'app:inventory',
  'app:approve-manager',
  'app:approve-purchaser',
  'app:repair-create',
  'app:messages',
];

/**
 * 读缓存里的身份和权限。**只读缓存，绝不打接口** ——
 * tabBar 的 attached 和角标刷新都会走到这里，一旦联网就会触发
 * 401 → reLaunch 打转（见 custom-tab-bar/index.ts 的说明）。
 */
export function readCachedAccess(): { pages: Record<string, boolean> | null } {
  return { pages: wx.getStorageSync(PAGES_KEY) || null };
}

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

/**
 * 页面拿到 auth.me() 后顺手把权限存下来，tabBar 据此决定显示哪几格。
 *
 * tabBar 在 attached 里绝不能联网（会 401 → reLaunch 打转），所以它只读这份缓存。
 * 后台改完角色，用户在任意页下拉刷新（getSession(page, true)）就会走到这里，
 * 底部立刻跟着变 —— 不用退出重登，更不用杀掉小程序。
 */
export function rememberAccess(
  page: any,
  pages: Record<string, { view?: boolean }> | null | undefined,
) {
  const slim: Record<string, boolean> | null = pages
    ? TAB_PAGE_KEYS.reduce((acc, key) => {
        acc[key] = !!pages[key]?.view;
        return acc;
      }, {} as Record<string, boolean>)
    : null;
  const changed =
    JSON.stringify(wx.getStorageSync(PAGES_KEY) || null) !== JSON.stringify(slim);
  if (!changed) return;
  if (slim) wx.setStorageSync(PAGES_KEY, slim);
  else wx.removeStorageSync(PAGES_KEY);
  const tabBar = getTabBar(page);
  if (tabBar && typeof tabBar.applyAccess === 'function') {
    tabBar.applyAccess({ pages: slim });
  }
}

/** 退出登录时清掉：换个人登进来不能还按上一个人的身份渲染底部 */
export function clearAccessCache() {
  wx.removeStorageSync(PAGES_KEY);
  wx.removeStorageSync('pms.staff.poolMode');
}
