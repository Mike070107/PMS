import { BadRequestException } from '@nestjs/common';
import { MIS_PROPERTY_OFFICES } from '../fees/mis-fees.service';

/** 统计汇总年度报表类型：arrears=项目欠费年度汇总，received=项目实收年度汇总。 */
export const STATISTICS_TYPES = ['arrears', 'received'] as const;
export type StatisticsType = (typeof STATISTICS_TYPES)[number];

/** 旧系统管理处名称（生产已核对：01–05；05 为 MIS 精确值，无收费流水）。 */
export const STATISTICS_OFFICE_NAMES: Record<string, string> = {
  '01': '枫桦景苑一期',
  '02': '枫桦景苑二期A',
  '03': '枫桦景苑二期B',
  '04': '上海新家',
  '05': '馨香北桥-二期',
};

/**
 * MIS 房屋性质字典 FWXZK（来源：MIS 只读实测，2026-11-09）。
 * 旧报表「房屋性质」按收费明细行 WYZJ.FWXZ_DH（收费时点性质）过滤，
 * 不是室表当前性质；06「空房」需要能单独勾选/排除。
 */
export const STATISTICS_NATURE_LABELS: Record<string, string> = {
  '01': '商品房',
  '02': '售后公房',
  '03': '使用权房',
  '04': '商铺',
  '05': '配套用房',
  '06': '空房',
  '07': '居住',
  '08': '非居住',
  '09': '系统',
  '10': '非系统',
  '11': '代管',
  '12': '非代管',
  '13': '私房',
};

/** options.natures 固定返回 FWXZK 全量字典（按 code 排序），与镜像里实际出现的值无关。 */
export const STATISTICS_NATURE_OPTIONS: Array<{ code: string; name: string }> =
  Object.keys(STATISTICS_NATURE_LABELS)
    .sort()
    .map((code) => ({ code, name: STATISTICS_NATURE_LABELS[code] }));

export function statisticsNatureName(code: string): string {
  return STATISTICS_NATURE_LABELS[code] ?? `性质${code}`;
}

export interface StatisticsCommunityRef {
  id: number;
  name: string;
}

export interface StatisticsOffice {
  officeCode: string;
  officeName: string;
  /** PMS 小区 id；05 馨香北桥二期在 PMS 无同名小区，仅全公司范围展示。 */
  communityId: number | null;
  communityName: string | null;
}

/**
 * 旧系统管理处 → PMS 小区（复用收费模块已确认的 MIS_PROPERTY_OFFICES 映射）。
 * scope=null 表示全公司；否则只保留映射到授权小区内的管理处。
 * 05 馨香北桥二期没有 PMS 小区，只对全公司范围可见，避免越权。
 */
export function resolveStatisticsOffices(
  communities: StatisticsCommunityRef[],
  scope: number[] | null,
): StatisticsOffice[] {
  const byName = new Map(communities.map((community) => [community.name, community]));
  const codes = new Set<string>(['05']);
  for (const officeCodes of Object.values(MIS_PROPERTY_OFFICES)) {
    for (const code of officeCodes) codes.add(code);
  }
  const offices: StatisticsOffice[] = [];
  for (const officeCode of [...codes].sort()) {
    let community: StatisticsCommunityRef | undefined;
    for (const [communityName, officeCodes] of Object.entries(MIS_PROPERTY_OFFICES)) {
      if (!officeCodes.includes(officeCode)) continue;
      const matched = byName.get(communityName);
      if (matched) {
        community = matched;
        break;
      }
    }
    // 受限账号看不到没有 PMS 归属的 05；其它管理处按小区范围过滤。
    if (scope && (!community || !scope.includes(community.id))) continue;
    offices.push({
      officeCode,
      officeName: STATISTICS_OFFICE_NAMES[officeCode] ?? `管理处${officeCode}`,
      communityId: community?.id ?? null,
      communityName: community?.name ?? null,
    });
  }
  return offices;
}

/** 按请求的管理处勾选过滤（未勾选 = 全部授权管理处）。 */
export function filterRequestedOffices(offices: StatisticsOffice[], requested?: string[]): StatisticsOffice[] {
  if (!requested?.length) return offices;
  const wanted = new Set(requested);
  return offices.filter((office) => wanted.has(office.officeCode));
}

/** 年度列（含首尾）；限制跨度，避免一次拉出超宽表。 */
export function statisticsColumns(yearFrom: number, yearTo: number): number[] {
  if (!Number.isInteger(yearFrom) || !Number.isInteger(yearTo) || yearFrom > yearTo) {
    throw new BadRequestException('年度范围不合法');
  }
  if (yearTo - yearFrom > 50) throw new BadRequestException('年度范围不能超过 50 年');
  return Array.from({ length: yearTo - yearFrom + 1 }, (_, index) => yearFrom + index);
}

export interface StatisticsAnnualRawRow {
  officeCode: string;
  year: number | string;
  amountCents: number | string;
}

export interface StatisticsAnnualRow {
  officeCode: string;
  officeName: string;
  cells: Record<string, number>;
  totalCents: number;
}

/**
 * 把一条聚合 SQL 的结果摊成「管理处行 × 年度列」表格。
 * 没数据的年份补 0（旧系统同列显示 0.00）；合计 = 该行全部年份之和。
 * 金额全部是整数分，不在这里做元/分换算。
 */
export function buildAnnualTable(
  offices: StatisticsOffice[],
  columns: number[],
  raw: StatisticsAnnualRawRow[],
): { rows: StatisticsAnnualRow[]; subtotal: { cells: Record<string, number>; totalCents: number } } {
  const amountByOfficeYear = new Map<string, number>();
  for (const row of raw) {
    amountByOfficeYear.set(`${row.officeCode}:${Number(row.year)}`, Number(row.amountCents || 0));
  }
  const rows: StatisticsAnnualRow[] = offices.map((office) => {
    const cells: Record<string, number> = {};
    let totalCents = 0;
    for (const year of columns) {
      const cents = amountByOfficeYear.get(`${office.officeCode}:${year}`) ?? 0;
      cells[String(year)] = cents;
      totalCents += cents;
    }
    return { officeCode: office.officeCode, officeName: office.officeName, cells, totalCents };
  });
  const subtotalCells: Record<string, number> = {};
  let subtotalTotal = 0;
  for (const year of columns) {
    const cents = rows.reduce((sum, row) => sum + (row.cells[String(year)] ?? 0), 0);
    subtotalCells[String(year)] = cents;
    subtotalTotal += cents;
  }
  return { rows, subtotal: { cells: subtotalCells, totalCents: subtotalTotal } };
}

/** 欠费年月范围：201410-201412；只有一个月时只显示该月。 */
export function formatPeriodRange(start?: string | null, end?: string | null): string | null {
  if (!start) return end ?? null;
  if (!end || start === end) return start;
  return `${start}-${end}`;
}

export function isStatisticsType(value: unknown): value is StatisticsType {
  return value === 'arrears' || value === 'received';
}
