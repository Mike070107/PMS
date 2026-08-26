/**
 * 员工端的身份与「底部哪几格可见」，只在这里定义一次。
 *
 * 单独一个文件（不并进 session.ts）是为了 tabBar：它在 attached 里只读本地缓存、
 * **绝不能碰网络**，所以不该顺带 import 到 api-client 那条链上。
 * 这个文件不 import 任何东西，谁都能安全引。
 *
 * 身份来自后台的角色（2026-08-26 起业务身份并进角色表 roles.business_role）：
 * 管理员在后台把某人的角色改成维修工，users.role 跟着变，端上这里就跟着变。
 * 「能不能点某个按钮」仍看权限矩阵 access.pages —— 见 session.ts。
 */

/** 只报修、不接单也不派单：保安 / 居委会 / 业委会 / 物业工作人员 */
export const REPORTER_ROLES: string[] = [
  'guard',
  'neighborhood',
  'owner_committee',
  'property_staff',
];

/** 维修工：接单、完工、报缺料 */
export const TECHNICIAN_ROLE = 'technician';

/**
 * 办公室一侧：不接单，但要派单、管材料与库存。
 * 对他们来说「工单池」是待派单池而不是待接单池，「在手工单」永远是空的
 * （单不会派到自己头上），所以那一格换成「材料与库存」。
 */
export const DISPATCH_ROLES: string[] = ['office', 'manager', 'purchaser', 'admin'];

/** 干物业活的人（能看工单池），代报身份不在内 */
export const WORKER_ROLES: string[] = [TECHNICIAN_ROLE, ...DISPATCH_ROLES];

/** 采购审批：按业务身份把关（审批流程语义，见 docs/rbac-design.md 的例外约定） */
export const APPROVER_ROLES: string[] = ['manager', 'purchaser', 'admin'];

export const isTechnician = (role: string) => role === TECHNICIAN_ROLE;
export const isDispatcher = (role: string) => DISPATCH_ROLES.indexOf(role) >= 0;
export const isReporter = (role: string) => REPORTER_ROLES.indexOf(role) >= 0;

/** 底部 tab 的 key，与 custom-tab-bar 的 ALL_TABS 一一对应 */
export type TabKey = 'pool' | 'mine' | 'materials' | 'approvals' | 'me';

/** tabBar 判显隐要的那点东西：身份 + 角色矩阵里各入口的「可见」 */
export interface TabAccess {
  role: string;
  /** /auth/me 的 access.pages 精简版（key 为 app:xxx）；拿不到时为 null，按身份兜底 */
  pages: Record<string, boolean> | null;
}

/** tab key → 角色矩阵里的入口 key（后台「角色管理」里勾的就是这些） */
const TAB_PAGE: Record<TabKey, string> = {
  pool: 'app:pool',
  mine: 'app:my-orders',
  materials: 'app:inventory',
  approvals: 'app:approvals',
  me: '',
};

/**
 * 没有权限矩阵时的兜底：合并前硬编码的那套。
 * 只在老会话（登录后还没拿到过 /auth/me）时用得上，拿到一次就再也走不到这里。
 */
function fallbackByRole(key: TabKey, role: string): boolean {
  switch (key) {
    case 'pool':
      return WORKER_ROLES.indexOf(role) >= 0;
    case 'mine':
      return !isDispatcher(role);
    case 'materials':
      return isDispatcher(role);
    case 'approvals':
      return APPROVER_ROLES.indexOf(role) >= 0;
    default:
      return true;
  }
}

/**
 * 某一格该不该显示 —— 由后台「角色管理」里给这个角色勾的入口决定。
 *
 * 每个工种的活不一样，看到的入口就该不一样，这件事现在只有一处配置：
 * 角色矩阵。端上不再写死「办公室看得到材料与库存」那种白名单 ——
 * 2026-08-26 之前正是因为写死，后台把人改成维修工，底部还挂着派单台。
 *
 * 「我的」永远可见（要能看自己的资料、退出登录）；
 * 角色和权限都拿不到时一律显示：多一格也比让有权限的人以为功能没了强，后端仍会拦。
 */
export function canSeeTab(key: TabKey, access: TabAccess): boolean {
  if (key === 'me') return true;
  const { role, pages } = access;
  if (pages) return !!pages[TAB_PAGE[key]];
  if (!role) return true;
  return fallbackByRole(key, role);
}
