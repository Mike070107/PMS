import { Entity, Column, Index } from 'typeorm';
import { TenantEntity } from '../common/base.entity';

/**
 * 角色额外可见的仓库（2026-08-30）。
 *
 * 数据范围（role_scopes）只能表达「哪些管理处 / 哪些小区」，而总仓不挂任何管理处，
 * 所以「让枫桦景苑办公室用总公司那个总仓」用数据范围表达不出来 —— 这张表补这一格。
 * 空 = 只看数据范围算出来的仓（管理处范围的人看本处的仓，全公司范围的人本来就全看得到）。
 *
 * 与管理处视角正交：顶栏切了某个管理处只收窄「按管理处算的那部分」，
 * 这里授权的仓一直可见 —— 它是角色本身的授权，不属于任何一个管理处。
 */
@Entity('role_warehouses')
@Index(['tenantId'])
@Index(['roleId'])
export class RoleWarehouse extends TenantEntity {
  @Column({ name: 'role_id', type: 'int' })
  roleId: number;

  @Column({ name: 'warehouse_id', type: 'int' })
  warehouseId: number;
}
