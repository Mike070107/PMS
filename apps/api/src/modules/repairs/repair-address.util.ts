/**
 * 从报修描述里识别地址：「一期24号302」「198弄24号」「二期6号大门关不上」……
 *
 * 思路不是 NLP，而是两步：
 *   1. 正则抽出「N期 / X弄 / Y号 / Z室」候选（这个文件，纯函数可单测）；
 *   2. 拿候选去撞库里真实存在的分期/楼栋/房号（repairs.service.parseRepairAddress）——
 *      撞上了才算识别到，撞不上宁可不填，绝不猜一个地址挂上去。
 *
 * 只说到楼栋就停在楼栋级、别把公区单挂到房号上，这条口径与
 * miniapp 的 utils/place-scope 一致。
 */

export interface RepairAddressCandidate {
  /** 分期，统一成中文写法「一期」；描述里没说就是 null */
  phase: string | null;
  /** 弄的数字部分，如「198」 */
  lane: string | null;
  /** 号的数字部分，如「24」 */
  buildingNo: string | null;
  /** 室号数字部分，如「302」 */
  roomNo: string | null;
  /** 归一化后的命中内容，如「一期24号302室」，给用户看、也用来做「忽略」去重 */
  matchedText: string;
}

const CN_DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

/** 「1期」「12期」→「一期」「十二期」，和小区名里的中文写法对齐 */
export function phaseToCn(raw: string): string {
  if (!/^\d+$/.test(raw)) return raw.replace('两', '二');
  const n = Number(raw);
  if (n <= 0 || n > 19) return raw;
  if (n < 10) return CN_DIGITS[n];
  return n === 10 ? '十' : `十${CN_DIGITS[n - 10]}`;
}

const PHASE_RE = /([一二三四五六七八九十两\d]{1,3})期/;
const LANE_RE = /(\d{1,4})弄/;
/** 「24号」但不是「24号码」；「号楼/栋」的后缀吞掉 */
const BUILDING_RE = /(\d{1,4})号(?!码)(?:楼|栋)?/g;
/**
 * 「XX号」前面两个字是这些词时，号不是门牌号：车位 24 号、工号 8 号……
 * （「门牌24号」是真地址，不拦）
 */
const NO_PREFIX_BLACKLIST = new Set([
  '车位', '车牌', '电话', '手机', '编号', '工号', '单号', '卡号', '证号', '房号',
]);
/** 显式室号：302室 / 302房 */
const ROOM_EXPLICIT_RE = /(\d{1,5})\s*[室房](?![屋子])/;

/**
 * 抽出地址候选。至少要有「N期」或「Y号」之一才算候选；
 * 只有一个孤零零的数字（「3个灯泡」）不算。
 */
export function extractAddressCandidate(text: string): RepairAddressCandidate | null {
  const value = String(text || '').trim();
  if (!value) return null;

  const phaseMatch = PHASE_RE.exec(value);
  const phase = phaseMatch ? phaseToCn(phaseMatch[1]) + '期' : null;
  const laneMatch = LANE_RE.exec(value);
  const lane = laneMatch ? laneMatch[1] : null;

  let buildingNo: string | null = null;
  let roomNo: string | null = null;
  BUILDING_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = BUILDING_RE.exec(value))) {
    const before = value.slice(Math.max(0, m.index - 2), m.index);
    if (NO_PREFIX_BLACKLIST.has(before)) continue;
    buildingNo = m[1];
    // 紧跟在「Y号」后面的 3-4 位数字当室号：「24号302」。
    // 两位以下的裸数字歧义太大（24号3 可能是 3 楼、3 个），必须带「室」才认。
    const rest = value.slice(m.index + m[0].length);
    const bareRoom = /^(\d{3,4})(?!\d)/.exec(rest);
    if (bareRoom) roomNo = bareRoom[1];
    break;
  }
  if (!roomNo) {
    const explicit = ROOM_EXPLICIT_RE.exec(value);
    if (explicit) roomNo = explicit[1];
  }

  if (!phase && !buildingNo) return null;
  // 室号必须挂在楼栋号下面才有意义；只说「302室」没法定位到哪栋楼
  if (!buildingNo) roomNo = null;

  const matchedText = [
    phase ?? '',
    lane ? `${lane}弄` : '',
    buildingNo ? `${buildingNo}号` : '',
    roomNo ? `${roomNo}室` : '',
  ].join('');
  return { phase, lane, buildingNo, roomNo, matchedText };
}

