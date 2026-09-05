import { Column, Entity, Index } from 'typeorm';
import { TenantEntity } from '../common/base.entity';

/**
 * 每一次大模型调用记一行：谁家、哪个用途、花了多少 token、命中了什么缓存。
 *
 * 2026-09-05 Mike 问「AI 调用会不会让账单快速涨」—— 之前一个数字都答不上来，
 * 只能翻 nginx 日志数请求次数。有了这张表，后台「AI 辅助」页能直接看本月用量和估算费用。
 *
 * 两种缓存分开记：
 *   · cacheHit = 本系统结果缓存命中（ai_result_cache），根本没打服务商，token 全 0；
 *   · promptCacheHitTokens = 服务商（DeepSeek）前缀缓存命中的输入 token，按折扣价计。
 */
@Entity('ai_usage_logs')
@Index(['tenantId', 'createdAt'])
export class AiUsageLog extends TenantEntity {
  /** repair-parse / completion-summary / material-receipt / material-profile / test */
  @Column({ type: 'varchar', length: 30 })
  kind: string;

  @Column({ type: 'varchar', length: 80, default: '' })
  model: string;

  @Column({ default: true })
  ok: boolean;

  @Column({ name: 'cache_hit', default: false })
  cacheHit: boolean;

  @Column({ name: 'prompt_tokens', type: 'int', default: 0 })
  promptTokens: number;

  @Column({ name: 'prompt_cache_hit_tokens', type: 'int', default: 0 })
  promptCacheHitTokens: number;

  @Column({ name: 'completion_tokens', type: 'int', default: 0 })
  completionTokens: number;

  @Column({ name: 'latency_ms', type: 'int', default: 0 })
  latencyMs: number;

  /** 服务商报错原文（截断），成功为 null */
  @Column({ type: 'varchar', length: 300, nullable: true })
  error: string | null;
}
