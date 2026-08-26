// 页面注册表（与 packages/shared-types/src/pages.ts 同源，调整需双向同步）。
// pageKey 一经上线不要改：role_permissions / tenants.enabled_pages 按它存储。
//
// 两组：ADMIN_PAGE_KEYS = 网站后台菜单；STAFF_APP_PAGE_KEYS = 员工端小程序入口
// （`app:` 前缀）。同一张权限表管两端，「这个角色能看到什么」只有一处配置。

export type PermissionAction = 'view' | 'edit' | 'delete';

/** 企业端页面 key（参与角色权限矩阵与租户可用页面勾选） */
export const ADMIN_PAGE_KEYS = [
  'dashboard', // 工作台
  'work-orders', // 工单管理
  'business', // 前台收费
  'materials', // 材料 SKU 库
  'inventory', // 库存与采购
  'properties', // 房产与业主
  'owners', // 业主审核
  'users', // 用户管理
  'roles', // 角色管理
  'offices', // 管理处
  'qr', // 楼栋报修码
  'settings', // 系统设置
] as const;

export type AdminPageKey = (typeof ADMIN_PAGE_KEYS)[number];

/**
 * 员工端小程序的入口 key。哪个角色能看到哪几格由角色矩阵决定，
 * 端上不再按业务身份写死（详见 shared-types/src/pages.ts 的说明）。
 * 「我的」页人人可见，不参与勾选。
 */
export const STAFF_APP_PAGE_KEYS = [
  'app:pool', // 工单池 / 派单台
  'app:my-orders', // 在手工单 / 我的报修
  'app:repair-create', // 报修（代住户提单）
  'app:inventory', // 材料与库存
  'app:approvals', // 采购审批
  'app:messages', // 消息中心
] as const;

export type StaffAppPageKey = (typeof STAFF_APP_PAGE_KEYS)[number];

/** 权限矩阵可勾选的全部页面 */
export const ALL_PAGE_KEYS = [...ADMIN_PAGE_KEYS, ...STAFF_APP_PAGE_KEYS] as const;

export const isStaffAppPageKey = (key: string) => key.startsWith('app:');

/**
 * 每个业务身份在员工端的推荐入口组合 —— 合并前硬编码在小程序里的那套。
 * 两处用它：升级时种子给身份角色预勾（apps/api rbac-seed），
 * 新建角色时后台表单预填。两边必须是同一份，否则「后台勾的」和「实际种的」会对不上。
 *
 * 'v' = 只看，'e' = 看 + 操作。代报身份（保安/居委会/业委会/物业工作人员）共用一份。
 */
export const DEFAULT_APP_PAGES_BY_IDENTITY: Record<string, Record<string, 'v' | 'e'>> = {
  technician: {
    'app:pool': 'e',
    'app:my-orders': 'e',
    'app:repair-create': 'v',
    'app:messages': 'v',
  },
  office: {
    'app:pool': 'e',
    'app:inventory': 'e',
    'app:repair-create': 'v',
    'app:messages': 'v',
  },
  manager: {
    'app:pool': 'e',
    'app:inventory': 'e',
    'app:approvals': 'e',
    'app:repair-create': 'v',
    'app:messages': 'v',
  },
  purchaser: {
    'app:pool': 'e',
    'app:inventory': 'e',
    'app:approvals': 'e',
    'app:repair-create': 'v',
    'app:messages': 'v',
  },
  admin: {
    'app:pool': 'e',
    'app:my-orders': 'e',
    'app:inventory': 'e',
    'app:approvals': 'e',
    'app:repair-create': 'v',
    'app:messages': 'v',
  },
  guard: { 'app:repair-create': 'v', 'app:my-orders': 'v', 'app:messages': 'v' },
  neighborhood: { 'app:repair-create': 'v', 'app:my-orders': 'v', 'app:messages': 'v' },
  owner_committee: { 'app:repair-create': 'v', 'app:my-orders': 'v', 'app:messages': 'v' },
  property_staff: { 'app:repair-create': 'v', 'app:my-orders': 'v', 'app:messages': 'v' },
};

/** 角色数据范围类型 */
export enum RoleDataScope {
  ALL = 'all', // 全公司
  OFFICES = 'offices', // 指定管理处（自动含其下全部小区）
  COMMUNITIES = 'communities', // 指定小区
}
