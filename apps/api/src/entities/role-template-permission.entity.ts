import { Entity, Column, Index } from 'typeorm';
import { TenantEntity } from '../common/base.entity';

/**
 * 权限模板 × 页面 的三档权限，字段与 role_permissions 一模一样 ——
 * 权限解析时两张表的行混在一起按 page_key 取并集即可（见 access.service）。
 */
@Entity('role_template_permissions')
@Index(['tenantId'])
@Index(['templateId', 'pageKey'], { unique: true })
export class RoleTemplatePermission extends TenantEntity {
  @Column({ name: 'template_id', type: 'int' })
  templateId: number;

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
