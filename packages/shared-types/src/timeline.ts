/**
 * 实际事件历史的展示排序：最新在上，不改变API流水/状态机/调用方数组。
 * 同一时刻可显式提供流水号（较大者较新）；无流水号或完全相同则保持原序。
 * 未知时间置底且保持原序；不要用于包含未来环节的计划步骤。
 */
export function sortTimelineNewestFirst<T>(
  rows: readonly T[] | null | undefined,
  getTime: (row: T) => string | number | Date | null | undefined,
  getSequence?: (row: T) => number,
): T[] {
  return (rows || [])
    .map((row, index) => {
      const value = getTime(row);
      const time = value == null || value === '' ? NaN : value instanceof Date ? value.getTime() : new Date(value).getTime();
      return { row, index, time: Number.isFinite(time) ? time : null };
    })
    .sort((a, b) => {
      if (a.time === null || b.time === null) {
        return a.time === b.time ? a.index - b.index : a.time === null ? 1 : -1;
      }
      return b.time - a.time || (getSequence ? getSequence(b.row) - getSequence(a.row) : 0) || a.index - b.index;
    })
    .map(({ row }) => row);
}
