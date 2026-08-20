import { Entity, Column, Index } from 'typeorm';
import { TenantEntity } from '../common/base.entity';
import { PurchaseOrderStatus } from '../common/enums';

/** 采购单（采购经理下单后生成） */
@Entity('purchase_orders')
@Index(['tenantId', 'status'])
export class PurchaseOrder extends TenantEntity {
  @Column({ name: 'order_no', type: 'varchar', length: 40 })
  orderNo: string;

  @Column({ name: 'request_id', type: 'int', nullable: true })
  requestId: number | null;

  @Column({ name: 'supplier_id', type: 'int' })
  supplierId: number;

  // 明细：[{materialId, qty, unitCostCents}]
  @Column({ type: 'jsonb', default: () => "'[]'" })
  items: Array<{ materialId: number; qty: number; unitCostCents: number }>;

  @Column({ name: 'total_cents', type: 'int', default: 0 })
  totalCents: number;

  @Column({ type: 'varchar', length: 20, default: PurchaseOrderStatus.PLACED })
  status: PurchaseOrderStatus;
}
