import { Entity, Column, Index } from 'typeorm';
import { TenantEntity } from '../common/base.entity';

/** 库位/货架：入库时选择存放位置（库区-货架-货位） */
@Entity('warehouse_locations')
@Index(['tenantId', 'warehouseId'])
export class WarehouseLocation extends TenantEntity {
  @Column({ name: 'warehouse_id', type: 'int' })
  warehouseId: number;

  // 库区（如 A区）
  @Column({ type: 'varchar', length: 60, nullable: true })
  zone: string | null;

  // 货架（如 03架）
  @Column({ type: 'varchar', length: 60, nullable: true })
  shelf: string | null;

  // 货位（如 2层）
  @Column({ type: 'varchar', length: 60, nullable: true })
  bin: string | null;

  // 组合展示名（zone-shelf-bin），入库时展示与选择
  @Column({ type: 'varchar', length: 200 })
  label: string;

  @Column({ default: true })
  enabled: boolean;
}
