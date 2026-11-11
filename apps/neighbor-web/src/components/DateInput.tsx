import { useMemo, type ChangeEvent, type InputHTMLAttributes } from 'react';
import { DatePicker } from 'antd';
import dayjs from 'dayjs';
import zhCN from 'antd/es/date-picker/locale/zh_CN';

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'size'> & {
  type?: 'date' | 'month' | 'datetime-local';
};

/** 原生日期输入的薄适配：沿用页面字符串契约，统一使用既有 AntD 日历。 */
export default function DateInput({ type = 'date', value, defaultValue, onChange, min, max, required, readOnly, disabled, className, style, name, id, placeholder, autoFocus, tabIndex, ...rest }: Props) {
  const month = type === 'month';
  const timestamp = type === 'datetime-local';
  const format = month ? 'YYYY-MM' : timestamp ? 'YYYY-MM-DD HH:mm' : 'YYYY-MM-DD';
  const wireFormat = timestamp ? 'YYYY-MM-DDTHH:mm' : format;
  const parse = (v: unknown) => v && dayjs(String(v)).isValid() ? dayjs(String(v)) : null;
  // rc-picker watches the Dayjs object identity. Re-parsing the same wire value
  // on every parent poll resets its browsing panel to the selected date, even
  // though the user has only flipped month/year and has not selected a day yet.
  const current = useMemo(() => parse(value ?? defaultValue), [value, defaultValue]);
  const lower = parse(min);
  const upper = parse(max);
  const unit = month ? 'month' : 'day';
  return <DatePicker
    id={id} name={name} value={current} picker={month ? 'month' : 'date'} locale={zhCN}
    format={format} showTime={timestamp ? { format: 'HH:mm' } : false} needConfirm={timestamp}
    placeholder={placeholder || (month ? '选择月份' : timestamp ? '选择日期和时间' : '选择日期')}
    className={['pms-date-input', className].filter(Boolean).join(' ')} style={style}
    disabled={disabled} inputReadOnly={readOnly} allowClear={!required && !readOnly}
    autoFocus={autoFocus} tabIndex={tabIndex} aria-label={rest['aria-label']} aria-invalid={rest['aria-invalid']} aria-required={required}
    disabledDate={date => !!((lower && date.isBefore(lower, unit)) || (upper && date.isAfter(upper, unit)))}
    onChange={date => {
      if (readOnly || disabled) return;
      const next = date?.format(wireFormat) || '';
      if (next && ((min && next < String(min)) || (max && next > String(max)))) return;
      // 当前接入点均消费 target.value，保留 name/id，避免改写各业务提交与筛选逻辑。
      const target = { value: next, name: name || '', id: id || '', type } as HTMLInputElement;
      onChange?.({ target, currentTarget: target, type: 'change' } as ChangeEvent<HTMLInputElement>);
    }}
  />;
}
