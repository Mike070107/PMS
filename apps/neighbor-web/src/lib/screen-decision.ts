export type ManualMetrics = {
  sample: boolean; asOf: string; note: string; overdueHouses: number; overdueCents: number;
  untouchedHouses: number; untouchedCents: number; disputeCount: number; disputeCents: number;
  recoveredCents: number; duePromises: number; keptPromises: number; pendingHouses: number;
};
export type ScreenTargetSetting = { id: number; communityIds: number[]; feeCode: string; annualCents: number; monthCents: (number | null)[] };
export type ScreenSettingsData = { year: number; communities: { id: number; name: string }[]; targets: ScreenTargetSetting[];
  revision: number; manual: ManualMetrics | null; owners: { communityId: number; name: string }[]; updatedAt: string | null };
export type DecisionProject = { targetId: number; communityId: number | null; communityIds: number[]; name: string;
  annualCents: number; paidCents: number; plannedCents: number; behindCents: number; rate: number | null; planRate: number | null };
export type DecisionSummary = { year: number; asOf: string; source?: string; dataAsOf?: string; queriedAt?: string; partial: boolean; missingTargetCommunities: { id: number; name: string }[];
  target: { annualCents: number; yearToDateCents: number; rate: number | null; gapCents: number; remainingDays: number };
  decision: { plannedToDateCents: number | null; behindCents: number | null; planSource: string; requiredDailyCents: number | null;
    recentDailyCents: number | null; recentDays: number; forecastCents: number | null; projects: DecisionProject[]; planCurve: {key:string;plannedCents:number}[] };
  trend: { key: string; paidCents: number; targetCents: number }[];
};
export const chinaToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
export const amountWan = (value: number | null | undefined) => value == null ? '—' : (value / 1000000).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export function sampleManual(year: number): ManualMetrics {
  return { sample: true, asOf: `${year}${chinaToday().slice(4)}`, note: '预填示例，请按实际台账核实后更新',
    overdueHouses: 12, overdueCents: 18600000, untouchedHouses: 8, untouchedCents: 26400000,
    disputeCount: 6, disputeCents: 9200000, recoveredCents: 38600000, duePromises: 25, keptPromises: 18, pendingHouses: 28 };
}
export function distributeCents(annual: number) {
  const base = Math.floor(annual / 12);
  return Array.from({ length: 12 }, (_, i) => base + (i < annual % 12 ? 1 : 0));
}
