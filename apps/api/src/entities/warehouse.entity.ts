import { Entity, Column, Index } from 'typeorm';
import { TenantEntity } from '../common/base.entity';
import { WarehouseType } from '../common/enums';

/** 仓库：总仓 + 多个小区仓 */
@Entity('warehouses')
@Index(['tenantId'])
export class Warehouse extends TenantEntity {
  @Column({ type: 'varchar', length: 120 })
  name: string;

  @Column({ type: 'varchar', length: 20 })
  type: WarehouseType;

  // 小区仓关联小区；总仓为 null
  @Column({ name: 'community_id', type: 'int', nullable: true })
  communityId: number | null;

  @Column({ default: true })
  enabled: boolean;
}
