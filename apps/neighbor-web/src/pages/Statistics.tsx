import { useEffect, useRef, useState } from 'react';
import { request } from '@pms/api-client';
import ToneIcon from '@/components/ToneIcon';
import Icon from '@/components/Icon';
import { Loading, toast } from '@/components/ui';
import AnnualSummaryTable, { type AnnualCellTarget } from '@/components/statistics/AnnualSummaryTable';
import HouseDetailSheet, { type DetailTarget } from '@/components/statistics/HouseDetailSheet';
import StatisticsFilters from '@/components/statistics/StatisticsFilters';
import { dayjs } from '@/lib/format';
import {
  PENDING_REPORTS, REPORTS, annualCsv, annualQueryParams, downloadCsv, fmtCents, reportName,
  type AnnualQuery, type AnnualSummaryResponse, type FilterDraft, type StatisticsOptions,
  type StatisticsReportType,
} from '@/lib/statistics';
import '@/styles/statistics.css';

/** 旧系统截图口径：房屋性质用「收费发生时点性质」（MIS WYZJ.FWXZ_DH），默认不勾选 06 空房。 */
const DEFAULT_EXCLUDED_NATURE_CODES = new Set(['06']);

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

/** 筛选草稿的默认值：管理处/收费项目全选；房屋性质除 06 空房外全选；应收到当年 12 月，收款日期范围留空。 */
function defaultDraft(options: StatisticsOptions): FilterDraft {
  return {
    officeCodes: options.offices.map((office) => office.officeCode),
    feeCodes: options.feeItems.map((fee) => fee.code),
    natures: options.natures.map((nature) => nature.code).filter((code) => !DEFAULT_EXCLUDED_NATURE_CODES.has(code)),
    paidDateFrom: '',
    paidDateTo: '',
    asOfPeriod: `${dayjs().year()}12`,
  };
}

function timeText(value?: string | null): string {
  if (!value) return '';
  const parsed = dayjs(value);
  return parsed.isValid() ? parsed.format('YYYY-MM-DD HH:mm') : String(value);
}

/**
 * 统计汇总（P1）：旧「一通软件」统计菜单的前端复刻。
 * 左侧筛选勾选，主区年度汇总表（管理处固定列 / 年度横向滚动 / 合计高亮 / 小计），
 * 点金额单元格 → 房屋明细 → 逐笔账单三级下钻；导出当前筛选的 CSV（UTF-8 BOM）。
 */
