import { CollectionTargetRow } from './collection-targets.util';

export type ScreenSummaryCommunity = { id: number; name: string; offices: string[] };
export type ScreenDailyRow = { officeCode: string; day: string; paidCents: number; billCount: number; houseCount: number; feeCode?: string };
export type ScreenArrears = { totalCents: number; houseCount: number; buckets: Array<{ key: string; count: number; amountCents: number }> };

const FEE_CODES = ['property', 'berth', 'parking', 'other'] as const;
type FeeCode = (typeof FEE_CODES)[number];
const round1 = (value: number) => Math.round(value * 10) / 10;
const pad = (n: number) => String(n).padStart(2, '0');
const dayKey = (year: number, month: number, day: number) => `${year}-${pad(month)}-${pad(day)}`;
const normalizeFeeCode = (value: unknown): FeeCode => FEE_CODES.includes(String(value) as FeeCode) ? String(value) as FeeCode : 'property';

function cstToday(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value || 0);
  return { year: get('year'), month: get('month'), day: get('day') };
}

function targetMonthValue(target: CollectionTargetRow, month: number) {
  const explicit = target.monthCents[month - 1];
  return explicit === null || explicit === undefined
    ? { value: Math.round(target.annualCents / 12), source: 'derived' as const }
    : { value: explicit, source: 'explicit' as const };
}

/**
 * 收费大屏聚合计算：所有实收由调用方按 ZJ_SKRQ/paid_date 自然日提供。
 * 指标/达成率只统计命中指标组的 feeCode；今日实收保留全费项，并额外给 byFee。
 */
