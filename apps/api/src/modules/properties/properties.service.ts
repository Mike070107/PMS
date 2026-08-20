import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, FindOptionsWhere, In, IsNull, Repository } from 'typeorm';
import { AuthUser } from '../../common/current-user.decorator';
import { ResolvedAccess } from '../access/access.service';
import { scopeCommunityIds } from '../access/scope.util';
import { UserRole, UserStatus } from '../../common/enums';
import {
  addNaturalOrderBy,
  compareBuildingLike,
} from '../../common/natural-order';
import {
  Building,
  Community,
  House,
  Unit,
  User,
  WorkOrder,
} from '../../entities';
import {
  BuildingQueryDto,
  CommunityQueryDto,
  CreateBuildingDto,
  CreateCommunityDto,
  CreateHouseDto,
  HouseQueryDto,
  TenantScopedQueryDto,
  UpdateBuildingDto,
  UpdateCommunityDto,
  UpdateHouseDto,
} from './dto';
import { QrService } from '../qr/qr.service';

/** 「枫桦景苑一期」→ { group: '枫桦景苑', phase: '一期' }；不带分期后缀时返回 null */
const PHASE_SUFFIX = /^(.*[^\s一二三四五六七八九十百零壹贰叁肆伍陆柒捌玖拾\d])\s*([一二三四五六七八九十]+|\d+)\s*期$/;

function splitPhaseName(name: string): { group: string; phase: string } | null {
  const matched = PHASE_SUFFIX.exec(name.trim());
  if (!matched) return null;
  const group = matched[1].trim();
  if (!group) return null;
  return { group, phase: `${matched[2]}期` };
}

@Injectable()
export class PropertiesService {
  constructor(
    @InjectRepository(Community)
    private readonly communityRepo: Repository<Community>,
    @InjectRepository(Building)
    private readonly buildingRepo: Repository<Building>,
    @InjectRepository(Unit)
    private readonly unitRepo: Repository<Unit>,
    @InjectRepository(House)
    private readonly houseRepo: Repository<House>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(WorkOrder)
    private readonly workOrderRepo: Repository<WorkOrder>,
    private readonly qrService: QrService,
  ) {}

  // ---------------- Communities ----------------

  /**
   * 默认只返回「挂房产的小区」（即没有子节点的节点），保证所有按小区筛选的老页面行为不变；
   * includeGroups=true 时把分组节点一起返回，用于房产页的层级树。
   */
  async listCommunities(query: CommunityQueryDto, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.resolveTenantId(user, query.tenantId);
    const all = await this.communityRepo.find({
      where: { tenantId },
      order: { id: 'ASC' },
    });
    const parentIds = new Set(
      all.map((item) => item.parentId).filter((id): id is number => !!id),
    );
    const scope = scopeCommunityIds(access);
    const rows = all
      .filter((item) => !scope || scope.includes(item.id))
      .map((item) => ({
        ...item,
        isGroup: parentIds.has(item.id),
      }));
    return query.includeGroups ? rows : rows.filter((item) => !item.isGroup);
  }

  async createCommunity(dto: CreateCommunityDto, user: AuthUser) {
    const tenantId = this.resolveTenantId(user, dto.tenantId);
    const existing = await this.communityRepo.findOne({
      where: { tenantId, name: dto.name },
    });
    if (existing) {
      throw new BadRequestException('同名小区已存在');
    }
    const community = this.communityRepo.create({
      tenantId,
      name: dto.name,
      parentId: await this.resolveParentId(tenantId, dto.parentId, null),
      address: dto.address ?? null,
      zones: Array.isArray(dto.zones) ? dto.zones : [],
      enabled: dto.enabled ?? true,
      createdBy: user.id,
      updatedBy: user.id,
    });
    return this.communityRepo.save(community);
  }

  async updateCommunity(id: number, dto: UpdateCommunityDto, user: AuthUser) {
    const tenantId = this.resolveTenantId(user);
    const community = await this.communityRepo.findOne({
      where: { id, tenantId },
    });
    if (!community) throw new NotFoundException('community not found');

    if (dto.name && dto.name !== community.name) {
      const dup = await this.communityRepo.findOne({
        where: { tenantId, name: dto.name },
      });
      if (dup && dup.id !== id) {
        throw new BadRequestException('同名小区已存在');
      }
      community.name = dto.name;
    }
    if (dto.parentId !== undefined) {
      community.parentId = await this.resolveParentId(tenantId, dto.parentId, id);
    }
    if (dto.address !== undefined) community.address = dto.address ?? null;
    if (dto.zones !== undefined) community.zones = dto.zones;
    if (dto.enabled !== undefined) community.enabled = dto.enabled;
    community.updatedBy = user.id;
    return this.communityRepo.save(community);
  }

