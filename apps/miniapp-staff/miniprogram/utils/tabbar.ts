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
  'app:my-repairs',
  'app:inventory',
  'app:stocktakes',
  'app:materials',
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

/**
 * 「工单池」和「派单台」在 tabBar 上是两格，却共用 /pages/pool/pool 这一个页面。
 * switchTab 不接受参数，所以「进来该看哪一屏」只能走缓存。
 *
 * key 原来在 tabBar 组件、pool 页、下面的 clearAccessCache 里各硬编码一份，
 * 三处任改其一就会对不上（表现为切了模式没生效、或退出登录没清干净）。统一收在这里。
 */
const POOL_MODE_KEY = 'pms.staff.poolMode';

export type PoolMode = 'pool' | 'dispatch';

/** 缓存里记的是哪一屏。没记过按派单台 —— 只有一格权限时页面会自己纠正 */
export function cachedPoolMode(): PoolMode {
  try {
    return wx.getStorageSync(POOL_MODE_KEY) === 'pool' ? 'pool' : 'dispatch';
  } catch {
    return 'dispatch';
  }
}

export function rememberPoolMode(mode: PoolMode) {
  try {
    wx.setStorageSync(POOL_MODE_KEY, mode);
  } catch {
    /* 存不下不影响跳转，页面会按权限自己判默认模式 */
  }
}

function getTabBar(page: any) {
  return typeof page?.getTabBar === 'function' ? page.getTabBar() : null;
}

export function syncTabBar(page: any, key: TabKey) {
  const tabBar = getTabBar(page);
  if (tabBar && typeof tabBar.setActive === 'function') tabBar.setActive(key);
}

/**
 * 底部弹层开着时把胶囊 tabBar 藏起来 —— **tab 页里每个弹层的开和关都必须调这个**。
 *
 * 为什么不能只靠 z-index：员工端的 tabBar 是自定义组件，微信把它渲染在页面之上的
 * 另一层，不参与页面内的 z-index 比较。2026-08-31 实测，把弹层排到 200（胶囊 100）
 * 之后真机上「确认派单」那排按钮照样被压住 —— 那次以为改完了，其实没有。
 *
 * 关的时候要传「这一页是不是还有别的弹层开着」，别一关就把胶囊放出来盖住下面那层
 * （材料页是两层弹层叠着的）。
 */
export function setTabBarHidden(page: any, hidden: boolean) {
  const tabBar = getTabBar(page);
  if (tabBar && typeof tabBar.setHidden === 'function') tabBar.setHidden(!!hidden);
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
  wx.removeStorageSync(POOL_MODE_KEY);
}