export default function Statistics() {
  const [options, setOptions] = useState<StatisticsOptions | null>(null);
  const [optionsError, setOptionsError] = useState('');
  const [optionsRetry, setOptionsRetry] = useState(0);
  const [draft, setDraft] = useState<FilterDraft>({ officeCodes: [], feeCodes: [], natures: [], paidDateFrom: '', paidDateTo: '', asOfPeriod: '' });
  const [reportType, setReportType] = useState<StatisticsReportType>('received');
  const reportTypeRef = useRef<StatisticsReportType>('received');
  const [applied, setApplied] = useState<AnnualQuery | null>(null);
  const [annual, setAnnual] = useState<AnnualSummaryResponse | null>(null);
  const [annualLoading, setAnnualLoading] = useState(false);
  const [annualError, setAnnualError] = useState('');
  const [annualRetry, setAnnualRetry] = useState(0);
  const [detailTarget, setDetailTarget] = useState<DetailTarget | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
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
        const nextDraft = defaultDraft(response);
        setDraft(nextDraft);
        setApplied({
          type: reportTypeRef.current,
          officeCodes: nextDraft.officeCodes,
          feeCodes: nextDraft.feeCodes,
          natures: nextDraft.natures,
          yearFrom: response.yearRange.min,
          yearTo: response.yearRange.max,
          asOfPeriod: nextDraft.asOfPeriod,
          paidDateFrom: nextDraft.paidDateFrom,
          paidDateTo: nextDraft.paidDateTo,
        });
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
    setAnnualLoading(true); setAnnualError('');
    request<AnnualSummaryResponse>({ url: '/statistics/annual', query: annualQueryParams(applied) })
      .then((response) => { if (!cancelled) setAnnual(response); })
      .catch((error) => { if (!cancelled) setAnnualError(error instanceof Error && error.message ? error.message : '统计数据读取失败'); })
      .finally(() => { if (!cancelled) setAnnualLoading(false); });
    return () => { cancelled = true; };
  }, [applied, annualRetry]);

  const canSubmit = draft.officeCodes.length > 0 && draft.feeCodes.length > 0 && draft.natures.length > 0;

  const resetDraft = () => {
    if (!options) return;
    setDraft(defaultDraft(options));
  };

  const submit = () => {
    if (!options || !canSubmit) return;
    // 收款日期范围校验：只允许「从 ≤ 至」；不合法时提示且不发请求。
    if (draft.paidDateFrom && draft.paidDateTo && draft.paidDateFrom > draft.paidDateTo) {
      toast('收款日期起不能晚于收款日期至');
      return;
    }
    setDetailOpen(false);
    setDetailTarget(null);
    setApplied({
      type: reportType,
      officeCodes: draft.officeCodes,
      feeCodes: draft.feeCodes,
      natures: draft.natures,
      yearFrom: options.yearRange.min,
      yearTo: options.yearRange.max,
      asOfPeriod: draft.asOfPeriod,
      paidDateFrom: draft.paidDateFrom,
      paidDateTo: draft.paidDateTo,
    });
  };

  const switchReport = (type: StatisticsReportType) => {
    setReportType(type);
    setDetailOpen(false);
    setDetailTarget(null);
    setApplied((previous) => (previous ? { ...previous, type } : previous));
  };

  const openCell = (target: AnnualCellTarget) => {
    if (!applied) return;
    setDetailTarget(target);
    setDetailOpen(true);
  };

  const exportCurrent = () => {
    if (!annual || !applied) return;
    const csv = annualCsv(annual, {
      dataAsOf: annual.dataAsOf || options?.dataAsOf || null,
      filters: applied,
      offices: options?.offices,
      feeItems: options?.feeItems,
      natures: options?.natures,
    });
    const name = `统计汇总-${reportName(annual.type)}-${dayjs().format('YYYYMMDD')}.csv`;
    if (downloadCsv(name, csv)) toast('已导出当前筛选结果 CSV');
    else toast('导出失败，请重试');
  };

  const annualLabel = reportName(annual?.type ?? applied?.type ?? reportType);
  const dataAsOf = timeText(annual?.dataAsOf || options?.dataAsOf);
  const sourceLabel = options?.sourceMode === 'mirror' ? 'MIS 镜像' : (options?.sourceMode || '');

  return (
    <div className="stats">
      <div className="ph" style={{ marginBottom: 14 }}>
        <div>
          <div className="h1row"><ToneIcon kind="dashboard" /><h1 style={{ fontSize: 22 }}>统计汇总</h1></div>
          <p>按管理处 / 收费项目 / 房屋性质勾选汇总；年度金额可逐级下钻到房屋与逐笔账单</p>
        </div>
        <div className="act stats-head-actions">
          {dataAsOf ? <span className="tag mute">数据截止 {dataAsOf}</span> : null}
          {sourceLabel ? <span className="tag acc">{sourceLabel}</span> : null}
          <button type="button" className="btn sm" disabled={!applied || annualLoading} onClick={() => setAnnualRetry((value) => value + 1)}>
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
                  canExport={!!annual && !!applied}
                  loading={annualLoading}
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
                    className={`stats-report-tab${(annual?.type ?? applied?.type ?? reportType) === report.type ? ' on' : ''}`}
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
                <b>{annualLabel}</b>
                {annual && annual.available !== false ? <span className="tag mute">{annual.rows.length} 个管理处</span> : null}
                {annual && annual.available !== false && annual.subtotal ? <span className="tag acc">合计 {fmtCents(annual.subtotal.totalCents)}</span> : null}
                {annual?.columns?.length ? <span className="muted stats-range">{annual.columns[0]}–{annual.columns[annual.columns.length - 1]} 年度</span> : null}
                <span className="muted stats-as-of">{dataAsOf ? `数据截止 ${dataAsOf}` : ''}</span>
              </div>

              {(annual?.type ?? applied?.type ?? reportType) === 'received' && annual?.available !== false ? (
                <div className="note2 stats-received-hint">
                  <Icon name="alert" />实收年度按「应收年月」归年（收款日期可跨年）；收款日期范围只用于筛选已收流水，不改变年度归属。点单元格查逐笔清单。
                </div>
              ) : null}

              {annualLoading ? <Loading text="统计中…" /> : annualError ? (
                <div className="note2" role="alert" style={{ background: 'var(--dang-w)', color: 'var(--dang)' }}>
                  <Icon name="alert" />{annualError}
                  <button className="btn sm" style={{ marginLeft: 10 }} onClick={() => setAnnualRetry((value) => value + 1)}>重试</button>
                </div>
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

              {(annual?.type ?? applied?.type) === 'arrears' && annual?.available !== false ? (
                <div className="note2 stats-known-gap" style={{ marginTop: 12 }}>
                  <Icon name="alert" />数据来自 MIS 镜像（每 5 分钟增量）。管理处 01（一期）历史欠费与旧系统截图存在已知差异，
                  待补减免/签报镜像后同条件核对；本页不把差异伪造为 0。
                </div>
              ) : null}
            </div>
          </section>
        </div>
      )}

      <HouseDetailSheet
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
        target={detailTarget}
        type={applied?.type ?? annual?.type ?? reportType}
        reportLabel={annualLabel}
        feeCodes={applied?.feeCodes ?? []}
        natures={applied?.natures ?? []}
        asOfPeriod={applied?.asOfPeriod ?? ''}
        paidDateFrom={applied?.paidDateFrom ?? ''}
        paidDateTo={applied?.paidDateTo ?? ''}
      />
    </div>
  );
}
