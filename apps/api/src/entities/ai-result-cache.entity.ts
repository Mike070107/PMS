import { Column, Entity, Index } from 'typeorm';
import { TenantEntity } from '../common/base.entity';

/**
 * 大模型结果缓存：同一份提示词 + 同一句话，若干天内直接复用上次的 JSON，不再打服务商。
 *
 * key = sha256(模型 + 完整系统提示词 + 归一化后的用户原话)。系统提示词进 key 是故意的：
 * 样例库、类型清单、收费规则一变，提示词就变，旧缓存自然失效，不用另写失效逻辑。
 * temperature 已经是 0，同样的输入本来就该得到同样的输出，缓存不改变行为。
 * 有效期由后台「AI 辅助 → 结果缓存天数」控制，0 = 关闭。
 */
@Entity('ai_result_cache')
@Index(['tenantId', 'keyHash'], { unique: true })
@Index(['expiresAt'])
export class AiResultCache extends TenantEntity {
  @Column({ type: 'varchar', length: 30 })
  kind: string;

  @Column({ name: 'key_hash', type: 'varchar', length: 64 })
  keyHash: string;

  @Column({ type: 'varchar', length: 80, default: '' })
  model: string;

  @Column({ type: 'jsonb' })
  response: Record<string, unknown>;

  /** 被复用了几次 —— 后台看得到这条缓存省了多少次调用 */
  @Column({ type: 'int', default: 0 })
  hits: number;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;
}
