import { Entity, Column, Index } from 'typeorm';
import { TenantEntity } from '../common/base.entity';

/**
 * 角色 = 一个人在物业里「干哪一行」＋「被授权到哪一页的哪一档」。
 *
 * 2026-08-26 起业务身份与后台角色**合并成这一张表**（此前是双轨）：
 * 后台只有「角色」一个概念，建角色时选它对应的业务身份（business_role）。
 * - 业务身份：business_role → 决定小程序端能力（接单/派单/代报）、审批链、登录哪个端
 * - 功能权限：role_permissions（页面 × 查看/编辑/删除）
 * - 数据范围：data_scope + role_scopes（全公司 / 指定管理处 / 指定小区）
 * 同名角色按公司隔离，(tenant_id, name) 唯一。
 *
 * users.role 仍在，但已降级为**派生列**：绑角色时由 business_role 同步写入，
 * 后台不再单独编辑。留着它是因为 26 处 @Roles、jwt payload、小程序登录跳转、
 * SELF_SCOPED_ROLES 的数据隔离都读它，而业主根本不绑角色（users.role='owner'）。
 */
@Entity('roles')
@Index(['tenantId', 'name'], { unique: true })
export class Role extends TenantEntity {
  @Column({ type: 'varchar', length: 60 })
  name: string;

  /**
   * 这个角色对应的业务身份（UserRole）。
   * null = 纯后台角色，不上小程序（比如只给财务开个「查报表」的角色）。
   * 一个用户只能绑一个带 business_role 的角色，否则「他到底是维修工还是经理」无解。
   */
  @Column({ name: 'business_role', type: 'varchar', length: 20, nullable: true })
  businessRole: string | null;

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
