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

  /**
   * 所属管理处（2026-08-27）。人员按角色范围对应到管理处，再由管理处对应到仓：
   * 员工端库存页默认仓、工单选料兜底都按它匹配。空 = 公司级（总仓）。
   * 老数据没填时按 community_id → communities.office_id 懒补（见 InventoryService.listWarehouses）。
   */
  @Column({ name: 'office_id', type: 'int', nullable: true })
  officeId: number | null;

  /**
   * 默认入库库位（2026-08-30）。入库、调拨入库的表单带出它，仍可改；
   * 空 = 这个仓还没配库位或没指定默认，入库时手动挑。
   */
  @Column({ name: 'default_location_id', type: 'int', nullable: true })
  defaultLocationId: number | null;

  @Column({ default: true })
  enabled: boolean;
}
