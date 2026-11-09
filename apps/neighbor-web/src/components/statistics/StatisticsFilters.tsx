import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import Icon from '@/components/Icon';
import DateInput from '@/components/DateInput';
import type { FilterDraft, StatisticsOptions } from '@/lib/statistics';

export interface StatisticsFiltersProps {
  options: StatisticsOptions;
  draft: FilterDraft;
  onChange: (patch: Partial<FilterDraft>) => void;
  onSubmit: () => void;
  onReset: () => void;
  onExport: () => void;
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

/** 左侧筛选：管理处/小区、收费项目、房屋性质勾选多选 + 截止日期；只在点「统计」时生效。 */
export default function StatisticsFilters({
  options, draft, onChange, onSubmit, onReset, onExport, canExport, loading,
}: StatisticsFiltersProps) {
  const [officeQuery, setOfficeQuery] = useState('');
  const filteredOffices = useMemo(() => {
    const keyword = officeQuery.trim();
    if (!keyword) return options.offices;
    return options.offices.filter((office) => `${office.name}${office.communityName || ''}${office.officeCode}`.includes(keyword));
  }, [officeQuery, options.offices]);

  const canSubmit = draft.officeCodes.length > 0 && draft.feeCodes.length > 0 && draft.natures.length > 0;
  const monthValue = draft.asOfPeriod && /^\d{6}$/.test(draft.asOfPeriod)
    ? `${draft.asOfPeriod.slice(0, 4)}-${draft.asOfPeriod.slice(4)}`
    : '';

  const groupPatch = (group: 'offices' | 'fees' | 'natures', values: string[]): Partial<FilterDraft> => (
    group === 'offices' ? { officeCodes: values } : group === 'fees' ? { feeCodes: values } : { natures: values }
  );

  const groupActions = (group: 'offices' | 'fees' | 'natures', all: string[]) => (
    <>
      <button type="button" className="stats-link" data-action={`${group}-select-all`} onClick={() => onChange(groupPatch(group, all))}>全选</button>
      <button type="button" className="stats-link" data-action={`${group}-clear`} onClick={() => onChange(groupPatch(group, []))}>清空</button>
    </>
  );

  return (
    <aside className="card stats-filters" aria-label="统计筛选">
      <div className="stats-filter-head">
        <b><Icon name="search" size={17} />筛选条件</b>
        <button type="button" className="btn sm g" data-action="filters-reset" onClick={onReset}>重置</button>
      </div>

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

      <CheckGroup title="收费项目" hint="旧系统 16 个收费项目" actions={groupActions('fees', options.feeItems.map((fee) => fee.code))}>
        <div className="stats-check-list stats-check-list--grid" role="group" aria-label="收费项目">
          {options.feeItems.map((fee) => (
            <label key={fee.code} className="stats-check">
              <input
                type="checkbox"
                data-fee-code={fee.code}
                checked={draft.feeCodes.includes(fee.code)}
                onChange={() => onChange({ feeCodes: toggle(draft.feeCodes, fee.code) })}
              />
              <span className="stats-check-name">{fee.name}</span>
              <small className="muted">{fee.code}</small>
            </label>
          ))}
        </div>
      </CheckGroup>

      <CheckGroup
        title="房屋性质"
        hint="按收费发生时点性质统计；空房（06）默认不勾选，可手动勾选"
        actions={groupActions('natures', options.natures.map((nature) => nature.code))}
      >
        <div className="stats-check-list" role="group" aria-label="房屋性质">
          {options.natures.map((nature) => (
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
        <label>
          收款截止日期
          <DateInput type="date" value={draft.paidDateTo} onChange={(event) => onChange({ paidDateTo: event.target.value })} />
        </label>
        <label>
          应收截止年月
          <DateInput type="month" value={monthValue} onChange={(event) => onChange({ asOfPeriod: String(event.target.value || '').replace('-', '') })} />
        </label>
      </div>

      <div className="stats-filter-actions">
        <button type="button" className="btn p stats-apply" data-testid="stats-submit" disabled={!canSubmit || loading} onClick={onSubmit}>
          <Icon name="chart" size={17} />{loading ? '统计中…' : '统计'}
        </button>
        <button type="button" className="btn stats-export" data-testid="stats-export" disabled={!canExport || loading} onClick={onExport}>
          <Icon name="download" size={17} />导出 CSV
        </button>
      </div>
      {!canSubmit ? <div className="note2" role="status"><Icon name="alert" />请至少各选一个管理处、收费项目和房屋性质。</div> : null}
    </aside>
  );
}
