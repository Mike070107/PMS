export interface LocationOption { text: string; count: number }
export const normalizeLocation = (value: string) => value.trim().replace(/\s+/gu, ' ');

/** Merge only validated, aggregate location labels; never infer from a full address. */
export function locationOptions(defaults: readonly string[], learned: unknown): LocationOption[] {
  const values = new Map<string, number>();
  const order = new Map<string, number>();
  defaults.forEach((text, index) => {
    const clean = normalizeLocation(text);
    if (clean && clean.length <= 60) { values.set(clean, 0); order.set(clean, index); }
  });
  if (Array.isArray(learned)) for (const item of learned) {
    if (!item || typeof item.text !== 'string' || !Number.isSafeInteger(item.count) || item.count < 0) continue;
    const text = normalizeLocation(item.text);
    if (!text || text.length > 60) continue;
    values.set(text, Math.max(values.get(text) ?? 0, item.count));
  }
  return [...values].map(([text, count]) => ({ text, count })).sort((a, b) =>
    b.count - a.count || (order.get(a.text) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.text) ?? Number.MAX_SAFE_INTEGER) || a.text.localeCompare(b.text, 'zh'),
  );
}

/** Fit real measured button widths, reserving a single 'more' button only on overflow. */
export function visibleLocationCount(width: number, sizes: readonly number[], moreWidth: number, gap = 8): number {
  if (!sizes.length || width <= 0) return 0;
  const total = sizes.reduce((sum, size) => sum + size, 0) + Math.max(0, sizes.length - 1) * gap;
  if (total <= width) return sizes.length;
  let count = 0, used = 0;
  for (const size of sizes) {
    const next = used + (count ? gap : 0) + size;
    if (next + gap + moreWidth > width) break;
    used = next; count++;
  }
  return count;
}
