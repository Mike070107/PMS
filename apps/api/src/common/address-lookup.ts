import type { DataSource } from 'typeorm';
import { resolveAddressQuery, type AddressQueryHits, type AddressTreeLite } from './address.shared';

/**
 * 全站列表搜索的地址识别入口（工单、账单、车辆门禁…都走这一个）：
 * 模糊输入、精准命中 —— 198/20、一期20、枫桦景苑一期20号楼 都落到 枫桦景苑一期 198弄20号。
 * 地址簿按租户缓存 60 秒（房产改动最多晚一分钟被搜到）。
 */
const cache = new Map<number, { at: number; tree: AddressTreeLite[] }>();

export async function loadAddressTreeLite(ds: DataSource, tenantId: number): Promise<AddressTreeLite[]> {
  const hit = cache.get(tenantId);
  if (hit && Date.now() - hit.at < 60_000) return hit.tree;
  const [communities, buildings, houses] = await Promise.all([
    ds.query(`SELECT id, name FROM communities WHERE tenant_id = $1`, [tenantId]) as Promise<Array<{ id: number; name: string }>>,
    ds.query(`SELECT id, community_id AS "communityId", lane, building_no AS "buildingNo", road_name AS "roadName" FROM buildings WHERE tenant_id = $1`, [tenantId]) as Promise<
      Array<{ id: number; communityId: number; lane: string | null; buildingNo: string | null; roadName: string | null }>>,
    ds.query(`SELECT id, building_id AS "buildingId", room_no AS "roomNo", shop_name AS "shopName" FROM houses WHERE tenant_id = $1`, [tenantId]) as Promise<
      Array<{ id: number; buildingId: number; roomNo: string; shopName: string | null }>>,
  ]);
  const byBuilding = new Map<number, AddressTreeLite['buildings'][number]['houses']>();
  for (const h of houses) {
    const list = byBuilding.get(Number(h.buildingId)) ?? [];
    list.push({ id: Number(h.id), roomNo: h.roomNo, shopName: h.shopName });
    byBuilding.set(Number(h.buildingId), list);
  }
  const tree: AddressTreeLite[] = communities.map((c) => {
    const own = buildings.filter((b) => Number(b.communityId) === Number(c.id));
    const laneCount = new Map<string, number>();
    own.forEach((b) => { if (b.lane) laneCount.set(b.lane, (laneCount.get(b.lane) ?? 0) + 1); });
    const mainLane = [...laneCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    return {
      id: Number(c.id), name: c.name, mainLane,
      buildings: own.map((b) => ({ id: Number(b.id), lane: b.lane, buildingNo: b.buildingNo ?? '', roadName: b.roadName, houses: byBuilding.get(Number(b.id)) ?? [] })),
    };
  });
  cache.set(tenantId, { at: Date.now(), tree });
  return tree;
}

export interface AddressFilter extends AddressQueryHits {
  /** 命中楼栋 / 小区时展开到户：按房过滤的表直接用 */
  allHouseIds: number[];
}

/** 搜索词当地址认；不像地址返回 null（调用方退回原来的文字搜索） */
export async function resolveAddressForTenant(ds: DataSource, tenantId: number, keyword: string | null | undefined): Promise<AddressFilter | null> {
  const q = String(keyword || '').trim();
  if (!q) return null;
  const tree = await loadAddressTreeLite(ds, tenantId);
  const hits = resolveAddressQuery(q, tree);
  if (!hits) return null;
  const buildings = tree.flatMap((c) => c.buildings.map((b) => ({ ...b, communityId: c.id })));
  const allHouseIds = hits.level === 'house' ? hits.houseIds
    : buildings.filter((b) => (hits.level === 'building' ? hits.buildingIds.includes(b.id) : hits.communityIds.includes(b.communityId))).flatMap((b) => b.houses.map((h) => h.id));
  return { ...hits, allHouseIds };
}
