/** 停车续期统一日期口径；纯自然日，调用者传北京时间当天，不依赖服务器时区。 */
export function parkingRenewalWindow(input: { currentEndDate?: string | null; today: string; months: number }): { startDate: string; endDate: string } {
  const { today, months } = input;
  const valid = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s + 'T00:00:00Z')) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
  if (!valid(today)) throw new Error('续期当天日期无效');
  if (!Number.isInteger(months) || months < 1 || months > 60) throw new Error('缴费月数要在 1~60 之间');
  const current = input.currentEndDate || '';
  if (current && !valid(current)) throw new Error('原到期日无效，请先核对');
  const active = !!current && current >= today;
  const [year, month, day] = (active ? current : today).split('-').map(Number);
  const offset = active ? months : months - 1 + (day > 10 ? 1 : 0);
  const endDate = new Date(Date.UTC(year, month + offset, 0)).toISOString().slice(0, 10);
  const startDate = active ? new Date(Date.parse(current + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10) : today;
  return { startDate, endDate };
}
