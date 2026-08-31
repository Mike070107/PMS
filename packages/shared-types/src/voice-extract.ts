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

/**
 * 手机号：**前后都不能再挨着数字**。
 * 没有这两个边界时，语音多听出一位的「138000138000」会被截成前 11 位
 * 「13800013800」—— 一个能通过校验的错号码，维修工照着打过去是空号。
 * 位数不对就宁可不填，让人自己补（2026-08-31 实际踩过）。
 */
const MOBILE_RE = /(?<!\d)1[3-9]\d{9}(?!\d)/;
/** 座机：区号 3-4 位 + 号码 7-8 位，可带分隔符。同样卡死前后边界 */
const TEL_RE = /(?<!\d)0\d{2,3}-?\d{7,8}(?!\d)/;

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
    // 「找不到开关」曾被认成联系人「不到开关」：以停用词开头的一律不算
    const startsWithStopword = candidate
      ? [...NAME_STOPWORDS].some((w) => candidate.startsWith(w))
      : false;
    if (candidate && !startsWithStopword && !NAME_PREFIX_NOISE.has(candidate[0])) {
      out.name = candidate;
      out.nameText = labeledHit![0];
    }
  }

  return out;
}

/**
 * 从一句话里剥掉已经被认走的部分，剩下的才是「故障描述」。
 *
 * 「业主张先生报修一期47号大门关不上电话13800138000」——
 * 地址、联系人、电话各自认走之后，描述只该剩「大门关不上」。
 * 原来是整句话原样落进故障描述，语气词、人名、电话号全在里面，
 * 后台看单的人要自己在一堆字里找故障是什么。
 *
 * 剥的顺序：先剥认出来的原文片段（地址 matchedText / phoneText / nameText），
 * 再剥它们留下的标签词（「电话」「联系人」「业主」「报修」……），
 * 最后剥语音识别带进来的语气词和头尾标点。剥完少于 2 个字就退回原话 —— 宁可多也别空。
 */
export function extractFaultDescription(
  raw: string,
  removals: { addressText?: string; phoneText?: string; nameText?: string } = {},
): string {
  let text = String(raw || '').trim();
  if (!text) return '';
  const original = text;

  // 1) 认出来的原文片段整段去掉（地址那段可能带「一期 47 号」这类空格，宽松匹配）
  for (const piece of [removals.addressText, removals.phoneText, removals.nameText]) {
    const p = String(piece || '').trim();
    if (!p) continue;
    const UNIT = '期弄号室楼栋幢单元';
    const loose = p
      .split('')
      .map((ch) => {
        const esc = ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // 「室」「号」这类单位字原话里常省略（说「17号201」，matchedText 是「17号201室」）
        return UNIT.includes(ch) ? `(?:${esc})?` : esc;
      })
      // 数字之间允许夹着原话里的「楼」「2单元」和标点（「5号楼2单元301」对「5号301室」）
      .join('(?:[\\s，,、]|号楼|楼|栋|幢|\\d*单元)*');
    // 地址后面紧跟的「楼 / 室 / 的」是地址的尾巴，一起剥（「3号楼电梯坏了」→「电梯坏了」）
    text = text.replace(new RegExp(`${loose}(?:号楼|楼|栋|幢|单元|室|的)?`), ' ');
  }
  /* 电话没被认出但仍是一串数字（阿拉伯或中文报号）：也不该留在描述里。
     这里**故意比 MOBILE_RE 宽松**，两者目的不同：
       MOBILE_RE 严格卡 11 位 + 前后边界，是为了「宁可不填也不给错号」；
       这里只是清描述 —— 多听/少听一位的残串同样该整串剥掉。
     用严格的 11 位正则会在「138000138000」（语音多听一位）里只吃掉前 11 位，
     把孤零零一个 0 留在描述里，变成「家里灯不亮，0」（2026-08-31 实测）。
     所以按「≥10 位连续数字」整串剥：房号是 17号201 这种被单位字隔开的短数字，
     不会误伤。 */
  text = text
    .replace(/(?<!\d)\d(?:[\s\-]*\d){9,}(?!\d)/g, ' ')
    .replace(/[零〇一幺二两三四五六七八九]{7,}/g, ' ');

  // 2) 标签词：这些词只是在引出人/电话/地址，本身不是故障
  text = text
    .replace(/(联系电话|联系方式|电话号码|手机号码|手机号|电话|手机|号码)(是|为|：|:)?/g, ' ')
    .replace(/(联系人|户主|业主|住户|租户|物业|保安|居委会|业委会)(是|为|：|:)?/g, ' ')
    .replace(/(来?报修的?|报的修|报了个修|报个修|报的|报单|反映|投诉|说是|说的)/g, ' ')
    // 人名被剥掉后留下的引导词：「找 ，门铃坏了」「 的说厨房水龙头…」
    //   「找 / 叫 / 联系」只在后面已经空了（人名刚被剥掉）时才是孤字，「找不到开关」不能动
    .replace(/(^|[，,、\s])(找|叫|联系|通知)(?=[，,、\s]|$)/g, '$1')
    .replace(/(^|[，,、\s])(的)?(说|讲|反映)(是|的)?(?=[一-龥，,、\s]|$)/g, '$1')
    // 「麻烦帮忙过来看一下」「请尽快派人修一下」「谢谢」：整段都是客套，不是故障
    .replace(/(麻烦|请|帮忙|希望|尽快|赶紧|抓紧|派人|派个人|安排人|安排|能不能|可不可以)+(过来|来|上门|上来)?(看一下|看一看|看看|看下|修一下|修修|修下|修理一下|修理|处理一下|处理下|处理|弄一下|弄下|解决一下|解决下|解决)?/g, ' ')
    .replace(/(谢谢|麻烦了|辛苦了|拜托了|拜托)/g, ' ')
    .replace(/(地址是|地址|位置是|位置)(：|:)?/g, ' ');

  // 3) 语气词、口头禅：语音识别会把它们一字不落写进来
  text = text
    .replace(/(呃|嗯|啊|哦|哎|呀|吧|呢|嘛|喔|唉|那个|就是|然后|反正|其实|的话)/g, ' ')
    .replace(/[，,。.、；;！!？?\s]+/g, (m) => (/[，,、；;]/.test(m) ? '，' : /[。.！!？?]/.test(m) ? '。' : ' '))
    .replace(/\s+/g, '')
    .replace(/^[，。]+|[，。]+$/g, '')
    .replace(/，{2,}/g, '，')
    .replace(/，。|。，/g, '。');

  // 剥过头了就退回原话：描述空着比带点噪音更糟
  return text.replace(/[，。]/g, '').length >= 2 ? text : original;
}

