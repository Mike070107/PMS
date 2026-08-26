// 页面注册表：权限矩阵、后台菜单过滤、员工端底部入口、租户可用页面勾选共用同一份 key。
// 新增页面时在这里登记，pageKey 一经上线不要改（数据库 role_permissions 按它存储）。
//
// 两组页面：
//   · ADMIN_PAGES —— 网站后台的菜单
//   · STAFF_APP_PAGES —— 员工端小程序的入口，key 一律 `app:` 前缀
// 合并成一份是因为「这个角色能看到什么」本来就是一件事：2026-08-26 之前后台矩阵
// 只管网站，小程序端另按身份硬编码，于是后台把人改成维修工、端上底部纹丝不动。

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
  { key: 'roles', label: '业务角色', group: '基础档案' },
  { key: 'offices', label: '管理处', group: '基础档案' },
  { key: 'qr', label: '楼栋报修码', group: '基础档案' },
  { key: 'settings', label: '系统设置', group: '系统' },
];

export const ADMIN_PAGE_KEYS = ADMIN_PAGES.map((p) => p.key);

/**
 * 员工端小程序的入口。不同工种工作流不同 —— 维修工要工单池和在手工单，
 * 办公室要派单台和材料库存，保安只要报修 —— 全部由角色勾选决定，不再写死。
 *
 * 「我的」页不在此列：任何人都要能看到自己的资料和退出登录。
 * 「删除」一档对小程序没有意义，矩阵里只勾查看/操作两档。
 */
export const STAFF_APP_PAGES: StaffAppPageDef[] = [
  {
    key: 'app:pool',
    label: '工单池 / 派单台',
    hint: '看还没派出去的单',
    editLabel: '接单 / 派单',
    editHint: '维修工领单、办公室把单派给人',
  },
  {
    key: 'app:my-orders',
    label: '在手工单 / 我的报修',
    hint: '自己接的单，或自己报的单',
    editLabel: '处理工单',
    editHint: '完工、报缺料、回填处理结果',
  },
  {
    key: 'app:repair-create',
    label: '报修',
    hint: '替住户提单（保安、居委会、业委会常用）',
  },
  {
    key: 'app:inventory',
    label: '材料与库存',
    hint: '查还有几个、看采购进度',
    editLabel: '改材料信息',
    editHint: '补 SKU 资料和照片、发起采购申请',
  },
  {
    key: 'app:approvals',
    label: '采购审批',
    hint: '看待审批的采购单',
    editLabel: '审批',
    editHint: '通过或驳回。后端仍按经理/采购身份把关，其它角色勾了也批不动',
  },
  {
    key: 'app:messages',
    label: '消息中心',
    hint: '派单通知、催办提醒',
  },
];

export const STAFF_APP_PAGE_KEYS = STAFF_APP_PAGES.map((p) => p.key);

/** 权限矩阵可勾选的全部页面（后台 + 员工端） */
export const ALL_PAGE_KEYS = [...ADMIN_PAGE_KEYS, ...STAFF_APP_PAGE_KEYS];

export const isStaffAppPageKey = (key: string) => key.startsWith('app:');

export interface StaffAppPageDef {
  /** 稳定标识，存库用；一律 `app:` 前缀 */
  key: string;
  /** 矩阵显示名 */
  label: string;
  /** 「查看」这一档在干什么 */
  hint: string;
  /** 「编辑」一档的叫法；不填 = 这一页没有操作权可分 */
  editLabel?: string;
  editHint?: string;
}

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
