// 跨端共享：枚举与 DTO 类型。
// 与 apps/api/src/common/enums.ts 同源，后续如 API 端有调整需双向同步。
import type { AdminAccess } from './pages';

// ---------- 枚举 ----------
export enum UserRole {
  OWNER = 'owner',
  STAFF = 'staff',
  SUPERADMIN = 'superadmin',
}

/** 走业主端小程序（邻修管家）的角色：只有业主 */
export const OWNER_APP_ROLES: UserRole[] = [UserRole.OWNER];

/** 走员工端小程序（邻修管理）的角色 */
export const STAFF_APP_ROLES: UserRole[] = [UserRole.STAFF];

/** 后台「用户管理」里能开的账号：员工（干哪一行由角色决定） */
export const ASSIGNABLE_STAFF_ROLES: UserRole[] = [UserRole.STAFF];

export const USER_ROLE_LABELS: Record<string, string> = {
  [UserRole.OWNER]: '业主',
  [UserRole.STAFF]: '员工',
  [UserRole.SUPERADMIN]: '平台管理员',
};

export enum AuditStatus {
  PENDING = 'pending',
  APPROVED = 'approved',
  REJECTED = 'rejected',
}

export enum UserStatus {
  ACTIVE = 'active',
  DISABLED = 'disabled',
}

/**
 * 业主档案是怎么来的。
 * 报修登记来的那批是「顺手记下来的」，不是业主自己认证过的 —— 后台必须能一眼分开，
 * 否则谁也不知道这条档案可不可信、要不要打电话核实。
 */
export enum OwnerSource {
  /** 后台手工建档 */
  MANUAL = 'manual',
  /** 业主自己在小程序认证房屋 */
  SELF = 'self',
  /** 员工报修时报出来的联系人，系统顺手记的 */
  REPAIR_INTAKE = 'repair_intake',
  /** 从老收费系统整批导入的存量档案（姓名/房号可信，电话可能是固话或已停用） */
  LEGACY_IMPORT = 'legacy_import',
}

export const OWNER_SOURCE_LABELS: Record<string, string> = {
  [OwnerSource.MANUAL]: '后台建档',
  [OwnerSource.SELF]: '业主认证',
  [OwnerSource.REPAIR_INTAKE]: '报修登记',
  [OwnerSource.LEGACY_IMPORT]: '老系统导入',
};

export enum QrGranularity {
  COMMUNITY = 'community',
  BUILDING = 'building',
}

export enum WorkOrderStatus {
  CREATED = 'created',
  DISPATCHED = 'dispatched',
  IN_PROGRESS = 'in_progress',
  WAITING_MATERIAL = 'waiting_material',
  DONE_PENDING_REVIEW = 'done_pending_review',
  COMPLETED = 'completed',
  CANCELLED = 'cancelled',
}

export enum RepairSource {
  OWNER_MINIAPP = 'owner_miniapp',
  /** 员工小程序（邻修管理）：维修工/办公室巡查顺手报修 */
  STAFF_MINIAPP = 'staff_miniapp',
  OFFICE_WEB = 'office_web',
}

/** 报修来源的中文说法：时间轴/详情直接展示给业主，不能露枚举值 */
export const REPAIR_SOURCE_LABELS: Record<string, string> = {
  [RepairSource.OWNER_MINIAPP]: '业主小程序提交',
  [RepairSource.STAFF_MINIAPP]: '员工小程序提交',
  [RepairSource.OFFICE_WEB]: '物业办公室登记',
};

export enum WarehouseType {
  CENTRAL = 'central',
  COMMUNITY = 'community',
  /** 管理处仓：新建管理处时自动建的同名仓 */
  OFFICE = 'office',
}

export const WAREHOUSE_TYPE_LABELS: Record<string, string> = {
  [WarehouseType.CENTRAL]: '总仓',
  [WarehouseType.COMMUNITY]: '小区仓',
  [WarehouseType.OFFICE]: '管理处仓',
};

export enum StockMovementType {
  INBOUND = 'inbound',
  OUTBOUND = 'outbound',
  RETURN = 'return',
  TRANSFER = 'transfer',
  ADJUST = 'adjust',
}

export enum PurchaseRequestStatus {
  DRAFT = 'draft',
  OFFICE_REVIEW = 'office_review',
  MANAGER_REVIEW = 'manager_review',
  PURCHASER_REVIEW = 'purchaser_review',
  APPROVED = 'approved',
  REJECTED = 'rejected',
  MERGED = 'merged',
  DONE = 'done',
}

export enum PurchaseOrderStatus {
  PLACED = 'placed',
  PARTIAL = 'partial',
  RECEIVED = 'received',
  CLOSED = 'closed',
}

