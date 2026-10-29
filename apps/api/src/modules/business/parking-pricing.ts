/**
 * 停车月租计价：单价 × 月数，叠加自建的「套餐档」（例如 12 个月 1500 元）。
 *
 * 规则：在「按月单价」和各套餐档之间取最省的组合——
 *   业主车 150/月，套餐 12 个月 1500：1~11 个月按月算，12 个月 1500，13 个月 1500+150，24 个月 3000；
 *   租客车 180/月，没有套餐：12 个月 2160。
 * 套餐档在收费标准页自建；纯函数，前后端算法一致，服务端结果为准。
 */
export interface PriceTier { months: number; amountCents: number }
export interface ParkingRuleConfig {
  parkingTarget?: string;
  /** 车辆类别：业主车 / 租客车 / 大车 / 小车……自建；空 = 不分类，任何车都可用 */
  vehicleClass?: string;
  tiers?: PriceTier[];
}

export const MAX_MONTHS = 60;

export function normalizeTiers(value: unknown): PriceTier[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error('套餐档格式不对');
  const out: PriceTier[] = [];
  for (const raw of value) {
    const months = Number((raw as PriceTier)?.months);
    const amountCents = Number((raw as PriceTier)?.amountCents);
    if (!Number.isInteger(months) || months < 1 || months > 36) throw new Error('套餐月数要在 1~36 之间');
    if (!Number.isInteger(amountCents) || amountCents < 0) throw new Error('套餐金额不对');
    if (out.some((t) => t.months === months)) throw new Error(`套餐 ${months} 个月重复了`);
    out.push({ months, amountCents });
  }
  return out.sort((a, b) => a.months - b.months);
}

export function normalizeVehicleClass(value: unknown): string {
  const text = String(value ?? '').trim().replace(/\s+/g, '');
  if (text.length > 12) throw new Error('车辆类别最多 12 个字');
  return text;
}

/** 计算 N 个月应收，并给出组合说明（「12 个月套餐 + 1 个月」） */
export function priceParking(months: number, unitPriceCents: number, tiers: PriceTier[] = []): { amountCents: number; breakdown: string } {
  if (!Number.isInteger(months) || months < 1 || months > MAX_MONTHS) throw new Error(`缴费月数要在 1~${MAX_MONTHS} 之间`);
  const best: Array<{ cost: number; from: number; tier: number }> = [{ cost: 0, from: -1, tier: 0 }];
  for (let m = 1; m <= months; m++) {
    let cur = { cost: best[m - 1].cost + unitPriceCents, from: m - 1, tier: 0 };
    for (const t of tiers) {
      if (t.months <= m && best[m - t.months].cost + t.amountCents < cur.cost) cur = { cost: best[m - t.months].cost + t.amountCents, from: m - t.months, tier: t.months };
    }
    best.push(cur);
  }
  const parts = new Map<string, number>();
  for (let m = months; m > 0; m = best[m].from) {
    const key = best[m].tier ? `${best[m].tier} 个月套餐` : '按月';
    parts.set(key, (parts.get(key) || 0) + 1);
  }
  const pieces = [...parts.entries()].map(([k, n]) => (k === '按月' ? `${n} 个月按月` : n > 1 ? `${k} ×${n}` : k));
  return { amountCents: best[months].cost, breakdown: pieces.reverse().join(' + ') };
}
