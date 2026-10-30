import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, In, IsNull, Repository } from 'typeorm';
import { AuthUser } from '../../common/current-user.decorator';
import { ResolvedAccess } from '../access/access.service';
import { scopeCommunityIds } from '../access/scope.util';
import { addNaturalOrderBy } from '../../common/natural-order';
import {
  BusinessBillingUnit,
  BusinessServiceType,
  BusinessTransactionStatus,
  UserRole,
} from '../../common/enums';
import {
  AccessCard,
  BusinessLog,
  BusinessRule,
  BusinessTransaction,
  Building,
  Community,
  House,
  ParkingVehicle,
  User,
  ParkingPlateTag,
} from '../../entities';
import {
  BusinessRuleQueryDto,
  BusinessSearchDto,
  CompleteBusinessDto,
  EstimateBusinessDto,
  UpsertBusinessRuleDto,
} from './dto';
import { BusinessExecutionService } from './business-execution.service';
import { findParkingTarget, PARKING_TARGETS, targetsForCommunity, validateRuleTarget } from './parking-targets';
import { addDays, addMonthsClamped, renewalWindow } from './business-execution.util';
import { AccessService } from '../access/access.service';
import { VehicleIntakeService } from './vehicle-intake.service';
import { DEFAULT_GROUP, STANDARD_MONTHS, normalizeTiers, normalizeVehicleClass, priceRule, targetsOverlap, upgradeToTable, type ParkingRuleConfig } from './parking-pricing';
import { Notification } from '../../entities';
import { NotifyChannel, NotifyStatus } from '../../common/enums';
import { DeliyunParkingService } from '../access-card-issuance/deliyun-parking.service';

@Injectable()
export class BusinessService {
  constructor(
    @InjectRepository(BusinessRule)
    private readonly ruleRepo: Repository<BusinessRule>,
    @InjectRepository(ParkingVehicle)
    private readonly vehicleRepo: Repository<ParkingVehicle>,
    @InjectRepository(AccessCard)
    private readonly cardRepo: Repository<AccessCard>,
    @InjectRepository(BusinessTransaction)
    private readonly txnRepo: Repository<BusinessTransaction>,
    @InjectRepository(BusinessLog)
    private readonly logRepo: Repository<BusinessLog>,
    @InjectRepository(House)
    private readonly houseRepo: Repository<House>,
    @InjectRepository(Building)
    private readonly buildingRepo: Repository<Building>,
    private readonly execution: BusinessExecutionService,
    @InjectRepository(Community)
    private readonly communityRepo: Repository<Community>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly deliyun: DeliyunParkingService,
    private readonly access: AccessService,
    private readonly intakes: VehicleIntakeService,
    @InjectRepository(ParkingPlateTag)
    private readonly tagRepo: Repository<ParkingPlateTag>,
  ) {}

  /** 车牌分类（按哪类收费）：收银台按车牌批量取 */
  async plateTags(plates: string[], user: AuthUser) {
    const tenantId = this.requireTenant(user);
    const list = [...new Set(plates.map((p) => normPlate(p)).filter(Boolean))].slice(0, 100);
    if (!list.length) return [];
    return this.tagRepo.find({ where: { tenantId, plate: In(list) } });
  }

  /** 缴费规则分组下的车牌：按分组 / 车牌片段查（收费标准页用） */
  async listPlateTags(query: { group?: string; q?: string }, user: AuthUser) {
    const tenantId = this.requireTenant(user);
    const qb = this.tagRepo.createQueryBuilder('t').where('t.tenant_id = :tenantId', { tenantId });
    if (query.group) qb.andWhere('t.vehicle_class = :g', { g: query.group });
    const q = normPlate(query.q || '');
    if (q) qb.andWhere('t.plate ILIKE :q', { q: `%${q}%` });
    const [rows, counts] = await Promise.all([
      qb.orderBy('t.updated_at', 'DESC').take(500).getMany(),
      this.tagRepo.createQueryBuilder('t').select('t.vehicle_class', 'group').addSelect('COUNT(*)', 'n')
        .where('t.tenant_id = :tenantId', { tenantId }).groupBy('t.vehicle_class').getRawMany<{ group: string; n: string }>(),
    ]);
    return { rows, counts: Object.fromEntries(counts.map((c) => [c.group, Number(c.n)])) };
  }

  /** 车牌归入缴费规则分组；清空 = 移出分组（按默认分组收） */
  async setPlateTag(plateValue: string, vehicleClass: string, houseId: number | null, user: AuthUser) {
    const tenantId = this.requireTenant(user);
    const plate = normPlate(plateValue);
    if (!/^[\u4e00-\u9fa5][A-Z][A-Z0-9]{5,6}$/.test(plate)) throw new BadRequestException('车牌格式不正确');
    let cls: string;
    try { cls = normalizeVehicleClass(vehicleClass); } catch (e) { throw new BadRequestException((e as Error).message); }
    if (cls) {
      const groups = await this.ruleRepo.find({ where: { tenantId, serviceType: BusinessServiceType.PARKING_MONTHLY, enabled: true } });
      if (!groups.some((r) => ((r.config ?? {}) as ParkingRuleConfig).vehicleClass === cls)) throw new BadRequestException(`没有启用中的缴费规则分组「${cls}」`);
    }
    const row = await this.tagRepo.findOne({ where: { tenantId, plate } });
    if (!cls) { if (row) await this.tagRepo.delete({ id: row.id }); return { plate, vehicleClass: '' }; }
    if (row) { row.vehicleClass = cls; row.houseId = houseId ?? row.houseId; row.updatedBy = user.id; return this.tagRepo.save(row); }
    return this.tagRepo.save(this.tagRepo.create({ tenantId, plate, vehicleClass: cls, houseId: houseId ?? null, createdBy: user.id, updatedBy: user.id }));
  }