export enum NotifyChannel {
  WX_SUBSCRIBE = 'wx_subscribe',
  IN_APP = 'in_app',
}

export enum NotifyStatus {
  PENDING = 'pending',
  SENT = 'sent',
  FAILED = 'failed',
  FALLBACK = 'fallback',
}

export enum DictType {
  SKILL = 'skill',
  REPAIR_TYPE = 'repair_type',
  REPAIR_COMMON_TAG = 'repair_common_tag',
  REPAIR_ACTION_TAG = 'repair_action_tag',
  MATERIAL_CATEGORY = 'material_category',
}

// ---------- 通用响应 ----------
export interface ApiOk<T> {
  code: 0;
  data: T;
  message?: string;
}

export interface ApiErr {
  code: number;
  message: string;
  data?: null;
}

export type ApiResp<T> = ApiOk<T> | ApiErr;

export interface Paginated<T> {
  list: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface DashboardMetrics {
  dispatching: number;
  material: number;
  review: number;
  pendingAudits: number;
  pendingPurchase: number;
}

// ---------- 认证 ----------
export interface LoginByCodeReq {
  code: string;
  appType: 'owner' | 'staff';
}

export interface StaffLoginReq {
  code: string;
  phoneCode?: string;
  account?: string;
  password?: string;
}

export interface LoginResp {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: UserBrief;
  needBinding?: boolean;
}

export interface UserBrief {
  id: string;
  role: UserRole;
  nickname?: string;
  avatar?: string;
  phone?: string;
  tenantId?: string;
}

/** 业主绑定/申请中的房屋（GET /auth/me 对业主返回） */
export interface OwnerPlace {
  auditStatus: AuditStatus;
  rejectReason: string | null;
  communityId: number;
  communityName: string;
  buildingId: number | null;
  buildingText: string;
  houseId: number | null;
  roomNo: string;
  addressText: string;
  /**
   * true = 这不是他家，是物业地址：保安/居委会/业委会/物业工作人员没有
   * 「自己家」概念，默认位置显示第一个授权小区的物业地址（小区档案里的「地址」）。
   * 他们 2026-08-24 起走员工端，业主端已经不会再收到这个标记。
   */
  officePlace?: boolean;
}

/** GET /auth/me 的返回 */
export interface MeResp {
  id: number;
  tenantId: number | null;
  role: UserRole;
  name: string | null;
  phone: string | null;
  loginAccount: string | null;
  status: UserStatus;
  /** 他绑的角色名。没有「身份」可显示了，角色名就是他在系统里的称呼 */
  roleNames?: string[];
  /** 仅业主/代报角色返回；未提交入驻时为 null */
  place?: OwnerPlace | null;
  /** 仅代报角色返回（员工端用）：能替哪些小区报修 */
  reporter?: ReporterGrant;
  /** 该物业配好的微信订阅消息模板 id，端上用它调 requestSubscribeMessage */
  subscribeTemplates?: string[];
  /**
   * 后台角色的权限矩阵（业主之外的身份都返回）。管理后台一直在用，
   * 员工端小程序也一律以它为准判「这个按钮给不给点」——
   * 端上再照着业务身份手写一份角色白名单，就会和服务端的 @RequirePermission 判得不一样：
   * 要么点了才 403，要么明明有权限却看不到入口（办公室改材料 SKU 就是后者）。
   */
  access?: AdminAccess;
}

/**
 * 代报授权。员工端据此把报修地址簿收窄到授权小区 —— 保安/居委会/业委会
 * 报的东西往往既不在自己家、也不在自己楼里，但也不该能报到别的小区去。
 */
export interface ReporterGrant {
  role: UserRole;
  /** 中文身份，直接展示：保安 / 居委会 / 业委会 */
  roleLabel: string;
  /** 一个授权小区都没有时为 false，端上不显示代报入口 */
  canReportOthers: boolean;
  communities: Array<{ id: number; name: string }>;
}

export interface OwnerOnboardReq {
  communityId: number;
  buildingId?: number;
  /** 业主手改过的弄/号；传了就以它为准在该小区里匹配楼栋 */
  lane?: string;
  buildingNo?: string;
  roomNo: string;
  realName?: string;
  phone?: string;
  phoneCode?: string;
}

// ---------- 二维码 ----------
export interface QrResolveResp {
  token: string;
  tenantId: number;
  granularity: QrGranularity;
  placeNote: string | null;
  /** 印在码上的文案，如「枫桦景苑二期 228弄3号 · 扫码报修」 */
  caption: string | null;
  community: { id: number; name: string } | null;
  building: { id: number; lane: string | null; buildingNo: string } | null;
}

/** 一张楼栋码的生成状态 */
export interface BuildingQrInfo {
  id: number;
  token: string;
  caption: string | null;
  imageUrl: string | null;
  envVersion: string | null;
  targetPage: string | null;
  generatedAt: string | null;
  lastError: string | null;
  enabled: boolean;
}

/** GET /qr-codes/buildings 的一行：楼栋 + 它的码（没生成时 qr = null） */
export interface BuildingQrRow {
  buildingId: number;
  communityId: number;
  communityName: string;
  lane: string | null;
  buildingNo: string;
  /** 228弄3号 */
  buildingText: string;
  qr: BuildingQrInfo | null;
}

export interface QrBackfillResp {
  totalBuildings: number;
  /** 本次新建的码记录数 */
  created: number;
  /** 本次成功出图的张数 */
  generated: number;
  failed: Array<{ buildingId: number; buildingText: string; reason: string }>;
  /** 还剩多少张没出图，> 0 时前端继续调用 */
  remaining: number;
}

export interface QrRegenerateResp {
  total: number;
  generated: number;
  failed: Array<{ id: number; reason: string }>;
}

// ---------- 报修 / 工单 ----------
/** 对应 POST /repair-requests（业主端）与 /repair-requests/office（后台） */
export interface RepairCreateReq {
  communityId: number;
  buildingId?: number;
  houseId?: number;
  addressText?: string;
  contactName?: string;
  contactPhone?: string;
  repairType?: string;
  /**
   * 端上自动判出来的类型。人当场改成别的时两者不一致，
   * 服务端据此记一条负样本，让判定越用越准（见 RepairTypeCorrection）。
   */
  predictedRepairType?: string;
  /** AI 草稿随最终提交带回，仅用于记录人工纠错 */
  aiAssist?: { sourceText: string; draft: Record<string, unknown> };
  /** 报修入口：AI 随手拍 / 完整表单，用于功能使用统计 */
  entryMode?: 'quick_ai' | 'form';
  content: string;
  attachments?: string[];
  /**
   * 按紧急处理。端上从描述里认出「急修 / 加急 / 抢修」就带 true，
   * 人点掉就带 false —— 不传时服务端会拿描述自己判（见 detectUrgency）。
   */
  urgent?: boolean;
}

/**
 * 缺料明细（工单快照与采购申请明细共用一套结构）。
 * materialId 有值 = 从材料库 SKU 选的；只有 name = 现场手填、等办公室建完 SKU 再回来关联。
 */
export interface MissingMaterialLine {
  materialId?: number;
  name: string;
  qty: number;
  unit?: string;
}

export interface WorkOrderListItem {
  /** 报修时拍的照片（只图片、最多 4 张），卡片上直接给缩略图 */
  photos?: string[];
  /** 图片总张数，卡片上「+N」按它算 */
  photoCount?: number;
  id: number;
  orderNo: string;
  status: WorkOrderStatus;
  requestId: number;
  communityId: number;
  assigneeId: number | null;
  /** 建单时实际收到“新工单待接”通知的维修工；空数组表示等待办公室派单 */
  candidateIds?: number[];
  skill: string | null;
  createdAt: string;
  dispatchedAt: string | null;
  acceptedAt: string | null;
  completedAt: string | null;
  slaDueAt: string | null;
  repairType?: string | null;
  /** 中文类型名。租户自建的类型（menjing 这种）端上查不到，一律用后端给的这个 */
  repairTypeLabel?: string | null;
  summaryAddress?: string | null;
  summaryContent?: string | null;
  /** 等待材料的单在工单池里要让人看见缺的是什么，到货了才知道能不能接 */
  missingMaterials?: MissingMaterialLine[];
  /**
   * 当前维修工姓名。派单台要的是「这单在谁手上」，光有 assigneeId 端上显示不出人名，
   * 而员工端拿不到 /staff（那是 users 页权限）。后端一并给出，未派单时为 null。
   */
  assigneeName?: string | null;
  /** 报修人（建单时落库的联系人）；工单池卡片「报修人」那一行用 */
  contactName?: string | null;
  /** 代报身份中文（保安 / 居委会…）；业主本人或员工提交时为 null */
  reporterRoleLabel?: string | null;
  /** 报修来源编码（owner_miniapp / staff_miniapp / office_web）及中文 */
  source?: string | null;
  sourceLabel?: string | null;
  /** 实际点击提交的人；可能与报修联系人不是同一个人 */
  submittedByName?: string | null;
  /** 报修时就说了「急修」：卡片标题前挂红色「紧急」标，工单池里排最前 */
  urgent?: boolean;
}

export interface RepairRequestView {
  id: number;
  communityId: number;
  buildingId: number | null;
  houseId: number | null;
  addressText: string | null;
  contactName: string | null;
  contactPhone: string | null;
  repairType: string | null;
  /** 中文类型名，由后端按租户配置给出 */
  repairTypeLabel?: string | null;
  content: string;
  attachments: string[];
  /** 报修时标的紧急（描述里说了「急修」，或报单的人自己勾的） */
  urgent?: boolean;
  submittedBy: number | null;
  createdAt: string;
}

export interface WorkOrderLogItem {
  id: number;
  fromStatus: WorkOrderStatus | null;
  toStatus: WorkOrderStatus;
  action: string;
  operatorId: number | null;
  note: string | null;
  createdAt: string;
}

/** 对应 GET /work-orders/:id */
export interface WorkOrderDetail {
  workOrder: WorkOrderListItem & {
    actionTags: string[];
    actionNote: string | null;
    resultAttachments: string[];
    feeCents: number;
    missingMaterials: MissingMaterialLine[];
    faultLocation: string | null;
    faultSymptom: string | null;
    repairContent: string | null;
    usedMaterials: UsedMaterialLine[];
  };
  request: RepairRequestView | null;
  logs: WorkOrderLogItem[];
  /** 已经从仓库领用并扣库的明细；与尚未提交的端上草稿分开。 */
  materialUsages?: WorkOrderMaterialUsageView[];
}

export interface WorkOrderMaterialUsageView {
  id: number;
  materialId: number;
  warehouseId: number;
  name: string;
  spec?: string | null;
  unit: string;
  qty: number;
  warehouseName: string;
  createdAt: string;
}

/**
 * 派单台可选的维修工。
 * 带上「手上还有几单」是派单时唯一真正需要的判断依据 —— 只给一串人名，
 * 办公室只能凭印象派，活全压在同一个人身上也看不出来。
 */
export interface TechnicianOption {
  /** 报修类型配置按管理处筛人时带上：all = 全公司范围，office = 只覆盖当前管理处；派单列表不带 */
  scope?: 'all' | 'office' | null;
  id: number;
  name: string;
  phone: string | null;
  /** 工种编码（后台给维修工配的技能），用于提示「这单是水的，他修水」 */
  skills: string[];
  /** 手上没完结的单数（已派单 + 维修中） */
  openCount: number;
}

export interface AssignWorkOrderReq {
  assigneeId: number;
  skill?: string;
  /** 要求完成时限（小时），不传则沿用工单原有的 slaDueAt */
  slaHours?: number;
  note?: string;
}

/** 完工时的用料一行。带 warehouseId = 从库存领的，后端会真的扣库存并记出库流水 */
export interface UsedMaterialLine {
  materialId?: number;
  warehouseId?: number;
  name?: string;
  qty: number;
  unit?: string;
  /** 用料备注，会原样印到养护单背面《材料领耗记录》的备注格 */
  note?: string;
}

export interface CompleteWorkOrderReq {
  actionTags?: string[];
  actionNote?: string;
  resultAttachments?: string[];
  faultLocation?: string;
  faultSymptom?: string;
  repairContent?: string;
  /** 收费金额（分）。一期只记账，不做支付 */
  feeCents?: number;
  materials?: UsedMaterialLine[];
  /** 命中的收费规则编码，只做审计，不会覆盖 feeCents */
  feeRuleCode?: string;
  /** AI 草稿随最终提交带回，仅用于记录人工纠错 */
  aiAssist?: { sourceText: string; draft: Record<string, unknown> };
}

// ---------- 报修类型 / 状态文案（前后台与小程序共用） ----------
export const REPAIR_TYPE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'water', label: '水相关' },
  { value: 'electric', label: '电相关' },
  { value: 'door_window', label: '家里门锁/门窗相关' },
  { value: 'appliance', label: '家电/设备相关' },
  { value: 'elevator', label: '电梯相关' },
  { value: 'smart', label: '智能化相关' },
  { value: 'public', label: '公共设施相关' },
  { value: 'other', label: '其它' },
];