export function buildScreenSummary(input: {
  year: number;
  communities: ScreenSummaryCommunity[];
  targets: CollectionTargetRow[];
  dailyRows: ScreenDailyRow[];
  arrears: ScreenArrears;
  recentPayments: any[];
  granularity?: 'day' | 'month';
  now?: Date;
}) {
  const { year, communities, targets, dailyRows, arrears, recentPayments } = input;
  const granularity = input.granularity === 'day' ? 'day' : 'month';
  const today = cstToday(input.now);
  const selectedIds = new Set(communities.map((community) => community.id));
  const officeToCommunity = new Map<string, ScreenSummaryCommunity>();
  for (const community of communities) for (const office of community.offices) officeToCommunity.set(String(office), community);

  // 只命中「组内小区全部被选中」的指标组；部分选中不算命中。
  const matchedTargets = targets.filter((target) => target.communityIds.length > 0 && target.communityIds.every((id) => selectedIds.has(id)));
  const targetCommunityIdSet = new Set(matchedTargets.flatMap((target) => target.communityIds));
  const targetCommunities = communities.filter((community) => targetCommunityIdSet.has(community.id));
  const missingTargetCommunities = communities.filter((community) => !targetCommunityIdSet.has(community.id)).map((community) => ({ id: community.id, name: community.name }));
  const partial = missingTargetCommunities.length > 0;

  const communityPaid = new Map<number, number>();
  const categoryCommunityPaid = new Map<string, number>();
  const categoryCommunityMonth = new Map<string, number>();
  const todayByFee: Record<FeeCode, number> = { property: 0, berth: 0, parking: 0, other: 0 };
  let todayCents = 0, todayBills = 0, todayHouses = 0;
  const todayKey = dayKey(today.year, today.month, today.day);
  for (const row of dailyRows) {
    const day = String(row.day).slice(0, 10);
    if (!day.startsWith(`${year}-`)) continue;
    const community = officeToCommunity.get(String(row.officeCode));
    if (!community) continue;
    const amount = Number(row.paidCents || 0);
    const feeCode = normalizeFeeCode(row.feeCode);
    communityPaid.set(community.id, (communityPaid.get(community.id) || 0) + amount);
    const communityCategoryKey = `${community.id}|${feeCode}`;
    categoryCommunityPaid.set(communityCategoryKey, (categoryCommunityPaid.get(communityCategoryKey) || 0) + amount);
    const monthKey = `${community.id}|${feeCode}|${day.slice(0, 7)}`;
    categoryCommunityMonth.set(monthKey, (categoryCommunityMonth.get(monthKey) || 0) + amount);
    if (day === todayKey) {
      todayCents += amount;
      todayBills += Number(row.billCount || 0);
      todayHouses += Number(row.houseCount || 0);
      todayByFee[feeCode] += amount;
    }
  }

  const annualCents = matchedTargets.reduce((sum, target) => sum + target.annualCents, 0);
  const targetYtdCents = matchedTargets.reduce((sum, target) => sum + target.communityIds.reduce((groupSum, id) => groupSum + (categoryCommunityPaid.get(`${id}|${target.feeCode}`) || 0), 0), 0);
  const currentMonth = todayKey.slice(0, 7);
  const targetMonthPaidCents = matchedTargets.reduce((sum, target) => sum + target.communityIds.reduce((groupSum, id) => groupSum + (categoryCommunityMonth.get(`${id}|${target.feeCode}|${currentMonth}`) || 0), 0), 0);

  let explicitMonthCents = 0;
  let derivedMonthCents = 0;
  let hasExplicitMonth = false;
  let hasDerivedMonth = false;
  for (const target of matchedTargets) {
    const value = target.monthCents[today.month - 1];
    if (value === null || value === undefined) {
      derivedMonthCents += Math.round(target.annualCents / 12);
      hasDerivedMonth = true;
    } else {
      explicitMonthCents += value;
      hasExplicitMonth = true;
    }
  }
  const monthTargetCents = explicitMonthCents + derivedMonthCents;
  const monthTargetSource = matchedTargets.length === 0 ? null : (hasDerivedMonth ? 'derived' : hasExplicitMonth ? 'explicit' : null);

  const yearStart = `${year}-01-01`, yearEnd = `${year}-12-31`;
  const remainingDays = year === today.year
    ? Math.max(0, Math.round((Date.parse(`${yearEnd}T00:00:00+08:00`) - Date.parse(`${todayKey}T00:00:00+08:00`)) / 86400000) + 1)
    : (year > today.year ? Math.round((Date.parse(`${yearEnd}T00:00:00+08:00`) - Date.parse(`${yearStart}T00:00:00+08:00`)) / 86400000) + 1 : 0);
  const gapCents = annualCents > 0 ? annualCents - targetYtdCents : 0;
  const dailyNeedCents = annualCents > 0 && remainingDays > 0 ? Math.round(gapCents / remainingDays) : null;
  const rate = annualCents > 0 ? round1((targetYtdCents / annualCents) * 100) : null;

  const communityRows = communities.map((community) => {
    const covered = matchedTargets.find((target) => target.communityIds.includes(community.id));
    const annual = covered && covered.communityIds.length === 1 ? covered.annualCents : 0;
    // 未覆盖指标的小区也按默认考核费项（通常是物业费）展示，保证排行不会混入其他费项。
    const feeCode = covered?.feeCode || 'property';
    const paid = categoryCommunityPaid.get(`${community.id}|${feeCode}`) || 0;
    return { communityId: community.id, name: community.name, targetCents: annual, paidCents: paid, rate: annual > 0 ? round1((paid / annual) * 100) : null };
  });

  const targetMonthPaidFor = (month: string) => matchedTargets.reduce((sum, target) => sum + target.communityIds.reduce((groupSum, id) => groupSum + (categoryCommunityMonth.get(`${id}|${target.feeCode}|${month}`) || 0), 0), 0);
  const targetMonthFor = (month: number) => matchedTargets.reduce((sum, target) => sum + targetMonthValue(target, month).value, 0);

  const trend: Array<{ key: string; paidCents: number; targetCents: number }> = [];
  if (granularity === 'month') {
    for (let month = 1; month <= 12; month += 1) {
      const key = `${year}-${pad(month)}`;
      trend.push({ key, paidCents: targetMonthPaidFor(key), targetCents: targetMonthFor(month) });
    }
  } else {
    const end = year === today.year ? todayKey : yearEnd;
    const monthlyTargets = monthlyTargetForDaily(matchedTargets);
    const startUtc = Date.UTC(year, 0, 1), endUtc = Date.UTC(Number(end.slice(0, 4)), Number(end.slice(5, 7)) - 1, Number(end.slice(8, 10)));
    const dailyPaid = dailyTargetPaid(dailyRows, matchedTargets, officeToCommunity, year);
    for (let time = startUtc; time <= endUtc; time += 86400000) {
      const date = new Date(time);
      const key = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
      trend.push({ key, paidCents: dailyPaid.get(key) || 0, targetCents: monthlyTargets[key.slice(0, 7)] || 0 });
    }
  }

  return {
    year,
    scope: { communityIds: communities.map((community) => community.id), communityNames: communities.map((community) => community.name) },
    target: { annualCents, yearToDateCents: targetYtdCents, rate, gapCents, remainingDays, dailyNeedCents },
    targetScope: { communityIds: targetCommunities.map((community) => community.id), communityNames: targetCommunities.map((community) => community.name) },
    missingTargetCommunities,
    partial,
    today: {
      paidCents: todayCents, billCount: todayBills, houseCount: todayHouses,
      byFee: { propertyCents: todayByFee.property, berthCents: todayByFee.berth, parkingCents: todayByFee.parking, otherCents: todayByFee.other },
      vsDailyNeed: dailyNeedCents && dailyNeedCents > 0 ? round1((todayCents / dailyNeedCents) * 100) : null,
      vsMonthRate: monthTargetCents > 0 ? round1((todayCents / monthTargetCents) * 100) : null,
    },
    monthToDate: { paidCents: targetMonthPaidCents, targetCents: monthTargetCents, rate: monthTargetCents > 0 ? round1((targetMonthPaidCents / monthTargetCents) * 100) : null, targetSource: monthTargetSource, month: currentMonth },
    communities: communityRows,
    trend,
    arrears,
    recentPayments,
  };
}

function dailyTargetPaid(rows: ScreenDailyRow[], targets: CollectionTargetRow[], officeToCommunity: Map<string, ScreenSummaryCommunity>, year: number) {
  const targetIds = new Map<number, string>();
  for (const target of targets) for (const id of target.communityIds) targetIds.set(id, target.feeCode);
  const result = new Map<string, number>();
  for (const row of rows) {
    const day = String(row.day).slice(0, 10);
    if (!day.startsWith(`${year}-`)) continue;
    const community = officeToCommunity.get(String(row.officeCode));
    if (!community || targetIds.get(community.id) !== normalizeFeeCode(row.feeCode)) continue;
    result.set(day, (result.get(day) || 0) + Number(row.paidCents || 0));
  }
  return result;
}

function monthlyTargetForDaily(targets: CollectionTargetRow[]) {
  const result: Record<string, number> = {};
  for (const target of targets) {
    for (let month = 1; month <= 12; month += 1) {
      const value = targetMonthValue(target, month).value;
      if (!value) continue;
      const days = new Date(Date.UTC(target.year, month, 0)).getUTCDate();
      const key = `${target.year}-${pad(month)}`;
      result[key] = (result[key] || 0) + Math.round(value / days);
    }
  }
  return result;
}
