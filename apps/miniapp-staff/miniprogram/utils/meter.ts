/** 抄表页面共用的小工具：类型名、读数格式化、错误文案。 */

export const METER_TYPE_LABELS: Record<string, string> = {
  water: '水表',
  electricity: '电表',
  gas: '燃气表',
  heat: '热量表',
};

export const METER_TYPE_COLORS: Record<string, string> = {
  water: '#1d63b8',
  electricity: '#ad6800',
  gas: '#c53d45',
  heat: '#6b4fa8',
};

/** 按档案位数补前导零和小数点：水表 02405，电表 022418.88 */
export function formatMeterValue(
  value: number | string | null | undefined,
  integerDigits: number,
  decimalDigits: number,
): string {
  if (value === null || value === undefined || value === '') return '';
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '';
  const int = Math.max(1, Number(integerDigits) || 1);
  const dec = Math.max(0, Number(decimalDigits) || 0);
  const fixed = numeric.toFixed(dec);
  const [whole, fraction] = fixed.split('.');
  const padded = whole.padStart(int, '0');
  return dec > 0 ? `${padded}.${fraction}` : padded;
}

export function formatMeterTime(value: string | Date | null | undefined): string {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function meterErrText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error || '操作失败');
}

/** 现场读数输入只保留数字和小数点，最多 3 位小数 */
export function sanitizeReadingInput(value: string): string {
  const cleaned = String(value || '').replace(/[^\d.]/g, '');
  const [whole, ...rest] = cleaned.split('.');
  if (!rest.length) return whole.slice(0, 10);
  return `${whole.slice(0, 10)}.${rest.join('').slice(0, 3)}`;
}