export const REPAIR_TYPE_LABELS: Record<string, string> = REPAIR_TYPE_OPTIONS.reduce(
  (acc, item) => {
    acc[item.value] = item.label;
    return acc;
  },
  {} as Record<string, string>,
);

export const WORK_ORDER_STATUS_LABELS: Record<WorkOrderStatus, string> = {
  [WorkOrderStatus.CREATED]: '待派单',
  [WorkOrderStatus.DISPATCHED]: '已派单',
  [WorkOrderStatus.IN_PROGRESS]: '维修中',
  [WorkOrderStatus.WAITING_MATERIAL]: '等待材料',
  [WorkOrderStatus.DONE_PENDING_REVIEW]: '待验收',
  [WorkOrderStatus.COMPLETED]: '已完成',
  [WorkOrderStatus.CANCELLED]: '已撤单',
};

/**
 * 工单类型 / 要求完成截止日期只允许在「待维修阶段」（待派单、已派单）改。
 * 维修工一开工就按类型领了料、按截止排了班，事后再改会让轨迹和统计对不上号，
 * 所以后台详情里这两项过了这个阶段就置灰（2026-08-26 要求）。
 * 服务端同名规则在 apps/api/src/common/enums.ts，两边要一起改。
 */
export const REPAIR_TYPE_AND_SLA_EDITABLE_STATUSES: WorkOrderStatus[] = [
  WorkOrderStatus.CREATED,
  WorkOrderStatus.DISPATCHED,
];
export function canEditRepairTypeAndSla(status: WorkOrderStatus): boolean {
  return REPAIR_TYPE_AND_SLA_EDITABLE_STATUSES.includes(status);
}
/** 置灰时给用户看的原因（别静默隐藏）；可改时返回 null */
export function repairTypeAndSlaLockReason(status: WorkOrderStatus): string | null {
  if (canEditRepairTypeAndSla(status)) return null;
  return status === WorkOrderStatus.COMPLETED || status === WorkOrderStatus.CANCELLED
    ? '工单已完结，不能再修改'
    : '已开始维修，不能再修改';
}

