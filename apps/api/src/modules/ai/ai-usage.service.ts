import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'node:crypto';
import { MoreThan, Repository } from 'typeorm';
import { AiResultCache, AiUsageLog } from '../../entities';
import type { AiAssistSetting } from '../settings/settings.constants';

/** 一次调用的用量（服务商返回的 usage 字段整理后） */
export interface LlmUsage {
  promptTokens: number;
  promptCacheHitTokens: number;
  completionTokens: number;
}

export interface UsageSummary {
  month: string;
  calls: number;
  okCalls: number;
  failedCalls: number;
  /** 本系统结果缓存命中次数（没打服务商） */
  localCacheHits: number;
  promptTokens: number;
  promptCacheHitTokens: number;
  completionTokens: number;
  /** 服务商前缀缓存命中占输入 token 的比例，0~1 */
  providerCacheRatio: number;
  /** 后台填了单价才有；没填为 null，前端显示「填单价后可估算」 */
  estimatedCostYuan: number | null;
  byKind: Array<{ kind: string; calls: number; localCacheHits: number; promptTokens: number; completionTokens: number }>;
  byDay: Array<{ day: string; calls: number; localCacheHits: number }>;
}

/**
 * 大模型用量台账 + 结果缓存。LlmService 每次调用都经过这里；业务代码不直接碰这两张表。
 *
 * 记账失败绝不能影响主流程：写不进去就打一行日志。
 */
@Injectable()
export class AiUsageService {
  private readonly logger = new Logger(AiUsageService.name);

  constructor(
    @InjectRepository(AiUsageLog) private readonly usageRepo: Repository<AiUsageLog>,
    @InjectRepository(AiResultCache) private readonly cacheRepo: Repository<AiResultCache>,
  ) {}

  async record(input: {
    tenantId: number;
    kind: string;
    model: string;
    ok: boolean;
    cacheHit?: boolean;
    usage?: LlmUsage | null;
    latencyMs: number;
    error?: string | null;
  }): Promise<void> {
    try {
      await this.usageRepo.save(
        this.usageRepo.create({
          tenantId: input.tenantId,
          kind: input.kind.slice(0, 30),
          model: (input.model || '').slice(0, 80),
          ok: input.ok,
          cacheHit: !!input.cacheHit,
          promptTokens: input.usage?.promptTokens ?? 0,
          promptCacheHitTokens: input.usage?.promptCacheHitTokens ?? 0,
          completionTokens: input.usage?.completionTokens ?? 0,
          latencyMs: Math.max(0, Math.round(input.latencyMs)),
          error: input.error ? input.error.slice(0, 300) : null,
          createdBy: null,
          updatedBy: null,
        }),
      );
    } catch (e) {
      this.logger.warn(`AI 用量记账失败：${(e as Error).message}`);
    }
  }

  /** 缓存 key：模型 + 系统提示词 + 归一化原话。归一化只影响 key，发给模型的仍是原话 */
  static cacheKey(model: string, system: string, user: string): string {
    return createHash('sha256')
      .update(model)
      .update('\n')
      .update(system)
      .update('\n')
      .update(normalizeForCache(user))
      .digest('hex');
  }

  async getCached(tenantId: number, keyHash: string): Promise<Record<string, unknown> | null> {
    try {
      const row = await this.cacheRepo.findOne({
        where: { tenantId, keyHash, expiresAt: MoreThan(new Date()) },
      });
      if (!row) return null;
      // 命中计数只是统计，不用等它写完
      void this.cacheRepo.increment({ id: row.id }, 'hits', 1).catch(() => undefined);
      return row.response;
    } catch (e) {
      this.logger.warn(`读 AI 结果缓存失败：${(e as Error).message}`);
      return null;
    }
  }

  async putCached(input: {
    tenantId: number;
    kind: string;
    keyHash: string;
    model: string;
    response: Record<string, unknown>;
    days: number;
  }): Promise<void> {
    if (input.days <= 0) return;
    const expiresAt = new Date(Date.now() + input.days * 86400_000);
    try {
      const existing = await this.cacheRepo.findOne({
        where: { tenantId: input.tenantId, keyHash: input.keyHash },
      });
      if (existing) {
        existing.response = input.response;
        existing.model = input.model;
        existing.expiresAt = expiresAt;
        await this.cacheRepo.save(existing);
        return;
      }
      await this.cacheRepo.save(
        this.cacheRepo.create({
          tenantId: input.tenantId,
          kind: input.kind.slice(0, 30),
          keyHash: input.keyHash,
          model: (input.model || '').slice(0, 80),
          response: input.response,
          hits: 0,
          expiresAt,
          createdBy: null,
          updatedBy: null,
        }),
      );
    } catch (e) {
      this.logger.warn(`写 AI 结果缓存失败：${(e as Error).message}`);
    }
  }

