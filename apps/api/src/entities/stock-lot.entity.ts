import { Entity, Column, Index } from 'typeorm';
import { TenantEntity } from '../common/base.entity';

/** 库存批次：同一材料不同入库单价分批追踪，出库按 FIFO 扣减 */
@Entity('stock_lots')
@Index(['tenantId', 'warehouseId', 'materialId', 'remainingQty'])
@Index(['tenantId', 'warehouseId', 'materialId', 'receivedAt'])
export class StockLot extends TenantEntity {
  @Column({ name: 'warehouse_id', type: 'int' })
  warehouseId: number;

  @Column({ name: 'material_id', type: 'int' })
  materialId: number;

  @Column({ name: 'lot_no', type: 'varchar', length: 60 })
  lotNo: string;

  @Column({ name: 'initial_qty', type: 'numeric', precision: 12, scale: 2 })
  initialQty: number;

  @Column({ name: 'remaining_qty', type: 'numeric', precision: 12, scale: 2 })
  remainingQty: number;

  @Column({ name: 'unit_cost_cents', type: 'int', default: 0 })
  unitCostCents: number;

  @Column({ name: 'supplier_id', type: 'int', nullable: true })
  supplierId: number | null;

  @Column({ name: 'purchase_order_id', type: 'int', nullable: true })
  purchaseOrderId: number | null;

  @Column({ name: 'goods_receipt_id', type: 'int', nullable: true })
  goodsReceiptId: number | null;

  @Column({ name: 'source_type', type: 'varchar', length: 40, nullable: true })
  sourceType: string | null;

  @Column({ name: 'source_id', type: 'int', nullable: true })
  sourceId: number | null;

  @Column({ name: 'received_at', type: 'timestamptz' })
  receivedAt: Date;
}
