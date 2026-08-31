/**
 * 一行展示的完整地址：`枫桦景苑一期17号201室`。
 *
 * **这份和 packages/shared-types/src/address.ts 的 formatAddressLine / isLaneRedundant
 * 是同一套规则的两份实现**（api 不依赖 @pms/shared-types，同 common/enums.ts 与
 * common/repair-urgency.util.ts 的既有做法）。改判断规则时两边都要动，
 * 两边各有一份测试锁着同样的用例。
 *
 * 规则：弄号跟在小区名后面是不是废话（2026-08-31 用户反馈「小区里已经包含了地址的
 * 一部分就别重复显示」）：
 *   · 小区名里已经写了它 —— 「永南140弄」+「140弄3号201室」，弄号说了两遍
 *   · 这个小区就这一个弄 —— 「枫桦景苑一期」只有 198 弄，说了小区名就等于说了弄号
 * 反过来，一个小区有好几个弄时**绝不能省**：省了「198弄17号」和「228弄17号」
 * 会显示成同一个地址，维修工按门牌找过去是白跑一趟。弄数不确定（0/undefined）时
 * 一律保留，宁可多一段。
 */

export interface AddressCommunityInfo {
  name: string;
  /** 这个小区有几个不同的「弄」。0 或 undefined = 不确定，按保留处理 */
  laneCount?: number | null;
}

export interface AddressBuildingInfo {
  lane?: string | null;
  buildingNo?: string | null;
  roadName?: string | null;
}

export function isLaneRedundant(
  community: AddressCommunityInfo,
  lane?: string | null,
): boolean {
  if (!lane) return false;
  if (community.name.includes(`${lane}弄`)) return true;
  return community.laneCount === 1;
}

export function formatAddressLine(
  community: AddressCommunityInfo,
  building?: AddressBuildingInfo | null,
  roomNo?: string | null,
): string {
  const lane = building?.lane || '';
  const keepLane = !!lane && !isLaneRedundant(community, lane);
  const road = !lane && building?.roadName ? building.roadName : '';
  const buildingText = building
    ? `${keepLane ? `${lane}弄` : ''}${road}${building.buildingNo ? `${building.buildingNo}号` : ''}`
    : '';
  return `${community.name}${buildingText}${roomNo ? `${roomNo}室` : ''}`;
}
