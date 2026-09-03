import { Entity, Column, Index } from 'typeorm';
import { TenantEntity } from '../common/base.entity';
import { WorkOrderStatus } from '../common/enums';

/**
 * 一次业务动作前/后的工单关键字段快照。
 *
 * 撤回**必须**按快照恢复，不能根据当前字段倒推：
 * 「维修中」可能来自待派单主动认领、也可能来自等待材料接回、还可能来自定向派单后接单，
 * 倒推只会猜错一半（2026-09-03 之前就是硬编码「维修中一律退回已派单」）。
 */
export interface WorkOrderSnapshot {
  status?: WorkOrderStatus;
  assigneeId?: number | null;
  candidateIds?: number[];
  skill?: string | null;
  /** 报修类型存在 repair_requests 上，转单会改它，所以一并快照 */
  repairType?: string | null;
  dispatchedAt?: string | null;
  acceptedAt?: string | null;
  completedAt?: string | null;
  slaDueAt?: string | null;
  escalatedAt?: string | null;
  missingMaterials?: unknown[];
  usedMaterials?: unknown[];
  resultAttachments?: string[];
  actionTags?: string[];
  actionNote?: string | null;
  faultLocation?: string | null;
  faultSymptom?: string | null;
  repairContent?: string | null;
  feeCents?: number;
  /** 动作发生时当前生效的完工批次 id */
  activeCompletionBatchId?: number | null;
}

/** 工单状态变更与操作流水 */
@Entity('work_order_logs')
@Index(['tenantId', 'workOrderId'])
export class WorkOrderLog extends TenantEntity {
  @Column({ name: 'work_order_id', type: 'int' })
  workOrderId: number;

  @Column({ name: 'from_status', type: 'varchar', length: 24, nullable: true })
  fromStatus: WorkOrderStatus | null;

  @Column({ name: 'to_status', type: 'varchar', length: 24 })
  toStatus: WorkOrderStatus;

  // 操作动作描述，如 auto_dispatch / accept / transfer / complete / need_material / review
  @Column({ type: 'varchar', length: 40 })
  action: string;

  @Column({ name: 'operator_id', type: 'int', nullable: true })
  operatorId: number | null;

  @Column({ type: 'text', nullable: true })
  note: string | null;

  /** 维修过程照片；与完工照片分开，按时间节点展示。 */
  @Column({ type: 'jsonb', default: () => "'[]'" })
  attachments: string[];

  /** 执行这个动作**之前**的工单快照。撤回时原样写回。 */
  @Column({ name: 'before_snapshot', type: 'jsonb', nullable: true })
  beforeSnapshot: WorkOrderSnapshot | null;

  /** 执行之后的快照，用来核对「撤回的确实是这一步」 */
  @Column({ name: 'after_snapshot', type: 'jsonb', nullable: true })
  afterSnapshot: WorkOrderSnapshot | null;

  /** 本条是 rollback 时，指向被它撤销的那条业务日志 */
  @Column({ name: 'rolled_back_log_id', type: 'int', nullable: true })
  rolledBackLogId: number | null;

  /** 本条被哪条 rollback 撤销了；有值 = 这一步已经被撤回过，不能再撤第二次 */
  @Column({ name: 'reverted_by_log_id', type: 'int', nullable: true })
  revertedByLogId: number | null;

  /** 撤回节点的结构化明细（退料清单、采购/养护单处理结果等），前端直接渲染 */
  @Column({ name: 'rollback_detail', type: 'jsonb', nullable: true })
  rollbackDetail: Record<string, unknown> | null;
}
