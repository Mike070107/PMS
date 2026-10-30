/**
 * 抄表 OCR 结果解析：把 OCR 的零散文本框变成「一个读数 + 可能的表号」。
 *
 * 现场照片的难点不是认字，而是**知道哪个数字才是读数**：
 * 水表照片里有 GB/T778-2018、Q3、R=80；电表照片里有 3×220/380V、6400imp/kWh、
 * 2013年、厂家电话。单纯「取最长的数字」会把规格当读数。
 *
 * 这里的策略：
 * 1. 同一行的框按 x 拼起来（电表液晶屏的 0224 和 1888 常被切成两个框）；
 * 2. 只保留 3 位以上数字串，按建档时定好的整数/小数位判断像不像读数；
 * 3. 位数正好匹配的候选优先，OCR 分数只作次要依据；
 * 4. 表号单独找，排除读数本身，宁可返回多个候选让人确认，也不猜。
 *
 * 这一层是纯函数，不碰网络和数据库，便于用真实照片的 OCR 输出做回归。
 */

export interface OcrBoxItem {
  text: string;
  score: number;
  /** [x1, y1, x2, y2]，原图像素 */
  box?: number[];
}

export interface MeterOcrParseOptions {
  integerDigits: number;
  decimalDigits: number;
  width?: number;
  height?: number;
  /** 已建档的表号：用于从候选里挑出与档案一致的那个 */
  meterNoHint?: string;
}

export interface MeterOcrCandidate {
  digits: string;
  value: number | null;
  score: number;
  text: string;
  /** true = 数字里明确有小数点 */
  explicitDecimal: boolean;
  /** OCR 框，用于判断两个候选是不是同一行/同一块屏 */
  box?: number[];
}

export interface MeterOcrParsed {
  digits: string | null;
  value: number | null;
  confidence: number;
  meterNo: string | null;
  meterNoCandidates: string[];
  texts: string;
  candidates: MeterOcrCandidate[];
  needsReview: boolean;
}

const MAX_READING_DIGITS = 12;

/** 全角数字 / OCR 常见形近字归一化；只用于「找数字」，原文仍完整保留在 texts 里 */
export function normalizeOcrText(input: string): string {
  let out = '';
  for (const ch of String(input ?? '')) {
    const code = ch.charCodeAt(0);
    if (code >= 0xff10 && code <= 0xff19) {
      out += String.fromCharCode(code - 0xff10 + 48);
      continue;
    }
    if (/\d/.test(ch)) {
      out += ch;
      continue;
    }
    if (ch === '.' || ch === '．' || ch === '·') {
      out += '.';
      continue;
    }
    if (ch === ',' || ch === '，' || ch === ' ') {
      out += ' ';
      continue;
    }
    // 七段数码管/点阵屏上容易混淆的字母。只映射这几种，别把 GB/T 里的 B 也变成 8
    // —— 规格行本来就该被位数规则排除，映射了反而多出假候选。
    if (ch === 'O' || ch === 'o' || ch === 'D') out += '0';
    else if (ch === 'I' || ch === 'l' || ch === '|' || ch === 'i') out += '1';
    else if (ch === 'Z' || ch === 'z') out += '2';
    else if (ch === 'S' || ch === 's') out += '5';
    else if (ch === 'G' || ch === 'g') out += '6';
    else out += ch;
  }
  return out;
}

