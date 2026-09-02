import { Injectable } from '@nestjs/common';
import { ExtractSamplesService } from './extract-samples.service';
import { LlmService } from './llm.service';

/**
 * 一句话报修的语义整理。
 *
 * **分工是这样定的**（2026-09-01）：模型只做「哪一段是什么」和「把口语理顺」，
 * 不做任何需要查库的事。
 *   · 门牌、房号 → 规则 + 房产库。模型不知道你的库，它会编一个看着合理的房号，
 *     而地址编错的代价是师傅按门牌找过去、白跑一趟。所以模型给的地址只当**线索**，
 *     一律拿回去 extractAddressCandidate + 撞库，撞不上就不采信（见 repairs.service）。
 *   · 电话 → 规则。严格 11 位、宁可不填也不给错号，这一条模型帮不上忙。
 *   · 描述、联系人姓名、哪一段是地址 → 模型。这才是正则永远追不完的地方：
 *     今天补了逗号，明天来一句「就那个五千五百十一弄」又不行了。
 */
export interface RepairTextAiResult {
  /** 地址那一段的原话，如「5511弄，236号，502」。只当线索，仍要撞库 */
  addressText?: string;
  /** 理顺后的故障描述，只留故障本身：「电子门旋钮打滑，居民出不去」 */
  description?: string;
  /** 联系人姓名。原话里没说人名就不要编，留空 */
  contactName?: string;
  /** 联系电话。仍以规则抽到的为准，这里只作交叉验证 */
  phone?: string;
  /** 是不是催得很急（「急急急」「等着用」这类） */
  urgent?: boolean;
  /**
   * 坏的东西在**公共区域**（门口机、单元门、楼道、电梯…）还是户内。
   *
   * 报修人会连着自己的门牌一起说：「5511弄278号503报门口机没有反应」——
   * 503 是他住哪儿，不是坏在哪儿。判成公区后服务端会把地址落到楼栋级，
   * 房号转去当联系人标识（见 repairs.service 的 parseRepairAddress）。
   */
  publicArea?: boolean;
  /** 报修类型编码。只能取本次提示词给出的租户有效类型；规则明确命中时仍以规则为准 */
  repairType?: string;
}

export interface RepairTypePromptOption {
  repairType: string;
  label: string;
  /** 后台“猜你想输”里明确配置的生效关键词，优先级最高 */
  configuredKeywords?: string[];
  /** 类型名和同义词扩展出的辅助关键词 */
  keywords?: string[];
  /** 已被人工改判验证为不应归入此类型的词 */
  negativeKeywords?: string[];
}

/**
 * AI 调用前先跑一次租户自己的关键词口径。
 * 明确配置的“猜你想输”词权重远高于系统同义词；分数相同时保持后台类型顺序。
 */
export function matchRepairTypeKeywords(
  text: string,
  repairTypes: RepairTypePromptOption[],
): string {
  const value = String(text || '').trim().toLowerCase();
  if (!value) return '';
  let bestType = '';
  let bestScore = 0;
  for (const item of repairTypes) {
    const blocked = new Set((item.negativeKeywords || []).map((word) => word.trim().toLowerCase()));
    let score = 0;
    for (const word of item.configuredKeywords || []) {
      const key = word.trim().toLowerCase();
      if (key.length >= 2 && value.includes(key)) score += key.length * 100;
    }
    for (const word of item.keywords || []) {
      const key = word.trim().toLowerCase();
      if (key.length >= 2 && !blocked.has(key) && value.includes(key)) score += key.length;
    }
    if (score > bestScore) {
      bestScore = score;
      bestType = item.repairType;
    }
  }
  return bestType;
}

