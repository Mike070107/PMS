import { useEffect, useRef, useState } from 'react';
import { request } from '@pms/api-client';
import ToneIcon from '@/components/ToneIcon';
import Icon from '@/components/Icon';
import { Loading, toast } from '@/components/ui';
import AnnualSummaryTable, { type AnnualCellTarget } from '@/components/statistics/AnnualSummaryTable';
import HouseDetailSheet, { type DetailTarget } from '@/components/statistics/HouseDetailSheet';
import FeeNatureTable, { type FeeNatureCellTarget } from '@/components/statistics/FeeNatureTable';
import DailyTable, { type DailyCellTarget } from '@/components/statistics/DailyTable';
import CollectionDetailSheet, { type CollectionDetailTarget } from '@/components/statistics/CollectionDetailSheet';
import ArrearsPrepaidTable from '@/components/statistics/ArrearsPrepaidTable';
import ArrearsBillsSheet, { type ArrearsBillsTarget } from '@/components/statistics/ArrearsBillsSheet';
import AssessmentTable from '@/components/statistics/AssessmentTable';
import CollectionAnalysisTable from '@/components/statistics/CollectionAnalysisTable';
import CollectionAnalysisDetailSheet, { type AnalysisDetailTarget } from '@/components/statistics/CollectionAnalysisDetailSheet';
import MonthlyReportTable from '@/components/statistics/MonthlyReportTable';
import PropertySummaryTable from '@/components/statistics/PropertySummaryTable';
import OwnerLedgerTable from '@/components/statistics/OwnerLedgerTable';
import BuildingLedgerTable from '@/components/statistics/BuildingLedgerTable';
import ReliefTable from '@/components/statistics/ReliefTable';
import SignoffsTable from '@/components/statistics/SignoffsTable';
import TicketSummaryTable from '@/components/statistics/TicketSummaryTable';
import TicketsTable from '@/components/statistics/TicketsTable';
import StatisticsFilters from '@/components/statistics/StatisticsFilters';
import { dayjs } from '@/lib/format';
import {
  PENDING_REPORTS, REPORTS,
  annualCsv, annualQueryParams, arrearsPrepaidCsv, arrearsPrepaidDetailParams, arrearsPrepaidSummaryParams,
  assessmentCsv, assessmentQueryParams, buildingLedgerCsv, buildingLedgerParams,
  collectionAnalysisCsv, collectionAnalysisParams, collectionQueryParams, dailyCsv, dailyQueryParams, downloadCsv,
  feeNatureCsv, fmtCents, monthlyReportCsv, monthlyReportParams, ownerLedgerCsv, ownerLedgerParams,
  propertySummaryCsv, propertySummaryParams, reliefCsv, reliefParams, reportName, signoffsCsv, signoffsParams,
  ticketSummaryCsv, ticketSummaryParams, ticketsCsv, ticketsParams,
  type AnnualQuery, type AnnualReportType, type AnnualSummaryResponse, type ArrearsPrepaidDetailResponse,
  type ArrearsPrepaidQuery, type ArrearsPrepaidSummaryResponse, type ArrearsPrepaidDetailRow,
  type AssessmentQuery, type AssessmentResponse, type BuildingLedgerQuery, type BuildingLedgerResponse,
  type CollectionAnalysisQuery, type CollectionAnalysisResponse, type CollectionQuery, type DailyQuery,
  type DailyResponse, type FeeNatureResponse, type FilterDraft, type MonthlyReportQuery, type MonthlyReportResponse,
  type OwnerLedgerQuery, type OwnerLedgerResponse, type PropertySummaryQuery, type PropertySummaryResponse,
  type ReliefQuery, type ReliefResponse, type ReportQuery, type SignoffsQuery, type SignoffsResponse,
  type StatisticsOptions, type StatisticsReportType, type TicketListQuery, type TicketsResponse,
  type TicketSummaryQuery, type TicketSummaryResponse,
} from '@/lib/statistics';
import '@/styles/statistics.css';

/**
 * 各报表默认房屋性质（旧系统截图口径）：
 * - 实收年度汇总：包含 06 空房（13 项全选）；
 * - 欠费年度汇总：排除 06 空房（12 项），与旧系统截图 01=662,269.00 一致；
 * - P2 收费汇总/日报表：13 项全选（列模板需要全部房屋性质）。
 */
const DEFAULT_EXCLUDED_NATURE_BY_REPORT: Record<StatisticsReportType, Set<string>> = {
  received: new Set(),
  arrears: new Set(['06']),
  'fee-nature': new Set(),
  daily: new Set(),
  'arrears-prepaid': new Set(),
  assessment: new Set(),
  'collection-analysis': new Set(),
  'monthly-report': new Set(),
  'property-summary': new Set(),
  'owner-ledger': new Set(),
  'building-ledger': new Set(),
  relief: new Set(),
  signoffs: new Set(),
  'ticket-summary': new Set(),
  tickets: new Set(),
};

/** P2 报表日期区间必填，默认本月 1 日~今天；P1 报表保留原行为（日期可选）。 */
function isDateRequired(type: StatisticsReportType): boolean {
  return type === 'fee-nature' || type === 'daily' || type === 'collection-analysis' || type === 'relief' || type === 'signoffs'
    || type === 'ticket-summary' || type === 'tickets';
}

function defaultDateRange(type: StatisticsReportType): { from: string; to: string } {
  if (!isDateRequired(type)) return { from: '', to: '' };
  const today = dayjs();
  if (type === 'relief' || type === 'signoffs' || type === 'tickets') {
    return { from: `${today.year()}-01-01`, to: today.format('YYYY-MM-DD') };
  }
  return { from: `${today.year()}-${String(today.month() + 1).padStart(2, '0')}-01`, to: today.format('YYYY-MM-DD') };
}

/** 筛选悬浮面板收纳状态（用户要求记住上次状态；窄屏默认收起）。 */
const FILTERS_COLLAPSED_KEY = 'statistics.filters.collapsed';

function initialFiltersCollapsed(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const stored = window.localStorage.getItem(FILTERS_COLLAPSED_KEY);
    if (stored === '1') return true;
    if (stored === '0') return false;
  } catch { /* 隐私模式读不到本地存储时按视口判断 */ }
  return window.innerWidth <= 900;
}

function rememberFiltersCollapsed(collapsed: boolean) {
  try { window.localStorage.setItem(FILTERS_COLLAPSED_KEY, collapsed ? '1' : '0'); } catch { /* 忽略存储失败 */ }
}

/** 指定报表类型的默认房屋性质（实收含 06；欠费排除 06；P2 全选）。 */
function defaultNatures(options: StatisticsOptions, reportType: StatisticsReportType): string[] {
  const excluded = DEFAULT_EXCLUDED_NATURE_BY_REPORT[reportType];
  return options.natures.map((nature) => nature.code).filter((code) => !excluded.has(code));
}

/** 两个房屋性质勾选集合是否相同（用于判断用户是否手动改过）。 */
function sameNatureSelection(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const expected = new Set(right);
  return left.every((code) => expected.has(code));
}

/** 筛选草稿的默认值：管理处/收费项目全选；房屋性质按报表类型默认；P2 日期默认本月。 */
function defaultDraft(options: StatisticsOptions, reportType: StatisticsReportType): FilterDraft {
  const range = defaultDateRange(reportType);
  const today = dayjs();
  return {
    officeCodes: options.offices.map((office) => office.officeCode),
    feeCodes: options.feeItems.map((fee) => fee.code),
    natures: defaultNatures(options, reportType),
    paidDateFrom: range.from,
    paidDateTo: reportType === 'arrears-prepaid' || reportType === 'assessment' ? today.format('YYYY-MM-DD') : range.to,    asOfPeriod: reportType === 'arrears-prepaid' || reportType === 'collection-analysis' || reportType === 'monthly-report'
      ? `${today.year()}${String(today.month() + 1).padStart(2, '0')}`
      : `${dayjs().year()}12`,
    paymentMethods: (options.paymentMethods ?? []).map((method) => method.id),
    cashier: '',
    subjectYearFrom: '',
    subjectYearTo: '',
    assessmentYear: String(today.year()),
    analysisSort: 'currentArrears',
    ledgerKeyword: '',
    signoffTypes: [],
    signoffStatus: 'all',
    ticketStatus: 'all',
  };
}

