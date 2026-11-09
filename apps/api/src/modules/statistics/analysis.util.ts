/**
 * P2-D「收款分析（按户）」「收费月报表（核心指标版）」纯函数/常量层。
 * 金额一律整数分；日期区间左闭右开 [dateFrom, dateTo+1)。
 */

/** 收款分析排序：当年欠收降序 / 历年欠收降序 / 地址升序。 */
export const ANALYSIS_SORTS = ['currentArrears', 'historyArrears', 'address'] as const;
export type CollectionAnalysisSort = (typeof ANALYSIS_SORTS)[number];

/** 月报表当前只按管理处分组（旧系统为小区（项目），与管理处一一映射）。 */
export const MONTHLY_REPORT_GROUP_BYS = ['office'] as const;
export type MonthlyReportGroupBy = (typeof MONTHLY_REPORT_GROUP_BYS)[number];

/**
 * 月报表 28 列中定义未知、需要旧系统截图确认的列。
 * 不伪造数据：接口显式返回 pendingColumns，前端标「待截图确认」。
 */
export const MONTHLY_REPORT_PENDING_COLUMNS = [
  '本期实收分项(收当月/收当年/收旧欠/待确认/收合计)',
  '累计实收数',
  '本期回收率分项',
  '本期欠收分项',
  '账面累计实收/累计溢收/收欠费',
] as const;

/** asOfPeriod=YYYYMM → 年份字符串 YYYY。 */
export function periodYear(asOfPeriod: string): string {
  return asOfPeriod.slice(0, 4);
}

/** 统计年月前后年边界：prevYearDec=上年12月，monthStart=本月1日，nextMonthStart=下月1日。 */
export function periodMonthBounds(asOfPeriod: string): {
  year: number;
  prevYearDec: string;
  monthStart: string;
  nextMonthStart: string;
} {
  const year = Number(asOfPeriod.slice(0, 4));
  const month = Number(asOfPeriod.slice(4, 6));
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  return {
    year,
    prevYearDec: `${year - 1}12`,
    monthStart: `${asOfPeriod.slice(0, 4)}-${asOfPeriod.slice(4, 6)}-01`,
    nextMonthStart: `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`,
  };
}