const SYSTEM_PROMPT = `你是物业报修的填单助手。用户会说一句很口语的话，可能带停顿、重复、语气词。
把它拆成 JSON，只输出 JSON，不要任何解释、不要代码围栏。

字段：
- addressText: 这句话里表示"在哪儿"的原话片段（小区名、几弄、几号、几室、楼道、大门等）。不要补全、不要猜测没说过的信息。唯一允许的改写是把中文数字换成阿拉伯数字："十七号二零一" 写成 "17号201"、"五千五百十一弄" 写成 "5511弄"。没有就给空字符串。
- description: 故障本身，理成一句通顺的话。必须去掉门牌号、人名、电话、催促语（急急急）、客套话（麻烦、谢谢）。保留故障现象和影响（如"居民出不去"）。不要编造原话里没有的细节。
- contactName: 联系人姓名。只有明确说了人名才填（张先生、李阿姨、王师傅）。没说就给空字符串，绝对不要把地址或数字当成姓名。
- phone: 手机号，11位数字。没有就给空字符串。
- urgent: 说话人是否表达了很急（急急急、十万火急、马上、等着用）。布尔值。
- publicArea: 坏的东西在公共区域还是在住户家里。布尔值。
  判断的是"**坏的东西**在哪"，不是"说话人住哪"。报修人常常连自己的门牌一起说，
  那个门牌只是他的住址：说"278号503报门口机没反应"，门口机在单元门口，publicArea 就是 true。
  公共区域的东西：门口机/可视对讲/单元门/门禁/道闸、电梯、楼道、楼道灯、路灯、监控、
  水泵房、配电箱、垃圾房、车库、外墙、绿化、井盖。
  住户家里的东西：家里的灯、马桶、水管、热水器、入户门锁、阳台、厨房卫生间里的东西。
  说了"我家""家里"的一律按住户家里算。
- repairType: 报修类型编码。必须从本提示词后面给出的「本项目可用报修类型」中选择；无法确定时给空字符串。
  先看坏的是哪一种设备，再看故障动作。明确设备词优先于泛词：门铃、门口机、可视对讲、
  门禁属于智能化；入户门锁、锁芯、钥匙、窗户才属于门锁/门窗。
  「打不开门」「家里」只是故障/位置，不能把明确说出的「门铃」改成「门锁」。
  publicArea 和 repairType 是两件事：住户家里的门铃可以是 publicArea=false，但类型仍是智能化。

例子：
输入：5511弄，236号，502报修电子门里面，旋钮打滑，居民出不来。急急急，13818909545
输出：{"addressText":"5511弄，236号，502","description":"电子门旋钮打滑，居民出不去","contactName":"","phone":"13818909545","urgent":true,"publicArea":true,"repairType":"__SMART_TYPE__"}

输入：5511弄278号503报门口机没有反应18201728748
输出：{"addressText":"5511弄278号503","description":"门口机没有反应","contactName":"","phone":"18201728748","urgent":false,"publicArea":true,"repairType":"__SMART_TYPE__"}

输入：枫桦一期17号201家里灯不亮，联系人张先生，电话13800138000
输出：{"addressText":"枫桦一期17号201","description":"家里灯不亮","contactName":"张先生","phone":"13800138000","urgent":false,"publicArea":false,"repairType":"__ELECTRIC_TYPE__"}

输入：枫桦一期十七号二零一，家里灯不亮了，找张先生，13800138000
输出：{"addressText":"枫桦一期17号201","description":"家里灯不亮","contactName":"张先生","phone":"13800138000","urgent":false,"publicArea":false,"repairType":"__ELECTRIC_TYPE__"}

输入：枫桦景苑二期25号303家里门铃打不开门
输出：{"addressText":"枫桦景苑二期25号303","description":"家里门铃打不开门","contactName":"","phone":"","urgent":false,"publicArea":false,"repairType":"__SMART_TYPE__"}`;

const COMPLETION_PROMPT = `你是物业维修的完工记录助手。维修工刚干完活，站在现场口述做了什么，话很随意、有口头禅。
把它整理成办公室和业主都看得懂的记录，只输出 JSON，不要解释、不要代码围栏。

字段：
- actionNote: 维修说明，业主会看到。写清做了什么处理，一到两句，用书面语。不要编造原话里没有的动作和结果；没修成（人不在家、缺料）就如实写没修成和原因。
- faultLocation: 故障位置（厨房水槽下方、三楼楼道）。原话没说就给空字符串。
- faultSymptom: 故障现象（接头老化渗水、角阀锈死）。原话没说就给空字符串。
- materials: 他提到用了哪些材料，数组元素形如 {"name":"角阀","qty":1,"unit":"只"}。
  原话明确说了数量才填数字；「换了个/装了一只」可记为 1；完全没说数量就把 qty 设为 null。
  **换掉的、装上的东西本身就是用料**："换了个角阀" → 角阀；"接了段PVC管" → PVC管。
  别因为已经写进 actionNote 就不列了 —— 这一栏会自动加进用料清单，漏一样就是账不平。
  纯动作（紧固、清理、复位）不算用料。没提到任何材料就给空数组。
- feeRuleCode: 只能从后面给出的「本项目维修收费规则」选择编码。只有口述内容明确符合某条规则才选；
  不确定、没提供规则或说了免费时给空字符串。绝对不要自己计算或编造金额。

例子：
输入：换了个角阀，原来那个锈死了，顺手把水管接头缠了生料带
输出：{"actionNote":"更换角阀一只；水管接头加缠生料带","faultLocation":"","faultSymptom":"角阀锈蚀卡死","materials":[{"name":"角阀","qty":1,"unit":"只"},{"name":"生料带","qty":null,"unit":""}],"feeRuleCode":""}`;

