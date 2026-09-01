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
 * materials 保留给老版本显示；新版本读 materialSuggestions。
 * 只有名称/别名唯一精确命中且数量明确时才形成草稿行，真正扣库存仍在人工提交之后。
 */
export interface CompletionMaterialSuggestion {
  spokenName: string;
  qty: number | null;
  unit: string;
  materialId: number | null;
  materialName: string;
  spec: string;
  catalogUnit: string;
  match: 'exact' | 'candidate' | 'none';
  needsConfirmation: boolean;
}

export const completionSummary = (data: { text: string; workOrderId?: number }) =>
  request<{
    ok: boolean;
    actionNote?: string;
    faultLocation?: string;
    faultSymptom?: string;
    materials?: string[];
    materialSuggestions?: CompletionMaterialSuggestion[];
    feeSuggestion?: {
      ruleCode: string;
      ruleName: string;
      feeCents: number;
      basis: string;
    } | null;
    draft?: Record<string, unknown>;
  }>({ method: 'POST', url: '/ai/completion-summary', data });