  /** 物业经理：待审核的非标准停车续期 */
  async listReviews(user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    const scope = scopeCommunityIds(access);
    if (scope && !scope.length) return [];
    return this.txnRepo.find({
      where: { tenantId, serviceType: BusinessServiceType.PARKING_MONTHLY, externalSyncStatus: 'review', ...(scope ? { communityId: In(scope) } : {}) },
      order: { id: 'ASC' }, take: 200,
    });
  }

  /** 审核非标准续期：通过 → 进执行队列；驳回 → 不执行，留驳回原因给前台处理 */
  async decideReview(id: number, approve: boolean, reason: string | undefined, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    const txn = await this.txnRepo.findOne({ where: { id, tenantId } });
    if (!txn) throw new NotFoundException('流水不存在');
    const scope = scopeCommunityIds(access);
    if (scope && (txn.communityId == null || !scope.includes(txn.communityId))) throw new ForbiddenException('这笔不在你的管理范围内');
    if (txn.externalSyncStatus !== 'review') throw new BadRequestException('这笔已经审核过了');
    if (txn.createdBy === user.id) throw new ForbiddenException('不能审核自己收款登记的续期，请由其他有审批权限的人处理');
    if (!approve && !reason?.trim()) throw new BadRequestException('驳回请写原因');
    const review = { ...((txn.snapshot?.review as Record<string, unknown>) || {}), decidedBy: user.id, decidedAt: new Date().toISOString(), decision: approve ? 'approved' : 'rejected', decisionReason: reason?.trim() || null };
    const exec = this.execution.initialFor(BusinessServiceType.PARKING_MONTHLY);
    // 新办车牌：金额通过了，但业主资料还没审核通过的，继续等资料
    const intakeId = (txn.snapshot?.intake as { id?: number } | undefined)?.id;
    const waitDocs = approve && intakeId ? !(await this.intakes.isApproved(intakeId, tenantId)) : false;
    const next = !approve ? 'rejected' : waitDocs ? 'awaiting_docs' : exec.status;
    const claimed = await this.txnRepo.createQueryBuilder().update(BusinessTransaction)
      .set({ externalSyncStatus: next, updatedBy: user.id, // eslint-disable-next-line @typescript-eslint/no-explicit-any
        snapshot: { ...(txn.snapshot || {}), review, ...(approve && exec.execution ? { execution: exec.execution } : {}) } as any })
      .where('id = :id AND external_sync_status = :st', { id, st: 'review' }).execute();
    if (!claimed.affected) throw new BadRequestException('这笔已经审核过了');
    await this.logRepo.save(this.logRepo.create({ tenantId, transactionId: id, action: approve ? 'review_approved' : 'review_rejected', detail: { reason: reason?.trim() || null }, createdBy: user.id, updatedBy: user.id }));
    if (txn.createdBy) {
      const plate = (txn.snapshot?.vehicle as { plateNo?: string } | undefined)?.plateNo || '';
      await this.txnRepo.manager.save(Notification, this.txnRepo.manager.create(Notification, {
        tenantId, receiverId: txn.createdBy, channel: NotifyChannel.IN_APP, eventKey: 'business.review_decided',
        title: approve ? `停车续期 ${plate} 已审核通过，系统开始续期` : `停车续期 ${plate} 被驳回：${reason?.trim()}`,
        payload: { transactionId: id, txnNo: txn.txnNo, approved: approve }, status: NotifyStatus.SENT, readAt: null, createdBy: user.id, updatedBy: user.id,
      })).catch(() => undefined);
    }
    if (approve && next === 'queued') this.execution.kick(id);
    return { id, externalSyncStatus: next };
  }

  /** 通知能审批的物业经理（按小区所属管理处收窄） */
  private async notifyReviewers(tenantId: number, communityId: number | null, title: string, payload: Record<string, unknown>, operatorId: number) {
    try {
      let ids = await this.access.userIdsWithPermission(tenantId, 'app:approve-manager', 'edit');
      const officeId = communityId ? (await this.communityRepo.findOne({ where: { id: communityId, tenantId } }))?.officeId ?? null : null;
      if (officeId) { const cover = await this.access.filterUsersCoveringOffice(tenantId, ids, officeId); ids = ids.filter((x) => cover.has(x)); }
      ids = ids.filter((x) => x !== operatorId);
      if (!ids.length) return;
      await this.txnRepo.manager.save(Notification, ids.map((receiverId) => this.txnRepo.manager.create(Notification, {
        tenantId, receiverId, channel: NotifyChannel.IN_APP, eventKey: 'business.review_requested', title, payload,
        status: NotifyStatus.SENT, readAt: null, createdBy: operatorId, updatedBy: operatorId,
      })));
    } catch { /* 通知失败不影响收款登记 */ }
  }

