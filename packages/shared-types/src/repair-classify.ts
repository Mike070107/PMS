/**
 * 按描述文字自动判定报修类型。
 * 用租户在后台配好的「猜你想输」关键词当依据 —— 他们平时怎么写，判定就怎么走，
 * 不用另外维护一份分类词表。
 */

export interface ClassifiableType {
  repairType: string;
  label: string;
  keywords: string[];
  /**
   * 「别再按这个词判我」清单，由负样本算出来（端上判成我、人当场改成别的类型 ≥2 次）。
   * 命中就扣掉同等分数 —— 不是直接否决：万一这个词在别处是对的，
   * 让它和其它命中的词去比大小，比一刀切稳。
   */
  negativeKeywords?: string[];
}

export interface ClassifyResult {
  repairType: string;
  label: string;
  /** 命中的关键词，用来告诉用户「为什么判成这个类型」 */
  matched: string[];
  score: number;
}

/** 关键词整词命中最稳；再退一步用「关键词里的双字片段」兜住「水管爆了」这种变体 */
function scoreKeyword(text: string, keyword: string): number {
  const word = keyword.trim();
  if (!word) return 0;
  if (text.includes(word)) return word.length * 2;

  // 「电梯按键失灵」对上「电梯按键坏了」：取关键词里的连续双字去撞
  let hits = 0;
  for (let i = 0; i + 2 <= word.length; i += 1) {
    if (text.includes(word.slice(i, i + 2))) hits += 1;
  }
  // 至少 2 个片段、且覆盖到关键词三分之一以上才算数
  // （「垃圾桶坏了」要能对上「垃圾桶损坏」；单个「电」「水」不能乱撞）
  return hits >= 2 && hits * 3 >= word.length ? hits : 0;
}

/**
 * 返回得分最高的类型；一个关键词都没命中时返回 null，交给调用方兜底成「其它」。
 * 类型名本身（如「电梯相关」里的「电梯」）也参与匹配。
 */
export function classifyRepairType(
  content: string,
  types: ClassifiableType[],
): ClassifyResult | null {
  const text = String(content || '').trim().toLowerCase();
  if (!text || !types.length) return null;

  let best: ClassifyResult | null = null;
  for (const type of types) {
    const matched: string[] = [];
    let score = 0;

    for (const keyword of type.keywords || []) {
      const hit = scoreKeyword(text, keyword.toLowerCase());
      if (hit > 0) {
        score += hit;
        matched.push(keyword);
      }
    }

    // 被人改判过的词：扣掉它带来的分。同一个词既在 keywords 又在 negativeKeywords 时，
    // 净得分为 0，等于这个词不再参与判定 —— 正是我们要的效果。
    for (const keyword of type.negativeKeywords || []) {
      const hit = scoreKeyword(text, keyword.toLowerCase());
      if (hit > 0) {
        score -= hit;
        const at = matched.indexOf(keyword);
        if (at >= 0) matched.splice(at, 1);
      }
    }

    // 「电梯相关」→ 去掉「相关」后的「电梯」也是很强的信号
    const bareLabel = type.label.replace(/相关|问题|类$/g, '').trim();
    if (bareLabel.length >= 2 && text.includes(bareLabel.toLowerCase())) {
      score += bareLabel.length * 2;
      if (!matched.includes(bareLabel)) matched.push(bareLabel);
    }

    if (score > 0 && (!best || score > best.score)) {
      best = { repairType: type.repairType, label: type.label, matched, score };
    }
  }
  return best;
}
