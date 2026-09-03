import { Injectable, Logger } from '@nestjs/common';
import { LlmService } from './llm.service';

/**
 * 材料入库语音填表：办公室对着「新增材料入库」说一句
 * 「PPR 弯头 25 的要 10 个，单价三块五；再来两卷生料带，一卷两块」，
 * 服务端把它理成一张可编辑的入库明细草稿。
 *
 * **只填表，绝不落库**：识别结果原样交给前端回填表单，数量、单价、SKU 都要人核对后自己提交。
 * 建档同理 —— 匹配不到 SKU 时只标 `needsCreate`，由人在界面上点「建档」并确认类别
 * （类别决定材料编码前缀，编码发出去就锁死了，不能让模型替人选，见
 * InventoryService.buildMaterialCode / assertMaterialUnique）。
 *
 * 为什么单独一个文件而不是塞进 repair-text.ai.ts：那边是「维修工口述完工」，
 * 提示词、字段、下游语义完全不同；而且完工那条链路明确不做 SKU 匹配
 * （AI 不能自动形成用料行、触发扣库存）。入库是反过来的：填的是一张待人工提交的单据，
 * 匹配 SKU 恰恰是这里最省事的地方，两套口径必须分开放，别互相污染。
 */

const RECEIPT_PROMPT = `你是物业仓库的入库单助手。仓管会口述一批刚买回来的材料，你要把它理成结构化的入库明细。

只输出 JSON，不要任何解释文字，格式：
{"items":[{"name":"材料名称","spec":"规格型号","qty":10,"unit":"个","unitPriceYuan":3.5}]}

规则：
- name: 材料本身的名称，去掉规格和数量，例如「PPR 弯头 25 的」→ name「PPR弯头」、spec「25」。
- spec: 口述里提到的型号/规格/尺寸/颜色，没说就给空字符串。**绝不自己编型号**。
  尺寸里的乘号统一写成星号：「50 乘 50」→「50*50」；单位和数字之间不留空格：「DN 50」→「DN50」。
- qty: 数量，只填口述里明确说了的数字；「来两卷」= 2。完全没说数量就给 null。
- unit: 口述里的单位（个/卷/米/桶/套…），没说就给空字符串，不要猜。
- unitPriceYuan: **单价**（元，可带小数），「三块五」= 3.5，「两块」= 2。
  只有明确是单价才填；说的是总价、或没提价格，一律给 null。**绝不自己算单价**。
- 一句话里有几样材料就给几条；同一样材料重复说到就合并成一条。
- 一句都对不上（没提到任何材料）就返回 {"items":[]}。`;

export interface ReceiptMaterialMention {
  name: string;
  spec: string;
  qty: number | null;
  unit: string;
  unitPriceYuan: number | null;
}

export interface ReceiptCatalogItem {
  id: number;
  code: string;
  name: string;
  spec?: string | null;
  unit?: string | null;
  category?: string | null;
}

/** 一行识别结果 + 它在 SKU 库里的落点。match=none 时要人工建档 */
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
  /** exact=名称+规格都对上；candidate=只对上名称或包含关系，要人挑；none=库里没有 */
  match: 'exact' | 'candidate' | 'none';
  /** 库里没有这条 SKU，界面上给「建档」入口（类别仍要人选） */
  needsCreate: boolean;
  /** match=candidate 时把可选的几条一并给出来，人直接点，不用回去搜 */
  candidates: Array<{ materialId: number; code: string; name: string; spec: string; unit: string }>;
}

@Injectable()
export class MaterialReceiptAiService {
  private readonly logger = new Logger(MaterialReceiptAiService.name);

  constructor(private readonly llm: LlmService) {}

  /** 没配大模型 / 调不通时返回 null，端上提示「按原样手工填」，不能因此卡住入库 */
  async parse(tenantId: number, text: string): Promise<ReceiptMaterialMention[] | null> {
    const spoken = text.trim();
    if (!spoken) return [];
    const answer = await this.llm.askJson<{ items?: unknown }>(tenantId, RECEIPT_PROMPT, spoken);
    if (!answer) return null;
    return parseReceiptMentions(answer.items);
  }
}