  /**
   * 收银台「停车缴费」：一户在各停车系统里登记的车。
   * - 德立云的场（人防车库、永南、永德、吴泾、上海新家…）在这里按房号实时查，带回车位号（cardNo）、授权车库、有效期；
   * - 本地旧库（枫桦一期/二期地面、二期大车库）要经现场助手读，前端用 roomTerm 发起 /access-card-issuance/parking/queries。
   * 每个场单独成败，一个场查不到不影响其他场。
   */
  async householdParking(houseId: number, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    const house = await this.houseRepo.findOne({ where: { id: houseId, tenantId } });
    if (!house) throw new NotFoundException('房号不存在');
    const building = await this.buildingRepo.findOne({ where: { id: house.buildingId, tenantId } });
    const community = building ? await this.communityRepo.findOne({ where: { id: building.communityId, tenantId } }) : null;
    const scope = scopeCommunityIds(access);
    if (scope && (!community || !scope.includes(community.id))) throw new ForbiddenException('该房号不在你的管理范围内');
    const strip = (v: string | null | undefined) => (v || '').trim().replace(/^0+(?=\d)/, '');
    const parts = [strip(building?.lane), strip(building?.buildingNo), strip(house.roomNo)].filter(Boolean);
    const room = parts.join('/');
    const targets = targetsForCommunity(community?.name ?? null);
    const parks = [...new Map(targets.filter((t) => t.system === 'deliyun').map((t) => [t.deliyunPark!, t])).values()];
    const deliyun = await Promise.all(parks.map(async (t) => {
      try {
        const r = await this.deliyun.findVehiclesByRoom(room, t.deliyunPark);
        return { targetKey: t.key, label: t.label, park: t.deliyunPark!, ok: true, error: null as string | null, rows: r.rows };
      } catch (e) {
        return { targetKey: t.key, label: t.label, park: t.deliyunPark!, ok: false, error: e instanceof Error ? e.message : '查询失败', rows: [] };
      }
    }));
    const localDatabases = [...new Set(targets.filter((t) => t.system === 'local').map((t) => t.database!))];
    return {
      houseId, room, communityId: community?.id ?? null, communityName: community?.name ?? null,
      targets, deliyun, localDatabases,
      /** 本地库查询词：旧库住户名里存的是 198-4-201 / 198/06/302 这类房号 */
      roomTerm: parts.length >= 2 ? parts.join('/') : null,
    };
  }

  async listRules(query: BusinessRuleQueryDto, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    await this.ensureDefaultRules(tenantId, user.id);
    await this.upgradeParkingRules(tenantId);
    const scope = scopeCommunityIds(access);
    if (scope && !scope.length) return [];
    const baseWhere = {
      tenantId,
      ...(query.serviceType ? { serviceType: query.serviceType } : {}),
    };
    // 受限角色能看到：公司通用规则（对他的小区同样生效）+ 绑定在他范围内小区的规则
    return this.ruleRepo.find({
      where: scope
        ? [
            { ...baseWhere, communityId: IsNull() },
            { ...baseWhere, communityId: In(scope) },
          ]
        : baseWhere,
      order: { serviceType: 'ASC', id: 'ASC' },
    });
  }

  async createRule(dto: UpsertBusinessRuleDto, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    this.assertRuleShape(dto);
    const communityId = await this.assertRuleCommunity(
      dto.communityId ?? null,
      tenantId,
      access,
    );
    await this.assertRuleTarget(dto, communityId, tenantId);
    await this.assertRuleUnique(dto, communityId, tenantId, null);
    const rule = this.ruleRepo.create({
      tenantId,
      serviceType: dto.serviceType,
      name: dto.name,
      communityId,
      billingUnit: dto.billingUnit,
      unitPriceCents: dto.unitPriceCents,
      config: dto.config ?? {},
      enabled: dto.enabled ?? true,
      createdBy: user.id,
      updatedBy: user.id,
    });
    return this.ruleRepo.save(rule);
  }

  async updateRule(
    id: number,
    dto: UpsertBusinessRuleDto,
    user: AuthUser,
    access?: ResolvedAccess,
  ) {
    const tenantId = this.requireTenant(user);
    this.assertRuleShape(dto);
    const rule = await this.ruleRepo.findOne({ where: { id, tenantId } });
    if (!rule) throw new NotFoundException('rule not found');
    const scope = scopeCommunityIds(access);
    // 公司通用规则改动影响全公司，受限角色不能碰；绑定小区的规则也必须在自己范围内
    if (scope && (rule.communityId == null || !scope.includes(rule.communityId))) {
      throw new ForbiddenException('该规则不在你的管理范围内，请联系全公司范围的管理员修改');
    }
    const communityId = await this.assertRuleCommunity(
      dto.communityId ?? null,
      tenantId,
      access,
    );
    await this.assertRuleTarget(dto, communityId, tenantId);
    await this.assertRuleUnique(dto, communityId, tenantId, rule.id);
    const oldGroup = ((rule.config ?? {}) as ParkingRuleConfig).vehicleClass || '';
    const newGroup = ((dto.config ?? {}) as ParkingRuleConfig).vehicleClass || '';
    Object.assign(rule, {
      serviceType: dto.serviceType,
      name: dto.name,
      communityId,
      billingUnit: dto.billingUnit,
      unitPriceCents: dto.unitPriceCents,
      config: dto.config ?? {},
      enabled: dto.enabled ?? true,
      updatedBy: user.id,
    });
    const saved = await this.ruleRepo.save(rule);
    // 分组改名：车牌跟着改（同名分组在别的小区还在用时不动，免得把那边的车也改走）
    if (dto.serviceType === BusinessServiceType.PARKING_MONTHLY && oldGroup && newGroup && oldGroup !== newGroup) {
      const still = (await this.ruleRepo.find({ where: { tenantId, serviceType: BusinessServiceType.PARKING_MONTHLY } }))
        .some((r) => ((r.config ?? {}) as ParkingRuleConfig).vehicleClass === oldGroup);
      if (!still) {
        await this.tagRepo.update({ tenantId, vehicleClass: oldGroup }, { vehicleClass: newGroup, updatedBy: user.id });
        await this.intakes.renameGroup(tenantId, oldGroup, newGroup);
      }
    }
    return saved;
  }

