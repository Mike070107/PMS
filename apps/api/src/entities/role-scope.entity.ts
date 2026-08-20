import { Entity, Column, Index } from 'typeorm';
import { TenantEntity } from '../common/base.entity';

/**
 * 角色数据范围明细。仅当 roles.data_scope 为 offices / communities 时有记录：
 * - offices：每条填 office_id（覆盖该管理处下全部小区，含之后新增的）
 * - communities：每条填 community_id（顶层小区，自动含其下分期）
 * 两列互斥，一条记录只填其一。
 */
@Entity('role_scopes')
@Index(['tenantId'])
@Index(['roleId'])
export class RoleScope extends TenantEntity {
  @Column({ name: 'role_id', type: 'int' })
  roleId: number;

  @Column({ name: 'office_id', type: 'int', nullable: true })
  officeId: number | null;

  @Column({ name: 'community_id', type: 'int', nullable: true })
  communityId: number | null;
}