// ---------- 材料 / 库存 ----------

/** 材料类别（决定 SKU 编码前缀），后台与小程序共用 */
/**
 * 材料类别的**内置种子**，只用于两件事：新公司第一次打开时种进档案、
 * 以及接口还没返回时的兜底占位。
 *
 * **不要再拿它当下拉数据源** —— 类别在后台「库存与采购 → 基础资料 → 材料类别」
 * 可以增删改（2026-09-01 起），真值在服务端 GET /material-categories。
 * 往这里加类别只对还没种过的新公司生效。
 */
export const MATERIAL_CATEGORIES: string[] = [
  '卫生', '电器', '化工', '黑色', '有色', '水料',
  '木料', '五金', '工具', '防护用品', '防台防汛', '低值易耗品',
];

/** 材料类别档案。code = SKU 编码前缀（五金 → WJ-0001），下发过编码后不可改 */
export interface MaterialCategoryView {
  id: number;
  /** 编码前缀，2~4 位大写字母 */
  code: string;
  /** 类别名称，materials.category 存的就是它 */
  label: string;
  sortOrder: number;
  enabled: boolean;
  /** 这个类别下有几条材料：>0 时不给删，只能停用 */
  materialCount: number;
}

/**
 * 材料计量单位。分组只影响下拉展示，存库仍是单位本身的字符串。
 * 不在表里的单位允许自己填（老数据里有「延米」这类）。
 */