/** 由草稿 + 当前报表生成请求快照（类型收窄放这里，页面渲染只读快照）。 */
function buildQuery(type: StatisticsReportType, draft: FilterDraft, options: StatisticsOptions): ReportQuery {
  if (type === 'received' || type === 'arrears') {
    const annual: AnnualQuery = {
      type: type as AnnualReportType,
      officeCodes: draft.officeCodes,
      feeCodes: draft.feeCodes,
      natures: draft.natures,
      yearFrom: options.yearRange.min,
      yearTo: options.yearRange.max,
      asOfPeriod: draft.asOfPeriod,
      paidDateFrom: draft.paidDateFrom,
      paidDateTo: draft.paidDateTo,
    };
    return annual;
  }
  if (type === 'fee-nature') {
    const query: CollectionQuery = {
      type: 'fee-nature',
      officeCodes: draft.officeCodes,
      feeCodes: draft.feeCodes,
      natures: draft.natures,
      paymentMethods: draft.paymentMethods,
      cashier: draft.cashier.trim(),
      dateFrom: draft.paidDateFrom,
      dateTo: draft.paidDateTo,
      subjectYearFrom: draft.subjectYearFrom,
      subjectYearTo: draft.subjectYearTo,
    };
    return query;
  }
  if (type === 'arrears-prepaid') {
    const query: ArrearsPrepaidQuery = {
      type: 'arrears-prepaid',
      tab: 'arrears',
      officeCodes: draft.officeCodes,
      feeCodes: draft.feeCodes,
      natures: draft.natures,
      asOfPeriod: draft.asOfPeriod,
      paidDateTo: draft.paidDateTo,
    };
    return query;
  }
  if (type === 'assessment') {
    const query: AssessmentQuery = {
      type: 'assessment',
      officeCodes: draft.officeCodes,
      feeCodes: draft.feeCodes,
      natures: draft.natures,
      year: draft.assessmentYear,
      paidDateTo: draft.paidDateTo,
    };
    return query;
  }
  if (type === 'collection-analysis') {
    const query: CollectionAnalysisQuery = {
      type: 'collection-analysis',
      officeCodes: draft.officeCodes,
      feeCodes: draft.feeCodes,
      natures: draft.natures,
      asOfPeriod: draft.asOfPeriod,
      dateFrom: draft.paidDateFrom,
      dateTo: draft.paidDateTo,
      sort: draft.analysisSort,
    };
    return query;
  }
  if (type === 'monthly-report') {
    const query: MonthlyReportQuery = {
      type: 'monthly-report',
      officeCodes: draft.officeCodes,
      feeCodes: draft.feeCodes,
      natures: draft.natures,
      asOfPeriod: draft.asOfPeriod,
    };
    return query;
  }
  if (type === 'property-summary') {
    const query: PropertySummaryQuery = { type: 'property-summary', officeCodes: draft.officeCodes };
    return query;
  }
  if (type === 'owner-ledger') {
    const query: OwnerLedgerQuery = {
      type: 'owner-ledger', officeCodes: draft.officeCodes, natures: draft.natures, keyword: draft.ledgerKeyword,
    };
    return query;
  }
  if (type === 'building-ledger') {
    const query: BuildingLedgerQuery = { type: 'building-ledger', officeCodes: draft.officeCodes, keyword: draft.ledgerKeyword };
    return query;
  }
  if (type === 'relief') {
    const query: ReliefQuery = {
      type: 'relief',
      officeCodes: draft.officeCodes,
      feeCodes: draft.feeCodes,
      dateFrom: draft.paidDateFrom,
      dateTo: draft.paidDateTo,
      keyword: draft.ledgerKeyword,
    };
    return query;
  }
  if (type === 'signoffs') {
    const query: SignoffsQuery = {
      type: 'signoffs',
      officeCodes: draft.officeCodes,
      types: draft.signoffTypes,
      status: draft.signoffStatus,
      dateFrom: draft.paidDateFrom,
      dateTo: draft.paidDateTo,
      keyword: draft.ledgerKeyword,
    };
    return query;
  }
  if (type === 'ticket-summary') {
    const query: TicketSummaryQuery = {
      type: 'ticket-summary',
      officeCodes: draft.officeCodes,
      feeCodes: draft.feeCodes,
      paymentMethods: draft.paymentMethods,
      cashier: draft.cashier.trim(),
      dateFrom: draft.paidDateFrom,
      dateTo: draft.paidDateTo,
    };
    return query;
  }
  if (type === 'tickets') {
    const query: TicketListQuery = {
      type: 'tickets',
      officeCodes: draft.officeCodes,
      status: draft.ticketStatus,
      keyword: draft.ledgerKeyword,
      dateFrom: draft.paidDateFrom,
      dateTo: draft.paidDateTo,
    };
    return query;
  }
  const query: DailyQuery = {
    type: 'daily',
    officeCodes: draft.officeCodes,
    feeCodes: draft.feeCodes,
    natures: draft.natures,
    dateFrom: draft.paidDateFrom,
    dateTo: draft.paidDateTo,
  };
  return query;
}

function timeText(value?: string | null): string {
  if (!value) return '';
  const parsed = dayjs(value);
  return parsed.isValid() ? parsed.format('YYYY-MM-DD HH:mm') : String(value);
}

/**
 * 统计汇总（P1 + P2）：旧「一通软件」统计菜单的前端复刻。
 * 左侧筛选勾选；已接入：实收/欠费年度汇总、收费汇总（费项×性质矩阵）、收款日报表（日期×费项矩阵）。
 * 点金额单元格下钻逐笔明细；导出当前筛选的 CSV（UTF-8 BOM）。
 */
