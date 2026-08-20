// 管理后台页面注册表（与 packages/shared-types/src/pages.ts 同源，调整需双向同步）。
// pageKey 一经上线不要改：role_permissions / tenants.enabled_pages 按它存储。

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

/** 角色数据范围类型 */
export enum RoleDataScope {
  ALL = 'all', // 全公司
  OFFICES = 'offices', // 指定管理处（自动含其下全部小区）
  COMMUNITIES = 'communities', // 指定小区
}