  async deleteCommunity(id: number, user: AuthUser) {
    const tenantId = this.resolveTenantId(user);
    const community = await this.communityRepo.findOne({
      where: { id, tenantId },
    });
    if (!community) throw new NotFoundException('community not found');
    const childCount = await this.communityRepo.count({
      where: { tenantId, parentId: id },
    });
    if (childCount > 0) {
      throw new BadRequestException(
        `该小区下还有 ${childCount} 个分期，请先移出或删除分期`,
      );
    }
    const buildingCount = await this.buildingRepo.count({
      where: { tenantId, communityId: id },
    });
    if (buildingCount > 0) {
      throw new BadRequestException(
        `该小区下还有 ${buildingCount} 栋楼，请先删除房产`,
      );
    }
    await this.communityRepo.remove(community);
    return { ok: true };
  }

  /**
   * 按名字里的「N期」后缀自动归组：枫桦景苑一期 / 枫桦景苑二期 → 上级「枫桦景苑」。
   * 幂等：已归好组的再跑一次不会有变化。只处理同前缀 ≥2 个分期的情况。
   */
  async autoGroupCommunities(user: AuthUser, requestedTenantId?: number) {
    const tenantId = this.resolveTenantId(user, requestedTenantId);
    const all = await this.communityRepo.find({
      where: { tenantId },
      order: { id: 'ASC' },
    });
    const byName = new Map(all.map((item) => [item.name, item]));
    const parentIds = new Set(
      all.map((item) => item.parentId).filter((id): id is number => !!id),
    );

    const groups = new Map<string, Community[]>();
    for (const community of all) {
      if (parentIds.has(community.id)) continue; // 本身已是分组节点
      const parsed = splitPhaseName(community.name);
      if (!parsed) continue;
      const list = groups.get(parsed.group) ?? [];
      list.push(community);
      groups.set(parsed.group, list);
    }

    let createdGroups = 0;
    let linked = 0;
    const skipped: string[] = [];
    for (const [groupName, children] of groups) {
      if (children.length < 2) continue;
      let parent = byName.get(groupName);
      if (parent && children.some((child) => child.id === parent!.id)) continue;
      if (parent) {
        // 同名小区自己还挂着房产，就不能当分组节点，否则它会从可选小区里消失
        const buildingCount = await this.buildingRepo.count({
          where: { tenantId, communityId: parent.id },
        });
        if (buildingCount > 0) {
          skipped.push(groupName);
          continue;
        }
      }
      if (!parent) {
        parent = await this.communityRepo.save(
          this.communityRepo.create({
            tenantId,
            name: groupName,
            parentId: null,
            address: null,
            zones: [],
            enabled: true,
            createdBy: user.id,
            updatedBy: user.id,
          }),
        );
        byName.set(groupName, parent);
        createdGroups += 1;
      }
      for (const child of children) {
        if (child.parentId === parent.id) continue;
        child.parentId = parent.id;
        child.updatedBy = user.id;
        await this.communityRepo.save(child);
        linked += 1;
      }
    }
    return { createdGroups, linked, skipped };
  }

  // ---------------- Buildings ----------------

  async listBuildings(query: BuildingQueryDto, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.resolveTenantId(user, query.tenantId);
    const where: FindOptionsWhere<Building> = { tenantId };
    const scope = scopeCommunityIds(access);
    if (scope) {
      if (!scope.length) return [];
      if (query.communityId && !scope.includes(query.communityId)) return [];
      where.communityId = query.communityId ?? In(scope);
    } else if (query.communityId) {
      where.communityId = query.communityId;
    }
    const rows = await this.buildingRepo.find({ where });
    // 楼号是 varchar，按 id 出会变成建库顺序、按字符串出 10 号会跑到 2 号前
    return rows.sort(
      (a, b) => a.communityId - b.communityId || compareBuildingLike(a, b),
    );
  }

