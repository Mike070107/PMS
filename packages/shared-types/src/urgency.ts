/**
 * 从报修描述里认「这单要不要当紧急处理」。
 *
 * 来由：业主/保安按住说话时会直接说「这个要急修」——「急修」是物业行业里
 * 和「小修 / 大修」并列的档位，说出口就是要求马上派人。以前这句话只是躺在
 * 描述文本里，派单的人得逐条读才看得见，工单上没有任何标记。
 *
 * 判定放在这里、不放在某个页面里：报修有五个入口（业主端随手拍 / 一键报修、
 * 员工端随手拍 / 我要报修、后台录入），逐个写一套一定会漏。端上引这里做即时展示，
 * 服务端建单时再用同一份口径兜一次底（老版本小程序、后台录入都靠它）。
 *
 * 认的是四类话（2026-08-31 按用户要求扩到后两类）：
 *   1. 明确的档位词：急修 / 紧急 / 加急 / 特急 / 抢修 / 火急；
 *   2. 连着喊的「急急」「急急急」；
 *   3. 单字「急」——「急！」「我很急」「急死了」；
 *   4. 有人被关在里面：「居民出不来」「电梯困人」——一个急字都没有，却最急。
 *
 * 两类必须排除的假阳性，都是实际会说出口的话：
 *   1. 否定：「不急修」「不用抢修」「不算紧急」——命中词前面挂着「不/别/没/无需」；
 *   2. 部件名：「电梯紧急呼叫按钮坏了」「紧急照明不亮」——「紧急」是这东西的名字，
 *      跟着的是「按钮/照明/出口」这类零件词，不是在催。
 */

/**
 * 判成紧急的说法。只收「明确在要求加急」的词：
 * 「马上」「赶紧」「快点」这类语气词几乎每单都有人说，收进来等于所有单都是紧急，
 * 红标一多就没人看了，所以不收。
 */
export const URGENT_KEYWORDS = ['急修', '紧急', '加急', '特急', '抢修', '火急'] as const;

/** 命中词前面出现这些字 = 在说「不用急」，别标 */
const NEGATION_BEFORE = /(不|别|没|无须|无需|勿|非)[^，。,.；;、\s]{0,2}$/;

/** 命中词后面跟着这些字 = 这是个零件的名字（紧急呼叫按钮、紧急照明），不是在催 */
const PART_NAME_AFTER = [
  '呼叫', '按钮', '按键', '开关', '照明', '灯', '出口', '通道', '疏散',
  '广播', '联系人', '联络人', '电话', '预案', '演练',
];

/**
 * 连着写的「急急」「急急急」。单独认是为了把**整串**当成命中词回显
 * （「听到你说『急急急』」），只回一个「急」看着像认错了。
 */
const REPEATED_URGENT_RE = /急{2,}/;

/**
 * 单字「急」。「急！」「我很急」「急死了」在实际报修里就是在催人。
 *
 * 它比其它词容易误伤，所以除了否定规则，再挡两类「这个急字不是在催」的词：
 *   前面挨着：应急（照明/电源）、紧急（上面已有专门词条并带零件名过滤，
 *             从这里放行等于绕过那道过滤）；
 *   后面挨着：急救 / 急诊 / 急停按钮 / 急速 / 急促 / 急转 / 急弯。
 */
const BARE_URGENT = '急';
const BARE_URGENT_SKIP_BEFORE = ['应', '紧'];
const BARE_URGENT_SKIP_AFTER = ['救', '诊', '停', '速', '促', '转', '弯', '刹', '剧'];

/**
 * 有人被关在里面。这类话里一个「急」字都没有，却比说三遍急修都急
 * （2026-08-31 用户举的例子：「居民出不来」）。
 *
 * 「出不来」**必须挨着人**才算：「热水出不来」「水出不来」是最常见的报修话之一，
 * 不卡主语等于天天误标，红标一泛滥就没人当真了。
 */
const TRAPPED_SUBJECT =
  '居民|业主|住户|租户|老太太|老太|老人|老伯|孩子|小孩|乘客|客人|保姆|人';
