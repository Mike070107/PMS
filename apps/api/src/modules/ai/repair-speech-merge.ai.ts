import { Injectable } from '@nestjs/common';
import { LlmService } from './llm.service';

/**
 * 多段口述合并成一句 —— 「按住说话」可以按好几次，后面那几段常常不是补充，而是**改口**。
 *
 * 2026-09-14 Mike 的原话：
 *   ①一期43号大门坏了 ②198弄44号202报修大门坏了 ③说错了是一期40号大门坏
 *   「你应该把这三句话整合起来总结出最终实际要报修的地址是一期40号大门坏」
 *
 * 原来是直接把新的一段拼到后面（`[旧, 新].join('，')`），结果是一句自相矛盾、
 * 带三个门牌的话：派单的人看不出到底去哪儿，地址识别还会撞上**最先**出现的那个门牌 ——
 * 也就是他已经改口不要的那个。人说话本来就会停顿、会犹豫、会说错重说，
 * 这一层就是把「他最后到底要报什么」定下来。
 *
 * 为什么单独一个文件、单独一个 service：
 * - 合并**不吃样例库**（样例是教模型怎么拆字段的，和合并无关），只要 LlmService；
 * - 这样也不用去动 repair-text.ai.ts —— 那个文件常有别的会话在改，
 *   共用 checkout 下少碰一个文件就少一次冲突（见 CLAUDE.md「共用 checkout」那条）。
 */
const MERGE_PROMPT = `你是物业报修的填单助手。维修工按住说话报修，可能分好几次说，
后面几段往往是在**改口更正**前面说错的地方，也可能只是补充。
把这几段合并成**一句**最终要提交的话。

只输出 JSON：{"text":"合并后的那一句"}，不要解释、不要代码围栏。

规则：
- 同一件事以**最后说的**为准：地址、房号、故障、人名、电话，后面提到就覆盖前面的。
- 出现「说错了、不对、应该是、改成、不是…是…、重说」这类更正词时，它后面的内容一律优先。
- 前面说过、后面没有再提的信息要**保留**（先说了电话、后面只改地址，电话要留着）。
- 最终只能有一处地址、一件故障 —— 绝不把两个门牌都写进去。
- 不要编造没说过的信息，也不要替他补全没说过的部分（没说小区名就别加小区名）。
- 删掉口头语、重复和犹豫（「那个」「就是」「等一下」），但门牌数字、人名、电话一个字都不许改。
- 实在合不出确定结果时，宁可原样返回最后一段，也不要拼成两件事。

例子：
输入：
1. 一期43号大门坏了
2. 198弄44号202报修大门坏了
3. 说错了是一期40号大门坏
输出：{"text":"一期40号大门坏了"}

输入：
1. 枫桦一期17号201家里灯不亮
2. 联系人张先生13800138000
输出：{"text":"枫桦一期17号201家里灯不亮，联系人张先生13800138000"}

输入：
1. 二期26号1003门铃不响
2. 不是1003，是1103
输出：{"text":"二期26号1103门铃不响"}`;

/**
 * 合并结果的收口：模型偶尔会把几段原样拼回来，或者返回一句比输入加起来还长的话
 * （自己编了内容）。合并的价值就是「更短、更准」，明显变长的一律不采用。
 *
 * 纯函数，单测锁的就是它 —— 模型输出千变万化，这一层是最后一道闸。
 */
export function acceptMergedSpeech(
  segments: string[],
  merged: string | null | undefined,
): string | null {
  const list = (segments || []).map((item) => String(item || '').trim()).filter(Boolean);
  const value = String(merged || '').trim();
  if (!value || list.length < 2) return null;
  // 和「直接拼起来」一样长甚至更长 = 没合并，用它不如用原来的拼接
  const joined = list.join('，');
  if (value.length >= joined.length) return null;
  // 比最长的那一段还短一大截，多半是把信息丢了（只剩「大门坏了」，地址没了）
  const longest = list.reduce((max, item) => Math.max(max, item.length), 0);
  if (value.length < Math.min(longest, 6)) return null;
  return value;
}

@Injectable()
export class RepairSpeechMergeService {
  constructor(private readonly llm: LlmService) {}

  /**
   * 把多段口述合并成最终要提交的一句。
   *
   * 合不出来（没配大模型、调不通、返回不是 JSON、结果没通过 acceptMergedSpeech）一律 null，
   * 调用方退回原来的「拼在后面」—— 合并只是锦上添花，绝不能让人白说一遍。
   */
  async merge(tenantId: number, segments: string[]): Promise<string | null> {
    const list = (segments || []).map((item) => String(item || '').trim()).filter(Boolean);
    if (list.length < 2) return null;
    const user = list.map((item, index) => `${index + 1}. ${item}`).join('\n');
    const raw = await this.llm.askJson<Record<string, unknown>>(tenantId, MERGE_PROMPT, user, {
      kind: 'repair-merge',
      cacheable: true,
    });
    const text = typeof raw?.text === 'string' ? raw.text : '';
    return acceptMergedSpeech(list, text);
  }
}
