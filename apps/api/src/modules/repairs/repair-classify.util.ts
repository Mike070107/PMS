/**
 * 报修类型的关键词推导与判定。
 *
 * 背景：判定关键词原先只有一个来源——后台「猜你想输」里配的常用短语。
 * 租户自建的类型（如「门铃 / 对讲 / 门禁 /监控 / 道闸 问题」「外墙渗水」）
 * 那份列表是空的，于是不管业主写什么都判成「其它」。
 *
 * 现在关键词由三层叠出来，租户一个字都不用配：
 *   1. 后台配的常用短语（有就用，租户说了算）
 *   2. 类型名本身切出来的词——「门铃 / 对讲 / 门禁 /监控 / 道闸」这种标题
 *      本来就是一串关键词，切开直接能用
 *   3. 同义词扩展——业主嘴里的「刷卡」对上物业术语「门禁」
 *
 * 这份列表通过 GET /repair-types 的 keywords 下发给小程序，
 * 所以已经发布的小程序不用重新上传也会跟着变聪明。
 */

/**
 * 同义词组：组内任意一个词出现在某类型的关键词里，整组都并进去。
 * 只收「一看就属于这一类」的词；像「打不开」「进不去」这种家里门锁和门禁都可能，
 * 收进来只会把判定搅浑，宁可判不出交给物业核对。
 */
const SYNONYM_GROUPS: string[][] = [
  // 门禁 / 智能化。
  // 「电子门 / 自动门 / 旋转门」是小区大门那套电控门，坏了要找弱电（智能化）的师傅，
  // 不是修家里门锁的木工。2026-08-31 用户报的「电子门旋转打滑」一个关键词都没撞上，
  // 整单落到了「其它」，所以把这批门体设备的叫法一并收进来。
  // 「玻璃门」故意不收：单元门那块玻璃碎了是门窗/公共设施的活，收进来会把它抢过来。
  ['门禁', '刷卡', '门卡', '门禁卡', '感应卡', '磁卡', '刷不开', '刷不上', '刷不了',
    '电子门', '自动门', '电动门', '旋转门', '感应门', '平移门', '伸缩门',
    '门禁机', '门口机', '读卡器', '人脸识别', '刷脸', '梯控'],
  ['对讲', '可视对讲', '楼宇对讲', '对讲机', '室内机', '分机'],
  ['门铃', '按铃', '呼叫器', '门铃不响'],
  ['监控', '摄像头', '摄像机', '探头', '录像'],
  ['道闸', '抬杆', '起杆', '落杆', '闸机', '挡杆', '车牌识别', '车牌'],
  // 电梯
  ['电梯', '轿厢', '困人', '梯门', '楼层显示'],
  // 水。「漏水」和「渗水」必须分成两组：租户把「外墙渗水」单列成一类，
  // 混在一组会让「厨房漏水」同时命中水和外墙，分数打平只能看排序，很脆
  ['漏水', '滴水', '漏个不停', '一直滴水'],
  ['渗水', '洇水', '返潮', '泛潮'],
  ['水管', '爆管', '水管爆'],
  ['堵塞', '堵了', '返水', '反水', '下水慢', '不下水'],
  ['马桶', '坐便', '抽水马桶'],
  ['水龙头', '龙头', '花洒'],
  // 电
  ['跳闸', '空开', '断路器', '保险丝', '电闸', '推不上'],
  ['插座', '五孔', '面板没电'],
  ['漏电', '电麻手', '漏电保护'],
  // 门窗
  ['门锁', '锁芯', '锁舌', '钥匙', '反锁'],
  ['窗户', '窗子', '推拉窗', '窗扇'],
  ['纱窗', '纱网'],
  ['玻璃', '玻璃碎', '玻璃裂'],
  // 家电
  ['空调', '不制冷', '不制热', '空调外机'],
  ['油烟机', '抽油烟机', '排烟'],
  ['洗衣机', '不脱水', '不甩干'],
  ['燃气灶', '煤气灶', '灶台', '打不着火'],
  ['热水器', '不出热水'],
  // 公共设施
  ['楼道', '走廊', '过道'],
  ['井盖', '窨井盖', '沙井盖'],
  ['绿化', '树枝', '修剪', '草坪', '花坛'],
  ['垃圾桶', '垃圾箱', '果皮箱'],
  ['路面', '地砖', '路面破损', '地面塌陷'],
  // 外墙
  ['外墙', '墙面', '墙体', '外立面'],
];

/** 类型名里的分隔符：「门铃 / 对讲 / 门禁 /监控 / 道闸 问题」切成五个词 */
const LABEL_SPLIT = /[/\\、，,。·|｜\s]+/;
/** 切出来后的收尾词，去掉不影响语义 */
const LABEL_TAIL = /(相关|问题|类)$/;
/** 切出来后没有区分度的词，留着只会乱撞 */
const LABEL_NOISE = new Set(['其它', '其他', '问题', '相关', '维修', '报修']);

/** 从类型名里切关键词：「家里门锁/门窗相关」→ 家里门锁、门窗 */
export function labelKeywords(label: string): string[] {
  return String(label || '')
    .split(LABEL_SPLIT)
    .map((part) => part.replace(LABEL_TAIL, '').trim())
    // 一个字的词（「水相关」切出来的「水」）谁都能撞上，不要
    .filter((part) => part.length >= 2 && !LABEL_NOISE.has(part));
}

/** 同义词扩展：关键词里出现「门禁」，就把「刷卡/门卡/…」一并算成这个类型的词 */
export function expandSynonyms(seeds: string[]): string[] {
  const out = [...seeds];
  const joined = seeds.join('|');
  for (const group of SYNONYM_GROUPS) {
    if (!group.some((word) => joined.includes(word))) continue;
    for (const word of group) {
      if (!out.includes(word)) out.push(word);
    }
  }
  return out;
}

/** 一个报修类型最终参与判定的全部关键词 */
export function buildTypeKeywords(rule: {
  label: string;
  contentSuggestions?: string[] | null;
}): string[] {
  const seeds: string[] = [];
  for (const word of [...(rule.contentSuggestions ?? []), ...labelKeywords(rule.label)]) {
    const text = String(word ?? '').trim();
    if (text && !seeds.includes(text)) seeds.push(text);
  }
  return expandSynonyms(seeds);
}

/**
 * 服务端兜底判定：小程序没传类型时用它，别让工单一路躺到「其它」。
 * 这里只做整词包含匹配 —— 关键词已经是「刷卡」「门禁」这种短词，
 * 不需要小程序端那套模糊片段匹配（那套是为了边打字边给提示，宁可宽一点）。
 */
export function classifyByKeywords(
  content: string,
  types: Array<{ repairType: string; keywords: string[] }>,
): string | null {
  const text = String(content || '').trim().toLowerCase();
  if (!text) return null;

  let bestType: string | null = null;
  let bestScore = 0;
  for (const type of types) {
    let score = 0;
    for (const keyword of type.keywords || []) {
      const word = keyword.trim().toLowerCase();
      // 越长的词命中越有说服力：「电梯困人」压过单个「电梯」
      if (word.length >= 2 && text.includes(word)) score += word.length;
    }
    if (score > bestScore) {
      bestScore = score;
      bestType = type.repairType;
    }
  }
  return bestType;
}