/** 完工小结里从口述抽出的材料提及；后续还必须匹配真实 SKU */
export interface CompletionMaterialMention {
  name: string;
  qty: number | null;
  unit: string;
}

export interface CompletionFeeRuleOption {
  code: string;
  name: string;
  repairType?: string | null;
  keywords?: string[];
  feeCents: number;
}

/**
 * 收费建议的第二道校验：模型选了编码还不够，原话/整理结果必须命中规则关键词。
 * 没写关键词的规则只有在本场景仅剩一条时才可采用，避免多条模糊规则由模型随便挑。
 */
export function validateCompletionFeeRule(
  code: string,
  rules: CompletionFeeRuleOption[],
  text: string,
): CompletionFeeRuleOption | null {
  if (!code || /(?:免费|不收费|免单|不收钱)/.test(text)) return null;
  const rule = rules.find((item) => item.code === code);
  if (!rule) return null;
  const keywords = (rule.keywords || []).map((item) => item.trim()).filter(Boolean);
  if (!keywords.length) return rules.length === 1 ? rule : null;
  const normalized = text.toLowerCase().replace(/\s+/g, '');
  return keywords.some((word) => normalized.includes(word.toLowerCase().replace(/\s+/g, '')))
    ? rule
    : null;
}

export interface CompletionSummary {
  actionNote: string;
  faultLocation: string;
  faultSymptom: string;
  /** 他提到的材料和明确数量；是否能形成草稿行由真实材料库唯一匹配决定 */
  materials: CompletionMaterialMention[];
  /** 只返回收费规则编码，金额必须由服务端从规则表回填 */
  feeRuleCode: string;
}

@Injectable()
export class RepairTextAiService {
  constructor(
    private readonly llm: LlmService,
    private readonly samples: ExtractSamplesService,
  ) {}

  /** 没配大模型、调不通、返回不是 JSON —— 一律 null，调用方退回规则结果 */
  async parse(
    tenantId: number,
    text: string,
    repairTypes: RepairTypePromptOption[] = [],
  ): Promise<RepairTextAiResult | null> {
    const value = (text || '').trim();
    // 太短的话规则法足够了，不值得多花一次调用和 1~2 秒延迟
    if (value.length < 6) return null;
    /**
     * 提示词 = 固定规则 + **样例库**。
     *
     * 样例库在数据库里、后台能加（ai_extract_samples）：遇到一种没见过的说法，
     * 办公室自己加一条「这么说 → 应该这么认」就行，不用改代码重新发版
     * （2026-09-01 用户要求：已经处理过的正例要让 AI 记住，别每次重讲一遍规则）。
     * 拿不到样例（库挂了、还没灌种子）也不影响 —— 固定规则那部分照常工作。
     */
    const keywordRepairType = matchRepairTypeKeywords(value, repairTypes);
    // 固定样例不能写死 smart/electric：租户可以把类型编码命名成 menjing 等任意值。
    // 先从本租户类型与关键词中找到对应编码，再替换样例占位符，避免样例反过来教模型
    // 返回一个“不在本项目可用类型里”的编码。
    const typeCode = (pattern: RegExp, keywordPattern: RegExp) =>
      repairTypes.find((item) =>
        pattern.test(item.label) ||
        [...(item.configuredKeywords || []), ...(item.keywords || [])]
          .some((word) => keywordPattern.test(word)),
      )?.repairType || '';
    const tenantPrompt = SYSTEM_PROMPT
      .replaceAll('__SMART_TYPE__', typeCode(/智能|弱电|门禁|对讲/, /门铃|门禁|对讲|门口机/))
      .replaceAll('__ELECTRIC_TYPE__', typeCode(/电相关|电气|强电/, /灯不亮|跳闸|插座|漏电/));
    const typeContext = repairTypes.length
      ? [
          '本项目可用报修类型（repairType 必须返回冒号前的编码，不要返回名称）：',
          ...repairTypes.map((item) =>
            `- ${item.repairType}: ${item.label}`
            + `；物业明确配置的“猜你想输”关键词=${JSON.stringify(item.configuredKeywords || [])}`
            + `；系统辅助关键词=${JSON.stringify(item.keywords || [])}`
            + `；排除词=${JSON.stringify(item.negativeKeywords || [])}`,
          ),
          keywordRepairType
            ? `系统已先按物业配置关键词明确命中：${keywordRepairType}。repairType 必须采用这个编码；模型只负责整理其他字段。`
            : '系统关键词未明确命中，请结合设备语义从上述类型中选择；不能确定就返回空字符串。',
        ].join('\n')
      : '本项目没有提供可用报修类型；repairType 返回空字符串。';
    const system = await this.buildSystemPrompt(
      tenantId,
      `${tenantPrompt}\n\n${typeContext}`,
      'repair',
    );
    const raw = await this.llm.askJson<Record<string, unknown>>(tenantId, system, value);
    if (!raw) return null;
    const allowedTypes = new Set(repairTypes.map((item) => item.repairType));
    const repairType = keywordRepairType || str(raw.repairType);
    return {
      addressText: str(raw.addressText),
      description: str(raw.description),
      contactName: str(raw.contactName),
      phone: str(raw.phone).replace(/\D/g, ''),
      urgent: raw.urgent === true,
      publicArea: raw.publicArea === true,
      repairType: allowedTypes.has(repairType) ? repairType : '',
    };
  }

