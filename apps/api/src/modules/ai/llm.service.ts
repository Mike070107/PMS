import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { SettingsService } from '../settings/settings.service';
import type { AiAssistSetting } from '../settings/settings.constants';

/**
 * 大模型调用的唯一出口。
 *
 * 走 **OpenAI 兼容协议**（POST {baseUrl}/v1/chat/completions）：DeepSeek、通义、智谱、
 * Moonshot、本地 ollama 都认这一套，换服务商只改后台那三个字段，不用改代码。
 * 刻意**不用** response_format: json_object —— 那是 OpenAI/DeepSeek 的扩展，
 * 有的服务商不认会直接报 400。改成在提示词里要求输出 JSON，再宽松解析。
 *
 * 三条铁律，写在这里是因为它们决定了这个服务能不能放进报修主流程：
 *   1. **绝不抛异常影响主流程**。超时、报错、返回乱码，一律返回 null，调用方退回规则结果。
 *   2. **绝不打印 apiKey**。日志里只出现 baseUrl、model 和错误原文。
 *   3. **有超时**。默认 6 秒，现场没人对着转圈等；超了就当没这回事。
 */
@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);

  constructor(private readonly settings: SettingsService) {}

  /** 配置齐了吗（开关开着 + 地址 + 模型 + key）。没配齐就别走 AI 那条路 */
  async isReady(tenantId: number): Promise<boolean> {
    const cfg = await this.settings.getAiAssistRaw(tenantId);
    return !!(cfg.enabled && cfg.baseUrl && cfg.model && cfg.apiKey);
  }

  /**
   * 问一次模型，要一个 JSON 回来。
   *
   * @returns 解析出来的对象；任何一步不顺（没配、超时、非 JSON）都返回 null，
   *          让调用方安静地退回规则结果 —— 报修不能因为模型不灵就交不了单。
   */
  async askJson<T = Record<string, unknown>>(
    tenantId: number,
    system: string,
    user: string,
  ): Promise<T | null> {
    const cfg = await this.settings.getAiAssistRaw(tenantId);
    if (!cfg.enabled || !cfg.baseUrl || !cfg.model || !cfg.apiKey) return null;
    const raw = await this.chat(cfg, system, user);
    if (!raw.ok) {
      // 只记原文，不记 key。现场报「AI 没反应」时，这一行是唯一的线索
      this.logger.warn(`大模型调用失败（${cfg.baseUrl} ${cfg.model}）：${raw.error}`);
      return null;
    }
    return parseJsonLoose<T>(raw.content);
  }

  /**
   * 后台「发送测试」用：把服务商返回的**真实**错误原样带回去。
   * 「调用失败」四个字帮不了任何人 —— 是 key 错了、余额没了还是模型名写错了，
   * 只有原文说得清。
   */
  async testConnection(
    tenantId: number,
    override?: Partial<AiAssistSetting>,
  ): Promise<{ ok: boolean; reply?: string; error?: string; model?: string }> {
    const saved = await this.settings.getAiAssistRaw(tenantId);
    const cfg: AiAssistSetting = { ...saved, ...stripMasked(override) };
    if (!cfg.baseUrl) return { ok: false, error: '还没填接口地址' };
    if (!cfg.model) return { ok: false, error: '还没填模型名' };
    if (!cfg.apiKey) return { ok: false, error: '还没填 API Key' };
    const res = await this.chat(
      cfg,
      '你是连通性测试，只回一个 JSON。',
      '请原样返回 {"ok":true}',
    );
    if (!res.ok) return { ok: false, error: res.error, model: cfg.model };
    return { ok: true, reply: res.content.slice(0, 200), model: cfg.model };
  }

  private async chat(
    cfg: AiAssistSetting,
    system: string,
    user: string,
  ): Promise<{ ok: true; content: string } | { ok: false; error: string }> {
    const url = `${cfg.baseUrl.replace(/\/+$/, '')}/v1/chat/completions`;
    try {
      const res = await axios.post(
        url,
        {
          model: cfg.model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          // 抽取任务要的是稳定，不是创意：同一句话每次都该得到同一个结果
          temperature: 0,
          max_tokens: 500,
          stream: false,
        },
        {
          timeout: cfg.timeoutMs || 6000,
          headers: {
            Authorization: `Bearer ${cfg.apiKey}`,
            'Content-Type': 'application/json',
          },
        },
      );
      const content = res.data?.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim()) {
        return { ok: false, error: `返回里没有 choices[0].message.content：${JSON.stringify(res.data).slice(0, 200)}` };
      }
      return { ok: true, content };
    } catch (err: any) {
      // 服务商的报错正文最有用（余额不足、key 无效、模型不存在都在这儿）
      const body = err?.response?.data;
      const detail =
        (typeof body === 'string' ? body : body && JSON.stringify(body)) || err?.message || String(err);
      const status = err?.response?.status;
      return { ok: false, error: `${status ? `HTTP ${status} ` : ''}${String(detail).slice(0, 300)}` };
    }
  }
}

/** 页面回显的是脱敏串，原样提交回来时当没改 —— 别拿一串圆点去调接口 */
function stripMasked(override?: Partial<AiAssistSetting>): Partial<AiAssistSetting> {
  if (!override) return {};
  const next = { ...override };
  if (typeof next.apiKey === 'string' && (!next.apiKey.trim() || next.apiKey.startsWith('••'))) {
    delete next.apiKey;
  }
  return next;
}

/**
 * 模型说好了输出 JSON，实际常常裹一层 ```json 围栏、或者前后带一句解释。
 * 宽松解析：先直接 parse，不行就把第一个 { 到最后一个 } 之间那段抠出来再试。
 * 还是不行就返回 null，调用方退回规则结果。
 */
export function parseJsonLoose<T>(text: string): T | null {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    /* 往下试抠括号 */
  }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(trimmed.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}