  async createBuilding(dto: CreateBuildingDto, user: AuthUser) {
    const tenantId = this.resolveTenantId(user, dto.tenantId);
    const community = await this.communityRepo.findOne({
      where: { id: dto.communityId, tenantId },
    });
    if (!community) throw new NotFoundException('community not found');

    const building = await this.upsertBuilding(
      tenantId,
      dto.communityId,
      dto.lane ?? null,
      dto.buildingNo,
      dto.zone ?? null,
      user.id,
    );
    // 新建楼栋即出码。ensureBuildingQr 内部吞掉所有异常，微信/COS 挂了也不影响建楼栋
    const qr = await this.qrService.ensureBuildingQr(tenantId, building.id, user.id);
    return {
      ...building,
      qr: qr
        ? { id: qr.id, token: qr.token, imageUrl: qr.imageUrl, lastError: qr.lastError }
        : null,
    };
  }

  async updateBuilding(id: number, dto: UpdateBuildingDto, user: AuthUser) {
    const tenantId = this.resolveTenantId(user);
    const building = await this.buildingRepo.findOne({
      where: { id, tenantId },
    });
    if (!building) throw new NotFoundException('building not found');

    const nextLane = dto.lane !== undefined ? (dto.lane || null) : building.lane;
    const nextNo = dto.buildingNo !== undefined ? dto.buildingNo : building.buildingNo;
    if (nextLane !== building.lane || nextNo !== building.buildingNo) {
      const dup = await this.buildingRepo.findOne({
        where: {
          tenantId,
          communityId: building.communityId,
          lane: nextLane ?? IsNull(),
          buildingNo: nextNo,
        },
      });
      if (dup && dup.id !== id) {
        throw new BadRequestException('同小区下已存在同弄同号的楼栋');
      }
    }

    if (dto.lane !== undefined) building.lane = dto.lane || null;
    if (dto.buildingNo !== undefined) building.buildingNo = dto.buildingNo;
    if (dto.zone !== undefined) building.zone = dto.zone || null;
    building.updatedBy = user.id;
    return this.buildingRepo.save(building);
  }

  async deleteBuilding(id: number, user: AuthUser) {
    const tenantId = this.resolveTenantId(user);
    const building = await this.buildingRepo.findOne({
      where: { id, tenantId },
    });
    if (!building) throw new NotFoundException('building not found');
    const houseCount = await this.houseRepo.count({
      where: { tenantId, buildingId: id },
    });
    if (houseCount > 0) {
      throw new BadRequestException(
        `该楼栋下还有 ${houseCount} 户房产，请先删除房产`,
      );
    }
    await this.buildingRepo.remove(building);
    return { ok: true };
  }

  // ---------------- Houses ----------------

