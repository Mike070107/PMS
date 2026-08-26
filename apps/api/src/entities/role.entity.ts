import { Entity, Column, Index } from 'typeorm';
import { TenantEntity } from '../common/base.entity';

/**
 * 角色 = 一个名字 + 勾好的页面 + 数据范围。就这三件事。
 *
 * - 能看到什么、能不能动手：role_permissions（页面 × 查看/编辑/删除），
 *   两端共用一张表，员工端入口用 `app:` 前缀（见 common/pages.ts）
 * - 能看哪些小区的数据：data_scope + role_scopes
 *
 * 这里**没有「业务身份 / 角色类型」这种字段**。2026-08-26 短暂加过一个
 * business_role，用来区分「接单还是派单」「谁批第一步」——那两件事已经
 * 拆成各自的可勾选入口（app:pool / app:dispatch / app:approve-manager /
 * app:approve-purchaser），字段随之删除：配一个角色不该先填一个类型。
 *
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
