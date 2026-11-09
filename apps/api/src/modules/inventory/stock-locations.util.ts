export type StockLocationQty = { locationId: number | null; label: string; qty: number };

/** 把流水按库位汇总成当前库存分布；流水未覆盖的差额归「未分配」。 */
export function buildLocationBreakdown(
  qty: number,
  movementByLocation: Map<number | null, number>,
  labels: Map<number, string>,
  currentLocationId?: number | null,
): StockLocationQty[] {
  const rows = [...movementByLocation.entries()]
    .filter(([, locationQty]) => Math.abs(locationQty) > 0.005)
    .map(([locationId, locationQty]) => ({
      locationId,
      label: locationId ? labels.get(locationId) ?? `库位#${locationId}` : '未分配',
      qty: Number(Number(locationQty).toFixed(2)),
    }));
  const assigned = rows.reduce((sum, row) => sum + row.qty, 0);
  const unassigned = Number((qty - assigned).toFixed(2));
  if (Math.abs(unassigned) > 0.005) rows.push({ locationId: null, label: '未分配', qty: unassigned });
  if (!rows.length && currentLocationId && Math.abs(qty) > 0.005) rows.push({ locationId: currentLocationId, label: labels.get(currentLocationId) ?? '未分配', qty });
  return rows;
}
