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

export interface UrgencyResult {
  /** 要不要按紧急处理 */
  urgent: boolean;
  /** 命中的那个词，用来告诉用户「为什么标成紧急」；没命中是空串 */
  matched: string;
}

/**
 * 认不出来就是不紧急 —— 宁可漏标也别乱标：
 * 乱标的紧急单会把真正急的那张挤下去，比不标更糟。
 */
export function detectUrgency(text?: string | null): UrgencyResult {
  const raw = String(text || '');
  if (!raw.trim()) return { urgent: false, matched: '' };

  for (const word of URGENT_KEYWORDS) {
    let from = 0;
    for (;;) {
      const at = raw.indexOf(word, from);
      if (at < 0) break;
      from = at + word.length;
      const before = raw.slice(Math.max(0, at - 4), at);
      if (NEGATION_BEFORE.test(before)) continue;
      const after = raw.slice(at + word.length, at + word.length + 4);
      if (PART_NAME_AFTER.some((part) => after.startsWith(part))) continue;
      return { urgent: true, matched: word };
    }
  }
  return { urgent: false, matched: '' };
}

/** 端上「为什么这单成了紧急」的一句话，各页面别各写一套 */
export function urgencyReason(matched: string): string {
  return matched ? `听到你说「${matched}」` : '';
}
