/**
 * 地址簿：小区(分期) → 楼栋 → 房号 的全量树，以及「228/4/201」式的渐进联想匹配。
 * 后台与两个小程序共用同一套匹配逻辑，避免两端行为不一致。
 *
 * 匹配规则（办公室接电话时按业主口述边听边打）：
 *   228            → 枫桦景苑二期（228 弄）
 *   228/4          → 枫桦景苑二期 / 4号楼
 *   228/4/201      → 枫桦景苑二期 / 228弄4号 / 201
 *   4/201          → 省掉小区，直接按 楼号/室号 找
 *   228弄4号201室   → 中文单位字等价于 /
 */

export interface AddressHouse {
  id: number;
  roomNo: string;
  propertyType: string;
  shopName: string | null;
  /** 仅后台返回；小程序端拿不到业主信息 */
  ownerName?: string | null;
  ownerPhone?: string | null;
}

export interface AddressBuilding {
  id: number;
  lane: string | null;
  buildingNo: string;
  roadName: string | null;
  houses: AddressHouse[];
}

export interface AddressCommunity {
  id: number;
  name: string;
  parentId: number | null;
  /** true = 分组节点（如「枫桦景苑」），本身不挂楼栋 */
  isGroup: boolean;
  /** 该分期覆盖户数最多的「弄」，用于省掉下级里的重复前缀 */
  mainLane: string | null;
  buildings: AddressBuilding[];
}