export const MATERIAL_UNIT_GROUPS: Array<{ label: string; units: string[] }> = [
  {
    label: '计数',
    units: ['个', '只', '件', '套', '台', '组', '副', '对', '双', '把', '根', '条', '支', '片', '块', '张'],
  },
  { label: '长度 / 面积', units: ['米', '厘米', '平方米'] },
  { label: '重量 / 容积', units: ['公斤', '克', '升'] },
  { label: '包装', units: ['包', '袋', '箱', '盒', '桶', '瓶', '卷', '捆', '管'] },
];

export const MATERIAL_UNITS: string[] = MATERIAL_UNIT_GROUPS.flatMap((group) => group.units);

export interface MaterialView {
  id: number;
  code: string;
  name: string;
  spec?: string | null;
  category?: string | null;
  unit: string;
  defaultCostCents: number;
  /** 第一张实物照片（列表缩略图用）；由服务端从 photoUrls[0] 同步 */
  photoUrl?: string | null;
  /** 实物照片全集，最多 4 张；点开大图要把整个数组交给预览器才能左右滑 */
  photoUrls?: string[];
  aliases?: string[];
  params?: string | null;
  enabled: boolean;
}

/**
 * 材料选择器用的精简 SKU（GET /materials/options）。
 * 维修工要在缺料登记里挑材料，但不该看到成本，所以单独一份不含 defaultCostCents 的视图。
 */
export interface MaterialOption {
  id: number;
  code: string;
  name: string;
  spec?: string | null;
  category?: string | null;
  unit: string;
  photoUrl?: string | null;
  photoUrls?: string[];
  aliases?: string[];
}

/**
 * 「添加用料」的选料项：本小区仓里这个材料还有多少。
 * qty=0 也返回 —— 仓里没有正是要走缺料登记的场景，列表里看不到会让人以为系统里没这东西。
 */
export interface WorkOrderStockOption {
  materialId: number;
  code: string;
  name: string;
  spec?: string | null;
  category?: string | null;
  unit: string;
  photoUrl?: string | null;
  photoUrls?: string[];
  aliases?: string[];
  qty: number;
}

