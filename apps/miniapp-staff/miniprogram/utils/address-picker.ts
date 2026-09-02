/**
 * 小程序端地址快选：输入「4/201」或「228/4/201」即时联想出完整地址。
 * 匹配算法与管理后台同一套（@pms/shared-types 里的 scoreAddressPath），
 * 保证两端排序结果一致。
 */
import { address } from '@pms/api-client';
import {
  buildingMatchKeys,
  communityMatchKeys,
  formatBuildingFull,
  formatFullAddress,
  houseMatchKeys,
  scoreAddressPath,
  tokenizeAddress,
  type AddressCommunity,
  type MatchKeys,
} from '@pms/shared-types';

export interface AddressSuggestion {
  /** wx:for 的 key */
  key: string;
  /** 枫桦景苑二期/228弄4号/201 */
  text: string;
  communityId: number;
  communityName: string;
  buildingId: number | null;
  buildingText: string;
  /** 拆开的弄/号，入驻页要能单独回填并让业主手改 */
  lane: string | null;
  buildingNo: string;
  houseId: number | null;
  roomNo: string;
}

interface Level {
  keys: MatchKeys;
  suggestion: AddressSuggestion;
}

/** 打平成「小区 / 小区+楼栋 / 小区+楼栋+房号」三种路径，和后台下拉的层级一致 */
function flatten(book: AddressCommunity[]): Array<{ keys: MatchKeys[]; suggestion: AddressSuggestion }> {
  const paths: Array<{ keys: MatchKeys[]; suggestion: AddressSuggestion }> = [];
  for (const community of book) {
    if (community.isGroup) continue;
    const communityLevel: Level = {
      keys: communityMatchKeys(community),
      suggestion: {
        key: `c${community.id}`,
        text: community.name,
        communityId: community.id,
        communityName: community.name,
        buildingId: null,
        buildingText: '',
        lane: null,
        buildingNo: '',
        houseId: null,
        roomNo: '',
      },
    };
    paths.push({ keys: [communityLevel.keys], suggestion: communityLevel.suggestion });

    for (const building of community.buildings) {
      const buildingText = formatBuildingFull(building);
      const buildingKeys = buildingMatchKeys(building);
      paths.push({
        keys: [communityLevel.keys, buildingKeys],
        suggestion: {
          key: `b${building.id}`,
          text: formatFullAddress(community.name, building),
          communityId: community.id,
          communityName: community.name,
          buildingId: building.id,
          buildingText,
          lane: building.lane,
          buildingNo: building.buildingNo,
          houseId: null,
          roomNo: '',
        },
      });

      for (const house of building.houses) {
        paths.push({
          keys: [communityLevel.keys, buildingKeys, houseMatchKeys(house)],
          suggestion: {
            key: `h${house.id}`,
            text: formatFullAddress(community.name, building, house.roomNo),
            communityId: community.id,
            communityName: community.name,
            buildingId: building.id,
            buildingText,
            lane: building.lane,
            buildingNo: building.buildingNo,
            houseId: house.id,
            roomNo: house.roomNo,
          },
        });
      }
    }
  }
  return paths;
}

/** 摊平结果按地址簿缓存 —— 每次按键都重算 1900 条路径，手机上会明显卡 */
const flatCache = new WeakMap<
  AddressCommunity[],
  Array<{ keys: MatchKeys[]; suggestion: AddressSuggestion }>
>();

function flattenCached(book: AddressCommunity[]) {
  let hit = flatCache.get(book);
  if (!hit) {
    hit = flatten(book);
    flatCache.set(book, hit);
  }
  return hit;
}

/** 地址簿按「登录人数据范围 + 小区」缓存，换账号时绝不能复用上个人的地址簿 */
const cache = new Map<string, AddressCommunity[]>();

export async function loadAddressBook(
  communityId?: number,
  cacheScope = 'default',
): Promise<AddressCommunity[]> {
  const key = `${cacheScope}:${String(communityId ?? 'all')}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const book = await address.book(communityId);
  cache.set(key, book);
  return book;
}

export function suggestAddresses(
  book: AddressCommunity[],
  input: string,
  limit = 8,
): AddressSuggestion[] {
  const tokens = tokenizeAddress(input || '');
  if (!tokens.length) return [];
  return flattenCached(book)
    .map((path) => ({ path, score: scoreAddressPath(tokens, path.keys) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((item) => item.path.suggestion);
}
