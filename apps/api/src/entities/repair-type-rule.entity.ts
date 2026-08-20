import { Column, Entity, Index } from 'typeorm';
import { TenantEntity } from '../common/base.entity';

/** 报修类型派单规则：报修类型 -> 默认维修工 */
@Entity('repair_type_rules')
@Index(['tenantId', 'repairType'], { unique: true })
export class RepairTypeRule extends TenantEntity {
  @Column({ name: 'repair_type', type: 'varchar', length: 60 })
  repairType: string;

  @Column({ type: 'varchar', length: 120 })
  label: string;

  @Column({ name: 'assignee_id', type: 'int', nullable: true })
  assigneeId: number | null;

  @Column({ name: 'sla_hours', type: 'int', nullable: true })
  slaHours: number | null;

  @Column({ name: 'sort_order', type: 'int', default: 0 })
  sortOrder: number;

  @Column({ type: 'boolean', default: true })
  enabled: boolean;

  /**
   * 该类型的「猜你想输」常用词，按数组顺序展示（后台可拖动调序 / 按使用次数排序）。
   * 首次初始化时用内置种子词播种，之后完全由租户维护。
   */
  @Column({ name: 'content_suggestions', type: 'jsonb', default: () => "'[]'" })
  contentSuggestions: string[];
}