/** 这张工单能去领料的仓库之一 */
export interface WorkOrderStockWarehouse {
  id: number;
  name: string;
  type: WarehouseType;
  /** 本次自动选中的默认仓（工种专属仓优先，其次是工单所属管理处仓） */
  own: boolean;
  /** 这个仓里至少有一样东西有货，端上用来提示「换那个仓有货」 */
  hasStock: boolean;
}

export interface WorkOrderStockOptions {
  /** 当前这份清单出自哪个仓；没配且没手动切时为 null */
  warehouseId: number | null;
  warehouseName: string;
  /** 本单报修类型（提示「哪个类型没配仓库」要用） */
  repairType: string | null;
  repairTypeLabel: string;
  /** 这个「小区 + 类型」在后台配过领料仓库没有 */
  configured: boolean;
  /** 可手动切换的仓库，配好的那个排最前 */
  warehouses: WorkOrderStockWarehouse[];
  items: WorkOrderStockOption[];
}

/** 「小区 + 报修类型 → 领料仓库」一条配置 */
export interface WarehouseView {
  id: number;
  name: string;
  type: WarehouseType;
  communityId?: number | null;
  /** 所属管理处；空 = 公司级。员工端按自己角色范围对应的管理处挑默认仓 */
  officeId?: number | null;
  /** 管理处名 / 小区名由服务端带出，端上不要再存一份字典 */
  officeName?: string | null;
  communityName?: string | null;
  /** 仓库配的默认入库库位；入库表单选了仓就带出来 */
  defaultLocationId?: number | null;
  enabled: boolean;
  /** 当前用户的工种专属默认仓；员工端库存页优先选中。 */
  preferred?: boolean;
}

/** 仓库里的一个库位（货架格），入库时选存放位置 */
export interface WarehouseLocationView {
  id: number;
  warehouseId: number;
  zone?: string | null;
  shelf?: string | null;
  bin?: string | null;
  label: string;
  enabled: boolean;
}

export interface StockView {
  id: number;
  warehouseId: number;
  materialId: number;
  qty: string | number;
  safetyQty: string | number;
  /** 剩余批次数量（不含老库存兜底），GET /stocks 附带 */
  lotQty?: number;
  /** 剩余批次金额（分） */
  lotValueCents?: number;
  /** 单位成本（分）：有批次按批次加权，没有退回 SKU 参考成本 */
  unitCostCents?: number;
  costSource?: 'lot' | 'default';
  /** 该行库存金额（分）= 数量 × 单位成本 */
  amountCents?: number;
}

/** 库存批次：同一材料不同入库单价分批追踪，出库先进先出 */
export interface StockLotView {
  id: number;
  warehouseId: number;
  materialId: number;
  lotNo: string;
  initialQty: string | number;
  remainingQty: string | number;
  unitCostCents: number;
  supplierId?: number | null;
  purchaseOrderId?: number | null;
  goodsReceiptId?: number | null;
  /** goods_receipt 采购入库 / general_receipt 一般入库 / transfer_order 调拨入库 / stock_adjust 盘盈 / legacy_stock 老库存兜底 */
  sourceType?: string | null;
  sourceId?: number | null;
  receivedAt: string;
}

export interface StockMovementView {
  id: number;
  warehouseId: number;
  materialId: number;
  /** inbound / outbound / transfer / adjust */
  type: string;
  /** 正数入库 / 负数出库 */
  qty: string | number;
  unitCostCents: number;
  refType?: string | null;
  refId?: number | null;
  /** 来源单据号（入库单号 / 调拨单号 / 工单号），服务端下发；界面上显示它而不是 refId */
  refNo?: string | null;
  note?: string | null;
  createdAt?: string;
  createdBy?: number | null;
}

// ---------- 库存盘点 ----------

export type StocktakeStatus = 'counting' | 'submitted' | 'approved' | 'rejected' | 'cancelled';

export const STOCKTAKE_STATUS_LABELS: Record<StocktakeStatus, string> = {
  counting: '盘点中',
  submitted: '待复核',
  approved: '已完成',
  rejected: '已退回',
  cancelled: '已取消',
};

export const STOCKTAKE_REASON_OPTIONS = [
  { value: 'unregistered_usage', label: '领用未登记' },
  { value: 'unregistered_inbound', label: '入库未登记' },
  { value: 'damaged', label: '破损报废' },
  { value: 'expired', label: '过期报废' },
  { value: 'misplaced', label: '库位放错' },
  { value: 'counting_error', label: '上次盘点有误' },
  { value: 'other', label: '其他' },
] as const;

