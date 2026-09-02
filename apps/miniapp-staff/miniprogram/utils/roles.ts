/**
 * 员工端底部有哪几格，**只看后台给这个角色勾了什么**。
 *
 * 这个文件不 import 任何东西：tabBar 在 attached 里只读本地缓存、绝不能碰网络，
 * 所以它不该被顺带拉到 api-client 那条依赖链上。
 *
 * 这里没有「维修工 / 办公室」这种身份判断了 —— 接单和派单是两格，
 * 审批的两步也是两格，谁有哪一格由「业务角色」页勾选决定。
 */

/** 底部 tab 的 key，与 custom-tab-bar 的 ALL_TABS 一一对应 */
export type TabKey = 'pool' | 'dispatch' | 'mine' | 'materials' | 'approvals' | 'me';

/** tabBar 判显隐要的那点东西：角色矩阵里各入口的「可见」 */
export interface TabAccess {
  /** /auth/me 的 access.pages 精简版（key 为 app:xxx）；拿不到时为 null */
  pages: Record<string, boolean> | null;
}

/** tab key → 角色矩阵里的入口 key（后台「业务角色」页里勾的就是这些） */
export const TAB_PAGE: Record<TabKey, string> = {
  pool: 'app:pool',
  dispatch: 'app:dispatch',
  mine: 'app:my-orders',
  materials: 'app:inventory', // 「材料 SKU 库」那一格在 canSeeTab 里一并判
  approvals: 'app:approve-manager', // 采购那一步在 canSeeTab 里一并判
  me: '',
};

/**
 * 某一格该不该显示。
 *
 * 「我的」永远可见（要能看自己的资料、退出登录）；
 * 权限还没拿到时（登录后第一次 /auth/me 回来之前）全部显示 ——
 * 多一格也比让有权限的人以为功能没了强，后端仍会拦。
 */
export function canSeeTab(key: TabKey, access: TabAccess): boolean {
  if (key === 'me') return true;
  const { pages } = access;
  if (!pages) return true;
  if (key === 'approvals') {
    return !!(pages['app:approve-manager'] || pages['app:approve-purchaser']);
  }
  // 「材料与库存」这一页里有两格：库存（app:inventory）和材料 SKU 库（app:materials）。
  // 只勾了后者的角色也得进得来，否则那一格永远够不着
  if (key === 'materials') {
    return !!(pages['app:inventory'] || pages['app:materials']);
  }
  // 「我的报修」虽然复用工单池页面，但授权是独立的。只给这格的人仍要能进入
  // 容器页，进去后页面只展示「我报的」，不会展示待接工单。
  if (key === 'pool') {
    return !!(pages['app:pool'] || pages['app:my-repairs']);
  }
  return !!pages[TAB_PAGE[key]];
}
