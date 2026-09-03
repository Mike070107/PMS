import { Entity, Column, Index } from 'typeorm';
import { TenantEntity } from '../common/base.entity';

/**
 * 养护单（《房屋修理养护任务单》）的一条查勘修理项目。
 * 纸张正面只有 4 行，超过 4 条会再印一张（前端分页，数据不受此限制）。
 */
export interface MaintenanceItem {
  /** 查勘部位 */
  part: string;
  /** 查勘修理项目 */
  name: string;
  /** 查勘数量 */
  surveyQty: number | null;
  /** 实做数量 */
  actualQty: number | null;
  /** 实做工时 */
  actualHours: number | null;
  /** 量方数量 */
  measureQty: number | null;
  /** 预算定额编号（quota_items.code 的快照，改配置不动已开的单） */
  quotaCode: string;
  /** 预算定额工时 */
  quotaHours: number | null;
  /** 人工费（分） */
  laborFeeCents: number | null;
  /** 材料费（分） */
  materialFeeCents: number | null;
  /** 质量验收 */
  quality: string;
  /** 备注 */
  note: string;
}

/**
 * 养护单背面《材料领耗记录》的一行。
 * 数据来自工单用料（work_order_materials + work_orders.used_materials），
 * 落单时快照下来 —— 库存成本之后还会变，纸面上的金额不能跟着变。
 */
export interface MaintenanceMaterial {
  name: string;
  spec: string;
  unit: string;
  /** 估料数量 */
  estQty: number | null;
  /** 领料数量 */
  pickQty: number | null;
  /** 实耗数量 */
  usedQty: number | null;
  /** 退料数量 */
  returnQty: number | null;
  /** 实耗金额（分） */
  amountCents: number | null;
  /** 备注（来源：工单用料备注） */
  note: string;
}

export const MAINTENANCE_STATUS = {
  /** Web 端刚从工单开出，办公室正在核对表单 */
  FILLING: 'filling',
  /** 已推送，只允许填单人签字 */
  WAITING_FILLER: 'waiting_filler',
  /** 填单人已签，只允许修理人签字 */
  WAITING_REPAIRER: 'waiting_repairer',
  /** 修理人已签，只允许查验员签字 */
  WAITING_INSPECTOR: 'waiting_inspector',
  /** 三方签字完成，等办公室打印 */
  PENDING_PRINT: 'pending_print',
  /** 已打印归档 */
  COMPLETED: 'completed',
  /** 作废 */
  VOID: 'void',
} as const;

export type MaintenanceStatus =
  (typeof MAINTENANCE_STATUS)[keyof typeof MAINTENANCE_STATUS];

/**
 * 养护单：一张工单对应一张（《房屋修理养护任务单》正反面）。
 *
 * 它是**纸面单据的快照**，不是工单的视图：
 * 开单那一刻把工单上的地址、人、日期、用料抄下来，之后工单再改也不动它 ——
 * 纸已经打出来签过字了，系统里的字段跟着变会对不上账。
 */
@Entity('maintenance_orders')
@Index(['tenantId', 'status'])
// 一张工单同时只有一张有效养护单；作废的那张不占位，可以重新开
@Index(['tenantId', 'workOrderId'], { unique: true, where: "status <> 'void'" })
@Index(['orderNo'], { unique: true })
export class MaintenanceOrder extends TenantEntity {
  /** 系统单号 YH-YYYYMMDD-XXXX */
  @Column({ name: 'order_no', type: 'varchar', length: 40 })
  orderNo: string;

  /** 纸质联单上预印的号码（如 0119524），手工回填，打印时优先用它 */
  @Column({ name: 'paper_no', type: 'varchar', length: 40, nullable: true })
  paperNo: string | null;

  @Column({ name: 'work_order_id', type: 'int' })
  workOrderId: number;

  @Column({ name: 'work_order_no', type: 'varchar', length: 40, nullable: true })
  workOrderNo: string | null;

  @Column({ name: 'request_id', type: 'int', nullable: true })
  requestId: number | null;

  @Column({ name: 'community_id', type: 'int' })
  communityId: number;

  @Column({ type: 'varchar', length: 24, default: MAINTENANCE_STATUS.FILLING })
  status: MaintenanceStatus;

  // ===== 表头 =====
  /** 管房单位（管理处名，没划管理处时用小区名） */
  @Column({ name: 'unit_name', type: 'varchar', length: 120, nullable: true })
  unitName: string | null;

  @Column({ name: 'reporter_name', type: 'varchar', length: 60, nullable: true })
  reporterName: string | null;

  // 地址在纸上是「__村 __路 __弄 __号 __室」五格，分开存才能各归各位
  @Column({ name: 'addr_village', type: 'varchar', length: 60, nullable: true })
  addrVillage: string | null;

  @Column({ name: 'addr_road', type: 'varchar', length: 60, nullable: true })
  addrRoad: string | null;

  @Column({ name: 'addr_lane', type: 'varchar', length: 30, nullable: true })
  addrLane: string | null;

  @Column({ name: 'addr_building_no', type: 'varchar', length: 30, nullable: true })
  addrBuildingNo: string | null;

