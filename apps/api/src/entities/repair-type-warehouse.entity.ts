import { Column, Entity, Index } from 'typeorm';
import { TenantEntity } from '../common/base.entity';

/**
 * 报修类型 → 领料仓库，按小区分别配。
 *
 * 为什么不直接挂在 repair_type_rules 上：那张表是「全公司一份」的派单规则
 * （默认维修工、时限、猜你想输关键词），而领料仓库要按小区分开配
 * （同样是门禁故障，一期从智能化维修工仓库领，二期可能从别的仓领）。
 * 塞进去就得给每个小区复制一整套规则，改一个关键词要改 N 遍。
 *
 * 没配的 (小区, 类型) 就是没配 —— 不做「退回小区仓」这类猜测：
 * 猜错了料就从别的仓扣走，账对不上比领不到料更难查。
 */
@Entity('repair_type_warehouses')
@Index(['tenantId', 'communityId', 'repairType'], { unique: true })
export class RepairTypeWarehouse extends TenantEntity {
  @Column({ name: 'community_id', type: 'int' })
  communityId: number;

  @Column({ name: 'repair_type', type: 'varchar', length: 60 })
  repairType: string;

  @Column({ name: 'warehouse_id', type: 'int' })
  warehouseId: number;
}
