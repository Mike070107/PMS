import { Entity, Column, Index } from 'typeorm';
import { TenantEntity } from '../common/base.entity';

/** 「猜你想输」的排序口径：本处优先（本处数据不足时用全公司补齐）/ 直接用全公司 */
export type SuggestionScope = 'office_first' | 'company';

/**
 * 物业管理处：公司下的管理单元，一个管理处管多个小区。
 * 小区通过 communities.office_id 挂到管理处；角色数据范围可按管理处圈定，
 * 选中管理处即覆盖其下全部小区（含之后新增的）。
 */
@Entity('management_offices')
@Index(['tenantId'])
export class ManagementOffice extends TenantEntity {
  @Column({ type: 'varchar', length: 120 })
  name: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  remark: string | null;

  @Column({ default: true })
  enabled: boolean;

  /**
   * 「猜你想输」按谁的历史排序（2026-08-31）。
   *
   * 默认 office_first 而不是纯本处：新管理处一条报修都还没有，纯本处口径会是一片空白，
   * 比不分口径还难用。所以本处有数据的词排前面，不够 8 条时用全公司的补齐。
   */
  @Column({
    name: 'suggestion_scope',
    type: 'varchar',
    length: 20,
    default: 'office_first',
  })
  suggestionScope: SuggestionScope;

  /**
   * 本处归纳出的高频词是否进公司模板的候选池。
   * 只是「候选」—— 要不要收编成模板词仍然是公司层点一下才生效，
   * 不自动写模板：一个小区的叫法自动铺到全公司，撞词和误判都会跟着铺开。
   */
  @Column({ name: 'suggestion_feedback', type: 'boolean', default: true })
  suggestionFeedback: boolean;
}