const TRAPPED_ACTION =
  '出不来|出不去|出不了|进不来|下不来|上不去|被困|困住|困在|关在|锁在';
/** 主语和动作之间还能夹几个字：「有人在里面出不来」 */
const TRAPPED_RE = new RegExp(
  `(?:${TRAPPED_SUBJECT})[^，。,.；;、\s]{0,4}(?:${TRAPPED_ACTION})`,
);
/** 行业固定说法，本身就带了「人」，不用再卡主语 */
const TRAPPED_WORDS = ['困人', '关人'];

export interface UrgencyResult {
  /** 要不要按紧急处理 */
  urgent: boolean;
  /** 命中的那个词，用来告诉用户「为什么标成紧急」；没命中是空串 */
  matched: string;
}

/**
 * 「打不开」「关不上」「出不来」里的「不」是可能补语，在描述故障本身，不是在说「不用急」。
 * 不排掉它，「大门打不开了急急」「大门关不上急修」会被当成否定，整单漏标
 * （2026-08-31 写「急急」用例时发现，老版本就有）。判否定前先把这类片段换成分隔符。
 */
const COMPLEMENT_BU = /[一-龥]不[开上来去下动了住到见出进好掉走响通亮着起过]/g;

/** 命中词前面这一小段，是不是真的在说「不用急」 */
function isNegated(before: string): boolean {
  return NEGATION_BEFORE.test(before.replace(COMPLEMENT_BU, '，'));
}

/** 在原话里找 word，逐个命中位置排掉否定和零件名；都排掉就算没命中 */
function hasUrgentHit(
  raw: string,
  word: string,
  skipAfter: string[],
  skipBefore: string[],
): boolean {
  let from = 0;
  for (;;) {
    const at = raw.indexOf(word, from);
    if (at < 0) return false;
    from = at + word.length;
    const before = raw.slice(Math.max(0, at - 4), at);
    if (isNegated(before)) continue;
    if (skipBefore.some((ch) => before.endsWith(ch))) continue;
    const after = raw.slice(at + word.length, at + word.length + 4);
    if (skipAfter.some((part) => after.startsWith(part))) continue;
    return true;
  }
}

/**
 * 认不出来就是不紧急 —— 宁可漏标也别乱标：
 * 乱标的紧急单会把真正急的那张挤下去，比不标更糟。
 */
export function detectUrgency(text?: string | null): UrgencyResult {
  const raw = String(text || '');
  if (!raw.trim()) return { urgent: false, matched: '' };

  // 1) 有人被困：最该先认出来的一类，回显原话里的那一句
  const trapped = TRAPPED_RE.exec(raw);
  if (trapped) return { urgent: true, matched: trapped[0] };
  for (const word of TRAPPED_WORDS) {
    if (raw.includes(word)) return { urgent: true, matched: word };
  }

  // 2) 连着喊的「急急急」：整串当命中词
  const repeated = REPEATED_URGENT_RE.exec(raw);
  if (
    repeated &&
    !isNegated(raw.slice(Math.max(0, repeated.index - 4), repeated.index))
  ) {
    return { urgent: true, matched: repeated[0] };
  }

  // 3) 明确的档位词
  for (const word of URGENT_KEYWORDS) {
    if (hasUrgentHit(raw, word, PART_NAME_AFTER, [])) return { urgent: true, matched: word };
  }

  // 4) 单字「急」兜底
  if (
    hasUrgentHit(
      raw,
      BARE_URGENT,
      [...PART_NAME_AFTER, ...BARE_URGENT_SKIP_AFTER],
      BARE_URGENT_SKIP_BEFORE,
    )
  ) {
    return { urgent: true, matched: BARE_URGENT };
  }

  return { urgent: false, matched: '' };
}

/** 端上「为什么这单成了紧急」的一句话，各页面别各写一套 */
export function urgencyReason(matched: string): string {
  return matched ? `听到你说「${matched}」` : '';
}
