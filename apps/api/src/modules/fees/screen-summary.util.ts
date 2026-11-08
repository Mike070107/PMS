import { CollectionTargetRow } from './collection-targets.util';

export type ScreenSummaryCommunity = { id: number; name: string; offices: string[] };
export type ScreenDailyRow = { officeCode: string; day: string; paidCents: number; billCount: number; houseCount: number };
export type ScreenArrears = { totalCents: number; houseCount: number; buckets: Array<{ key: string; count: number; amountCents: number }> };

const round1 = (value: number) => Math.round(value * 10) / 10;
const pad = (n: number) => String(n).padStart(2, '0');
const dayKey = (year: number, month: number, day: number) => `${year}-${pad(month)}-${pad(day)}`;

function cstToday(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value || 0);
  return { year: get('year'), month: get('month'), day: get('day') };
}

/**
 * 收费大屏聚合计算：所有实收由调用方按 ZJ_SKRQ/paid_date 自然日提供，这里只做口径与达成率换算。
 * 指标为 0 或未设置时 rate/dailyNeedCents 返回 null，避免前端显示 0%。
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
  const officeToCommunity = new Map<string, ScreenSummaryCommunity>();
  for (const community of communities) for (const office of community.offices) officeToCommunity.set(String(office), community);
  const communityPaid = new Map<number, number>();
  const monthPaid = new Map<string, number>();
  const dayPaidMap = new Map<string, number>();
  let ytdCents = 0, todayCents = 0, todayBills = 0, todayHouses = 0;
  const todayKey = dayKey(today.year, today.month, today.day);
  for (const row of dailyRows) {
    const day = String(row.day).slice(0, 10);
    if (!day.startsWith(`${year}-`)) continue;
    const community = officeToCommunity.get(String(row.officeCode));
    if (!community) continue;
    const amount = Number(row.paidCents || 0);
    ytdCents += amount;
    communityPaid.set(community.id, (communityPaid.get(community.id) || 0) + amount);
    monthPaid.set(day.slice(0, 7), (monthPaid.get(day.slice(0, 7)) || 0) + amount);
    dayPaidMap.set(day, (dayPaidMap.get(day) || 0) + amount);
    if (day === todayKey) {
      todayCents += amount;
      todayBills += Number(row.billCount || 0);
      todayHouses += Number(row.houseCount || 0);
    }
  }

  const selectedIds = new Set(communities.map((community) => community.id));
  // 只命中「组内小区全部被选中」的指标组；部分选中不算命中。
  const matchedTargets = targets.filter((target) => target.communityIds.length > 0 && target.communityIds.every((id) => selectedIds.has(id)));
  const targetCommunityIdSet = new Set(matchedTargets.flatMap((target) => target.communityIds));
  const targetCommunities = communities.filter((community) => targetCommunityIdSet.has(community.id));
  const missingTargetCommunities = communities.filter((community) => !targetCommunityIdSet.has(community.id)).map((community) => ({ id: community.id, name: community.name }));
  const annualCents = matchedTargets.reduce((sum, target) => sum + target.annualCents, 0);
  const targetYtdCents = targetCommunities.reduce((sum, community) => sum + (communityPaid.get(community.id) || 0), 0);
  const partial = missingTargetCommunities.length > 0;
  const currentMonth = todayKey.slice(0, 7);
  const monthTargetCents = matchedTargets.reduce((sum, target) => sum + (target.monthCents[today.month - 1] ?? 0), 0);
  const monthPaidCents = monthPaid.get(currentMonth) || 0;
  const yearStart = `${year}-01-01`, yearEnd = `${year}-12-31`;
  const remainingDays = year === today.year
    ? Math.max(0, Math.round((Date.parse(`${yearEnd}T00:00:00+08:00`) - Date.parse(`${todayKey}T00:00:00+08:00`)) / 86400000) + 1)
    : (year > today.year ? Math.round((Date.parse(`${yearEnd}T00:00:00+08:00`) - Date.parse(`${yearStart}T00:00:00+08:00`)) / 86400000) + 1 : 0);
  const gapCents = annualCents > 0 ? annualCents - targetYtdCents : 0;
  const dailyNeedCents = annualCents > 0 && remainingDays > 0 ? Math.round(gapCents / remainingDays) : null;
  const rate = annualCents > 0 ? round1((targetYtdCents / annualCents) * 100) : null;

  const communityRows = communities.map((community) => {
    const annual = matchedTargets.find((target) => target.communityIds.length === 1 && target.communityIds[0] === community.id)?.annualCents || 0;
    const paid = communityPaid.get(community.id) || 0;
    return { communityId: community.id, name: community.name, targetCents: annual, paidCents: paid, rate: annual > 0 ? round1((paid / annual) * 100) : null };
  });

  const trend: Array<{ key: string; paidCents: number; targetCents: number }> = [];
  if (granularity === 'month') {
    for (let month = 1; month <= 12; month += 1) {
      const key = `${year}-${pad(month)}`;
      const targetCents = matchedTargets.reduce((sum, target) => sum + (target.monthCents[month - 1] ?? 0), 0);
      trend.push({ key, paidCents: monthPaid.get(key) || 0, targetCents });
    }
  } else {
    const end = year === today.year ? todayKey : yearEnd;
    const monthlyTargets = monthlyTargetForDaily(matchedTargets);
    const startUtc = Date.UTC(year, 0, 1), endUtc = Date.UTC(Number(end.slice(0, 4)), Number(end.slice(5, 7)) - 1, Number(end.slice(8, 10)));
    for (let time = startUtc; time <= endUtc; time += 86400000) {
      const date = new Date(time);
      const key = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
      trend.push({ key, paidCents: dayPaidMap.get(key) || 0, targetCents: monthlyTargets[key.slice(0, 7)] || 0 });
    }
  }

  return {
    year,
    scope: { communityIds: communities.map((community) => community.id), communityNames: communities.map((community) => community.name) },
    target: {
      annualCents, yearToDateCents: targetYtdCents, rate, gapCents, remainingDays, dailyNeedCents,
    },
    targetScope: { communityIds: targetCommunities.map((community) => community.id), communityNames: targetCommunities.map((community) => community.name) },
    missingTargetCommunities,
    partial,
    today: { paidCents: todayCents, billCount: todayBills, houseCount: todayHouses, vsDailyNeed: dailyNeedCents && dailyNeedCents > 0 ? round1((todayCents / dailyNeedCents) * 100) : null },
    monthToDate: { paidCents: monthPaidCents, targetCents: monthTargetCents, rate: monthTargetCents > 0 ? round1((monthPaidCents / monthTargetCents) * 100) : null },
    communities: communityRows,
    trend,
    arrears,
    recentPayments,
  };
}

function monthlyTargetForDaily(targets: CollectionTargetRow[]) {
  const result: Record<string, number> = {};
  for (const target of targets) {
    for (let month = 1; month <= 12; month += 1) {
      const value = target.monthCents[month - 1] ?? 0;
      if (!value) continue;
      const days = new Date(Date.UTC(target.year, month, 0)).getUTCDate();
      const key = `${target.year}-${pad(month)}`;
      result[key] = (result[key] || 0) + Math.round(value / days);
    }
  }
  return result;
}
