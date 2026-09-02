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

/** 紧急在前；同组按报修时间从早到晚；时间相同按 id 保证顺序稳定。 */
export function compareWorkOrderPriority(
  a: { urgent?: boolean | null; createdAt?: Date | string | null; id?: number },
  b: { urgent?: boolean | null; createdAt?: Date | string | null; id?: number },
): number {
  const urgentDiff = Number(!!b.urgent) - Number(!!a.urgent);
  if (urgentDiff) return urgentDiff;
  const leftTime = a.createdAt ? new Date(a.createdAt).getTime() : Number.POSITIVE_INFINITY;
  const rightTime = b.createdAt ? new Date(b.createdAt).getTime() : Number.POSITIVE_INFINITY;
  const timeDiff = leftTime - rightTime;
  if (Number.isFinite(timeDiff) && timeDiff) return timeDiff;
  return (a.id ?? 0) - (b.id ?? 0);
}