// ---------------- 认出来的人/电话怎么合进表单 ----------------

/** 表单里联系人两个字段的当前状态 */
export interface ContactFormState {
  name: string;
  phone: string;
  /** 当前这个值是「登录人默认值」，不是用户手填的 —— 描述里认出别人时可以顶掉 */
  nameIsDefault: boolean;
  phoneIsDefault: boolean;
  /** 用户手动改过：自动识别一律不许再动 */
  nameTouched: boolean;
  phoneTouched: boolean;
}

export interface ContactMergeResult {
  /** 要写回表单的值；这一轮没变化的字段不出现 */
  name?: string;
  phone?: string;
  /** 合并后这两个字段还算不算「默认值」，调用方要存回去 */
  nameIsDefault: boolean;
  phoneIsDefault: boolean;
  /** 「已从描述里认出…」提示里的短语 */
  filled: string[];
  /** 默认联系人被清掉了：电话换成了别人的，但这句话里没说是谁 */
  clearedName: boolean;
}

/**
 * 把描述里认出的联系人/电话合进表单当前值 —— 判断口径的唯一出处，
 * 新增「一句话填单」的入口直接引这里，别各写一套。
 *
 * 三条老规矩：
 *   1. 用户手改过的绝不覆盖；
 *   2. 空着的、或者只是登录人默认值的，让描述里认出的人顶掉；
 *   3. 认不出就不动。
 *
 * 2026-08-31 补的第四条 —— **电话换人了，默认联系人必须一起清空**：
 * 代报的人说「一期17号201漏水，电话13800138000」，电话被顶成业主的号，
 * 联系人却还留着登录的保安/维修工自己的名字，工单上就成了
 * 「张保安 138xxxx（业主的号）」这种拼出来的假联系人 —— 维修工照着名字喊人，
 * 开门的是另一个人。既然电话已经不是默认那个人的了，那个名字也就一定不对，
 * 宁可空着让人补填，也不能留一个错的。
 */
export function mergeExtractedContact(
  extracted: ExtractedContact,
  state: ContactFormState,
): ContactMergeResult {
  const out: ContactMergeResult = {
    nameIsDefault: state.nameIsDefault,
    phoneIsDefault: state.phoneIsDefault,
    filled: [],
    clearedName: false,
  };
  const canFillName = !state.nameTouched && (!state.name || state.nameIsDefault);
  const canFillPhone = !state.phoneTouched && (!state.phone || state.phoneIsDefault);

  if (extracted.name && canFillName) {
    if (extracted.name !== state.name) {
      out.name = extracted.name;
      out.filled.push(`联系人 ${extracted.name}`);
    }
    out.nameIsDefault = false;
  }

  // 电话从「登录人的默认号」被换成了描述里那个号 —— 这单的联系人已经换人了
  const phoneTookOverDefault =
    !!extracted.phone &&
    canFillPhone &&
    state.phoneIsDefault &&
    extracted.phone !== state.phone;

  if (extracted.phone && canFillPhone) {
    if (extracted.phone !== state.phone) {
      out.phone = extracted.phone;
      out.filled.push(`电话 ${extracted.phone}`);
    }
    out.phoneIsDefault = false;
  }

  if (phoneTookOverDefault && !extracted.name && canFillName && state.name && state.nameIsDefault) {
    out.name = '';
    out.nameIsDefault = false;
    out.clearedName = true;
  }

  return out;
}

/** 「自动填了什么」的那一句提示，各入口别各写一套 */
export function contactFillHint(result: ContactMergeResult): string {
  const parts: string[] = [];
  if (result.filled.length) parts.push(`已从描述里认出${result.filled.join('、')}，不对可直接改`);
  // 清空是「我把原来那个人删了」，必须说出来，不然用户以为是自己不小心删的
  if (result.clearedName) parts.push('电话不是你本人的，联系人已清空，请填写实际联系人');
  return parts.join('；');
}
