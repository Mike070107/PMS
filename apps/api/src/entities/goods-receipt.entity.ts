import { Entity, Column, Index } from 'typeorm';
import { TenantEntity } from '../common/base.entity';

/** 入库单来源类型 */
export type GoodsReceiptType = 'purchase_order' | 'general';

/**
 * 入库单。两种来源：
 * - purchase_order：采购单入库，关联采购单、填实收数量、差异提醒
 * - general：一般入库（零星采买），填来源 + 小票/发票附件
 * 每条明细逐项拍照、选库位。
 */
@Entity('goods_receipts')
@Index(['tenantId', 'purchaseOrderId'])
@Index(['tenantId', 'receiptType'])
export class GoodsReceipt extends TenantEntity {
  @Column({ name: 'receipt_no', type: 'varchar', length: 40 })
  receiptNo: string;

  @Column({ name: 'receipt_type', type: 'varchar', length: 20, default: 'purchase_order' })
  receiptType: GoodsReceiptType;

  // 采购单入库时关联；一般入库为 null
  @Column({ name: 'purchase_order_id', type: 'int', nullable: true })
  purchaseOrderId: number | null;

  // 一般入库的材料来源（如「XX五金店临时采购」）
  @Column({ name: 'source_text', type: 'varchar', length: 255, nullable: true })
  sourceText: string | null;

  // 一般入库的凭证附件（小票照片 / 发票 PDF）
  @Column({ type: 'jsonb', default: () => "'[]'" })
  attachments: string[];

  // 入库目标仓
  @Column({ name: 'warehouse_id', type: 'int' })
  warehouseId: number;

  // 接收人
  @Column({ name: 'receiver_id', type: 'int', nullable: true })
  receiverId: number | null;

  // 明细：每项含实收数量、单价、逐项照片、库位
  @Column({ type: 'jsonb', default: () => "'[]'" })
  items: Array<{
    materialId: number;
    qty: number;
    unitCostCents: number;
    photoUrls?: string[];
    locationId?: number | null;
    locationLabel?: string | null;
  }>;
}
