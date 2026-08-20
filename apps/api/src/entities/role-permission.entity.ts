import { Entity, Column, Index } from 'typeorm';
import { TenantEntity } from '../common/base.entity';

/**
 * 角色 × 页面 的三档权限。page_key 见 @pms/shared-types 的 ADMIN_PAGES。
 * 无记录或 can_view=false 即该页菜单隐藏、接口 403。
 */
@Entity('role_permissions')
@Index(['tenantId'])
@Index(['roleId', 'pageKey'], { unique: true })
export class RolePermission extends TenantEntity {
  @Column({ name: 'role_id', type: 'int' })
  roleId: number;

  @Column({ name: 'page_key', type: 'varchar', length: 40 })
  pageKey: string;

  @Column({ name: 'can_view', default: false })
  canView: boolean;

  /** 编辑含新增与修改 */
  @Column({ name: 'can_edit', default: false })
  canEdit: boolean;

  @Column({ name: 'can_delete', default: false })
  canDelete: boolean;
}
