import { STATISTICS_OFFICE_NAMES } from './statistics.util';

/**
 * P2-C「欠收与溢收汇总」「收缴考核」纯函数层。
 * 金额一律整数分；这里只做口径常量、行/矩阵拼装与比率计算，不做元/分换算。
 */

/** 欠收与溢收汇总分组维度。 */
export const ARREARS_PREPAID_GROUP_BYS = ['office', 'fee'] as const;
export type ArrearsPrepaidGroupBy = (typeof ARREARS_PREPAID_GROUP_BYS)[number];

/** 欠收与溢收两个页签。 */
export const ARREARS_PREPAID_TABS = ['arrears', 'prepaid'] as const;
export type ArrearsPrepaidTab = (typeof ARREARS_PREPAID_TABS)[number];

/** 百分比：保留两位小数；分母<=0 时返回 0（不伪造 NaN/Infinity）。 */
export function roundRatePct(numeratorCents: number, denominatorCents: number): number {
  if (!denominatorCents || denominatorCents <= 0) return 0;
  return Math.round((numeratorCents * 10_000) / denominatorCents) / 100;
}

export interface AssessmentRawRow {
  officeCode: string;
  sId: number | null;
  address: string | null;
  ownerName: string | null;
  areaSqm: number | null;
  month: number | string;
  receivableCents: number | string;
  receivedCents: number | string;
}

export interface AssessmentMonth {
  month: number;
  receivableCents: number;
  receivedCents: number;
}

export interface AssessmentRow {
  officeCode: string;
  officeName: string;
  sId: number | null;
  address: string | null;
  ownerName: string | null;
  areaSqm: number | null;
  months: AssessmentMonth[];
  totalReceivableCents: number;
  totalReceivedCents: number;
  ratePct: number;
}

export interface AssessmentSummary {
  receivableCents: number;
  receivedCents: number;
  ratePct: number;
  payableHouseholds: number;
  paidHouseholds: number;
  householdRatePct: number;
}

/**
 * 收缴考核：行=房屋（管理处 + 楼栋/门牌 + 室号 + 业主），列=1–12 月应收/已收。
 * 已收按所属年月（period 年/月）归属；合计行/汇总对全部筛选计算，不受分页影响。
 */
export function buildCollectionAssessment(
  raw: AssessmentRawRow[],
  limit: number,
  offset: number,
): { rows: AssessmentRow[]; summary: AssessmentSummary; count: number } {
  const byHouse = new Map<string, {
    officeCode: string;
    sId: number | null;
    address: string | null;
    ownerName: string | null;
    areaSqm: number | null;
    receivable: number[];
    received: number[];
  }>();
  for (const row of raw) {
    const officeCode = (row.officeCode ?? '').trim();
    const key = `${officeCode}:${row.sId == null ? '' : row.sId}`;
    let house = byHouse.get(key);
    if (!house) {
      house = {
        officeCode,
        sId: row.sId == null ? null : Number(row.sId),
        address: row.address == null ? null : String(row.address),
        ownerName: row.ownerName == null ? null : String(row.ownerName),
        areaSqm: row.areaSqm == null ? null : Number(row.areaSqm),
        receivable: Array.from({ length: 12 }, () => 0),
        received: Array.from({ length: 12 }, () => 0),
      };
      byHouse.set(key, house);
    }
    const month = Number(row.month);
    if (!Number.isInteger(month) || month < 1 || month > 12) continue;
    house.receivable[month - 1] += Number(row.receivableCents || 0);
    house.received[month - 1] += Number(row.receivedCents || 0);
  }
  const all: AssessmentRow[] = [...byHouse.values()].map((house) => {
    const months: AssessmentMonth[] = Array.from({ length: 12 }, (_, index) => ({
      month: index + 1,
      receivableCents: house.receivable[index],
      receivedCents: house.received[index],
    }));
    const totalReceivableCents = months.reduce((sum, item) => sum + item.receivableCents, 0);
    const totalReceivedCents = months.reduce((sum, item) => sum + item.receivedCents, 0);
    return {
      officeCode: house.officeCode,
      officeName: STATISTICS_OFFICE_NAMES[house.officeCode] ?? `管理处${house.officeCode}`,
      sId: house.sId,
      address: house.address,
      ownerName: house.ownerName,
      areaSqm: house.areaSqm,
      months,
      totalReceivableCents,
      totalReceivedCents,
      ratePct: roundRatePct(totalReceivedCents, totalReceivableCents),
    };
  });
  all.sort((left, right) =>
    right.totalReceivableCents - left.totalReceivableCents
    || String(left.address ?? '').localeCompare(String(right.address ?? ''), 'zh-CN', { numeric: true })
    || Number(left.sId ?? 0) - Number(right.sId ?? 0));
  const receivableCents = all.reduce((sum, row) => sum + row.totalReceivableCents, 0);
  const receivedCents = all.reduce((sum, row) => sum + row.totalReceivedCents, 0);
  const payableHouseholds = all.filter((row) => row.totalReceivableCents > 0).length;
  const paidHouseholds = all.filter((row) => row.totalReceivedCents > 0).length;
  return {
    rows: all.slice(offset, offset + limit),
    summary: {
      receivableCents,
      receivedCents,
      ratePct: roundRatePct(receivedCents, receivableCents),
      payableHouseholds,
      paidHouseholds,
      householdRatePct: roundRatePct(paidHouseholds, payableHouseholds),
    },
    count: all.length,
  };
}
