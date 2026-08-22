import { Entity, Column, Index } from 'typeorm';
import { TenantEntity } from '../common/base.entity';

/**
 * 报修类型纠错记录：管理员在工单详情里把自动判定的类型改掉时落一条。
 *
 * 两个用途：
 * 1. 半自动学习的凭据 —— 更正时勾选的关键词写进了 repair_type_rules，
 *    这里记下「谁、把哪单、从什么改成什么、学了哪些词」，学错了能对着查；
 * 2. 攒数据 —— 同一个词被反复纠正到同一类型时，后续可以做全自动迁移，
 *    没有这张表就永远只能靠人肉记忆。
 */
@Entity('repair_type_corrections')
@Index(['tenantId', 'workOrderId'])
export class RepairTypeCorrection extends TenantEntity {
  @Column({ name: 'work_order_id', type: 'int' })
  workOrderId: number;

  @Column({ name: 'request_id', type: 'int' })
  requestId: number;

  /** 更正前的类型编码；原本没判出类型时为 null */
  @Column({ name: 'from_type', type: 'varchar', length: 60, nullable: true })
  fromType: string | null;

  @Column({ name: 'to_type', type: 'varchar', length: 60 })
  toType: string;

  /** 报修描述快照 —— 之后做自动学习要靠它复盘「哪个词导致误判」 */
  @Column({ type: 'text' })
  content: string;

  /** 这次更正同时学进新类型的关键词 */
  @Column({ name: 'learned_keywords', type: 'jsonb', default: () => "'[]'" })
  learnedKeywords: string[];
}