/** 模型返回的东西一律当不可信输入洗一遍：类型、范围、条数全部收口 */
export function parseReceiptMentions(value: unknown): ReceiptMaterialMention[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((row) => {
      const item = (row ?? {}) as Record<string, unknown>;
      const name = String(item.name ?? '').trim().slice(0, 120);
      if (!name) return null;
      const qty = toPositiveNumber(item.qty);
      const price = toPositiveNumber(item.unitPriceYuan);
      return {
        name,
        spec: String(item.spec ?? '').trim().slice(0, 120),
        qty: qty === null ? null : Number(qty.toFixed(2)),
        unit: String(item.unit ?? '').trim().slice(0, 20),
        unitPriceYuan: price === null ? null : Number(price.toFixed(2)),
      } satisfies ReceiptMaterialMention;
    })
    .filter((item): item is ReceiptMaterialMention => !!item)
    .slice(0, 20);
}

function toPositiveNumber(value: unknown): number | null {
  const num = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  if (!Number.isFinite(num) || num <= 0) return null;
  return num;
}

/**
 * 名称/规格比对前先抹掉标点、空格和「型号/规格」这类口语垫字。
 *
 * 尺寸的乘号要统一：口述是「50 乘 50」，库里写的是「50*50」，不归一就对不上，
 * 于是判成「库里没有」去建档，建出一条重复 SKU —— 线上实测踩到过（2026-09-03）。
 * 只在**数字之间**折叠 乘/x/×/X/*，免得把 box、max 这类词里的 x 也吃掉。
 */
export function normalizeReceiptName(value: string): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/(\d)\s*[乘x×*]\s*(\d)/g, '$1*$2')
    .replace(/[\s·、，,。.（）()【】\[\]\-_/]/g, '')
    .replace(/型号|规格|尺寸/g, '');
}

/**
 * 把识别出的材料落到 SKU 库上。
 *
 * 名称+规格都命中才算 exact（可以放心预选）；只命中名称、或包含关系、
 * 或同名多条规格 → candidate，把候选一起给出来让人点，**不替他选**：
 * 同名不同规格并成一个 SKU 是这个项目踩过的老账（断路器 ¥55/¥20 其实是两种规格）。
 */
export function matchReceiptMaterials(
  mentions: ReceiptMaterialMention[],
  catalog: ReceiptCatalogItem[],
): ReceiptMaterialSuggestion[] {
  return mentions.map((mention) => {
    const wantName = normalizeReceiptName(mention.name);
    const wantSpec = normalizeReceiptName(mention.spec);
    const scored = catalog
      .map((item) => {
        const name = normalizeReceiptName(item.name);
        const spec = normalizeReceiptName(item.spec ?? '');
        if (!name) return { item, score: 0 };
        const nameHit = name === wantName ? 2 : name.includes(wantName) || wantName.includes(name) ? 1 : 0;
        if (!nameHit) return { item, score: 0 };
        // 说了规格就要规格也对得上；没说规格时不因为库里有规格而降级
        const specHit = !wantSpec ? 1 : spec === wantSpec ? 2 : spec.includes(wantSpec) ? 1 : 0;
        if (wantSpec && !specHit) return { item, score: 0 };
        return { item, score: nameHit * 10 + specHit };
      })
      .filter((row) => row.score > 0)
      .sort((a, b) => b.score - a.score || a.item.id - b.item.id);

    const best = scored[0];
    const tie = !!best && scored.some((row, index) => index > 0 && row.score === best.score);
    // score = 名称命中 ×10 + 规格命中。22 = 名称和规格都精确；
    // 21 = 名称精确且规格对得上（或压根没说规格）；≤12 = 只沾上名字，必须人工挑。
    // 同分并列（同名多条规格）一律降级成 candidate —— 同名不同规格是这个项目踩过的老账。
    const isExact = !!best && best.score >= 21 && !tie;
    return {
      spokenName: mention.name,
      spokenSpec: mention.spec,
      qty: mention.qty,
      unit: mention.unit,
      unitPriceCents: mention.unitPriceYuan === null ? null : Math.round(mention.unitPriceYuan * 100),
      materialId: isExact ? best.item.id : null,
      materialCode: isExact ? best.item.code : '',
      materialName: isExact ? best.item.name : '',
      materialSpec: isExact ? best.item.spec ?? '' : '',
      materialUnit: isExact ? best.item.unit ?? '' : '',
      match: !best ? 'none' : isExact ? 'exact' : 'candidate',
      needsCreate: !best,
      candidates: (isExact ? [] : scored.slice(0, 5)).map((row) => ({
        materialId: row.item.id,
        code: row.item.code,
        name: row.item.name,
        spec: row.item.spec ?? '',
        unit: row.item.unit ?? '',
      })),
    } satisfies ReceiptMaterialSuggestion;
  });
}
