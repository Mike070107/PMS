import LegacyStartDate from './LegacyStartDate';
import RenewalMonths from './cashier/RenewalMonths';
import { useId } from 'react';
import type { familyCars } from '@pms/api-client';
export type RegistrationTerm = familyCars.VehicleRegistrationTerm;

export function RegistrationTermSummary({ term }: { term?: RegistrationTerm | null }) {
  const value = term ?? { mode: 'months', months: 12 };
  return <div style={{ overflowWrap: 'anywhere' }}>
    <b>申请期限：</b>{value.mode === 'months' ? `${value.months}个月（允许生效日起算）` : `${value.startDate} 至 ${value.endDate}（自定义日期）`}
    {value.legacyStartDate && <div>旧库开始日期：{value.legacyStartDate}</div>}
    {value.mode === 'dates' ? <div className="muted">原因：{value.reason}；未来日期审批后仍等待起始日。</div> : null}
  </div>;
}

/** Office-controlled term only; owner upload pages must never use this to authorize execution. */
export function RegistrationTermEditor({ value, onChange, disabled, title = '申请期限', attempted = false }: { title?: string; attempted?: boolean; value: RegistrationTerm; onChange: (value: RegistrationTerm) => void; disabled?: boolean }) {
  const id = useId();
  const dateErrors = value.mode === 'dates' && attempted ? {
    start: value.startDate ? '' : '请选择开始日期',
    end: !value.endDate ? '请选择结束日期' : value.endDate < value.startDate ? '结束日期不能早于开始日期' : '',
    reason: value.reason.trim() ? '' : '请填写自定义原因',
  } : { start:'', end:'', reason:'' };
  const errorProps = (key: keyof typeof dateErrors) => ({
    'aria-invalid': !!dateErrors[key],
    'aria-describedby': dateErrors[key] ? id + '-' + key + '-error' : undefined,
  });
  const errorText = (key: keyof typeof dateErrors) => dateErrors[key] && <small id={id + '-' + key + '-error'}>{dateErrors[key]}</small>;
  const field = { display: 'grid', gap: 6, minWidth: 0 };
  return <fieldset disabled={disabled} style={{ border: 0, padding: 0, margin: 0, display: 'grid', gap: 12, minWidth: 0 }}>
    <legend style={{ marginBottom: 8, fontWeight: 700 }}>{title}</legend>
    <LegacyStartDate value={value.legacyStartDate ?? null} end={value.mode === 'dates' ? value.endDate : undefined} disabled={disabled}
      onChange={date => onChange({ ...value, legacyStartDate: date ?? undefined })} />
    {value.mode === 'months' ? <>
      <RenewalMonths value={value.months} disabled={disabled} onChange={months => onChange({ legacyStartDate: value.legacyStartDate, mode:'months', months })}
        onInvalidDraft={() => onChange({ legacyStartDate: value.legacyStartDate, mode:'months', months:0 })} />
      <button type="button" className="btn g sm" style={{justifySelf:'start'}} onClick={() => onChange({ legacyStartDate: value.legacyStartDate, mode:'dates', startDate:'', endDate:'', reason:'' })}>自定日期</button>
    </> : <>
      <button type="button" className="btn g sm" style={{justifySelf:'start'}} onClick={() => onChange({ legacyStartDate: value.legacyStartDate, mode:'months', months:12 })}>按月授权</button>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 }}>
        <label style={field} htmlFor={`${id}-start`}>开始日期<input id={`${id}-start`} {...errorProps('start')} className="in" style={{ minWidth: 0, width: '100%' }} type="date" required value={value.startDate} onChange={event => onChange({ ...value, startDate: event.target.value })} />{errorText('start')}</label>
        <label style={field} htmlFor={`${id}-end`}>结束日期<input id={`${id}-end`} {...errorProps('end')} className="in" style={{ minWidth: 0, width: '100%' }} type="date" required min={value.startDate || undefined} value={value.endDate} onChange={event => onChange({ ...value, endDate: event.target.value })} />{errorText('end')}</label>
      </div>
      <label style={field} htmlFor={`${id}-reason`}>自定义原因（必填）<textarea id={`${id}-reason`} {...errorProps('reason')} className="in" rows={2} required maxLength={500} value={value.reason} onChange={event => onChange({ ...value, reason: event.target.value })} />{errorText('reason')}</label>
    </>}
  </fieldset>;
}