export interface StocktakeTaskView {
  id: number;
  taskNo: string;
  title: string;
  warehouseId: number;
  warehouseName: string;
  status: StocktakeStatus;
  totalCount: number;
  countedCount: number;
  differenceCount: number;
  snapshotAt: string;
  submittedAt?: string | null;
  reviewedAt?: string | null;
  reviewerId?: number | null;
  reviewNote?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StocktakeItemView {
  id: number;
  taskId: number;
  materialId: number;
  locationId?: number | null;
  locationLabel?: string | null;
  bookQty: number;
  actualQty: number | null;
  differenceQty: number | null;
  reasonCode?: string | null;
  note?: string | null;
  attachments: string[];
  countedBy?: number | null;
  countedAt?: string | null;
  material: {
    id: number;
    code: string;
    name: string;
    spec?: string | null;
    category?: string | null;
    unit: string;
    photoUrl?: string | null;
    aliases?: string[];
  };
}

export interface StocktakeDetailView extends StocktakeTaskView {
  items: StocktakeItemView[];
}

// ---------- 采购 ----------
export interface PurchaseRequestItem {
  /** 合并后仍保持稳定的行标识，用于单项驳回和修改重提 */
  lineId?: string;
  materialId?: number;
  name: string;
  qty: number;
  /** 单位随缺料登记一起带过来：「阀芯 ×2」和「阀芯 ×2 套」采购起来不是一回事 */
  unit?: string;
  estUnitCostCents?: number;
  sourceRequestId?: number;
  sourceRequestNo?: string;
  sourceWorkOrderId?: number | null;
  sourceWorkOrderNo?: string | null;
  rejectReason?: string;
  rejectedAtStage?: 'manager' | 'purchaser';
}

export interface PurchaseRequestView {
  id: number;
  requestNo: string;
  workOrderId: number | null;
  /** 来源工单的工单号，服务端下发；界面上显示它而不是 workOrderId */
  workOrderNo?: string | null;
  /** 合并表格的全部来源，不再只显示主单那一张 */
  sourceRequestNos?: string[];
  sourceWorkOrderNos?: string[];
  applicantId: number;
  /** 申请人 / 两位审批人的姓名，服务端下发 —— 端上不要拿 id 顶着显示 */
  applicantName?: string | null;
  managerName?: string | null;
  purchaserName?: string | null;
  items: PurchaseRequestItem[];
  estTotalCents: number;
  status: PurchaseRequestStatus;
  managerId: number | null;
  managerAt: string | null;
  purchaserId: number | null;
  purchaserAt: string | null;
  rejectReason?: string | null;
  createdAt: string;
}

export const PURCHASE_STATUS_LABELS: Record<PurchaseRequestStatus, string> = {
  [PurchaseRequestStatus.DRAFT]: '草稿',
  [PurchaseRequestStatus.OFFICE_REVIEW]: '办公室汇总',
  [PurchaseRequestStatus.MANAGER_REVIEW]: '待经理审批',
  [PurchaseRequestStatus.PURCHASER_REVIEW]: '待采购审批',
  [PurchaseRequestStatus.APPROVED]: '已批准',
  [PurchaseRequestStatus.REJECTED]: '已驳回',
  [PurchaseRequestStatus.MERGED]: '已合并',
  [PurchaseRequestStatus.DONE]: '已完成',
};

/**
 * 员工端「审批」页要处理哪一批单，取决于他手上有哪一步的审批权：
 * 勾了「采购审批（经理这一步）」就看待经理审的，勾了采购那一步就看待采购确认的。
 */
export const PENDING_STATUS_BY_APP_PAGE: Record<string, PurchaseRequestStatus> = {
  'app:approve-manager': PurchaseRequestStatus.MANAGER_REVIEW,
  'app:approve-purchaser': PurchaseRequestStatus.PURCHASER_REVIEW,
};

// ---------- 字典 ----------
export interface DictItem {
  id: string;
  type: DictType;
  code: string;
  name: string;
  sort: number;
}

export * from './address';
export * from './repair-classify';
export * from './pages';
export * from './fees';
export * from './voice-extract';
export * from './urgency';

// ---------- 停留时长 ----------

/** ISO / 'YYYY-MM-DD HH:mm:ss' 都能解析；解析不了返回 null */
function parseTime(value?: string | null): Date | null {
  if (!value) return null;
  let d = new Date(value);
  if (isNaN(d.getTime())) d = new Date(String(value).replace(/-/g, '/'));
  return isNaN(d.getTime()) ? null : d;
}

/**
 * 工单已停留几天：从业主提交那一刻算起，**按自然日跨天数**，
 * 当天 = 0 天，隔一天 = 1 天。不是 24 小时制 —— 早上 9 点报的和晚上 11 点报的，
 * 第二天早上都该算「停留 1 天」，按小时折算会让同一天报的单显示不一样。
 * 与有没有接单无关：业主感知到的等待就是从他提交那一刻开始的。
 */
export function stayDays(from?: string | null, now: Date = new Date()): number {
  const start = parseTime(from);
  if (!start) return 0;
  const a = new Date(start.getFullYear(), start.getMonth(), start.getDate()).getTime();
  const b = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return Math.max(0, Math.round((b - a) / 86400000));
}

/** 停留天数的提示级别：0-1 天正常，2 天提醒，3 天及以上要显眼 */
export type StayTone = 'normal' | 'warn' | 'danger';

export function stayTone(days: number): StayTone {
  if (days >= 3) return 'danger';
  if (days >= 2) return 'warn';
  return 'normal';
}

/** 「已停留 2 天」；当天也照常显示 0 天，让人知道确实在计时 */
export function stayDaysText(from?: string | null, now: Date = new Date()): string {
  return `已停留 ${stayDays(from, now)} 天`;
}

/**
 * 两个时间点之间的间隔，用于「这个节点停了多久」。
 * 不足 1 分钟显示「不到 1 分钟」，免得一堆「0 分钟」看着像没记录。
 */
export function formatDuration(fromIso?: string | null, toIso?: string | null): string {
  const from = parseTime(fromIso);
  const to = toIso ? parseTime(toIso) : new Date();
  if (!from || !to) return '';
  const ms = to.getTime() - from.getTime();
  if (ms < 0) return '';
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return '不到 1 分钟';
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const restMin = minutes % 60;
    return restMin ? `${hours} 小时 ${restMin} 分钟` : `${hours} 小时`;
  }
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours ? `${days} 天 ${restHours} 小时` : `${days} 天`;
}

