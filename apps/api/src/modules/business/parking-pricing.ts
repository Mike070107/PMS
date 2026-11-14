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
  /** 旧字段：只绑一个停车场时等于 parkingTargets[0]，执行层兜底用 */
  parkingTarget?: string;
  /** 适用车库（停车目标 key）；空 = 本小区全部车库 */
  parkingTargets?: string[];
  /** 缴费规则分组名（车牌按它匹配分组；历史上叫「车辆类别」） */
  vehicleClass?: string;
  /** 价格表：每个可选月数一个金额 */
  tiers?: PriceTier[];
  /** monthly=月单价+完整周期减免；table=显式档位优先、缺档按1月价；无字段为旧套餐算法 */
  priceMode?: 'table' | 'monthly';
  monthlyPriceCents?: number;
  discountCycleMonths?: number;
  discountMonths?: number;
  /** 本小区（对应车库）的默认分组：没归组的车按它收 */
  isDefault?: boolean;
}

export const DEFAULT_GROUP = '默认分组';
export const STANDARD_MONTHS = [1, 2, 3, 6, 12];

export class MissingParkingPriceError extends Error {
  name = 'MissingParkingPriceError';
}

/** 显式月档优先；自定义缺档月份仅按同分组的1月价计算，不推导或重复套餐优惠。 */
export function priceTable(months: number, tiers: PriceTier[]): { amountCents: number; breakdown: string } {
  if (!Number.isInteger(months) || months < 1 || months > MAX_MONTHS) throw new Error(`缴费月数要在 1~${MAX_MONTHS} 之间`);
  const hit = tiers.find((t) => t.months === months);
  const monthly = tiers.find((t) => t.months === 1);
  if (!hit && monthly) {
    const amountCents = monthly.amountCents * months;
    if (!Number.isSafeInteger(monthly.amountCents) || monthly.amountCents < 0 || !Number.isSafeInteger(amountCents) || amountCents < 0) throw new Error('按月计费金额超出合法范围');
    return { amountCents, breakdown: `${months}个月 × ${monthly.amountCents / 100}元/月（同分组月单价）` };
  }
  if (!hit) {
    const list = tiers.map((t) => t.months).sort((a, b) => a - b).join('、');
    throw new MissingParkingPriceError(list ? `这个缴费规则分组没有定 ${months} 个月的价格，可选：${list} 个月` : '这个缴费规则分组还没有设价格');
  }
  return { amountCents: hit.amountCents, breakdown: `${months} 个月` };
}

/** 连续月份：每满12个月按年价，余月按月价；只在完整12月时触发优惠。 */
export function priceMonthly(months: number, cfg: ParkingRuleConfig): { amountCents: number; breakdown: string } {
  if (!Number.isInteger(months) || months < 1 || months > MAX_MONTHS) throw new Error(`缴费月数要在 1~${MAX_MONTHS} 之间`);
  const unit = cfg.monthlyPriceCents;
  const cycle = cfg.discountCycleMonths === undefined ? 12 : cfg.discountCycleMonths;
  const free = cfg.discountMonths === undefined ? 0 : cfg.discountMonths;
  if (unit == null || !Number.isSafeInteger(unit) || unit < 0) throw new MissingParkingPriceError('请明确配置非负月单价，0元请填0');
  if (!Number.isInteger(cycle) || cycle < 2 || cycle > MAX_MONTHS) throw new Error('满减周期必须是2至60的整数月');
  if (!Number.isInteger(free) || free < 0 || free > cycle) throw new Error('减免月数须为0至满减周期的整数');
  const rounds = Math.floor(months / cycle), discounted = rounds * free;
  const amountCents = (months - discounted) * unit;
  if (!Number.isSafeInteger(amountCents) || amountCents < 0) throw new Error('按月计费金额超出合法范围');
  return { amountCents, breakdown: free > 0
    ? `${months}个月 × ${unit / 100}元/月；每满${cycle}个月减免${free}个月，本次${rounds}轮减免${discounted}个月`
    : `${months}个月 × ${unit / 100}元/月，不减免` };
}

/** 明确选择计价模式；不把未知价格当免费，也不套用其他车辆类别。 */
export function priceRule(months: number, unitPriceCents: number, cfg: ParkingRuleConfig): { amountCents: number; breakdown: string } {
  if (!Number.isInteger(months) || months < 1 || months > MAX_MONTHS) throw new Error(`缴费月数要在 1~${MAX_MONTHS} 之间`);
  if (cfg.priceMode === 'monthly') return priceMonthly(months, cfg);
  if (cfg.priceMode !== 'table') return priceParking(months, unitPriceCents, cfg.tiers ?? []);
  return priceTable(months, normalizeTiers(cfg.tiers ?? []));
}

/**
 * 旧规则（单价 + 可选套餐）升级为缴费规则分组：按原算法算出 1/2/3/6/12 个月（以及原有套餐月数）的价格写进价格表，
 * 金额与升级前完全一致；没分类的叫「默认分组」并设为默认。已经是分组的原样返回 null。
 */
export function upgradeToTable(cfg: ParkingRuleConfig, unitPriceCents: number): ParkingRuleConfig | null {
  if (cfg.priceMode === 'table' || cfg.priceMode === 'monthly') return null;
  const old = cfg.tiers ?? [];
  const months = [...new Set([...STANDARD_MONTHS, ...old.map((t) => t.months)])].sort((a, b) => a - b);
  const next: ParkingRuleConfig = {
    ...cfg,
    priceMode: 'table',
    tiers: months.map((m) => ({ months: m, amountCents: priceParking(m, unitPriceCents, old).amountCents })),
    vehicleClass: cfg.vehicleClass || DEFAULT_GROUP,
    parkingTargets: cfg.parkingTargets?.length ? cfg.parkingTargets : cfg.parkingTarget ? [cfg.parkingTarget] : [],
  };
  if (!cfg.vehicleClass) next.isDefault = true;
  return next;
}

/** 两个分组的适用车库是否重叠（空 = 全部车库，和任何分组都重叠） */
export function targetsOverlap(a: string[] = [], b: string[] = []): boolean {
  if (!a.length || !b.length) return true;
  return a.some((k) => b.includes(k));
}

export const MAX_MONTHS = 60;

export function normalizeTiers(value: unknown): PriceTier[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error('套餐档格式不对');
  const out: PriceTier[] = [];
  for (const raw of value) {
    const months = Number((raw as PriceTier)?.months);
    const amount: unknown = (raw as PriceTier)?.amountCents;
    if (typeof amount !== 'number' && (typeof amount !== 'string' || !amount.trim())) throw new Error(`${months} 个月的金额不对`);
    const amountCents = Number(amount);
    if (!Number.isInteger(months) || months < 1 || months > MAX_MONTHS) throw new Error(`缴费月数要在 1~${MAX_MONTHS} 之间`);
    if (!Number.isSafeInteger(amountCents) || amountCents < 0) throw new Error(`${months} 个月的金额不对`);
    if (out.some((t) => t.months === months)) throw new Error(`${months} 个月重复了`);
    out.push({ months, amountCents });
  }
  return out.sort((a, b) => a.months - b.months);
}

export function normalizeVehicleClass(value: unknown): string {
  const text = String(value ?? '').trim().replace(/\s+/g, '');
  if (text.length > 20) throw new Error('分组名称最多 20 个字');
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
