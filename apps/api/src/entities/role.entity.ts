import { Entity, Column, Index } from 'typeorm';
import { TenantEntity } from '../common/base.entity';

/**
 * 后台角色（网站权限，与 users.role 业务身份双轨并存）。
 * - 功能权限：role_permissions（页面 × 查看/编辑/删除）
 * - 数据范围：data_scope + role_scopes（全公司 / 指定管理处 / 指定小区）
 * 同名角色按公司隔离，(tenant_id, name) 唯一。
 */
@Entity('roles')
@Index(['tenantId', 'name'], { unique: true })
export class Role extends TenantEntity {
  @Column({ type: 'varchar', length: 60 })
  name: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  remark: string | null;

  /** RoleDataScope: all / offices / communities */
  @Column({ name: 'data_scope', type: 'varchar', length: 20, default: 'all' })
  dataScope: string;

  /** 内置角色（企业超级管理员）：不可删、不可改权限 */
  @Column({ name: 'built_in', default: false })
  builtIn: boolean;

  @Column({ default: true })
  enabled: boolean;
}