  async listHouses(query: HouseQueryDto, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.resolveTenantId(user, query.tenantId);
    const scope = scopeCommunityIds(access);
    if (scope && !scope.length) return [];
    const qb = this.houseRepo
      .createQueryBuilder('h')
      .leftJoin(Building, 'b', 'b.id = h.building_id AND b.tenant_id = h.tenant_id')
      .leftJoin(
        Community,
        'c',
        'c.id = b.community_id AND c.tenant_id = b.tenant_id',
      )
      .leftJoin(
        User,
        'u',
        'u.house_id = h.id AND u.tenant_id = h.tenant_id AND u.role = :role',
        { role: UserRole.OWNER },
      )
      .where('h.tenant_id = :tenantId', { tenantId })
      .select([
        'h.id AS id',
        'b.community_id AS "communityId"',
        'h.building_id AS "buildingId"',
        'h.unit_id AS "unitId"',
        'h.room_no AS "roomNo"',
        'h.property_type AS "propertyType"',
        'h.road_name AS "roadName"',
        'h.full_address AS "fullAddress"',
        'h.shop_name AS "shopName"',
        'h.area_sqm AS "areaSqm"',
        'b.lane AS lane',
        'b.building_no AS "buildingNo"',
        'c.name AS "communityName"',
        'u.id AS "ownerId"',
        'u.name AS "ownerName"',
        'u.phone AS "ownerPhone"',
      ])
      .orderBy('c.id', 'ASC')
      .limit(5000);

    // 小区 → 弄 → 楼号 → 房号，全部走自然序（101 在 1001 前）
    addNaturalOrderBy(qb, 'b.lane');
    addNaturalOrderBy(qb, 'b.building_no');
    qb.addOrderBy('b.id', 'ASC');
    addNaturalOrderBy(qb, 'h.room_no');
    qb.addOrderBy('h.id', 'ASC');

    if (scope) {
      qb.andWhere('b.community_id IN (:...scopeIds)', { scopeIds: scope });
    }
    if (query.buildingId) {
      qb.andWhere('h.building_id = :bid', { bid: query.buildingId });
    } else if (query.communityId) {
      qb.andWhere('b.community_id = :cid', { cid: query.communityId });
    }

    if (query.q) {
      const rawQ = query.q.trim();
      const parts = rawQ
        .split(/[\/\\\-\s]+/)
        .map((p) => p.trim())
        .filter(Boolean);
      qb.andWhere(
        new Brackets((sub) => {
          sub
            .where('b.lane ILIKE :kw', { kw: `%${rawQ}%` })
            .orWhere('b.building_no ILIKE :kw', { kw: `%${rawQ}%` })
            .orWhere('h.room_no ILIKE :kw', { kw: `%${rawQ}%` })
            .orWhere('h.road_name ILIKE :kw', { kw: `%${rawQ}%` })
            .orWhere('h.full_address ILIKE :kw', { kw: `%${rawQ}%` })
            .orWhere('h.shop_name ILIKE :kw', { kw: `%${rawQ}%` })
            .orWhere('u.name ILIKE :kw', { kw: `%${rawQ}%` })
            .orWhere('u.phone ILIKE :kw', { kw: `%${rawQ}%` })
            .orWhere(
              "concat(coalesce(b.lane, ''), '/', b.building_no, '/', h.room_no) ILIKE :kw",
              { kw: `%${rawQ}%` },
            )
            .orWhere(
              "concat(coalesce(b.lane, ''), '弄', b.building_no, '号', h.room_no, '室') ILIKE :kw",
              { kw: `%${rawQ}%` },
            );
          if (parts.length === 3) {
            sub.orWhere(
              'b.lane = :lanePart AND b.building_no = :buildingPart AND h.room_no = :roomPart',
              {
                lanePart: parts[0],
                buildingPart: parts[1],
                roomPart: parts[2],
              },
            );
          } else if (parts.length === 2) {
            sub.orWhere('b.building_no = :buildingPart2 AND h.room_no = :roomPart2', {
              buildingPart2: parts[0],
              roomPart2: parts[1],
            });
          }
        }),
      );
    }

    const rows = await qb.getRawMany<any>();
    return rows.map((r) => ({
      id: Number(r.id),
      communityId: Number(r.communityId),
      buildingId: Number(r.buildingId),
      unitId: r.unitId ? Number(r.unitId) : null,
      roomNo: r.roomNo,
      propertyType: r.propertyType || '住宅',
      roadName: r.roadName,
      fullAddress: r.fullAddress,
      shopName: r.shopName,
      areaSqm: r.areaSqm,
      lane: r.lane,
      buildingNo: r.buildingNo,
      communityName: r.communityName,
      owner: r.ownerId
        ? { id: Number(r.ownerId), name: r.ownerName, phone: r.ownerPhone }
        : null,
    }));
  }

  async createHouse(dto: CreateHouseDto, user: AuthUser) {
    const tenantId = this.resolveTenantId(user, dto.tenantId);

    let buildingId = dto.buildingId;
    if (!buildingId) {
      if (!dto.communityId || !dto.buildingNo) {
        throw new BadRequestException(
          '需要传 buildingId 或 (communityId + buildingNo)',
        );
      }
      const community = await this.communityRepo.findOne({
        where: { id: dto.communityId, tenantId },
      });
      if (!community) throw new NotFoundException('community not found');
      const building = await this.upsertBuilding(
        tenantId,
        dto.communityId,
        dto.lane ?? null,
        dto.buildingNo,
        null,
        user.id,
      );
      buildingId = building.id;
      // 批量导入房产会顺带建出很多楼栋：这里只落码记录，图片留给「批量补齐」统一生成，
      // 避免一次导入把微信 getUnlimited 的频率打爆
      await this.qrService.ensureBuildingQr(tenantId, building.id, user.id, {
        withImage: false,
      });
    } else {
      const building = await this.buildingRepo.findOne({
        where: { id: buildingId, tenantId },
      });
      if (!building) throw new NotFoundException('building not found');
    }

    if (dto.unitId) {
      const unit = await this.unitRepo.findOne({
        where: { id: dto.unitId, tenantId, buildingId },
      });
      if (!unit) throw new NotFoundException('unit not found');
    }

    const existing = await this.houseRepo.findOne({
      where: {
        tenantId,
        buildingId,
        unitId: dto.unitId ?? IsNull(),
        roomNo: dto.roomNo,
      },
    });
    if (existing) {
      throw new BadRequestException('同楼栋下已存在该房号');
    }

    const house = this.houseRepo.create({
      tenantId,
      buildingId,
      unitId: dto.unitId ?? null,
      roomNo: dto.roomNo,
      propertyType: dto.propertyType || '住宅',
      roadName: dto.roadName || null,
      fullAddress: dto.fullAddress || null,
      shopName: dto.shopName || null,
      areaSqm: dto.areaSqm ?? null,
      createdBy: user.id,
      updatedBy: user.id,
    });
    return this.houseRepo.save(house);
  }

