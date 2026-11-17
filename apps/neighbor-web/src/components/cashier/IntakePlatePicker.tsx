import { useState } from 'react';
import './intake-registration.css';

// 与扫码填写页同一车牌字符集，不接受 I/O 或任意文字作为新车身份。
const PROVINCES = '京津冀晋蒙辽吉黑沪苏浙皖闽赣鲁豫鄂湘粤桂琼渝川贵云藏陕甘青宁新'.split('');
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'.split('');
const ALNUM = '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ'.split('');
export default function IntakePlatePicker({ value, onChange, disabled = false }: { value: string; onChange: (v: string) => void; disabled?: boolean }) {
  const [position, setPosition] = useState(Math.min(value.length, 7));
  const keys = position === 0 ? PROVINCES : position === 1 ? LETTERS : ALNUM;
  const choose = (key: string) => {
    const index = Math.min(position, value.length);
    onChange(`${value.slice(0, index)}${key}${value.slice(index + 1)}`.slice(0, 8));
    setPosition(Math.min(index + 1, 7));
  };
  return <fieldset className="intake-plate-picker" disabled={disabled}>
    <legend>车牌（鼠标点选，普通车 7 位 / 新能源 8 位）</legend>
    <div className="intake-plate-slots" aria-label="车牌号码">
      {Array.from({ length: 8 }, (_, i) => <button type="button" key={i} aria-label={`车牌第${i + 1}位${value[i] ? ` ${value[i]}` : ''}`} aria-pressed={position === i} onClick={() => setPosition(Math.min(i, value.length))}>{value[i] || (i === 7 ? '+' : '—')}</button>)}
    </div>
    <div className="intake-plate-keys" aria-label={position === 0 ? '省份简称' : position === 1 ? '发牌机关' : '车牌序号'}>
      {keys.map(key => <button type="button" key={key} onClick={() => choose(key)}>{key}</button>)}
    </div>
    <div className="intake-plate-actions"><button type="button" className="btn sm" onClick={() => { onChange(value.slice(0, -1)); setPosition(Math.max(0, value.length - 1)); }}>退一位</button><button type="button" className="btn sm" onClick={() => { onChange(''); setPosition(0); }}>清空车牌</button><output aria-live="polite">{value || '请选择省份'}</output></div>
  </fieldset>;
}
