/**
 * 报修描述里「要不要当紧急处理」的判定（服务端这一份）。
 *
 * **与 packages/shared-types/src/urgency.ts 同源，改一处必须同步另一处** ——
 * 端上要即时给用户看「已标为紧急」，服务端要给不带这个字段的请求兜底
 * （老版本小程序、后台录入），两边判出来的结果必须一模一样，
 * 否则用户在小程序上看到红标、提交后单子却不是紧急的。
 * （api 不依赖 @pms/shared-types，同 common/enums.ts 与 shared-types 的既有做法。）
 *
 * 认的是四类话（2026-08-31 按用户要求扩到后两类）：
 *   1. 明确的档位词：急修 / 紧急 / 加急 / 特急 / 抢修 / 火急
 *      （「急修」是物业行业里和「小修 / 大修」并列的档位）；
 *   2. 连着喊的「急急」「急急急」；
 *   3. 单字「急」——「急！」「我很急」「急死了」；
 *   4. 有人被关在里面：「居民出不来」「电梯困人」。
 *
 * 两类必须排除的假阳性：否定（「不用急修」）、零件名（「电梯紧急呼叫按钮坏了」）。
 */

/** 判成紧急的说法；「马上 / 赶紧」这类语气词几乎每单都有，收进来等于全是紧急，不收 */
export const URGENT_KEYWORDS = ['急修', '紧急', '加急', '特急', '抢修', '火急'];

/** 命中词前面出现这些字 = 在说「不用急」 */
const NEGATION_BEFORE = /(不|别|没|无须|无需|勿|非)[^，。,.；;、\s]{0,2}$/;

/** 命中词后面跟着这些字 = 这是零件的名字（紧急呼叫按钮、紧急照明），不是在催 */
const PART_NAME_AFTER = [
  '呼叫', '按钮', '按键', '开关', '照明', '灯', '出口', '通道', '疏散',
  '广播', '联系人', '联络人', '电话', '预案', '演练',
];

/** 连着写的「急急」「急急急」：整串当命中词回显，只回一个「急」看着像认错了 */
const REPEATED_URGENT_RE = /急{2,}/;

/**
 * 单字「急」。除否定外再挡两类「这个急字不是在催」的词：
 *   前面挨着：应急（照明/电源）、紧急（上面已有词条并带零件名过滤，别从这里绕过去）；
 *   后面挨着：急救 / 急诊 / 急停按钮 / 急速 / 急促 / 急转 / 急弯。
 */
const BARE_URGENT = '急';
const BARE_URGENT_SKIP_BEFORE = ['应', '紧'];
const BARE_URGENT_SKIP_AFTER = ['救', '诊', '停', '速', '促', '转', '弯', '刹', '剧'];

/**
 * 有人被关在里面。「出不来」必须挨着人才算：
 * 「热水出不来」是最常见的报修话之一，不卡主语等于天天误标。
 */
const TRAPPED_SUBJECT =
  '居民|业主|住户|租户|老太太|老太|老人|老伯|孩子|小孩|乘客|客人|保姆|人';
const TRAPPED_ACTION =
  '出不来|出不去|出不了|进不来|下不来|上不去|被困|困住|困在|关在|锁在';
const TRAPPED_RE = new RegExp(
  `(?:${TRAPPED_SUBJECT})[^，。,.；;、\s]{0,4}(?:${TRAPPED_ACTION})`,
);
/** 行业固定说法，本身带了「人」，不用再卡主语 */
const TRAPPED_WORDS = ['困人', '关人'];

export interface UrgencyResult {
  urgent: boolean;
  /** 命中的那个词，写进工单进度里说明「为什么是紧急」 */
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

/** 在原话里找 word，逐个命中位置排掉否定和零件名 */
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

/** 认不出就是不紧急：乱标的急单会把真正急的挤下去，比不标更糟 */
export function detectUrgency(text?: string | null): UrgencyResult {
  const raw = String(text || '');
  if (!raw.trim()) return { urgent: false, matched: '' };

  const trapped = TRAPPED_RE.exec(raw);
  if (trapped) return { urgent: true, matched: trapped[0] };
  for (const word of TRAPPED_WORDS) {
    if (raw.includes(word)) return { urgent: true, matched: word };
  }

  const repeated = REPEATED_URGENT_RE.exec(raw);
  if (
    repeated &&
    !isNegated(raw.slice(Math.max(0, repeated.index - 4), repeated.index))
  ) {
    return { urgent: true, matched: repeated[0] };
  }

  for (const word of URGENT_KEYWORDS) {
    if (hasUrgentHit(raw, word, PART_NAME_AFTER, [])) return { urgent: true, matched: word };
  }

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
