/** 所有端的时间显示口径；只渲染，不改变原时间点、数据库或业务日期。 */
export const DISPLAY_TIME_ZONE = 'Asia/Shanghai';
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

/**
 * UTC/显式偏移先解析为同一时间点，再渲染北京时间。
 * 旧系统无偏移的本地时间按北京时间解析，不能由浏览器所在地决定。
 * 日期值不是时间点，保留原日期且不伪造 00:00。
 * 不依赖 Intl/timeZone：微信运行时与浏览器共用同一实现。
 */
export function formatBeijingDateTime(
  value?: string | number | Date | null,
  pattern = 'YYYY-MM-DD HH:mm',
): string {
  if (value == null || value === '') return '';
  let dateOnly = false;
  let instant: Date;
  if (typeof value === 'string') {
    const raw = value.trim();
    const match = raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?)?$/i);
    if (!match) return '';
    const [, y, mo, dd, hh, mm, ss, fraction, offset] = match;
    const day = `${y}-${mo.padStart(2, '0')}-${dd.padStart(2, '0')}`;
    const calendar = new Date(`${day}T00:00:00.000Z`);
    if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== day) return '';
    dateOnly = hh == null;
    if (dateOnly) instant = calendar;
    else {
      if (Number(hh) > 23 || Number(mm) > 59 || Number(ss || 0) > 59) return '';
      const zone = offset ? offset.toUpperCase().replace(/([+-]\d{2})(\d{2})$/, '$1:$2') : '+08:00';
      instant = new Date(`${day}T${hh}:${mm}:${ss || '00'}${fraction || ''}${zone}`);
    }
  } else {
    instant = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  }
  if (!Number.isFinite(instant.getTime())) return '';
  // 仅显示投影：对原 epoch 应用已解析的时区，不把原字符串钟点直接加八。
  const display = dateOnly ? instant : new Date(instant.getTime() + BEIJING_OFFSET_MS);
  const pad = (v: number) => String(v).padStart(2, '0');
  const tokens: Record<string, string> = {
    YYYY: String(display.getUTCFullYear()), YY: String(display.getUTCFullYear()).slice(-2),
    M: String(display.getUTCMonth() + 1), MM: pad(display.getUTCMonth() + 1),
    D: String(display.getUTCDate()), DD: pad(display.getUTCDate()),
    HH: pad(display.getUTCHours()), mm: pad(display.getUTCMinutes()), ss: pad(display.getUTCSeconds()),
    ddd: WEEKDAYS[display.getUTCDay()],
  };
  const displayPattern = dateOnly ? pattern.replace(/\s*HH:mm(?::ss)?/g, '').trim() : pattern;
  return displayPattern.replace(/YYYY|ddd|YY|MM|DD|HH|mm|ss|M|D/g, token => tokens[token]);
}
