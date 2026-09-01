import { EntityManager } from 'typeorm';
import { Building, Community, House } from '../entities';

/**
 * 「这条数据说的是哪一户」—— 批量导入时的房号定位。
 *
 * 导入数据（老系统、Excel）里没有本系统的 house id，只有「小区 / 弄 / 号 / 室」四段文字。
 * 业主导入、物业费导入都要做同一件事：把四段文字翻成 houses.id。抽成一份，
 * 两边（以及以后的 Excel 导入）共用，规则只在这里改。
 *
 * 匹配规则（依次尝试）：
 *   1. 直接给了 houseId → 按 id（必须属于本公司）
 *   2. 小区名 + 弄 + 号 + 室 精确匹配（空弄 = 无弄，商铺一般没有弄）
 *   3. 楼里只有一户（商铺 / 整栋出租）→ 只要 小区 + 弄 + 号 对上就算命中，
 *      室号写什么都不管（老系统商铺的「室」填的是门牌号，本系统填的是「商铺」）
 *   匹配不上返回 null，由调用方记进「未匹配」清单，不要猜。
 */
export interface HouseLocator {
  houseId?: number | null;
  communityName?: string | null;
  lane?: string | null;
  buildingNo?: string | null;
  roomNo?: string | null;
}

export interface IndexedHouse {
  id: number;
  communityId: number;
  communityName: string;
  buildingId: number;
  lane: string | null;
  buildingNo: string;
  roomNo: string;
  propertyType: string;
}

function norm(value?: string | null): string {
  return (value ?? '').replace(/\s+/g, '').trim();
}

export class HouseIndex {
  private constructor(
    private readonly byId: Map<number, IndexedHouse>,
    private readonly byKey: Map<string, IndexedHouse>,
    private readonly byBuilding: Map<string, IndexedHouse[]>,
  ) {}

  static async load(manager: EntityManager, tenantId: number): Promise<HouseIndex> {
    const rows = await manager
      .createQueryBuilder(House, 'h')
      .innerJoin(Building, 'b', 'b.id = h.building_id')
      .innerJoin(Community, 'c', 'c.id = b.community_id')
      .where('h.tenant_id = :tenantId', { tenantId })
      .select([
        'h.id AS id',
        'c.id AS "communityId"',
        'c.name AS "communityName"',
        'b.id AS "buildingId"',
        'b.lane AS lane',
        'b.building_no AS "buildingNo"',
        'h.room_no AS "roomNo"',
        'h.property_type AS "propertyType"',
      ])
      .getRawMany<any>();

    const byId = new Map<number, IndexedHouse>();
    const byKey = new Map<string, IndexedHouse>();
    const byBuilding = new Map<string, IndexedHouse[]>();
    for (const r of rows) {
      const house: IndexedHouse = {
        id: Number(r.id),
        communityId: Number(r.communityId),
        communityName: r.communityName,
        buildingId: Number(r.buildingId),
        lane: r.lane ?? null,
        buildingNo: r.buildingNo,
        roomNo: r.roomNo,
        propertyType: r.propertyType || '住宅',
      };
      byId.set(house.id, house);
      byKey.set(HouseIndex.houseKey(house.communityName, house.lane, house.buildingNo, house.roomNo), house);
      const bk = HouseIndex.buildingKey(house.communityName, house.lane, house.buildingNo);
      const list = byBuilding.get(bk) ?? [];
      list.push(house);
      byBuilding.set(bk, list);
    }
    return new HouseIndex(byId, byKey, byBuilding);
  }

  static houseKey(community: string, lane: string | null | undefined, buildingNo: string, roomNo: string) {
    return `${norm(community)}|${norm(lane)}|${norm(buildingNo)}|${norm(roomNo)}`;
  }

  static buildingKey(community: string, lane: string | null | undefined, buildingNo: string) {
    return `${norm(community)}|${norm(lane)}|${norm(buildingNo)}`;
  }

  /** 人看的定位文字：枫桦景苑一期 198弄2号 101 */
  static describe(loc: HouseLocator): string {
    // 只给了 house_id 的行（导入表里自己填的编号）：写成「房产编号 123」，
    // 那是他文件里的值、找得回去；不要写 `#123`，看着像系统内部编号（2026-09-01）
    if (loc.houseId) return `房产编号 ${loc.houseId}`;
    const lane = norm(loc.lane) ? `${norm(loc.lane)}弄` : '';
    return `${norm(loc.communityName)} ${lane}${norm(loc.buildingNo)}号 ${norm(loc.roomNo)}`.trim();
  }

  resolve(loc: HouseLocator): IndexedHouse | null {
    if (loc.houseId) return this.byId.get(Number(loc.houseId)) ?? null;
    if (!loc.communityName || !loc.buildingNo) return null;
    const exact = this.byKey.get(
      HouseIndex.houseKey(loc.communityName, loc.lane, loc.buildingNo, loc.roomNo ?? ''),
    );
    if (exact) return exact;
    const inBuilding = this.byBuilding.get(
      HouseIndex.buildingKey(loc.communityName, loc.lane, loc.buildingNo),
    );
    if (inBuilding && inBuilding.length === 1) return inBuilding[0];
    return null;
  }

  get size(): number {
    return this.byId.size;
  }
}
