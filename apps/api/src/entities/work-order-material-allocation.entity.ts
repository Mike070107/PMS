import { Entity, Column, Index } from 'typeorm';
import { TenantEntity } from '../common/base.entity';

/** 工单用料成本分摊：记录一次领料实际扣到了哪些库存批次 */
@Entity('work_order_material_allocations')
@Index(['tenantId', 'workOrderMaterialId'])
export class WorkOrderMaterialAllocation extends TenantEntity {
  @Column({ name: 'work_order_material_id', type: 'int' })
  workOrderMaterialId: number;

  @Column({ name: 'stock_lot_id', type: 'int' })
  stockLotId: number;

  @Column({ type: 'numeric', precision: 12, scale: 2 })
  qty: number;

  @Column({ name: 'unit_cost_cents', type: 'int', default: 0 })
  unitCostCents: number;

  @Column({ name: 'amount_cents', type: 'int', default: 0 })
  amountCents: number;
}