/** 中文单位字与各种分隔符统一按 / 切开 */
const SEPARATOR = /[/\\\-—－_·,，、。:：;；#＃\s]+/;
const UNIT_CHARS = /[弄号室栋幢座楼单元]/g;

export function tokenizeAddress(input: string): string[] {
  return input
    .trim()
    .replace(UNIT_CHARS, '/')
    .split(SEPARATOR)
    .map((part) => part.trim())
    .filter(Boolean);
}

// ---------------- 展示文案 ----------------

/** 楼栋在下拉里的短标签：小区已经表达了主弄号，这里就不重复 */
export function formatBuildingLabel(
  community: Pick<AddressCommunity, 'mainLane'>,
  building: Pick<AddressBuilding, 'lane' | 'buildingNo' | 'roadName'>,
): string {
  if (building.lane && building.lane !== community.mainLane) {
    return `${building.lane}弄${building.buildingNo}号`;
  }
  if (!building.lane && building.roadName) {
    return `${building.roadName}${building.buildingNo}号`;
  }
  return `${building.buildingNo}号楼`;
}

/** 楼栋的完整写法：228弄4号 / 永德路153号 */
export function formatBuildingFull(
  building: Pick<AddressBuilding, 'lane' | 'buildingNo' | 'roadName'>,
): string {
  if (building.lane) return `${building.lane}弄${building.buildingNo}号`;
  if (building.roadName) return `${building.roadName}${building.buildingNo}号`;
  return `${building.buildingNo}号`;
}

/**
 * 这个弄号跟在小区名后面是不是废话。
 *
 * 两种情况都是废话（2026-08-31 用户反馈「小区里已经包含了地址的一部分就别重复显示」）：
 *   · 小区名里已经写了它 —— 「永南140弄」+「140弄3号201室」，弄号说了两遍
 *   · 这个小区就这一个弄 —— 「枫桦景苑一期」只有 198 弄，说了小区名就等于说了弄号
 * 反过来，一个小区有好几个弄时**绝不能省**：省了「198弄17号」和「228弄17号」
 * 会显示成同一个地址，维修工按门牌找过去是白跑一趟。
 */
export function isLaneRedundant(
  community: { name: string; mainLane?: string | null; laneCount?: number | null },
  lane?: string | null,
): boolean {
  if (!lane) return false;
  if (community.name.includes(`${lane}弄`)) return true;
  return community.laneCount === 1;
}

/**
 * 一行展示的完整地址：`枫桦景苑一期17号201室`。
 *
 * 工单卡片、消息标题、通知文案这些「给人看一眼就知道去哪」的地方都用它，
 * 别再各处自己拼 —— 拼出来的差别就是「永北5511弄 5511弄278号503室」这种重复。
 * 需要可复制/可搜索的规范写法（带分隔符、带弄号）用 formatFullAddress。
 */
export function formatAddressLine(
  community: { name: string; mainLane?: string | null; laneCount?: number | null },
  building?: Pick<AddressBuilding, 'lane' | 'buildingNo' | 'roadName'> | null,
  roomNo?: string | null,
): string {
  const lane = building?.lane || '';
  const keepLane = lane && !isLaneRedundant(community, lane);
  const buildingText = building
    ? `${keepLane ? `${lane}弄` : ''}${!lane && building.roadName ? building.roadName : ''}${building.buildingNo ? `${building.buildingNo}号` : ''}`
    : '';
  return `${community.name}${buildingText}${roomNo ? `${roomNo}室` : ''}`;
}

/** 最终填进表单、可复制的地址：枫桦景苑二期/228弄4号/201 */
export function formatFullAddress(
  communityName: string,
  building?: Pick<AddressBuilding, 'lane' | 'buildingNo' | 'roadName'> | null,
  roomNo?: string | null,
): string {
  return [communityName, building ? formatBuildingFull(building) : '', roomNo || '']
    .filter(Boolean)
    .join('/');
}

// ---------------- 匹配打分 ----------------

/** 每一层参与匹配的候选串，越靠前权重越高 */
export interface MatchKeys {
  /** 完全相等即最高分，如楼号 "4"、房号 "201"、弄号 "228" */
  exact: string[];
  /** 前缀命中，如输入 "20" 命中 "201" */
  prefix: string[];
  /** 包含命中，如输入 "枫桦" 命中 "枫桦景苑二期" */
  loose: string[];
}

function scoreToken(token: string, keys: MatchKeys): number {
  const lower = token.toLowerCase();
  if (keys.exact.some((key) => key.toLowerCase() === lower)) return 6;
  if (keys.prefix.some((key) => key.toLowerCase().startsWith(lower))) return 4;
  if (keys.loose.some((key) => key.toLowerCase().includes(lower))) return 2;
  return 0;
}

/** 一组 token（1~3 个）打在同一层上，全部命中才算命中 */
function scoreGroup(tokens: string[], keys: MatchKeys): number {
  let total = 0;
  for (const token of tokens) {
    const score = scoreToken(token, keys);
    if (!score) return 0;
    total += score;
  }
  return total;
}

const MAX_TOKENS_PER_LEVEL = 3;

/**
 * 把 tokens 顺序切成 levels.length 组（每组 1~3 个）分别命中各层，返回最高分。
 * 这样「枫桦景苑二期/228/4/201」这种带弄号的完整地址粘回来也能命中。
 */
function alignScore(tokens: string[], levels: MatchKeys[]): number {
  if (!tokens.length || !levels.length || tokens.length < levels.length) return 0;
  const memo = new Map<string, number>();

  const walk = (tokenIndex: number, levelIndex: number): number => {
    if (levelIndex === levels.length) {
      return tokenIndex === tokens.length ? 1 : 0;
    }
    const cacheKey = `${tokenIndex}:${levelIndex}`;
    const cached = memo.get(cacheKey);
    if (cached !== undefined) return cached;

    const remainingLevels = levels.length - levelIndex - 1;
    let best = 0;
    for (let size = 1; size <= MAX_TOKENS_PER_LEVEL; size += 1) {
      const nextIndex = tokenIndex + size;
      if (nextIndex > tokens.length - remainingLevels) break;
      const groupScore = scoreGroup(tokens.slice(tokenIndex, nextIndex), levels[levelIndex]);
      if (!groupScore) continue;
      const rest = walk(nextIndex, levelIndex + 1);
      if (rest) best = Math.max(best, groupScore + rest);
    }
    memo.set(cacheKey, best);
    return best;
  };

  return walk(0, 0);
}

const PREFIX_ALIGNED_BONUS = 1000;

/**
 * 给「一条完整路径」打分。0 = 不匹配。
 * 从第一层对齐命中的分明显更高，所以输入 228 时「枫桦景苑二期」排在
 * 各种房号里含 228 的结果前面。
 */
export function scoreAddressPath(tokens: string[], levels: MatchKeys[]): number {
  let best = 0;
  for (let skip = 0; skip < levels.length; skip += 1) {
    const score = alignScore(tokens, levels.slice(skip));
    if (!score) continue;
    const weighted = skip === 0 ? score + PREFIX_ALIGNED_BONUS : score;
    if (weighted > best) best = weighted;
  }
  return best;
}

// ---------------- 各层的匹配键 ----------------

export function communityMatchKeys(community: AddressCommunity): MatchKeys {
  const exact = [community.name];
  const prefix = [community.name];
  const loose = [community.name];
  if (community.mainLane) {
    exact.push(community.mainLane);
    prefix.push(community.mainLane);
    loose.push(community.mainLane);
  }
  return { exact, prefix, loose };
}

export function buildingMatchKeys(building: AddressBuilding): MatchKeys {
  const exact = [building.buildingNo];
  const prefix = [building.buildingNo];
  const loose = [building.buildingNo];
  if (building.lane) {
    exact.push(building.lane);
    prefix.push(building.lane);
    loose.push(`${building.lane}弄${building.buildingNo}号`);
  }
  if (building.roadName) {
    loose.push(building.roadName);
  }
  return { exact, prefix, loose };
}

export function houseMatchKeys(house: AddressHouse): MatchKeys {
  const exact = [house.roomNo];
  const prefix = [house.roomNo];
  const loose = [house.roomNo];
  if (house.ownerName) {
    exact.push(house.ownerName);
    prefix.push(house.ownerName);
    loose.push(house.ownerName);
  }
  if (house.ownerPhone) {
    exact.push(house.ownerPhone);
    prefix.push(house.ownerPhone);
    loose.push(house.ownerPhone);
  }
  if (house.shopName) {
    prefix.push(house.shopName);
    loose.push(house.shopName);
  }
  return { exact, prefix, loose };
}
