import { useId, useRef, useState } from 'react';
import { MAX_MONTHS } from '@/lib/parking-pricing';
import './RenewalMonths.css';

/** 月数只负责选择；金额由当前车辆规则经服务端试算。 */
export default function RenewalMonths({ value, onChange, onValidityChange, disabled = false, active = true, onInvalidDraft }: {
  value: number;
  onChange: (months: number) => void;
  onValidityChange?: (valid: boolean) => void;
  disabled?: boolean;
  active?: boolean;
  onInvalidDraft?: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const errorId = useId();
  const [draft, setDraft] = useState({ source: value, text: String(value) });
  const [blurred, setBlurred] = useState(false);
  const text = draft.source === value ? draft.text : String(value);
  const valid = /^[1-9]\d*$/.test(text) && Number(text) <= MAX_MONTHS;
  const select = (months: number) => {
    if (disabled || !Number.isInteger(months) || months < 1 || months > MAX_MONTHS) return;
    input.current?.setCustomValidity('');
    setDraft({ source: months, text: String(months) }); setBlurred(false);
    onValidityChange?.(true); onChange(months);
  };
  return <div className="renewal-months" role="group" aria-label="续期月数">
    <div className="renewal-months__presets">
      {[1, 2, 3, 6, 12].map(m => <button type="button" key={m} data-month={m}
        className={`chip ${active && valid && value === m ? 'on' : ''}`} aria-pressed={active && valid && value === m}
        disabled={disabled} onClick={() => select(m)}>{m} 个月</button>)}
    </div>
    <div className="renewal-months__stepper">
      <button type="button" className="btn" aria-label="减少1个月" disabled={disabled || !valid || value <= 1} onClick={() => select(value - 1)}>−</button>
      <label>自定义<input ref={input} className="in" type="text" inputMode="numeric" aria-label="自定义续期月数" required pattern="[1-9][0-9]*" aria-invalid={!valid && blurred} aria-describedby={!valid && blurred ? errorId : undefined}
        disabled={disabled} value={text} onChange={e => {
          if (disabled) return;
          const next = e.target.value;
          const ok = /^[1-9]\d*$/.test(next) && Number(next) <= MAX_MONTHS;
          e.target.setCustomValidity(ok ? '' : '请输入 1～' + MAX_MONTHS + ' 的整数');
          setDraft({ source: ok ? Number(next) : onInvalidDraft ? 0 : value, text: next }); setBlurred(false);
          onValidityChange?.(ok);
          if (ok) onChange(Number(next)); else onInvalidDraft?.();
        }} onBlur={() => { setBlurred(true); onValidityChange?.(valid); }} />个月</label>
      <button type="button" className="btn" aria-label="增加1个月" disabled={disabled || !valid || value >= MAX_MONTHS} onClick={() => select(value + 1)}>+</button>
    </div>
    {!valid && blurred ? <span className="renewal-months__error" id={errorId} role="alert">请输入 1～{MAX_MONTHS} 的整数月份</span> : null}
  </div>;
}
