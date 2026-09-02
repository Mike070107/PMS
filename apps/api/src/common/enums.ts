/**
 * 用户属于哪个端。**不再表达「他在物业里干哪一行」** ——
 * 那件事 2026-08-26 起完全由角色的权限矩阵决定（见 common/pages.ts）。
 *
 * 早先这里有 technician / office / manager / purchaser / guard… 一长串，
 * 接口按它 @Roles 把关、端上按它决定看到哪几格。结果后台改了角色，
 * 小程序纹丝不动 —— 因为那是另一条轨。现在只剩「哪个端」这一件事：
 *   owner      业主端小程序（邻修管家）
 *   staff      员工端小程序 + 网站后台，能干什么全看他绑的角色
 *   superadmin 平台运营（tenant_id 为 null）
 */
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

/** 业主入驻审核状态 */
export enum AuditStatus {
  PENDING = 'pending',
  APPROVED = 'approved',
  REJECTED = 'rejected',
}

/** 用户账号状态 */
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
  /** 从老收费系统（吴泾物业 MySQL 库）整批导入的存量业主档案 */
  LEGACY_IMPORT = 'legacy_import',
}

/** 二维码粒度 */
export enum QrGranularity {
  COMMUNITY = 'community', // 小区码
  BUILDING = 'building', // 楼栋/单元码
}

/**
 * 工单状态机
 * created → dispatched → in_progress → done_pending_review → completed
 *                            ↑      ↘ waiting_material（缺料登记，同时退回工单池）
 *                            └──────────┘ 材料到货后重新派单 / 维修工自行接回
 * 旁路：cancelled
 */
export enum WorkOrderStatus {
  CREATED = 'created', // 已提交（待派单池）
  DISPATCHED = 'dispatched', // 已派单
  IN_PROGRESS = 'in_progress', // 维修中
  WAITING_MATERIAL = 'waiting_material', // 等待材料（无负责人，在工单池里等材料）
  DONE_PENDING_REVIEW = 'done_pending_review', // 待业主验收
  COMPLETED = 'completed', // 已完成
  CANCELLED = 'cancelled', // 已撤单
}

/** 报修来源 */
export enum RepairSource {
  OWNER_MINIAPP = 'owner_miniapp', // 业主小程序（邻修管家）
  STAFF_MINIAPP = 'staff_miniapp', // 员工小程序（邻修管理），员工巡查顺手报修
  OFFICE_WEB = 'office_web', // 物业办公室录入
}

/** 报修来源的中文说法：进度时间轴、工单详情都直接展示给业主，不能露枚举值 */
export const REPAIR_SOURCE_LABELS: Record<string, string> = {
  [RepairSource.OWNER_MINIAPP]: '业主小程序提交',
  [RepairSource.STAFF_MINIAPP]: '员工小程序提交',
  [RepairSource.OFFICE_WEB]: '物业办公室登记',
};

/** 仓库类型 */
export enum WarehouseType {
  CENTRAL = 'central', // 总仓
  COMMUNITY = 'community', // 小区仓
  OFFICE = 'office', // 管理处仓：新建管理处时自动建的同名仓，挂 office_id 不挂小区
}

/** 库存流水类型 */
export enum StockMovementType {
  INBOUND = 'inbound', // 采购入库
  OUTBOUND = 'outbound', // 工单领料出库
  TRANSFER = 'transfer', // 调拨
  ADJUST = 'adjust', // 盘点调整
}

/**
 * 调拨单状态机
 * pending_review（待经理审批）→ approved（已审批/在途，发货仓已扣减）→ received（接收仓按实收入库，完成）
 * 旁路：rejected（经理驳回）
 */
export enum TransferOrderStatus {
  PENDING_REVIEW = 'pending_review',
  APPROVED = 'approved',
  RECEIVED = 'received',
  REJECTED = 'rejected',
}

/**
 * 盘点单状态机
 * counting（盘点中，可分批保存实盘数）→ pending_review（待经理审核）→ approved（已过账）
 * 旁路：审核退回 → 回到 counting 继续改（盘一个仓几百条，不能一驳全重来）；
 *       counting 可作废（cancelled）—— 同一个仓同时只允许一张在途盘点单，
 *       废单不作废掉会把下一次盘点堵死。
 */
export enum StocktakeOrderStatus {
  COUNTING = 'counting',
  PENDING_REVIEW = 'pending_review',
  APPROVED = 'approved',
  CANCELLED = 'cancelled',
}

/**
 * 采购申请状态（四级链路）
 * office_review（办公室汇总合并）→ manager_review（物业经理）→ purchaser_review（采购经理）→ approved（待下单）→ done
 * 旁路：rejected、merged（被合并进其他申请）
 */