  /**
   * 完工小结：维修工站在现场说一句，理成办公室和业主都看得懂的维修记录。
   *
   * 和一句话报修同一套路数、同一个样例库（kind='completion'）。
   * **模型只理文字，不碰要落库的东西** —— 模型先抽出材料名和明确说过的数量，
   * 服务端再拿真实材料库做名称/别名匹配。只有唯一精确命中才给端上形成草稿行，
   * 最终仍由维修工确认后随完工事务扣库存。
   */
  async summarizeCompletion(
    tenantId: number,
    text: string,
    feeRules: CompletionFeeRuleOption[] = [],
  ): Promise<CompletionSummary | null> {
    const value = (text || '').trim();
    if (value.length < 4) return null;
    const feeContext = feeRules.length
      ? [
          '本项目维修收费规则（feeRuleCode 只能返回冒号前编码，金额由系统回填）：',
          ...feeRules.map(
            (rule) => `- ${rule.code}: ${JSON.stringify({
              name: rule.name,
              feeYuan: (rule.feeCents / 100).toFixed(2),
              repairType: rule.repairType || '',
              keywords: rule.keywords || [],
            })}`,
          ),
        ].join('\n')
      : '本项目没有配置维修收费规则；feeRuleCode 必须返回空字符串。';
    const system = await this.buildSystemPrompt(
      tenantId,
      `${COMPLETION_PROMPT}\n\n${feeContext}`,
      'completion',
    );
    const raw = await this.llm.askJson<Record<string, unknown>>(tenantId, system, value);
    if (!raw) return null;
    return {
      actionNote: str(raw.actionNote),
      faultLocation: str(raw.faultLocation),
      faultSymptom: str(raw.faultSymptom),
      materials: parseMaterialMentions(raw.materials),
      feeRuleCode: feeRules.some((rule) => rule.code === str(raw.feeRuleCode))
        ? str(raw.feeRuleCode)
        : '',
    };
  }

  /** 固定规则 + 样例库拼成的完整提示词。样例取不到就只用固定规则那半截 */
  private async buildSystemPrompt(tenantId: number, base: string, kind: string): Promise<string> {
    let examples: string[] = [];
    try {
      const rows = await this.samples.forPrompt(tenantId, kind);
      examples = rows
        .filter((row) => row.text?.trim() && row.expected && Object.keys(row.expected).length)
        .map((row) => `输入：${row.text.trim()}\n输出：${JSON.stringify(fullShape(row.expected))}`);
    } catch {
      // 样例是加分项，取不到就算了，别让识别整个失效
    }
    if (!examples.length) return base;
    const header = '下面是这家物业实际遇到过、并且已经确认过正确的例子，照着这个口径来：';
    return [base, header, examples.join('\n\n')].join('\n\n');
  }
}

