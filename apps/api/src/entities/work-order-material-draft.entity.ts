import { Column, Entity, Index } from 'typeorm';
import { TenantEntity } from '../common/base.entity';

@Entity('work_order_material_drafts')
@Index(['tenantId', 'workOrderId'], { unique: true })
export class WorkOrderMaterialDraft extends TenantEntity {
  @Column({ name: 'work_order_id', type: 'int' })
  workOrderId: number;

  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  rows: unknown[];

  @Column({ type: 'int', default: 0 })
  version: number;
}

@Entity('stock_reservations')
@Index(['tenantId', 'workOrderId', 'warehouseId', 'materialId'], { unique: true })
@Index(['tenantId', 'warehouseId', 'materialId'])
export class StockReservation extends TenantEntity {
  @Column({ name: 'work_order_id', type: 'int' })
  workOrderId: number;

  @Column({ name: 'warehouse_id', type: 'int' })
  warehouseId: number;

  @Column({ name: 'material_id', type: 'int' })
  materialId: number;

  @Column({ type: 'numeric', precision: 12, scale: 2 })
  qty: number;
}
