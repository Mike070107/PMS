/** 同一车库规则供登记与既有车辆授权使用；不掺入各自的保存协议。 */
export type BasementGarage = 'main' | 'civil';
export interface GarageKeys { ground: string; main: string; civil: string }
export const GARAGE_KEYS: GarageKeys = { ground: 'phase2', main: 'main', civil: 'civil' };
export const PAID_GARAGE_KEYS: GarageKeys = { ground: 'local:phase2_parking', main: 'local:phase2_main_garage', civil: 'deliyun:枫桦景苑' };
export const basementLabel = (garage: BasementGarage) => garage === 'main' ? '二期大车库' : '二期人防车库';
export function toggleGarage(selected: string[], key: string, keys = GARAGE_KEYS): string[] {
  if (selected.includes(key)) return selected.filter(k => k !== key && !(key === keys.ground && (k === keys.main || k === keys.civil)));
  return [...new Set([...selected, key, ...([keys.main, keys.civil].includes(key) ? [keys.ground] : [])])];
}
export function garageNumbersFor(selected: string[], numbers: Record<string, string>, keys = GARAGE_KEYS) {
  return Object.fromEntries(Object.entries(numbers).filter(([key]) => selected.includes(key === 'main' ? keys.main : key === 'civil' ? keys.civil : key)));
}

export function propertySpaceLabels(lots: ReadonlyArray<{ targetKey: string | null; propertySpace?: string | null }>) {
  const labels = new Set<string>();
  for (const lot of lots) {
    const garage = lot.targetKey === PAID_GARAGE_KEYS.main ? '大车库' : lot.targetKey === PAID_GARAGE_KEYS.civil ? '人防车库' : '';
    if (garage && lot.propertySpace?.trim()) labels.add(garage + ' ' + lot.propertySpace.trim());
  }
  return [...labels];
}
