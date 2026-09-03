/**
 * 列表统一排序口径。
 *
 * 中文环境的 localeCompare 按拼音排列，英文名自然按 A-Z；数字按自然数比较，
 * 避免「材料10」排在「材料2」前面。空名称统一沉底。
 */
export function compareNameAlphabetically(
  a?: string | null,
  b?: string | null,
): number {
  const left = (a ?? '').trim();
  const right = (b ?? '').trim();
  if (left === right) return 0;
  if (!left) return 1;
  if (!right) return -1;
  return left.localeCompare(right, 'zh-Hans-CN', {
    numeric: true,
    sensitivity: 'base',
  });
}

/**
 * 现场工单：紧急和超时风险优先；同一天内按地址聚拢，减少维修人员往返跑动。
 * API 不依赖共享包的运行时代码，因此在服务端保留同口径实现。
 */
export function compareWorkOrderPriority(
  a: { urgent?: boolean | null; createdAt?: Date | string | null; slaDueAt?: Date | string | null; summaryAddress?: string | null; id?: number },
  b: { urgent?: boolean | null; createdAt?: Date | string | null; slaDueAt?: Date | string | null; summaryAddress?: string | null; id?: number },
  now = Date.now(),
): number {
  const urgentDiff = Number(!!b.urgent) - Number(!!a.urgent);
  if (urgentDiff) return urgentDiff;

  const asTime = (value?: Date | string | null) => {
    if (!value) return Number.POSITIVE_INFINITY;
    const time = new Date(value).getTime();
    return Number.isFinite(time) ? time : Number.POSITIVE_INFINITY;
  };
  const slaRank = (value?: Date | string | null) => {
    const due = asTime(value);
    if (!Number.isFinite(due)) return 2;
    if (due <= now) return 0;
    if (due <= now + 2 * 60 * 60 * 1000) return 1;
    return 2;
  };
  const slaDiff = slaRank(a.slaDueAt) - slaRank(b.slaDueAt);
  if (slaDiff) return slaDiff;

  const dayOf = (value?: Date | string | null) => {
    const time = asTime(value);
    return Number.isFinite(time)
      ? Math.floor((time + 8 * 60 * 60 * 1000) / (24 * 60 * 60 * 1000))
      : Number.POSITIVE_INFINITY;
  };
  const dayDiff = dayOf(a.createdAt) - dayOf(b.createdAt);
  if (Number.isFinite(dayDiff) && dayDiff) return dayDiff;

  const leftAddress = (a.summaryAddress || '').trim();
  const rightAddress = (b.summaryAddress || '').trim();
  if (leftAddress !== rightAddress) {
    if (!leftAddress) return 1;
    if (!rightAddress) return -1;
    const addressDiff = leftAddress.localeCompare(rightAddress, 'zh-Hans-CN', {
      numeric: true,
      sensitivity: 'base',
    });
    if (addressDiff) return addressDiff;
  }

  const leftTime = asTime(a.createdAt);
  const rightTime = asTime(b.createdAt);
  const timeDiff = leftTime - rightTime;
  if (Number.isFinite(timeDiff) && timeDiff) return timeDiff;
  return (a.id ?? 0) - (b.id ?? 0);
}
