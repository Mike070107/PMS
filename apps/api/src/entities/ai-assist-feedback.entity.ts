import { Column, Entity, Index } from 'typeorm';
import { TenantEntity } from '../common/base.entity';

/**
 * AI 填单纠错记录。
 *
 * 这里只记录“模型草稿”和“人工最终提交”的差异，不直接改提示词。办公室审核后才能
 * 提升为正式样例，避免一次手滑把整个租户的识别口径教偏。
 */
@Entity('ai_assist_feedback')
@Index(['tenantId', 'kind', 'status'])
@Index(['tenantId', 'workOrderId'])
export class AiAssistFeedback extends TenantEntity {
  @Column({ type: 'varchar', length: 20 })
  kind: 'repair' | 'completion';

  @Column({ name: 'work_order_id', type: 'int', nullable: true })
  workOrderId: number | null;

  @Column({ name: 'source_text', type: 'text' })
  sourceText: string;

  @Column({ type: 'jsonb', default: () => "'{}'" })
  draft: Record<string, unknown>;

  @Column({ name: 'final_value', type: 'jsonb', default: () => "'{}'" })
  finalValue: Record<string, unknown>;

  @Column({ name: 'field_diff', type: 'jsonb', default: () => "'{}'" })
  fieldDiff: Record<string, { before: unknown; after: unknown }>;

  /** pending=有修改待审核；confirmed=原样确认；promoted=已收为样例；ignored=已忽略 */
  @Column({ type: 'varchar', length: 20, default: 'confirmed' })
  status: 'pending' | 'confirmed' | 'promoted' | 'ignored';

  @Column({ type: 'varchar', length: 80, nullable: true })
  model: string | null;

  @Column({ name: 'prompt_version', type: 'varchar', length: 30, default: '2026-09-02' })
  promptVersion: string;
}
