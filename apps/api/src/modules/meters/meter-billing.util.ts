/** 抄表计费/用量的小工具，纯函数，便于回归 */

export function round3(value: number): number {
  return Math.round((value + Number.EPSILON) * 1000) / 1000;
}

export function yuanToCents(value: number | string | null | undefined): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.round(numeric * 100);
}

export function centsToYuan(cents: number | null | undefined): number {
  const numeric = Number(cents);
  return Number.isFinite(numeric) ? Math.round(numeric) / 100 : 0;
}

/** 用量 × 单价（分），四舍五入到分。用量已经乘过倍率 */
export function amountCentsOf(usage: number | null | undefined, unitPriceCents: number): number {
  const numeric = Number(usage);
  const price = Math.max(0, Math.round(Number(unitPriceCents) || 0));
  if (!Number.isFinite(numeric) || numeric <= 0 || price <= 0) return 0;
  return Math.round(numeric * price);
}

export interface UsageResult {
  usage: number | null;
  rollover: boolean;
  error?: string;
}

/**
 * 本次用量 =（本次读数 - 上次读数）× 倍率。
 *
 * 表走到头归零（99999 → 00012）要按进位算，不能记成负用量；但也不能把所有
 * 「本次比上次小」都当进位 —— 抄错一位（2405 抄成 2300）会被算成 9 万多吨。
 * 只有上次读数已经接近满位（≥90% 量程）才认定是进位。
 */
export function computeUsage(
  current: number,
  previous: number | null | undefined,
  multiplier: number,
  integerDigits: number,
): UsageResult {
  if (previous === null || previous === undefined || !Number.isFinite(Number(previous))) {
    return { usage: null, rollover: false };
  }
  const prev = Number(previous);
  const mult = Number.isFinite(Number(multiplier)) && Number(multiplier) > 0 ? Number(multiplier) : 1;
  const wrap = Math.pow(10, Math.max(1, Math.min(10, Math.round(integerDigits))));
  let diff = current - prev;
  let rollover = false;
  if (diff < -0.0005) {
    if (prev >= wrap * 0.9) {
      diff = current + wrap - prev;
      rollover = true;
    } else {
      return {
        usage: null,
        rollover: false,
        error: `本次读数 ${current} 小于上次 ${prev}，请核对；如果已经换表，请先给新表建档`,
      };
    }
  }
  return { usage: round3(diff * mult), rollover };
}

/** 北京时间账期 YYYY-MM（中国无夏令时，固定 +8 即可，避免服务器时区影响） */
export function periodOf(date: Date): string {
  const shifted = new Date(date.getTime() + 8 * 3600 * 1000);
  return shifted.toISOString().slice(0, 7);
}

/** 北京时间日期 YYYY-MM-DD */
export function dateOf(date: Date): string {
  const shifted = new Date(date.getTime() + 8 * 3600 * 1000);
  return shifted.toISOString().slice(0, 10);
}

export function formatCents(cents: number | null | undefined): string {
  return (Number(cents || 0) / 100).toFixed(2);
}