/** 星期几，进度时间轴里用 —— 物业和业主对「周几」比对日期敏感 */
const WEEKDAY_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/**
 * 进度节点的时间：`2026/8/9 17:07 周日`。
 * 月/日不补零（读起来更接近口语），时分补零对齐；带星期，
 * 「周五报的、周一才派单」这种拖延一眼就看得出来。
 * web 与两个小程序都用这一个函数，不要各写各的格式。
 */
export function formatDateTimeCn(value?: string | null): string {
  const d = parseTime(value);
  if (!d) return '';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm} ${WEEKDAY_CN[d.getDay()]}`;
}

/** 报修附件的数量上限：三端同一份，别再各写一套（后台原来自己定义了一份） */
export const MAX_REPAIR_IMAGES = 6;
export const MAX_REPAIR_VIDEOS = 1;
/** 现场短视频的时长上限（秒）：拍太长上传慢、维修工也不会看完 */
export const MAX_REPAIR_VIDEO_SECONDS = 15;

/**
 * 附件是不是视频 —— 只能按扩展名判，因为存下来的就是一个 URL。
 * 判断口径的唯一出处：后台、业主端、员工端都引这里，
 * 否则「后台认得出是视频、小程序把它当图片渲染成一片黑」这种事迟早发生。
 */
export function isVideoUrl(value?: string | null): boolean {
  return /\.(mp4|mov|m4v|webm|avi|mkv)(\?|#|$)/i.test(String(value || ''));
}

/**
 * 卡片列表里的短日期：08/24 22:44。
 * 不带年份和星期 —— 列表卡是一行一行扫的，一行只有一个「值」的宽度，
 * 完整格式（2026/8/24 22:44 周一）再拼上「已等 N 天」必然折行，
 * 折一次这一行就断成两截，整齐就没了。详情页和时间轴仍然用完整格式。
 */
export function formatDateShortCn(value?: string | null): string {
  const d = parseTime(value);
  if (!d) return '';
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${mo}/${dd} ${hh}:${mm}`;
}

/**
 * 「猜你想输」的兜底词表。后台和小程序共用这一份 ——
 * 只在这里改一次，两端就同步了，不会出现后台加了词小程序还是老几个。
 */
/**
 * 「具体位置」的快捷词。前半是楼里/小区里的方位，后半是公区房间 ——
 * 监控室、水泵房这类地方没有房号，报修描述里说了也认不出地址，
 * 点一下写进「具体位置」，维修工才知道去哪（点位登记在后台「公区点位」里，
 * 登记过的还能被描述直接认出来）。
 */
export const DEFAULT_LOCATION_SUGGESTIONS = [
  '大门',
  '4楼电梯口',
  '3楼楼梯',
  '地下车库',
  '楼道',
  '单元门口',
  '监控室',
  '门卫室',
  '水泵房',
  '电梯机房',
  '垃圾房',
  '配电间',
];

export const DEFAULT_CONTENT_SUGGESTIONS = [
  '水管漏水',
  '灯不亮',
  '门锁打不开',
  '电梯故障',
  '下水道堵塞',
  '墙面渗水',
];
