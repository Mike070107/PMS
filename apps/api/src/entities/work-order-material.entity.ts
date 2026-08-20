import { Entity, Column, Index } from 'typeorm';
import { TenantEntity } from '../common/base.entity';

/** 工单领用材料明细（完工时填，自动从对应仓出库） */
@Entity('work_order_materials')
@Index(['tenantId', 'workOrderId'])
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
}
