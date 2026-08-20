import { Entity, Column, Index } from 'typeorm';
import { TenantEntity } from '../common/base.entity';

/**
 * 用户 ↔ 后台角色 多对多绑定，权限与数据范围按所有角色取并集。
 * （类名避开 enums 里的 UserRole 枚举。）
 */
@Entity('user_roles')
@Index(['tenantId', 'userId'])
@Index(['userId', 'roleId'], { unique: true })
export class UserRoleAssignment extends TenantEntity {
  @Column({ name: 'user_id', type: 'int' })
  userId: number;

  @Column({ name: 'role_id', type: 'int' })
  roleId: number;
}
