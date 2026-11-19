import { Input, InputNumber, Radio, Select, Typography } from 'antd';
import type { familyCars } from '@pms/api-client';

export type RegistrationTerm = familyCars.VehicleRegistrationTerm;
export const DEFAULT_TERM: RegistrationTerm = { mode: 'months', months: 12 };

export function termValid(term: RegistrationTerm) {
  if (term.mode === 'months') return Number.isInteger(term.months) && term.months >= 1 && term.months <= 60;
  return /^\d{4}-\d{2}-\d{2}$/.test(term.startDate) && /^\d{4}-\d{2}-\d{2}$/.test(term.endDate)
    && term.endDate >= term.startDate && !!term.reason.trim() && term.reason.trim().length <= 500;
}

export function termText(term?: RegistrationTerm | null) {
  const value = term ?? DEFAULT_TERM;
  return value.mode === 'months' ? `${value.months} 个月` : `${value.startDate} 至 ${value.endDate}（原因：${value.reason}）`;
}

/** Office/manager only: the owner QR page never edits or authorises the term. */
export default function VehicleRegistrationTermEditor({ value, onChange, disabled }: {
  value: RegistrationTerm; onChange: (next: RegistrationTerm) => void; disabled?: boolean;
}) {
  const kind = value.mode === 'dates' ? 'dates' : [1, 12].includes(value.months) ? String(value.months) : 'other';
  return <div className="family-term-editor">
    <label className="family-label">申请期限</label>
    <Select style={{ width: '100%' }} disabled={disabled} value={kind} onChange={(next) => onChange(
      next === 'dates' ? { mode: 'dates', startDate: '', endDate: '', reason: '' }
        : { mode: 'months', months: next === 'other' ? 3 : Number(next) })}
      options={[{ value: '12', label: '12 个月（默认，允许生效日起算）' }, { value: '1', label: '1 个月' }, { value: 'other', label: '其他月数' }, { value: 'dates', label: '自定义起止日期（须经理审批）' }]} />
    {value.mode === 'months' ? <>
      {kind === 'other' ? <div style={{ marginTop: 8 }}>
        <InputNumber min={1} max={60} precision={0} disabled={disabled} value={value.months} onChange={(next) => onChange({ mode: 'months', months: Number(next ?? 1) })} addonAfter="个月" />
      </div> : null}
      <Typography.Text type="secondary" style={{ fontSize: 13 }}>按上海自然日：生效日加月数，钳制到月末再减一天；办理失败重试不重新起算。</Typography.Text>
    </> : <div style={{ marginTop: 8, display: 'grid', gap: 8 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8 }}>
        <Input type="date" disabled={disabled} value={value.startDate} onChange={(e) => onChange({ ...value, startDate: e.target.value })} aria-label="自定义开始日期" />
        <Input type="date" disabled={disabled} min={value.startDate || undefined} value={value.endDate} onChange={(e) => onChange({ ...value, endDate: e.target.value })} aria-label="自定义结束日期" />
      </div>
      <Input.TextArea rows={2} maxLength={500} disabled={disabled} value={value.reason} placeholder="自定义期限原因（必填，随审批留痕）" onChange={(e) => onChange({ ...value, reason: e.target.value })} />
      <Typography.Text type="secondary" style={{ fontSize: 13 }}>经理审批的是以上固定日期；未到开始日不执行，重试不顺延。</Typography.Text>
    </div>}
  </div>;
}

/** Compact read-only term row used by detail views. */
export function RegistrationTermSummary({ term }: { term?: RegistrationTerm | null }) {
  return <span>{termText(term)}{term?.mode === 'dates' ? <Typography.Text type="secondary"> · 未来起始日审批后仍等待</Typography.Text> : null}</span>;
}

export { Radio };