/** 表号比较：去掉空格、横杠、点，统一大写；只比字母数字 */
export function normalizeMeterNo(value: string | null | undefined): string {
  const compact = String(value ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  // 铭牌上常写成「No.20054564」；"NO" 只是标签，不是表号本身
  return compact.replace(/^NO(?=\d)/, '');
}

function boxOf(item: OcrBoxItem): number[] | null {
  const box = item.box;
  return Array.isArray(box) && box.length >= 4 && box.every((n) => Number.isFinite(Number(n)))
    ? box.map(Number)
    : null;
}

function lineGroups(items: OcrBoxItem[]): OcrBoxItem[][] {
  const boxed = items.filter((item) => boxOf(item));
  const unboxed = items.filter((item) => !boxOf(item));
  const groups: OcrBoxItem[][] = [];
  const sorted = [...boxed].sort((a, b) => boxOf(a)![1] - boxOf(b)![1]);
  for (const item of sorted) {
    const box = boxOf(item)!;
    const center = (box[1] + box[3]) / 2;
    const height = Math.max(1, box[3] - box[1]);
    const group = groups.find((candidate) => {
      const first = boxOf(candidate[0])!;
      const firstHeight = Math.max(1, first[3] - first[1]);
      const firstCenter = (first[1] + first[3]) / 2;
      return Math.abs(center - firstCenter) <= Math.max(8, Math.min(height, firstHeight) * 0.6);
    });
    if (group) group.push(item);
    else groups.push([item]);
  }
  for (const group of groups) {
    group.sort((a, b) => boxOf(a)![0] - boxOf(b)![0]);
  }
  // 没有坐标的条目每条单独成行（LLM 返回的纯文本）
  return [...groups, ...unboxed.map((item) => [item])];
}

function lineText(group: OcrBoxItem[]): string {
  return normalizeOcrText(group.map((item) => item.text).join(' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function runScore(group: OcrBoxItem[]): number {
  const scores = group.map((item) => Number(item.score)).filter((n) => Number.isFinite(n) && n > 0);
  if (!scores.length) return 0.6;
  return scores.reduce((sum, n) => sum + n, 0) / scores.length;
}

function readingBox(group: OcrBoxItem[]): number[] | null {
  const boxes = group.map(boxOf).filter(Boolean) as number[][];
  if (!boxes.length) return null;
  return [
    Math.min(...boxes.map((b) => b[0])),
    Math.min(...boxes.map((b) => b[1])),
    Math.max(...boxes.map((b) => b[2])),
    Math.max(...boxes.map((b) => b[3])),
  ];
}

/** 两个框是不是同一块屏/同一行（用于判断读数是否有歧义） */
function sameArea(a?: number[], b?: number[]): boolean {
  if (!a || !b) return true;
  const heightA = Math.max(1, a[3] - a[1]);
  const heightB = Math.max(1, b[3] - b[1]);
  const distance = Math.abs((a[1] + a[3]) / 2 - (b[1] + b[3]) / 2);
  return distance <= Math.max(heightA, heightB) * 1.2;
}

/** 交集占较小框面积的比例；用于把「表号框」与「读数框」区分开 */
function overlapRatio(a: number[], b: number[]): number {
  const width = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const height = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const areaA = Math.max(1, (a[2] - a[0]) * (a[3] - a[1]));
  const areaB = Math.max(1, (b[2] - b[0]) * (b[3] - b[1]));
  return (width * height) / Math.min(areaA, areaB);
}

function expectedDigits(integer: number, decimal: number): number {
  return Math.max(1, integer) + Math.max(0, decimal);
}

/**
 * 把数字串变成金额/用量能用的值。
 * - 有小数点：按小数点
 * - 没小数点、位数正好 = 整数位 + 小数位：按建档位数补小数点（电表 02241888 → 22418.88）
 * - 水表整数位、无小数：直接取整
 * - 其它：仍返回数值，但调用方会因位数不符降低置信度
 */
export function digitsToValue(
  digits: string,
  integerDigits: number,
  decimalDigits: number,
  explicitDecimal = false,
): number | null {
  const clean = normalizeOcrText(digits).replace(/[^\d.]/g, '');
  if (!clean) return null;
  if (explicitDecimal && clean.includes('.')) {
    const value = Number(clean);
    return Number.isFinite(value) ? value : null;
  }
  const bare = clean.replace(/\./g, '');
  if (!bare) return null;
  if (decimalDigits > 0) {
    if (bare.length === integerDigits + decimalDigits) {
      return Number(`${bare.slice(0, integerDigits)}.${bare.slice(integerDigits)}`);
    }
    if (bare.length === integerDigits + decimalDigits + 1 && bare.startsWith('0')) {
      const trimmed = bare.slice(1);
      return Number(`${trimmed.slice(0, integerDigits)}.${trimmed.slice(integerDigits)}`);
    }
  }
  const value = Number(bare);
  return Number.isFinite(value) ? value : null;
}

/** 按建档位数格式化读数：水表 02405，电表 022418.88（用于页面和导出） */
export function formatReadingValue(
  value: number | string | null | undefined,
  integerDigits: number,
  decimalDigits: number,
): string {
  if (value === null || value === undefined || value === '') return '';
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '';
  const int = Math.max(1, integerDigits);
  const dec = Math.max(0, decimalDigits);
  const fixed = numeric.toFixed(dec);
  const [whole, fraction] = fixed.split('.');
  const padded = whole.padStart(int, '0');
  return dec > 0 ? `${padded}.${fraction}` : padded;
}

export function parseMeterOcr(
  items: OcrBoxItem[],
  options: MeterOcrParseOptions,
): MeterOcrParsed {
  const integerDigits = Math.min(10, Math.max(1, Math.round(options.integerDigits)));
  const decimalDigits = Math.min(4, Math.max(0, Math.round(options.decimalDigits)));
  const expected = expectedDigits(integerDigits, decimalDigits);
  const hint = normalizeMeterNo(options.meterNoHint);
  const groups = lineGroups(items || []);
  const texts = groups
    .map((group) => group.map((item) => item.text).join(' ').trim())
    .filter(Boolean);

  const candidates: MeterOcrCandidate[] = [];
  for (const group of groups) {
    const text = lineText(group);
    if (!text) continue;
    const rawText = group.map((item) => item.text).join(' ');
    // 同一行里的数字串；允许「02405 m」「0224 1888」这种被空格/单位隔开的写法
    const compact = text.replace(/\s+/g, '');
    const runs = compact.match(/\d{3,}(?:\.\d{1,3})?/g) || [];
    for (const run of runs) {
      if (run.replace(/\./g, '').length > MAX_READING_DIGITS) continue;
      const explicitDecimal = run.includes('.');
      const bare = run.replace(/\./g, '');
      if (hint && normalizeMeterNo(bare) === hint) continue;
      let score = runScore(group);
      // 位数正好匹配建档位数时最可信；差一位还可以接受，差更多基本是规格/表号
      if (bare.length === expected) score += 0.08;
      else if (bare.length === expected + 1 && bare.startsWith('0')) score += 0.04;
      else score -= 0.22;
      // 读数一般在照片中下部；顶部多半是表头/规格
      const box = readingBox(group);
      if (box && options.height) {
        const centerY = (box[1] + box[3]) / 2 / options.height;
        if (centerY > 0.5) score += 0.03;
        if (centerY < 0.25) score -= 0.05;
        // 读数数字通常比铭牌上的表号/规格大得多：电表液晶屏数字高约 220px，
        // 下面的表号只有 60px。没有这个信号时，8 位表号会和 8 位读数打成平手。
        const heightRatio = (box[3] - box[1]) / options.height;
        if (heightRatio >= 0.04) score += 0.08;
        if (heightRatio >= 0.06) score += 0.04;
      }
      if (box && options.width) {
        const widthRatio = (box[2] - box[0]) / options.width;
        if (widthRatio >= 0.25) score += 0.05;
      }
      // 读数行常带单位；铭牌行常带「表号/编号/年」
      if (/(?:m3|m³|kwh|kw·h|立方|吨|度)/i.test(text)) score += 0.08;
      if (/表号|编号|出厂|年|GB|JJG|Q3|R=/.test(text)) score -= 0.25;
      // 用未归一化的原文再罚一次：GB 里的 G 在某些 OCR 结果里会被归一成 6，
      // 只查归一化文本会漏掉标准号行，导致 8 位标准号抢走读数。
      if (/GB|JJG|DTSD|DDS|imp|Hz|\bV\b|表号|编号|出厂|年/.test(rawText)) score -= 0.3;
      const value = digitsToValue(run, integerDigits, decimalDigits, explicitDecimal);
      if (value === null) continue;
      candidates.push({
        digits: bare,
        value,
        score: Math.max(0, Math.min(1, score)),
        text: run,
        explicitDecimal,
        box: box ?? undefined,
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score || b.digits.length - a.digits.length);
  const best = candidates[0] ?? null;
  // 只有和读数在同一块屏/同一行的另一个数字才叫「歧义」。
  // 电表下方的表号同样 8 位、分数也高，但它离读数 600 多像素，不该把置信度压到 74。
  const runnerUp =
    candidates.find(
      (candidate) =>
        candidate.digits !== best?.digits &&
        candidate.score >= (best?.score ?? 0) - 0.04 &&
        sameArea(candidate.box, best?.box),
    ) ?? null;

  let confidence = best ? Math.round(best.score * 100) : 0;
  if (best && best.digits.length !== expected && !(best.digits.length === expected + 1 && best.digits.startsWith('0'))) {
    confidence = Math.max(0, confidence - 18);
  }
  if (best?.explicitDecimal && decimalDigits > 0) confidence = Math.min(96, confidence + 3);
  confidence = Math.min(96, confidence);
  if (runnerUp && best) confidence = Math.min(confidence, 74);

  // 表号：6 位以上、与读数不同，优先取靠近「表号/编号/No」的框，其次取图片下半部的高分框
  const meterCandidates: Array<{ digits: string; score: number; centerY: number }> = [];
  for (const group of groups) {
    const box = readingBox(group);
    const raw = group.map((item) => item.text).join(' ').trim();
    const text = lineText(group);
    const compact = text.replace(/\s+/g, '');
    // 同一个框里的数字就是读数本身，不能再当表号
    if (box && best?.box && best.digits !== null && overlapRatio(box, best.box) > 0.25) continue;
    for (const run of compact.match(/[A-Z0-9][A-Z0-9-]{5,30}/g) || []) {
      const digits = run.replace(/[^0-9]/g, '');
      if (digits.length < 6 || digits.length > 16) continue;
      if (digits === best?.digits) continue;
      // 排除日期、标准号、规格里的数字（GB/T17215.301-2007、3×220/380V）
      const letters = run.replace(/[^A-Z]/g, '');
      let score = runScore(group);
      if (/表号|编号|NO\.?|No\.?/.test(raw)) score += 0.15;
      if (/GB|JJG|Q3|R=|年|制|许可|型号|DTSD|DTS|imp|Hz|\bV\b/i.test(raw)) score -= 0.35;
      if (letters.length > 2) score -= 0.1;
      const centerY = box && options.height ? (box[1] + box[3]) / 2 / options.height : 0.5;
      if (score >= 0.68) meterCandidates.push({ digits, score, centerY });
    }
  }
  meterCandidates.sort((a, b) => b.score - a.score || b.centerY - a.centerY);
  const meterNoCandidates = [...new Set(meterCandidates.map((candidate) => candidate.digits))].slice(0, 5);

  let meterNo: string | null = null;
  if (hint) {
    meterNo = meterNoCandidates.find((candidate) => normalizeMeterNo(candidate) === hint) ?? null;
  }
  if (!meterNo && meterCandidates.length) {
    // 高分且与第二名拉得开才自动给；两个都像表号时留给人确认
    const top = meterCandidates[0];
    const second = meterCandidates.find((candidate) => candidate.digits !== top.digits);
    if (top.score >= 0.78 && top.digits.length >= 6 && (!second || top.score - second.score >= 0.05)) {
      meterNo = top.digits;
    }
  }

  const needsReview = !best || confidence < 75 || runnerUp !== null;

  return {
    digits: best?.digits ?? null,
    value: best?.value ?? null,
    confidence,
    meterNo,
    meterNoCandidates,
    texts: texts.join('\n'),
    candidates: candidates.slice(0, 6),
    needsReview,
  };
}
