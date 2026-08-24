/**
 * 从「一句话」里抽出联系人和电话。
 *
 * 场景：维修工/保安按住说话，一口气说「一期24号大门门铃坏了，找张师傅，13812345678」，
 * 系统要自己把联系人、电话、地址、类型都填好，人只做核对。
 * 地址交给各端的 address-detect，类型交给 classifyRepairType，这里只管人和电话。
 *
 * 两个前提决定了实现方式：
 * 1. 语音识别出来的电话经常是中文数字（「一三八……」），必须先转成阿拉伯数字；
 * 2. 识别结果没有标点，「找张师傅13812345678」是连在一起的，所以靠模式而不是分词。
 *
 * 抽取到的原文片段（phoneText/nameText）一并返回，端上可以据此标出「这几个字被认成电话了」，
 * 认错时用户一眼能看出来。
 */

/** 中文数字 → 阿拉伯数字。「幺」在报号时就是 1 */
const CN_DIGITS: Record<string, string> = {
  零: '0', 〇: '0', 一: '1', 幺: '1', 二: '2', 两: '2', 三: '3', 四: '4',
  五: '5', 六: '6', 七: '7', 八: '8', 九: '9',
};

/** 把连续 ≥7 个中文数字的串转成阿拉伯数字，其余原样保留（不能把「二期」也转了） */
export function normalizeSpokenDigits(text: string): string {
  const cn = Object.keys(CN_DIGITS).join('');
  return String(text || '').replace(
    new RegExp(`[${cn}]{7,}`, 'g'),
    (run) => run.split('').map((ch) => CN_DIGITS[ch] ?? ch).join(''),
  );
}

/** 手机号里常见的分隔符：说的时候会断开成 138 1234 5678 */
function joinSpacedDigits(text: string): string {
  return String(text || '').replace(/(?<=\d)[\s\-—－·]+(?=\d)/g, '');
}

const MOBILE_RE = /1[3-9]\d{9}/;
/** 座机：区号 3-4 位 + 号码 7-8 位，可带分隔符 */
const TEL_RE = /0\d{2,3}-?\d{7,8}/;

/** 称谓式：张师傅、李女士、王阿姨。姓最多取 3 个字，多出来的前缀在下面剥掉 */
const TITLES = '先生|女士|师傅|阿姨|大爷|大妈|太太|老师|经理|主任|队长';
const NAME_TITLE_RE = new RegExp(`([一-龥]{1,3})(${TITLES})`);

/**
 * 称谓前面粘着的字：「找张师傅」「联系人李女士」「业主王先生」。
 * 不剥掉就会把动词/标签当成姓的一部分（实测抽出过「找张师傅」「人李女士」）。
 */
const NAME_PREFIX_NOISE = new Set([
  '找', '人', '主', '系', '联', '叫', '姓', '给', '位', '的', '是', '和', '跟', '户', '业', '让', '请',
]);

/** 从「找张」这样的片段里剥出真正的姓；剥完只剩噪声就当没认出来 */
function cleanSurname(raw: string): string {
  let name = raw;
  while (name.length > 1 && NAME_PREFIX_NOISE.has(name[0])) name = name.slice(1);
  // 复姓最多两个字，再长就是把前面的话吃进来了
  if (name.length > 2) name = name.slice(-2);
  return NAME_PREFIX_NOISE.has(name) ? '' : name;
}
/** 明示式：联系人张三 / 找李四 / 户主王五 */
const NAME_LABELED_RE = /(?:联系人|联系电话是|联系|户主|业主|找|叫|姓)\s*[：:]?\s*([一-龥]{2,4})/;

/** 明示式容易把动词后面的词误当人名，这些一律不算 */
const NAME_STOPWORDS = new Set([
  '物业', '维修', '师傅', '不到', '不着', '过来', '一下', '人来', '我们', '你们',
  '他们', '这里', '那里', '楼上', '楼下', '隔壁', '业主', '保安', '电话', '手机',
]);

export interface ExtractedContact {
  /** 规范化后的号码，可直接填进表单 */
  phone?: string;
  /** 号码在原话里的样子，用来提示「这段被认成电话」 */
  phoneText?: string;
  name?: string;
  nameText?: string;
}

/**
 * 抽联系人和电话。抽不到就不返回对应字段 —— 宁可不填，也不要瞎猜后让人去改。
 */
export function extractContact(raw: string): ExtractedContact {
  const text = String(raw || '').trim();
  if (!text) return {};

  const out: ExtractedContact = {};

  // 电话：先把中文数字和分隔符规整掉再找，找到后回原文定位片段
  const normalized = joinSpacedDigits(normalizeSpokenDigits(text));
  const phoneHit = MOBILE_RE.exec(normalized) || TEL_RE.exec(normalized);
  if (phoneHit) {
    out.phone = phoneHit[0];
    // 原话里可能是「138 1234 5678」或中文数字，回去找一段宽松匹配用于提示
    const loose = new RegExp(
      phoneHit[0].split('').map((d) => `${d}[\s\-—－·]*`).join(''),
    ).exec(text);
    out.phoneText = (loose ? loose[0] : phoneHit[0]).trim();
  }

  // 联系人：称谓式最可靠（张师傅），其次是明示式（联系人张三）
  const titleHit = NAME_TITLE_RE.exec(text);
  const surname = titleHit ? cleanSurname(titleHit[1]) : '';
  if (titleHit && surname) {
    out.name = surname + titleHit[2];
    out.nameText = out.name;
  } else {
    const labeledHit = NAME_LABELED_RE.exec(text);
    const candidate = labeledHit?.[1]?.trim();
    if (candidate && !NAME_STOPWORDS.has(candidate) && !NAME_PREFIX_NOISE.has(candidate[0])) {
      out.name = candidate;
      out.nameText = labeledHit![0];
    }
  }

  return out;
}
