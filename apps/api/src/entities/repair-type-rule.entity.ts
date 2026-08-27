import { Column, Entity, Index } from 'typeorm';
import { TenantEntity } from '../common/base.entity';

/**
 * 报修类型派单规则：报修类型 -> 默认维修工 / 时限 / 关键词。
 *
 * 按管理处分套（2026-08-27）：office_id 为空 = **公司默认模板**；每个管理处首次打开配置页时
 * 从模板复制一份，之后各改各的。取规则时先找报修小区所属管理处的那套，没有再回退公司默认
 * （见 RepairsService.rulesForCommunity）。
 * 唯一性分两条：公司默认里类型编码唯一（部分索引 office_id IS NULL），
 * 同一管理处内类型编码唯一。
 */
@Entity('repair_type_rules')
@Index(['tenantId', 'officeId', 'repairType'], { unique: true })
@Index('uq_repair_type_rules_company', ['tenantId', 'repairType'], {
  unique: true,
  where: '"office_id" IS NULL',
})
export class RepairTypeRule extends TenantEntity {
  /** 所属管理处；null = 公司默认模板 */
  @Column({ name: 'office_id', type: 'int', nullable: true })
  officeId: number | null;

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
