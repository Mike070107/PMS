import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from '../common/base.entity';
import { DictType } from '../common/enums';

/**
 * 通用字典。
 * - tenantId 为 null：平台预置项，所有租户可见
 * - tenantId 非空：该租户自定义/覆盖项
 * 解析时合并：平台预置 + 租户自调（租户同 code 覆盖平台项）
 */
@Entity('dict_items')
@Index(['type', 'tenantId'])
export class DictItem extends BaseEntity {
  @Column({ name: 'tenant_id', type: 'int', nullable: true })
  tenantId: number | null;

  @Column({ type: 'varchar', length: 30 })
  type: DictType;

  @Column({ type: 'varchar', length: 60 })
  code: string;

  @Column({ type: 'varchar', length: 120 })
  label: string;

  // 维修动作标签按工种归类：parentCode 指向 skill code
  @Column({ name: 'parent_code', type: 'varchar', length: 60, nullable: true })
  parentCode: string | null;

  @Column({ name: 'sort_order', type: 'int', default: 0 })
  sortOrder: number;

  @Column({ default: true })
  enabled: boolean;
}