export default function Statistics() {
  const [options, setOptions] = useState<StatisticsOptions | null>(null);
  const [optionsError, setOptionsError] = useState('');
  const [optionsRetry, setOptionsRetry] = useState(0);
  const [draft, setDraft] = useState<FilterDraft>({
    officeCodes: [], feeCodes: [], natures: [], paidDateFrom: '', paidDateTo: '', asOfPeriod: '',
    paymentMethods: [], cashier: '', subjectYearFrom: '', subjectYearTo: '', assessmentYear: String(dayjs().year()),
    analysisSort: 'currentArrears', ledgerKeyword: '', signoffTypes: [], signoffStatus: 'all', ticketStatus: 'all',
  });
  const [reportType, setReportType] = useState<StatisticsReportType>('received');
  const reportTypeRef = useRef<StatisticsReportType>('received');
  const [applied, setApplied] = useState<ReportQuery | null>(null);
  const [annual, setAnnual] = useState<AnnualSummaryResponse | null>(null);
  const [annualLoading, setAnnualLoading] = useState(false);
  const [annualError, setAnnualError] = useState('');
  const [collection, setCollection] = useState<FeeNatureResponse | null>(null);
  const [collectionLoading, setCollectionLoading] = useState(false);
  const [collectionError, setCollectionError] = useState('');
  const [daily, setDaily] = useState<DailyResponse | null>(null);
  const [dailyLoading, setDailyLoading] = useState(false);
  const [dailyError, setDailyError] = useState('');
  const [arrearsSummary, setArrearsSummary] = useState<ArrearsPrepaidSummaryResponse | null>(null);
  const [arrearsDetail, setArrearsDetail] = useState<ArrearsPrepaidDetailResponse | null>(null);
  const [arrearsLoading, setArrearsLoading] = useState(false);
  const [arrearsError, setArrearsError] = useState('');
  const [arrearsBillsTarget, setArrearsBillsTarget] = useState<ArrearsBillsTarget | null>(null);
  const [arrearsBillsOpen, setArrearsBillsOpen] = useState(false);
  const [assessment, setAssessment] = useState<AssessmentResponse | null>(null);
  const [assessmentLoading, setAssessmentLoading] = useState(false);
  const [assessmentError, setAssessmentError] = useState('');
  const [analysis, setAnalysis] = useState<CollectionAnalysisResponse | null>(null);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [analysisError, setAnalysisError] = useState('');
  const [analysisTarget, setAnalysisTarget] = useState<AnalysisDetailTarget | null>(null);
  const [analysisDetailOpen, setAnalysisDetailOpen] = useState(false);
  const [monthlyReport, setMonthlyReport] = useState<MonthlyReportResponse | null>(null);
  const [monthlyLoading, setMonthlyLoading] = useState(false);
  const [monthlyError, setMonthlyError] = useState('');
  const [propertySummary, setPropertySummary] = useState<PropertySummaryResponse | null>(null);
  const [propertyLoading, setPropertyLoading] = useState(false);
  const [propertyError, setPropertyError] = useState('');
  const [ownerLedger, setOwnerLedger] = useState<OwnerLedgerResponse | null>(null);
  const [ownerLoading, setOwnerLoading] = useState(false);
  const [ownerError, setOwnerError] = useState('');
  const [buildingLedger, setBuildingLedger] = useState<BuildingLedgerResponse | null>(null);
  const [buildingLoading, setBuildingLoading] = useState(false);
  const [buildingError, setBuildingError] = useState('');
  const [relief, setRelief] = useState<ReliefResponse | null>(null);
  const [reliefLoading, setReliefLoading] = useState(false);
  const [reliefError, setReliefError] = useState('');
  const [signoffs, setSignoffs] = useState<SignoffsResponse | null>(null);
  const [signoffsLoading, setSignoffsLoading] = useState(false);
  const [signoffsError, setSignoffsError] = useState('');
  const [ticketSummary, setTicketSummary] = useState<TicketSummaryResponse | null>(null);
  const [ticketSummaryLoading, setTicketSummaryLoading] = useState(false);
  const [ticketSummaryError, setTicketSummaryError] = useState('');
  const [tickets, setTickets] = useState<TicketsResponse | null>(null);
  const [ticketsLoading, setTicketsLoading] = useState(false);
  const [ticketsError, setTicketsError] = useState('');
  const [reportRetry, setReportRetry] = useState(0);
  const [detailTarget, setDetailTarget] = useState<DetailTarget | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [collectionTarget, setCollectionTarget] = useState<CollectionDetailTarget | null>(null);
  const [collectionDetailOpen, setCollectionDetailOpen] = useState(false);
  const [filtersCollapsed, setFiltersCollapsed] = useState<boolean>(initialFiltersCollapsed);

  const toggleFilters = () => {
    setFiltersCollapsed((collapsed) => {
      const next = !collapsed;
      rememberFiltersCollapsed(next);
      return next;
    });
  };

  useEffect(() => { reportTypeRef.current = reportType; }, [reportType]);

  // 筛选选项：只读加载一次（失败可重试），成功后全选并自动出第一张报表。
  useEffect(() => {
    let cancelled = false;
    setOptionsError('');
    request<StatisticsOptions>({ url: '/statistics/options' })
      .then((response) => {
        if (cancelled) return;
        setOptions(response);
        const nextDraft = defaultDraft(response, reportTypeRef.current);
        setDraft(nextDraft);
        setApplied(buildQuery(reportTypeRef.current, nextDraft, response));
      })
      .catch((error) => {
        if (cancelled) return;
        setOptions(null);
        setOptionsError(error instanceof Error && error.message ? error.message : '统计筛选读取失败');
      });
    return () => { cancelled = true; };
  }, [optionsRetry]);

  // 只有 applied 变化（点「统计」/切报表/重试）才请求；改草稿不自动请求。
  useEffect(() => {
    if (!applied) return undefined;
    let cancelled = false;
    if (applied.type === 'received' || applied.type === 'arrears') {
      setAnnualLoading(true); setAnnualError('');
      request<AnnualSummaryResponse>({ url: '/statistics/annual', query: annualQueryParams(applied) })
        .then((response) => { if (!cancelled) setAnnual(response); })
        .catch((error) => { if (!cancelled) setAnnualError(error instanceof Error && error.message ? error.message : '统计数据读取失败'); })
        .finally(() => { if (!cancelled) setAnnualLoading(false); });
    } else if (applied.type === 'fee-nature') {
      setCollectionLoading(true); setCollectionError('');
      request<FeeNatureResponse>({ url: '/statistics/collection/fee-nature', query: collectionQueryParams(applied) })
        .then((response) => { if (!cancelled) setCollection(response); })
        .catch((error) => { if (!cancelled) setCollectionError(error instanceof Error && error.message ? error.message : '收费汇总读取失败'); })
        .finally(() => { if (!cancelled) setCollectionLoading(false); });
    } else if (applied.type === 'daily') {
      setDailyLoading(true); setDailyError('');
      request<DailyResponse>({ url: '/statistics/daily', query: dailyQueryParams(applied as DailyQuery) })
        .then((response) => { if (!cancelled) setDaily(response); })
        .catch((error) => { if (!cancelled) setDailyError(error instanceof Error && error.message ? error.message : '收款日报表读取失败'); })
        .finally(() => { if (!cancelled) setDailyLoading(false); });
    } else if (applied.type === 'arrears-prepaid') {
      setArrearsLoading(true); setArrearsError('');
      Promise.all([
        request<ArrearsPrepaidSummaryResponse>({ url: '/statistics/arrears-prepaid/summary', query: arrearsPrepaidSummaryParams(applied) }),
        request<ArrearsPrepaidDetailResponse>({ url: '/statistics/arrears-prepaid/detail', query: arrearsPrepaidDetailParams(applied) }),
      ])
        .then(([summary, detail]) => {
          if (cancelled) return;
          setArrearsSummary(summary);
          setArrearsDetail(detail);
        })
        .catch((error) => { if (!cancelled) setArrearsError(error instanceof Error && error.message ? error.message : '欠收与溢收读取失败'); })
        .finally(() => { if (!cancelled) setArrearsLoading(false); });
    } else if (applied.type === 'assessment') {
      setAssessmentLoading(true); setAssessmentError('');
      request<AssessmentResponse>({ url: '/statistics/collection-assessment', query: assessmentQueryParams(applied as AssessmentQuery) })
        .then((response) => { if (!cancelled) setAssessment(response); })
        .catch((error) => { if (!cancelled) setAssessmentError(error instanceof Error && error.message ? error.message : '收缴考核读取失败'); })
        .finally(() => { if (!cancelled) setAssessmentLoading(false); });
    } else if (applied.type === 'collection-analysis') {
      setAnalysisLoading(true); setAnalysisError('');
      request<CollectionAnalysisResponse>({ url: '/statistics/collection-analysis', query: collectionAnalysisParams(applied) })
        .then((response) => { if (!cancelled) setAnalysis(response); })
        .catch((error) => { if (!cancelled) setAnalysisError(error instanceof Error && error.message ? error.message : '收款分析读取失败'); })
        .finally(() => { if (!cancelled) setAnalysisLoading(false); });
    } else if (applied.type === 'monthly-report') {
      setMonthlyLoading(true); setMonthlyError('');
      request<MonthlyReportResponse>({ url: '/statistics/monthly-report', query: monthlyReportParams(applied as MonthlyReportQuery) })
        .then((response) => { if (!cancelled) setMonthlyReport(response); })
        .catch((error) => { if (!cancelled) setMonthlyError(error instanceof Error && error.message ? error.message : '收费月报表读取失败'); })
        .finally(() => { if (!cancelled) setMonthlyLoading(false); });
    } else if (applied.type === 'property-summary') {
      setPropertyLoading(true); setPropertyError('');
      request<PropertySummaryResponse>({ url: '/statistics/property-summary', query: propertySummaryParams(applied) })
        .then((response) => { if (!cancelled) setPropertySummary(response); })
        .catch((error) => { if (!cancelled) setPropertyError(error instanceof Error && error.message ? error.message : '房产汇总读取失败'); })
        .finally(() => { if (!cancelled) setPropertyLoading(false); });
    } else if (applied.type === 'owner-ledger') {
      setOwnerLoading(true); setOwnerError('');
      request<OwnerLedgerResponse>({ url: '/statistics/owner-ledger', query: ownerLedgerParams(applied) })
        .then((response) => { if (!cancelled) setOwnerLedger(response); })
        .catch((error) => { if (!cancelled) setOwnerError(error instanceof Error && error.message ? error.message : '住户台账读取失败'); })
        .finally(() => { if (!cancelled) setOwnerLoading(false); });
    } else if (applied.type === 'building-ledger') {
      setBuildingLoading(true); setBuildingError('');
      request<BuildingLedgerResponse>({ url: '/statistics/building-ledger', query: buildingLedgerParams(applied as BuildingLedgerQuery) })
        .then((response) => { if (!cancelled) setBuildingLedger(response); })
        .catch((error) => { if (!cancelled) setBuildingError(error instanceof Error && error.message ? error.message : '楼房台账读取失败'); })
        .finally(() => { if (!cancelled) setBuildingLoading(false); });
    } else if (applied.type === 'relief') {
      setReliefLoading(true); setReliefError('');
      request<ReliefResponse>({ url: '/statistics/relief', query: reliefParams(applied) })
        .then((response) => { if (!cancelled) setRelief(response); })
        .catch((error) => { if (!cancelled) setReliefError(error instanceof Error && error.message ? error.message : '减免情况读取失败'); })
        .finally(() => { if (!cancelled) setReliefLoading(false); });
    } else if (applied.type === 'signoffs') {
      setSignoffsLoading(true); setSignoffsError('');
      request<SignoffsResponse>({ url: '/statistics/signoffs', query: signoffsParams(applied as SignoffsQuery) })
        .then((response) => { if (!cancelled) setSignoffs(response); })
        .catch((error) => { if (!cancelled) setSignoffsError(error instanceof Error && error.message ? error.message : '签报情况读取失败'); })
        .finally(() => { if (!cancelled) setSignoffsLoading(false); });
    } else if (applied.type === 'ticket-summary') {
      setTicketSummaryLoading(true); setTicketSummaryError('');
      request<TicketSummaryResponse>({ url: '/statistics/ticket-summary', query: ticketSummaryParams(applied) })
        .then((response) => { if (!cancelled) setTicketSummary(response); })
        .catch((error) => { if (!cancelled) setTicketSummaryError(error instanceof Error && error.message ? error.message : '收款汇总表读取失败'); })
        .finally(() => { if (!cancelled) setTicketSummaryLoading(false); });
    } else {
      setTicketsLoading(true); setTicketsError('');
      request<TicketsResponse>({ url: '/statistics/tickets', query: ticketsParams(applied as TicketListQuery) })
        .then((response) => { if (!cancelled) setTickets(response); })
        .catch((error) => { if (!cancelled) setTicketsError(error instanceof Error && error.message ? error.message : '票据情况读取失败'); })
        .finally(() => { if (!cancelled) setTicketsLoading(false); });
    }
    return () => { cancelled = true; };
  }, [applied, reportRetry]);

  const datesFilled = !!draft.paidDateFrom && !!draft.paidDateTo;
  const isLedger = reportType === 'property-summary' || reportType === 'owner-ledger' || reportType === 'building-ledger';
  const hasRequiredSelections = isLedger || reportType === 'signoffs' || reportType === 'tickets'
    ? draft.officeCodes.length > 0
    : reportType === 'relief' || reportType === 'ticket-summary'
      ? draft.officeCodes.length > 0 && draft.feeCodes.length > 0
      : draft.officeCodes.length > 0 && draft.feeCodes.length > 0 && draft.natures.length > 0;
  const canSubmit = !!options
    && hasRequiredSelections
    && (!isDateRequired(reportType) || datesFilled)
    && (reportType !== 'arrears-prepaid' || (!!draft.asOfPeriod && !!draft.paidDateTo))
    && (reportType !== 'assessment' || !!draft.assessmentYear)
    && (reportType !== 'monthly-report' || !!draft.asOfPeriod)
    && (reportType !== 'fee-nature' || draft.paymentMethods.length > 0);

  const resetDraft = () => {
    if (!options) return;
    setDraft(defaultDraft(options, reportType));
  };

  const submit = () => {
    if (!options || !canSubmit) return;
    if (isDateRequired(reportType) && !datesFilled) { toast('请填写收款日期范围'); return; }
    if (reportType === 'arrears-prepaid' && (!draft.asOfPeriod || !draft.paidDateTo)) { toast('请填写统计年月和收款截止日期'); return; }
    if (reportType === 'assessment' && !draft.assessmentYear) { toast('请选择统计年份'); return; }
    if (draft.paidDateFrom && draft.paidDateTo && draft.paidDateFrom > draft.paidDateTo
      && (reportType === 'received' || reportType === 'arrears' || isDateRequired(reportType))) {
      toast('收款日期起不能晚于收款日期至');
      return;
    }
    if (draft.subjectYearFrom && draft.subjectYearTo && Number(draft.subjectYearFrom) > Number(draft.subjectYearTo)) {
      toast('所属年度起不能晚于所属年度止');
      return;
    }
    setDetailOpen(false);
    setDetailTarget(null);
    setCollectionDetailOpen(false);
    setCollectionTarget(null);
    setApplied(buildQuery(reportType, draft, options));
  };

  const switchReport = (type: StatisticsReportType) => {
    setDetailOpen(false);
    setDetailTarget(null);
    setCollectionDetailOpen(false);
    setCollectionTarget(null);
    if (!options) {
      setReportType(type);
      return;
    }
    // 只有当前房屋性质仍等于「切换前报表的默认值」时才自动换成新报表默认；
    // 用户手动改过就保留（实收/欠费默认差在 06 空房，P2 为 13 项全选）。
    const followsPreviousDefault = sameNatureSelection(draft.natures, defaultNatures(options, reportType));
    const nextDraft: FilterDraft = { ...draft, natures: followsPreviousDefault ? defaultNatures(options, type) : draft.natures };
    // P2 报表日期必填：从其它报表切过来时用新报表默认范围（避免沿用旧报表的月份/年份区间）。
    if (isDateRequired(type)) {
      const previousDefault = defaultDateRange(reportType);
      const followsPreviousDefault = nextDraft.paidDateFrom === previousDefault.from && nextDraft.paidDateTo === previousDefault.to;
      if (!nextDraft.paidDateFrom || !nextDraft.paidDateTo || followsPreviousDefault) {
        const range = defaultDateRange(type);
        nextDraft.paidDateFrom = range.from;
        nextDraft.paidDateTo = range.to;
      }
    }
    if (type === 'fee-nature' && !nextDraft.paymentMethods.length) {
      nextDraft.paymentMethods = (options.paymentMethods ?? []).map((method) => method.id);
    }
    if (type === 'arrears-prepaid') {
      const today = dayjs();
      const previousDefaultPeriod = defaultDraft(options, reportType).asOfPeriod;
      if (!nextDraft.asOfPeriod || nextDraft.asOfPeriod === previousDefaultPeriod) {
        nextDraft.asOfPeriod = `${today.year()}${String(today.month() + 1).padStart(2, '0')}`;
      }
      if (!nextDraft.paidDateTo) nextDraft.paidDateTo = today.format('YYYY-MM-DD');
    }
    if (type === 'assessment') {
      if (!nextDraft.assessmentYear) nextDraft.assessmentYear = String(dayjs().year());
      if (!nextDraft.paidDateTo) nextDraft.paidDateTo = dayjs().format('YYYY-MM-DD');
    }
    if (type === 'collection-analysis' || type === 'monthly-report') {
      const today = dayjs();
      const previousDefaultPeriod = defaultDraft(options, reportType).asOfPeriod;
      if (!nextDraft.asOfPeriod || nextDraft.asOfPeriod === previousDefaultPeriod) {
        nextDraft.asOfPeriod = `${today.year()}${String(today.month() + 1).padStart(2, '0')}`;
      }
      if (type === 'collection-analysis') {
        if (!nextDraft.paidDateFrom || !nextDraft.paidDateTo) {
          const range = defaultDateRange('collection-analysis');
          nextDraft.paidDateFrom = range.from;
          nextDraft.paidDateTo = range.to;
        }
        if (!nextDraft.analysisSort) nextDraft.analysisSort = 'currentArrears';
      }
    }
    setReportType(type);
    setDraft(nextDraft);
    setApplied(buildQuery(type, nextDraft, options));
  };

  const openCell = (target: AnnualCellTarget) => {
    setDetailTarget(target);
    setDetailOpen(true);
  };

  const openFeeNatureCell = (target: FeeNatureCellTarget) => {
    if (!applied || applied.type !== 'fee-nature') return;
    setCollectionTarget({
      feeCode: target.feeCode,
      feeName: target.feeName,
      natureCode: target.natureCode,
      natureName: collection?.columns.find((column) => column.code === target.natureCode)?.name ?? target.natureCode,
      kind: target.kind,
    });
    setCollectionDetailOpen(true);
  };

  const openDailyCell = (target: DailyCellTarget) => {
    if (!applied || applied.type !== 'daily') return;
    setCollectionTarget({
      feeCode: target.feeCode,
      feeName: target.feeName,
      date: target.date,
      kind: 'received',
    });
    setCollectionDetailOpen(true);
  };

  const switchArrearsTab = (tab: ArrearsPrepaidQuery['tab']) => {
    if (!applied || applied.type !== 'arrears-prepaid' || applied.tab === tab) return;
    setArrearsDetail(null);
    setArrearsBillsOpen(false);
    setApplied({ ...applied, tab });
  };

  const openArrearsBills = (row: ArrearsPrepaidDetailRow) => {
    setArrearsBillsTarget({
      sId: row.sId, feeCode: row.feeCode, feeName: row.feeName, address: row.address, amountCents: row.amountCents,
    });
    setArrearsBillsOpen(true);
  };

  const loadMoreArrears = async () => {
    if (!applied || applied.type !== 'arrears-prepaid' || !arrearsDetail) return;
    try {
      const response = await request<ArrearsPrepaidDetailResponse>({
        url: '/statistics/arrears-prepaid/detail',
        query: arrearsPrepaidDetailParams(applied, arrearsDetail.rows.length),
      });
      setArrearsDetail((previous) => (previous
        ? { ...previous, rows: [...previous.rows, ...(response.rows ?? [])], totals: response.totals ?? previous.totals, count: response.count ?? previous.count }
        : response));
    } catch (e) {
      toast(e instanceof Error && e.message ? e.message : '加载更多失败');
    }
  };

  const loadMoreAssessment = async () => {
    if (!applied || applied.type !== 'assessment' || !assessment) return;
    try {
      const response = await request<AssessmentResponse>({
        url: '/statistics/collection-assessment',
        query: assessmentQueryParams(applied, assessment.rows.length),
      });
      setAssessment((previous) => (previous
        ? { ...previous, rows: [...previous.rows, ...(response.rows ?? [])], count: response.count ?? previous.count }
        : response));
    } catch (e) {
      toast(e instanceof Error && e.message ? e.message : '加载更多失败');
    }
  };

  const openAnalysisDetail = (row: CollectionAnalysisResponse['rows'][number]) => {
    setAnalysisTarget({ sId: row.sId, address: row.address, ownerName: row.ownerName });
    setAnalysisDetailOpen(true);
  };

  const loadMoreAnalysis = async () => {
    if (!applied || applied.type !== 'collection-analysis' || !analysis) return;
    try {
      const response = await request<CollectionAnalysisResponse>({
        url: '/statistics/collection-analysis',
        query: collectionAnalysisParams(applied, analysis.rows.length),
      });
      setAnalysis((previous) => (previous
        ? { ...previous, rows: [...previous.rows, ...(response.rows ?? [])], totals: response.totals ?? previous.totals, count: response.count ?? previous.count }
        : response));
    } catch (e) {
      toast(e instanceof Error && e.message ? e.message : '加载更多失败');
    }
  };

  const loadMoreOwnerLedger = async () => {
    if (!applied || applied.type !== 'owner-ledger' || !ownerLedger) return;
    try {
      const response = await request<OwnerLedgerResponse>({
        url: '/statistics/owner-ledger',
        query: ownerLedgerParams(applied, ownerLedger.rows.length),
      });
      setOwnerLedger((previous) => (previous
        ? { ...previous, rows: [...previous.rows, ...(response.rows ?? [])], count: response.count ?? previous.count, totals: response.totals ?? previous.totals }
        : response));
    } catch (e) {
      toast(e instanceof Error && e.message ? e.message : '加载更多失败');
    }
  };

  const loadMoreBuildingLedger = async () => {
    if (!applied || applied.type !== 'building-ledger' || !buildingLedger) return;
    try {
      const response = await request<BuildingLedgerResponse>({
        url: '/statistics/building-ledger',
        query: buildingLedgerParams(applied, buildingLedger.rows.length),
      });
      setBuildingLedger((previous) => (previous
        ? { ...previous, rows: [...previous.rows, ...(response.rows ?? [])], count: response.count ?? previous.count, totals: response.totals ?? previous.totals }
        : response));
    } catch (e) {
      toast(e instanceof Error && e.message ? e.message : '加载更多失败');
    }
  };

  const loadMoreRelief = async () => {
    if (!applied || applied.type !== 'relief' || !relief) return;
    try {
      const response = await request<ReliefResponse>({ url: '/statistics/relief', query: reliefParams(applied, relief.rows.length) });
      setRelief((previous) => (previous
        ? { ...previous, rows: [...previous.rows, ...(response.rows ?? [])], totals: response.totals ?? previous.totals, count: response.count ?? previous.count }
        : response));
    } catch (e) {
      toast(e instanceof Error && e.message ? e.message : '加载更多失败');
    }
  };

  const loadMoreSignoffs = async () => {
    if (!applied || applied.type !== 'signoffs' || !signoffs) return;
    try {
      const response = await request<SignoffsResponse>({ url: '/statistics/signoffs', query: signoffsParams(applied, signoffs.rows.length) });
      setSignoffs((previous) => (previous
        ? { ...previous, rows: [...previous.rows, ...(response.rows ?? [])], totals: response.totals ?? previous.totals, count: response.count ?? previous.count }
        : response));
    } catch (e) {
      toast(e instanceof Error && e.message ? e.message : '加载更多失败');
    }
  };

  const loadMoreTickets = async () => {
    if (!applied || applied.type !== 'tickets' || !tickets) return;
    try {
      const response = await request<TicketsResponse>({ url: '/statistics/tickets', query: ticketsParams(applied as TicketListQuery, tickets.rows.length) });
      setTickets((previous) => (previous
        ? { ...previous, rows: [...previous.rows, ...(response.rows ?? [])], totals: response.totals ?? previous.totals, count: response.count ?? previous.count }
        : response));
    } catch (e) {
      toast(e instanceof Error && e.message ? e.message : '加载更多失败');
    }
  };

  const exportCurrent = () => {
    if (!applied) return;
    const stamp = dayjs().format('YYYYMMDD');
    if (applied.type === 'received' || applied.type === 'arrears') {
      if (!annual) return;
      const csv = annualCsv(annual, {
        dataAsOf: annual.dataAsOf || options?.dataAsOf || null,
        filters: applied,
        offices: options?.offices,
        feeItems: options?.feeItems,
        natures: options?.natures,
      });
      const name = `统计汇总-${reportName(annual.type)}-${stamp}.csv`;
      if (downloadCsv(name, csv)) toast('已导出当前筛选结果 CSV');
      else toast('导出失败，请重试');
      return;
    }
    if (applied.type === 'fee-nature') {
      if (!collection) return;
      const name = `统计汇总-收费汇总-${stamp}.csv`;
      if (downloadCsv(name, feeNatureCsv(collection, applied, options?.feeItems))) toast('已导出收费汇总 CSV');
      else toast('导出失败，请重试');
      return;
    }
    if (applied.type === 'daily') {
      if (!daily) return;
      const name = `统计汇总-收款日报表-${stamp}.csv`;
      if (downloadCsv(name, dailyCsv(daily, applied as DailyQuery, options?.feeItems))) toast('已导出收款日报表 CSV');
      else toast('导出失败，请重试');
      return;
    }
    if (applied.type === 'arrears-prepaid') {
      if (!arrearsDetail) return;
      const name = `统计汇总-欠收与溢收汇总-${applied.tab === 'arrears' ? '欠收' : '溢收'}-${stamp}.csv`;
      if (downloadCsv(name, arrearsPrepaidCsv(arrearsDetail, applied))) toast('已导出欠收与溢收汇总 CSV');
      else toast('导出失败，请重试');
      return;
    }
    if (applied.type === 'collection-analysis') {
      if (!analysis) return;
      const name = `统计汇总-收款分析-${stamp}.csv`;
      if (downloadCsv(name, collectionAnalysisCsv(analysis, applied))) toast('已导出收款分析 CSV');
      else toast('导出失败，请重试');
      return;
    }
    if (applied.type === 'monthly-report') {
      if (!monthlyReport) return;
      const name = `统计汇总-收费月报表（核心指标）-${stamp}.csv`;
      if (downloadCsv(name, monthlyReportCsv(monthlyReport, applied as MonthlyReportQuery))) toast('已导出收费月报表 CSV');
      else toast('导出失败，请重试');
      return;
    }
    if (applied.type === 'property-summary') {
      if (!propertySummary) return;
      const name = `统计汇总-房产汇总-${stamp}.csv`;
      if (downloadCsv(name, propertySummaryCsv(propertySummary, applied))) toast('已导出房产汇总 CSV');
      else toast('导出失败，请重试');
      return;
    }
    if (applied.type === 'owner-ledger') {
      if (!ownerLedger) return;
      const name = `统计汇总-住户台账-${stamp}.csv`;
      if (downloadCsv(name, ownerLedgerCsv(ownerLedger, applied))) toast('已导出住户台账 CSV');
      else toast('导出失败，请重试');
      return;
    }
    if (applied.type === 'building-ledger') {
      if (!buildingLedger) return;
      const name = `统计汇总-楼房台账-${stamp}.csv`;
      if (downloadCsv(name, buildingLedgerCsv(buildingLedger, applied as BuildingLedgerQuery))) toast('已导出楼房台账 CSV');
      else toast('导出失败，请重试');
      return;
    }
    if (applied.type === 'relief') {
      if (!relief) return;
      const name = `统计汇总-减免情况统计-${stamp}.csv`;
      if (downloadCsv(name, reliefCsv(relief, applied))) toast('已导出减免情况统计 CSV');
      else toast('导出失败，请重试');
      return;
    }
    if (applied.type === 'signoffs') {
      if (!signoffs) return;
      const name = `统计汇总-签报情况统计-${stamp}.csv`;
      if (downloadCsv(name, signoffsCsv(signoffs, applied))) toast('已导出签报情况统计 CSV');
      else toast('导出失败，请重试');
      return;
    }
    if (applied.type === 'ticket-summary') {
      if (!ticketSummary) return;
      const name = `统计汇总-收款汇总表-${stamp}.csv`;
      if (downloadCsv(name, ticketSummaryCsv(ticketSummary, applied))) toast('已导出收款汇总表 CSV');
      else toast('导出失败，请重试');
      return;
    }
    if (applied.type === 'tickets') {
      if (!tickets) return;
      const name = `统计汇总-票据情况统计-${stamp}.csv`;
      if (downloadCsv(name, ticketsCsv(tickets, applied as TicketListQuery))) toast('已导出票据情况统计 CSV');
      else toast('导出失败，请重试');
      return;
    }
    if (applied.type === 'assessment') {
      if (!assessment) return;
      const name = `统计汇总-收缴考核-${stamp}.csv`;
      if (downloadCsv(name, assessmentCsv(assessment, applied as AssessmentQuery))) toast('已导出收缴考核 CSV');
      else toast('导出失败，请重试');
    }
  };

  const activeLabel = reportName(applied?.type ?? reportType);
  const signoffTypeOptions = Array.from(new Set((signoffs?.rows ?? []).map((row) => row.type).filter((value): value is string => !!value)));
  const hasExportData = applied?.type === 'fee-nature'
    ? !!collection
    : applied?.type === 'daily'
      ? !!daily
      : applied?.type === 'arrears-prepaid'
        ? !!arrearsDetail
        : applied?.type === 'assessment'
          ? !!assessment
          : applied?.type === 'collection-analysis'
            ? !!analysis
            : applied?.type === 'monthly-report'
              ? !!monthlyReport
              : applied?.type === 'property-summary'
                ? !!propertySummary
                : applied?.type === 'owner-ledger'
                  ? !!ownerLedger
                  : applied?.type === 'building-ledger'
                    ? !!buildingLedger
                    : applied?.type === 'relief'
                      ? !!relief
                      : applied?.type === 'signoffs'
                        ? !!signoffs
                        : applied?.type === 'ticket-summary'
                          ? !!ticketSummary
                          : applied?.type === 'tickets'
                            ? !!tickets
                            : !!annual;
  const isLoading = applied?.type === 'fee-nature'
    ? collectionLoading
    : applied?.type === 'daily'
      ? dailyLoading
      : applied?.type === 'arrears-prepaid'
        ? arrearsLoading
        : applied?.type === 'assessment'
          ? assessmentLoading
          : applied?.type === 'collection-analysis'
            ? analysisLoading
            : applied?.type === 'monthly-report'
              ? monthlyLoading
              : applied?.type === 'property-summary'
                ? propertyLoading
                : applied?.type === 'owner-ledger'
                  ? ownerLoading
                  : applied?.type === 'building-ledger'
                    ? buildingLoading
                    : applied?.type === 'relief'
                      ? reliefLoading
                      : applied?.type === 'signoffs'
                        ? signoffsLoading
                        : applied?.type === 'ticket-summary'
                          ? ticketSummaryLoading
                          : applied?.type === 'tickets'
                            ? ticketsLoading
                            : annualLoading;
  const activeError = applied?.type === 'fee-nature'
    ? collectionError
    : applied?.type === 'daily'
      ? dailyError
      : applied?.type === 'arrears-prepaid'
        ? arrearsError
        : applied?.type === 'assessment'
          ? assessmentError
          : applied?.type === 'collection-analysis'
            ? analysisError
            : applied?.type === 'monthly-report'
              ? monthlyError
              : applied?.type === 'property-summary'
                ? propertyError
                : applied?.type === 'owner-ledger'
                  ? ownerError
                  : applied?.type === 'building-ledger'
                    ? buildingError
                    : applied?.type === 'relief'
                      ? reliefError
                      : applied?.type === 'signoffs'
                        ? signoffsError
                        : applied?.type === 'ticket-summary'
                          ? ticketSummaryError
                          : applied?.type === 'tickets'
                            ? ticketsError
                            : annualError;
  const activeDataAsOf = applied?.type === 'fee-nature'
    ? collection?.dataAsOf
    : applied?.type === 'daily'
      ? daily?.dataAsOf
      : applied?.type === 'arrears-prepaid'
        ? (arrearsSummary?.dataAsOf ?? arrearsDetail?.dataAsOf)
        : applied?.type === 'assessment'
          ? assessment?.dataAsOf
          : applied?.type === 'collection-analysis'
            ? analysis?.dataAsOf
            : applied?.type === 'monthly-report'
              ? monthlyReport?.dataAsOf
              : applied?.type === 'property-summary'
                ? propertySummary?.dataAsOf
                : applied?.type === 'owner-ledger'
                  ? ownerLedger?.dataAsOf
                  : applied?.type === 'building-ledger'
                    ? buildingLedger?.dataAsOf
                    : applied?.type === 'relief'
                      ? relief?.dataAsOf
                      : applied?.type === 'signoffs'
                        ? signoffs?.dataAsOf
                        : applied?.type === 'ticket-summary'
                          ? ticketSummary?.dataAsOf
                          : applied?.type === 'tickets'
                            ? tickets?.dataAsOf
                            : annual?.dataAsOf;
  const dataAsOf = timeText(activeDataAsOf || options?.dataAsOf);
  const sourceLabel = options?.sourceMode === 'mirror' ? 'MIS 镜像' : (options?.sourceMode || '');
  const activeAvailable = applied?.type === 'fee-nature'
    ? collection?.available
    : applied?.type === 'daily'
      ? daily?.available
      : applied?.type === 'arrears-prepaid'
        ? (arrearsDetail?.available ?? arrearsSummary?.available)
        : applied?.type === 'assessment'
          ? assessment?.available
          : applied?.type === 'collection-analysis'
            ? analysis?.available
            : applied?.type === 'monthly-report'
              ? monthlyReport?.available
              : applied?.type === 'property-summary'
                ? propertySummary?.available
                : applied?.type === 'owner-ledger'
                  ? ownerLedger?.available
                  : applied?.type === 'building-ledger'
                    ? buildingLedger?.available
                    : applied?.type === 'relief'
                      ? relief?.available
                      : applied?.type === 'signoffs'
                        ? signoffs?.available
                        : applied?.type === 'ticket-summary'
                          ? ticketSummary?.available
                          : applied?.type === 'tickets'
                            ? tickets?.available
                            : annual?.available;
  const activeMessage = applied?.type === 'fee-nature'
    ? collection?.message
    : applied?.type === 'daily'
      ? daily?.message
      : applied?.type === 'arrears-prepaid'
        ? (arrearsDetail?.message ?? arrearsSummary?.message)
        : applied?.type === 'assessment'
          ? assessment?.message
          : applied?.type === 'collection-analysis'
            ? analysis?.message
            : applied?.type === 'monthly-report'
              ? monthlyReport?.message
              : applied?.type === 'property-summary'
                ? propertySummary?.message
                : applied?.type === 'owner-ledger'
                  ? ownerLedger?.message
                  : applied?.type === 'building-ledger'
                    ? buildingLedger?.message
                    : applied?.type === 'relief'
                      ? relief?.message
                      : applied?.type === 'signoffs'
                        ? signoffs?.message
                        : applied?.type === 'ticket-summary'
                          ? ticketSummary?.message
                          : applied?.type === 'tickets'
                            ? tickets?.message
                            : annual?.message;

  const dateRangeText = applied?.type === 'arrears-prepaid'
    ? `统计年月 ${applied.asOfPeriod} · 收款截止 ${applied.paidDateTo}`
    : applied?.type === 'assessment'
      ? `统计年份 ${applied.year}${applied.paidDateTo ? ` · 收款截止 ${applied.paidDateTo}` : ''}`
      : applied?.type === 'collection-analysis'
        ? `统计年月 ${applied.asOfPeriod} · 收款日期 ${[applied.dateFrom, applied.dateTo].filter(Boolean).join(' 至 ')}`
        : applied?.type === 'monthly-report'
          ? `统计年月 ${applied.asOfPeriod}`
          : applied && 'dateFrom' in applied
            ? [applied.dateFrom, applied.dateTo].filter(Boolean).join(' 至 ')
            : '';

  return (
    <div className="stats">
      <div className="ph" style={{ marginBottom: 14 }}>
        <div>
          <div className="h1row"><ToneIcon kind="dashboard" /><h1 style={{ fontSize: 22 }}>统计汇总</h1></div>
          <p>按管理处 / 收费项目 / 房屋性质勾选汇总；年度与收款矩阵均可逐级下钻到逐笔明细</p>
        </div>
        <div className="act stats-head-actions">
          {dataAsOf ? <span className="tag mute">数据截止 {dataAsOf}</span> : null}
          {sourceLabel ? <span className="tag acc">{sourceLabel}</span> : null}
          <button type="button" className="btn sm" disabled={!applied || isLoading} onClick={() => setReportRetry((value) => value + 1)}>
            <Icon name="refresh" size={15} />刷新
          </button>
        </div>
      </div>

      {optionsError && !options ? (
        <div className="card" style={{ padding: 22 }}>
          <div className="note2" role="alert" style={{ background: 'var(--dang-w)', color: 'var(--dang)' }}>
            <Icon name="alert" />{optionsError}
            <button className="btn sm" style={{ marginLeft: 10 }} onClick={() => setOptionsRetry((value) => value + 1)}>重试</button>
          </div>
        </div>
      ) : !options ? (
        <Loading text="读取统计筛选…" />
      ) : options.available === false ? (
        <div className="card" style={{ padding: 22 }}>
          <div className="note2" role="status">
            <Icon name="alert" />{options.message || 'MIS 镜像数据尚未就绪，暂不能统计；请稍后再试。'}
            <button className="btn sm" style={{ marginLeft: 10 }} onClick={() => setOptionsRetry((value) => value + 1)}>重试</button>
          </div>
        </div>
      ) : (
        <div className={`stats-body${filtersCollapsed ? ' filters-collapsed' : ''}`}>
          {!filtersCollapsed ? (
            <>
              <div className="stats-filter-mask" aria-hidden="true" onClick={toggleFilters} />
              <div className="stats-filter-float" role="dialog" aria-label="统计筛选">
                <StatisticsFilters
                  options={options}
                  draft={draft}
                  onChange={(patch) => setDraft((previous) => ({ ...previous, ...patch }))}
                  onSubmit={submit}
                  onReset={resetDraft}
                  onExport={exportCurrent}
                  onCollapse={toggleFilters}
                  reportType={reportType}
                  signoffTypeOptions={signoffTypeOptions}
                  canExport={activeAvailable !== false && hasExportData}
                  loading={isLoading}
                />
              </div>
            </>
          ) : null}

          <section className="stats-main">
            <div className="card stats-catalog">
              <div className="stats-catalog-main">
                {REPORTS.map((report) => (
                  <button
                    key={report.type}
                    type="button"
                    data-report-type={report.type}
                    className={`stats-report-tab${(applied?.type ?? reportType) === report.type ? ' on' : ''}`}
                    title={report.hint}
                    onClick={() => switchReport(report.type)}
                  >{report.name}</button>
                ))}
                <span className="stats-catalog-sep" aria-hidden="true" />
                <span className="stats-pending-title">待接入</span>
                {PENDING_REPORTS.map((name) => (
                  <span key={name} className="stats-report-pending" aria-disabled="true" title={`${name}：待接入`}>{name}</span>
                ))}
              </div>
            </div>

            <div className="card stats-result">
              <div className="panelHd stats-result-head">
                <button
                  type="button"
                  className={`btn sm stats-filter-toggle${filtersCollapsed ? '' : ' on'}`}
                  data-testid="stats-filter-toggle"
                  aria-expanded={!filtersCollapsed}
                  title={filtersCollapsed ? '展开筛选条件' : '收起筛选条件，给数据区更多宽度'}
                  onClick={toggleFilters}
                >
                  <Icon name="search" size={15} />{filtersCollapsed ? '筛选' : '收起筛选'}
                </button>
                <b>{activeLabel}</b>
                {applied?.type === 'fee-nature' && collection && collection.available !== false ? <span className="tag mute">{collection.rows.length} 个收费项目</span> : null}
                {applied?.type === 'daily' && daily && daily.available !== false ? <span className="tag mute">{daily.rows.length} 天</span> : null}
                {applied?.type !== 'fee-nature' && applied?.type !== 'daily' && (applied?.type === 'received' || applied?.type === 'arrears') && annual && annual.available !== false ? <span className="tag mute">{annual.rows.length} 个管理处</span> : null}
                {activeAvailable !== false && applied?.type === 'received' && annual?.subtotal ? <span className="tag acc">合计 {fmtCents(annual.subtotal.totalCents)}</span> : null}
                {activeAvailable !== false && applied?.type === 'arrears' && annual?.subtotal ? <span className="tag acc">合计 {fmtCents(annual.subtotal.totalCents)}</span> : null}
                {activeAvailable !== false && applied?.type === 'fee-nature' && collection?.subtotal ? <span className="tag acc">合计 {fmtCents(collection.subtotal.netCents)}</span> : null}
                {activeAvailable !== false && applied?.type === 'daily' && daily?.subtotal ? <span className="tag acc">合计 {fmtCents(daily.subtotal.totalCents)}</span> : null}
                {activeAvailable !== false && applied?.type === 'arrears-prepaid' && arrearsSummary?.total ? (
                  <span className="tag acc">欠收 {fmtCents(arrearsSummary.total.arrearsCents)}</span>
                ) : null}
                {activeAvailable !== false && applied?.type === 'arrears-prepaid' && arrearsSummary?.total ? (
                  <span className="tag warn">溢收 {fmtCents(arrearsSummary.total.prepaidCents)}</span>
                ) : null}
                {activeAvailable !== false && applied?.type === 'assessment' && assessment?.summary ? (
                  <span className="tag acc">收缴率 {Number(assessment.summary.ratePct || 0).toFixed(2)}%</span>
                ) : null}
                {activeAvailable !== false && applied?.type === 'collection-analysis' && analysis ? (
                  <span className="tag mute">{analysis.rows.length} 户</span>
                ) : null}
                {activeAvailable !== false && applied?.type === 'monthly-report' && monthlyReport?.totals ? (
                  <span className="tag acc">本期回收率 {Number(monthlyReport.totals.recoveryRatePct || 0).toFixed(2)}%</span>
                ) : null}
                {activeAvailable !== false && applied?.type === 'property-summary' && propertySummary ? (
                  <span className="tag mute">{propertySummary.rows.length} 个管理处</span>
                ) : null}
                {activeAvailable !== false && applied?.type === 'owner-ledger' && ownerLedger ? (
                  <span className="tag mute">{ownerLedger.count ?? ownerLedger.rows.length} 户</span>
                ) : null}
                {activeAvailable !== false && applied?.type === 'building-ledger' && buildingLedger ? (
                  <span className="tag mute">{buildingLedger.count ?? buildingLedger.rows.length} 栋</span>
                ) : null}
                {activeAvailable !== false && applied?.type === 'relief' && relief ? (
                  <span className="tag mute">{relief.count ?? relief.rows.length} 条</span>
                ) : null}
                {activeAvailable !== false && applied?.type === 'signoffs' && signoffs ? (
                  <span className="tag mute">{signoffs.count ?? signoffs.rows.length} 件</span>
                ) : null}
                {activeAvailable !== false && applied?.type === 'ticket-summary' && ticketSummary?.totals ? (
                  <span className="tag acc">合计 {fmtCents(ticketSummary.totals.netCents)}</span>
                ) : null}
                {activeAvailable !== false && applied?.type === 'tickets' && tickets ? (
                  <span className="tag mute">{tickets.count ?? tickets.rows.length} 张</span>
                ) : null}
                {applied?.type === 'received' || applied?.type === 'arrears' ? (
                  annual?.columns?.length ? <span className="muted stats-range">{annual.columns[0]}–{annual.columns[annual.columns.length - 1]} 年度</span> : null
                ) : dateRangeText ? <span className="muted stats-range">{dateRangeText}</span> : null}
                <span className="muted stats-as-of">{dataAsOf ? `数据截止 ${dataAsOf}` : ''}</span>
              </div>

              {applied?.type === 'received' && annual?.available !== false ? (
                <div className="note2 stats-received-hint">
                  <Icon name="alert" />实收年度按「应收年月」归年（收款日期可跨年）；收款日期范围只用于筛选已收流水，不改变年度归属。点单元格查逐笔清单。
                </div>
              ) : null}
              {applied?.type === 'fee-nature' && collection?.available !== false ? (
                <div className="note2 stats-received-hint" data-testid="fee-nature-hint">
                  <Icon name="alert" />按收款日期统计收款/退款/调整；所属年度按应收年月筛选。行尾金额与房屋性质单元格均可点击查看逐笔明细，明细合计=单元格。
                </div>
              ) : null}
              {applied?.type === 'daily' && daily?.available !== false ? (
                <div className="note2 stats-received-hint" data-testid="daily-report-hint">
                  <Icon name="alert" />按收款日期逐日统计；没有收款的日期不显示 0 行。点单元格查当日收款明细。
                </div>
              ) : null}
              {applied?.type === 'collection-analysis' && analysis?.available !== false ? (
                <div className="note2 stats-received-hint" data-testid="collection-analysis-hint">
                  <Icon name="alert" />按户汇总：历年欠收/当年欠收/当月应收/预缴/区间实收；点行查该户逐笔明细，默认按当年欠收降序。
                </div>
              ) : null}
              {applied?.type === 'monthly-report' && monthlyReport?.available !== false ? (
                <div className="note2 stats-received-hint" data-testid="monthly-report-hint">
                  <Icon name="alert" />核心指标版：另有本期实收分项/累计实收/账面累计实收等列待旧系统截图确认，暂不显示。
                  {monthlyReport?.pendingColumns?.length ? `（待确认：${monthlyReport.pendingColumns.join('、')}）` : ''}
                </div>
              ) : null}
              {applied?.type === 'property-summary' && propertySummary?.available !== false ? (
                <div className="note2 stats-received-hint" data-testid="property-summary-hint">
                  <Icon name="alert" />按管理处汇总楼栋数/房屋数/业主数/建筑面积，并列出各房屋性质的房屋数。
                </div>
              ) : null}
              {applied?.type === 'owner-ledger' && ownerLedger?.available !== false ? (
                <div className="note2 stats-received-hint" data-testid="owner-ledger-hint">
                  <Icon name="alert" />关键词匹配地址/房号/业主/手机/电话；手机/电话缺失显示「—」；每页 200 户，可加载更多。
                </div>
              ) : null}
              {applied?.type === 'building-ledger' && buildingLedger?.available !== false ? (
                <div className="note2 stats-received-hint" data-testid="building-ledger-hint">
                  <Icon name="alert" />关键词匹配路/弄/楼号；每页 200 栋，可加载更多。
                </div>
              ) : null}
              {applied?.type === 'relief' && relief?.available !== false ? (
                <div className="note2 stats-received-hint" data-testid="relief-hint">
                  <Icon name="alert" />减免记录按减免日期筛选；金额合计=原应收/现应收/减免金额，每页 200 条可加载更多。
                </div>
              ) : null}
              {applied?.type === 'signoffs' && signoffs?.available !== false ? (
                <div className="note2 stats-received-hint" data-testid="signoffs-hint">
                  <Icon name="alert" />签报按拟稿日期筛选；状态标签：生效绿/作废灰/未结束橙；合计为调整金额与件数。
                </div>
              ) : null}
              {applied?.type === 'ticket-summary' && ticketSummary?.available !== false ? (
                <div className="note2 stats-received-hint" data-testid="ticket-summary-hint">
                  <Icon name="alert" />按收款日期统计；主表列为动态收款方式；「票据口径」为开票数据，与收款金额口径不同；另有按收款人副表。
                </div>
              ) : null}
              {applied?.type === 'tickets' && tickets?.available !== false ? (
                <div className="note2 stats-received-hint" data-testid="tickets-hint">
                  <Icon name="alert" />按开票日期统计；状态色标：已开绿/预开蓝/作废灰/已核销；每页 200 张可加载更多。
                </div>
              ) : null}

              {isLoading ? <Loading text="统计中…" /> : activeError ? (
                <div className="note2" role="alert" style={{ background: 'var(--dang-w)', color: 'var(--dang)' }}>
                  <Icon name="alert" />{activeError}
                  <button className="btn sm" style={{ marginLeft: 10 }} onClick={() => setReportRetry((value) => value + 1)}>重试</button>
                </div>
              ) : applied?.type === 'fee-nature' ? (
                collection ? (
                  collection.available === false ? (
                    <div className="note2" role="status"><Icon name="alert" />{collection.message || '收费汇总数据尚未就绪；请稍后再试。'}</div>
                  ) : collection.rows.length ? (
                    <FeeNatureTable report={collection} onCellClick={openFeeNatureCell} />
                  ) : <div className="empty">{collection.message || '当前筛选没有可汇总的数据'}</div>
                ) : null
              ) : applied?.type === 'daily' ? (
                daily ? (
                  daily.available === false ? (
                    <div className="note2" role="status"><Icon name="alert" />{daily.message || '收款日报表数据尚未就绪；请稍后再试。'}</div>
                  ) : daily.rows.length ? (
                    <DailyTable report={daily} onCellClick={openDailyCell} />
                  ) : <div className="empty">{daily.message || '当前筛选没有可汇总的数据'}</div>
                ) : null
              ) : applied?.type === 'arrears-prepaid' ? (
                arrearsDetail ? (
                  arrearsDetail.available === false ? (
                    <div className="note2" role="status"><Icon name="alert" />{arrearsDetail.message || '欠收与溢收数据尚未就绪；请稍后再试。'}</div>
                  ) : (
                    <>
                      <div className="stats-tabs" role="tablist" aria-label="欠收与溢收">
                        {(['arrears', 'prepaid'] as const).map((tab) => (
                          <button
                            key={tab}
                            type="button"
                            role="tab"
                            data-arrears-tab={tab}
                            aria-selected={applied.tab === tab}
                            className={`stats-tab${applied.tab === tab ? ' on' : ''}`}
                            onClick={() => switchArrearsTab(tab)}
                          >{tab === 'arrears' ? '欠收统计' : '溢收统计'}</button>
                        ))}
                      </div>
                      {arrearsSummary?.rows?.length ? (
                        <div className="stats-summary-chips" data-testid="arrears-summary-chips">
                          {arrearsSummary.rows.map((row) => (
                            <span key={row.officeCode} className="stats-summary-chip">
                              <b>{row.officeName || row.officeCode}</b>
                              <span>欠收 {fmtCents(row.arrearsCents)}</span>
                              <span>溢收 {fmtCents(row.prepaidCents)}</span>
                            </span>
                          ))}
                        </div>
                      ) : null}
                      {arrearsDetail.rows.length ? (
                        <>
                          <ArrearsPrepaidTable report={arrearsDetail} tab={applied.tab} onView={openArrearsBills} />
                          {arrearsDetail.count != null && arrearsDetail.rows.length < arrearsDetail.count ? (
                            <div className="stats-load-more">
                              <button type="button" className="btn sm" onClick={() => void loadMoreArrears()}>
                                加载更多（已显示 {arrearsDetail.rows.length}/{arrearsDetail.count}）
                              </button>
                            </div>
                          ) : null}
                        </>
                      ) : <div className="empty">{arrearsDetail.message || (applied.tab === 'arrears' ? '当前筛选没有欠收明细' : '当前筛选没有溢收明细')}</div>}
                    </>
                  )
                ) : null
              ) : applied?.type === 'assessment' ? (
                assessment ? (
                  assessment.available === false ? (
                    <div className="note2" role="status"><Icon name="alert" />{assessment.message || '收缴考核数据尚未就绪；请稍后再试。'}</div>
                  ) : (
                    <>
                      {assessment.summary ? (
                        <div className="stats-kpi-cards" data-testid="assessment-cards">
                          <div className="stats-kpi"><span>应收合计</span><b>{fmtCents(assessment.summary.receivableCents)}</b></div>
                          <div className="stats-kpi"><span>已收合计</span><b>{fmtCents(assessment.summary.receivedCents)}</b></div>
                          <div className="stats-kpi"><span>金额收缴率</span><b>{Number(assessment.summary.ratePct || 0).toFixed(2)}%</b></div>
                          <div className="stats-kpi"><span>应缴 / 已缴户数</span><b>{assessment.summary.payableHouseholds} / {assessment.summary.paidHouseholds}</b></div>
                          <div className="stats-kpi"><span>按户数收缴率</span><b>{Number(assessment.summary.householdRatePct || 0).toFixed(2)}%</b></div>
                        </div>
                      ) : null}
                      {assessment.rows.length ? (
                        <>
                          <AssessmentTable report={assessment} />
                          {assessment.count != null && assessment.rows.length < assessment.count ? (
                            <div className="stats-load-more">
                              <button type="button" className="btn sm" onClick={() => void loadMoreAssessment()}>
                                加载更多（已显示 {assessment.rows.length}/{assessment.count}）
                              </button>
                            </div>
                          ) : null}
                        </>
                      ) : <div className="empty">{assessment.message || '当前筛选没有收缴考核数据'}</div>}
                    </>
                  )
                ) : null
              ) : applied?.type === 'collection-analysis' ? (
                analysis ? (
                  analysis.available === false ? (
                    <div className="note2" role="status"><Icon name="alert" />{analysis.message || '收款分析数据尚未就绪；请稍后再试。'}</div>
                  ) : analysis.rows.length ? (
                    <>
                      <CollectionAnalysisTable report={analysis} onRowClick={openAnalysisDetail} />
                      {analysis.count != null && analysis.rows.length < analysis.count ? (
                        <div className="stats-load-more">
                          <button type="button" className="btn sm" onClick={() => void loadMoreAnalysis()}>
                            加载更多（已显示 {analysis.rows.length}/{analysis.count}）
                          </button>
                        </div>
                      ) : null}
                    </>
                  ) : <div className="empty">{analysis.message || '当前筛选没有收款分析数据'}</div>
                ) : null
              ) : applied?.type === 'monthly-report' ? (
                monthlyReport ? (
                  monthlyReport.available === false ? (
                    <div className="note2" role="status"><Icon name="alert" />{monthlyReport.message || '收费月报表数据尚未就绪；请稍后再试。'}</div>
                  ) : monthlyReport.rows.length ? (
                    <MonthlyReportTable report={monthlyReport} />
                  ) : <div className="empty">{monthlyReport.message || '当前筛选没有收费月报表数据'}</div>
                ) : null
              ) : applied?.type === 'property-summary' ? (
                propertySummary ? (
                  propertySummary.available === false ? (
                    <div className="note2" role="status"><Icon name="alert" />{propertySummary.message || '房产汇总数据尚未就绪；请稍后再试。'}</div>
                  ) : propertySummary.rows.length ? (
                    <PropertySummaryTable report={propertySummary} />
                  ) : <div className="empty">{propertySummary.message || '当前筛选没有房产数据'}</div>
                ) : null
              ) : applied?.type === 'owner-ledger' ? (
                ownerLedger ? (
                  ownerLedger.available === false ? (
                    <div className="note2" role="status"><Icon name="alert" />{ownerLedger.message || '住户台账数据尚未就绪；请稍后再试。'}</div>
                  ) : ownerLedger.rows.length ? (
                    <>
                      <OwnerLedgerTable report={ownerLedger} />
                      {ownerLedger.count != null && ownerLedger.rows.length < ownerLedger.count ? (
                        <div className="stats-load-more">
                          <button type="button" className="btn sm" onClick={() => void loadMoreOwnerLedger()}>
                            加载更多（已显示 {ownerLedger.rows.length}/{ownerLedger.count}）
                          </button>
                        </div>
                      ) : null}
                    </>
                  ) : <div className="empty">{ownerLedger.message || '当前筛选没有住户数据'}</div>
                ) : null
              ) : applied?.type === 'building-ledger' ? (
                buildingLedger ? (
                  buildingLedger.available === false ? (
                    <div className="note2" role="status"><Icon name="alert" />{buildingLedger.message || '楼房台账数据尚未就绪；请稍后再试。'}</div>
                  ) : buildingLedger.rows.length ? (
                    <>
                      <BuildingLedgerTable report={buildingLedger} />
                      {buildingLedger.count != null && buildingLedger.rows.length < buildingLedger.count ? (
                        <div className="stats-load-more">
                          <button type="button" className="btn sm" onClick={() => void loadMoreBuildingLedger()}>
                            加载更多（已显示 {buildingLedger.rows.length}/{buildingLedger.count}）
                          </button>
                        </div>
                      ) : null}
                    </>
                  ) : <div className="empty">{buildingLedger.message || '当前筛选没有楼房数据'}</div>
                ) : null
              ) : applied?.type === 'relief' ? (
                relief ? (
                  relief.available === false ? (
                    <div className="note2" role="status"><Icon name="alert" />{relief.message || '减免情况数据尚未就绪；请稍后再试。'}</div>
                  ) : relief.rows.length ? (
                    <>
                      <ReliefTable report={relief} />
                      {relief.count != null && relief.rows.length < relief.count ? (
                        <div className="stats-load-more">
                          <button type="button" className="btn sm" onClick={() => void loadMoreRelief()}>
                            加载更多（已显示 {relief.rows.length}/{relief.count}）
                          </button>
                        </div>
                      ) : null}
                    </>
                  ) : <div className="empty">{relief.message || '当前筛选没有减免记录'}</div>
                ) : null
              ) : applied?.type === 'signoffs' ? (
                signoffs ? (
                  signoffs.available === false ? (
                    <div className="note2" role="status"><Icon name="alert" />{signoffs.message || '签报情况数据尚未就绪；请稍后再试。'}</div>
                  ) : signoffs.rows.length ? (
                    <>
                      <SignoffsTable report={signoffs} />
                      {signoffs.count != null && signoffs.rows.length < signoffs.count ? (
                        <div className="stats-load-more">
                          <button type="button" className="btn sm" onClick={() => void loadMoreSignoffs()}>
                            加载更多（已显示 {signoffs.rows.length}/{signoffs.count}）
                          </button>
                        </div>
                      ) : null}
                    </>
                  ) : <div className="empty">{signoffs.message || '当前筛选没有签报记录'}</div>
                ) : null
              ) : applied?.type === 'ticket-summary' ? (
                ticketSummary ? (
                  ticketSummary.available === false ? (
                    <div className="note2" role="status"><Icon name="alert" />{ticketSummary.message || '收款汇总表数据尚未就绪；请稍后再试。'}</div>
                  ) : ticketSummary.rows.length ? (
                    <TicketSummaryTable report={ticketSummary} />
                  ) : <div className="empty">{ticketSummary.message || '当前筛选没有收款汇总数据'}</div>
                ) : null
              ) : applied?.type === 'tickets' ? (
                tickets ? (
                  tickets.available === false ? (
                    <div className="note2" role="status"><Icon name="alert" />{tickets.message || '票据情况数据尚未就绪；请稍后再试。'}</div>
                  ) : tickets.rows.length ? (
                    <>
                      <TicketsTable report={tickets} />
                      {tickets.count != null && tickets.rows.length < tickets.count ? (
                        <div className="stats-load-more">
                          <button type="button" className="btn sm" onClick={() => void loadMoreTickets()}>
                            加载更多（已显示 {tickets.rows.length}/{tickets.count}）
                          </button>
                        </div>
                      ) : null}
                    </>
                  ) : <div className="empty">{tickets.message || '当前筛选没有票据记录'}</div>
                ) : null
              ) : annual ? (
                annual.available === false ? (
                  <div className="note2" role="status">
                    <Icon name="alert" />{annual.message || 'MIS 镜像尚未覆盖该报表数据，暂不能统计；请稍后再试。'}
                  </div>
                ) : annual.rows.length ? (
                  <AnnualSummaryTable annual={annual} onCellClick={openCell} />
                ) : (
                  <div className="empty">{annual.message || '当前筛选没有可汇总的数据'}</div>
                )
              ) : null}

              {applied?.type === 'arrears' && annual?.available !== false ? (
                <div className="note2 stats-known-gap" style={{ marginTop: 12 }}>
                  <Icon name="alert" />数据来自 MIS 镜像（每 5 分钟增量）。管理处 01（一期）历史欠费与旧系统截图存在已知差异，
                  待补减免/签报镜像后同条件核对；本页不把差异伪造为 0。
                </div>
              ) : null}
            </div>
          </section>
        </div>
      )}

      {applied?.type === 'received' || applied?.type === 'arrears' ? (
        <HouseDetailSheet
          open={detailOpen}
          onClose={() => setDetailOpen(false)}
          target={detailTarget}
          type={applied.type}
          reportLabel={activeLabel}
          feeCodes={applied.feeCodes}
          natures={applied.natures}
          asOfPeriod={applied.asOfPeriod}
          paidDateFrom={applied.paidDateFrom}
          paidDateTo={applied.paidDateTo}
        />
      ) : null}

      <CollectionDetailSheet
        open={collectionDetailOpen}
        onClose={() => setCollectionDetailOpen(false)}
        base={applied}
        target={collectionTarget}
        reportLabel={activeLabel}
      />

      <ArrearsBillsSheet
        open={arrearsBillsOpen}
        onClose={() => setArrearsBillsOpen(false)}
        base={applied?.type === 'arrears-prepaid' ? applied : null}
        target={arrearsBillsTarget}
      />

      <CollectionAnalysisDetailSheet
        open={analysisDetailOpen}
        onClose={() => setAnalysisDetailOpen(false)}
        base={applied?.type === 'collection-analysis' ? applied : null}
        target={analysisTarget}
      />
    </div>
  );
}
