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
 * materials 只是**提示**他提到了哪些材料，不会自动填进用料清单 ——
 * 库存要扣的是具体 SKU，模型说的「角阀」对不上哪一条，得他自己从库存里选。
 */
export const completionSummary = (data: { text: string }) =>
  request<{
    ok: boolean;
    actionNote?: string;
    faultLocation?: string;
    faultSymptom?: string;
    materials?: string[];
  }>({ method: 'POST', url: '/ai/completion-summary', data });
