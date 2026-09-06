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

/**
 * 员工端「工单池 / 派单台 / 在手工单 / 我修的」的排序（2026-09-06 Mike）：
 * 紧急先；其余**只按报修时间从早到晚** —— 越老的越该先修，新单排在下面。
 * 不再按超时插队、不再同日按地址聚拢：那套排法看着不是时间序，维修工反而找不到「最早那单」。
 * 后台派单台仍用上面的 compareWorkOrderRoutePriority（办公室要看路线）。
 */
export function compareWorkOrderOldestFirst(
  a: RouteSortableWorkOrder,
  b: RouteSortableWorkOrder,
): number {
  const urgentDiff = Number(!!b.urgent) - Number(!!a.urgent);
  if (urgentDiff) return urgentDiff;
  const timeDiff = timeOf(a.createdAt) - timeOf(b.createdAt);
  if (Number.isFinite(timeDiff) && timeDiff) return timeDiff;
  return (a.id ?? 0) - (b.id ?? 0);
}

/** 「我报的 / 已完结」：最近的在上面，点进去先看到刚处理的 */
export function compareWorkOrderNewestFirst(
  a: RouteSortableWorkOrder,
  b: RouteSortableWorkOrder,
): number {
  const timeDiff = timeOf(b.createdAt) - timeOf(a.createdAt);
  if (Number.isFinite(timeDiff) && timeDiff) return timeDiff;
  // 没有时间的（理论上不会有）排最后
  const aMissing = !Number.isFinite(timeOf(a.createdAt));
  const bMissing = !Number.isFinite(timeOf(b.createdAt));
  if (aMissing !== bMissing) return aMissing ? 1 : -1;
  return (b.id ?? 0) - (a.id ?? 0);
}

/** 「我报的 / 已完结」不搜索时只展示最近这么多条，更早的靠搜索 */
export const RECENT_LIST_LIMIT = 30;
