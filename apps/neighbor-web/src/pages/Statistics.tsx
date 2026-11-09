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

/** 筛选草稿的默认值：全选；应收截止默认「当前年份 12 月」（旧系统口径含 12 月应收），收款截止留空不限制。 */
function defaultDraft(options: StatisticsOptions): FilterDraft {
  return {
    officeCodes: options.offices.map((office) => office.officeCode),
    feeCodes: options.feeItems.map((fee) => fee.code),
    natures: options.natures.map((nature) => nature.code),
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
  const [draft, setDraft] = useState<FilterDraft>({ officeCodes: [], feeCodes: [], natures: [], paidDateTo: '', asOfPeriod: '' });
  const [reportType, setReportType] = useState<StatisticsReportType>('received');
  const reportTypeRef = useRef<StatisticsReportType>('received');
  const [applied, setApplied] = useState<AnnualQuery | null>(null);
  const [annual, setAnnual] = useState<AnnualSummaryResponse | null>(null);
  const [annualLoading, setAnnualLoading] = useState(false);
  const [annualError, setAnnualError] = useState('');
  const [annualRetry, setAnnualRetry] = useState(0);
  const [detailTarget, setDetailTarget] = useState<DetailTarget | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(true);

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
        <div className="stats-layout">
          <button
            type="button"
            className="stats-filter-toggle"
            data-testid="stats-filter-toggle"
            aria-expanded={filtersOpen}
            onClick={() => setFiltersOpen((open) => !open)}
          >
            <Icon name="search" size={16} />{filtersOpen ? '收起筛选条件' : '展开筛选条件'}
          </button>
          <div className={`stats-filter-wrap${filtersOpen ? '' : ' collapsed'}`}>
            <StatisticsFilters
              options={options}
              draft={draft}
              onChange={(patch) => setDraft((previous) => ({ ...previous, ...patch }))}
              onSubmit={submit}
              onReset={resetDraft}
              onExport={exportCurrent}
              canExport={!!annual && !!applied}
              loading={annualLoading}
            />
          </div>

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
                <b>{annualLabel}</b>
                {annual && annual.available !== false ? <span className="tag mute">{annual.rows.length} 个管理处</span> : null}
                {annual && annual.available !== false && annual.subtotal ? <span className="tag acc">合计 {fmtCents(annual.subtotal.totalCents)}</span> : null}
                {annual?.columns?.length ? <span className="muted stats-range">{annual.columns[0]}–{annual.columns[annual.columns.length - 1]} 年度</span> : null}
                <span className="muted stats-as-of">{dataAsOf ? `数据截止 ${dataAsOf}` : ''}</span>
              </div>

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
        paidDateTo={applied?.paidDateTo ?? ''}
      />
    </div>
  );
}