  @Column({ name: 'addr_room', type: 'varchar', length: 30, nullable: true })
  addrRoom: string | null;

  /** 报修日期 */
  @Column({ name: 'reported_on', type: 'date', nullable: true })
  reportedOn: string | null;

  /** 有人时间（住户在家的时段，手填） */
  @Column({ name: 'present_time', type: 'varchar', length: 60, nullable: true })
  presentTime: string | null;

  @Column({ name: 'fault_part', type: 'varchar', length: 120, nullable: true })
  faultPart: string | null;

  @Column({ name: 'repair_item', type: 'varchar', length: 120, nullable: true })
  repairItem: string | null;

  @Column({ name: 'appoint_on', type: 'date', nullable: true })
  appointOn: string | null;

  @Column({ name: 'start_on', type: 'date', nullable: true })
  startOn: string | null;

  @Column({ name: 'finish_on', type: 'date', nullable: true })
  finishOn: string | null;

  // ===== 三组勾选：部位 / 费用类别 / 分摊方式 =====
  /** self 自用部位 / shared 共用部位 / public 公共设施 */
  @Column({ name: 'part_category', type: 'varchar', length: 20, nullable: true })
  partCategory: string | null;

  /** owner 业主自理 / repair_fund 修缮基金 / elevator_fund 电梯水泵基金 / public_fund 公共设施基金 */
  @Column({ name: 'fee_category', type: 'varchar', length: 20, nullable: true })
  feeCategory: string | null;

  /** natural 自然幢 / door 门牌幢 / zone 住宅区域 */
  @Column({ name: 'share_method', type: 'varchar', length: 20, nullable: true })
  shareMethod: string | null;

  /** 纸上三个括号里的字，默认跟着勾选自动写，可手改 */
  @Column({ name: 'repair_date_text', type: 'varchar', length: 60, nullable: true })
  repairDateText: string | null;

  @Column({ name: 'fee_category_text', type: 'varchar', length: 60, nullable: true })
  feeCategoryText: string | null;

  @Column({ name: 'share_method_text', type: 'varchar', length: 60, nullable: true })
  shareMethodText: string | null;

  // ===== 明细 =====
  @Column({ type: 'jsonb', default: () => "'[]'" })
  items: MaintenanceItem[];

  @Column({ type: 'jsonb', default: () => "'[]'" })
  materials: MaintenanceMaterial[];

  // ===== 金额 =====
  /** 定额人工单价（分/工时）快照 */
  @Column({ name: 'labor_rate_cents', type: 'int', default: 0 })
  laborRateCents: number;

  /** 取费系数快照，合计 =（人工费 + 材料费）× 系数 */
  @Column({ type: 'numeric', precision: 8, scale: 4, default: 1 })
  coefficient: string;

  /** 定额工料费合计（分） */
  @Column({ name: 'total_cents', type: 'int', default: 0 })
  totalCents: number;

  /** 材料合计（分） */
  @Column({ name: 'material_total_cents', type: 'int', default: 0 })
  materialTotalCents: number;

  /** 凭证发放 */
  @Column({ name: 'voucher_issue', type: 'varchar', length: 120, nullable: true })
  voucherIssue: string | null;

  // ===== 签名（一律手写，存图片地址） =====
  @Column({ name: 'filler_id', type: 'int', nullable: true })
  fillerId: number | null;

  @Column({ name: 'filler_name', type: 'varchar', length: 60, nullable: true })
  fillerName: string | null;

  @Column({ name: 'filler_sign_url', type: 'varchar', length: 500, nullable: true })
  fillerSignUrl: string | null;

  @Column({ name: 'repairer_id', type: 'int', nullable: true })
  repairerId: number | null;

  @Column({ name: 'repairer_name', type: 'varchar', length: 60, nullable: true })
  repairerName: string | null;

  @Column({ name: 'repairer_sign_url', type: 'varchar', length: 500, nullable: true })
  repairerSignUrl: string | null;

  @Column({ name: 'inspector_id', type: 'int', nullable: true })
  inspectorId: number | null;

  @Column({ name: 'inspector_name', type: 'varchar', length: 60, nullable: true })
  inspectorName: string | null;

  @Column({ name: 'inspector_sign_url', type: 'varchar', length: 500, nullable: true })
  inspectorSignUrl: string | null;

  @Column({ name: 'inspected_at', type: 'timestamptz', nullable: true })
  inspectedAt: Date | null;

  /** 报修人（户）验收签名 */
  @Column({ name: 'owner_sign_url', type: 'varchar', length: 500, nullable: true })
  ownerSignUrl: string | null;

  /** 背面右侧「折旧料或整料记录」，整张单一格自由文本 */
  @Column({ name: 'scrap_note', type: 'text', nullable: true })
  scrapNote: string | null;

  // ===== 背面下方两栏 =====
  @Column({ name: 'service_record', type: 'varchar', length: 120, nullable: true })
  serviceRecord: string | null;

  @Column({ name: 'follow_up_record', type: 'varchar', length: 120, nullable: true })
  followUpRecord: string | null;
}
