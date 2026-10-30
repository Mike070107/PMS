import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { In, IsNull, Not, Repository } from 'typeorm';
import { AuthUser } from '../../common/current-user.decorator';
import { UserRole, UserStatus } from '../../common/enums';
import {
  Building,
  Community,
  FamilyCar,
  House,
  ParkingOperation,
  ParkingProofUpload,
  ParkingQuery,
  User,
} from '../../entities';
import type { FamilyCarFile, FamilyCarStatus } from '../../entities';
import { AccessService, ResolvedAccess } from '../access/access.service';
import { scopeCommunityIds } from '../access/scope.util';
import { NotificationsService } from '../notifications/notifications.service';
import { detectUploadContentType } from '../upload/upload.controller';
import { ObjectStorageService } from '../upload/object-storage.service';
import { AccessCardIssuanceService } from './access-card-issuance.service';
import {
  FAMILY_GARAGES,
  FAMILY_RELATIONS,
  classifyPlateCheck,
  legacyIdentity,
  legacyPlate,
  legacyRoomOfRow,
  type LegacyRow,
  databaseForLane,
  daysUntil,
  defaultFamilyGarages,
  familyValidity,
  isExpiringSoon,
  isPastEnd,
  isValidFamilyPlate,
  normalizeFamilyGarages,
  normalizeFamilyPlate,
  roomKey,
  shanghaiDate,
} from './family-car.util';
import { ParkingProofService } from './parking-proof.service';


/** 把 228/6/502、228弄6号502室、6-502 解析成楼栋与房号；认不出返回 null */
export function parseImportRoom(text: string): { lane: string | null; buildingNo: string; roomNo: string } | null {
  const parts = String(text || '')
    .replace(/[弄号楼栋幢室座\s]/g, '/')
    .replace(/[\\\-—–]/g, '/')
    .split('/')
    .map((part) => part.trim())
    .filter((part) => /^\d+$/.test(part));
  if (parts.length < 2) return null;
  const tail = parts.slice(-3).map((part) => String(Number(part)));
  if (tail.length >= 3) return { lane: tail[0], buildingNo: tail[1], roomNo: tail[2] };
  return { lane: null, buildingNo: tail[0], roomNo: tail[1] };
}

export interface CreateFamilyCarInput {
  houseId: number;
  plate: string;
  duplicateCheckQueryId: number;
  ownerFill?: boolean;
  carOwnerName?: string;
  carOwnerPhone?: string;
  relation?: string;
  remark?: string;
  garages: string[];
  garageNumbers?: Record<string, string>;
  previousId?: number | null;
}

export interface UpdateFamilyCarInput {
  carOwnerName?: string;
  carOwnerPhone?: string;
  relation?: string;
  remark?: string;
  garages?: string[];
  garageNumbers?: Record<string, string>;
}

export const FAMILY_STATUS_LABEL: Record<FamilyCarStatus, string> = {
  upload: '待上传资料',
  office: '待办公室审核',
  manager: '待经理审核',
  returned: '经理退回',
  opening: '开通中',
  active: '已生效',
  expired: '已过期',
  void: '已作废',
};

/** 还在办理或有效、会占用这个车牌的状态 */
const LIVE_STATUSES: FamilyCarStatus[] = ['upload', 'office', 'manager', 'returned', 'opening', 'active'];
// 网页「亲情车经理审核」和员工小程序「审批 · 亲情车」是同一件事的两个入口
const MANAGER_KEYS = ['family-cars-approve', 'app:family-car-approve'];

@Injectable()
export class FamilyCarService {
  private readonly logger = new Logger(FamilyCarService.name);

  constructor(
    @InjectRepository(FamilyCar) private readonly repo: Repository<FamilyCar>,
    @InjectRepository(House) private readonly houseRepo: Repository<House>,
    @InjectRepository(Building) private readonly buildingRepo: Repository<Building>,
    @InjectRepository(Community) private readonly communityRepo: Repository<Community>,
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    @InjectRepository(ParkingQuery) private readonly queryRepo: Repository<ParkingQuery>,
    @InjectRepository(ParkingOperation) private readonly operationRepo: Repository<ParkingOperation>,
    @InjectRepository(ParkingProofUpload) private readonly proofRepo: Repository<ParkingProofUpload>,
    private readonly parking: AccessCardIssuanceService,
    private readonly proofs: ParkingProofService,
    private readonly storage: ObjectStorageService,
    private readonly access: AccessService,
    private readonly notifications: NotificationsService,
  ) {}

  // ---------------- 查询 ----------------

  async list(query: { status?: string; lane?: string; q?: string }, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    const qb = this.repo.createQueryBuilder('fc').where('fc.tenant_id = :tenantId', { tenantId });
    const scope = scopeCommunityIds(access);
    if (scope) {
      if (!scope.length) return { rows: [], today: shanghaiDate() };
      qb.andWhere(`fc.house_id IN (SELECT h.id FROM houses h JOIN buildings b ON b.id = h.building_id WHERE b.community_id IN (:...scope))`, { scope });
    }
    if (query.lane) qb.andWhere('fc.lane = :lane', { lane: query.lane });
    const term = (query.q || '').trim();
    if (term) {
      const like = `%${term.replace(/[%_]/g, '')}%`;
      const plateLike = `%${normalizeFamilyPlate(term)}%`;
      qb.andWhere(`(fc.plate ILIKE :plateLike OR fc.owner_name ILIKE :like OR fc.car_owner_name ILIKE :like
        OR fc.car_owner_phone ILIKE :like OR fc.owner_phone ILIKE :like OR fc.remark ILIKE :like
        OR concat(fc.lane, '/', fc.building_no, '/', fc.room_no) ILIKE :like)`, { like, plateLike });
    }
    // 已作废的只在「全部」里出现，清册默认不显示
    if (query.status !== 'all') qb.andWhere(`fc.status <> 'void'`);
    qb.orderBy('fc.lane', 'ASC').addOrderBy('fc.building_no::int', 'ASC').addOrderBy('fc.room_no', 'ASC').addOrderBy('fc.id', 'DESC');
    const rows = await qb.getMany();
    const today = shanghaiDate();
    return { rows: rows.map((row) => this.view(row, today)), today };
  }

  async get(id: number, user: AuthUser, access?: ResolvedAccess) {
    const car = await this.load(id, user, access);
    await this.sync(car, user);
    const ids = [car.registrationOperationId, car.openOperationId, car.renewOperationId, car.civilOperationId, car.expireOperationId].filter((value): value is number => !!value);
    const ops = ids.length ? await this.operationRepo.find({ where: { id: In(ids), tenantId: car.tenantId } }) : [];
    const state = (id: number | null) => {
      const op = id ? ops.find((row) => row.id === id) : null;
      return op ? { id: op.id, status: op.status, error: op.status === 'failed' ? op.lastError : null, completedAt: op.completedAt } : null;
    };
    const proof = car.proofUploadId ? await this.proofRepo.findOne({ where: { id: car.proofUploadId, tenantId: car.tenantId } }) : null;
    return {
      ...this.detail(car),
      operationStates: {
        registration: state(car.registrationOperationId),
        open: state(car.openOperationId),
        renew: state(car.renewOperationId),
        civil: state(car.civilOperationId),
        expire: state(car.expireOperationId),
      },
      upload: proof ? {
        id: proof.id,
        expiresAt: proof.expiresAt.toISOString(),
        status: proof.submittedAt ? 'submitted' : proof.expiresAt.getTime() <= Date.now() ? 'expired' : proof.openedAt ? 'opened' : 'waiting',
      } : null,
    };
  }

