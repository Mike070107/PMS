import { request } from '../request';

/**
 * 大模型辅助的小工具。**每一个都要能在模型不可用时安静退回**：
 * 后台没配、调不通、超时，接口返回 { ok: false }，端上按没有 AI 的老路子走 ——
 * 现场业务不能因为模型不灵就办不成。
 */

/**
 * 完工小结：维修工口述一句「换了个角阀，原来那个锈死了」，
 * 服务端交给大模型理成规范的维修记录。
 *
 * materials 只用于提醒维修工核对；AI 绝不能自动形成用料行或触发库存扣减。
 */
export const completionSummary = (data: { text: string; workOrderId?: number }) =>
  request<{
    ok: boolean;
    actionNote?: string;
    faultLocation?: string;
    faultSymptom?: string;
    materials?: string[];
    feeSuggestion?: {
      ruleCode: string;
      ruleName: string;
      feeCents: number;
      basis: string;
    } | null;
    draft?: Record<string, unknown>;
  }>({ method: 'POST', url: '/ai/completion-summary', data });
