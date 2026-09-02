import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  Brackets,
  FindOptionsWhere,
  In,
  IsNull,
  Repository,
  SelectQueryBuilder,
} from 'typeorm';
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
  CommunitySpot,
  House,
  ManagementOffice,
  Unit,
  User,
  WorkOrder,
} from '../../entities';
import {
  extractAddressCandidate,
  matchCommunityByName,
} from '../repairs/repair-address.util';
import {
  BuildingQueryDto,
  CommunityQueryDto,
  CommunitySpotQueryDto,
  CreateBuildingDto,
  CreateCommunityDto,
  CreateCommunitySpotDto,
  CreateHouseDto,
  HouseQueryDto,
  ParseHouseAddressDto,
  TenantScopedQueryDto,
  UpdateBuildingDto,
  UpdateCommunityDto,
  UpdateCommunitySpotDto,
  UpdateHouseDto,
} from './dto';
import { QrService } from '../qr/qr.service';

/**
 * 小区名里不该出现「管理处」：管理处是 management_offices 里的独立一层，
 * 靠 communities.office_id 挂上来。2026-08-29 之前线上把 4 个管理处各建了一个
 * 同名顶层小区当分组、真小区挂成它的「分期」—— 房产树上多一层假节点、
 * 管理处页「管辖小区」显示成自己的名字，真小区还占掉了分期那一层。
 */