  async updateHouse(id: number, dto: UpdateHouseDto, user: AuthUser) {
    const tenantId = this.resolveTenantId(user);
    const house = await this.houseRepo.findOne({ where: { id, tenantId } });
    if (!house) throw new NotFoundException('house not found');

    if (dto.roomNo !== undefined && dto.roomNo !== house.roomNo) {
      const dup = await this.houseRepo.findOne({
        where: {
          tenantId,
          buildingId: house.buildingId,
          unitId: house.unitId ?? IsNull(),
          roomNo: dto.roomNo,
        },
      });
      if (dup && dup.id !== id) {
        throw new BadRequestException('同楼栋下已存在该房号');
      }
      house.roomNo = dto.roomNo;
    }
    if (dto.areaSqm !== undefined) house.areaSqm = dto.areaSqm || null;
    if (dto.propertyType !== undefined) house.propertyType = dto.propertyType || '住宅';
    if (dto.roadName !== undefined) house.roadName = dto.roadName || null;
    if (dto.fullAddress !== undefined) house.fullAddress = dto.fullAddress || null;
    if (dto.shopName !== undefined) house.shopName = dto.shopName || null;
    if (dto.unitId !== undefined) house.unitId = dto.unitId ?? null;
    house.updatedBy = user.id;
    return this.houseRepo.save(house);
  }

  async deleteHouse(id: number, user: AuthUser) {
    const tenantId = this.resolveTenantId(user);
    const house = await this.houseRepo.findOne({ where: { id, tenantId } });
    if (!house) throw new NotFoundException('house not found');

    const ownerCount = await this.userRepo.count({
      where: { tenantId, houseId: id, role: UserRole.OWNER, status: UserStatus.ACTIVE },
    });
    if (ownerCount > 0) {
      throw new BadRequestException('该房产已绑定业主，请先解绑业主');
    }
    const workOrderCount = await this.workOrderRepo
      .createQueryBuilder('w')
      .leftJoin('w.request', 'r')
      .where('w.tenant_id = :tenantId', { tenantId })
      .andWhere('r.house_id = :id', { id })
      .getCount();
    if (workOrderCount > 0) {
      throw new BadRequestException(
        `该房产有 ${workOrderCount} 条历史工单，无法删除`,
      );
    }
    await this.houseRepo.remove(house);
    return { ok: true };
  }

  /**
   * 地址树：小区(分组/分期) → 楼栋 → 房号，一次拉全，前端用来做「228/4/201」这类即时联想。
   * 精简字段，1600 户量级约 100KB。
   */
  async getAddressTree(query: TenantScopedQueryDto, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.resolveTenantId(user, query.tenantId);
    const tree = await this.buildAddressTree(tenantId, { withOwners: true });
    const scope = scopeCommunityIds(access);
    return scope ? tree.filter((node) => scope.includes(node.id)) : tree;
  }

