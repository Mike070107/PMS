import { Entity, Column, Index } from 'typeorm';
import { TenantEntity } from '../common/base.entity';

/** active=当前有效用料；reversed=已被撤回冲销，只留档 */
export type WorkOrderMaterialStatus = 'active' | 'reversed';

/**
 * completion=正式提交完工时扣的料（可被撤回冲销）；
 * legacy_issue=批次机制上线前的历史领用，或缺料流程中的单独领用，不归属任何完工批次。
 */
export type WorkOrderMaterialSource = 'completion' | 'legacy_issue';

/**
 * 工单领用材料明细（完工时填，自动从对应仓出库）。
 *
 * **退料不删记录**：撤回完工只把 status 置 reversed 并写退料流水，
 * 原 FIFO 成本、原仓库、原数量永久保留 —— 成本报表要能还原当时扣的是哪批货。
 * 查「当前用料」一律带 status='active' 条件。
 */
@Entity('work_order_materials')
@Index(['tenantId', 'workOrderId'])
@Index(['tenantId', 'workOrderId', 'status'])
export class WorkOrderMaterial extends TenantEntity {
  @Column({ name: 'work_order_id', type: 'int' })
  workOrderId: number;

  @Column({ name: 'material_id', type: 'int' })
  materialId: number;

  // 出库来源仓
  @Column({ name: 'warehouse_id', type: 'int' })
  warehouseId: number;

  @Column({ type: 'numeric', precision: 12, scale: 2 })
  qty: number;

  // 出库时单位成本快照（分）
  @Column({ name: 'unit_cost_cents', type: 'int', default: 0 })
  unitCostCents: number;

  // 本次领料总成本（分），由 FIFO 批次分摊汇总
  @Column({ name: 'total_cost_cents', type: 'int', default: 0 })
  totalCostCents: number;

  /** 归属的完工提交批次；null = 历史领用或缺料领用 */
  @Column({ name: 'completion_batch_id', type: 'int', nullable: true })
  completionBatchId: number | null;

  @Column({ type: 'varchar', length: 20, default: 'active' })
  status: WorkOrderMaterialStatus;

  @Column({ name: 'source_action', type: 'varchar', length: 20, default: 'completion' })
  sourceAction: WorkOrderMaterialSource;

  @Column({ name: 'reversed_at', type: 'timestamptz', nullable: true })
  reversedAt: Date | null;

  @Column({ name: 'reversed_by', type: 'int', nullable: true })
  reversedBy: number | null;

  @Column({ name: 'reverse_reason', type: 'varchar', length: 500, nullable: true })
  reverseReason: string | null;

  /**
   * 退料时生成的那条 stock_movements.id。
   * 有值 = 已经退过料，是「同一条扣料最多冲销一次」的幂等闸门。
   */
  @Column({ name: 'reversal_movement_id', type: 'int', nullable: true })
  reversalMovementId: number | null;

  /** 出库时那条 stock_movements.id，轨迹里把扣料和退料成对显示 */
  @Column({ name: 'issue_movement_id', type: 'int', nullable: true })
  issueMovementId: number | null;
}