  /**
   * 同一小区里，同名分组的适用车库不能重叠（否则收银台不知道用哪条价格表）；
   * 默认分组同理，一个车库只能有一个默认分组。
   */
  private async assertRuleUnique(dto: UpsertBusinessRuleDto, communityId: number | null, tenantId: number, selfId: number | null) {
    if (dto.serviceType !== BusinessServiceType.PARKING_MONTHLY || dto.enabled === false) return;
    const cfg = (dto.config ?? {}) as ParkingRuleConfig;
    const same = (await this.ruleRepo.find({ where: { tenantId, serviceType: BusinessServiceType.PARKING_MONTHLY, enabled: true, communityId: communityId ?? IsNull() } }))
      .filter((r) => r.id !== selfId && targetsOverlap(((r.config ?? {}) as ParkingRuleConfig).parkingTargets, cfg.parkingTargets));
    const clash = same.find((r) => (((r.config ?? {}) as ParkingRuleConfig).vehicleClass || '') === (cfg.vehicleClass || ''));
    if (clash) throw new BadRequestException(`本小区已经有适用车库重叠的分组「${cfg.vehicleClass}」，请直接修改它或先停用`);
    const dflt = cfg.isDefault ? same.find((r) => ((r.config ?? {}) as ParkingRuleConfig).isDefault) : null;
    if (dflt) throw new BadRequestException(`本小区这些车库已经有默认分组「${((dflt.config ?? {}) as ParkingRuleConfig).vehicleClass}」，一个车库只能有一个默认分组`);
  }

  /** 旧规则（单价 + 套餐）一次性升级为缴费规则分组价格表，金额不变；幂等 */
  private async upgradeParkingRules(tenantId: number) {
    const rows = await this.ruleRepo.find({ where: { tenantId, serviceType: BusinessServiceType.PARKING_MONTHLY } });
    const changed = rows.flatMap((r) => {
      const next = upgradeToTable((r.config ?? {}) as ParkingRuleConfig, r.unitPriceCents);
      if (!next) return [];
      r.config = next as Record<string, unknown>;
      return [r];
    });
    if (changed.length) await this.ruleRepo.save(changed);
  }

  /** 删除缴费规则分组：收过款的分组只能停用（流水要能追溯当时的价格表）；分组里的车牌一并移出 */
  async deleteRule(id: number, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    const rule = await this.ruleRepo.findOne({ where: { id, tenantId } });
    if (!rule) throw new NotFoundException('分组不存在');
    await this.assertRuleCommunity(rule.communityId, tenantId, access);
    const used = await this.txnRepo.count({ where: { tenantId, ruleId: id } });
    if (used) throw new BadRequestException(`这个分组已经收过 ${used} 笔款，不能删除，可以停用`);
    const cls = ((rule.config ?? {}) as ParkingRuleConfig).vehicleClass;
    await this.ruleRepo.delete({ id, tenantId });
    const others = cls ? (await this.ruleRepo.find({ where: { tenantId, serviceType: BusinessServiceType.PARKING_MONTHLY } })).some((r) => ((r.config ?? {}) as ParkingRuleConfig).vehicleClass === cls) : true;
    if (cls && !others) await this.tagRepo.delete({ tenantId, vehicleClass: cls });
    return { ok: true };
  }

  /** 停车月租规则绑定的停车目标须存在、且适用于规则所在小区（config.parkingTarget） */
  private async assertRuleTarget(dto: UpsertBusinessRuleDto, communityId: number | null, tenantId: number) {
    const cfg = (dto.config ?? {}) as ParkingRuleConfig;
    const keys = [...new Set([...(cfg.parkingTargets ?? []), ...(cfg.parkingTarget ? [cfg.parkingTarget] : [])])];
    if (!keys.length) return;
    if (dto.serviceType !== BusinessServiceType.PARKING_MONTHLY) throw new BadRequestException('只有停车月租规则可以绑定停车目标');
    const community = communityId ? await this.communityRepo.findOne({ where: { id: communityId, tenantId } }) : null;
    for (const targetKey of keys) {
      const error = validateRuleTarget({ targetKey, communityName: community?.name ?? null });
      if (error) throw new BadRequestException(error);
    }
  }

  /** 停车目标目录（前端配置收费标准、收银台选择目标用），附带每个目标在各小区的规则 */
  parkingTargets() {
    return PARKING_TARGETS;
  }

  /** 规则绑定小区的合法性：小区须属于本公司；受限角色必须绑且只能绑自己范围内的小区 */
  private async assertRuleCommunity(
    communityId: number | null,
    tenantId: number,
    access?: ResolvedAccess,
  ): Promise<number | null> {
    if (communityId != null) {
      const community = await this.communityRepo.findOne({
        where: { id: communityId, tenantId },
      });
      if (!community) throw new BadRequestException('适用小区不存在');
    }
    const scope = scopeCommunityIds(access);
    if (scope && (communityId == null || !scope.includes(communityId))) {
      throw new ForbiddenException('受限角色只能维护绑定在自己管理范围内小区的规则');
    }
    return communityId;
  }