  /** 本月（或指定月 YYYY-MM）用量汇总，给后台「AI 辅助」页 */
  async summary(tenantId: number, month: string | undefined, prices: AiAssistSetting): Promise<UsageSummary> {
    const { start, end, label } = monthRange(month);
    const base = () =>
      this.usageRepo
        .createQueryBuilder('u')
        .where('u.tenant_id = :tenantId', { tenantId })
        .andWhere('u.created_at >= :start AND u.created_at < :end', { start, end });

    const totals = await base()
      .select('COUNT(*)', 'calls')
      .addSelect('SUM(CASE WHEN u.ok THEN 1 ELSE 0 END)', 'okCalls')
      .addSelect('SUM(CASE WHEN u.cache_hit THEN 1 ELSE 0 END)', 'localCacheHits')
      .addSelect('COALESCE(SUM(u.prompt_tokens), 0)', 'promptTokens')
      .addSelect('COALESCE(SUM(u.prompt_cache_hit_tokens), 0)', 'promptCacheHitTokens')
      .addSelect('COALESCE(SUM(u.completion_tokens), 0)', 'completionTokens')
      .getRawOne<Record<string, string>>();

    const byKindRaw = await base()
      .select('u.kind', 'kind')
      .addSelect('COUNT(*)', 'calls')
      .addSelect('SUM(CASE WHEN u.cache_hit THEN 1 ELSE 0 END)', 'localCacheHits')
      .addSelect('COALESCE(SUM(u.prompt_tokens), 0)', 'promptTokens')
      .addSelect('COALESCE(SUM(u.completion_tokens), 0)', 'completionTokens')
      .groupBy('u.kind')
      .orderBy('calls', 'DESC')
      .getRawMany<Record<string, string>>();

    const byDayRaw = await base()
      .select("to_char(u.created_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD')", 'day')
      .addSelect('COUNT(*)', 'calls')
      .addSelect('SUM(CASE WHEN u.cache_hit THEN 1 ELSE 0 END)', 'localCacheHits')
      .groupBy('day')
      .orderBy('day', 'ASC')
      .getRawMany<Record<string, string>>();

    const n = (v: unknown) => Number(v ?? 0) || 0;
    const calls = n(totals?.calls);
    const okCalls = n(totals?.okCalls);
    const promptTokens = n(totals?.promptTokens);
    const promptCacheHitTokens = n(totals?.promptCacheHitTokens);
    const completionTokens = n(totals?.completionTokens);
    return {
      month: label,
      calls,
      okCalls,
      failedCalls: calls - okCalls,
      localCacheHits: n(totals?.localCacheHits),
      promptTokens,
      promptCacheHitTokens,
      completionTokens,
      providerCacheRatio: promptTokens ? Math.min(1, promptCacheHitTokens / promptTokens) : 0,
      estimatedCostYuan: estimateCostYuan(
        { promptTokens, promptCacheHitTokens, completionTokens },
        prices,
      ),
      byKind: byKindRaw.map((r) => ({
        kind: r.kind,
        calls: n(r.calls),
        localCacheHits: n(r.localCacheHits),
        promptTokens: n(r.promptTokens),
        completionTokens: n(r.completionTokens),
      })),
      byDay: byDayRaw.map((r) => ({ day: r.day, calls: n(r.calls), localCacheHits: n(r.localCacheHits) })),
    };
  }
}

/**
 * 估算费用（元）。单价是后台填的「元 / 百万 token」三档：输入未命中、输入命中、输出。
 * 一档都没填就返回 null —— 别用猜的价格算出一个看起来很准的数字。
 * DeepSeek 的 prompt_tokens 已包含命中部分，所以未命中 = prompt - 命中。
 */
export function estimateCostYuan(usage: LlmUsage, prices: Partial<AiAssistSetting>): number | null {
  const miss = Number(prices.priceInputMissPerM) || 0;
  const hit = Number(prices.priceInputHitPerM) || 0;
  const out = Number(prices.priceOutputPerM) || 0;
  if (!miss && !hit && !out) return null;
  const hitTokens = Math.min(usage.promptCacheHitTokens, usage.promptTokens);
  const missTokens = usage.promptTokens - hitTokens;
  const yuan = (missTokens * miss + hitTokens * hit + usage.completionTokens * out) / 1_000_000;
  return Math.round(yuan * 10000) / 10000;
}

/** 去空白、统一常见标点、转小写：「门铃 坏了。」和「门铃坏了」算同一句 */
export function normalizeForCache(text: string): string {
  return String(text || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[，,。.！!？?；;：:、~～]+$/g, '')
    .replace(/，/g, ',')
    .replace(/。/g, '.')
    .replace(/！/g, '!')
    .replace(/？/g, '?')
    .replace(/：/g, ':')
    .replace(/；/g, ';');
}

/** 服务商 usage 字段 → 统一形状；DeepSeek 多给的 prompt_cache_hit_tokens 也收进来 */
export function readUsage(raw: unknown): LlmUsage | null {
  if (!raw || typeof raw !== 'object') return null;
  const u = raw as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0);
  return {
    promptTokens: num(u.prompt_tokens),
    promptCacheHitTokens: num(u.prompt_cache_hit_tokens),
    completionTokens: num(u.completion_tokens),
  };
}

function monthRange(month?: string): { start: Date; end: Date; label: string } {
  const m = /^(\d{4})-(\d{2})$/.exec(month || '');
  const now = new Date();
  const year = m ? Number(m[1]) : now.getFullYear();
  const mon = m ? Number(m[2]) - 1 : now.getMonth();
  // 按东八区的自然月算
  const start = new Date(Date.UTC(year, mon, 1, -8));
  const end = new Date(Date.UTC(year, mon + 1, 1, -8));
  return { start, end, label: `${year}-${String(mon + 1).padStart(2, '0')}` };
}
