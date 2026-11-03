import { resolveAddressQuery, type AddressCommunity, type AddressQueryHits } from '@pms/shared-types';

/**
 * 本地筛选用的地址匹配（列表数据已在前端、只有地址文本时）：
 * 搜索词和每行的地址文本各自落到地址簿上，落到同一栋 / 同一户才算命中。
 * 这样 198/20、一期20、枫桦景苑一期20号楼 和「枫桦景苑一期20号601室」都对得上，
 * 而「20」不会撞上「201室」。搜索词不像地址时返回 null，调用方用原来的文字包含匹配。
 */
export function addressMatcher(query: string, communities: AddressCommunity[]): ((addressText: string | null | undefined) => boolean) | null {
  const q = resolveAddressQuery(query, communities);
  if (!q) return null;
  const cache = new Map<string, AddressQueryHits | null>();
  return (addressText) => {
    const text = String(addressText || '').trim();
    if (!text) return false;
    if (!cache.has(text)) cache.set(text, resolveAddressQuery(text, communities));
    const row = cache.get(text);
    if (!row) return false;
    if (q.level === 'community') return row.communityIds.some((id) => q.communityIds.includes(id));
    if (q.level === 'building') return row.level !== 'community' && row.buildingIds.some((id) => q.buildingIds.includes(id));
    return row.level === 'house' && row.houseIds.some((id) => q.houseIds.includes(id));
  };
}
