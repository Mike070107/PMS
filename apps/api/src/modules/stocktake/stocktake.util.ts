export function roundStocktakeQty(value: number): number {
  return Number(value.toFixed(2));
}

export function stocktakeDifference(bookQty: number, actualQty: number): number {
  return roundStocktakeQty(actualQty - bookQty);
}

/** 只有库存在该项实盘保存后还被改动，才是需要重盘的并发冲突。 */
export function stockChangedAfterCount(
  bookQty: number,
  currentQty: number,
  countedAt?: Date | string | null,
  stockUpdatedAt?: Date | string | null,
): boolean {
  if (roundStocktakeQty(bookQty) === roundStocktakeQty(currentQty)) return false;
  if (!countedAt || !stockUpdatedAt) return true;
  return new Date(stockUpdatedAt).getTime() > new Date(countedAt).getTime();
}

export function stocktakeProgress(
  rows: Array<{ actualQty: number | null; differenceQty: number | null }>,
) {
  return {
    totalCount: rows.length,
    countedCount: rows.filter((row) => row.actualQty != null).length,
    differenceCount: rows.filter(
      (row) => row.actualQty != null && Number(row.differenceQty) !== 0,
    ).length,
  };
}
