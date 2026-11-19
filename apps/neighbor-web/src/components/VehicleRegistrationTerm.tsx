import { useId } from 'react';
import type { familyCars } from '@pms/api-client';
export type RegistrationTerm = familyCars.VehicleRegistrationTerm;

export function RegistrationTermSummary({ term }: { term?: RegistrationTerm | null }) {
  const value = term ?? { mode: 'months', months: 12 };
  return <div style={{ overflowWrap: 'anywhere' }}>
    <b>申请期限：</b>{value.mode === 'months' ? `${value.months}个月（允许生效日起算）` : `${value.startDate} 至 ${value.endDate}（自定义日期）`}
    {value.mode === 'dates' ? <div className="muted">原因：{value.reason}；未来日期审批后仍等待起始日。</div> : null}
  </div>;
}

/** Office-controlled term only; owner upload pages must never use this to authorize execution. */
export function RegistrationTermEditor({ value, onChange, disabled }: { value: RegistrationTerm; onChange: (value: RegistrationTerm) => void; disabled?: boolean }) {
  const id = useId();
  const selection = value.mode === 'dates' ? 'dates' : [1, 12].includes(value.months) ? String(value.months) : 'other';
  const field = { display: 'grid', gap: 6, minWidth: 0 };
  return <fieldset disabled={disabled} style={{ border: 0, padding: 0, margin: 0, display: 'grid', gap: 12, minWidth: 0 }}>
    <legend style={{ marginBottom: 8, fontWeight: 700 }}>申请期限</legend>
    <label style={field} htmlFor={`${id}-mode`}>期限方式
      <select id={`${id}-mode`} className="in" value={selection} onChange={event => {
        const mode = event.target.value;
        onChange(mode === 'dates' ? { mode: 'dates', startDate: '', endDate: '', reason: '' } : { mode: 'months', months: mode === 'other' ? 3 : Number(mode) });
      }}><option value="12">12个月（默认）</option><option value="1">1个月</option><option value="other">其他月数</option><option value="dates">自定义起止日期</option></select>
    </label>
    {value.mode === 'months' ? <>
      {selection === 'other' ? <label style={field} htmlFor={`${id}-months`}>月数（1至60）<input id={`${id}-months`} className="in" type="number" min={1} max={60} step={1} value={value.months || ''} onChange={event => onChange({ mode: 'months', months: Number(event.target.value) })} /></label> : null}
      <div className="muted">按上海自然日计算：开始日加申请月数，钳制到月末后减一天；失败重试不重新起算。</div>
    </> : <>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 }}>
        <label style={field} htmlFor={`${id}-start`}>开始日期<input id={`${id}-start`} className="in" style={{ minWidth: 0, width: '100%' }} type="date" value={value.startDate} onChange={event => onChange({ ...value, startDate: event.target.value })} /></label>
        <label style={field} htmlFor={`${id}-end`}>结束日期<input id={`${id}-end`} className="in" style={{ minWidth: 0, width: '100%' }} type="date" min={value.startDate || undefined} value={value.endDate} onChange={event => onChange({ ...value, endDate: event.target.value })} /></label>
      </div>
      <label style={field} htmlFor={`${id}-reason`}>自定义原因（必填）<textarea id={`${id}-reason`} className="in" rows={2} maxLength={500} value={value.reason} onChange={event => onChange({ ...value, reason: event.target.value })} /></label>
      <div className="muted">经理审批的是以上固定日期；未到开始日不执行，重试不顺延。</div>
    </>}
  </fieldset>;
}
