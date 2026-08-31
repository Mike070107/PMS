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
 *
 * **关键词不分套（2026-08-31）**：类型名 / 维修工 / 时限仍各管理处独立（叶双只在他那个管理处），
 * 但「猜你想输」关键词改成模板叠加，见下面 contentSuggestions / extraSuggestions / mutedSuggestions
 * 三个字段的说明。原因：关键词同时是报修类型的判定依据，每处各配一套等于同一句话在 A 处判得出、
 * 在 B 处判不出，而且词库被切碎后谁都攒不够数据。
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

  /** 兼容字段：assignee_ids 的第一个人。老代码/老数据只认这一列，新逻辑一律读 assigneeIds */
  @Column({ name: 'assignee_id', type: 'int', nullable: true })
  assigneeId: number | null;

  /**
   * 默认维修工，可多人（2026-08-28）。新单不再自动派给某一个人：这些人都收到「新工单」通知、
   * 都在自己的工单池里看到它，谁先接单归谁。老数据这一列是空数组，读取时用 assignee_id 兜底
   * （见 ruleAssigneeIds）。
   */
  @Column({ name: 'assignee_ids', type: 'jsonb', default: () => "'[]'" })
  assigneeIds: number[];

  @Column({ name: 'sla_hours', type: 'int', nullable: true })
  slaHours: number | null;

  @Column({ name: 'sort_order', type: 'int', default: 0 })
  sortOrder: number;

  @Column({ type: 'boolean', default: true })
  enabled: boolean;

  /**
   * 「猜你想输」**公司模板词**：只有 office_id IS NULL 那些行的这一列算数，全公司共用。
   * 公司层改了，所有管理处立刻跟着变（不再需要逐处配一遍）。
   *
   * 管理处行的这一列迁移后一律为空、也不再读 —— 本处的词走 extra_suggestions /
   * mutedSuggestions。留着这一列没删是为了迁移可回滚（见 RepairKeywordTemplate 迁移的 down）。
   */
  @Column({ name: 'content_suggestions', type: 'jsonb', default: () => "'[]'" })
  contentSuggestions: string[];

  /**
   * 本处自己加的词（只有管理处行有意义）：某个小区管道闸叫「抬杆机」这种本地叫法。
   * 排在模板词前面 —— 本地叫法更贴当地人的嘴。
   */
  @Column({ name: 'extra_suggestions', type: 'jsonb', default: () => "'[]'" })
  extraSuggestions: string[];

  /**
   * 本处停用的模板词（只有管理处行有意义）。
   *
   * 为什么是「屏蔽」不是「删除」：模板词被某个管理处删掉后，公司层再也不知道哪几处不认这个词，
   * 也没法回滚。屏蔽留了痕，配置页上能一眼看出「本处停用了 3 个模板词」并随时恢复。
   */
  @Column({ name: 'muted_suggestions', type: 'jsonb', default: () => "'[]'" })
  mutedSuggestions: string[];
}
