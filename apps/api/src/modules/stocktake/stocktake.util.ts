export function roundStocktakeQty(value: number): number {
  return Number(value.toFixed(2));
}

export function stocktakeDifference(bookQty: number, actualQty: number): number {
  return roundStocktakeQty(actualQty - bookQty);
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
