/**
 * 收费统计/导出共用的日期与分桶算法。
 *
 * 全部按 Asia/Shanghai 取整天：营业日、交班、对账都是按本地自然日说话的。
 * 生产服务器时区是 UTC，用 Node 本地时区或直接 ::date 切桶，会把北京时间
 * 凌晨 0 点到 8 点收的款算到前一天。
 *
 * 上海全年固定 UTC+8（1991 年后无夏令时），所以这里用固定偏移而不是查时区库。
 */
export const FEE_TZ = 'Asia/Shanghai';
const TZ_SUFFIX = '+08:00';

/** 某个上海自然日的 00:00 对应的绝对时刻 */
export function dayStart(date: string) {
  return new Date(`${date}T00:00:00${TZ_SUFFIX}`);
}

/** 次日 00:00：区间一律左闭右开，当天最后一秒的收款不会被漏掉 */
export function nextDayStart(date: string) {
  return dayStart(shiftDay(date, 1));
}

/** 把绝对时刻落到它所属的上海自然日 */
export function formatDay(value: Date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: FEE_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(value);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** YYYY-MM-DD 加减天数，按 UTC 推避免跨月出错 */
export function shiftDay(date: string, days: number) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** 今天（上海）的 YYYY-MM-DD */
export function todayInTz(now = new Date()) {
  return formatDay(now);
}

/** 上海自然日的 [今天 00:00, 明天 00:00) */
export function todayRange(now = new Date()) {
  const day = todayInTz(now);
  return { day, from: dayStart(day), to: nextDayStart(day) };
}

export type TrendGranularity = 'day' | 'week' | 'month';

/**
 * 环比用的上一个等长区间：按天数往前平移同样长度。
 *
 * 本月 1 号到今天和上月 1 号到同一天比，天数一样才有可比性；
 * 直接拿「上个自然月整月」比会让月初的环比永远是暴跌。
 */
export function previousRange(from: string, to: string) {
  const span = daysBetween(from, to);
  return { from: shiftDay(from, -span), to: shiftDay(to, -span) };
}

/** [from, to] 闭区间的天数 */
export function daysBetween(from: string, to: string) {
  const ms = dayStart(to).getTime() - dayStart(from).getTime();
  return Math.round(ms / 86_400_000) + 1;
}

/** 环比百分比，保留一位小数；上期为 0 时不编造百分比。 */
export function growthRate(current: number, previous: number): number | null {
  if (!previous) return null;
  return Math.round(((current - previous) / Math.abs(previous)) * 1000) / 10;
}

/** 占比百分比，保留一位小数；合计为 0 时不编造占比。 */
export function shareRatio(part: number, total: number): number | null {
  if (!total) return null;
  return Math.round((part / total) * 1000) / 10;
}

/**
 * 把「按上海自然日」的明细折进周/月桶，再补齐空桶。
 *
 * SQL 只按天分组（一个表达式走到底，口径不会和筛选条件打岔），
 * 周/月在这里折 —— 周和月的边界算法只有一份，和 bucketStart 共用。
 */
export function foldToBuckets(
  dayRows: Array<{ day: string; amountCents: number; count: number }>,
  from: string,
  to: string,
  granularity: TrendGranularity,
) {
  const sums = new Map<string, { bucket: string; amountCents: number; count: number }>();
  for (const row of dayRows) {
    const bucket = bucketStart(row.day, granularity);
    const hit = sums.get(bucket) ?? { bucket, amountCents: 0, count: 0 };
    hit.amountCents += row.amountCents;
    hit.count += row.count;
    sums.set(bucket, hit);
  }
  return fillTrendBuckets([...sums.values()], from, to, granularity);
}

/** 把缺口日期补成 0，趋势图不会因为某天没收款就把两天连成一条直线。 */
export function fillTrendBuckets(
  rows: Array<{ bucket: string; amountCents: number; count: number }>,
  from: string,
  to: string,
  granularity: TrendGranularity,
) {
  const found = new Map(rows.map((row) => [row.bucket, row]));
  const buckets: Array<{ bucket: string; amountCents: number; count: number }> = [];
  let cursor = bucketStart(from, granularity);
  const last = bucketStart(to, granularity);
  while (cursor <= last) {
    const hit = found.get(cursor);
    buckets.push({ bucket: cursor, amountCents: hit?.amountCents ?? 0, count: hit?.count ?? 0 });
    cursor = advance(cursor, granularity);
  }
  return buckets;
}

/** 桶的起始日，和 SQL 里 date_trunc 的口径对齐（周一为一周起点） */
export function bucketStart(date: string, granularity: TrendGranularity) {
  if (granularity === 'month') return `${date.slice(0, 7)}-01`;
  if (granularity === 'week') {
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    return shiftDay(date, -((weekday + 6) % 7));
  }
  return date;
}

function advance(date: string, granularity: TrendGranularity) {
  if (granularity === 'day') return shiftDay(date, 1);
  if (granularity === 'week') return shiftDay(date, 7);
  const [y, m] = date.split('-').map(Number);
  const next = new Date(Date.UTC(y, m, 1));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-01`;
}
