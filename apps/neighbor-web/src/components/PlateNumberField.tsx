import './PlateNumberField.css';
import { useId, useLayoutEffect, useRef, useState } from 'react';

// 与扫码填写页同一车牌字符集，不接受 I/O 或任意文字作为新车身份。
const PROVINCES = '京津冀晋蒙辽吉黑沪苏浙皖闽赣鲁豫鄂湘粤桂琼渝川贵云藏陕甘青宁新'.split('');
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'.split('');
const ALNUM = '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ'.split('');
const normalize = (text: string) => text.toUpperCase().replace(/[\s·.．・]/g, '').slice(0, 8);

export default function PlateNumberField({ label = '车牌号码（必填）', required = true, ariaLabel, value = '', onChange, disabled = false, inputId, invalid = false }: {
  label?: string; ariaLabel?: string; required?: boolean; value?: string; onChange?: (v: string) => void; disabled?: boolean; inputId?: string; invalid?: boolean;
}) {
  const generatedId = useId();
  const id = inputId ?? generatedId;
  const input = useRef<HTMLInputElement>(null);
  const caret = useRef<number | null>(null);
  const composing = useRef(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [selection, setSelection] = useState<{ start: number; end: number } | null>(null);
  const start = Math.min(selection?.start ?? value.length, value.length);
  const end = Math.min(selection?.end ?? start, value.length);
  const keys = start === 0 ? PROVINCES : start === 1 ? LETTERS : ALNUM;

  useLayoutEffect(() => {
    if (caret.current !== null) {
      input.current?.setSelectionRange(caret.current, caret.current);
      caret.current = null;
    }
  });

  const commit = (plate: string, position: number) => {
    caret.current = position;
    setSelection({ start: position, end: position });
    onChange?.(plate);
  };
  const type = (el: HTMLInputElement) => {
    const position = normalize(el.value.slice(0, el.selectionStart ?? el.value.length)).length;
    commit(normalize(el.value), position);
  };
  const rememberSelection = (el: HTMLInputElement) => {
    if (!composing.current) setSelection({ start: el.selectionStart ?? 0, end: el.selectionEnd ?? 0 });
  };
  const choose = (key: string) => {
    if (start >= 8) return;
    const tail = start === end && value.length === 8 ? start + 1 : end;
    commit(value.slice(0, start) + key + value.slice(tail), start + 1);
  };
  const erase = () => {
    const from = start === end ? Math.max(0, start - 1) : start;
    commit(value.slice(0, from) + value.slice(end), from);
  };

  return <div className="registration-plate">
    <label htmlFor={id}>{label}</label>
    <span className="plate-input-wrap">
      <input ref={input} id={id} className="in" value={draft ?? value} required={required} aria-label={ariaLabel} disabled={disabled}
        aria-invalid={invalid} aria-describedby={invalid ? id + '-error' : undefined}
        autoComplete="off" autoCapitalize="characters" spellCheck={false}
        onCompositionStart={event => { composing.current = true; setDraft(event.currentTarget.value); }}
        onCompositionEnd={event => { composing.current = false; setDraft(null); type(event.currentTarget); }}
        onSelect={event => rememberSelection(event.currentTarget)}
        onBlur={event => rememberSelection(event.currentTarget)}
        onChange={event => { if (composing.current) setDraft(event.target.value); else type(event.target); }} />
    </span>
    {invalid && <small id={id + '-error'}>请输入完整的 7 位或 8 位车牌</small>}
    {!disabled && <button type="button" className="btn sm plate-keypad-toggle" aria-expanded={expanded} aria-controls={id + '-keys'} onClick={() => setExpanded(!expanded)}>点选车牌</button>}
    <div id={id + '-keys'} hidden={!expanded || disabled}>
      <div className="intake-plate-keys" role="group" aria-label={start === 0 ? '省份简称' : start === 1 ? '发牌机关' : '车牌序号'}>
        {keys.map(key => <button type="button" key={key} disabled={start >= 8} onClick={() => choose(key)}>{key}</button>)}
      </div>
      <div className="intake-plate-actions">
        <button type="button" className="btn sm" disabled={end === 0} onClick={erase}>退一位</button>
        <button type="button" className="btn sm" disabled={!value} onClick={() => commit('', 0)}>清空车牌</button>
      </div>
    </div>
  </div>;
}