  async search(query: BusinessSearchDto, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    const scope = scopeCommunityIds(access);
    if (scope && !scope.length) {
      return { houses: [], vehicles: [], accessCards: [] };
    }
    const q = (query.q || '').trim();
    const houseQb = this.houseRepo
      .createQueryBuilder('h')
      .leftJoin(Building, 'b', 'b.id = h.building_id AND b.tenant_id = h.tenant_id')
      .leftJoin(Community, 'c', 'c.id = b.community_id AND c.tenant_id = b.tenant_id')
      .leftJoin(User, 'u', 'u.house_id = h.id AND u.tenant_id = h.tenant_id AND u.role = :role', {
        role: UserRole.OWNER,
      })
      .where('h.tenant_id = :tenantId', { tenantId })
      .andWhere(
        q
          ? new Brackets((sub) => {
              sub
                .where('h.room_no ILIKE :kw', { kw: `%${q}%` })
                .orWhere('b.building_no ILIKE :kw', { kw: `%${q}%` })
                .orWhere('b.lane ILIKE :kw', { kw: `%${q}%` })
                .orWhere('u.name ILIKE :kw', { kw: `%${q}%` })
                .orWhere('u.phone ILIKE :kw', { kw: `%${q}%` });
            })
          : '1=1',
      )
      .select([
        'h.id AS id',
        'h.room_no AS "roomNo"',
        'h.area_sqm AS "areaSqm"',
        'b.lane AS lane',
        'b.building_no AS "buildingNo"',
        'b.community_id AS "communityId"',
        'c.name AS "communityName"',
        'u.id AS "ownerId"',
        'u.name AS "ownerName"',
        'u.phone AS "ownerPhone"',
      ])
      .orderBy('c.id', 'ASC')
      .limit(20);
    if (scope) houseQb.andWhere('b.community_id IN (:...scope)', { scope });
    // 房产列表一律按「弄 → 号 → 室」自然序，不按建库顺序
    addNaturalOrderBy(houseQb, 'b.lane');
    addNaturalOrderBy(houseQb, 'b.building_no');
    addNaturalOrderBy(houseQb, 'h.room_no');
    const houseRows = await houseQb.getRawMany<any>();

    // 车辆/门禁卡自身没有小区字段，范围过滤通过所挂房号的小区实现
    const scopedByHouse = (qb: any, alias: string) => {
      if (!scope) return qb;
      return qb
        .innerJoin(House, 'sh', `sh.id = ${alias}.house_id AND sh.tenant_id = ${alias}.tenant_id`)
        .innerJoin(Building, 'sb', 'sb.id = sh.building_id AND sb.tenant_id = sh.tenant_id')
        .andWhere('sb.community_id IN (:...scope)', { scope });
    };
    // 按房号搜时要带出这些房子名下的车和卡（以前只按车牌/卡号过滤，按房号搜永远是空的）
    const houseIds = houseRows.map((r) => Number(r.id));
    const byHouseOrText = (qb: any, alias: string, col: string) => {
      if (!q) return qb;
      return qb.andWhere(new Brackets((sub) => {
        sub.where(`${alias}.${col} ILIKE :kw2`, { kw2: `%${q}%` });
        if (houseIds.length) sub.orWhere(`${alias}.house_id IN (:...hids)`, { hids: houseIds });
      }));
    };
    const filteredVehicles = await byHouseOrText(scopedByHouse(
      this.vehicleRepo
        .createQueryBuilder('v')
        .where('v.tenant_id = :tenantId', { tenantId }),
      'v',
    ), 'v', 'plate_no')
      .orderBy('v.id', 'DESC')
      .take(50)
      .getMany();
    const filteredCards = await byHouseOrText(scopedByHouse(
      this.cardRepo
        .createQueryBuilder('ac')
        .where('ac.tenant_id = :tenantId', { tenantId }),
      'ac',
    ), 'ac', 'card_no')
      .orderBy('ac.id', 'DESC')
      .take(100)
      .getMany();

    return {
      houses: houseRows.map((r) => ({
        id: Number(r.id),
        roomNo: r.roomNo,
        areaSqm: r.areaSqm,
        lane: r.lane,
        buildingNo: r.buildingNo,
        communityId: r.communityId != null ? Number(r.communityId) : null,
        communityName: r.communityName,
        owner: r.ownerId
          ? { id: Number(r.ownerId), name: r.ownerName, phone: r.ownerPhone }
          : null,
      })),
      vehicles: filteredVehicles,
      accessCards: filteredCards,
    };
  }

  async estimate(dto: EstimateBusinessDto, user: AuthUser) {
    const tenantId = this.requireTenant(user);
    const rule = await this.findRule(tenantId, dto.ruleId, dto.serviceType);
    if (dto.serviceType === BusinessServiceType.PARKING_MONTHLY) {
      return this.estimateParking(rule, dto, tenantId);
    }
    if (dto.serviceType === BusinessServiceType.ACCESS_CARD) {
      return this.estimateAccessCard(rule, dto);
    }
    throw new BadRequestException('unsupported service type');
  }

