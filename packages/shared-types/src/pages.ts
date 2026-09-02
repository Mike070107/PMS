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
  /** 权限矩阵里这一行的说明（不填就显示分组名） */
  hint?: string;
  /**
   * 勾中之后还能再细分的动作。不填 = 默认的「编辑（含新增）」+「删除」两档；
   * 空数组 = 这一格只有「给 / 不给」（如养护单查验：勾中就是能查验签字）。
   */
  actions?: Array<{ field: 'canEdit' | 'canDelete'; label: string; hint?: string }>;
}

/** 后台页面默认的两档细分动作 */
export const DEFAULT_ADMIN_PAGE_ACTIONS: NonNullable<AdminPageDef['actions']> = [
  { field: 'canEdit', label: '编辑（含新增）' },
  { field: 'canDelete', label: '删除' },
];

/** 企业端页面（参与角色权限矩阵与租户可用页面勾选） */
export const ADMIN_PAGES: AdminPageDef[] = [
  { key: 'dashboard', label: '工作台', group: '总览' },
  { key: 'reports', label: '报表查询', group: '总览' },
  { key: 'work-orders', label: '工单管理', group: '报修工单' },
  {
    key: 'maintenance-orders',
    label: '养护单',
    group: '报修工单',
    hint: '按工单开《房屋修理养护任务单》、打印',
  },
  {
    key: 'maintenance-inspect',
    label: '养护单查验（签字）',
    group: '报修工单',
    // 勾中即可查验，不再分档：这一格表达的就是「他是那个签字的人」（物业经理）。
    // 和「养护单」分开是有意的 —— 填单的人自己查验自己，三方签字就白签了。
    hint: '勾中 = 可以查验并手写签名（物业经理）',
    actions: [],
  },
  { key: 'business', label: '前台收费', group: '收费业务' },
  { key: 'fees', label: '物业费', group: '收费业务' },
  { key: 'materials', label: '材料 SKU 库', group: '材料与库存' },
  { key: 'inventory', label: '库存与采购', group: '材料与库存' },
  {
    key: 'stocktakes',
    label: '库存盘点',
    group: '材料与库存',
    hint: '发起盘点、录入实盘数量、复核并查看盘点报告',
  },
  { key: 'properties', label: '房产与业主', group: '基础档案' },
  { key: 'owners', label: '业主审核', group: '基础档案' },
  { key: 'users', label: '用户管理', group: '基础档案' },
  { key: 'roles', label: '业务角色', group: '基础档案' },
  { key: 'offices', label: '管理处', group: '基础档案' },
  { key: 'qr', label: '楼栋报修码', group: '基础档案' },
  { key: 'settings', label: '系统设置', group: '系统' },
  {
    key: 'logs',
    label: '日志管理',
    group: '系统',
    hint: '登录与重要操作日志、使用情况、负载和异常告警',
    actions: [],
  },
];

export const ADMIN_PAGE_KEYS = ADMIN_PAGES.map((p) => p.key);

/**
 * 员工端小程序的入口。哪个角色看到哪几格，**只由这里的勾选决定**，端上不写死。
 *
 * 为什么「工单池」和「派单台」是两格、审批分两格：
 * 这些是真正不同的动作，不是同一个动作的两种叫法。维修工把单领到自己名下（接单），
 * 办公室把单指派给别人（派单）；采购申请要先过经理、再过采购。
 * 早先把它们并成一格、另设一个「角色类型」字段去区分，等于让配置的人多填一个字段
 * 才能表达本来勾一下就能表达的事 —— 2026-08-26 拆开，类型字段随之删除。
 *
 * 「我的」页不在此列：任何人都要能看到自己的资料和退出登录。
 * 「删除」一档对小程序没有意义，矩阵里只勾查看/操作两档。
 */
