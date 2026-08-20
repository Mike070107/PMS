// 管理后台页面注册表：权限矩阵、菜单过滤、租户可用页面勾选共用同一份 key。
// 新增后台页面时在这里登记，pageKey 一经上线不要改（数据库 role_permissions 按它存储）。

export type PermissionAction = 'view' | 'edit' | 'delete';

export interface AdminPageDef {
  /** 稳定标识，存库用 */
  key: string;
  /** 菜单/矩阵显示名 */
  label: string;
  /** 菜单分组名 */
  group: string;
}

/** 企业端页面（参与角色权限矩阵与租户可用页面勾选） */
export const ADMIN_PAGES: AdminPageDef[] = [
  { key: 'dashboard', label: '工作台', group: '总览' },
  { key: 'work-orders', label: '工单管理', group: '报修工单' },
  { key: 'business', label: '前台收费', group: '收费业务' },
  { key: 'materials', label: '材料 SKU 库', group: '材料与库存' },
  { key: 'inventory', label: '库存与采购', group: '材料与库存' },
  { key: 'properties', label: '房产与业主', group: '基础档案' },
  { key: 'owners', label: '业主审核', group: '基础档案' },
  { key: 'users', label: '用户管理', group: '基础档案' },
  { key: 'roles', label: '角色管理', group: '基础档案' },
  { key: 'offices', label: '管理处', group: '基础档案' },
  { key: 'qr', label: '楼栋报修码', group: '基础档案' },
  { key: 'settings', label: '系统设置', group: '系统' },
];

export const ADMIN_PAGE_KEYS = ADMIN_PAGES.map((p) => p.key);

/** 角色数据范围类型 */
export enum RoleDataScope {
  /** 全公司 */
  ALL = 'all',
  /** 指定管理处（自动含其下全部小区，含之后新增的） */
  OFFICES = 'offices',
  /** 指定小区 */
  COMMUNITIES = 'communities',
}

export const ROLE_DATA_SCOPE_LABELS: Record<string, string> = {
  [RoleDataScope.ALL]: '全公司',
  [RoleDataScope.OFFICES]: '指定管理处',
  [RoleDataScope.COMMUNITIES]: '指定小区',
};

/** 单页三档权限 */
export interface PagePermission {
  pageKey: string;
  canView: boolean;
  canEdit: boolean;
  canDelete: boolean;
}

/** /auth/me 下发的后台访问能力（后端 ResolvedAccess 的裁剪版） */
export interface AdminAccess {
  isPlatformAdmin: boolean;
  isTenantAdmin: boolean;
  pages: Record<string, { view: boolean; edit: boolean; delete: boolean }>;
  scopeAll: boolean;
  communityIds: number[] | null;
  enabledPages: string[] | null;
  /** 可切换的管理处（顶栏切换器选项；按本体权限算，不受当前视角影响） */
  offices: Array<{ id: number; name: string }>;
  /** 生效中的管理处视角（x-acting-office-id）；null = 全部 */
  actingOfficeId: number | null;
}
