/**
 * 报修位置的「范围」。
 *
 * 业主报的东西不一定在自己家里：楼下大门、楼道、电梯、信箱，小区大门、道闸、路灯、
 * 绿化、健身器材，都归物业修。默认挂到业主房号上有两个实际后果 ——
 * 维修工按房号上门去敲门（白跑一趟），统计上把公区故障算进了这一户。
 *
 * 所以任何能提报修的入口，都要让人能把位置改成公共区域，并且提交时把 houseId
 * （以及小区级的 buildingId）摘掉。这份文件是这套判断的唯一出处，
 * 新增报修入口直接引它，不要各写一套。
 */

export type PlaceScope = 'home' | 'building' | 'community';

export interface PlaceScopeOption {
  key: PlaceScope;
  label: string;
  /** 「具体位置」输入框的 placeholder，举几个这一范围里常见的地方 */
  hint: string;
}

export const PLACE_SCOPES: PlaceScopeOption[] = [
  { key: 'home', label: '我家里', hint: '' },
  { key: 'building', label: '本楼公共区域', hint: '如：楼下大门、楼道、电梯、信箱' },
  { key: 'community', label: '小区里', hint: '如：小区大门、道闸、路灯、绿化、健身器材' },
];

/** 公共区域的单不该带房号，也不该要求业主填房号 */
export const isPublicScope = (scope: PlaceScope): boolean => scope !== 'home';

/**
 * 没定位到楼栋时「本楼公共区域」无处可指，直接不给选。
 * 需要选别人家/别的楼的人（后台标记过身份）走的是 components/place-picker，
 * 那套和管理后台一样能选到任意楼栋房号，不在这里加范围。
 */
export function scopeOptions(hasBuilding: boolean): PlaceScopeOption[] {
  return hasBuilding ? PLACE_SCOPES : PLACE_SCOPES.filter((item) => item.key !== 'building');
}

export function scopeHint(scope: PlaceScope): string {
  if (scope === 'home') return '';
  return PLACE_SCOPES.find((item) => item.key === scope)?.hint ?? '';
}

export interface PlaceBase {
  communityName: string;
  /** 楼栋文案，如「228弄26号」 */
  buildingText: string;
  /** 家里的完整地址（含室号）；由调用方从后端字段拿，别在端上再拼一套 */
  homeText: string;
}

/**
 * 按范围拼上门地址。
 * 楼下/楼道这类只定位到楼，小区里的只定位到小区；没补具体位置就写「公共区域」，
 * 让派单的人一眼看出这不是入户单。
 */
export function composePlaceText(
  scope: PlaceScope,
  base: PlaceBase,
  detail = '',
): string {
  if (scope === 'home') return base.homeText;
  const prefix =
    scope === 'building'
      ? [base.communityName, base.buildingText].filter(Boolean).join(' ')
      : base.communityName;
  return [prefix, detail.trim() || '公共区域'].filter(Boolean).join(' ');
}

/**
 * 提交时该带哪些 id。
 * 公区单摘掉 houseId；小区级的连 buildingId 也摘掉，否则工单看着像某栋楼的入户维修。
 */
export function scopeIds(
  scope: PlaceScope,
  ids: { buildingId?: number | null; houseId?: number | null },
): { buildingId?: number; houseId?: number } {
  return {
    buildingId: scope === 'community' ? undefined : ids.buildingId ?? undefined,
    houseId: scope === 'home' ? ids.houseId ?? undefined : undefined,
  };
}
