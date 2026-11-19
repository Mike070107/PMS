import { useState } from 'react';
import './intake-registration.css';

// 与扫码填写页同一车牌字符集，不接受 I/O 或任意文字作为新车身份。
const PROVINCES = '京津冀晋蒙辽吉黑沪苏浙皖闽赣鲁豫鄂湘粤桂琼渝川贵云藏陕甘青宁新'.split('');
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'.split('');
const ALNUM = '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ'.split('');
export default function IntakePlatePicker({ value, onChange, disabled = false, compact = false, inputId, invalid = false }: { value: string; onChange: (v: string) => void; disabled?: boolean; compact?: boolean; inputId?: string; invalid?: boolean }) {
  const [position, setPosition] = useState(Math.min(value.length, 7));
  const keys = position === 0 ? PROVINCES : position === 1 ? LETTERS : ALNUM;
  const choose = (key: string) => {
    const index = Math.min(position, value.length);
    onChange(`${value.slice(0, index)}${key}${value.slice(index + 1)}`.slice(0, 8));
    setPosition(Math.min(index + 1, 7));
  };
  const keypad = <fieldset className="intake-plate-picker" disabled={disabled}>
    <legend>车牌（鼠标点选，普通车 7 位 / 新能源 8 位）</legend>
    <div className="intake-plate-display">
      <div className={`intake-plate-slots${value.length === 8 ? ' intake-plate-energy' : ''}`} aria-label={`${value.length === 8 ? '新能源绿牌' : '普通蓝牌'}：${value || '待填写'}`}>
        {Array.from({ length: value.length === 8 ? 8 : 7 }, (_, i) => <button type="button" key={i} aria-label={`车牌第${i + 1}位${value[i] ? ` ${value[i]}` : ''}`} aria-pressed={position === i} onClick={() => setPosition(Math.min(i, value.length))}>{value[i] || '—'}</button>)}
      </div>
      {value.length < 8 ? <button type="button" className="btn sm intake-plate-add" aria-label="输入新能源车牌第8位" aria-pressed={position === 7} onClick={() => setPosition(Math.min(7, value.length))}>＋ 新能源第8位</button> : <span className="muted">新能源车牌</span>}
    </div>
    <div className="intake-plate-keys" aria-label={position === 0 ? '省份简称' : position === 1 ? '发牌机关' : '车牌序号'}>
      {keys.map(key => <button type="button" key={key} onClick={() => choose(key)}>{key}</button>)}
    </div>
    <div className="intake-plate-actions"><button type="button" className="btn sm" onClick={() => { onChange(value.slice(0, -1)); setPosition(Math.max(0, value.length - 1)); }}>退一位</button><button type="button" className="btn sm" onClick={() => { onChange(''); setPosition(0); }}>清空车牌</button><output aria-live="polite">{value || '请选择省份'}</output></div>
  </fieldset>;
  if (!compact) return keypad;
  return <div className="registration-plate">
    <label>车牌号码（必填）<input id={inputId} aria-invalid={invalid} aria-describedby={invalid ? inputId + '-error' : undefined} className="in" value={value} maxLength={10} disabled={disabled} autoComplete="off" onChange={event => {
      const plate = event.target.value.toUpperCase().replace(/[\s·.．・]/g, '').slice(0,8);
      onChange(plate); setPosition(Math.min(plate.length,7));
    }}/>{invalid && <small id={inputId + '-error'}>请输入完整的 7 位或 8 位车牌</small>}</label>
    <details><summary>点选车牌</summary>{keypad}</details>
  </div>;
}