  async complete(dto: CompleteBusinessDto, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    const estimate = await this.estimate(dto, user);
    const rule = await this.findRule(tenantId, dto.ruleId, dto.serviceType);
    // 非标准续期：前台自定开始/结束日期并手填实收金额 → 先登记收款，等物业经理审核通过再执行
    const custom = dto.serviceType === BusinessServiceType.PARKING_MONTHLY && (dto.manualAmountCents != null || !!dto.startDate || !!dto.endDate);
    if (custom) {
      if (!dto.startDate || !dto.endDate) throw new BadRequestException('非标准续期要填开始日期和结束日期');
      if (dto.manualAmountCents == null) throw new BadRequestException('非标准续期要填实收金额');
      if (!dto.customReason?.trim()) throw new BadRequestException('请写明非标准续期的原因，供物业经理审核');
    }
    const amountCents = custom ? dto.manualAmountCents! : estimate.amountCents;
    // 新办车牌：车牌由业主扫码填写，可能还没填；资料没审核通过前收款挂「待业主资料」
    const intake = dto.intakeId && dto.serviceType === BusinessServiceType.PARKING_MONTHLY
      ? await this.intakes.claimForPayment(dto.intakeId, dto.houseId, user) : null;
    if (intake) {
      dto.plateNo = intake.plate || undefined;
      dto.currentEndDate = undefined;
    }
    // 车牌所在的缴费规则分组要和所用价格表对上：业主车不能按租客车价收，反之亦然
    if (dto.serviceType === BusinessServiceType.PARKING_MONTHLY) {
      const ruleClass = ((rule.config ?? {}) as ParkingRuleConfig).vehicleClass || '';
      const carClass = intake ? intake.row.vehicleClass
        : dto.plateNo ? (await this.tagRepo.findOne({ where: { tenantId, plate: normPlate(dto.plateNo) } }))?.vehicleClass || '' : '';
      if (ruleClass && carClass && ruleClass !== carClass) {
        throw new BadRequestException(`这辆车属于「${carClass}」分组，不能按「${ruleClass}」分组的价格收款；分组不对请先改分组`);
      }
    }
    const house = dto.houseId
      ? await this.houseRepo.findOne({ where: { id: dto.houseId, tenantId } })
      : null;
    if (dto.houseId && !house) throw new NotFoundException('house not found');

    // 房号 → 小区：落到流水上供范围过滤，同时校验经办权限与规则适用性
    let communityId: number | null = null;
    if (house) {
      const building = await this.buildingRepo.findOne({
        where: { id: house.buildingId, tenantId },
      });
      communityId = building?.communityId ?? null;
    }
    const scope = scopeCommunityIds(access);
    if (scope && (communityId == null || !scope.includes(communityId))) {
      throw new ForbiddenException('该房号不在你的管理范围内');
    }
    if (rule.communityId != null && rule.communityId !== communityId) {
      throw new BadRequestException('该收费规则不适用于所选房号的小区，请换用对应小区的规则');
    }

    let targetType: string | null = null;
    let targetId: number | null = null;
    const snapshot: Record<string, unknown> = { estimate, ruleName: rule.name };
    const exec = this.execution.initialFor(dto.serviceType);
    if (exec.execution) snapshot.execution = exec.execution;
    if (custom) {
      snapshot.review = {
        reason: dto.customReason!.trim(), requestedBy: user.id, requestedAt: new Date().toISOString(),
        startDate: estimate.startDate, endDate: estimate.endDate, manualAmountCents: amountCents, standardAmountCents: estimate.amountCents,
      };
    }

    if (dto.serviceType === BusinessServiceType.PARKING_MONTHLY) {
      if (dto.parkingSystems?.length) {
        // 只接受本小区停车目录里的系统，防止把款记到别的小区的场
        const allowed = targetsForCommunity((await this.communityRepo.findOne({ where: { id: communityId ?? -1, tenantId } }))?.name ?? null);
        for (const s of dto.parkingSystems) {
          const ok = s.kind === 'local'
            ? !!s.database && (!!s.sourceRecordId || !!intake) && allowed.some((t) => t.system === 'local' && t.database === s.database)
            : !!s.park && allowed.some((t) => t.system === 'deliyun' && t.deliyunPark === s.park);
          if (!ok) throw new BadRequestException(`「${s.label}」不属于该房号所在小区的停车系统`);
        }
        const target = findParkingTarget(rule.config?.parkingTarget);
        snapshot.parking = { plate: (dto.plateNo || '').trim().toUpperCase(), target: target?.key ?? null, systems: dto.parkingSystems, ...(intake ? { newVehicle: true } : {}) };
      }
      if (intake) {
        snapshot.intake = { id: intake.row.id };
        snapshot.vehicle = { plateNo: intake.plate || '', validUntil: estimate.endDate };
        targetType = 'vehicle_intake';
        targetId = intake.row.id;
      } else {
        const vehicle = await this.upsertVehicle(dto, tenantId, user.id, estimate.endDate);
        targetType = 'parking_vehicle';
        targetId = vehicle.id;
        snapshot.vehicle = { id: vehicle.id, plateNo: vehicle.plateNo, validUntil: vehicle.validUntil };
      }
    } else if (dto.serviceType === BusinessServiceType.ACCESS_CARD) {
      const created = await this.issueAccessCards(dto, tenantId, user.id);
      targetType = 'access_card_batch';
      targetId = created[0]?.id ?? null;
      snapshot.cards = created.map((c) => ({ id: c.id, cardNo: c.cardNo }));
    }

    const txn = await this.txnRepo.save(
      this.txnRepo.create({
        tenantId,
        txnNo: this.makeTxnNo(dto.serviceType),
        serviceType: dto.serviceType,
        status: BusinessTransactionStatus.PAID,
        ruleId: rule.id,
        communityId,
        houseId: dto.houseId ?? null,
        ownerId: dto.ownerId ?? null,
        targetType,
        targetId,
        quantity: estimate.quantity,
        startDate: estimate.startDate,
        endDate: estimate.endDate,
        amountCents,
        paymentMethod: dto.paymentMethod ?? 'cash',
        externalSyncStatus: custom ? 'review' : intake && !intake.approved ? 'awaiting_docs' : exec.status,
        invoiceStatus: 'pending',
        remark: dto.remark ?? null,
        snapshot,
        createdBy: user.id,
        updatedBy: user.id,
      }),
    );

    await this.logRepo.save([
      this.logRepo.create({
        tenantId,
        transactionId: txn.id,
        action: 'payment_confirmed',
        detail: { amountCents: txn.amountCents, paymentMethod: txn.paymentMethod },
        createdBy: user.id,
        updatedBy: user.id,
      }),
      this.logRepo.create({
        tenantId,
        transactionId: txn.id,
        action: custom ? 'review_requested' : exec.status === 'queued' ? 'external_sync_queued' : 'external_sync_reserved',
        detail: { serviceType: dto.serviceType, targetType, targetId, mode: exec.execution?.mode ?? null },
        createdBy: user.id,
        updatedBy: user.id,
      }),
      this.logRepo.create({
        tenantId,
        transactionId: txn.id,
        action: 'invoice_reserved',
        detail: { status: 'pending' },
        createdBy: user.id,
        updatedBy: user.id,
      }),
    ]);

    if (intake) await this.intakes.attachPayment(intake.row, txn, user);
    if (custom) {
      const plate = (dto.plateNo || '').trim().toUpperCase() || '新办车牌';
      await this.notifyReviewers(tenantId, communityId, `待审核：停车非标准续期 ${plate} ${estimate.startDate}~${estimate.endDate} 实收 ¥${(amountCents / 100).toFixed(2)}`,
        { transactionId: txn.id, txnNo: txn.txnNo, page: '/pending' }, user.id);
    } else if (txn.externalSyncStatus === 'queued') this.execution.kick(txn.id);
    return txn;
  }