  /** 登记页选择房号后实时显示：本户当前有效 / 办理中 / 历史亲情车 */
  async houseContext(houseId: number, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    const house = await this.resolveHouse(houseId, tenantId, access);
    const rows = await this.repo.find({ where: { tenantId, houseId }, order: { id: 'DESC' } });
    const today = shanghaiDate();
    return {
      house: {
        houseId,
        lane: house.lane,
        buildingNo: house.buildingNo,
        roomNo: house.roomNo,
        roomKey: house.roomKey,
        communityName: house.communityName,
        ownerName: house.ownerName,
        ownerPhone: house.ownerPhone,
        database: house.database,
        garages: house.lane === '198' ? ['phase1'] : ['phase2'],
      },
      rows: rows.map((row) => this.view(row, today)),
    };
  }

  /** 物业经理待审（网页与员工小程序「审批」共用） */
  async pendingManager(user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    const rows = await this.repo.find({ where: { tenantId, status: 'manager' }, order: { officeReviewedAt: 'ASC' } });
    const scope = scopeCommunityIds(access);
    const visible = scope ? await this.filterByScope(rows, scope) : rows;
    const today = shanghaiDate();
    return visible.map((row) => this.detail(row, today));
  }

  // ---------------- 从停车库导入 ----------------

  /**
   * 把停车系统里已经在用的亲情车导进亲情车列表。
   *
   * 现场做法：在停车系统导出亲情车清单（车牌、房号、车主、有效期），办公室把清单
   * 贴进导入框。这里逐行匹配 PMS 房号与业主；这些车在旧库已经生效，导入后直接记为
   * 已生效（不再走两级审核，否则全部卡在待审），并在日志里写明来源。
   *
   * dryRun = 只出核对结果，不落库。
   */
  /** 从现场旧停车库（一期 parking1 / 二期 parking2）拉一份亲情车清单：交给数据同步助手只读查询 */
  async startLegacyPull(user: AuthUser) {
    const q = await this.parking.createParkingIdentityList('亲情车', user);
    return { id: q.id, status: q.status };
  }