export const STAFF_APP_PAGES: StaffAppPageDef[] = [
  {
    key: 'app:pool',
    label: '工单池',
    hint: '看还没人接的活',
    editLabel: '接单',
    editHint: '把单领到自己名下',
  },
  {
    key: 'app:dispatch',
    label: '派单台',
    hint: '看待派单的活',
    editLabel: '派单',
    editHint: '把单指派给维修工、改期限',
  },
  {
    key: 'app:my-orders',
    label: '在手工单',
    hint: '派给自己、由自己处理的工单',
    editLabel: '处理工单',
    editHint: '完工、报缺料、回填处理结果',
  },
  {
    key: 'app:my-repairs',
    label: '我的报修',
    hint: '查看自己替住户或巡查提交的报修进度',
  },
  {
    key: 'app:repair-create',
    label: '报修',
    hint: '替住户提单',
  },
  {
    key: 'app:inventory',
    label: '材料与库存',
    hint: '查还有几个、看采购进度',
    editLabel: '改材料 / 提采购',
    editHint: '补 SKU 资料和照片、发起采购申请',
  },
  {
    key: 'app:stocktakes',
    label: '库存盘点',
    hint: '现场扫码、查看盘点任务',
    editLabel: '盘点 / 复核',
    editHint: '新建盘点任务、录入实盘数量并复核',
  },
  {
    // 和「材料与库存」分成两格：那一格是「现场查还有几个」，人人都该有；
    // 这一格是「改材料档案」—— 改错名称型号会影响全公司的编码和统计，
    // 所以谁能进材料 SKU 库要单独勾（2026-09-01 要求）
    key: 'app:materials',
    label: '材料 SKU 库',
    hint: '看全部材料档案：编码、型号、别名、参考成本',
    editLabel: '改 SKU',
    editHint: '改名称型号、补照片和参数、停用',
  },
  {
    key: 'app:approve-manager',
    label: '采购审批（经理这一步）',
    hint: '看待经理审批的采购单',
    editLabel: '批 / 驳回',
    editHint: '采购申请要先过这一步',
  },
  {
    key: 'app:approve-purchaser',
    label: '采购审批（采购这一步）',
    hint: '看经理批完、待采购确认的单',
    editLabel: '批 / 驳回',
    editHint: '经理批完之后的第二步',
  },
  {
    key: 'app:messages',
    label: '消息中心',
    hint: '派单通知、催办提醒',
  },
];

/**
 * 不受 tenants.enabled_pages 裁剪的后台页面：公司自己的配置项（订阅消息模板、
 * 自动验收时限），平台「可用页面」勾不勾都得能进 —— 勾漏了整家公司就配不了通知。
 */
export const ALWAYS_ENABLED_PAGES: string[] = ['settings', 'logs'];

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
 * 开箱即用的几个角色和它们的入口。**只是初始值** —— 名字、勾选、数据范围
 * 都可以在「业务角色」页随便改，改完不会被任何东西覆盖回去。
 *
 * 'v' = 只看，'e' = 看 + 能动手。
 */
export const DEFAULT_ROLE_TEMPLATES: {
  name: string;
  remark: string;
  appPages: Record<string, 'v' | 'e'>;
  adminPages?: Record<string, 'v' | 'e'>;
}[] = [
  {
    name: '维修工',
    remark: '接单、完工、报缺料；不进网站后台',
    appPages: {
      'app:pool': 'e',
      'app:my-orders': 'e',
      'app:my-repairs': 'v',
      'app:repair-create': 'v',
      'app:messages': 'v',
    },
  },
  {
    name: '物业办公室',
    remark: '派单、管材料与库存、提采购申请',
    appPages: {
      'app:dispatch': 'e',
      'app:inventory': 'e',
      'app:stocktakes': 'e',
      'app:materials': 'e',
      'app:my-repairs': 'v',
      'app:repair-create': 'v',
      'app:messages': 'v',
    },
    adminPages: {
      dashboard: 'v',
      'work-orders': 'e',
      'maintenance-orders': 'e',
      materials: 'e',
      inventory: 'e',
      stocktakes: 'e',
      properties: 'v',
      qr: 'v',
    },
  },
  {
    name: '物业经理',
    remark: '派单 + 采购审批（经理这一步）+ 后台各页',
    appPages: {
      'app:dispatch': 'e',
      'app:inventory': 'e',
      'app:stocktakes': 'e',
      'app:materials': 'e',
      'app:approve-manager': 'e',
      'app:my-repairs': 'v',
      'app:repair-create': 'v',
      'app:messages': 'v',
    },
    adminPages: {
      dashboard: 'v',
      reports: 'v',
      'work-orders': 'e',
      'maintenance-orders': 'e',
      'maintenance-inspect': 'v',
      business: 'e',
      fees: 'e',
      materials: 'e',
      inventory: 'e',
      stocktakes: 'e',
      properties: 'e',
      owners: 'e',
      qr: 'e',
      logs: 'v',
    },
  },
  {
    name: '采购经理',
    remark: '采购审批（采购这一步）+ 材料库存',
    appPages: {
      'app:inventory': 'e',
      'app:stocktakes': 'e',
      'app:approve-purchaser': 'e',
      'app:messages': 'v',
    },
    adminPages: { dashboard: 'v', materials: 'e', inventory: 'e', stocktakes: 'e' },
  },
  {
    name: '保安',
    remark: '只替住户报修，看自己报的单',
    appPages: {
      'app:repair-create': 'v',
      'app:my-repairs': 'v',
      'app:messages': 'v',
    },
  },
  {
    name: '居委会',
    remark: '只替住户报修，看自己报的单',
    appPages: {
      'app:repair-create': 'v',
      'app:my-repairs': 'v',
      'app:messages': 'v',
    },
  },
  {
    name: '业委会',
    remark: '只替住户报修，看自己报的单',
    appPages: {
      'app:repair-create': 'v',
      'app:my-repairs': 'v',
      'app:messages': 'v',
    },
  },
];

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
