import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import Icon from '@/components/Icon';
import DateInput from '@/components/DateInput';
import { dayjs } from '@/lib/format';
import { groupFeeItems, type FeeCategoryGroup, type FilterDraft, type StatisticsFeeItem, type StatisticsOptions, type StatisticsReportType } from '@/lib/statistics';

export interface StatisticsFiltersProps {
  options: StatisticsOptions;
  draft: FilterDraft;
  onChange: (patch: Partial<FilterDraft>) => void;
  onSubmit: () => void;
  onReset: () => void;
  onExport: () => void;
  /** 收起悬浮筛选面板，把宽度还给数据区。 */
  onCollapse: () => void;
  /** 当前报表：应收截止年月只对欠费报表展示/生效。 */
  reportType: StatisticsReportType;
  canExport: boolean;
  loading: boolean;
}

function toggle(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

function CheckGroup({
  title, hint, actions, children,
}: {
  title: string;
  hint?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="stats-filter-group">
      <div className="stats-filter-group-head">
        <b>{title}</b>
        {actions ? <div className="stats-filter-group-actions">{actions}</div> : null}
      </div>
      {hint ? <div className="stats-filter-hint">{hint}</div> : null}
      {children}
    </section>
  );
}

/** 收费项目分组：组级复选框全选/取消，部分选中显示 indeterminate，并显示已选/总数。 */
function FeeCategoryRow({
  group, selectedCodes, onToggleGroup, onToggleItem,
}: {
  group: FeeCategoryGroup;
  selectedCodes: string[];
  onToggleGroup: (items: StatisticsFeeItem[]) => void;
  onToggleItem: (code: string) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const selected = group.items.filter((item) => selectedCodes.includes(item.code)).length;
  const allSelected = group.items.length > 0 && selected === group.items.length;
  const partiallySelected = selected > 0 && !allSelected;
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = partiallySelected;
  }, [partiallySelected]);
  return (
    <div className="stats-fee-group" data-fee-category={group.category} role="group" aria-label={group.category}>
      <label className="stats-fee-group-head">
        <input
          ref={ref}
          type="checkbox"
          data-fee-group-checkbox={group.category}
          checked={allSelected}
          aria-checked={partiallySelected ? 'mixed' : allSelected}
          onChange={() => onToggleGroup(group.items)}
        />
        <b>{group.category}</b>
        <small className="muted">{selected}/{group.items.length}</small>
      </label>
      <div className="stats-fee-items">
        {group.items.map((fee) => (
          <label key={fee.code} className="stats-check">
            <input
              type="checkbox"
              data-fee-code={fee.code}
              checked={selectedCodes.includes(fee.code)}
              onChange={() => onToggleItem(fee.code)}
            />
            <span className="stats-check-name">{fee.name}</span>
            <small className="muted">{fee.code}</small>
          </label>
        ))}
      </div>
    </div>
  );
}

