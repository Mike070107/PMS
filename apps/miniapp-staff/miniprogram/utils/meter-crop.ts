export interface CropRoi {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface OcrCandidateLike {
  digits: string;
  value: number | null;
  score: number;
  box?: number[];
}

const onlyDigits = (value: string | null | undefined) => String(value || '').replace(/\D/g, '');

/**
 * 在整图 OCR 候选里挑读数：
 * 1. 先排除档案表号；
 * 2. 优先取中心点落在固定红框内的候选；
 * 3. 红框偏了导致一个都没命中时，退回全图最高分（仍排除表号），
 *    不能因为框偏一点就报“没找到”。
 */
export function pickReadingCandidate(
  candidates: OcrCandidateLike[],
  roi: CropRoi,
  photoWidth: number,
  photoHeight: number,
  expectedDigits: number,
  meterNo: string,
): OcrCandidateLike | null {
  const meterDigits = onlyDigits(meterNo);
  const usable = (candidates || []).filter(
    (item) => !!item && (!meterDigits || onlyDigits(item.digits) !== meterDigits),
  );
  const boxed = usable.filter((item) => Array.isArray(item.box) && item.box!.length >= 4);
  if (boxed.length && photoWidth > 0 && photoHeight > 0) {
    const inside = boxed.filter((item) => {
      const box = item.box!;
      const cx = (box[0] + box[2]) / 2 / photoWidth;
      const cy = (box[1] + box[3]) / 2 / photoHeight;
      return cx >= roi.x && cx <= roi.x + roi.w && cy >= roi.y && cy <= roi.y + roi.h;
    });
    if (inside.length) return [...inside].sort((a, b) => b.score - a.score)[0];
  }

  const matching = boxed.filter(
    (item) => !expectedDigits || onlyDigits(item.digits).length === expectedDigits,
  );
  if (matching.length) return [...matching].sort((a, b) => b.score - a.score)[0];
  if (boxed.length) return [...boxed].sort((a, b) => b.score - a.score)[0];
  return usable[0] || null;
}
