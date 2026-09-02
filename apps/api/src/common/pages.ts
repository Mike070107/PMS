// 页面注册表（与 packages/shared-types/src/pages.ts 同源，调整需双向同步）。
// pageKey 一经上线不要改：role_permissions / tenants.enabled_pages 按它存储。
//
// 两组：ADMIN_PAGE_KEYS = 网站后台菜单；STAFF_APP_PAGE_KEYS = 员工端小程序入口
// （`app:` 前缀）。同一张权限表管两端，「这个角色能看到什么」只有一处配置。

export type PermissionAction = 'view' | 'edit' | 'delete';

/** 企业端页面 key（参与角色权限矩阵与租户可用页面勾选） */
export const ADMIN_PAGE_KEYS = [
  'dashboard', // 工作台
  'reports', // 报表查询（工单 / 人员 / 库存 / 材料使用）
  'work-orders', // 工单管理
  'maintenance-orders', // 养护单（房屋修理养护任务单）：填单 / 打印
  'maintenance-inspect', // 养护单查验（物业经理签字），单独一格：填单的人不该能自己查验自己
  'business', // 前台收费
  'fees', // 物业费（账单 / 收费标准 / 欠费）
  'materials', // 材料 SKU 库
  'inventory', // 库存与采购
  'stocktakes', // 库存盘点（发起、报告、复核）
  'properties', // 房产与业主
  'owners', // 业主审核
  'users', // 用户管理
  'roles', // 角色管理
  'offices', // 管理处
  'qr', // 楼栋报修码
  'settings', // 系统设置
  'logs', // 日志管理、使用分析与异常监控
] as const;

export type AdminPageKey = (typeof ADMIN_PAGE_KEYS)[number];

/**
 * 员工端小程序的入口 key。哪个角色能看到哪几格、能不能动手，**只由角色矩阵决定** ——
 * 后端接口也按这些 key 鉴权，不再有「业务身份」那一层（详见 shared-types/src/pages.ts）。
 * 「我的」页人人可见，不参与勾选。
 */
export const STAFF_APP_PAGE_KEYS = [
  'app:dispatch', // 派单台（派单）
  'app:pool', // 工单池（接单）
  'app:my-orders', // 在手工单（派给本人、由本人处理）
  'app:my-repairs', // 我的报修（本人提交的报修进度）
  'app:repair-create', // 报修
  'app:inventory', // 材料与库存（现场查存量、看采购进度）
  'app:stocktakes', // 库存盘点（现场扫码、提交复核）
  'app:materials', // 材料 SKU 库（看/改材料档案，单独一格）
  'app:approve-manager', // 采购审批（经理这一步）
  'app:approve-purchaser', // 采购审批（采购这一步）
  'app:messages', // 消息中心
] as const;

export type StaffAppPageKey = (typeof STAFF_APP_PAGE_KEYS)[number];

/** 权限矩阵可勾选的全部页面 */
/**
 * 不受 tenants.enabled_pages 裁剪的后台页面：公司自己的配置项（订阅消息模板、
 * 自动验收时限），平台「可用页面」勾不勾都得能进 —— 勾漏了整家公司就配不了通知。
 */
export const ALWAYS_ENABLED_PAGES: string[] = ['settings', 'logs'];

export const ALL_PAGE_KEYS = [...ADMIN_PAGE_KEYS, ...STAFF_APP_PAGE_KEYS] as const;

export const isStaffAppPageKey = (key: string) => key.startsWith('app:');

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
      'app:stocktakes': 'e',
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
      'app:materials': 'e',
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
  ALL = 'all', // 全公司
  OFFICES = 'offices', // 指定管理处（自动含其下全部小区）
  COMMUNITIES = 'communities', // 指定小区
}
