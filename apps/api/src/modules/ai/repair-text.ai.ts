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
}

const SYSTEM_PROMPT = `你是物业报修的填单助手。用户会说一句很口语的话，可能带停顿、重复、语气词。
把它拆成 JSON，只输出 JSON，不要任何解释、不要代码围栏。

字段：
- addressText: 这句话里表示"在哪儿"的原话片段（小区名、几弄、几号、几室、楼道、大门等）。不要补全、不要猜测没说过的信息。唯一允许的改写是把中文数字换成阿拉伯数字："十七号二零一" 写成 "17号201"、"五千五百十一弄" 写成 "5511弄"。没有就给空字符串。
- description: 故障本身，理成一句通顺的话。必须去掉门牌号、人名、电话、催促语（急急急）、客套话（麻烦、谢谢）。保留故障现象和影响（如"居民出不去"）。不要编造原话里没有的细节。
- contactName: 联系人姓名。只有明确说了人名才填（张先生、李阿姨、王师傅）。没说就给空字符串，绝对不要把地址或数字当成姓名。
- phone: 手机号，11位数字。没有就给空字符串。
- urgent: 说话人是否表达了很急（急急急、十万火急、马上、等着用）。布尔值。

例子：
输入：5511弄，236号，502报修电子门里面，旋钮打滑，居民出不来。急急急，13818909545
输出：{"addressText":"5511弄，236号，502","description":"电子门旋钮打滑，居民出不去","contactName":"","phone":"13818909545","urgent":true}

输入：枫桦一期17号201家里灯不亮，联系人张先生，电话13800138000
输出：{"addressText":"枫桦一期17号201","description":"家里灯不亮","contactName":"张先生","phone":"13800138000","urgent":false}

输入：枫桦一期十七号二零一，家里灯不亮了，找张先生，13800138000
输出：{"addressText":"枫桦一期17号201","description":"家里灯不亮","contactName":"张先生","phone":"13800138000","urgent":false}`;

@Injectable()
export class RepairTextAiService {
  constructor(
    private readonly llm: LlmService,
    private readonly samples: ExtractSamplesService,
  ) {}

  /** 没配大模型、调不通、返回不是 JSON —— 一律 null，调用方退回规则结果 */
  async parse(tenantId: number, text: string): Promise<RepairTextAiResult | null> {
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
    const system = await this.buildSystemPrompt(tenantId);
    const raw = await this.llm.askJson<Record<string, unknown>>(tenantId, system, value);
    if (!raw) return null;
    return {
      addressText: str(raw.addressText),
      description: str(raw.description),
      contactName: str(raw.contactName),
      phone: str(raw.phone).replace(/\D/g, ''),
      urgent: raw.urgent === true,
    };
  }

  /** 固定规则 + 样例库拼成的完整提示词。样例取不到就只用固定规则那半截 */
  private async buildSystemPrompt(tenantId: number): Promise<string> {
    let examples: string[] = [];
    try {
      const rows = await this.samples.forPrompt(tenantId);
      examples = rows
        .filter((row) => row.text?.trim() && row.expected && Object.keys(row.expected).length)
        .map((row) => `输入：${row.text.trim()}\n输出：${JSON.stringify(fullShape(row.expected))}`);
    } catch {
      // 样例是加分项，取不到就算了，别让识别整个失效
    }
    if (!examples.length) return SYSTEM_PROMPT;
    const header = '下面是这家物业实际遇到过、并且已经确认过正确的例子，照着这个口径来：';
    return [SYSTEM_PROMPT, header, examples.join('\n\n')].join('\n\n');
  }
}

/** 样例只存要教的字段，喂给模型时补齐成完整形状 —— 缺字段会教出「可以不输出某个字段」 */
function fullShape(expected: Record<string, unknown>): Record<string, unknown> {
  return {
    addressText: typeof expected.addressText === 'string' ? expected.addressText : '',
    description: typeof expected.description === 'string' ? expected.description : '',
    contactName: typeof expected.contactName === 'string' ? expected.contactName : '',
    phone: typeof expected.phone === 'string' ? expected.phone : '',
    urgent: expected.urgent === true,
  };
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}
