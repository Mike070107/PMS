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
import StatisticsFilters from '@/components/statistics/StatisticsFilters';
import { dayjs } from '@/lib/format';
import {
  PENDING_REPORTS, REPORTS,
  annualCsv, annualQueryParams, collectionQueryParams, dailyCsv, dailyQueryParams, downloadCsv, feeNatureCsv, fmtCents, reportName,
  type AnnualQuery, type AnnualReportType, type AnnualSummaryResponse, type CollectionQuery, type DailyQuery, type DailyResponse,
  type FeeNatureResponse, type FilterDraft, type ReportQuery, type StatisticsOptions, type StatisticsReportType,
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
};

/** P2 报表日期区间必填，默认本月 1 日~今天；P1 报表保留原行为（日期可选）。 */
function isDateRequired(type: StatisticsReportType): boolean {
  return type === 'fee-nature' || type === 'daily';
}

function defaultDateRange(type: StatisticsReportType): { from: string; to: string } {
  if (!isDateRequired(type)) return { from: '', to: '' };
  const today = dayjs();
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
  return {
    officeCodes: options.offices.map((office) => office.officeCode),
    feeCodes: options.feeItems.map((fee) => fee.code),
    natures: defaultNatures(options, reportType),
    paidDateFrom: range.from,
    paidDateTo: range.to,
    asOfPeriod: `${dayjs().year()}12`,
    paymentMethods: (options.paymentMethods ?? []).map((method) => method.id),
    cashier: '',
    subjectYearFrom: '',
    subjectYearTo: '',
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
    paymentMethods: [], cashier: '', subjectYearFrom: '', subjectYearTo: '',
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
    } else {
      setDailyLoading(true); setDailyError('');
      request<DailyResponse>({ url: '/statistics/daily', query: dailyQueryParams(applied as DailyQuery) })
        .then((response) => { if (!cancelled) setDaily(response); })
        .catch((error) => { if (!cancelled) setDailyError(error instanceof Error && error.message ? error.message : '收款日报表读取失败'); })
        .finally(() => { if (!cancelled) setDailyLoading(false); });
    }
    return () => { cancelled = true; };
  }, [applied, reportRetry]);

  const datesFilled = !!draft.paidDateFrom && !!draft.paidDateTo;
  const canSubmit = !!options
    && draft.officeCodes.length > 0 && draft.feeCodes.length > 0 && draft.natures.length > 0
    && (!isDateRequired(reportType) || datesFilled)
    && (reportType !== 'fee-nature' || draft.paymentMethods.length > 0);

  const resetDraft = () => {
    if (!options) return;
    setDraft(defaultDraft(options, reportType));
  };

  const submit = () => {
    if (!options || !canSubmit) return;
    if (isDateRequired(reportType) && !datesFilled) { toast('请填写收款日期范围'); return; }
    if (draft.paidDateFrom && draft.paidDateTo && draft.paidDateFrom > draft.paidDateTo) {
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
    // P2 报表日期必填：从其它报表切过来时用默认本月，避免空日期导致不能统计。
    if (isDateRequired(type) && (!nextDraft.paidDateFrom || !nextDraft.paidDateTo)) {
      const range = defaultDateRange(type);
      nextDraft.paidDateFrom = range.from;
      nextDraft.paidDateTo = range.to;
    }
    if (type === 'fee-nature' && !nextDraft.paymentMethods.length) {
      nextDraft.paymentMethods = (options.paymentMethods ?? []).map((method) => method.id);
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
    if (!daily) return;
    const name = `统计汇总-收款日报表-${stamp}.csv`;
    if (downloadCsv(name, dailyCsv(daily, applied as DailyQuery, options?.feeItems))) toast('已导出收款日报表 CSV');
    else toast('导出失败，请重试');
  };

  const activeLabel = reportName(applied?.type ?? reportType);
  const isLoading = applied?.type === 'fee-nature' ? collectionLoading : applied?.type === 'daily' ? dailyLoading : annualLoading;
  const activeError = applied?.type === 'fee-nature' ? collectionError : applied?.type === 'daily' ? dailyError : annualError;
  const activeDataAsOf = applied?.type === 'fee-nature'
    ? collection?.dataAsOf
    : applied?.type === 'daily'
      ? daily?.dataAsOf
      : annual?.dataAsOf;
  const dataAsOf = timeText(activeDataAsOf || options?.dataAsOf);
  const sourceLabel = options?.sourceMode === 'mirror' ? 'MIS 镜像' : (options?.sourceMode || '');
  const activeAvailable = applied?.type === 'fee-nature'
    ? collection?.available
    : applied?.type === 'daily'
      ? daily?.available
      : annual?.available;
  const activeMessage = applied?.type === 'fee-nature'
    ? collection?.message
    : applied?.type === 'daily'
      ? daily?.message
      : annual?.message;

  const dateRangeText = applied && 'dateFrom' in applied
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
                  canExport={activeAvailable !== false && (applied?.type === 'fee-nature' ? !!collection : applied?.type === 'daily' ? !!daily : !!annual)}
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
                {applied?.type !== 'fee-nature' && applied?.type !== 'daily' && annual && annual.available !== false ? <span className="tag mute">{annual.rows.length} 个管理处</span> : null}
                {activeAvailable !== false && applied?.type === 'received' && annual?.subtotal ? <span className="tag acc">合计 {fmtCents(annual.subtotal.totalCents)}</span> : null}
                {activeAvailable !== false && applied?.type === 'arrears' && annual?.subtotal ? <span className="tag acc">合计 {fmtCents(annual.subtotal.totalCents)}</span> : null}
                {activeAvailable !== false && applied?.type === 'fee-nature' && collection?.subtotal ? <span className="tag acc">合计 {fmtCents(collection.subtotal.netCents)}</span> : null}
                {activeAvailable !== false && applied?.type === 'daily' && daily?.subtotal ? <span className="tag acc">合计 {fmtCents(daily.subtotal.totalCents)}</span> : null}
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
    </div>
  );
}