/** 样例只存要教的字段，喂给模型时补齐成完整形状 —— 缺字段会教出「可以不输出某个字段」 */
function fullShape(expected: Record<string, unknown>): Record<string, unknown> {
  // 完工小结的样例只补它自己那几个字段：把报修的字段混进去会教偏
  if ('actionNote' in expected || 'faultLocation' in expected || 'faultSymptom' in expected) {
    return {
      actionNote: typeof expected.actionNote === 'string' ? expected.actionNote : '',
      faultLocation: typeof expected.faultLocation === 'string' ? expected.faultLocation : '',
      faultSymptom: typeof expected.faultSymptom === 'string' ? expected.faultSymptom : '',
      // 样例里教了用料就照着教；写死空数组等于教它「永远别输出用料」
      materials: Array.isArray(expected.materials)
        ? expected.materials.map((item) =>
            typeof item === 'string' ? { name: item, qty: null, unit: '' } : item,
          )
        : [],
      feeRuleCode: typeof expected.feeRuleCode === 'string' ? expected.feeRuleCode : '',
    };
  }
  return {
    addressText: typeof expected.addressText === 'string' ? expected.addressText : '',
    description: typeof expected.description === 'string' ? expected.description : '',
    contactName: typeof expected.contactName === 'string' ? expected.contactName : '',
    phone: typeof expected.phone === 'string' ? expected.phone : '',
    urgent: expected.urgent === true,
    publicArea: expected.publicArea === true,
    // 老样例没有这个字段时不硬填一个类型；新建/种子样例都会明确携带。
    ...(typeof expected.repairType === 'string' && expected.repairType
      ? { repairType: expected.repairType }
      : {}),
  };
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function parseMaterialMentions(value: unknown): CompletionMaterialMention[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === 'string') return { name: item.trim(), qty: null, unit: '' };
      if (!item || typeof item !== 'object') return null;
      const row = item as Record<string, unknown>;
      const qty = Number(row.qty);
      return {
        name: str(row.name),
        qty: Number.isFinite(qty) && qty > 0 && qty <= 999 ? qty : null,
        unit: str(row.unit).slice(0, 20),
      };
    })
    .filter((item): item is CompletionMaterialMention => !!item?.name)
    .slice(0, 8);
}

export interface CompletionMaterialCatalogItem {
  id: number;
  name: string;
  spec?: string | null;
  unit?: string;
  aliases?: string[];
}

/**
 * 模型只抽出口语材料名；真正的 SKU 在服务端按名称/别名匹配。
 * 只有完全命中才允许端上自动形成草稿行，包含关系只展示候选、必须人工点选。
 */
export function matchCompletionMaterials(
  mentions: CompletionMaterialMention[],
  catalog: CompletionMaterialCatalogItem[],
) {
  return mentions.map((mention) => {
    const wanted = normalizeMaterialName(mention.name);
    const ranked = catalog
      .map((item) => {
        const names = [item.name, ...(item.aliases || [])]
          .map(normalizeMaterialName)
          .filter(Boolean);
        const exact = names.some((name) => name === wanted);
        const partial = !exact && names.some((name) => name.includes(wanted) || wanted.includes(name));
        return { item, score: exact ? 2 : partial ? 1 : 0 };
      })
      .filter((row) => row.score > 0)
      .sort((a, b) => b.score - a.score || a.item.id - b.item.id);
    const best = ranked[0];
    const ambiguous = !!best && ranked.some(
      (row, index) => index > 0 && row.score === best.score && row.item.id !== best.item.id,
    );
    return {
      spokenName: mention.name,
      qty: mention.qty,
      unit: mention.unit,
      materialId: best?.item.id ?? null,
      materialName: best?.item.name ?? '',
      spec: best?.item.spec ?? '',
      catalogUnit: best?.item.unit ?? '',
      match: !best ? 'none' : best.score === 2 && !ambiguous ? 'exact' : 'candidate',
      needsConfirmation: !best || best.score !== 2 || ambiguous || mention.qty == null,
    };
  });
}

function normalizeMaterialName(value: string): string {
  return value.toLowerCase().replace(/[\s·（）()\-_型号规格]/g, '');
}
