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

/** 同一车牌同步两期到期日时，本次应收只记入第一库，避免报表重复计费。 */
export function allocateParkingRenewalAmounts(amount: number, targetCount: number): number[] {
  if (!Number.isFinite(amount) || amount < 0 || !Number.isInteger(targetCount) || targetCount < 1) {
    throw new Error('续期金额或目标停车库数量无效');
  }
  return Array.from({ length: targetCount }, (_, index) => index === 0 ? amount : 0);
}
