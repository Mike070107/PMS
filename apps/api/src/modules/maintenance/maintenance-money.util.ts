/**
 * 养护单上的三笔钱，算法只写这一处（后端落库、前端即时回显都引它）。
 *
 * 口径来自样单 0119524：
 *   工时 0.34 × 人工单价 17.50 元 = 人工费 5.95 元
 *  （人工费 5.95 + 材料费 6.00）× 取费系数 1.0341 = 定额工料费合计 12.36 元
 */

/** 一条明细里参与合计的两笔钱 */
export interface FeeLine {
  laborFeeCents?: number | null;
  materialFeeCents?: number | null;
}

/** 定额工料费合计（分）=（人工费合计 + 材料费合计）× 取费系数 */
export function totalFeeCents(items: FeeLine[], coefficient: number): number {
  const base = (items ?? []).reduce(
    (sum, item) => sum + (item.laborFeeCents ?? 0) + (item.materialFeeCents ?? 0),
    0,
  );
  const rate = Number.isFinite(coefficient) && coefficient > 0 ? coefficient : 1;
  return Math.round(base * rate);
}

/** 材料合计（分）：背面《材料领耗记录》各行实耗金额相加 */
export function materialTotalCents(rows: Array<{ amountCents?: number | null }>): number {
  return (rows ?? []).reduce((sum, row) => sum + (row.amountCents ?? 0), 0);
}

/**
 * 选定额编号后算这一行的工时和人工费。
 * 工时保留三位小数（定额本身就是 0.34 这种三位以内的数），钱四舍五入到分。
 */
export function quotaLabor(
  hoursPerUnit: number,
  qty: number,
  laborRateCents: number,
): { hours: number; laborFeeCents: number } {
  const perUnit = Number.isFinite(hoursPerUnit) ? hoursPerUnit : 0;
  const count = Number.isFinite(qty) && qty > 0 ? qty : 1;
  const hours = Math.round(perUnit * count * 1000) / 1000;
  return {
    hours,
    laborFeeCents: Math.round(hours * (Number.isFinite(laborRateCents) ? laborRateCents : 0)),
  };
}
