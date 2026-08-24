/** 用户角色 */
export enum UserRole {
  OWNER = 'owner', // 业主
  GUARD = 'guard', // 保安
  NEIGHBORHOOD = 'neighborhood', // 居委会
  OWNER_COMMITTEE = 'owner_committee', // 业委会
  PROPERTY_STAFF = 'property_staff', // 物业工作人员（只用业主端报修，不进后台）
  TECHNICIAN = 'technician', // 维修工
  OFFICE = 'office', // 物业办公室
  MANAGER = 'manager', // 物业经理
  PURCHASER = 'purchaser', // 采购经理
  ADMIN = 'admin', // 物业管理员（租户超管）
  SUPERADMIN = 'superadmin', // 平台管理员（开发方运营）
}

/**
 * 社区代报角色：不是业主、也不在物业编制内，但在小区里跑动，
 * 常常替住户报修（保安发现楼道灯坏、居委会接到老人电话、业委会巡查）。
 * 他们用业主端小程序，但报修位置不受「自己家」约束 ——
 * 能报哪些小区由 user_report_communities 逐条授权，不是全域放行。
 */
export const REPORTER_ROLES: UserRole[] = [
  UserRole.GUARD,
  UserRole.NEIGHBORHOOD,
  UserRole.OWNER_COMMITTEE,
  UserRole.PROPERTY_STAFF,
];

/** 走业主端小程序登录的角色（业主 + 代报角色） */
export const OWNER_APP_ROLES: UserRole[] = [UserRole.OWNER, ...REPORTER_ROLES];

/**
 * 走员工端小程序（邻修管理）登录的角色。
 * 员工也能在员工端报修（发现楼道灯坏了顺手提单），位置不受「自己家」约束。
 */
export const STAFF_APP_ROLES: UserRole[] = [
  UserRole.TECHNICIAN,
  UserRole.OFFICE,
  UserRole.MANAGER,
  UserRole.PURCHASER,
  UserRole.ADMIN,
];

/** 角色中文名。工单详情、账号管理都直接展示，不能露枚举值 */
export const USER_ROLE_LABELS: Record<string, string> = {
  [UserRole.OWNER]: '业主',
  [UserRole.GUARD]: '保安',
  [UserRole.NEIGHBORHOOD]: '居委会',
  [UserRole.OWNER_COMMITTEE]: '业委会',
  [UserRole.PROPERTY_STAFF]: '物业工作人员',
  [UserRole.TECHNICIAN]: '维修工',
  [UserRole.OFFICE]: '物业办公室',
  [UserRole.MANAGER]: '物业经理',
  [UserRole.PURCHASER]: '采购经理',
  [UserRole.ADMIN]: '物业管理员',
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
  WX_SUBSCRIBE = 'wx_subscribe', // 微信小程序订阅消息
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