/** 左侧悬浮筛选：管理处/小区、收费项目分类树、房屋性质、收款日期范围；只在点「统计」时生效。 */
export default function StatisticsFilters({
  options, draft, onChange, onSubmit, onReset, onExport, onCollapse, reportType, canExport, loading,
}: StatisticsFiltersProps) {
  const [officeQuery, setOfficeQuery] = useState('');
  const [feeQuery, setFeeQuery] = useState('');
  const filteredOffices = useMemo(() => {
    const keyword = officeQuery.trim();
    if (!keyword) return options.offices;
    return options.offices.filter((office) => `${office.name}${office.communityName || ''}${office.officeCode}`.includes(keyword));
  }, [officeQuery, options.offices]);
  const feeGroups = useMemo(() => groupFeeItems(options.feeItems), [options.feeItems]);
  // 房屋性质按 code 顺序展示（旧 MIS 13 项：01 商品房…13 私房）。
  const natures = useMemo(() => [...options.natures].sort((a, b) => a.code.localeCompare(b.code, 'zh-CN', { numeric: true })), [options.natures]);
  const visibleFeeGroups = useMemo(() => {
    const keyword = feeQuery.trim();
    if (!keyword) return feeGroups;
    return feeGroups
      .map((group) => ({ ...group, items: group.items.filter((fee) => `${fee.name}${fee.code}`.includes(keyword)) }))
      .filter((group) => group.items.length > 0);
  }, [feeGroups, feeQuery]);

  const canSubmit = draft.officeCodes.length > 0 && draft.feeCodes.length > 0 && draft.natures.length > 0
    && (reportType !== 'fee-nature' && reportType !== 'daily' && reportType !== 'collection-analysis' || (!!draft.paidDateFrom && !!draft.paidDateTo))
    && (reportType !== 'arrears-prepaid' || (!!draft.asOfPeriod && !!draft.paidDateTo))
    && (reportType !== 'assessment' || !!draft.assessmentYear)
    && (reportType !== 'monthly-report' || !!draft.asOfPeriod)
    && (reportType !== 'fee-nature' || draft.paymentMethods.length > 0);
  const monthValue = draft.asOfPeriod && /^\d{6}$/.test(draft.asOfPeriod)
    ? `${draft.asOfPeriod.slice(0, 4)}-${draft.asOfPeriod.slice(4)}`
    : '';
  const subjectYears = useMemo(() => {
    const min = options.yearRange.min ?? dayjs().year() - 5;
    const max = options.yearRange.max ?? dayjs().year();
    return Array.from({ length: Math.max(0, max - min + 1) }, (_, index) => min + index);
  }, [options.yearRange.min, options.yearRange.max]);

  const groupPatch = (group: 'offices' | 'fees' | 'natures', values: string[]): Partial<FilterDraft> => (
    group === 'offices' ? { officeCodes: values } : group === 'fees' ? { feeCodes: values } : { natures: values }
  );

  const groupActions = (group: 'offices' | 'fees' | 'natures', all: string[]) => (
    <>
      <button type="button" className="stats-link" data-action={`${group}-select-all`} onClick={() => onChange(groupPatch(group, all))}>全选</button>
      <button type="button" className="stats-link" data-action={`${group}-clear`} onClick={() => onChange(groupPatch(group, []))}>清空</button>
    </>
  );

  const toggleFeeGroup = (items: StatisticsFeeItem[]) => {
    const codes = items.map((item) => item.code);
    const allSelected = items.every((item) => draft.feeCodes.includes(item.code));
    onChange({
      feeCodes: allSelected
        ? draft.feeCodes.filter((code) => !codes.includes(code))
        : Array.from(new Set([...draft.feeCodes, ...codes])),
    });
  };

  return (
    <aside className="card stats-filters" aria-label="统计筛选">
      <div className="stats-filter-head">
        <b><Icon name="search" size={17} />筛选条件</b>
        <div className="stats-filter-head-actions">
          <button type="button" className="btn sm g" data-action="filters-collapse" title="收起筛选，给数据区更多宽度" onClick={onCollapse}>
            <Icon name="chev" size={15} />收起
          </button>
          <button type="button" className="btn sm g" data-action="filters-reset" onClick={onReset}>重置</button>
        </div>
      </div>

      <div className="stats-filter-body">
        <CheckGroup title="管理处 / 小区" hint="按旧系统管理处勾选，小区跟随管理处" actions={groupActions('offices', options.offices.map((office) => office.officeCode))}>
          <div className="stats-office-search">
            <Icon name="search" size={15} />
            <input
              className="in"
              data-testid="office-search"
              placeholder="搜索管理处 / 小区"
              value={officeQuery}
              onChange={(event) => setOfficeQuery(event.target.value)}
            />
          </div>
          <div className="stats-check-list stats-check-list--offices" role="group" aria-label="管理处">
            {filteredOffices.map((office) => (
              <label key={office.officeCode} className="stats-check">
                <input
                  type="checkbox"
                  data-office-code={office.officeCode}
                  checked={draft.officeCodes.includes(office.officeCode)}
                  onChange={() => onChange({ officeCodes: toggle(draft.officeCodes, office.officeCode) })}
                />
                <span className="stats-check-name">{office.name}</span>
                <small className="muted">{office.communityName || office.officeCode}</small>
              </label>
            ))}
            {!filteredOffices.length ? <div className="muted">没有匹配的管理处</div> : null}
          </div>
        </CheckGroup>

        <CheckGroup title="收费项目" hint="按旧 MIS 分类树；勾选后统计仍传扁平 feeCodes" actions={groupActions('fees', options.feeItems.map((fee) => fee.code))}>
          <div className="stats-office-search">
            <Icon name="search" size={15} />
            <input
              className="in"
              data-testid="fee-search"
              placeholder="搜索收费项目"
              value={feeQuery}
              onChange={(event) => setFeeQuery(event.target.value)}
            />
          </div>
          <div className="stats-fee-groups">
            {visibleFeeGroups.map((group) => (
              <FeeCategoryRow
                key={group.category}
                group={group}
                selectedCodes={draft.feeCodes}
                onToggleGroup={toggleFeeGroup}
                onToggleItem={(code) => onChange({ feeCodes: toggle(draft.feeCodes, code) })}
              />
            ))}
            {!visibleFeeGroups.length ? <div className="muted">没有匹配的收费项目</div> : null}
          </div>
        </CheckGroup>

        <CheckGroup
          title="房屋性质"
          hint="按收费发生时点性质统计；空房（06）默认不勾选，可手动勾选"
          actions={groupActions('natures', natures.map((nature) => nature.code))}
        >
          <div className="stats-check-list" role="group" aria-label="房屋性质">
            {natures.map((nature) => (
              <label key={nature.code} className="stats-check">
                <input
                  type="checkbox"
                  data-nature-code={nature.code}
                  checked={draft.natures.includes(nature.code)}
                  onChange={() => onChange({ natures: toggle(draft.natures, nature.code) })}
                />
                <span className="stats-check-name">{nature.name}</span>
                <small className="muted">{nature.code}</small>
              </label>
            ))}
          </div>
        </CheckGroup>

        <div className="stats-filter-dates">
          {reportType !== 'arrears-prepaid' && reportType !== 'assessment' && reportType !== 'monthly-report' ? (
            <>
          <div className="stats-date-range-label">
            {reportType === 'fee-nature' || reportType === 'daily' ? '收款日期范围（必填）' : '收款日期范围'}
            <span className="muted">
              {reportType === 'received'
                ? '（仅实收；年度按应收年月归年，此范围只做筛选）'
                : reportType === 'arrears'
                  ? '（欠费报表不使用收款日期）'
                  : '（按收款日期统计收款/退款/调整）'}
            </span>
          </div>
          <div className="stats-date-range" data-date-from={draft.paidDateFrom} data-date-to={draft.paidDateTo}>
            <DateInput
              type="date"
              value={draft.paidDateFrom}
              aria-label="收款日期从"
              placeholder="从"
              onChange={(event) => onChange({ paidDateFrom: event.target.value })}
            />
            <span className="stats-date-sep">至</span>
            <DateInput
              type="date"
              value={draft.paidDateTo}
              aria-label="收款日期至"
              placeholder="至"
              onChange={(event) => onChange({ paidDateTo: event.target.value })}
            />
          </div>
            </>
          ) : null}
          {reportType === 'arrears-prepaid' ? (
            <>
              <div className="stats-date-range-label">统计条件 <span className="muted">（统计年月 + 收款截止日期共同生效）</span></div>
              <div className="stats-extra-fields">
                <label>
                  统计年月
                  <DateInput type="month" value={monthValue} onChange={(event) => onChange({ asOfPeriod: String(event.target.value || '').replace('-', '') })} />
                </label>
                <label>
                  收款截止日期
                  <DateInput type="date" value={draft.paidDateTo} onChange={(event) => onChange({ paidDateTo: event.target.value })} />
                </label>
              </div>
              <div className="stats-filter-hint">欠收=统计年月前未缴；溢收=统计年月后已预收；两页签共用同一统计条件。</div>
            </>
          ) : null}
          {reportType === 'assessment' ? (
            <>
              <div className="stats-date-range-label">统计条件</div>
              <div className="stats-extra-fields">
                <label>
                  统计年份
                  <select className="in" data-testid="assessment-year" value={draft.assessmentYear} onChange={(event) => onChange({ assessmentYear: event.target.value })}>
                    {subjectYears.map((year) => <option key={year} value={year}>{year}</option>)}
                  </select>
                </label>
                <label>
                  收款截止日期（可选）
                  <DateInput type="date" value={draft.paidDateTo} onChange={(event) => onChange({ paidDateTo: event.target.value })} />
                </label>
              </div>
              <div className="stats-filter-hint">按所属年月统计 1–12 月应收；已收默认截至今天，可清空为不限制。</div>
            </>
          ) : null}
          {reportType === 'fee-nature' ? (
            <>
              <CheckGroup title="收款方式" hint="来自收款方式字典；至少勾选一项">
                <div className="stats-check-list" role="group" aria-label="收款方式">
                  {(options.paymentMethods ?? []).map((method) => (
                    <label key={method.id} className="stats-check">
                      <input
                        type="checkbox"
                        data-payment-method={method.id}
                        checked={draft.paymentMethods.includes(method.id)}
                        onChange={() => onChange({ paymentMethods: toggle(draft.paymentMethods, method.id) })}
                      />
                      <span className="stats-check-name">{method.name}</span>
                    </label>
                  ))}
                  {!(options.paymentMethods ?? []).length ? <div className="muted">收款方式字典为空</div> : null}
                </div>
              </CheckGroup>
              <div className="stats-extra-fields">
                <label>
                  收款人
                  <input className="in" type="text" data-testid="cashier-input" value={draft.cashier} placeholder="全部收款人" onChange={(event) => onChange({ cashier: event.target.value })} />
                </label>
                <label>
                  所属年度
                  <div className="stats-year-range">
                    <select className="in" data-testid="subject-year-from" value={draft.subjectYearFrom} onChange={(event) => onChange({ subjectYearFrom: event.target.value })}>
                      <option value="">不限</option>
                      {subjectYears.map((year) => <option key={year} value={year}>{year}</option>)}
                    </select>
                    <span className="stats-date-sep">至</span>
                    <select className="in" data-testid="subject-year-to" value={draft.subjectYearTo} onChange={(event) => onChange({ subjectYearTo: event.target.value })}>
                      <option value="">不限</option>
                      {subjectYears.map((year) => <option key={year} value={year}>{year}</option>)}
                    </select>
                  </div>
                </label>
              </div>
              <div className="stats-filter-hint">所属年度按应收年月（period）筛选，不影响按收款日期统计。</div>
            </>
          ) : reportType === 'daily' ? (
            <div className="stats-filter-hint" data-testid="daily-hint">按收款日期逐日统计；没有收款的日期不显示 0 行。</div>
          ) : reportType === 'arrears' ? (
            <label data-testid="asof-period-field">
              应收截止年月
              <DateInput type="month" value={monthValue} onChange={(event) => onChange({ asOfPeriod: String(event.target.value || '').replace('-', '') })} />
            </label>
          ) : reportType === 'received' ? (
            <div className="stats-filter-hint" data-testid="asof-period-hint">应收截止年月仅欠费报表使用；实收报表列按应收年度展示，不受截止年月截断。</div>
          ) : reportType === 'collection-analysis' ? (
            <>
              <div className="stats-extra-fields">
                <label>
                  统计年月
                  <DateInput type="month" value={monthValue} onChange={(event) => onChange({ asOfPeriod: String(event.target.value || '').replace('-', '') })} />
                </label>
                <label>
                  排序
                  <select className="in" data-testid="analysis-sort" value={draft.analysisSort} onChange={(event) => onChange({ analysisSort: event.target.value as FilterDraft['analysisSort'] })}>
                    <option value="currentArrears">当年欠收降序</option>
                    <option value="historyArrears">历年欠收降序</option>
                    <option value="address">地址序</option>
                  </select>
                </label>
              </div>
              <div className="stats-filter-hint">收款日期范围用于「区间实收」列；统计年月决定历年/当年欠收与当月应收。</div>
            </>
          ) : reportType === 'monthly-report' ? (
            <>
              <div className="stats-date-range-label">统计条件</div>
              <div className="stats-extra-fields">
                <label>
                  统计年月
                  <DateInput type="month" value={monthValue} onChange={(event) => onChange({ asOfPeriod: String(event.target.value || '').replace('-', '') })} />
                </label>
              </div>
              <div className="stats-filter-hint">按月输出核心指标；其他分项列等旧系统截图确认后补。</div>
            </>
          ) : null}
        </div>
      </div>

      <div className="stats-filter-actions">
        <button type="button" className="btn p stats-apply" data-testid="stats-submit" disabled={!canSubmit || loading} onClick={onSubmit}>
          <Icon name="chart" size={17} />{loading ? '统计中…' : '统计'}
        </button>
        <button type="button" className="btn stats-export" data-testid="stats-export" disabled={!canExport || loading} onClick={onExport}>
          <Icon name="download" size={17} />导出 Excel
        </button>
      </div>
      {!canSubmit ? (
        <div className="note2 stats-filter-note" role="status"><Icon name="alert" />
          {reportType === 'fee-nature' || reportType === 'daily'
            ? '请至少各选一个管理处、收费项目、房屋性质，并填写收款日期范围；收费汇总还需至少一个收款方式。'
            : reportType === 'arrears-prepaid'
              ? '请至少各选一个管理处、收费项目和房屋性质，并填写统计年月与收款截止日期。'
              : reportType === 'assessment'
                ? '请至少各选一个管理处、收费项目和房屋性质，并选择统计年份。'
                : reportType === 'collection-analysis'
                  ? '请至少各选一个管理处、收费项目、房屋性质，并填写统计年月与收款日期范围。'
                  : reportType === 'monthly-report'
                    ? '请至少各选一个管理处、收费项目和房屋性质，并选择统计年月。'
                    : '请至少各选一个管理处、收费项目和房屋性质。'}
        </div>
      ) : null}
    </aside>
  );
}