const OFFICE_WORD = /管理处|物业处|项目部/;

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
    @InjectRepository(ManagementOffice)
    private readonly officeRepo: Repository<ManagementOffice>,
    @InjectRepository(CommunitySpot)
    private readonly spotRepo: Repository<CommunitySpot>,
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
    // 管理处名一起带出来：房产页的层级树按它分组、小区管理里回显「所属管理处」，
    // 都不必再去要 offices 页面的权限
    const offices = await this.officeRepo.find({
      where: { tenantId },
      select: ['id', 'name'],
    });
    const officeName = new Map(offices.map((o) => [o.id, o.name]));
    const byId = new Map(all.map((item) => [item.id, item]));
    const rows = all
      .filter((item) => !scope || scope.includes(item.id))
      .map((item) => {
        // 分期自己不挂管理处，显示时跟随顶层小区
        const owner = item.officeId
          ? item
          : item.parentId
            ? byId.get(item.parentId)
            : null;
        return {
          ...item,
          isGroup: parentIds.has(item.id),
          officeName: owner?.officeId ? officeName.get(owner.officeId) ?? null : null,
        };
      });
    return query.includeGroups ? rows : rows.filter((item) => !item.isGroup);
  }

  async createCommunity(
    dto: CreateCommunityDto,
    user: AuthUser,
    access?: ResolvedAccess,
  ) {
    const tenantId = this.resolveTenantId(user, dto.tenantId);
    // 开小区是公司级动作：新建的小区不在任何管理处角色的范围里，
    // 让受限角色建等于建完自己就看不见。企业超管建好再划给管理处。
    if (scopeCommunityIds(access)) {
      throw new ForbiddenException('只有全公司数据范围的账号能新建小区');
    }
    this.assertNotOfficeName(dto.name);
    const existing = await this.communityRepo.findOne({
      where: { tenantId, name: dto.name },
    });
    if (existing) {
      throw new BadRequestException('同名小区已存在');
    }
    const parentId = await this.resolveParentId(tenantId, dto.parentId, null);
    const community = this.communityRepo.create({
      tenantId,
      name: dto.name,
      parentId,
      officeId: await this.resolveOfficeId(tenantId, dto.officeId, parentId),
      address: dto.address ?? null,
      zones: Array.isArray(dto.zones) ? dto.zones : [],
      enabled: dto.enabled ?? true,
      createdBy: user.id,
      updatedBy: user.id,
    });
    return this.communityRepo.save(community);
  }

  async updateCommunity(
    id: number,
    dto: UpdateCommunityDto,
    user: AuthUser,
    access?: ResolvedAccess,
  ) {
    const tenantId = this.resolveTenantId(user);
    const community = await this.communityRepo.findOne({
      where: { id, tenantId },
    });
    if (!community) throw new NotFoundException('community not found');
    this.assertCommunityInScope(access, id);

    if (dto.name && dto.name !== community.name) {
      this.assertNotOfficeName(dto.name);
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
    if (dto.officeId !== undefined || dto.parentId !== undefined) {
      community.officeId = await this.resolveOfficeId(
        tenantId,
        dto.officeId !== undefined ? dto.officeId : community.officeId,
        community.parentId,
        access,
      );
    }
    if (dto.address !== undefined) community.address = dto.address ?? null;
    if (dto.zones !== undefined) community.zones = dto.zones;
    if (dto.enabled !== undefined) community.enabled = dto.enabled;
    community.updatedBy = user.id;
    return this.communityRepo.save(community);
  }

  async deleteCommunity(id: number, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.resolveTenantId(user);
    const community = await this.communityRepo.findOne({
      where: { id, tenantId },
    });
    if (!community) throw new NotFoundException('community not found');
    this.assertCommunityInScope(access, id);
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
   * 把一整句地址拆成表单字段：「剑川路198弄3号301室」→ 路名/小区/弄/号/室。
   *
   * 和报修的语音地址识别**共用同一套解析**（repair-address.util）——
   * 一边改了另一边跟着变，不会出现「小程序认得出、后台认不出」这种两套口径。
   * 小区一律撞库：名字对不上就不填，留给人自己选，绝不猜一个小区塞进去。
   */
  async parseHouseAddress(dto: ParseHouseAddressDto, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.resolveTenantId(user, dto.tenantId);
    const candidate = extractAddressCandidate(dto.text);
    if (!candidate) {
      return { matched: false as const };
    }
    const scope = scopeCommunityIds(access);
    const all = await this.communityRepo.find({ where: { tenantId, enabled: true } });
    const parentIds = new Set(
      all.map((c) => c.parentId).filter((id): id is number => !!id),
    );
    // 分组节点不挂房产，只在叶子里选；受限角色只在自己范围内选
    const leaves = all.filter(
      (c) => !parentIds.has(c.id) && (!scope || scope.includes(c.id)),
    );

    const byName = matchCommunityByName(candidate.namePrefix, leaves);
    const byPhase = candidate.phase
      ? leaves.filter((c) => c.name.endsWith(candidate.phase as string))
      : [];
    let pool = byName.length && byPhase.length
      ? byName.filter((c) => byPhase.some((p) => p.id === c.id))
      : byName.length
        ? byName
        : byPhase;

    // 名字和分期都没说：用「弄」反查——同一个弄基本只属于一个小区
    if (!pool.length && candidate.lane) {
      const laneBuildings = await this.buildingRepo.find({
        where: { tenantId, lane: candidate.lane },
        select: ['id', 'communityId'],
      });
      const ids = [...new Set(laneBuildings.map((b) => b.communityId))];
      pool = leaves.filter((c) => ids.includes(c.id));
    }
    // 认出不止一个就等于没认出来，让人自己选，不赌
    const community = pool.length === 1 ? pool[0] : null;

    return {
      matched: true as const,
      roadName: candidate.roadName,
      communityId: community?.id ?? null,
      communityName: community?.name ?? null,
      lane: candidate.lane,
      buildingNo: candidate.buildingNo,
      roomNo: candidate.roomNo,
      /** 没认出小区时告诉前端为什么，别让人对着空下拉猜 */
      ambiguous: pool.length > 1 ? pool.map((c) => c.name) : [],
    };
  }

  /** 「所属管理处」下拉的选项。挂在 properties 权限下，房产页不必额外开管理处页权限 */
  async listOfficeOptions(user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.resolveTenantId(user);
    const offices = await this.officeRepo.find({
      where: { tenantId, enabled: true },
      order: { id: 'ASC' },
    });
    const scope = scopeCommunityIds(access);
    if (!scope) return offices.map((o) => ({ id: o.id, name: o.name }));
    if (!scope.length) return [];
    const officeIds = await this.officeIdsForScope(tenantId, scope);
    return offices
      .filter((office) => officeIds.has(office.id))
      .map((office) => ({ id: office.id, name: office.name }));
  }

  private async officeIdsForScope(tenantId: number, scope: number[]) {
    const communities = await this.communityRepo.find({
      where: { tenantId },
      select: ['id', 'parentId', 'officeId'],
    });
    const byId = new Map(communities.map((item) => [item.id, item]));
    const officeIds = new Set<number>();
    for (const id of scope) {
      const item = byId.get(id);
      const officeId =
        item?.officeId ??
        (item?.parentId ? byId.get(item.parentId)?.officeId : null);
      if (officeId) officeIds.add(officeId);
    }
    return officeIds;
  }

  private assertNotOfficeName(name: string) {
    if (OFFICE_WORD.test(name)) {
      throw new BadRequestException(
        '「管理处」不是小区。请去「管理处」页面新建管理处，再回这里把小区的「所属管理处」选上',
      );
    }
  }

  /** 只有顶层小区自己挂管理处；分期一律跟随上级，office_id 留空 */
  private async resolveOfficeId(
    tenantId: number,
    officeId: number | null | undefined,
    parentId: number | null,
    access?: ResolvedAccess,
  ): Promise<number | null> {
    if (parentId) return null;
    if (!officeId) return null;
    const office = await this.officeRepo.findOne({
      where: { id: officeId, tenantId },
    });
    if (!office) throw new BadRequestException('管理处不存在');
    const scope = scopeCommunityIds(access);
    if (
      scope &&
      !(await this.officeIdsForScope(tenantId, scope)).has(office.id)
    ) {
      throw new ForbiddenException('该管理处不在你的数据范围内');
    }
    return office.id;
  }

  /**
   * 写操作的数据范围闸门。列表接口一直过 `scopeCommunityIds`，写接口是
   * 2026-08-30 才补的 —— 在此之前「枫桦景苑办公室」（范围=枫桦景苑管理处，
   * 且有房产管理增删改权）能改永德段、吴泾新村的小区/楼栋/房号。
   * properties 下任何新增的写接口都要先过这里。
   */
  private assertCommunityInScope(
    access: ResolvedAccess | undefined,
    communityId: number,
  ) {
    const scope = scopeCommunityIds(access);
    if (scope && !scope.includes(communityId)) {
      throw new ForbiddenException('该小区不在你的数据范围内');
    }
  }

  private async assertBuildingInScope(
    access: ResolvedAccess | undefined,
    tenantId: number,
    buildingId: number,
  ) {
    if (!scopeCommunityIds(access)) return;
    const building = await this.buildingRepo.findOne({
      where: { id: buildingId, tenantId },
      select: ['id', 'communityId'],
    });
    if (!building) throw new NotFoundException('building not found');
    this.assertCommunityInScope(access, building.communityId);
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

  async createBuilding(
    dto: CreateBuildingDto,
    user: AuthUser,
    access?: ResolvedAccess,
  ) {
    const tenantId = this.resolveTenantId(user, dto.tenantId);
    const community = await this.communityRepo.findOne({
      where: { id: dto.communityId, tenantId },
    });
    if (!community) throw new NotFoundException('community not found');
    this.assertCommunityInScope(access, dto.communityId);

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

  async updateBuilding(
    id: number,
    dto: UpdateBuildingDto,
    user: AuthUser,
    access?: ResolvedAccess,
  ) {
    const tenantId = this.resolveTenantId(user);
    const building = await this.buildingRepo.findOne({
      where: { id, tenantId },
    });
    if (!building) throw new NotFoundException('building not found');
    this.assertCommunityInScope(access, building.communityId);

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

  async deleteBuilding(id: number, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.resolveTenantId(user);
    const building = await this.buildingRepo.findOne({
      where: { id, tenantId },
    });
    if (!building) throw new NotFoundException('building not found');
    this.assertCommunityInScope(access, building.communityId);
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

  // ---------------- 公区点位 ----------------

  /**
   * 公区点位 = 没有房号的地方：监控室、门卫室、水泵房、电梯机房、垃圾房……
   *
   * 为什么不在 houses 里加一条「商铺」：这些地方没有业主、没有面积、不收物业费，
   * 塞进房产台账会弄脏统计和收费口径；而且报修识别找房号只按数字撞，
   * 名字叫「监控室」的房号永远撞不上。单独一张表之后，「监控室2号显示屏不亮」
   * 才能认成「枫桦景苑二期 监控室」，而不是错挂到 228弄2号楼上。
   */
  async listCommunitySpots(
    query: CommunitySpotQueryDto,
    user: AuthUser,
    access?: ResolvedAccess,
  ) {
    const tenantId = this.resolveTenantId(user, query.tenantId);
    const where: FindOptionsWhere<CommunitySpot> = { tenantId };
    const scope = scopeCommunityIds(access);
    if (scope) {
      if (!scope.length) return [];
      if (query.communityId && !scope.includes(query.communityId)) return [];
      where.communityId = query.communityId ?? In(scope);
    } else if (query.communityId) {
      where.communityId = query.communityId;
    }
    const rows = await this.spotRepo.find({ where });
    // 挂了楼栋的点位要显示「228弄3号」，否则后台只看得到一个楼栋 id
    const buildingIds = [
      ...new Set(rows.map((r) => r.buildingId).filter((id): id is number => !!id)),
    ];
    const buildings = buildingIds.length
      ? await this.buildingRepo.find({ where: { tenantId, id: In(buildingIds) } })
      : [];
    const buildingById = new Map(buildings.map((b) => [b.id, b]));
    return rows
      .sort((a, b) => a.communityId - b.communityId || a.sortOrder - b.sortOrder || a.id - b.id)
      .map((row) => {
        const building = row.buildingId ? buildingById.get(row.buildingId) : null;
        return {
          ...row,
          buildingText: building
            ? `${building.lane ? building.lane + '弄' : ''}${building.buildingNo}号`
            : '',
        };
      });
  }

  async createCommunitySpot(
    dto: CreateCommunitySpotDto,
    user: AuthUser,
    access?: ResolvedAccess,
  ) {
    const tenantId = this.resolveTenantId(user, dto.tenantId);
    const name = this.assertSpotName(dto.name);
    await this.assertSpotPlace(tenantId, dto.communityId, dto.buildingId ?? null, access);
    await this.assertSpotNameFree(tenantId, dto.communityId, name, null);
    const spot = this.spotRepo.create({
      tenantId,
      communityId: dto.communityId,
      buildingId: dto.buildingId ?? null,
      name,
      sortOrder: dto.sortOrder ?? 0,
      enabled: dto.enabled ?? true,
      createdBy: user.id,
      updatedBy: user.id,
    });
    return this.spotRepo.save(spot);
  }

  async updateCommunitySpot(
    id: number,
    dto: UpdateCommunitySpotDto,
    user: AuthUser,
    access?: ResolvedAccess,
  ) {
    const tenantId = this.resolveTenantId(user);
    const spot = await this.spotRepo.findOne({ where: { id, tenantId } });
    if (!spot) throw new NotFoundException('spot not found');
    this.assertCommunityInScope(access, spot.communityId);
    if (dto.name !== undefined) {
      const name = this.assertSpotName(dto.name);
      await this.assertSpotNameFree(tenantId, spot.communityId, name, id);
      spot.name = name;
    }
    if (dto.buildingId !== undefined) {
      await this.assertSpotPlace(tenantId, spot.communityId, dto.buildingId, access);
      spot.buildingId = dto.buildingId;
    }
    if (dto.sortOrder !== undefined) spot.sortOrder = dto.sortOrder;
    if (dto.enabled !== undefined) spot.enabled = dto.enabled;
    spot.updatedBy = user.id;
    return this.spotRepo.save(spot);
  }

  async deleteCommunitySpot(id: number, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.resolveTenantId(user);
    const spot = await this.spotRepo.findOne({ where: { id, tenantId } });
    if (!spot) throw new NotFoundException('spot not found');
    this.assertCommunityInScope(access, spot.communityId);
    // 点位只被地址识别读，删掉不影响已经开出去的工单（工单存的是地址文本和 id 快照）
    await this.spotRepo.remove(spot);
    return { ok: true };
  }

  /**
   * 点位名要能在一句话里被认出来，所以：至少两个字（一个字满句子都是误撞），
   * 不能是纯数字（会和门牌号「2号」打架）。
   */
  private assertSpotName(raw: string): string {
    const name = String(raw || '').trim();
    if (name.length < 2) throw new BadRequestException('点位名称至少 2 个字');
    if (/^[0-9０-９]+$/.test(name)) {
      throw new BadRequestException('点位名称不能是纯数字，会和门牌号混掉');
    }
    return name;
  }

  private async assertSpotPlace(
    tenantId: number,
    communityId: number,
    buildingId: number | null,
    access?: ResolvedAccess,
  ) {
    const community = await this.communityRepo.findOne({
      where: { id: communityId, tenantId },
    });
    if (!community) throw new NotFoundException('community not found');
    this.assertCommunityInScope(access, communityId);
    if (buildingId === null) return;
    const building = await this.buildingRepo.findOne({
      where: { id: buildingId, tenantId },
      select: ['id', 'communityId'],
    });
    if (!building) throw new NotFoundException('building not found');
    if (building.communityId !== communityId) {
      throw new BadRequestException('这栋楼不在该小区下');
    }
  }

  /** 同一小区里点位不能重名：识别是按名字撞的，重名等于认出来也不知道是哪一个 */
  private async assertSpotNameFree(
    tenantId: number,
    communityId: number,
    name: string,
    selfId: number | null,
  ) {
    const dup = await this.spotRepo.findOne({
      where: { tenantId, communityId, name },
    });
    if (dup && dup.id !== selfId) {
      throw new BadRequestException('该小区下已有同名点位');
    }
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
      .orderBy('c.id', 'ASC');

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
      // 选中的是分组小区（如「永南永北」）时，把它底下的分期一起算进来 ——
      // 分组本身不挂房产，只按 id 相等过滤会得到空列表
      const ids = await this.expandCommunityIds(tenantId, query.communityId);
      qb.andWhere('b.community_id IN (:...cids)', { cids: ids });
    }

    if (query.q) this.applyHouseKeyword(qb, query.q);

    // 传了 page 才分页。老调用方（房号搜索下拉、前台收费、物业费）不传，继续拿数组，
    // 但上限从 5000 提到 20000 —— 一次导入几千套房很容易顶到旧上限，
    // 顶到之后列表和左侧树的角标会一起少掉，还看不出是被截断的（2026-08-27 就这么撞上了）。
    const paged = query.page !== undefined;
    let total: number | undefined;
    if (paged) {
      total = await qb.getCount();
      const page = Math.max(1, Number(query.page) || 1);
      const pageSize = Math.min(500, Math.max(1, Number(query.pageSize) || 50));
      qb.offset((page - 1) * pageSize).limit(pageSize);
    } else {
      qb.limit(20000);
    }

    const rows = await qb.getRawMany<any>();
    const mapped = rows.map((r) => ({
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
    if (!paged) return mapped;
    return {
      rows: mapped,
      total: total ?? mapped.length,
      page: Math.max(1, Number(query.page) || 1),
      pageSize: Math.min(500, Math.max(1, Number(query.pageSize) || 50)),
    };
  }


  /**
   * 房号模糊搜索：弄/号/室/路名/完整地址/商铺名/业主姓名/业主电话，
   * 外加 `198/2/101` 和 `198弄2号101室` 两种整串写法。
   * 列表和树的角标共用这一份，两边口径才不会飘。调用前需已 join b / h / u。
   */
  private applyHouseKeyword(qb: SelectQueryBuilder<House>, keyword: string) {
    const rawQ = keyword.trim();
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

  /** 小区 id → 它自己 + 它底下的分期（不是分组时就只有它自己） */
  private async expandCommunityIds(tenantId: number, communityId: number): Promise<number[]> {
    const children = await this.communityRepo.find({
      where: { tenantId, parentId: communityId },
      select: ['id'],
    });
    return children.length ? [communityId, ...children.map((c) => c.id)] : [communityId];
  }

  /**
   * 左侧树的户数角标专用：按小区 / 楼栋分组数房，**不受列表分页和上限影响**。
   * 角标和列表必须同一套过滤口径（同样的 scope、同样的 q），否则用户会看到
   * 「树上写 658 户、点进去只有 500 行」这种对不上的数。
   */
  async houseSummary(query: HouseQueryDto, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.resolveTenantId(user, query.tenantId);
    const scope = scopeCommunityIds(access);
    if (scope && !scope.length) {
      return { total: 0, communities: [], buildings: [] };
    }
    const qb = this.houseRepo
      .createQueryBuilder('h')
      .innerJoin(Building, 'b', 'b.id = h.building_id AND b.tenant_id = h.tenant_id')
      .leftJoin(
        User,
        'u',
        'u.house_id = h.id AND u.tenant_id = h.tenant_id AND u.role = :role',
        { role: UserRole.OWNER },
      )
      .where('h.tenant_id = :tenantId', { tenantId });
    if (scope) qb.andWhere('b.community_id IN (:...scopeIds)', { scopeIds: scope });
    if (query.q) this.applyHouseKeyword(qb, query.q);

    const rows = await qb
      .select([
        'b.community_id AS "communityId"',
        'h.building_id AS "buildingId"',
        'b.lane AS lane',
        'b.building_no AS "buildingNo"',
        'MIN(h.road_name) AS "roadName"',
        'COUNT(*) AS count',
      ])
      .groupBy('b.community_id')
      .addGroupBy('h.building_id')
      .addGroupBy('b.lane')
      .addGroupBy('b.building_no')
      .getRawMany<any>();

    const buildings = rows.map((r) => ({
      buildingId: Number(r.buildingId),
      communityId: Number(r.communityId),
      lane: r.lane,
      buildingNo: r.buildingNo,
      roadName: r.roadName,
      count: Number(r.count),
    }));
    buildings.sort(compareBuildingLike as any);
    const communityMap = new Map<number, number>();
    for (const b of buildings) {
      communityMap.set(b.communityId, (communityMap.get(b.communityId) ?? 0) + b.count);
    }
    return {
      total: buildings.reduce((sum, b) => sum + b.count, 0),
      communities: [...communityMap.entries()].map(([communityId, count]) => ({
        communityId,
        count,
      })),
      buildings,
    };
  }

  async createHouse(
    dto: CreateHouseDto,
    user: AuthUser,
    access?: ResolvedAccess,
  ) {
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
      this.assertCommunityInScope(access, dto.communityId);
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
      this.assertCommunityInScope(access, building.communityId);
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

  async updateHouse(
    id: number,
    dto: UpdateHouseDto,
    user: AuthUser,
    access?: ResolvedAccess,
  ) {
    const tenantId = this.resolveTenantId(user);
    const house = await this.houseRepo.findOne({ where: { id, tenantId } });
    if (!house) throw new NotFoundException('house not found');
    await this.assertBuildingInScope(access, tenantId, house.buildingId);

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

  async deleteHouse(id: number, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.resolveTenantId(user);
    const house = await this.houseRepo.findOne({ where: { id, tenantId } });
    if (!house) throw new NotFoundException('house not found');
    await this.assertBuildingInScope(access, tenantId, house.buildingId);

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
  async getAddressBook(
    communityId: number | undefined,
    user: AuthUser,
    access?: ResolvedAccess,
  ) {
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
    // 员工端必须服从业务角色的数据范围。空数组是「一个小区都没授权」，
    // 不能再当成全公司；业主首次扫码没有 access，仍沿用原来的扫码定位逻辑。
    const scope = scopeCommunityIds(access);
    const visibleTree = scope
      ? tree.filter((item) => scope.includes(item.id))
      : tree;
    if (!communityId) return visibleTree;
    // 只给这个小区（含它所属分组下的其它分期，业主可能扫了隔壁期的码）
    const picked = visibleTree.find((item) => item.id === communityId);
    if (!picked) throw new NotFoundException('community not found');
    if (!picked.parentId) return [picked];
    return visibleTree.filter(
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
