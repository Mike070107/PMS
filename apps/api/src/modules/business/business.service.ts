import { resolveAddressForTenant } from '../../common/address-lookup';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, EntityManager, In, IsNull, Not, Repository } from 'typeorm';
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
  Unit,
  Community,
  House,
  ParkingVehicle,
  ParkingQuery,
  ParkingOperation,
  VehicleIntake,
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
import { DEFAULT_GROUP, STANDARD_MONTHS, MissingParkingPriceError, normalizeTiers, normalizeVehicleClass, priceRule, targetsOverlap, upgradeToTable, type ParkingRuleConfig } from './parking-pricing';
import { Notification } from '../../entities';
import { NotifyChannel, NotifyStatus } from '../../common/enums';
import { DeliyunParkingService } from '../access-card-issuance/deliyun-parking.service';
import { ParkingSpace, PARKING_SPACE_CATEGORIES } from '../../entities/parking-space.entity';
import { expiredDraftSql } from './vehicle-draft-expiry';
import { mainSpaceFromQuery, type PropertySpaceRef } from './property-space-ledger';
import { UpdateParkingSpaceDto } from './parking-space.dto';
import { collectionDaySql, collectionTimeTextSql } from './collection-date';
import { parkingExactFieldValue } from '../access-card-issuance/parking-query-history';
import { parkingPlateFromFields } from '../access-card-issuance/parking-query.util';
import { supersededParkingPlates } from '../access-card-issuance/parking-plate-billing';

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
    @InjectRepository(ParkingSpace)
    private readonly spaceRepo: Repository<ParkingSpace>,
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
    // 入口校验审批权限，本方法校验小区范围，并记录登记人与审批人是否相同。
    const selfApproval = txn.createdBy === user.id;
    if (!approve && !reason?.trim()) throw new BadRequestException('驳回请写原因');
    const review: Record<string, unknown> = { ...((txn.snapshot?.review as Record<string, unknown>) || {}), decidedBy: user.id, decidedAt: new Date().toISOString(), decision: approve ? 'approved' : 'rejected', decisionReason: reason?.trim() || null, selfApproval };
    const exec = this.execution.initialFor(BusinessServiceType.PARKING_MONTHLY);
    // 新办车牌：金额通过了，但业主资料还没审核通过的，继续等资料
    const intakeId = (txn.snapshot?.intake as { id?: number } | undefined)?.id;
    if (intakeId) {
      const current = await this.intakes.dataVersionOf(intakeId, tenantId);
      const quoted = (txn.snapshot?.intake as { dataVersion?: number } | undefined)?.dataVersion;
      if (approve && (txn.snapshot?.intake as {homeUpload?:boolean}).homeUpload && !(await this.intakes.isApproved(intakeId, tenantId))) throw new BadRequestException('请先等待办公室审核补交资料，再审核金额');
      if (approve && quoted !== undefined && current !== null && current !== quoted && (txn.snapshot?.review as { manualAmountCents?: unknown } | undefined)?.manualAmountCents !== undefined) {
        throw new BadRequestException('登记资料已更新（含非标准金额依据），请让前台按最新资料重新登记；原报价审批不能直接执行');
      }
      if (approve && current !== null) review.approvedIntakeVersion = current;
    }
    const waitDocs = approve && intakeId ? !(await this.intakes.isApproved(intakeId, tenantId)) : false;
    const next = !approve ? 'rejected' : waitDocs ? 'awaiting_docs' : exec.status;
    const claimed = await this.txnRepo.createQueryBuilder().update(BusinessTransaction)
      .set({ externalSyncStatus: next, updatedBy: user.id, // eslint-disable-next-line @typescript-eslint/no-explicit-any
        snapshot: { ...(txn.snapshot || {}), review, ...(approve && exec.execution ? { execution: exec.execution } : {}) } as any })
      .where('id = :id AND external_sync_status = :st', { id, st: 'review' }).execute();
    if (!claimed.affected) throw new BadRequestException('这笔已经审核过了');
    await this.logRepo.save(this.logRepo.create({ tenantId, transactionId: id, action: approve ? 'review_approved' : 'review_rejected', detail: { reason: reason?.trim() || null, selfApproval }, createdBy: user.id, updatedBy: user.id }));
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
      // 收费类经理审核：新 key 与拆分前的旧 key 任一命中都算（旧授权不能失效）
      const managerIdSets = await Promise.all(
        ['app:approve-business-manager', 'app:approve-manager'].map((key) =>
          this.access.userIdsWithPermission(tenantId, key, 'edit'),
        ),
      );
      let ids = [...new Set(managerIdSets.flat())];
      const officeId = communityId ? (await this.communityRepo.findOne({ where: { id: communityId, tenantId } }))?.officeId ?? null : null;
      if (officeId) { const cover = await this.access.filterUsersCoveringOffice(tenantId, ids, officeId); ids = ids.filter((x) => cover.has(x)); }
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
  private async boundPropertySpaces(tenantId:number, houseId:number, communityIds:number[], plates:string[]) {
    if (!communityIds.length) return [];
    const rows: Array<{plate:string; garage:'main'|'civil'; spaceNo:string}> = await this.houseRepo.manager.connection.query(
      `SELECT DISTINCT linked.plate, s.garage, s.space_no AS "spaceNo" FROM parking_spaces s
       CROSS JOIN LATERAL (
         SELECT upper(regexp_replace(key, '[[:space:]·.．・-]', '', 'g')) AS plate
         FROM jsonb_each(s.vehicle_bindings)
         WHERE value->>'houseId' = $3::text OR upper(regexp_replace(key, '[[:space:]·.．・-]', '', 'g')) = ANY($4::text[])
         UNION SELECT token FROM (
           SELECT upper(regexp_replace(part, '[·.．・-]', '', 'g')) AS token
           FROM regexp_split_to_table(coalesce(s.plate,''), '[[:space:]/,，、;；]+') AS part
         ) imported WHERE token = ANY($4::text[])
       ) linked WHERE s.tenant_id = $1 AND s.community_id = ANY($2::int[])`,
      [tenantId,communityIds,String(houseId),plates]);
    return rows;
  }

  private async roomPropertySpaces(tenantId: number, houseId: number, communityIds: number[]) {
    if (!communityIds.length) return [];
    const house = await this.houseRepo.findOne({ where: { id: houseId, tenantId }, relations: { building: true, unit: true } });
    if (!house?.building || !communityIds.includes(house.building.communityId)) return [];
    const normalize = (value: string) => (value.match(/\d+/g) ?? []).map(Number).join('/');
    const short = normalize([house.building.buildingNo, house.unit?.unitNo, house.roomNo].filter(Boolean).join('/'));
    const full = normalize([house.building.lane, short].filter(Boolean).join('/'));
    const cards = await this.spaceRepo.findBy({ tenantId, communityId: In(communityIds) });
    return cards.filter(card => {
      const room = normalize(card.houseNo || '');
      return !!room && (room === full || (card.communityId === house.building.communityId && room === short));
    });
  }

  async householdPlateSpaces(houseId:number, plates:string[], user:AuthUser, access?:ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    const house = await this.houseRepo.findOne({where:{id:houseId, tenantId}, relations:{building:{community:true}}});
    if (!house) throw new NotFoundException('房号不存在');
    const scope = scopeCommunityIds(access);
    const community = house.building?.community;
    if (!community || (scope && !scope.includes(community.id))) throw new ForbiddenException('该房号不在你的管理范围内');
    const target = targetsForCommunity(community.name).find(t => t.key === 'local:phase2_main_garage');
    if (!target) return [];
    const communities = await this.communityRepo.findBy({tenantId, name:In(target.communities)});
    const ids = communities.map(c => c.id).filter(id => !scope || scope.includes(id));
    const normalized = [...new Set(plates.map(normPlate).filter(Boolean))];
    const [direct, byRoom] = await Promise.all([
      this.boundPropertySpaces(tenantId, houseId, ids, normalized),
      this.roomPropertySpaces(tenantId, houseId, ids),
    ]);
    return [...direct, ...normalized.flatMap(plate => byRoom
      .filter(card => !direct.some(row => normPlate(row.plate) === plate && row.garage === card.garage))
      .map(card => ({ plate, garage: card.garage, spaceNo: card.spaceNo })))];
  }

  async householdParking(houseId: number, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    const house = await this.houseRepo.findOne({ where: { id: houseId, tenantId }, relations: { unit: true } });
    if (!house) throw new NotFoundException('房号不存在');
    const building = await this.buildingRepo.findOne({ where: { id: house.buildingId, tenantId } });
    const community = building ? await this.communityRepo.findOne({ where: { id: building.communityId, tenantId } }) : null;
    const scope = scopeCommunityIds(access);
    if (scope && (!community || !scope.includes(community.id))) throw new ForbiddenException('该房号不在你的管理范围内');
    const strip = (v: string | null | undefined) => (v || '').trim().replace(/^0+(?=\d)/, '');
    const parts = [strip(building?.lane), strip(building?.buildingNo), strip(house.unit?.unitNo), strip(house.roomNo)].filter(Boolean);
    const room = parts.join('/');
    const targets = targetsForCommunity(community?.name ?? null);
    const vehicles = await this.vehicleRepo.find({
      where: { tenantId, houseId, status: 'active' }, select: { plateNo: true },
    });
    const boundPlates = vehicles.map(vehicle => normPlate(vehicle.plateNo)).filter(Boolean);
    const changed = boundPlates.length
      ? await this.vehicleRepo.manager.getRepository(ParkingOperation).createQueryBuilder('task')
        .where("task.tenant_id = :tenantId AND task.kind IN ('change_plate', 'delete_vehicle') AND task.status = 'completed'", { tenantId })
        .andWhere("task.payload->>'plate' IN (:...boundPlates)", { boundPlates })
        .getMany() : [];
    const parks = [...new Map(targets.filter((t) => t.system === 'deliyun').map((t) => [t.deliyunPark!, t])).values()];
    const deliyun = await Promise.all(parks.map(async (t) => {
      try {
        const r = await this.deliyun.findVehiclesByRoom(room, t.deliyunPark);
        return { targetKey: t.key, label: t.label, park: t.deliyunPark!, ok: true, error: null as string | null, rows: r.rows };
      } catch (e) {
        return { targetKey: t.key, label: t.label, park: t.deliyunPark!, ok: false, error: e instanceof Error ? e.message : '查询失败', rows: [] };
      }
    }));
    const basement = targets.find(t=>t.key === 'local:phase2_main_garage');
    const sharedCommunities = basement ? await this.communityRepo.findBy({tenantId,name:In(basement.communities)}) : [];
    const propertySpaces = await this.boundPropertySpaces(tenantId,houseId,sharedCommunities.map(c=>c.id).filter(id=>!scope || scope.includes(id)),vehicles.map(v=>normPlate(v.plateNo)));
    const localDatabases = [...new Set(targets.filter((t) => t.system === 'local').map((t) => t.database!))];
    return {
      houseId, room, communityId: community?.id ?? null, communityName: community?.name ?? null,
      targets, deliyun, localDatabases, propertySpaces, boundPlates, supersededPlates: supersededParkingPlates(changed),
      /** 本地库查询词：旧库住户名里存的是 198-4-201 / 198/06/302 这类房号 */
      roomTerm: parts.length >= 2 ? parts.join('/') : null,
    };
  }



  /** 编辑本地车位：只覆盖传入字段，独立类别不触发车辆解绑或续期。 */
  async updateParkingSpace(id: number, dto: UpdateParkingSpaceDto, user: AuthUser, access: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    if (!access) throw new ForbiddenException('缺少车位访问范围');
    const scope = scopeCommunityIds(access);
    if (scope && !scope.length) throw new NotFoundException('车位不存在');
    if (!Number.isSafeInteger(id) || id < 1 || id > 2147483647) throw new BadRequestException('车位编号必须为有效的正整数');
    const row = await this.spaceRepo.findOne({ where: { id, tenantId, ...(scope ? { communityId: In(scope) } : {}) } });
    if (!row) throw new NotFoundException('车位不存在');
    // 同时约束非HTTP调用；在任何行内字段修改前拒绝非法类别。
    if (dto.category !== undefined && dto.category !== null &&
      !PARKING_SPACE_CATEGORIES.includes(dto.category)) {
      throw new BadRequestException('车位类别必须为 property、rental、vacant 或 null');
    }
    if (dto.category !== undefined) row.category = dto.category;
    const clean = (v?: string) => (v === undefined ? undefined : (v.trim() === '' ? null : v.trim()));
    const plate = clean(dto.plate);
    if (plate !== undefined) row.plate = plate ? plate.toUpperCase().replace(/\s/g, '') : null;
    const houseNo = clean(dto.houseNo); if (houseNo !== undefined) row.houseNo = houseNo;
    const ownerName = clean(dto.ownerName); if (ownerName !== undefined) row.ownerName = ownerName;
    const ownerTel = clean(dto.ownerTel);
    // 多个电话统一用 / 分隔（现场常写成 ，、; 或空格）
    if (ownerTel !== undefined) row.ownerTel = ownerTel ? ownerTel.split(/[\/,，、;；\s]+/).filter(Boolean).join('/') : null;
    const note = clean(dto.note); if (note !== undefined) row.note = note;
    const area = clean(dto.areaSqm); if (area !== undefined) row.areaSqm = area;
    const end = clean(dto.endDate); if (end !== undefined) row.endDate = end;
    row.updatedBy = user.id;
    await this.spaceRepo.save(row);
    return { id: row.id, communityId: row.communityId ?? null, category: row.category ?? null, plate: row.plate, houseNo: row.houseNo, ownerName: row.ownerName, ownerTel: row.ownerTel, note: row.note, areaSqm: row.areaSqm, endDate: row.endDate };
  }
  /** 车位清单：大车库 / 人防车库。按车位号自然序，可按车位号或车牌搜。 */
  async listParkingSpaces(garage: string | undefined, q: string | undefined, user: AuthUser, access: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    if (!access) throw new ForbiddenException('缺少车位访问范围');
    const scope = scopeCommunityIds(access);
    if (scope && !scope.length) return { rows: [], total: 0, bound: 0 };
    const g = garage === 'civil' || garage === 'main' ? garage : undefined;
    const qb = this.spaceRepo.createQueryBuilder('s').addSelect('s.vehicleBindings').where('s.tenant_id = :tenantId', { tenantId });
    if (scope) qb.andWhere('s.community_id IN (:...scope)', { scope });
    if (g) qb.andWhere('s.garage = :g', { g });
    const kw = (q ?? '').trim();
    if (kw) qb.andWhere('(s.spaceNo ILIKE :kw OR s.plate ILIKE :kw OR s.houseNo ILIKE :kw OR CAST(s.vehicleBindings AS text) ILIKE :kw)', { kw: `%${kw}%` });
    // 车位号按数字自然序（1,2,3…10,100），字符串序会排成 1,10,100,101
    qb.orderBy('s.garage', 'ASC');
    addNaturalOrderBy(qb, 's.spaceNo');
    const rows = await qb.getMany();
    return {
      rows: rows.map((r) => ({
        id: r.id, communityId: r.communityId ?? null, category: r.category ?? null, garage: r.garage, spaceNo: r.spaceNo, houseNo: r.houseNo,
        vehicleBindings: r.vehicleBindings ?? {}, areaSqm: r.areaSqm, plate: r.plate, ownerName: r.ownerName, ownerTel: r.ownerTel,
        note: r.note, source: r.source, endDate: r.endDate,
      })),
      total: rows.length,
      bound: rows.filter((r) => r.plate && r.plate.trim()).length,
    };
  }
  /** 收费模块使用的小区名称目录；不依赖房产页面权限，也不返回住户资料。 */
  async feeCommunities(user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    if (!access) throw new ForbiddenException('缺少数据范围授权');
    const scope = scopeCommunityIds(access);
    if (scope && !scope.length) return [];
    const rows = await this.communityRepo.find({ where: { tenantId, ...(scope ? { id: In(scope) } : {}) }, select: ['id', 'name'], order: { id: 'ASC' } });
    return rows.filter(row => !scope || scope.includes(row.id));
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
    // 车牌登记保留每辆车自己的联系人。同户业主电话仍取自 users。
    const registrationMatches: Array<{ id: number; plateNo: string; houseId: number; contactPhone: string; openIntakeId: number | null }> =
      query.serviceType === BusinessServiceType.PARKING_MONTHLY && /^\d{4,11}$/.test(q)
        ? await this.houseRepo.manager.connection.query(
          `SELECT id, plate AS "plateNo", house_id AS "houseId", contact_phone AS "contactPhone",
                  CASE WHEN kind = 'family' OR transaction_id IS NULL THEN id END AS "openIntakeId"
           FROM (
             SELECT DISTINCT ON (i.house_id, upper(trim(i.plate))) i.id, upper(trim(i.plate)) AS plate,
                    i.house_id, i.contact_phone, i.kind, i.transaction_id
             FROM vehicle_intakes i
             JOIN houses h ON h.id = i.house_id AND h.tenant_id = i.tenant_id
             JOIN buildings b ON b.id = h.building_id AND b.tenant_id = h.tenant_id
             WHERE i.tenant_id = $1 AND i.status <> 'void' AND NOT ${expiredDraftSql('i')} AND trim(i.plate) <> ''
               AND (i.community_id IS NULL OR i.community_id = b.community_id)
               ${scope ? 'AND b.community_id = ANY($3::int[])' : ''}
             ORDER BY i.house_id, upper(trim(i.plate)), i.id DESC
           ) latest WHERE contact_phone LIKE $2 ORDER BY id DESC`,
          scope ? [tenantId, '%' + q, scope] : [tenantId, '%' + q]) : [];
    // 认得出是地址就按房精准查（198/20/601、一期20号601、枫桦景苑一期20号楼…），姓名电话照常模糊
    const addr = await resolveAddressForTenant(this.houseRepo.manager.connection, tenantId, q);
    const houseQb = this.houseRepo
      .createQueryBuilder('h')
      .leftJoin(Building, 'b', 'b.id = h.building_id AND b.tenant_id = h.tenant_id')
      .leftJoin(Unit, 'un', 'un.id = h.unit_id AND un.tenant_id = h.tenant_id AND un.building_id = b.id')
      .leftJoin(Community, 'c', 'c.id = b.community_id AND c.tenant_id = b.tenant_id')
      .leftJoin(User, 'u', 'u.house_id = h.id AND u.tenant_id = h.tenant_id AND u.role = :role', {
        role: UserRole.OWNER,
      })
      .where('h.tenant_id = :tenantId', { tenantId })
      .andWhere(
        q
          ? new Brackets((sub) => {
              if (addr) {
                sub.where(addr.allHouseIds.length ? 'h.id IN (:...addrHouseIds)' : '1=0', { addrHouseIds: addr.allHouseIds })
                  .orWhere('u.name ILIKE :kw', { kw: `%${q}%` });
              } else sub
                .where('h.room_no ILIKE :kw', { kw: `%${q}%` })
                .orWhere('b.building_no ILIKE :kw', { kw: `%${q}%` })
                .orWhere('b.lane ILIKE :kw', { kw: `%${q}%` })
                .orWhere('u.name ILIKE :kw', { kw: `%${q}%` })
                .orWhere('u.phone ILIKE :kw', { kw: `%${q}%` })
                .orWhere('EXISTS (SELECT 1 FROM parking_vehicles pv WHERE pv.tenant_id = h.tenant_id AND pv.house_id = h.id AND pv.plate_no ILIKE :kw)', { kw: `%${q}%` });
              if (registrationMatches.length) sub.orWhere('h.id IN (:...registeredHouses)', {
                registeredHouses: [...new Set(registrationMatches.map(row => row.houseId))],
              });
              if (addr && /^\d{4,11}$/.test(q)) sub.orWhere('u.phone ILIKE :ownerPhone', { ownerPhone: '%' + q + '%' });
              // 同一份房产字段支持商铺、公寓、普通房屋的连续或分隔地址。
              sub.orWhere("concat(b.building_no,un.unit_no,h.room_no) = :addressKey OR concat_ws('/',nullif(b.lane,''),b.building_no,un.unit_no,h.room_no) = :addressKey OR concat_ws('/',b.building_no,un.unit_no,h.room_no) = :addressKey", { addressKey: q.replace(/\s+/g, '').replace(/／/g, '/') });
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
        .where('ac.tenant_id = :tenantId AND ac.house_id IS NOT NULL', { tenantId }),
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
      registrationMatches,
      vehicles: filteredVehicles,
      accessCards: filteredCards,
    };
  }

  async estimate(dto: EstimateBusinessDto, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    const collectionDate = this.validateCollectionDate(dto);
    const rule = await this.findRule(tenantId, dto.ruleId, dto.serviceType);
    if (dto.serviceType === BusinessServiceType.PARKING_MONTHLY) {
      const quote = this.estimateParking(rule, dto, tenantId);
      const plate = normPlate(dto.plateNo || '');
      if (!access || !/^[\u4e00-\u9fff][A-Z][A-Z0-9]{5,6}$/.test(plate)) return quote;
      const recordedPaymentsToday = await this.parkingPaymentsOn(tenantId, plate, scopeCommunityIds(access), collectionDate ?? this.today()).catch(() => null);
      return { ...quote, recordedPaymentsToday };
    }
    if (dto.serviceType === BusinessServiceType.ACCESS_CARD) {
      return this.estimateAccessCard(rule, dto);
    }
    throw new BadRequestException('unsupported service type');
  }

  private validateCollectionDate(dto: EstimateBusinessDto & { intakeId?: number }) {
    const day = dto.collectionDate;
    if (day == null) return undefined;
    if (dto.serviceType !== BusinessServiceType.PARKING_MONTHLY)
      throw new BadRequestException('仅停车收费可选择收费日期');
    const parsed = new Date(`${day}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day.startsWith('0000') || !Number.isFinite(parsed.getTime()) ||
        parsed.toISOString().slice(0, 10) !== day || day > this.today())
      throw new BadRequestException('收费日期须为有效日期且不能晚于今天');
    return day;
  }

  private parkingPaymentsOn(tenantId: number, plate: string, scope: number[] | null, day: string) {
    return this.txnRepo.query<{
      txnNo: string; paidAt: string; amountCents: number; startDate: string | null; endDate: string | null;
    }[]>(`
      SELECT txn_no AS "txnNo", ${collectionTimeTextSql('t', 'HH24:MI:SS')} AS "paidAt",
        amount_cents AS "amountCents", start_date::text AS "startDate", end_date::text AS "endDate"
      FROM business_transactions t
      WHERE tenant_id = $1 AND service_type = 'parking_monthly' AND status = 'paid' AND amount_cents > 0
        AND NOT (snapshot ? 'reversedByTxnNo')
        AND ($2::int[] IS NULL OR community_id = ANY($2::int[]))
        AND ${collectionDaySql('t')} = $3
        AND UPPER(regexp_replace(COALESCE(NULLIF(snapshot#>>'{parking,plate}', ''), snapshot#>>'{vehicle,plateNo}'),
          '[[:space:]·.．・-]', '', 'g')) = $4
      ORDER BY created_at DESC, id DESC
    `, [tenantId, scope, day, plate]);
  }

  async complete(dto: CompleteBusinessDto, user: AuthUser, access?: ResolvedAccess) {
    this.validateCollectionDate(dto);
    if (dto.shopBuildingId != null && (!dto.intakeId || dto.houseId != null || dto.serviceType !== BusinessServiceType.PARKING_MONTHLY))
      throw new BadRequestException('商铺新车收费须关联原商铺登记');
    let existing = false;
    const plateOnly = dto.serviceType === BusinessServiceType.PARKING_MONTHLY && dto.houseId == null && !dto.intakeId;
    const txn = plateOnly ? await this.txnRepo.manager.transaction(async manager => {
      const tenantId = this.requireTenant(user);
      const plate = normPlate(dto.plateNo || '');
      await manager.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [`parking-payment:${tenantId}`, plate]);
      const context = await this.plateRenewalContext(dto, user, access, manager);
      const repo = manager.getRepository(BusinessTransaction);
      const previous = await repo.findOneBy({ tenantId, txnNo: context.txnNo });
      if (previous) {
        if (previous.snapshot.plateRenewalSignature !== context.signature || previous.status !== BusinessTransactionStatus.PAID)
          throw new BadRequestException('本次车牌查询已有收款记录，请先核对办理记录');
        existing = true;
        return previous;
      }
      const pending = await repo.createQueryBuilder('t').where('t.tenant_id = :tenantId', { tenantId })
        .andWhere('t.target_type = :targetType AND t.status = :paid', { targetType: 'parking_plate', paid: BusinessTransactionStatus.PAID })
        .andWhere("t.snapshot->'vehicle'->>'plateNo' = :plate", { plate })
        .andWhere("t.external_sync_status <> 'synced'").getCount();
      if (pending) throw new BadRequestException('该车牌有已收款、尚未完成的续期，请先在办理记录核对，避免重复收费');
      const service: BusinessService = Object.assign(Object.create(this), {
        txnRepo: repo, logRepo: manager.getRepository(BusinessLog),
      });
      return service.completePayment(dto, user, access, manager, context);
    }) : dto.intakeId && dto.serviceType === BusinessServiceType.PARKING_MONTHLY
      ? await this.intakes.withPaymentTransaction(dto.intakeId, user, access, async (manager) => {
        // Only the intake path changes: create money + audit + attachment atomically under its row lock.
        const service: BusinessService = Object.assign(Object.create(this), {
          txnRepo: manager.getRepository(BusinessTransaction), logRepo: manager.getRepository(BusinessLog),
        });
        return service.completePayment(dto, user, access, manager);
      })
      : await this.completePayment(dto, user, access);
    if (existing) return txn;
    // External execution must not observe or act on uncommitted money/attachment.
    if (txn.externalSyncStatus === 'review') {
      const plate = (dto.plateNo || '').trim().toUpperCase() || '新办车牌';
      await this.notifyReviewers(txn.tenantId, txn.communityId, `待审核：停车非标准续期 ${plate} ${txn.startDate}~${txn.endDate} 实收 ¥${(txn.amountCents / 100).toFixed(2)}`,
        { transactionId: txn.id, txnNo: txn.txnNo, page: '/pending' }, user.id);
    } else if (txn.externalSyncStatus === 'queued') this.execution.kick(txn.id);
    return txn;
  }

  private async plateRenewalContext(dto: CompleteBusinessDto, user: AuthUser, access: ResolvedAccess | undefined, manager: EntityManager) {
    const tenantId = this.requireTenant(user);
    const plate = normPlate(dto.plateNo || '');
    if (!access || dto.ownerId != null || dto.vehicleId != null || !/^[\u4e00-\u9fff][A-Z][A-Z0-9]{5,6}$/.test(plate))
      throw new BadRequestException('请按完整车牌查询现场车辆后办理');
    const systems = dto.parkingSystems ?? [];
    const queryId = systems[0]?.queryId;
    if (!queryId || dto.expectedAmountCents == null ||
        systems.some(sys => sys.kind !== 'local' || !sys.database || sys.queryId !== queryId) ||
        new Set(systems.map(sys => sys.database)).size !== systems.length)
      throw new BadRequestException('请重新查询车牌，并选择要续期的现场停车库');
    const query = await manager.getRepository(ParkingQuery).findOneBy({
      id: queryId, tenantId, queryKind: 'vehicle', status: 'completed', createdBy: user.id, term: plate,
    });
    if (!query?.completedAt) throw new BadRequestException('现场车辆查询不可用，请重新查询车牌');
    const rule = await this.findRule(tenantId, dto.ruleId, dto.serviceType);
    const allowedNames = PARKING_TARGETS.filter(target => target.system === 'local' && target.database === systems[0].database)
      .flatMap(target => target.communities);
    const phase = systems.some(sys => sys.database === 'parking1') ? '一期' : '二期';
    const communities = (await this.communityRepo.findBy({ tenantId, name: In([...new Set(allowedNames)]) }));
    const scope = scopeCommunityIds(access);
    const permitted = communities.filter(community => !scope || scope.includes(community.id));
    const choices = rule.communityId != null ? permitted.filter(community => community.id === rule.communityId)
      : permitted.length === 1 ? permitted : permitted.filter(community => community.name.endsWith(phase));
    if (choices.length !== 1) throw new ForbiddenException('当前收费规则或现场停车库不在可办理的小区范围');
    const selectedKeys = new Set<string>();
    const selected = systems.map(sys => {
      const rows = query.rows.filter(row => row.database === sys.database && parkingPlateFromFields(row.fields) === plate);
      if (rows.length !== 1 || parkingExactFieldValue(rows[0].fields, ['P_id']) !== sys.sourceRecordId ||
          !/^[1-9]\d*$/.test(sys.sourceRecordId || ''))
        throw new BadRequestException('所选停车库里的车牌档案不唯一或已变化，请刷新后核对车辆');
      const row = rows[0];
      const rawEnd = parkingExactFieldValue(row.fields, ['End_Time', 'EndDate', 'ExpireDate']);
      const previousEndDate = /^\d{4}-\d{2}-\d{2}/.test(rawEnd || '') ? rawEnd!.slice(0, 10) : null;
      const effective = parkingExactFieldValue(row.fields, ['P_Effective']) ?? '';
      const available = sys.database === 'parking1' ? ['local:phase1_parking']
        : [([9, 11, 13].some(channel => effective[channel - 1] === '1') ? 'local:phase2_parking' : null),
          ([15, 17, 19, 21].some(channel => effective[channel - 1] === '1') ? 'local:phase2_main_garage' : null)]
          .filter((key): key is string => key !== null);
      if (!available.length) available.push('local:phase2_parking');
      const target = findParkingTarget(sys.targetKey);
      if (!target || !available.includes(target.key)) throw new BadRequestException('停车库授权与所选收费车库不一致');
      available.forEach(key => selectedKeys.add(key));
      return { ...sys, label: target.short ?? target.label, previousEndDate };
    });
    const config = rule.config as ParkingRuleConfig | null;
    const ruleTargets = config?.parkingTargets ?? (config?.parkingTarget ? [config.parkingTarget] : []);
    if (ruleTargets.length && !ruleTargets.some(key => selectedKeys.has(key)))
      throw new BadRequestException('该收费标准不适用于所选停车车库');
    const signature = JSON.stringify([dto.ruleId, dto.months, dto.startDate, dto.endDate, dto.manualAmountCents, dto.customReason,
      dto.expectedAmountCents, dto.paymentMethod, dto.confirmedVehicleClass, dto.legacyStartDate,
      selected.map(sys => [sys.database, sys.sourceRecordId, sys.targetKey]).sort(), ...(dto.collectionDate ? [dto.collectionDate] : [])]);
    const txnNo = `PKPL-${queryId}`;
    const age = Date.now() - query.completedAt.getTime();
    if (age < 0 || age > 10 * 60_000) {
      const previous = await manager.getRepository(BusinessTransaction).findOneBy({ tenantId, txnNo });
      if (!previous) throw new BadRequestException('现场查询已超过 10 分钟，请重新查询车牌后再收费');
    }
    dto.plateNo = plate;
    dto.parkingSystems = selected;
    dto.currentEndDate = selected.flatMap(system => system.previousEndDate ? [system.previousEndDate] : []).sort().at(-1);
    return { communityId: choices[0].id, txnNo, signature };
  }

  private async propertySpaceRefs(dto: CompleteBusinessDto, tenantId: number, communityId: number,
    scope: number[] | null, intake?: { garages: string[]; garageNumbers: Record<string,string> }) {
    const houseCommunity = await this.communityRepo.findOneBy({id:communityId,tenantId});
    const targets = targetsForCommunity(houseCommunity?.name ?? '');
    const plate = normPlate(dto.plateNo || '');
    const numbers = new Map<'main' | 'civil', string>();
    let ambiguousMain = false;
    if (intake) {
      if (intake.garages.includes('local:phase2_main_garage')) numbers.set('main', intake.garageNumbers.main);
      if (intake.garages.includes('deliyun:枫桦景苑')) numbers.set('civil', intake.garageNumbers.civil);
    } else {
      for (const sys of dto.parkingSystems ?? []) {
        if (sys.kind === 'local' && sys.database === 'parking2') {
          const repo = this.houseRepo.manager.getRepository(ParkingQuery);
          const query = await repo.findOne({where:{tenantId,status:'completed',queryKind:'vehicle',
            ...(sys.queryId ? {id:sys.queryId} : {term:plate})},order:{id:'DESC'}});
          if (!query || ambiguousMain) continue;
          const no = mainSpaceFromQuery(query.rows,plate,sys.sourceRecordId || '');
          if (no !== null && numbers.has('main') && numbers.get('main') !== no) {
            ambiguousMain = true;
            numbers.delete('main');
            continue;
          }
          if (no !== null) numbers.set('main',no);
        } else if (sys.kind === 'deliyun' && sys.park === '枫桦景苑') {
          const results = await this.deliyun.findVehiclesByPlate(plate,sys.park).catch(() => null);
          const exact = (results?.rows ?? []).filter(r => normPlate(r.plate) === plate && r.civilDefenseAuthorized);
          if (exact.length !== 1) continue;
          numbers.set('civil',exact[0].cardNo?.trim() || '');
        }
      }
    }
    if (intake && !numbers.size) throw new BadRequestException('产权车须选定大车库或人防车位后再收费');
    const refs: PropertySpaceRef[] = [];
    for (const [garage,spaceNo] of numbers) {
      const key = garage === 'main' ? 'local:phase2_main_garage' : 'deliyun:枫桦景苑';
      const target = targets.find(t => t.key === key);
      if (!target || (intake && !spaceNo?.trim())) {
        if (intake) throw new BadRequestException('本次产权车位不在适用车库或缺少车位号');
        continue;
      }
      const communities = await this.communityRepo.findBy({tenantId,name:In(target.communities)});
      const ids = communities.map(c=>c.id).filter(id=>!scope || scope.includes(id));
      const lookup = (number: string) => this.spaceRepo.findBy({tenantId,communityId:In(ids),garage,spaceNo:number});
      let rows = spaceNo?.trim() ? await lookup(spaceNo.trim()) : [];
      if (rows.length !== 1 && !intake && dto.houseId) {
        const bindings = (await this.boundPropertySpaces(tenantId,dto.houseId,ids,[plate]))
          .filter(row => row.garage === garage && normPlate(row.plate) === plate);
        // An external card number may have a different format from the bound PMS card number.
        const candidates = bindings.length || spaceNo?.trim() ? bindings
          : (await this.roomPropertySpaces(tenantId,dto.houseId,ids)).filter(card => card.garage === garage);
        const chosen = garage === 'main' ? dto.mainSpaceNo : dto.civilSpaceNo;
        const number = chosen ? candidates.find(card => card.spaceNo === chosen)?.spaceNo
          : candidates.length === 1 ? candidates[0].spaceNo : undefined;
        rows = number ? await lookup(number) : [];
      }
      if (rows.length !== 1 || !rows[0].communityId) {
        if (intake) throw new BadRequestException('产权车位档案未能唯一匹配，请核对车库、车位号和管理范围');
        continue;
      }
      refs.push({id:rows[0].id,communityId:rows[0].communityId,garage,spaceNo:rows[0].spaceNo});
    }
    return refs;
  }

  private async completePayment(dto: CompleteBusinessDto, user: AuthUser, access?: ResolvedAccess, manager?: EntityManager,
    plateRenewal?: { communityId: number; txnNo: string; signature: string }) {
    const tenantId = this.requireTenant(user);
    // 新办车牌：车牌由业主扫码或办公室填写，登记期限以登记单为准，服务端重新报价。
    const intake = dto.intakeId && dto.serviceType === BusinessServiceType.PARKING_MONTHLY
      ? await this.intakes.claimForPayment(dto.intakeId, dto.houseId, user, manager, access, dto.shopBuildingId) : null;
    const term = intake?.verifyGarages && dto.expectedAmountCents !== undefined ? null : intake?.row.registrationTerm ?? null;
    if (intake) {
      dto.plateNo = intake.plate || undefined;
      dto.currentEndDate = undefined;
      if (term?.mode === 'months') { dto.months = term.months; dto.startDate = undefined; dto.endDate = undefined; }
      else if (term?.mode === 'dates') { dto.startDate = term.startDate; dto.endDate = term.endDate; dto.months = undefined; }
    }
    const estimate = await this.estimate(dto, user);
    const rule = await this.findRule(tenantId, dto.ruleId, dto.serviceType);
    // 非标准续期：前台自定开始/结束日期并手填实收金额 → 先登记收款，等物业经理审核通过再执行
    const custom = dto.serviceType === BusinessServiceType.PARKING_MONTHLY
      && (dto.manualAmountCents != null || (!!dto.startDate || !!dto.endDate));
    if (custom) {
      if (!dto.startDate || !dto.endDate) throw new BadRequestException('非标准续期要填开始日期和结束日期');
      if (dto.manualAmountCents == null) throw new BadRequestException('非标准续期要填实收金额');
      if (!dto.customReason?.trim()) throw new BadRequestException('请写明非标准续期的原因，供物业经理审核');
    }
    const amountCents = custom ? dto.manualAmountCents! : estimate.amountCents;
    if (dto.expectedAmountCents !== undefined && dto.expectedAmountCents !== amountCents) throw new BadRequestException('应收金额已变化，请刷新报价后重新确认');
    // 车牌所在的缴费规则分组要和所用价格表对上：业主车不能按租客车价收，反之亦然
    let previousParkingClass = '';
    let selectedParkingClass = '';
    if (dto.serviceType === BusinessServiceType.PARKING_MONTHLY) {
      const ruleClass = ((rule.config ?? {}) as ParkingRuleConfig).vehicleClass || '';
      const carClass = intake ? intake.row.vehicleClass
        : dto.plateNo ? (await this.tagRepo.findOne({ where: { tenantId, plate: normPlate(dto.plateNo) } }))?.vehicleClass || '' : '';
      previousParkingClass = carClass || '';
      if (dto.confirmedVehicleClass && dto.confirmedVehicleClass !== ruleClass)
        throw new BadRequestException('收费类别与当前价格表不一致，请重新确认');
      selectedParkingClass = dto.confirmedVehicleClass || carClass || ruleClass;
      if ((!dto.confirmedVehicleClass || intake) && ruleClass && carClass && ruleClass !== carClass) {
        throw new BadRequestException(`这辆车属于「${carClass}」分组，不能按「${ruleClass}」分组的价格收款；分组不对请先改分组`);
      }
    }
    const house = dto.houseId
      ? await this.houseRepo.findOne({ where: { id: dto.houseId, tenantId } })
      : null;
    if (dto.houseId && !house) throw new NotFoundException('house not found');

    // 房号 → 小区：落到流水上供范围过滤，同时校验经办权限与规则适用性
    const shopIntake = intake?.row.shopBuildingId != null ? intake.row : null;
    let communityId: number | null = plateRenewal?.communityId ?? shopIntake?.communityId ?? null;
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
    if (dto.collectionDate) snapshot.collectionDate = dto.collectionDate;
    if (plateRenewal) snapshot.plateRenewalSignature = plateRenewal.signature;
    if (!plateRenewal && ['产权车','产权车位'].includes(selectedParkingClass)) {
      if (!communityId) throw new BadRequestException('产权车流水需要明确房屋所属小区');
      snapshot.propertySpaces = await this.propertySpaceRefs(dto, tenantId, communityId, scope, intake?.row);
    }
    if (house && ['产权车','产权车位'].includes(selectedParkingClass)) {
      const currentHouse = await this.houseRepo.findOneOrFail({where:{tenantId,id:house.id},relations:{unit:true}});
      const building = await this.buildingRepo.findOneByOrFail({tenantId,id:currentHouse.buildingId});
      const owner = dto.ownerId ? await this.userRepo.findOneBy({tenantId,id:dto.ownerId,houseId:currentHouse.id,role:UserRole.OWNER})
        : (await this.userRepo.find({where:{tenantId,houseId:currentHouse.id,role:UserRole.OWNER},order:{id:'ASC'},take:1}))[0];
      const registration = intake?.row ?? await this.houseRepo.manager.getRepository(VehicleIntake).findOne({
        where:{tenantId,houseId:currentHouse.id,plate:normPlate(dto.plateNo || ''),status:Not('void')},order:{id:'DESC'},
        select:{id:true,contactPhone:true},
      });
      snapshot.propertyContact = { houseId:currentHouse.id, houseNo:[building.lane,building.buildingNo,currentHouse.unit?.unitNo,currentHouse.roomNo].filter(Boolean).join('/'),
        ownerName:owner?.name ?? null, ownerPhone:owner?.phone ?? null, contactPhone:registration?.contactPhone || null };
    }
    if (shopIntake && ['产权车','产权车位'].includes(selectedParkingClass)) {
      snapshot.propertyContact = { houseId: null, shopBuildingId: shopIntake.shopBuildingId, houseNo: shopIntake.houseLabel,
        ownerName: shopIntake.ownerName || null, ownerPhone: shopIntake.ownerPhone || null, contactPhone: shopIntake.contactPhone || null };
    }
    if (intake) {
      snapshot.registrationTerm = term;
      snapshot.quote = {
        amountCents, standardAmountCents: 'standardAmountCents' in estimate ? estimate.standardAmountCents : estimate.amountCents,
        quantity: estimate.quantity, startDate: estimate.startDate, endDate: estimate.endDate,
        ruleId: rule.id, unitPriceCents: rule.unitPriceCents, computedAt: new Date().toISOString(),
        source: 'server-intake-term',
      };
    }
    const exec = this.execution.initialFor(dto.serviceType);
    if (plateRenewal && exec.execution?.mode !== 'on')
      throw new BadRequestException('当前现场续期未启用，请恢复续期服务后再收款');
    if (exec.execution) snapshot.execution = exec.execution;
    if (custom) {
      snapshot.review = {
        reason: dto.customReason!.trim(), requestedBy: user.id, requestedAt: new Date().toISOString(),
        startDate: estimate.startDate, endDate: estimate.endDate, manualAmountCents: amountCents, standardAmountCents: 'standardAmountCents' in estimate ? estimate.standardAmountCents : estimate.amountCents,
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
        if (dto.legacyStartDate && (!dto.parkingSystems.some(s => s.kind === 'local') || !estimate.endDate || dto.legacyStartDate > estimate.endDate))
          throw new BadRequestException('旧库开始日期不能晚于结束日期，且必须选择旧停车库');
        snapshot.parking = { ...(dto.confirmedVehicleClass ? { vehicleClass: dto.confirmedVehicleClass, previousVehicleClass: previousParkingClass } : {}), ...(dto.legacyStartDate ? { legacyStartDate: dto.legacyStartDate } : {}), plate: (dto.plateNo || '').trim().toUpperCase(), target: target?.key ?? null, systems: dto.parkingSystems, ...(intake ? { newVehicle: true } : {}) };
      }
      if (intake) {
        if (intake.verifyGarages) {
          const allowed = targetsForCommunity((await this.communityRepo.findOne({where:{id:communityId ?? -1,tenantId}}))?.name ?? null);
          const keys = (dto.parkingSystems ?? []).map(s => {
            const targets = allowed.filter(t => s.kind === 'local' ? t.system === 'local' && t.database === s.database : t.system === 'deliyun' && t.deliyunPark === s.park);
            if (s.targetKey) return targets.find(t => t.key === s.targetKey)?.key;
            return (targets.find(t => t.label === s.label || t.short === s.label) ?? targets[0])?.key;
          });
          if (!keys.length || keys.some(k => !k) || keys.sort().join('|') !== [...intake.row.garages].sort().join('|')) throw new BadRequestException('车库已变化，请刷新后按原登记收款');
        }
        snapshot.intake = { ...(intake.homeUpload ? {homeUpload:true} : {}), id: intake.row.id, plate: intake.row.plate, dataVersion: intake.row.dataVersion ?? 0,
          ...(shopIntake ? { shopBuildingId: shopIntake.shopBuildingId, propertyLabel: shopIntake.houseLabel } : {}) };
        snapshot.vehicle = { plateNo: intake.plate || '', validUntil: estimate.endDate };
        targetType = 'vehicle_intake';
        targetId = intake.row.id;
      } else if (plateRenewal) {
        targetType = 'parking_plate';
        snapshot.vehicle = { plateNo: dto.plateNo, validUntil: estimate.endDate };
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

    const record = this.txnRepo.create({
        tenantId,
        txnNo: plateRenewal?.txnNo ?? this.makeTxnNo(dto.serviceType),
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
      });
    const txn = !intake && dto.serviceType === BusinessServiceType.PARKING_MONTHLY && dto.confirmedVehicleClass && dto.plateNo
      ? await this.txnRepo.manager.transaction(async manager => {
        const saved = await manager.save(record);
        await manager.getRepository(ParkingPlateTag).upsert({ tenantId, plate: normPlate(dto.plateNo!), vehicleClass: selectedParkingClass,
          ...(plateRenewal ? {} : { houseId: dto.houseId ?? null }), updatedBy: user.id }, ['tenantId', 'plate']);
        return saved;
      }) : await this.txnRepo.save(record);

    await this.logRepo.save([
      this.logRepo.create({
        tenantId,
        transactionId: txn.id,
        action: 'payment_confirmed',
        detail: { amountCents: txn.amountCents, paymentMethod: txn.paymentMethod, ...(dto.collectionDate ? { collectionDate: dto.collectionDate } : {}) },
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

    if (intake) await this.intakes.attachPayment(intake.row, txn, user, manager);
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
    // 历史导入曾把车位维度写进计价单位；仅兼容已明确按月配置的规则，不扩展其他单位。
    const legacySpaceMonthly = String(rule.billingUnit) === 'space' && rule.config?.priceMode === 'monthly';
    if (rule.billingUnit !== BusinessBillingUnit.MONTH && !legacySpaceMonthly) {
      throw new BadRequestException('停车月租规则必须按月计费');
    }
    const hasDates = dto.startDate != null || dto.endDate != null;
    const hasManual = dto.manualAmountCents != null;
    if (hasDates) {
      const validDay = (d: unknown): d is string => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)
        && Number.isFinite(Date.parse(d + 'T00:00:00Z')) && new Date(d + 'T00:00:00Z').toISOString().slice(0, 10) === d;
      if (!validDay(dto.startDate) || !validDay(dto.endDate)) throw new BadRequestException('开始日期和结束日期都要填，且必须是真实日期 YYYY-MM-DD');
      if (dto.endDate < dto.startDate) throw new BadRequestException('结束日期不能早于开始日期');
    }
    if (hasManual && (!hasDates || !Number.isSafeInteger(dto.manualAmountCents) || dto.manualAmountCents! < 0
      || typeof dto.customReason !== 'string' || !dto.customReason.trim())) {
      throw new BadRequestException('自定日期必须明确填写非负实收金额和原因');
    }
    const quantity = dto.months ?? this.monthsBetween(dto.startDate, dto.endDate);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 60) throw new BadRequestException('请选择1至60的整数月数');
    let priced: { amountCents: number; breakdown: string } | null = null;
    try { priced = priceRule(quantity, rule.unitPriceCents, (rule.config ?? {}) as ParkingRuleConfig); }
    catch (e) {
      // 明确实收会进入经理审核；只允许缺标准月档，不掩盖其他计价异常。
      if (!(hasDates && hasManual && e instanceof MissingParkingPriceError)) throw new BadRequestException((e as Error).message);
    }
    const current = /^\d{4}-\d{2}-\d{2}/.test(dto.currentEndDate || '') ? dto.currentEndDate!.slice(0, 10) : null;
    // 续期：没到期的接着原到期日续，已过期的从今天起；结束日 = 开始 + N 月 − 1 天
    const win = dto.startDate ? null : renewalWindow({ currentEndDate: current, today: dto.intakeId && dto.collectionDate ? dto.collectionDate : this.today(), months: quantity });
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
      amountCents: hasManual ? dto.manualAmountCents! : priced!.amountCents,
      standardAmountCents: priced?.amountCents ?? null,
      requiresReview: hasManual,
      summary: `停车月租 ${quantity} 个月`,
      breakdown: priced?.breakdown ?? '标准价格未配置；按明确实收登记，经理审核后执行',
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
      // 续费不能隐式变更车辆归属；换户须走独立的档案核对流程。
      if (dto.plateNo && normPlate(vehicle.plateNo) !== normPlate(dto.plateNo)) {
        throw new BadRequestException('车辆记录与提交车牌不一致，请重新查询后办理');
      }
      if (vehicle.houseId != null && vehicle.houseId !== dto.houseId) {
        throw new BadRequestException('该车已关联其他住户房号，不能在当前住户下续费；请先核对车辆档案');
      }
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
      cfg.priceMode = cfg.priceMode === 'monthly' ? 'monthly' : 'table';
      if (cfg.priceMode === 'monthly') {
        try {
          priceRule(60, dto.unitPriceCents, cfg);
          const cycle = cfg.discountCycleMonths ?? 12;
          cfg.discountCycleMonths = cycle;
          cfg.discountMonths = cfg.discountMonths ?? 0;
          cfg.tiers = [1, cycle].map(months => ({ months, amountCents: priceRule(months, dto.unitPriceCents, cfg).amountCents }));
        } catch (e) { throw new BadRequestException((e as Error).message); }
      } else {
        // 兼容旧指定月档，不能未经授权把其他类别自动转换。
        if (!cfg.tiers.length && dto.unitPriceCents > 0) cfg.tiers = STANDARD_MONTHS.map(m => ({ months: m, amountCents: dto.unitPriceCents * m }));
        if (!cfg.tiers.length) throw new BadRequestException('价格表至少要有一个月数和金额');
      }
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
