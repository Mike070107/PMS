/**
 * 报修描述里「要不要当紧急处理」的判定（服务端这一份）。
 *
 * **与 packages/shared-types/src/urgency.ts 同源，改一处必须同步另一处** ——
 * 端上要即时给用户看「已标为紧急」，服务端要给不带这个字段的请求兜底
 * （老版本小程序、后台录入），两边判出来的结果必须一模一样，
 * 否则用户在小程序上看到红标、提交后单子却不是紧急的。
 * （api 不依赖 @pms/shared-types，同 common/enums.ts 与 shared-types 的既有做法。）
 *
 * 「急修」是物业行业里和「小修 / 大修」并列的档位，说出口就是要求马上派人。
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

export interface UrgencyResult {
  urgent: boolean;
  /** 命中的那个词，写进工单进度里说明「为什么是紧急」 */
  matched: string;
}

/** 认不出就是不紧急：乱标的急单会把真正急的挤下去，比不标更糟 */
export function detectUrgency(text?: string | null): UrgencyResult {
  const raw = String(text || '');
  if (!raw.trim()) return { urgent: false, matched: '' };

  for (const word of URGENT_KEYWORDS) {
    let from = 0;
    for (;;) {
      const at = raw.indexOf(word, from);
      if (at < 0) break;
      from = at + word.length;
      if (NEGATION_BEFORE.test(raw.slice(Math.max(0, at - 4), at))) continue;
      const after = raw.slice(at + word.length, at + word.length + 4);
      if (PART_NAME_AFTER.some((part) => after.startsWith(part))) continue;
      return { urgent: true, matched: word };
    }
  }
  return { urgent: false, matched: '' };
}