/** 「024」和「24」当同一个号；楼栋表里存的是数字串，这里统一成十进制比较 */
export function sameNo(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = String(a ?? '').replace(/[号栋楼弄室房]/g, '').trim();
  const right = String(b ?? '').replace(/[号栋楼弄室房]/g, '').trim();
  if (!left || !right) return false;
  if (left === right) return true;
  return /^\d+$/.test(left) && /^\d+$/.test(right) && Number(left) === Number(right);
}

// ---------------- 类型纠错的关键词候选 ----------------

/** 这些字出现在词里基本是句子成分而不是名词，不适合当关键词 */
const CANDIDATE_STOP_CHARS = /[的了吗吧呢啊呀哦嘛么我你他她它这那哪请帮谢麻烦师傅一二三四五六七八九十]/;

/**
 * 管理员更正工单类型时，从描述里挑出可以「学」进新类型的候选词。
 *
 * 做法：先把地址片段（期/弄/号/室）和数字剥掉，剩下的中文按 2-3 字滑窗切词，
 * 含原类型命中关键词字符的排前面 —— 典型场景是「门」误判进门窗类，
 * 候选里的「大门」就排在最前，管理员点一下就把「大门」学进公共设施类。
 * 这里只出候选，学不学、学哪个由管理员决定（半自动，可解释可撤销）。
 */
export function extractKeywordCandidates(
  content: string,
  matchedOldKeywords: string[],
  limit = 8,
): string[] {
  const stripped = String(content || '')
    // 地址片段和数字对分类没有意义，先剥掉，免得「24号」被切成候选
    .replace(/[0-9０-９]+\s*[期弄号栋楼室房]?/g, ' ')
    .replace(/[一二三四五六七八九十两]+[期弄号栋楼室]/g, ' ');
  const runs = stripped.split(/[^一-龥]+/).filter((run) => run.length >= 2);
  const oldChars = new Set(matchedOldKeywords.join(''));

  const seen = new Set<string>();
  const scored: Array<{ word: string; score: number }> = [];
  for (const run of runs) {
    for (const size of [2, 3]) {
      for (let i = 0; i + size <= run.length; i += 1) {
        const word = run.slice(i, i + size);
        if (seen.has(word) || CANDIDATE_STOP_CHARS.test(word)) continue;
        seen.add(word);
        let score = 0;
        // 和误判来源沾边的词优先：那正是要「掰过来」的词
        if ([...word].some((ch) => oldChars.has(ch))) score += 4;
        // 靠前的词更可能是主语（坏的东西在句子开头说）
        if (i === 0) score += 2;
        // 双字词优先：更像名词，配置页里也更通用
        if (size === 2) score += 1;
        scored.push({ word, score });
      }
    }
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((item) => item.word);
}

/**
 * 「198/47/201」「198弄47号201室」「198-47-201」→ ['198', '47', '201']。
 * 和 packages/shared-types/src/address.ts 的 tokenizeAddress 同一套切分规则（API 不依赖那个包，这里抄一份），
 * 工单池搜索按段依次模糊匹配 楼栋(弄/号)+房号。改规则两边一起改。
 */
export function tokenizeAddress(input: string): string[] {
  return input
    .trim()
    .replace(/[弄号室栋幢座楼单元]/g, '/')
    .split(/[/\\-—－_·,，、。:：;；#＃\s]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}