  /**
   * 拉取进度；完成后把旧库行整理成导入行（车牌、房号、有效期、电话、实际授权车库），
   * 交给 importFromParking 先核对（dryRun）再导入 —— 和手工贴清单走同一套校验。
   */
  async legacyPullResult(id: number, user: AuthUser) {
    const q = await this.parking.getParkingIdentityList(id, user);
    if (q.status !== 'completed') return { id: q.id, status: q.status, error: q.lastError, rows: [] };
    const date = (v: unknown) => { const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v ?? '')); return m ? m[1] : undefined; };
    const rows = (q.rows as LegacyRow[]).filter((r) => legacyIdentity(r).includes('亲情')).map((r) => {
      const f = r.fields || {};
      const bits = String(f.P_Effective ?? '');
      const on = (chs: number[]) => /^[01]{16,}$/.test(bits) && chs.some((c) => bits[c - 1] === '1');
      const garages = r.database === 'parking1' ? (on([5, 7]) ? ['phase1'] : [])
        : [...(on([9, 11, 13]) ? ['phase2'] : []), ...(on([15, 17, 19, 21]) ? ['main'] : [])];
      // 房号按旧页面同一口径认：owner_Name → owner_Add → P_note；owner_Name 写的是人名时那就是车主
      const { room: ref, personName, tried } = legacyRoomOfRow(r);
      const room = ref ? (ref.kind === 'house' ? `${ref.lane}/${ref.buildingNo}/${ref.roomNo}` : `${ref.road}/${ref.number}`) : (tried[0] || '');
      const tel = f.Owner__owner_Tel ? String(f.Owner__owner_Tel).slice(0, 30) : undefined;
      return {
        plate: legacyPlate(r),
        room: room.trim().slice(0, 40),
        carOwnerName: personName ?? undefined,
        carOwnerPhone: personName ? tel : undefined,
        identity: legacyIdentity(r),
        database: r.database,
        startDate: date(f.Sart_Time ?? f.Start_Time),
        endDate: date(f.End_Time),
        ownerPhone: personName ? undefined : tel,
        remark: `从旧停车库导入${ref && ref.source !== room ? ` · 旧库房号「${ref.source}」` : ''}${f.P_note ? ` · ${String(f.P_note).slice(0, 100)}` : ''}`.slice(0, 200),
        garages,
      };
    });
    // 同一车牌在一期、二期库都有（或重复登记）：留到期最晚的一条，另一条记进说明
    const byPlate = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      const prev = byPlate.get(row.plate);
      if (!prev || (row.endDate || '') > (prev.endDate || '')) byPlate.set(row.plate, prev ? { ...row, remark: `${row.remark}（旧库另有一条 ${prev.database === 'parking1' ? '一期' : '二期'} 记录，已取到期较晚的）`.slice(0, 200) } : row);
    }
    return { id: q.id, status: q.status, error: null, rows: [...byPlate.values()], total: rows.length };
  }

  async importFromParking(
    dto: {
      rows: Array<{
        plate: string;
        room: string;
        ownerName?: string;
        ownerPhone?: string;
        carOwnerName?: string;
        carOwnerPhone?: string;
        relation?: string;
        identity?: string;
        database?: string;
        startDate?: string;
        endDate?: string;
        remark?: string;
        garages?: string[];
      }>;
      dryRun?: boolean;
    },
    user: AuthUser,
    access?: ResolvedAccess,
  ) {
    const tenantId = this.requireTenant(user);
    const scope = scopeCommunityIds(access);
    const today = shanghaiDate();
    const dryRun = !!dto.dryRun;
    const results: Array<{
      plate: string;
      room: string;
      verdict: 'imported' | 'would_import' | 'skipped' | 'failed';
      message: string;
    }> = [];
    let imported = 0;
    let skipped = 0;
    let failed = 0;

    for (const row of dto.rows.slice(0, 500)) {
      const plate = normalizeFamilyPlate(row.plate);
      const roomText = String(row.room || '').trim();
      const fail = (message: string) => {
        failed += 1;
        results.push({ plate, room: roomText, verdict: 'failed', message });
      };
      const skip = (message: string) => {
        skipped += 1;
        results.push({ plate, room: roomText, verdict: 'skipped', message });
      };

      if (!isValidFamilyPlate(plate)) { fail('车牌格式不正确，例：豫GQ3N07'); continue; }
      if (row.identity && !row.identity.includes('亲情')) {
        skip(`旧库车辆身份是「${row.identity}」，不是亲情车`);
        continue;
      }

      // 商铺：永德路/169（旧库写法 永德路169号商铺、永德路187…）→ 路名 + 门牌（也认 157-159 这种合并门牌）
      const shopKey = /^([\u4e00-\u9fa5]{1,8}路)\/?(\d{1,5})/.exec(roomText.replace(/\s+/g, ''));
      const parsed = shopKey ? null : parseImportRoom(roomText);
      if (!shopKey && !parsed) {
        // 旧库里写的是人名 / 备注、没有房号：不按姓名去猜（同名会挂错户），列出来请办公室核实后手动登记
        fail(roomText && !/\d/.test(roomText) ? `旧库没有登记房号（房号栏写的是「${roomText}」），未导入；请核实房号后手动登记` : roomText ? `房号「${roomText}」无法识别，例：228/6/502` : '旧库没有登记房号，未导入；请核实房号后手动登记');
        continue;
      }

      let building: Building;
      let house: House | null;
      if (shopKey) {
        const [, road, no] = shopKey;
        const n = Number(no);
        const covers = (b: Building) => {
          const m = /^(\d+)(?:-(\d+))?$/.exec(String(b.buildingNo || '').trim());
          return !!m && (m[2] ? n >= Number(m[1]) && n <= Number(m[2]) : n === Number(m[1]));
        };
        const onRoad = (await this.buildingRepo.find({ where: { tenantId, roadName: road } }))
          .filter((b) => (!scope || scope.includes(b.communityId)) && covers(b));
        // 门牌正好相等的优先（221 号 和 219-229 合并门牌同时命中时取 221）
        const exact = onRoad.filter((b) => String(b.buildingNo).trim() === String(n));
        const shops = exact.length ? exact : onRoad;
        if (!shops.length) { fail(`找不到商铺 ${road}${no}号`); continue; }
        if (shops.length > 1) { fail(`${road}${no}号 对应多个楼栋，请手动登记`); continue; }
        building = shops[0];
        const inShop = await this.houseRepo.find({ where: { tenantId, buildingId: building.id } });
        house = inShop.find((h) => h.roomNo === '商铺') ?? (inShop.length === 1 ? inShop[0] : null);
        if (!house) { fail(`${road}${building.buildingNo}号 有 ${inShop.length} 个房产，无法确定是哪一间，请手动登记`); continue; }
      } else {
        // 楼栋：给了弄号就精确定位，没给就按楼号找（可能命中多个小区）
        // 楼号按数字比（库里个别楼号写成 06）
        const where: Record<string, unknown> = { tenantId };
        if (parsed!.lane) where.lane = parsed!.lane;
        const sameNo = (v: string) => /^\d+$/.test(String(v).trim()) && Number(v) === Number(parsed!.buildingNo);
        const buildings = (parsed!.lane ? await this.buildingRepo.find({ where }) : await this.buildingRepo.find({ where: { tenantId, buildingNo: In([parsed!.buildingNo, parsed!.buildingNo.padStart(2, '0')]) } }))
          .filter((b) => (!scope || scope.includes(b.communityId)) && sameNo(b.buildingNo));
        if (!buildings.length) {
          fail(parsed!.lane ? `找不到 ${parsed!.lane} 弄 ${parsed!.buildingNo} 号` : `找不到 ${parsed!.buildingNo} 号楼`);
          continue;
        }
        if (buildings.length > 1) {
          fail('房号对应多个楼栋，请把弄号写全，例：228/6/502');
          continue;
        }
        building = buildings[0];
        house = (await this.houseRepo.find({ where: { tenantId, buildingId: building.id } }))
          .find((h) => h.roomNo === parsed!.roomNo || (/^\d+$/.test(h.roomNo) && Number(h.roomNo) === Number(parsed!.roomNo))) ?? null;
        if (!house) { fail(`${parsed!.lane ?? ''}${parsed!.lane ? '弄' : ''}${parsed!.buildingNo}号没有 ${parsed!.roomNo} 室`); continue; }
      }

      // 商铺没有弄号：lane 记路名，库按旧库来源（没有就按小区：一期 parking1）
      const lane = (building.lane || building.roadName || '').trim();
      const community = shopKey ? await this.communityRepo.findOne({ where: { tenantId, id: building.communityId } }) : null;
      const database = databaseForLane(lane)
        ?? (row.database === 'parking1' || row.database === 'parking2' ? row.database : null)
        ?? (community?.name.includes('一期') ? 'parking1' : community?.name.includes('二期') ? 'parking2' : null);
      if (!database) { fail('只支持枫桦景苑一期 / 二期的房号和商铺'); continue; }
      const normNo = (v: string) => (/^\d+$/.test(v) ? String(Number(v)) : v);
      const target = `${lane}${/^\d+$/.test(lane) ? '/' : ''}${normNo(building.buildingNo)}${/^\d+$/.test(lane) ? '/' : '号'}${normNo(house.roomNo)}`;

      const duplicate = await this.repo.findOne({
        where: { tenantId, plate, status: In(LIVE_STATUSES) },
      });
      if (duplicate) {
        skip(`车牌已在亲情车列表（${duplicate.lane}/${duplicate.buildingNo}/${duplicate.roomNo} · ${FAMILY_STATUS_LABEL[duplicate.status]}）`);
        continue;
      }

      if (dryRun) {
        results.push({ plate, room: roomText, verdict: 'would_import', message: `将导入到 ${target}` });
        continue;
      }

      const owner = await this.userRepo.findOne({
        where: { tenantId, houseId: house.id, role: UserRole.OWNER, status: UserStatus.ACTIVE },
        order: { id: 'ASC' },
      });
      const validity = row.startDate && row.endDate
        ? { startDate: row.startDate, endDate: row.endDate }
        : familyValidity(today);
      // 旧库拉来的行带着实际授权的车库（P_Effective 通道位），以旧库为准；手贴的清单没有就按弄号默认
      const fromLegacy = (row.garages ?? []).filter((g) => (FAMILY_GARAGES as readonly string[]).includes(g));
      const garages = fromLegacy.length ? fromLegacy : defaultFamilyGarages(database === 'parking1' ? '198' : '228');

      const car = await this.repo.save(this.repo.create({
        tenantId,
        houseId: house.id,
        lane,
        buildingNo: normNo(building.buildingNo),
        roomNo: normNo(house.roomNo),
        ownerName: (row.ownerName || owner?.name || '').trim().slice(0, 50),
        ownerPhone: (row.ownerPhone || owner?.phone || '').trim().slice(0, 30),
        ownerUserId: owner?.id ?? null,
        carOwnerName: (row.carOwnerName || '').trim().slice(0, 50),
        carOwnerPhone: (row.carOwnerPhone || '').trim().slice(0, 30),
        relation: (row.relation || '').trim().slice(0, 20),
        plate,
        remark: (row.remark || '从停车库导入').trim().slice(0, 200),
        database,
        garages,
        garageNumbers: {},
        mode: 'existing',
        // 旧库里已过期的也导进来（历史清册），标成已过期，不发到期提醒
        status: isPastEnd(validity.endDate, today) ? 'expired' : 'active',
        ownerFill: false,
        files: [],
        proofUploadId: null,
        registrationOperationId: null,
        openOperationId: null,
        renewOperationId: null,
        expireOperationId: null,
        civilOperationId: null,
        officeReviewedBy: null,
        officeReviewedAt: null,
        officeNote: '从停车库导入：旧库已生效，未走 PMS 审核',
        managerReviewedBy: null,
        managerReviewedAt: null,
        managerNote: '',
        startDate: validity.startDate,
        endDate: validity.endDate,
        remindedAt: null,
        previousId: null,
        lastError: null,
        log: [],
        createdBy: user.id,
        updatedBy: user.id,
      }));
      await this.appendLog(
        car,
        user,
        '从停车库导入',
        `旧库已在用${row.identity ? `（车辆身份：${row.identity}）` : ''}；导入前无 PMS 资料与审核记录`,
      );
      imported += 1;
      results.push({ plate, room: roomText, verdict: 'imported', message: `已导入 ${target}` });
    }

    return {
      dryRun,
      summary: { total: dto.rows.length, imported, skipped, failed },
      rows: results,
    };
  }

  // ---------------- 登记 ----------------

  async create(input: CreateFamilyCarInput, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    const house = await this.resolveHouse(Number(input.houseId), tenantId, access);
    const plate = normalizeFamilyPlate(input.plate);
    if (!isValidFamilyPlate(plate)) throw new BadRequestException('车牌格式不正确，例如 豫GQ3N07（不加点）');
    const ownerFill = !!input.ownerFill;
    const info = this.cleanInfo(input, !ownerFill);
    const garages = this.cleanGarages(input.garages, input.garageNumbers);

    const live = await this.repo.find({ where: { tenantId, plate, status: In(LIVE_STATUSES) } });
    const previousId = input.previousId ? Number(input.previousId) : null;
    const blocking = live.find((row) => !(row.status === 'active' && row.id === previousId));
    if (blocking) {
      throw new BadRequestException(`车牌 ${plate} 已有亲情车登记（${blocking.lane}/${blocking.buildingNo}/${blocking.roomNo} · ${FAMILY_STATUS_LABEL[blocking.status]}），不能重复登记`);
    }
    if (previousId) {
      const previous = await this.repo.findOne({ where: { id: previousId, tenantId } });
      if (!previous || previous.plate !== plate) throw new BadRequestException('续登来源记录与车牌不一致');
    }

    // 旧库查重：网页先通过停车网关按车牌真实查询，这里复核结果并决定是新登记还是续登
    const check = await this.queryRepo.findOne({ where: { id: Number(input.duplicateCheckQueryId) || 0, tenantId, queryKind: 'vehicle' } });
    if (!check || check.status !== 'completed' || !check.completedAt) throw new BadRequestException('车牌查重尚未完成，请重新查重');
    if (normalizeFamilyPlate(check.term) !== plate) throw new BadRequestException('查重结果与当前车牌不一致，请重新查重');
    if (Date.now() - new Date(check.completedAt).getTime() > 5 * 60 * 1000) throw new BadRequestException('车牌查重结果已超过 5 分钟，请重新查重');
    const outcome = classifyPlateCheck(check.rows, plate, house.roomKey);
    if (outcome.mode === 'conflict') throw new BadRequestException(outcome.message);

    const now = new Date();
    let car = await this.repo.save(this.repo.create({
      tenantId,
      houseId: house.houseId,
      lane: house.lane,
      buildingNo: house.buildingNo,
      roomNo: house.roomNo,
      ownerName: house.ownerName,
      ownerPhone: house.ownerPhone,
      ownerUserId: house.ownerUserId,
      carOwnerName: info.carOwnerName,
      carOwnerPhone: info.carOwnerPhone,
      relation: info.relation,
      plate,
      remark: (input.remark || '').trim().slice(0, 200),
      database: house.database,
      garages: garages.garages,
      garageNumbers: garages.garageNumbers,
      mode: outcome.mode,
      status: 'upload',
      ownerFill,
      files: [],
      proofUploadId: null,
      registrationOperationId: null,
      openOperationId: null,
      renewOperationId: null,
      expireOperationId: null,
      civilOperationId: null,
      officeReviewedBy: null,
      officeReviewedAt: null,
      officeNote: '',
      managerReviewedBy: null,
      managerReviewedAt: null,
      managerNote: '',
      startDate: null,
      endDate: null,
      remindedAt: null,
      previousId,
      lastError: null,
      log: [],
      createdBy: user.id,
      updatedBy: user.id,
    }));
    const qr = await this.proofs.createFamilySession(car, user, null);
    car.proofUploadId = qr.id;
    await this.appendLog(car, user, previousId ? '办公室续登 / 补登记' : '办公室登记', outcome.mode === 'existing' ? '旧库已是本户亲情车，审核通过后调整授权并续期' : undefined);

    if (outcome.mode === 'new') {
      // 新车牌：先在旧库暂存为待审核亲情车（零授权、零收费），审核通过后再开通
      try {
        const validity = familyValidity(shanghaiDate(now));
        const op = await this.parking.createParkingOperation({
          kind: 'add_vehicle',
          database: house.database,
          idempotencyKey: `family-car-${car.id}-register`,
          pmsUserId: house.ownerUserId,
          payload: {
            plate,
            ownerName: house.ownerName || house.roomKey,
            ownerPhone: house.ownerPhone,
            ownerAddress: house.roomKey,
            identity: '亲情车',
            amount: 0,
            months: 12,
            startDate: validity.startDate,
            endDate: validity.endDate,
            proofUploadId: qr.id,
            garages: car.garages,
            garageNumbers: car.garageNumbers,
            spaces: car.garageNumbers.main || '',
            requiresProofReview: true,
            duplicateCheckQueryId: check.id,
            note: ['亲情车管理登记', car.remark, '操作来源：PMS系统'].filter(Boolean).join('；'),
          },
        }, user, access);
        car.registrationOperationId = op.id;
        await this.repo.save(car);
      } catch (error) {
        // 旧库暂存没有建立就不留半条记录，办公室可直接重试
        await this.proofRepo.delete({ id: qr.id, tenantId });
        await this.repo.delete({ id: car.id, tenantId });
        throw error;
      }
    }
    car = (await this.repo.findOne({ where: { id: car.id, tenantId } }))!;
    return { ...this.detail(car), qr };
  }

  async update(id: number, input: UpdateFamilyCarInput, user: AuthUser, access?: ResolvedAccess) {
    const car = await this.load(id, user, access);
    if (!['upload', 'office', 'returned'].includes(car.status)) throw new BadRequestException('当前状态不能修改登记信息');
    const changes: string[] = [];
    const set = (key: 'carOwnerName' | 'carOwnerPhone' | 'relation' | 'remark', value: string | undefined, label: string, max: number) => {
      if (value === undefined) return;
      const next = value.trim().slice(0, max);
      if (next !== car[key]) { changes.push(`${label}：${car[key] || '空'} → ${next || '空'}`); car[key] = next; }
    };
    set('carOwnerName', input.carOwnerName, '车主姓名', 50);
    set('carOwnerPhone', input.carOwnerPhone, '车主电话', 30);
    if (input.relation !== undefined && input.relation && !(FAMILY_RELATIONS as readonly string[]).includes(input.relation)) {
      throw new BadRequestException('与业主关系不在可选范围内');
    }
    set('relation', input.relation, '与业主关系', 20);
    set('remark', input.remark, '备注', 200);
    if (input.garages) {
      if (car.mode === 'new' && car.registrationOperationId) {
        // 暂存记录的目标车库已经写入旧库任务，改车库只影响审核后的开通范围
      }
      const garages = this.cleanGarages(input.garages, input.garageNumbers ?? car.garageNumbers);
      changes.push(`开通车库：${car.garages.join(',')} → ${garages.garages.join(',')}`);
      car.garages = garages.garages;
      car.garageNumbers = garages.garageNumbers;
    }
    if (!changes.length) return this.detail(car);
    await this.appendLog(car, user, '修改登记信息', changes.join('；'));
    return this.detail(car);
  }

  /** 重新生成 1 小时上传二维码（旧二维码立即失效） */
  async regenerateQr(id: number, user: AuthUser, access?: ResolvedAccess) {
    const car = await this.load(id, user, access);
    if (!['upload', 'office', 'returned'].includes(car.status)) throw new BadRequestException('当前状态不需要上传资料');
    const qr = await this.proofs.createFamilySession(car, user, car.proofUploadId);
    car.proofUploadId = qr.id;
    await this.appendLog(car, user, '生成 1 小时上传二维码');
    return { ...this.detail(car), qr };
  }

  async addFiles(id: number, files: Express.Multer.File[] | undefined, user: AuthUser, access?: ResolvedAccess) {
    const car = await this.load(id, user, access);
    if (!['upload', 'office', 'returned'].includes(car.status)) throw new BadRequestException('当前状态不能再上传资料');
    const list = files ?? [];
    if (!list.length || list.length > 10) throw new BadRequestException('请选择 1 至 10 份资料');
    if (car.files.length + list.length > 30) throw new BadRequestException('每辆车最多保存 30 份资料');
    const types = list.map((file) => detectUploadContentType(file.buffer));
    if (types.some((type) => !type || (!type.startsWith('image/') && type !== 'application/pdf'))) {
      throw new BadRequestException('只支持 JPG、PNG、GIF、WebP、HEIC 图片或 PDF');
    }
    const added: FamilyCarFile[] = [];
    for (let index = 0; index < list.length; index++) {
      const stored = await this.storage.putBuffer(list[index].buffer, types[index]!, 'family-cars', list[index].originalname);
      added.push({ objectKey: stored.objectKey, fileName: list[index].originalname.slice(0, 255), contentType: types[index]!, source: 'office', uploadedAt: new Date().toISOString() });
    }
    car.files = [...car.files, ...added];
    await this.appendLog(car, user, '办公室上传资料', added.map((file) => file.fileName).join('、'));
    return this.detail(car);
  }

  async removeFile(id: number, index: number, user: AuthUser, access?: ResolvedAccess) {
    const car = await this.load(id, user, access);
    if (!['upload', 'office', 'returned'].includes(car.status)) throw new BadRequestException('当前状态不能删除资料');
    const file = car.files[index];
    if (!file) throw new NotFoundException('资料不存在');
    car.files = car.files.filter((_, i) => i !== index);
    await this.appendLog(car, user, '删除资料', file.fileName);
    return this.detail(car);
  }

  async submit(id: number, user: AuthUser, access?: ResolvedAccess) {
    const car = await this.load(id, user, access);
    if (car.status !== 'upload') throw new BadRequestException('当前状态不能提交审核');
    if (!car.files.length) throw new BadRequestException('请先上传资料');
    car.status = 'office';
    await this.appendLog(car, user, '提交办公室审核');
    return this.detail(car);
  }

  // ---------------- 审核 ----------------

  async officeReview(id: number, decision: 'approve' | 'reupload' | 'void', note: string | undefined, user: AuthUser, access?: ResolvedAccess) {
    const car = await this.load(id, user, access);
    const text = (note || '').trim().slice(0, 500);
    if (decision === 'void') {
      if (['opening', 'active', 'expired', 'void'].includes(car.status)) throw new BadRequestException('当前状态不能作废');
      if (!text) throw new BadRequestException('请填写作废原因');
      car.status = 'void';
      await this.appendLog(car, user, '办公室驳回并作废', text);
      return this.detail(car);
    }
    if (!['office', 'returned'].includes(car.status)) throw new BadRequestException('当前不在办公室审核环节');
    if (decision === 'reupload') {
      car.status = 'upload';
      // 重传后要重新经办公室审核，不能沿用之前的审核结果自动推进
      car.officeReviewedBy = null;
      car.officeReviewedAt = null;
      const qr = await this.proofs.createFamilySession(car, user, car.proofUploadId);
      car.proofUploadId = qr.id;
      await this.appendLog(car, user, '要求业主补资料，已重新生成二维码', text || undefined);
      return { ...this.detail(car), qr };
    }
    if (!car.files.length) throw new BadRequestException('还没有资料，不能审核通过');
    if (!car.carOwnerName || !car.carOwnerPhone || !car.relation) throw new BadRequestException('请先补全车主姓名、电话和与业主关系');
    if (car.mode === 'new') {
      const registration = car.registrationOperationId ? await this.operationRepo.findOne({ where: { id: car.registrationOperationId, tenantId: car.tenantId } }) : null;
      if (registration?.status !== 'completed') {
        throw new BadRequestException(registration?.status === 'failed'
          ? `旧库暂存失败：${registration.lastError || '请联系管理员'}；请作废后重新登记`
          : '旧库暂存还在执行，请确认停车网关在线后稍候再审核');
      }
    }
    const returned = car.status === 'returned';
    car.status = 'manager';
    car.officeReviewedBy = user.id;
    car.officeReviewedAt = new Date();
    car.officeNote = text || '资料齐全';
    await this.appendLog(car, user, returned ? '办公室处理退回后重新提交经理审核' : '办公室审核通过', car.officeNote);
    await this.notifyManagers(car, user);
    return this.detail(car);
  }

  async managerReview(id: number, decision: 'approve' | 'return', note: string | undefined, user: AuthUser, access?: ResolvedAccess) {
    const car = await this.load(id, user, access);
    if (car.status !== 'manager') throw new BadRequestException('当前不在物业经理审核环节');
    const text = (note || '').trim().slice(0, 500);
    car.managerReviewedBy = user.id;
    car.managerReviewedAt = new Date();
    if (decision === 'return') {
      if (!text) throw new BadRequestException('请填写退回原因');
      car.status = 'returned';
      car.managerNote = text;
      await this.appendLog(car, user, '物业经理退回办公室', text);
      await this.notifyOffice(car, `亲情车 ${car.plate} 被物业经理退回`, text);
      return this.detail(car);
    }
    car.managerNote = text || '同意';
    car.status = 'opening';
    car.lastError = null;
    await this.appendLog(car, user, '物业经理审核通过，开始开通车库', car.managerNote);
    await this.startOpening(car, user);
    await this.sync(car, user);
    return this.detail(car);
  }

  /** 开通 / 续期失败后重试（只重试失败的那一步，不会重复登记） */
  async retry(id: number, user: AuthUser, access?: ResolvedAccess) {
    const car = await this.load(id, user, access);
    if (car.status !== 'opening') throw new BadRequestException('只有开通中的记录需要重试');
    for (const opId of [car.openOperationId, car.renewOperationId]) {
      if (!opId) continue;
      const op = await this.operationRepo.findOne({ where: { id: opId, tenantId: car.tenantId } });
      if (op?.status === 'failed') {
        op.status = 'pending'; op.attempt = 0; op.completedAt = null; op.lastError = null;
        op.leaseAgentKey = null; op.leaseExpiresAt = null; op.updatedBy = user.id;
        await this.operationRepo.save(op);
      }
    }
    if (car.civilOperationId) {
      const civil = await this.operationRepo.findOne({ where: { id: car.civilOperationId, tenantId: car.tenantId } });
      if (civil?.status === 'failed') await this.openCivil(car, user, true);
    }
    car.lastError = null;
    if (!car.openOperationId) await this.startOpening(car, user);
    await this.appendLog(car, user, '重试开通');
    await this.sync(car, user);
    return this.detail(car);
  }

  /** 提前停用：立即撤销车库授权 */
  async stop(id: number, note: string | undefined, user: AuthUser, access?: ResolvedAccess) {
    const car = await this.load(id, user, access);
    if (car.status !== 'active') throw new BadRequestException('只有已生效的亲情车可以停用');
    if (!(note || '').trim()) throw new BadRequestException('请填写停用原因');
    await this.expire(car, user, `提前停用：${note!.trim().slice(0, 200)}`);
    return this.detail(car);
  }

  // ---------------- 业主扫码提交（ParkingProofService 回调） ----------------

  async ownerSubmitted(familyCarId: number, files: FamilyCarFile[], form: Record<string, string> | null) {
    const car = await this.repo.findOne({ where: { id: familyCarId } });
    if (!car) return;
    car.files = [...car.files, ...files];
    if (form) {
      if (form.carOwnerName) car.carOwnerName = form.carOwnerName.trim().slice(0, 50);
      if (form.carOwnerPhone) car.carOwnerPhone = form.carOwnerPhone.trim().slice(0, 30);
      if (form.relation && (FAMILY_RELATIONS as readonly string[]).includes(form.relation)) car.relation = form.relation;
    }
    if (car.status === 'upload') car.status = 'office';
    car.log = [...car.log, { at: new Date().toISOString(), userId: null, userName: '业主扫码', action: '业主扫码填写并上传资料', note: files.map((file) => file.fileName).join('、') }];
    await this.repo.save(car);
    await this.notifyOffice(car, `亲情车 ${car.plate} 业主已上传资料，待办公室审核`);
  }

  /**
   * 收银台「新办车牌 · 亲情车」：业主扫码填的车牌、车主和资料已由办公室在收银台审核过。
   * 这里按原流程建亲情车登记（含旧库查重、暂存），带上资料，并记下办公室已审核；
   * 新车牌的旧库暂存完成后自动提交物业经理（定时任务推进），不用办公室再审一遍。
   */
  async createFromIntake(input: CreateFamilyCarInput, files: FamilyCarFile[], note: string, user: AuthUser, access?: ResolvedAccess) {
    const created = await this.create({ ...input, ownerFill: false }, user, access);
    const car = await this.load(created.id, user, access);
    car.files = files;
    car.status = 'office';
    car.officeReviewedBy = user.id;
    car.officeReviewedAt = new Date();
    car.officeNote = (note || '收银台已审核业主扫码资料').slice(0, 500);
    // 收银台的二维码已经收齐资料，亲情车自己的上传码不再需要
    if (car.proofUploadId) {
      const proof = await this.proofRepo.findOne({ where: { id: car.proofUploadId, tenantId: car.tenantId } });
      if (proof && !proof.submittedAt && proof.expiresAt.getTime() > Date.now()) { proof.expiresAt = new Date(); await this.proofRepo.save(proof); }
    }
    await this.appendLog(car, user, '收银台扫码登记，办公室已审核资料', car.officeNote);
    await this.advancePreReviewed(car, user).catch(() => undefined);
    return this.detail(car);
  }

  /** 办公室已审核（收银台）、只等旧库暂存完成的登记：完成后自动提交物业经理 */
  private async advancePreReviewed(car: FamilyCar, user: AuthUser) {
    if (car.status !== 'office' || !car.officeReviewedAt) return;
    if (car.mode === 'new') {
      const registration = car.registrationOperationId ? await this.operationRepo.findOne({ where: { id: car.registrationOperationId, tenantId: car.tenantId } }) : null;
      if (registration?.status === 'failed') { await this.setError(car, `旧库暂存失败：${registration.lastError || '请联系管理员'}`); return; }
      if (registration?.status !== 'completed') return;
    }
    car.status = 'manager';
    await this.appendLog(car, user, '旧库暂存完成，自动提交物业经理审核');
    await this.notifyManagers(car, user);
  }

  /** 业主扫码页显示的登记信息 */
  async sessionInfo(familyCarId: number) {
    const car = await this.repo.findOne({ where: { id: familyCarId } });
    if (!car) return null;
    return {
      lane: car.lane, buildingNo: car.buildingNo, roomNo: car.roomNo, plate: car.plate,
      carOwnerName: car.carOwnerName, carOwnerPhone: car.carOwnerPhone, relation: car.relation,
      relations: [...FAMILY_RELATIONS],
      needsInfo: !car.carOwnerName || !car.carOwnerPhone || !car.relation,
    };
  }

  // ---------------- 定时：开通进度、到期停用、到期提醒 ----------------

  @Cron(CronExpression.EVERY_5_MINUTES)
  async tick() {
    try {
      const preReviewed = await this.repo.find({ where: { status: 'office', officeReviewedAt: Not(IsNull()) } });
      for (const car of preReviewed) await this.advancePreReviewed(car, this.systemUser(car)).catch((error) => this.logger.warn(`亲情车 ${car.id} 自动提交经理失败：${error.message}`));
      const opening = await this.repo.find({ where: { status: 'opening' } });
      for (const car of opening) await this.sync(car, this.systemUser(car)).catch((error) => this.logger.warn(`亲情车 ${car.id} 开通进度同步失败：${error.message}`));
      const today = shanghaiDate();
      const active = await this.repo.find({ where: { status: 'active' } });
      for (const car of active) {
        if (isPastEnd(car.endDate, today)) {
          await this.expire(car, this.systemUser(car), `有效期至 ${car.endDate}，已到期自动停用`)
            .catch((error) => this.logger.warn(`亲情车 ${car.id} 到期停用失败：${error.message}`));
        } else if (!car.remindedAt && isExpiringSoon(car.endDate, today)) {
          car.remindedAt = new Date();
          await this.repo.save(car);
          await this.notifyOffice(car, `亲情车 ${car.plate} 将于 ${car.endDate} 到期`, `${car.lane}/${car.buildingNo}/${car.roomNo} ${car.carOwnerName}，到期后自动停用，如需继续请续登`);
        }
      }
    } catch (error) {
      this.logger.error(`亲情车定时任务失败：${(error as Error).message}`);
    }
  }

  // ---------------- 内部 ----------------

  private async startOpening(car: FamilyCar, user: AuthUser) {
    const today = shanghaiDate();
    const validity = familyValidity(today);
    car.startDate = validity.startDate;
    car.endDate = validity.endDate;
    const proofId = await this.approveProof(car, user);
    const localGarages = car.garages.filter((key) => key !== 'civil');
    try {
      const op = await this.parking.createParkingOperation({
        kind: 'update_garages',
        database: car.database as 'parking1' | 'parking2',
        idempotencyKey: `family-car-${car.id}-open-${proofId}`,
        pmsUserId: car.ownerUserId,
        payload: {
          plate: car.plate,
          ownerRoom: roomKey(car.lane, car.buildingNo, car.roomNo),
          ownerAddress: roomKey(car.lane, car.buildingNo, car.roomNo),
          ownerName: car.ownerName,
          ownerPhone: car.ownerPhone,
          identity: '亲情车',
          garages: localGarages,
          garageNumbers: car.garageNumbers,
          familyReviewId: proofId,
          state: 1,
        },
      }, user);
      car.openOperationId = op.id;
    } catch (error) {
      car.lastError = (error instanceof Error ? error.message : '开通车库任务创建失败').slice(0, 500);
    }
    if (car.garages.includes('civil')) await this.openCivil(car, user, false);
    await this.repo.save(car);
  }

  private async openCivil(car: FamilyCar, user: AuthUser, retryFailed: boolean) {
    try {
      const op = await this.parking.setDeliyunCivilDefenseAuthorization({
        plate: car.plate, authorized: true, beginDate: car.startDate, endDate: car.endDate,
        ownerRoom: roomKey(car.lane, car.buildingNo, car.roomNo),
        parkingSpace: car.garageNumbers.civil || '', remark: '来自PMS',
        idempotencyKey: `family-car-${car.id}-civil-${car.startDate}`,
      }, user, retryFailed);
      car.civilOperationId = op.id;
      if (op.status === 'failed') car.lastError = `人防车库开通失败：${op.error || ''}`.slice(0, 500);
    } catch (error) {
      car.lastError = `人防车库开通失败：${error instanceof Error ? error.message : ''}`.slice(0, 500);
    }
  }

  /**
   * 把开通凭证（parking_proof_uploads）标为审核通过。
   * 停车模块只认「该车牌最新一份证明」是否已通过，所以最新那份必须属于本条登记。
   */
  private async approveProof(car: FamilyCar, user: AuthUser): Promise<number> {
    const latest = await this.proofRepo.findOne({ where: { tenantId: car.tenantId, plate: car.plate }, order: { createdAt: 'DESC', id: 'DESC' } });
    let proof = latest && latest.familyCarId === car.id ? latest : null;
    if (!proof) {
      const session = await this.proofs.createFamilySession(car, user, null);
      proof = await this.proofRepo.findOne({ where: { id: session.id, tenantId: car.tenantId } });
    }
    proof!.reviewStatus = 'approved';
    proof!.reviewReason = null;
    proof!.reviewedAt = new Date();
    proof!.reviewedBy = user.id;
    proof!.updatedBy = user.id;
    // 扫码链接到此作废：审核通过后不再接受新资料
    if (!proof!.submittedAt && proof!.expiresAt.getTime() > Date.now()) proof!.expiresAt = new Date();
    await this.proofRepo.save(proof!);
    car.proofUploadId = proof!.id;
    return proof!.id;
  }

  /** 推进开通：车库授权完成 → 续期一年（调用停车续期）→ 已生效 */
  private async sync(car: FamilyCar, user: AuthUser) {
    if (car.status !== 'opening') return;
    if (!car.openOperationId) return;
    const open = await this.operationRepo.findOne({ where: { id: car.openOperationId, tenantId: car.tenantId } });
    if (!open) return;
    if (open.status === 'failed') { await this.setError(car, `车库授权失败：${open.lastError || ''}`); return; }
    if (open.status !== 'completed') return;
    if (!car.renewOperationId) {
      try {
        const renew = await this.parking.createParkingOperation({
          kind: 'renew_vehicle',
          database: car.database as 'parking1' | 'parking2',
          idempotencyKey: `family-car-${car.id}-renew-${car.endDate}`,
          pmsUserId: car.ownerUserId,
          payload: { plate: car.plate, endDate: car.endDate, amount: 0, months: 12, identity: '亲情车', note: '亲情车年度登记，不收费' },
        }, user);
        car.renewOperationId = renew.id;
        car.lastError = null;
        await this.repo.save(car);
      } catch (error) {
        await this.setError(car, `续期任务创建失败：${error instanceof Error ? error.message : ''}`);
        return;
      }
    }
    const renew = await this.operationRepo.findOne({ where: { id: car.renewOperationId!, tenantId: car.tenantId } });
    if (!renew) return;
    if (renew.status === 'failed') { await this.setError(car, `续期失败：${renew.lastError || ''}`); return; }
    if (renew.status !== 'completed') return;
    if (car.civilOperationId) {
      const civil = await this.operationRepo.findOne({ where: { id: car.civilOperationId, tenantId: car.tenantId } });
      if (civil?.status === 'failed') { await this.setError(car, `人防车库开通失败：${civil.lastError || ''}`); return; }
    }
    car.status = 'active';
    car.lastError = null;
    car.remindedAt = null;
    car.log = [...car.log, { at: new Date().toISOString(), userId: null, userName: '系统', action: '车库开通成功，有效期起算', note: `${car.startDate} ~ ${car.endDate}` }];
    await this.repo.save(car);
    if (car.previousId) {
      const previous = await this.repo.findOne({ where: { id: car.previousId, tenantId: car.tenantId } });
      if (previous && previous.status === 'active') {
        previous.status = 'expired';
        previous.log = [...previous.log, { at: new Date().toISOString(), userId: null, userName: '系统', action: '已由续登记录替代', note: `新有效期 ${car.startDate} ~ ${car.endDate}` }];
        await this.repo.save(previous);
      }
    }
    await this.notifyOffice(car, `亲情车 ${car.plate} 已生效，有效期至 ${car.endDate}`);
  }

  private async expire(car: FamilyCar, user: AuthUser, reason: string) {
    // 同一车牌已有续登在办理时，不撤销授权，等新记录开通后接替
    const newer = await this.repo.findOne({ where: { tenantId: car.tenantId, plate: car.plate, id: Not(car.id), status: In(['upload', 'office', 'manager', 'returned', 'opening']) } });
    if (!newer && car.proofUploadId) {
      const op = await this.parking.createParkingOperation({
        kind: 'update_garages',
        database: car.database as 'parking1' | 'parking2',
        idempotencyKey: `family-car-${car.id}-expire-${car.endDate}`,
        pmsUserId: car.ownerUserId,
        payload: {
          plate: car.plate,
          ownerRoom: roomKey(car.lane, car.buildingNo, car.roomNo),
          ownerAddress: roomKey(car.lane, car.buildingNo, car.roomNo),
          garages: [],
          familyReviewId: car.proofUploadId,
          state: 1,
        },
      }, user);
      car.expireOperationId = op.id;
      if (car.garages.includes('civil')) {
        await this.parking.setDeliyunCivilDefenseAuthorization({
          plate: car.plate, authorized: false, ownerRoom: roomKey(car.lane, car.buildingNo, car.roomNo),
          idempotencyKey: `family-car-${car.id}-civil-off-${car.endDate}`,
        }, user, true).catch((error) => this.logger.warn(`亲情车 ${car.id} 人防停用失败：${error.message}`));
      }
    }
    car.status = 'expired';
    if (reason.startsWith('提前停用')) car.endDate = shanghaiDate();
    await this.appendLog(car, user, newer ? `${reason}（同车牌续登办理中，暂不撤销车库授权）` : `${reason}，已下发撤销车库授权`);
  }

  private async setError(car: FamilyCar, message: string) {
    if (car.lastError === message.slice(0, 500)) return;
    car.lastError = message.slice(0, 500);
    await this.repo.save(car);
  }

  private async notifyManagers(car: FamilyCar, user: AuthUser) {
    const ids = new Set<number>();
    for (const key of MANAGER_KEYS) (await this.access.userIdsWithPermission(car.tenantId, key, 'edit')).forEach((id) => ids.add(id));
    ids.delete(user.id);
    const title = `亲情车待经理审核：${car.plate}`;
    for (const receiverId of ids) {
      await this.notifications.notifyUser({
        tenantId: car.tenantId, receiverId, eventKey: 'family_car_pending_manager', title,
        // 点通知直达员工小程序的亲情车审批
        payload: { familyCarId: car.id }, page: '/pages/approvals/approvals?section=family',
        template: 'orderUrge',
        templateFields: this.templateFields(car, '待经理审核', `${car.carOwnerName}（${car.relation}）亲情车待审核`),
      });
    }
  }

  private async notifyOffice(car: FamilyCar, title: string, note?: string) {
    const ids = new Set<number>((await this.access.userIdsWithPermission(car.tenantId, 'family-cars', 'edit')));
    if (car.createdBy) ids.add(car.createdBy);
    for (const receiverId of ids) {
      await this.notifications.notifyUser({ tenantId: car.tenantId, receiverId, eventKey: 'family_car_update', title, payload: { familyCarId: car.id, note } });
    }
  }

  private templateFields(car: FamilyCar, status: string, content: string) {
    const now = new Date(Date.now() + 8 * 3600_000).toISOString().replace('T', ' ').slice(0, 16);
    return {
      orderNo: car.plate, type: '亲情车审核', status, statusShort: status.slice(0, 5), content,
      assignee: '物业经理', address: `${car.lane}弄${car.buildingNo}号${car.roomNo}室`, reporter: car.ownerName || '业主',
      time: now, reportedAt: now, dueAt: now,
    };
  }

  private systemUser(car: FamilyCar): AuthUser {
    return { id: car.managerReviewedBy || car.officeReviewedBy || car.createdBy || 0, tenantId: car.tenantId, role: 'admin' };
  }

  private async appendLog(car: FamilyCar, user: AuthUser, action: string, note?: string) {
    const actor = user.id ? await this.userRepo.findOne({ where: { id: user.id }, select: ['id', 'name', 'loginAccount'] as (keyof User)[] }) : null;
    car.log = [...car.log, { at: new Date().toISOString(), userId: user.id || null, userName: actor?.name || (actor as { loginAccount?: string } | null)?.loginAccount || '系统', action, note }];
    car.updatedBy = user.id || car.updatedBy;
    await this.repo.save(car);
  }

  private cleanInfo(input: { carOwnerName?: string; carOwnerPhone?: string; relation?: string }, required: boolean) {
    const carOwnerName = (input.carOwnerName || '').trim().slice(0, 50);
    const carOwnerPhone = (input.carOwnerPhone || '').trim().slice(0, 30);
    const relation = (input.relation || '').trim();
    if (relation && !(FAMILY_RELATIONS as readonly string[]).includes(relation)) throw new BadRequestException('与业主关系不在可选范围内');
    if (required && (!carOwnerName || !carOwnerPhone || !relation)) throw new BadRequestException('请填写车主姓名、电话和与业主关系，或选择由业主扫码填写');
    if (carOwnerPhone && !/^1\d{10}$/.test(carOwnerPhone) && !/^[\d-]{7,20}$/.test(carOwnerPhone)) throw new BadRequestException('车主电话格式不正确');
    return { carOwnerName, carOwnerPhone, relation };
  }

  private cleanGarages(value: unknown, numbers?: Record<string, string>) {
    let garages: string[];
    try { garages = normalizeFamilyGarages(value); } catch (error) { throw new BadRequestException((error as Error).message); }
    const garageNumbers: Record<string, string> = {};
    for (const key of ['main', 'civil']) {
      if (!garages.includes(key)) continue;
      const text = String(numbers?.[key] ?? '').trim();
      if (!text || text.length > 20) throw new BadRequestException(`请填写${key === 'main' ? '二期大车库车库号' : '二期人防车库车位号'}（最多 20 字）`);
      garageNumbers[key] = text;
    }
    return { garages, garageNumbers };
  }

  private async resolveHouse(houseId: number, tenantId: number, access?: ResolvedAccess) {
    if (!Number.isSafeInteger(houseId) || houseId <= 0) throw new BadRequestException('请选择房号');
    const house = await this.houseRepo.findOne({ where: { id: houseId, tenantId } });
    if (!house) throw new NotFoundException('房号不存在');
    const building = await this.buildingRepo.findOne({ where: { id: house.buildingId, tenantId } });
    if (!building) throw new NotFoundException('房号所属楼栋不存在');
    const community = await this.communityRepo.findOne({ where: { id: building.communityId, tenantId } });
    const scope = scopeCommunityIds(access);
    if (scope && !scope.includes(building.communityId)) throw new ForbiddenException('该房号不在你的管理范围内');
    const lane = (building.lane || '').trim();
    const database = databaseForLane(lane);
    if (!database || !/^\d+$/.test(building.buildingNo) || !/^\d+$/.test(house.roomNo)) {
      throw new BadRequestException('亲情车目前只支持枫桦景苑 198 弄、228 弄的住宅房号');
    }
    const owner = await this.userRepo.findOne({ where: { tenantId, houseId, role: UserRole.OWNER, status: UserStatus.ACTIVE }, order: { id: 'ASC' } });
    return {
      houseId,
      lane,
      buildingNo: String(Number(building.buildingNo)),
      roomNo: String(Number(house.roomNo)),
      roomKey: roomKey(lane, building.buildingNo, house.roomNo),
      communityName: community?.name || '',
      ownerName: owner?.name || '',
      ownerPhone: owner?.phone || '',
      ownerUserId: owner?.id ?? null,
      database,
    };
  }

  private async filterByScope(rows: FamilyCar[], scope: number[]) {
    if (!rows.length) return rows;
    const houseIds = rows.map((row) => row.houseId).filter((id): id is number => !!id);
    if (!houseIds.length) return [];
    const houses = await this.houseRepo.find({ where: { id: In(houseIds) } });
    const buildings = await this.buildingRepo.find({ where: { id: In(houses.map((h) => h.buildingId)) } });
    const allowedBuildings = new Set(buildings.filter((b) => scope.includes(b.communityId)).map((b) => b.id));
    const allowedHouses = new Set(houses.filter((h) => allowedBuildings.has(h.buildingId)).map((h) => h.id));
    return rows.filter((row) => row.houseId && allowedHouses.has(row.houseId));
  }

  private async load(id: number, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    const car = await this.repo.findOne({ where: { id, tenantId } });
    if (!car) throw new NotFoundException('亲情车记录不存在');
    const scope = scopeCommunityIds(access);
    if (scope && !(await this.filterByScope([car], scope)).length) throw new ForbiddenException('该记录不在你的管理范围内');
    return car;
  }

  private requireTenant(user: AuthUser) {
    if (!user.tenantId) throw new ForbiddenException('当前账号没有物业公司范围');
    return user.tenantId;
  }

  private view(car: FamilyCar, today = shanghaiDate()) {
    return {
      id: car.id,
      houseId: car.houseId,
      lane: car.lane,
      buildingNo: car.buildingNo,
      roomNo: car.roomNo,
      roomKey: roomKey(car.lane, car.buildingNo, car.roomNo),
      ownerName: car.ownerName,
      ownerPhone: car.ownerPhone,
      carOwnerName: car.carOwnerName,
      carOwnerPhone: car.carOwnerPhone,
      relation: car.relation,
      plate: car.plate,
      remark: car.remark,
      status: car.status,
      statusLabel: FAMILY_STATUS_LABEL[car.status],
      mode: car.mode,
      ownerFill: car.ownerFill,
      startDate: car.startDate,
      endDate: car.endDate,
      daysLeft: car.endDate && car.status === 'active' ? daysUntil(car.endDate, today) : null,
      expiringSoon: car.status === 'active' && isExpiringSoon(car.endDate, today),
      garages: car.garages,
      garageNumbers: car.garageNumbers,
      fileCount: car.files.length,
      lastError: car.lastError,
      previousId: car.previousId,
      createdAt: car.createdAt,
      updatedAt: car.updatedAt,
    };
  }

  private detail(car: FamilyCar, today = shanghaiDate()) {
    return {
      ...this.view(car, today),
      files: car.files.map((file, index) => ({ index, fileName: file.fileName, contentType: file.contentType, source: file.source, uploadedAt: file.uploadedAt, fileUrl: `/api/v1/upload/file?key=${encodeURIComponent(file.objectKey)}` })),
      proofUploadId: car.proofUploadId,
      officeNote: car.officeNote,
      officeReviewedAt: car.officeReviewedAt,
      managerNote: car.managerNote,
      managerReviewedAt: car.managerReviewedAt,
      operations: {
        registration: car.registrationOperationId,
        open: car.openOperationId,
        renew: car.renewOperationId,
        civil: car.civilOperationId,
        expire: car.expireOperationId,
      },
      log: car.log,
    };
  }
}