export enum PurchaseRequestStatus {
  DRAFT = 'draft',
  OFFICE_REVIEW = 'office_review', // 待物业办公室汇总合并
  MANAGER_REVIEW = 'manager_review', // 待物业经理审批
  PURCHASER_REVIEW = 'purchaser_review', // 待采购经理审批
  APPROVED = 'approved', // 审批通过待下单
  REJECTED = 'rejected',
  MERGED = 'merged', // 已被合并进其他申请单
  DONE = 'done', // 已下单/已入库完成
}

/** 采购单状态 */
export enum PurchaseOrderStatus {
  PLACED = 'placed', // 已下单
  PARTIAL = 'partial', // 部分到货
  RECEIVED = 'received', // 已收货
  CLOSED = 'closed',
}

/** 通知渠道 */
export enum NotifyChannel {
  WX_SUBSCRIBE = 'wx_subscribe', // 微信小程序订阅消息（同意一次推一条）
  WX_SERVICE = 'wx_service', // 微信服务号模板消息（关注即可一直推，员工侧优先走它）
  IN_APP = 'in_app', // 站内消息（降级兜底）
}

/** 通知发送状态 */
export enum NotifyStatus {
  PENDING = 'pending',
  SENT = 'sent',
  FAILED = 'failed',
  FALLBACK = 'fallback', // 订阅余量不足，降级为站内消息
}

/** 字典类型 */
export enum DictType {
  SKILL = 'skill', // 工种
  REPAIR_TYPE = 'repair_type', // 报修类型
  REPAIR_COMMON_TAG = 'repair_common_tag', // 常用报修标签
  REPAIR_ACTION_TAG = 'repair_action_tag', // 维修动作标签
  MATERIAL_CATEGORY = 'material_category', // 材料分类
}

/** 前台可办理的收费业务类型 */
export enum BusinessServiceType {
  PARKING_MONTHLY = 'parking_monthly', // 停车月租
  ACCESS_CARD = 'access_card', // 门禁卡购买/补卡
}

/** 收费规则计价单位 */
export enum BusinessBillingUnit {
  MONTH = 'month',
  CARD = 'card',
}

/** 业务办理单状态 */
export enum BusinessTransactionStatus {
  PAID = 'paid',
  CANCELLED = 'cancelled',
}

/**
 * 物业费账单状态（与 packages/shared-types/src/fees.ts 同源）。
 * unpaid → paid（登记收款）；paid → unpaid（撤销收款）/ refunded（退款）；
 * unpaid → cancelled（作废，误生成/免收）→ unpaid（恢复）。
 */
export enum FeeBillStatus {
  UNPAID = 'unpaid',
  PAID = 'paid',
  REFUNDED = 'refunded',
  CANCELLED = 'cancelled',
}

/** 账单是怎么来的：老系统导入 / 按收费标准生成 / 后台手工录入 */
export enum FeeBillSource {
  LEGACY_IMPORT = 'legacy_import',
  GENERATED = 'generated',
  MANUAL = 'manual',
}

/** 每户收费标准的状态：当前生效 / 已被新标准替代（留作历史） */
export enum FeeStandardStatus {
  ACTIVE = 'active',
  HISTORY = 'history',
}

/**
 * 费用项目预置表。code 存库，name 随单快照 —— 同一 code 各公司叫法不同也不影响历史账单。
 * 来源是吴泾物业老系统的 setupsfxm（管理费/租金/保洁保安费…），其它公司沿用即可，
 * 不够用时加一行，**已上线的 code 不要改**。
 */
export const FEE_ITEMS: ReadonlyArray<{ code: string; name: string }> = [
  { code: 'management', name: '物业管理费' },
  { code: 'rent', name: '租金' },
  { code: 'clean_guard', name: '保洁保安费' },
  { code: 'guard', name: '保安费' },
  { code: 'clean', name: '保洁费' },
  { code: 'parking', name: '泊位费' },
  { code: 'temp_parking', name: '临时停车费' },
  { code: 'network', name: '网络费' },
  { code: 'water', name: '水费' },
  { code: 'electricity', name: '电费' },
  { code: 'locker', name: '快递柜费' },
  { code: 'vacant_rent', name: '空房租金' },
  { code: 'other', name: '其他' },
];

export const FEE_ITEM_CODES: string[] = FEE_ITEMS.map((item) => item.code);

export function feeItemName(code: string): string {
  return FEE_ITEMS.find((item) => item.code === code)?.name ?? code;
}
