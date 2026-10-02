import dayjs from 'dayjs';

/**
 * 停车续期按目标自然月月底结算，不保留原日号，也不按 30 天折算。
 * 正式页默认值、快捷切换及预览共用；手动选择日期不走此函数。
 */
export function parkingRenewalEndDate(currentEndDate: string, months: number): string {
  if (!Number.isInteger(months) || months < 1) return '';
  const parsed = dayjs(currentEndDate);
  return parsed.isValid() ? parsed.add(months, 'month').endOf('month').format('YYYY-MM-DD') : '';
}
