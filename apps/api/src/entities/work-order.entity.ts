import { Entity, Column, DeleteDateColumn, Index } from 'typeorm';
import { TenantEntity } from '../common/base.entity';
import { WorkOrderStatus } from '../common/enums';

/** 工单本体 */
@Entity('work_orders')
@Index(['tenantId', 'status'])
@Index(['tenantId', 'assigneeId'])
@Index(['orderNo'], { unique: true })
export class WorkOrder extends TenantEntity {
  // 人类可读单号，如 RX-20260809-K7QM（尾号随机，字符集见 RepairsService.ORDER_NO_ALPHABET）
  @Column({ name: 'order_no', type: 'varchar', length: 40 })
  orderNo: string;

  @Column({ name: 'request_id', type: 'int' })
  requestId: number;

  @Column({ name: 'community_id', type: 'int' })
  communityId: number;

  // 当前负责维修工 user id，待派单池时为 null
  @Column({ name: 'assignee_id', type: 'int', nullable: true })
  assigneeId: number | null;

  /**
   * 建单时按“所属管理处 + 报修类型”算出的待接单维修工快照。
   *
   * 不能只靠 skill 反查当前规则：同一个类型在不同管理处配置的人不同，规则之后也可能被修改。
   * 工单池必须严格只给当时收到新单通知的这些人看；办公室定向派单则仍以 assignee_id 为准。
   */
  @Column({ name: 'candidate_ids', type: 'jsonb', default: () => "'[]'" })
  candidateIds: number[];

  // 该工单需要的工种编码（派单匹配用）
  @Column({ type: 'varchar', length: 60, nullable: true })
  skill: string | null;

  @Column({ type: 'varchar', length: 24, default: WorkOrderStatus.CREATED })
  status: WorkOrderStatus;

  // ===== SLA 计时点 =====
  @Column({ name: 'dispatched_at', type: 'timestamptz', nullable: true })
  dispatchedAt: Date | null;

  @Column({ name: 'accepted_at', type: 'timestamptz', nullable: true })
  acceptedAt: Date | null;

  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt: Date | null;

  // SLA 截止时刻（派单时按租户配置算出），超时触发告警
  @Column({ name: 'sla_due_at', type: 'timestamptz', nullable: true })
  slaDueAt: Date | null;

  // 「派单后迟迟没接单」的升级提醒发出去的时刻。
  // 只发一次：定时任务每 10 分钟扫一遍，不打标记就会每 10 分钟催一轮，
  // 维修工和办公室会被同一张单刷屏，最后谁都不看了。
  // 改派（assignWorkOrder）时清空，新的负责人重新计时。
  @Column({ name: 'escalated_at', type: 'timestamptz', nullable: true })
  escalatedAt: Date | null;

  // ===== 维修执行结果 =====
  // 维修动作标签编码数组
  @Column({ name: 'action_tags', type: 'jsonb', default: () => "'[]'" })
  actionTags: string[];

  @Column({ name: 'action_note', type: 'text', nullable: true })
  actionNote: string | null;

  @Column({ name: 'fault_location', type: 'varchar', length: 255, nullable: true })
  faultLocation: string | null;

  @Column({ name: 'fault_symptom', type: 'text', nullable: true })
  faultSymptom: string | null;

  @Column({ name: 'repair_content', type: 'text', nullable: true })
  repairContent: string | null;

  // note = 用料备注，会印到养护单背面《材料领耗记录》的备注格
  @Column({ name: 'used_materials', type: 'jsonb', default: () => "'[]'" })
  usedMaterials: Array<{ materialId?: number; name: string; qty: number; unit?: string; note?: string }>;

  // 维修现场附件
  @Column({ name: 'result_attachments', type: 'jsonb', default: () => "'[]'" })
  resultAttachments: string[];

  // 收费金额（分），一期仅记账
  @Column({ name: 'fee_cents', type: 'int', default: 0 })
  feeCents: number;

  // 缺料清单快照（材料名称/数量/单位），等待材料时填。
  // materialId 有值 = 从材料库 SKU 选的；只有 name = 现场手填，办公室建完 SKU 后可回来补关联
  @Column({ name: 'missing_materials', type: 'jsonb', default: () => "'[]'" })
  missingMaterials: Array<{ name: string; qty: number; materialId?: number; unit?: string }>;

  /**
   * 管理员“删除”实际是可审计作废：TypeORM 默认查询自动排除 deleted_at 有值的工单，
   * 但数据仍留在库里，后续可从操作日志和快照核对，不会把统计口径悄悄改掉。
   */
  @DeleteDateColumn({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt: Date | null;

  @Column({ name: 'voided_by', type: 'int', nullable: true })
  voidedBy: number | null;

  @Column({ name: 'void_reason', type: 'varchar', length: 500, nullable: true })
  voidReason: string | null;

  /** 作废前的收费、用料、状态等原始值；退库后仍能完整审计。 */
  @Column({ name: 'void_snapshot', type: 'jsonb', default: () => "'{}'" })
  voidSnapshot: Record<string, unknown>;
}
