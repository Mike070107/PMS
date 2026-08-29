import { Entity, Column, Index } from 'typeorm';
import { TenantEntity } from '../common/base.entity';

/** 某仓某材料的当前库存 */
@Entity('stocks')
@Index(['tenantId'])
@Index(['warehouseId', 'materialId'], { unique: true })
export class Stock extends TenantEntity {
  @Column({ name: 'warehouse_id', type: 'int' })
  warehouseId: number;

  @Column({ name: 'material_id', type: 'int' })
  materialId: number;

  @Column({ type: 'numeric', precision: 12, scale: 2, default: 0 })
  qty: number;

  // 安全库存，低于则报表预警
  @Column({ name: 'safety_qty', type: 'numeric', precision: 12, scale: 2, default: 0 })
  safetyQty: number;

  /** 当前存放库位，最近一次入库写入。空 = 该仓没配库位 */
  @Column({ name: 'location_id', type: 'int', nullable: true })
  locationId: number | null;
}
