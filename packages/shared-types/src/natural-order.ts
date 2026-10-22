/**
 * 自然排序：房号、楼栋号按数字大小排，不做字符串比较。
 *
 * 「1, 2, 3, 11, 21」而不是「1, 10, 11, 2, 20」——办公室点房号下拉时
 * 是按楼层找的，字典序会让人滚到 10 楼才看见 2 楼。
 *
 * 纯字符串实现，不依赖 Intl / localeCompare：
 * 小程序端也要用，且不同运行环境的 ICU 数据不一致，同一份数据会排出不同结果。
 */
export function compareNatural(a: unknown, b: unknown): number {
  const sa = a == null ? '' : String(a);
  const sb = b == null ? '' : String(b);
  if (sa === sb) return 0;

  let i = 0;
  let j = 0;
  const isDigit = (ch: string) => ch >= '0' && ch <= '9';

  while (i < sa.length && j < sb.length) {
    const ca = sa[i];
    const cb = sb[j];
    const da = isDigit(ca);
    const db = isDigit(cb);

    if (da && db) {
      let ei = i;
      let ej = j;
      while (ei < sa.length && isDigit(sa[ei])) ei += 1;
      while (ej < sb.length && isDigit(sb[ej])) ej += 1;
      const na = Number(sa.slice(i, ei));
      const nb = Number(sb.slice(j, ej));
      if (na !== nb) return na < nb ? -1 : 1;
      // 数值相同按位数排（'02' 在 '2' 前），保证排序稳定
      const la = ei - i;
      const lb = ej - j;
      if (la !== lb) return la < lb ? -1 : 1;
      i = ei;
      j = ej;
      continue;
    }

    if (ca !== cb) return ca < cb ? -1 : 1;
    i += 1;
    j += 1;
  }

  const ra = sa.length - i;
  const rb = sb.length - j;
  if (ra !== rb) return ra < rb ? -1 : 1;
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

export interface HouseLike {
  lane?: string | null;
  buildingNo?: string | null;
  roomNo?: string | null;
  id?: number;
}

/** 房产 / 收费下拉统一顺序：弄 → 楼号 → 房号，全部自然序 */
export function compareHouseLike(a: HouseLike, b: HouseLike): number {
  return (
    compareNatural(a.lane, b.lane) ||
    compareNatural(a.buildingNo, b.buildingNo) ||
    compareNatural(a.roomNo, b.roomNo) ||
    (a.id ?? 0) - (b.id ?? 0)
  );
}

/** 楼栋下拉：弄 → 楼号 */
export function compareBuildingLike(a: HouseLike, b: HouseLike): number {
  return (
    compareNatural(a.lane, b.lane) ||
    compareNatural(a.buildingNo, b.buildingNo) ||
    (a.id ?? 0) - (b.id ?? 0)
  );
}

/** 不动原数组的排序副本 */
export function sortedHouses<T extends HouseLike>(list: readonly T[]): T[] {
  return [...list].sort(compareHouseLike);
}

export function sortedBuildings<T extends HouseLike>(list: readonly T[]): T[] {
  return [...list].sort(compareBuildingLike);
}