  /**
   * 入驻用的小区清单。已归属租户的用户只看自己租户的；
   * 新业主（tenantId 为空）跨租户返回，否则他没法手动选到自己的小区。
   * 只出挂了房产的小区（分组节点没法直接选），且只返回 id + 名称。
   */
  async listPublicCommunities(user: AuthUser) {
    const where = user.tenantId ? { tenantId: user.tenantId, enabled: true } : { enabled: true };
    const communities = await this.communityRepo.find({
      where,
      order: { tenantId: 'ASC', id: 'ASC' },
    });
    const parentIds = new Set(
      communities.map((item) => item.parentId).filter((id): id is number => !!id),
    );
    const leaves = communities.filter((item) => !parentIds.has(item.id)); // 分组节点下面没有楼栋，不给选
    if (!leaves.length) return [];

    // 每个小区的主弄（住宅楼栋里占比最高的那个弄），用来显示成「枫桦景苑·一期（198弄）」
    const laneRows = await this.buildingRepo
      .createQueryBuilder('b')
      .select('b.community_id', 'communityId')
      .addSelect('b.lane', 'lane')
      .addSelect('COUNT(*)', 'count')
      .where('b.community_id IN (:...ids)', { ids: leaves.map((item) => item.id) })
      .andWhere("COALESCE(b.lane, '') <> ''")
      .groupBy('b.community_id')
      .addGroupBy('b.lane')
      .orderBy('COUNT(*)', 'DESC')
      .getRawMany<{ communityId: number; lane: string; count: string }>();

    const mainLaneByCommunity = new Map<number, string>();
    for (const row of laneRows) {
      const id = Number(row.communityId);
      if (!mainLaneByCommunity.has(id)) mainLaneByCommunity.set(id, row.lane);
    }

    return leaves.map((item) => {
      const groupName = item.parentId
        ? communities.find((c) => c.id === item.parentId)?.name ?? null
        : null;
      return {
        id: item.id,
        name: item.name,
        groupName,
        /** 「枫桦景苑一期」去掉分组前缀后的「一期」，给小程序拼短标签用 */
        shortName: groupName && item.name.startsWith(groupName)
          ? item.name.slice(groupName.length) || item.name
          : item.name,
        mainLane: mainLaneByCommunity.get(item.id) ?? null,
      };
    });
  }

  /**
   * 小程序端地址簿：结构同 address-tree，但**不带任何业主信息**，并且必须按小区收窄。
   * 业主首次入驻时账号还没有 tenantId，此时用 communityId 反查租户
   * （与 ownerOnboard 同样的信任模型：小区 id 来自扫码解析出的二维码）。
   */
  async getAddressBook(communityId: number | undefined, user: AuthUser) {
    let tenantId = user.tenantId ?? null;
    if (!tenantId) {
      if (!communityId) {
        throw new BadRequestException('请先扫码确定小区');
      }
      const community = await this.communityRepo.findOne({
        where: { id: communityId },
      });
      if (!community) throw new NotFoundException('community not found');
      tenantId = community.tenantId;
    }
    const tree = await this.buildAddressTree(tenantId, { withOwners: false });
    if (!communityId) return tree;
    // 只给这个小区（含它所属分组下的其它分期，业主可能扫了隔壁期的码）
    const picked = tree.find((item) => item.id === communityId);
    if (!picked) throw new NotFoundException('community not found');
    if (!picked.parentId) return [picked];
    return tree.filter(
      (item) => item.id === communityId || item.parentId === picked.parentId,
    );
  }