  listTransactions(user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    const scope = scopeCommunityIds(access);
    if (scope && !scope.length) return Promise.resolve([]);
    return this.txnRepo.find({
      // 受限角色看不到 community_id 为空的历史流水（回填后仅剩没挂房号的单）
      where: scope ? { tenantId, communityId: In(scope) } : { tenantId },
      order: { id: 'DESC' },
      take: 100,
    });
  }

  private estimateParking(rule: BusinessRule, dto: EstimateBusinessDto, tenantId: number) {
    if (rule.billingUnit !== BusinessBillingUnit.MONTH) {
      throw new BadRequestException('停车月租规则必须按月计费');
    }
    const quantity = dto.months ?? this.monthsBetween(dto.startDate, dto.endDate);
    if (!quantity || quantity < 1) throw new BadRequestException('请选择缴费月数');
    let priced: { amountCents: number; breakdown: string };
    try { priced = priceRule(quantity, rule.unitPriceCents, (rule.config ?? {}) as ParkingRuleConfig); }
    catch (e) { throw new BadRequestException((e as Error).message); }
    const current = /^\d{4}-\d{2}-\d{2}/.test(dto.currentEndDate || '') ? dto.currentEndDate!.slice(0, 10) : null;
    // 续期：没到期的接着原到期日续，已过期的从今天起；结束日 = 开始 + N 月 − 1 天
    const win = dto.startDate ? null : renewalWindow({ currentEndDate: current, today: this.today(), months: quantity });
    const startDate = dto.startDate ?? win!.startDate;
    const endDate = dto.endDate ?? (win ? win.endDate : addDays(addMonthsClamped(startDate, quantity), -1));
    if (dto.startDate || dto.endDate) {
      const ok = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d);
      if (!ok(startDate) || !ok(endDate)) throw new BadRequestException('开始日期和结束日期都要填，格式 YYYY-MM-DD');
      if (endDate < startDate) throw new BadRequestException('结束日期不能早于开始日期');
    }
    return {
      serviceType: dto.serviceType,
      ruleId: rule.id,
      unitPriceCents: rule.unitPriceCents,
      quantity,
      startDate,
      endDate,
      amountCents: priced.amountCents,
      summary: `停车月租 ${quantity} 个月`,
      breakdown: priced.breakdown,
      vehicleClass: ((rule.config ?? {}) as ParkingRuleConfig).vehicleClass ?? null,
      tenantId,
    };
  }

  private estimateAccessCard(rule: BusinessRule, dto: EstimateBusinessDto) {
    if (rule.billingUnit !== BusinessBillingUnit.CARD) {
      throw new BadRequestException('门禁卡规则必须按张计费');
    }
    const quantity = dto.quantity ?? 1;
    return {
      serviceType: dto.serviceType,
      ruleId: rule.id,
      unitPriceCents: rule.unitPriceCents,
      quantity,
      startDate: null,
      endDate: null,
      amountCents: rule.unitPriceCents * quantity,
      summary: `门禁卡 ${quantity} 张`,
    };
  }

  private async upsertVehicle(
    dto: CompleteBusinessDto,
    tenantId: number,
    operatorId: number,
    validUntil: string | null,
  ) {
    if (!dto.vehicleId && !dto.plateNo) {
      throw new BadRequestException('请填写车牌号');
    }
    if (!dto.houseId) throw new BadRequestException('请选择业主房号');
    let vehicle = dto.vehicleId
      ? await this.vehicleRepo.findOne({ where: { id: dto.vehicleId, tenantId } })
      : null;
    if (!vehicle && dto.plateNo) {
      vehicle = await this.vehicleRepo.findOne({
        where: { tenantId, plateNo: dto.plateNo.toUpperCase() },
      });
    }
    if (!vehicle) {
      vehicle = this.vehicleRepo.create({
        tenantId,
        plateNo: dto.plateNo!.toUpperCase(),
        houseId: dto.houseId,
        ownerId: dto.ownerId ?? null,
        validUntil,
        externalRef: null,
        status: 'active',
        createdBy: operatorId,
        updatedBy: operatorId,
      });
    } else {
      vehicle.houseId = dto.houseId;
      vehicle.ownerId = dto.ownerId ?? vehicle.ownerId;
      vehicle.validUntil = validUntil;
      vehicle.updatedBy = operatorId;
    }
    return this.vehicleRepo.save(vehicle);
  }

  private async issueAccessCards(dto: CompleteBusinessDto, tenantId: number, operatorId: number) {
    if (!dto.houseId) throw new BadRequestException('请选择业主房号');
    const quantity = dto.quantity ?? 1;
    const rows: AccessCard[] = [];
    for (let i = 0; i < quantity; i += 1) {
      rows.push(
        this.cardRepo.create({
          tenantId,
          cardNo: `AC${Date.now()}${String(i + 1).padStart(2, '0')}`,
          houseId: dto.houseId,
          ownerId: dto.ownerId ?? null,
          cardType: 'standard',
          externalRef: null,
          status: 'active',
          createdBy: operatorId,
          updatedBy: operatorId,
        }),
      );
    }
    return this.cardRepo.save(rows);
  }

  private async findRule(tenantId: number, ruleId: number, serviceType: BusinessServiceType) {
    const rule = await this.ruleRepo.findOne({
      where: { id: ruleId, tenantId, serviceType, enabled: true },
    });
    if (!rule) throw new NotFoundException('收费规则不存在或已停用');
    return rule;
  }

  private async ensureDefaultRules(tenantId: number, operatorId: number) {
    const count = await this.ruleRepo.count({ where: { tenantId } });
    if (count > 0) return;
    await this.ruleRepo.save([
      this.ruleRepo.create({
        tenantId,
        serviceType: BusinessServiceType.PARKING_MONTHLY,
        name: '停车月租标准价',
        communityId: null,
        billingUnit: BusinessBillingUnit.MONTH,
        unitPriceCents: 15000,
        config: { invoiceItem: '停车服务费' },
        enabled: true,
        createdBy: operatorId,
        updatedBy: operatorId,
      }),
      this.ruleRepo.create({
        tenantId,
        serviceType: BusinessServiceType.ACCESS_CARD,
        name: '门禁卡标准价',
        communityId: null,
        billingUnit: BusinessBillingUnit.CARD,
        unitPriceCents: 2000,
        config: { invoiceItem: '门禁卡工本费', maxCardsPerHouse: 6 },
        enabled: true,
        createdBy: operatorId,
        updatedBy: operatorId,
      }),
    ]);
  }

  private assertRuleShape(dto: UpsertBusinessRuleDto) {
    if (
      dto.serviceType === BusinessServiceType.PARKING_MONTHLY &&
      dto.billingUnit !== BusinessBillingUnit.MONTH
    ) {
      throw new BadRequestException('停车月租必须按月计费');
    }
    if (dto.serviceType === BusinessServiceType.PARKING_MONTHLY) {
      // 缴费规则分组：分组名 + 价格表（每个可选月数一个金额）+ 适用车库 + 是否默认；规范化后再存，计价只认这一份
      const cfg = { ...(dto.config ?? {}) } as ParkingRuleConfig & Record<string, unknown>;
      try {
        cfg.vehicleClass = normalizeVehicleClass(cfg.vehicleClass) || DEFAULT_GROUP;
        cfg.tiers = normalizeTiers(cfg.tiers);
      } catch (e) { throw new BadRequestException((e as Error).message); }
      // 旧后台只传单价：按单价生成 1/2/3/6/12 个月的价格表，兼容老入口
      if (!cfg.tiers.length && dto.unitPriceCents > 0) cfg.tiers = STANDARD_MONTHS.map((m) => ({ months: m, amountCents: dto.unitPriceCents * m }));
      if (!cfg.tiers.length) throw new BadRequestException('价格表至少要有一个月数和金额');
      cfg.priceMode = 'table';
      cfg.parkingTargets = [...new Set((Array.isArray(cfg.parkingTargets) ? cfg.parkingTargets : cfg.parkingTarget ? [cfg.parkingTarget] : []).map(String).filter(Boolean))];
      // 执行层兜底只认单个 parkingTarget：只绑一个车库时才填
      if (cfg.parkingTargets.length === 1) cfg.parkingTarget = cfg.parkingTargets[0]; else delete cfg.parkingTarget;
      cfg.isDefault = !!cfg.isDefault;
      dto.config = cfg;
      dto.name = (dto.name || '').trim() || cfg.vehicleClass;
      // 单价字段保留给旧界面显示：1 个月的价格，没有就按最短档折算
      const one = cfg.tiers.find((t) => t.months === 1) ?? cfg.tiers[0];
      dto.unitPriceCents = Math.round(one.amountCents / one.months);
    }
    if (
      dto.serviceType === BusinessServiceType.ACCESS_CARD &&
      dto.billingUnit !== BusinessBillingUnit.CARD
    ) {
      throw new BadRequestException('门禁卡必须按张计费');
    }
  }

  private monthsBetween(start?: string, end?: string): number {
    if (!start || !end) return 0;
    const a = new Date(start);
    const b = new Date(end);
    if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime()) || b < a) return 0;
    const days = Math.round((b.getTime() - a.getTime()) / 86400000) + 1; // 起止都算在内
    return Math.max(1, Math.ceil(days / 31));
  }

  private addMonths(date: string, months: number): string {
    const d = new Date(`${date}T00:00:00+08:00`);
    d.setMonth(d.getMonth() + months);
    return d.toISOString().slice(0, 10);
  }

  private today(): string {
    return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  }

  private makeTxnNo(serviceType: BusinessServiceType): string {
    const prefix = serviceType === BusinessServiceType.PARKING_MONTHLY ? 'PK' : 'AC';
    const stamp = new Date(Date.now() + 8 * 3600000)
      .toISOString()
      .replace(/\D/g, '')
      .slice(0, 14);
    return `${prefix}${stamp}${Math.floor(Math.random() * 9000 + 1000)}`;
  }

  private requireTenant(user: AuthUser): number {
    if (!user.tenantId) {
      throw new ForbiddenException('tenant scope is required');
    }
    return user.tenantId;
  }
}

function normPlate(p: string) {
  return String(p || '').replace(/[\s·.．・-]/g, '').toUpperCase();
}
