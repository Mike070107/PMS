import { useId } from 'react';
import DateInput from '@/components/DateInput';

export default function LegacyStartDate({ value, onChange, end, disabled }: {
  value: string | null; onChange: (value: string | null) => void; end?: string; disabled?: boolean;
}) {
  const errorId = useId();
  const invalid = value !== null && (!value || (!!end && value > end));
  return <div>
    <label><input type="checkbox" checked={value !== null} disabled={disabled} onChange={e =>
      onChange(e.target.checked ? new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10) : null)} />启用开始日期</label>
    {value !== null && <label>旧停车库开始日期<DateInput type="date" required value={value} max={end} disabled={disabled}
      aria-invalid={invalid} aria-describedby={invalid ? errorId : undefined} onChange={e => onChange(e.target.value)} />
      {invalid && <small id={errorId} role="alert">请选择不晚于结束日期的开始日期</small>}</label>}
  </div>;
}