  private async buildAddressTree(
    tenantId: number,
    opts: { withOwners: boolean },
  ) {
    const communities = await this.communityRepo.find({
      where: { tenantId },
      order: { id: 'ASC' },
    });
    const buildings = (
      await this.buildingRepo.find({ where: { tenantId } })
    ).sort(compareBuildingLike);
    const houseQb = this.houseRepo
      .createQueryBuilder('h')
      .leftJoin(
        User,
        'u',
        'u.house_id = h.id AND u.tenant_id = h.tenant_id AND u.role = :role AND u.status = :status',
        { role: UserRole.OWNER, status: UserStatus.ACTIVE },
      )
      .where('h.tenant_id = :tenantId', { tenantId })
      .select([
        'h.id AS id',
        'h.building_id AS "buildingId"',
        'h.room_no AS "roomNo"',
        'h.property_type AS "propertyType"',
        'h.road_name AS "roadName"',
        'h.shop_name AS "shopName"',
        'u.name AS "ownerName"',
        'u.phone AS "ownerPhone"',
      ])
      .orderBy('h.building_id', 'ASC');
    addNaturalOrderBy(houseQb, 'h.room_no');
    const houseRows = await houseQb.getRawMany<any>();

    const buildingNodes = new Map<
      number,
      {
        id: number;
        communityId: number;
        lane: string | null;
        buildingNo: string;
        roadName: string | null;
        houses: Array<{
          id: number;
          roomNo: string;
          propertyType: string;
          shopName: string | null;
          ownerName: string | null;
          ownerPhone: string | null;
        }>;
      }
    >();
    for (const b of buildings) {
      buildingNodes.set(b.id, {
        id: b.id,
        communityId: b.communityId,
        lane: b.lane,
        buildingNo: b.buildingNo,
        roadName: null,
        houses: [],
      });
    }
    for (const row of houseRows) {
      const node = buildingNodes.get(Number(row.buildingId));
      if (!node) continue;
      if (!node.roadName && row.roadName) node.roadName = row.roadName;
      node.houses.push({
        id: Number(row.id),
        roomNo: row.roomNo,
        propertyType: row.propertyType || '住宅',
        shopName: row.shopName || null,
        // 业主姓名/电话只给后台，小程序端一律不下发
        ownerName: opts.withOwners ? row.ownerName || null : null,
        ownerPhone: opts.withOwners ? row.ownerPhone || null : null,
      });
    }

    const parentIds = new Set(
      communities.map((c) => c.parentId).filter((id): id is number => !!id),
    );
    return communities.map((c) => {
      const own = Array.from(buildingNodes.values()).filter(
        (b) => b.communityId === c.id,
      );
      // 主弄号：覆盖户数最多的那个「弄」，用于在下拉里省掉重复前缀
      const laneWeight = new Map<string, number>();
      for (const b of own) {
        if (!b.lane) continue;
        laneWeight.set(b.lane, (laneWeight.get(b.lane) ?? 0) + b.houses.length);
      }
      const mainLane =
        Array.from(laneWeight.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ??
        null;
      return {
        id: c.id,
        name: c.name,
        parentId: c.parentId,
        isGroup: parentIds.has(c.id),
        mainLane,
        buildings: own.map(({ communityId: _communityId, ...rest }) => rest),
      };
    });
  }

  // ---------------- helpers ----------------

  /** 校验并归一化「上级小区」，只允许两层 */
  private async resolveParentId(
    tenantId: number,
    parentId: number | null | undefined,
    selfId: number | null,
  ): Promise<number | null> {
    if (parentId === undefined || parentId === null) return null;
    if (!Number.isInteger(parentId)) {
      throw new BadRequestException('上级小区 id 不合法');
    }
    if (selfId && parentId === selfId) {
      throw new BadRequestException('不能把小区设为自己的上级');
    }
    const parent = await this.communityRepo.findOne({
      where: { id: parentId, tenantId },
    });
    if (!parent) throw new NotFoundException('上级小区不存在');
    if (parent.parentId) {
      throw new BadRequestException('小区层级最多两层，不能挂在分期下面');
    }
    // 分组节点只用来分层，本身不挂房产；否则它会从「可选小区」列表里消失
    const parentBuildings = await this.buildingRepo.count({
      where: { tenantId, communityId: parent.id },
    });
    if (parentBuildings > 0) {
      throw new BadRequestException(
        `「${parent.name}」下面还挂着 ${parentBuildings} 栋楼，不能当上级小区`,
      );
    }
    if (selfId) {
      const childCount = await this.communityRepo.count({
        where: { tenantId, parentId: selfId },
      });
      if (childCount > 0) {
        throw new BadRequestException(
          '该小区下已有分期，不能再挂到别的小区下面',
        );
      }
    }
    return parentId;
  }

  private async upsertBuilding(
    tenantId: number,
    communityId: number,
    lane: string | null,
    buildingNo: string,
    zone: string | null,
    operatorId: number,
  ): Promise<Building> {
    const existing = await this.buildingRepo.findOne({
      where: {
        tenantId,
        communityId,
        lane: lane ?? IsNull(),
        buildingNo,
      },
    });
    if (existing) {
      if (zone && zone !== existing.zone) {
        existing.zone = zone;
        existing.updatedBy = operatorId;
        return this.buildingRepo.save(existing);
      }
      return existing;
    }
    return this.buildingRepo.save(
      this.buildingRepo.create({
        tenantId,
        communityId,
        lane: lane || null,
        buildingNo,
        zone: zone || null,
        createdBy: operatorId,
        updatedBy: operatorId,
      }),
    );
  }

  private resolveTenantId(user: AuthUser, requestedTenantId?: number): number {
    if (user.tenantId) {
      if (requestedTenantId && requestedTenantId !== user.tenantId) {
        throw new ForbiddenException('tenant mismatch');
      }
      return user.tenantId;
    }
    if (user.role === UserRole.SUPERADMIN) {
      if (!requestedTenantId) {
        throw new BadRequestException('tenantId is required for superadmin');
      }
      return requestedTenantId;
    }
    throw new ForbiddenException('tenant scope is required');
  }
}
