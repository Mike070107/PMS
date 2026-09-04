import { request } from '../request';

/**
 * 材料入库的语音填表。
 *
 * **两个接口都只填表、不落库**：识别结果原样交给端上回填表单，
 * 数量、单价、SKU、类别全部由人核对后走原来的提交接口（POST /materials、
 * POST /goods-receipts/general）。AI 不建档、不入库、不动库存。
 *
 * 单独放一个文件而不是塞进 endpoints/ai.ts：那边是维修工的完工小结（工单权限），
 * 这边是仓管的入库（inventory·edit），两批人、两套权限，别互相牵连。
 */

/** 一行识别出来的材料 + 它在 SKU 库里的落点 */
export interface ReceiptMaterialSuggestion {
  spokenName: string;
  spokenSpec: string;
  qty: number | null;
  unit: string;
  unitPriceCents: number | null;
  materialId: number | null;
  materialCode: string;
  materialName: string;
  materialSpec: string;
  materialUnit: string;
  /** exact=名称+规格都对上，可以直接预选；candidate=要人从候选里挑；none=库里没有，得建档 */
  match: 'exact' | 'candidate' | 'none';
  needsCreate: boolean;
  candidates: Array<{ materialId: number; code: string; name: string; spec: string; unit: string }>;
}

/**
 * 说一句 → 拆成入库明细（名称/型号/数量/单位/单价），并标出每行落在哪条 SKU 上。
 * `ok:false` = 这家公司还没配大模型或调不通，端上照原样手工填，别卡住入库。
 */
export const parseReceipt = (data: { text: string }) =>
  request<{ ok: boolean; reason?: string; items: ReceiptMaterialSuggestion[] }>({
    method: 'POST',
    url: '/ai/material-receipt-parse',
    data,
  });

/** 建档草稿。category 一定是本公司类别档案里的原文，或空串（拿不准就留给人选） */
export interface MaterialProfileDraft {
  name: string;
  spec: string;
  unit: string;
  aliases: string[];
  params: string;
  category: string;
}

/**
 * 说一段 → 材料档案草稿（名称/型号/单位/别名/详细参数/类别）。
 * 类别只会从本公司已有的类别里挑，模型不许自创 —— 类别决定材料编码前缀，发出去就锁死。
 */
export const parseProfile = (data: { text: string }) =>
  request<{
    ok: boolean;
    reason?: string;
    draft: MaterialProfileDraft | null;
    categories?: string[];
  }>({ method: 'POST', url: '/ai/material-profile-parse', data });
