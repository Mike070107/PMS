const DAY_MS = 24 * 60 * 60 * 1000;
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const SLA_SOON_MS = 2 * 60 * 60 * 1000;

export interface RouteSortableWorkOrder {
  id?: number;
  urgent?: boolean | null;
  createdAt?: Date | string | null;
  slaDueAt?: Date | string | null;
  summaryAddress?: string | null;
}

function timeOf(value?: Date | string | null): number {
  if (!value) return Number.POSITIVE_INFINITY;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : Number.POSITIVE_INFINITY;
}

/** 上海自然日编号，确保服务器和小程序不会因为所在时区不同把凌晨工单拆到两天。 */
function shanghaiDay(value?: Date | string | null): number {
  const time = timeOf(value);
  return Number.isFinite(time)
    ? Math.floor((time + SHANGHAI_OFFSET_MS) / DAY_MS)
    : Number.POSITIVE_INFINITY;
}

function slaPriority(value: Date | string | null | undefined, now: number): number {
  const due = timeOf(value);
  if (!Number.isFinite(due)) return 2;
  if (due <= now) return 0;
  if (due <= now + SLA_SOON_MS) return 1;
  return 2;
}

function compareAddress(left?: string | null, right?: string | null): number {
  const a = (left || '').trim();
  const b = (right || '').trim();
  if (a === b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return a.localeCompare(b, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' });
}

/**
 * 现场工单统一排序：
 * 1. 紧急；2. 已超时 / 2 小时内到期；3. 报修日期；4. 同日按地址就近聚拢；
 * 5. 同地址按报修时间先到先处理。
 */
export function compareWorkOrderRoutePriority(
  a: RouteSortableWorkOrder,
  b: RouteSortableWorkOrder,
  now = Date.now(),
): number {
  const urgentDiff = Number(!!b.urgent) - Number(!!a.urgent);
  if (urgentDiff) return urgentDiff;

  const slaDiff = slaPriority(a.slaDueAt, now) - slaPriority(b.slaDueAt, now);
  if (slaDiff) return slaDiff;

  const dayDiff = shanghaiDay(a.createdAt) - shanghaiDay(b.createdAt);
  if (Number.isFinite(dayDiff) && dayDiff) return dayDiff;

  const addressDiff = compareAddress(a.summaryAddress, b.summaryAddress);
  if (addressDiff) return addressDiff;

  const timeDiff = timeOf(a.createdAt) - timeOf(b.createdAt);
  if (Number.isFinite(timeDiff) && timeDiff) return timeDiff;
  return (a.id ?? 0) - (b.id ?? 0);
}
