import { Entity, Column, Index } from 'typeorm';
import { TenantEntity } from '../common/base.entity';

/** 供应商-材料-报价（比价用） */
@Entity('supplier_materials')
@Index(['tenantId', 'supplierId'])
@Index(['supplierId', 'materialId'], { unique: true })
export class SupplierMaterial extends TenantEntity {
  @Column({ name: 'supplier_id', type: 'int' })
  supplierId: number;

  @Column({ name: 'material_id', type: 'int' })
  materialId: number;

  // 报价（分）
  @Column({ name: 'price_cents', type: 'int' })
  priceCents: number;

  @Column({ name: 'quoted_at', type: 'timestamptz', nullable: true })
  quotedAt: Date | null;
}
