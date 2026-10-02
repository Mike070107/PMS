import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes } from 'node:crypto';
import { Brackets, EntityManager, In, Repository } from 'typeorm';
import { AuthUser } from '../../common/current-user.decorator';
import { UserRole, UserStatus } from '../../common/enums';
import {
  AccessCardAgent,
  AccessCardAuthorization,
  AccessCardIssueBatch,
  AccessCardIssueItem,
  AccessCardLegacyCardCheck,
  AccessCardLegacySnapshot,
  Building,
  Community,
  House,
  ParkingQuery,
  ParkingOwnerUpdate,
  ParkingHistory,
  ParkingRecordSnapshot,
  ParkingOperation,
  User,
} from '../../entities';
import { ResolvedAccess } from '../access/access.service';
import { scopeCommunityIds } from '../access/scope.util';
import {
  accessBuildingsForHouse,
  accessSystemOf,
  belongsToSameAccessArea,
  icToWg,
  legacyRoomKey,
  legacyDatabaseRoomKey,
  legacyDuplicateCardMessage,
  normalizeBuildingNo,
  projectPhaseOf,
} from './access-card-routing';
import { CreateAccessCardIssueDto } from './dto';
import {
  AgentHeartbeatDto,
  AgentReportDto,
  CardPreflightDto,
  CreateParkingQueryDto,
  CreateParkingOwnerUpdateDto,
  EnrollAccessCardAgentDto,
  LegacyCardCheckReportDto,
  LegacyHistoryReportDto,
  ParkingQueryReportDto,
  ParkingOwnerUpdateReportDto,
  CreateParkingOperationDto,
  CreateAccessCardAuthorizationDto,
  CreateAccessCardControllerUploadDto,
  AccessCardAuthorizationReportDto,
  ParkingOperationReportDto,
  ParkingHistoryQueryDto,
} from './dto';
import { agentTokenMatches, issueAgentSecret } from './agent-auth';
import { effectiveAgentStatus, orderAgentsByAvailability } from './agent-status';
import { DeliyunParkingService } from './deliyun-parking.service';
import {
  diffParkingSnapshot,
  formatParkingGarageAuthorization,
  normalizeParkingSourceRecordId,
  type ParkingSnapshotValues,
} from './parking-history.util';
import type {
  AccessCardPermissionEntry,
  AccessCardPermissionSubject,
} from '../../entities/access-card-legacy-snapshot.entity';
import type { ParkingHistoryChange, ParkingHistoryEventType } from '../../entities/parking-history.entity';
import type { AccessPermissionReportDto } from './dto';
import { sortAccessCardHistoryNewestFirst, verifiedHistoryAccessStatus } from './access-card-history.util';
import {
  parkingLegacyRoomFromName,
  parkingPmsBuildingKey,
  parkingPmsHouseKey,
  parkingRoomAddress,
  parseParkingSearch,
  assertFreshParkingPlateCheck,
  supportsStructuredParkingQueries,
} from './parking-query.util';
import {
  normalizeParkingOwnerFieldHints,
  normalizeParkingOwnerValues,
  parkingLegacyOwnerValuesFromFields,
  parkingOwnerJoinedFieldValue,
  parkingOwnerChanges,
  supportsParkingOwnerUpdates,
  supportsParkingOwnerRebind,
  applyParkingOwnerSnapshot,
  parkingOwnerWriteMismatches,
  supportsParkingVehicleSync,
} from './parking-owner-update.util';

type HouseContext = {
  house: House;
  building: Building;
  community: Community;
  phase: 'phase1' | 'phase2';
  accessSystem: 'mjsystem' | 'iccard' | null;
  roomKey: string;
  legacyStorageRoomKey: string;
};

@Injectable()
export class AccessCardIssuanceService {
  constructor(
    @InjectRepository(AccessCardIssueBatch)
    private readonly batchRepo: Repository<AccessCardIssueBatch>,
    @InjectRepository(AccessCardIssueItem)
    private readonly itemRepo: Repository<AccessCardIssueItem>,
    @InjectRepository(AccessCardAuthorization)
    private readonly authorizationRepo: Repository<AccessCardAuthorization>,
    @InjectRepository(AccessCardAgent)
    private readonly agentRepo: Repository<AccessCardAgent>,
    @InjectRepository(AccessCardLegacySnapshot)
    private readonly legacySnapshotRepo: Repository<AccessCardLegacySnapshot>,
    @InjectRepository(AccessCardLegacyCardCheck)
    private readonly legacyCardCheckRepo: Repository<AccessCardLegacyCardCheck>,
    @InjectRepository(House)
    private readonly houseRepo: Repository<House>,
    @InjectRepository(Building)
    private readonly buildingRepo: Repository<Building>,
    @InjectRepository(Community)
    private readonly communityRepo: Repository<Community>,
    @InjectRepository(ParkingQuery)
    private readonly parkingQueryRepo: Repository<ParkingQuery>,
    @InjectRepository(ParkingOwnerUpdate)
    private readonly parkingOwnerUpdateRepo: Repository<ParkingOwnerUpdate>,
    @InjectRepository(ParkingOperation)
    private readonly parkingOperationRepo: Repository<ParkingOperation>,
    @InjectRepository(ParkingHistory)
    private readonly parkingHistoryRepo: Repository<ParkingHistory>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly config: ConfigService,
    private readonly deliyun: DeliyunParkingService,
  ) {}

  async getHouseContext(houseId: number, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    const context = await this.resolveHouse(houseId, tenantId, access);
    const [buildings, pmsHistory, legacySnapshot, authorizationTasks] = await Promise.all([
      this.buildingRepo.find({
        where: { tenantId, communityId: context.community.id },
      }),
      this.historyForHouse(houseId, tenantId),
      this.requestLegacyHistory(tenantId, context.legacyStorageRoomKey, user.id),
      this.authorizationRepo.find({
        where: { tenantId, houseId },
        order: { createdAt: 'DESC' },
        take: 100,
      }),
    ]);
    const legacyReady = legacySnapshot.refreshedAt !== null;
    const permissionSubjects = context.phase === 'phase2'
      ? this.permissionSubjects(pmsHistory, legacyReady ? legacySnapshot.history : [])
      : [];
    const permissionSnapshot = context.phase === 'phase2'
      ? await this.requestAccessPermissions(legacySnapshot, permissionSubjects, user.id)
      : legacySnapshot;
    const mergedHistory = this.mergeHistory(
      pmsHistory,
      legacyReady ? legacySnapshot.history : [],
      context.phase,
      permissionSnapshot.permissionStatus,
      permissionSnapshot.permissions,
    );
    const latestAuthorizationByRow = new Map<number, AccessCardAuthorization>();
    for (const task of authorizationTasks) {
      if (!latestAuthorizationByRow.has(task.historyRowId)) latestAuthorizationByRow.set(task.historyRowId, task);
    }
    const history = mergedHistory.map((row) => ({
      ...row,
      latestAuthorization: latestAuthorizationByRow.has(row.id)
        ? this.historyAuthorizationResponse(latestAuthorizationByRow.get(row.id)!)
        : null,
    }));

    return {
      house: {
        id: context.house.id,
        roomNo: context.house.roomNo,
        communityId: context.community.id,
        communityName: context.community.name,
        buildingId: context.building.id,
        buildingNo: context.building.buildingNo,
        lane: context.building.lane,
        roomKey: context.roomKey,
        displayAddress: `${context.community.name} · ${context.building.buildingNo}号楼 · ${context.house.roomNo}室`,
      },
      projectPhase: context.phase,
      accessSystem: context.accessSystem,
      routeReady: context.phase === 'phase1' || context.accessSystem !== null,
      availableBuildings: accessBuildingsForHouse(context.phase, context.building, buildings)
        .map((building) => ({
            id: building.id,
            buildingNo: building.buildingNo,
            accessSystem: accessSystemOf(context.phase, building.buildingNo),
            routeReady: true,
          })),
      issuedCount: legacyReady ? legacySnapshot.issuedCount : history.length,
      nextSequence: legacyReady
        ? legacySnapshot.nextSequence
        : Math.max(0, ...history.map((item) => item.sequence)) + 1,
      history,
      historySources: {
        pms: true,
        legacy80: legacyReady,
        accessPermissions: context.phase === 'phase1' || permissionSnapshot.permissionStatus === 'ready',
        accessPermissionsMessage: context.phase === 'phase1'
          ? '一期楼栋门禁不需要核验'
          : permissionSnapshot.permissionStatus === 'ready'
            ? `已按门禁权限表核验 ${permissionSubjects.length} 张卡`
            : permissionSnapshot.permissionLastError || '正在从 MjSystem / iCCard 权限表核验控制器权限',
        message: legacyReady
          ? `已合并 192.168.1.80 历史记录，旧库下一序号 #${legacySnapshot.nextSequence}`
          : legacySnapshot.lastError || '暂未取得 192.168.1.80 的历史记录，如需重新查询，请点击“刷新历史”',
      },
    };
  }

  async createHistoryAuthorization(
    houseId: number,
    historyId: number,
    dto: CreateAccessCardAuthorizationDto,
    user: AuthUser,
    access?: ResolvedAccess,
  ) {
    const tenantId = this.requireTenant(user);
    const idempotencyKey = dto.idempotencyKey.trim();
    const existing = await this.authorizationRepo.findOne({ where: { tenantId, idempotencyKey } });
    if (existing) return this.historyAuthorizationResponse(existing);

    const context = await this.getHouseContext(houseId, user, access);
    if (context.projectPhase !== 'phase2') {
      throw new BadRequestException('枫桦景苑一期卡片只写卡，不需要追加楼栋门禁权限');
    }
    const historyRow = context.history.find((row) => row.id === historyId);
    if (!historyRow?.wgCardNo) throw new NotFoundException('没有找到这张历史卡片，或卡片缺少 WG 卡号');
    if (!dto.targetBuildingIds.length) throw new BadRequestException('请至少选择一个要追加授权的楼栋');

    const availableById = new Map(context.availableBuildings.map((building) => [building.id, building]));
    const selected = dto.targetBuildingIds.map((id) => availableById.get(id));
    if (selected.some((building) => !building || !building.routeReady || !building.accessSystem)) {
      throw new BadRequestException('所选楼栋不属于当前门禁区域，或门禁路由尚未配置');
    }
    if (selected.some((building) => building!.id === context.house.buildingId)) {
      throw new BadRequestException(`本楼栋 ${context.house.buildingNo} 号楼不属于额外授权范围`);
    }

    const authorized = new Set((historyRow.controllerResults ?? [])
      .map((row) => normalizeBuildingNo(typeof row.buildingNo === 'string' ? row.buildingNo : ''))
      .filter(Boolean));
    const duplicate = selected.filter((building) => authorized.has(normalizeBuildingNo(building!.buildingNo)));
    if (duplicate.length) {
      throw new BadRequestException(`这张卡已拥有 ${duplicate.map((item) => `${item!.buildingNo}号楼`).join('、')} 权限，无需重复授权`);
    }

    return this.enqueueHistoryAuthorization({
      tenantId,
      houseId,
      historyId,
      roomKey: context.house.roomKey,
      icCardNo: historyRow.icCardNo,
      wgCardNo: historyRow.wgCardNo,
      targetBuildings: selected.map((building) => ({
        id: building!.id,
        buildingNo: building!.buildingNo,
        accessSystem: building!.accessSystem!,
      })),
      idempotencyKey,
      userId: user.id,
    });
  }

  async uploadHistoryCardToController(
    houseId: number,
    historyId: number,
    dto: CreateAccessCardControllerUploadDto,
    user: AuthUser,
    access?: ResolvedAccess,
  ) {
    const tenantId = this.requireTenant(user);
    const idempotencyKey = dto.idempotencyKey.trim();
    const existing = await this.authorizationRepo.findOne({ where: { tenantId, idempotencyKey } });
    if (existing) return this.historyAuthorizationResponse(existing);

    const context = await this.getHouseContext(houseId, user, access);
    if (context.projectPhase !== 'phase2') {
      throw new BadRequestException('枫桦景苑一期卡片不需要上传门禁控制器');
    }
    const historyRow = context.history.find((row) => row.id === historyId);
    if (!historyRow?.wgCardNo) throw new NotFoundException('没有找到这张历史卡片，或卡片缺少 WG 卡号');
    if (historyRow.accessStatus === 'controller_uploaded') {
      throw new BadRequestException('这张卡已上传控制器，无需重复上传');
    }
    if (historyRow.accessStatus !== 'not_uploaded') {
      throw new BadRequestException('这张卡的门禁权限尚未核验完成，请刷新历史后再试');
    }

    const homeBuilding = context.availableBuildings.find((building) => building.id === context.house.buildingId);
    if (!homeBuilding?.routeReady || !homeBuilding.accessSystem) {
      throw new BadRequestException(`本楼栋 ${context.house.buildingNo} 号楼的门禁路由尚未配置`);
    }

    return this.enqueueHistoryAuthorization({
      tenantId,
      houseId,
      historyId,
      roomKey: context.house.roomKey,
      icCardNo: historyRow.icCardNo,
      wgCardNo: historyRow.wgCardNo,
      targetBuildings: [{
        id: homeBuilding.id,
        buildingNo: homeBuilding.buildingNo,
        accessSystem: homeBuilding.accessSystem,
      }],
      idempotencyKey,
      userId: user.id,
    });
  }

  async getHistoryAuthorization(id: number, user: AuthUser) {
    const tenantId = this.requireTenant(user);
    const task = await this.authorizationRepo.findOne({ where: { id, tenantId } });
    if (!task) throw new NotFoundException('历史卡片授权任务不存在');
    return this.historyAuthorizationResponse(task);
  }

  async retryHistoryAuthorization(
    id: number,
    user: AuthUser,
    access?: ResolvedAccess,
  ) {
    const tenantId = this.requireTenant(user);
    const task = await this.authorizationRepo.findOne({ where: { id, tenantId } });
    if (!task) throw new NotFoundException('历史卡片授权任务不存在');
    await this.resolveHouse(task.houseId, tenantId, access);
    if (task.status !== 'failed') throw new BadRequestException('只有下发失败的历史卡片授权任务可以重试');
    const activeTask = await this.authorizationRepo.createQueryBuilder('authorization')
      .where('authorization.tenant_id = :tenantId', { tenantId })
      .andWhere('authorization.history_row_id = :historyRowId', { historyRowId: task.historyRowId })
      .andWhere('authorization.id <> :id', { id: task.id })
      .andWhere('authorization.status IN (:...statuses)', { statuses: ['pending', 'running'] })
      .getOne();
    if (activeTask) throw new BadRequestException('这张卡已有其他门栋权限任务正在执行，请等待完成后刷新历史');
    await this.requireHistoryAuthorizationGateway(tenantId);
    task.status = 'pending';
    task.attempt = 0;
    task.controllerResults = [];
    task.completedAt = null;
    task.leaseAgentKey = null;
    task.leaseExpiresAt = null;
    task.lastError = null;
    task.updatedBy = user.id;
    return this.historyAuthorizationResponse(await this.authorizationRepo.save(task));
  }

  async readiness(user: AuthUser) {
    const tenantId = this.requireTenant(user);
    const agents = await this.agentRepo.find({ where: { tenantId }, order: { id: 'ASC' } });
    const simulationEnabled = this.simulationEnabled();
    const deliyun = await this.deliyun.status();
    const parkingDbWrite = agents.some((agent) =>
      agent.kind === 'parking_gateway' &&
      effectiveAgentStatus(agent) === 'online' &&
      agent.capabilities?.parkingDbWrite === true);
    const accessDbWrite = agents.some((agent) =>
      agent.kind === 'access_gateway' &&
      effectiveAgentStatus(agent) === 'online' &&
      agent.capabilities?.accessDbWrite === true);
    const controllerUpload = agents.some((agent) =>
      agent.kind === 'access_gateway' &&
      effectiveAgentStatus(agent) === 'online' &&
      agent.capabilities?.controllerUpload === true);
    const historicalAccessGrant = agents.some((agent) =>
      agent.kind === 'access_gateway' && effectiveAgentStatus(agent) === 'online'
      && agent.capabilities?.historicalAccessGrant === true);
    return {
      simulationEnabled,
      features: {
        cardWrite: false,
        legacyDbWrite: false,
        accessDbWrite,
        parkingDbRead: true,
        parkingDbWrite,
        controllerUpload,
        historicalAccessGrant,
      },
      agents: orderAgentsByAvailability(agents).map((agent) => ({
        id: agent.agentKey,
        kind: agent.kind,
        name: agent.name,
        version: agent.version,
        status: effectiveAgentStatus(agent),
        capabilities: agent.capabilities,
        lastSeenAt: agent.lastSeenAt,
      })),
      deliyun,
    };
  }

  async createParkingQuery(dto: CreateParkingQueryDto, user: AuthUser) {
    const tenantId = this.requireTenant(user);
    let term: string;
    try {
      term = parseParkingSearch(dto.term).term;
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : '查询内容格式不正确');
    }

    const agents = await this.agentRepo.find({ where: { tenantId, kind: 'parking_gateway', enabled: true } });
    const gateway = orderAgentsByAvailability(agents).find((agent) =>
      effectiveAgentStatus(agent) === 'online' &&
      agent.capabilities?.parkingDbRead === true &&
      supportsStructuredParkingQueries(agent.version));
    if (!gateway) {
      throw new ServiceUnavailableException('停车网关尚未连接，或 Windows 数据同步助手需要升级到 2.4.0（独立停车代理 0.8.0）');
    }

    const query = this.parkingQueryRepo.create({
      tenantId,
      term,
      status: 'pending',
      rows: [],
      attempt: 0,
      requestedAt: new Date(),
      completedAt: null,
      leaseAgentKey: null,
      leaseExpiresAt: null,
      lastError: null,
      createdBy: user.id,
      updatedBy: user.id,
    });
    return this.parkingQueryResponse(await this.parkingQueryRepo.save(query));
  }

  async getParkingQuery(id: number, user: AuthUser) {
    const tenantId = this.requireTenant(user);
    const query = await this.parkingQueryRepo.findOne({ where: { id, tenantId } });
    if (!query) throw new NotFoundException('停车查询不存在或已失效');
    return this.parkingQueryResponse(query);
  }

  async createParkingOwnerUpdate(dto: CreateParkingOwnerUpdateDto, user: AuthUser) {
    const tenantId = this.requireTenant(user);
    const plate = dto.plate?.trim().toUpperCase();
    if (!plate) throw new BadRequestException('住户资料更新必须携带当前车辆的车牌，请刷新页面后重试');
    // 不能将缺失的整个表单/字段归一化为 null 后提交清空旧库。
    for (const field of ['phone', 'room', 'note'] as const) {
      if (dto.expected?.[field] === undefined || dto.values?.[field] === undefined) {
        throw new BadRequestException(`住户资料缺少 ${field} 字段，请重新查询后再保存`);
      }
    }
    const idempotencyKey = dto.idempotencyKey.trim();
    const expectedValues = normalizeParkingOwnerValues({ ...dto.expected, name: null });
    const requestedValues = normalizeParkingOwnerValues({ ...dto.values, name: null });
    const existing = await this.parkingOwnerUpdateRepo.findOne({ where: { tenantId, idempotencyKey } });
    const existingResponse = (task: ParkingOwnerUpdate) => {
      if (task.database !== dto.database || task.externalOwnerId !== dto.externalOwnerId.trim() ||
          task.plate !== plate || task.pmsUserId !== (dto.pmsUserId ?? null) ||
          parkingOwnerChanges(task.expectedValues, expectedValues).length ||
          parkingOwnerChanges(task.requestedValues, requestedValues).length) {
        throw new BadRequestException('该提交编号已有其他更新内容，请先确认原任务结果');
      }
      return this.parkingOwnerUpdateResponse(task);
    };
    if (existing) return existingResponse(existing);

    const agents = await this.agentRepo.find({ where: { tenantId, kind: 'parking_gateway', enabled: true } });
    const gateway = orderAgentsByAvailability(agents).find((agent) =>
      effectiveAgentStatus(agent) === 'online' &&
      agent.capabilities?.parkingDbWrite === true &&
      supportsParkingOwnerUpdates(agent.version));
    if (!gateway) {
      throw new ServiceUnavailableException('停车网关尚未就绪：请确认 Windows 数据同步助手已升级到 2.3.0 且旧库账号具备写入权限');
    }

    const changes = parkingOwnerChanges(expectedValues, requestedValues);
    if (!changes.length) throw new BadRequestException('住户资料没有发生变化');
    if (!dto.externalOwnerId.trim()) throw new BadRequestException('旧停车系统没有可用的住户编号，无法安全更新');

    const now = new Date();
    const task = this.parkingOwnerUpdateRepo.create({
      tenantId,
      database: dto.database,
      externalOwnerId: dto.externalOwnerId.trim(),
      plate,
      pmsUserId: dto.pmsUserId ?? null,
      idempotencyKey,
      expectedValues,
      requestedValues,
      fieldHints: normalizeParkingOwnerFieldHints(dto.fieldHints),
      resultValues: null,
      status: 'pending',
      attempt: 0,
      requestedAt: now,
      completedAt: null,
      leaseAgentKey: null,
      leaseExpiresAt: null,
      lastError: null,
      createdBy: user.id,
      updatedBy: user.id,
    });
    try {
      return this.parkingOwnerUpdateResponse(await this.parkingOwnerUpdateRepo.save(task));
    } catch (error) {
      if ((error as { code?: string }).code !== '23505') throw error;
      const duplicate = await this.parkingOwnerUpdateRepo.findOne({ where: { tenantId, idempotencyKey } });
      if (!duplicate) throw error;
      return existingResponse(duplicate);
    }
  }

  async getParkingOwnerUpdate(id: number, user: AuthUser) {
    const tenantId = this.requireTenant(user);
    const task = await this.parkingOwnerUpdateRepo.findOne({ where: { id, tenantId } });
    if (!task) throw new NotFoundException('住户资料更新任务不存在');
    return this.parkingOwnerUpdateResponse(task);
  }

  async createParkingOperation(dto: CreateParkingOperationDto, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    const idempotencyKey = dto.idempotencyKey.trim();
    const existing = await this.parkingOperationRepo.findOne({ where: { tenantId, idempotencyKey } });
    if (existing) return this.parkingOperationResponse(existing);
    const agents = await this.agentRepo.find({ where: { tenantId, kind: 'parking_gateway', enabled: true } });
    const gateway = orderAgentsByAvailability(agents).find((agent) =>
      effectiveAgentStatus(agent) === 'online' && agent.capabilities?.parkingDbWrite === true && supportsParkingOwnerUpdates(agent.version) &&
      (dto.kind !== 'rebind_owner' || supportsParkingOwnerRebind(agent.version)) &&
      (dto.kind !== 'sync_vehicle_info' || supportsParkingVehicleSync(agent.version)));
    if (!gateway) throw new ServiceUnavailableException(dto.kind === 'rebind_owner'
      ? '变更绑定用户需要 PMS 数据同步助手 2.5.20 及以上版本，请先更新现场助手'
      : dto.kind === 'sync_vehicle_info' ? '车辆资料对齐需要 PMS 数据同步助手 2.5.19 及以上版本，请先在现场电脑升级'
      : '停车网关尚未就绪：请安装 2.4.0 及以上助手并确认旧库存储过程写入权限');
    const payload = normalizeParkingOperationPayload(dto.payload);
    const expected = normalizeParkingOperationPayload(dto.expected ?? {});
    if (dto.kind === 'rebind_owner') {
      const houseId = Number(payload.houseId);
      if (!Number.isSafeInteger(houseId) || houseId <= 0 || !Number.isSafeInteger(dto.pmsUserId) || !dto.pmsUserId) {
        throw new BadRequestException('请从 PMS 房号或姓名搜索结果中选择要绑定的业主');
      }
      const context = await this.resolveHouse(houseId, tenantId, access);
      const owner = await this.userRepo.findOne({ where: { id: dto.pmsUserId, tenantId, houseId, role: UserRole.OWNER, status: UserStatus.ACTIVE } });
      if (!owner) throw new BadRequestException('所选业主与房号不匹配或已停用，请重新选择');
      const parts = [context.building.lane, context.building.buildingNo, context.house.roomNo];
      if (!/^(198|228)$/.test(parts[0] || '') || parts.slice(1).some((part) => !/^\d+$/.test(part || '') || Number(part) <= 0)) {
        throw new BadRequestException('所选房号不能转换为旧停车系统的弄号/楼栋/室号格式，请先完善 PMS 房产档案');
      }
      // 不接受页面自由输入的姓名、电话、旧库主键或房号作为写入依据。
      payload.ownerRoom = parts.map(Number).join('/');
      payload.ownerName = owner.name ?? '';
      payload.ownerPhone = owner.phone ?? '';
      payload.pmsUserId = owner.id;
      payload.bindingContract = 1;
      delete payload.ownerId;
      delete payload.restoreOwnerId;
    }
    validateParkingOperation(dto.kind, payload, expected, dto.sourceRecordId);
    if (dto.kind === 'sync_vehicle_info' && textValue(payload.sourceDatabase) === dto.database) {
      throw new BadRequestException('源停车库和目标停车库不能相同');
    }
    if (dto.kind === 'add_vehicle') {
      const duplicateCheckQueryId = Number(payload.duplicateCheckQueryId);
      if (!Number.isInteger(duplicateCheckQueryId) || duplicateCheckQueryId <= 0) {
        throw new BadRequestException('新增车牌前必须完成一期、二期停车旧库的真实查重');
      }
      const duplicateCheck = await this.parkingQueryRepo.findOne({ where: { id: duplicateCheckQueryId, tenantId } });
      if (!duplicateCheck) throw new BadRequestException('车牌查重记录不存在或不属于当前物业，请重新查重');
      try {
        assertFreshParkingPlateCheck(duplicateCheck, textValue(payload.plate) || '');
      } catch (error) {
        throw new BadRequestException(error instanceof Error ? error.message : '车牌查重未通过');
      }
      // 查重任务编号只用于 PMS 服务端校验，不传给现场助手的旧库存储过程。
      delete payload.duplicateCheckQueryId;
    }
    const now = new Date();
    const task = this.parkingOperationRepo.create({
      tenantId, kind: dto.kind, database: dto.database, idempotencyKey,
      sourceRecordId: dto.sourceRecordId?.trim() || null, pmsUserId: dto.pmsUserId ?? null,
      payload, expected, result: null, status: 'pending', attempt: 0,
      requestedAt: now, completedAt: null, leaseAgentKey: null, leaseExpiresAt: null,
      lastError: null, rollbackOfOperationId: null, createdBy: user.id, updatedBy: user.id,
    });
    return this.parkingOperationResponse(await this.parkingOperationRepo.save(task));
  }

  async getParkingOperation(id: number, user: AuthUser) {
    const tenantId = this.requireTenant(user);
    const task = await this.parkingOperationRepo.findOne({ where: { id, tenantId } });
    if (!task) throw new NotFoundException('停车操作任务不存在');
    return this.parkingOperationResponse(task);
  }

  async rollbackParkingOperation(id: number, user: AuthUser) {
    const tenantId = this.requireTenant(user);
    const source = await this.parkingOperationRepo.findOne({ where: { id, tenantId } });
    if (!source || source.status !== 'completed') throw new BadRequestException('只有已完成的停车操作可以回滚');
    const payload = source.payload;
    const reverse: Record<string, unknown> = { ...payload };
    let kind: CreateParkingOperationDto['kind'];
    if (source.kind === 'add_vehicle') kind = 'delete_vehicle';
    else if (source.kind === 'delete_vehicle') kind = 'add_vehicle';
    else if (source.kind === 'change_plate') { kind = 'change_plate'; reverse.plate = payload.newPlate; reverse.newPlate = payload.plate; }
    else if (source.kind === 'renew_vehicle') { kind = 'renew_vehicle'; reverse.endDate = payload.previousEndDate; }
    else if (source.kind === 'rebind_owner') {
      if (!source.result?.previousOwnerId || !source.result?.targetOwnerId || !source.result?.previousRoom) {
        throw new BadRequestException('原任务缺少已核验的原住户信息，不能自动回滚，请重新选择原房号变更绑定');
      }
      kind = 'rebind_owner'; reverse.restoreOwnerId = source.result.previousOwnerId;
      reverse.previousOwnerId = source.result.targetOwnerId; reverse.ownerRoom = source.result.previousRoom;
      reverse.ownerPhone = source.result.previousPhone; reverse.bindingContract = 1;
    }
    else if (source.kind === 'update_garages') { kind = 'update_garages'; reverse.effective = payload.previousEffective; }
    else throw new BadRequestException('设备下载任务没有安全的数据库回滚动作，请按旧系统状态重新下发');
    if (kind === 'add_vehicle' && !reverse.plate) throw new BadRequestException('原操作没有保存完整车牌，无法回滚');
    const task = this.parkingOperationRepo.create({
      tenantId, kind, database: source.database, idempotencyKey: `rollback-${source.id}-${Date.now()}`,
      sourceRecordId: source.sourceRecordId, pmsUserId: source.kind === 'rebind_owner' ? Number(payload.previousPmsUserId) || null : source.pmsUserId, payload: normalizeParkingOperationPayload(reverse),
      expected: {}, result: null, status: 'pending', attempt: 0, requestedAt: new Date(), completedAt: null,
      leaseAgentKey: null, leaseExpiresAt: null, lastError: null, rollbackOfOperationId: source.id,
      createdBy: user.id, updatedBy: user.id,
    });
    return this.parkingOperationResponse(await this.parkingOperationRepo.save(task));
  }

  async getParkingHistory(dto: ParkingHistoryQueryDto, user: AuthUser) {
    const tenantId = this.requireTenant(user);
    const pmsUserId = dto.pmsUserId ? Number(dto.pmsUserId) : null;
    const database = dto.database?.trim() || null;
    const externalOwnerId = dto.externalOwnerId?.trim() || null;
    const sourceRecordId = normalizeParkingSourceRecordId(dto.sourceRecordId);
    const plate = normalizeParkingText(dto.plate);
    if (!pmsUserId && !(database && externalOwnerId) && !sourceRecordId && !plate) {
      throw new BadRequestException('请选择用户或车牌后再查看历史记录');
    }

    const subject = new Brackets((qb) => {
      let has = false;
      if (pmsUserId) {
        qb.where('history.pms_user_id = :pmsUserId', { pmsUserId });
        has = true;
      }
      if (database && externalOwnerId) {
        const method = has ? 'orWhere' : 'where';
        qb[method]('(history.database = :database AND history.external_owner_id = :externalOwnerId)', { database, externalOwnerId });
      }
    });
    const userHistory = (pmsUserId || (database && externalOwnerId))
      ? await this.parkingHistoryRepo.createQueryBuilder('history')
        .where('history.tenant_id = :tenantId', { tenantId })
        .andWhere(subject)
        .andWhere("(history.source <> 'parking_gateway' OR history.source_record_id IS NULL OR history.source_record_id <> :invalidSourceRecordId)", { invalidSourceRecordId: '0000000000' })
        .orderBy('history.occurred_at', 'DESC')
        .addOrderBy('history.id', 'DESC')
        .take(100)
        .getMany()
      : [];

    const vehicleHistory = (sourceRecordId || plate)
      ? await this.parkingHistoryRepo.createQueryBuilder('history')
        .where('history.tenant_id = :tenantId', { tenantId })
        .andWhere("(history.source <> 'parking_gateway' OR history.source_record_id IS NULL OR history.source_record_id <> :invalidSourceRecordId)", { invalidSourceRecordId: '0000000000' })
        .andWhere(new Brackets((qb) => {
          if (sourceRecordId) qb.where('history.source_record_id = :sourceRecordId', { sourceRecordId });
          if (plate) {
            const method = sourceRecordId ? 'orWhere' : 'where';
            qb[method]('(history.plate_before = :plate OR history.plate_after = :plate)', { plate });
          }
        }))
        .orderBy('history.occurred_at', 'DESC')
        .addOrderBy('history.id', 'DESC')
        .take(100)
        .getMany()
      : [];

    const actorIds = Array.from(new Set([...userHistory, ...vehicleHistory]
      .map((item) => item.operatorUserId)
      .filter((id): id is number => id !== null)));
    const actors = actorIds.length
      ? await this.userRepo.find({ where: { tenantId, id: In(actorIds) }, select: ['id', 'name', 'loginAccount'] })
      : [];
    const actorById = new Map(actors.map((actor) => [actor.id, actor.name || actor.loginAccount || `用户 #${actor.id}`]));
    const response = (item: ParkingHistory) => ({
      id: item.id,
      eventType: item.eventType,
      source: item.source,
      database: item.database,
      sourceRecordId: item.sourceRecordId,
      pmsUserId: item.pmsUserId,
      externalOwnerId: item.externalOwnerId,
      plateBefore: item.plateBefore,
      plateAfter: item.plateAfter,
      summary: item.summary,
      changes: item.changes.map((change) => change.field === 'effective' || change.label === '车库授权'
        ? {
          ...change,
          before: formatParkingGarageAuthorization(change.before, item.database),
          after: formatParkingGarageAuthorization(change.after, item.database),
        }
        : change),
      operator: item.operatorUserId ? actorById.get(item.operatorUserId) || `用户 #${item.operatorUserId}` : '系统从旧停车库检测',
      occurredAt: item.occurredAt,
      // 生产加列由 synchronize 完成时，既有 PMS 记录也会得到保守默认值；PMS 写入时间本身就是操作时间。
      timeBasis: item.source === 'pms' ? 'operation' : item.timeBasis,
    });
    return { userHistory: userHistory.map(response), vehicleHistory: vehicleHistory.map(response) };
  }

  async claimParkingQuery(agentKey: string, token: string) {
    const agent = await this.authenticateAgent(agentKey, token);
    if (agent.kind !== 'parking_gateway') throw new ForbiddenException('当前代理不是停车系统网关');
    if (!supportsStructuredParkingQueries(agent.version)) return { task: null };

    const task = await this.parkingQueryRepo.manager.transaction(async (manager) => {
      const repo = manager.getRepository(ParkingQuery);
      const now = new Date();
      const query = await repo.createQueryBuilder('query')
        .where('query.tenant_id = :tenantId', { tenantId: agent.tenantId })
        .andWhere("(query.status = 'pending' OR (query.status = 'running' AND query.lease_expires_at < :now))", { now })
        .orderBy('query.created_at', 'ASC')
        .setLock('pessimistic_write')
        .setOnLocked('skip_locked')
        .getOne();
      if (!query) return null;
      if (query.attempt >= 3) {
        query.status = 'failed';
        query.lastError = query.lastError || '停车网关连续查询失败，请重新查询';
        query.completedAt = now;
        query.leaseAgentKey = null;
        query.leaseExpiresAt = null;
        await repo.save(query);
        return null;
      }
      query.status = 'running';
      query.attempt += 1;
      query.leaseAgentKey = agent.agentKey;
      query.leaseExpiresAt = new Date(now.getTime() + 90_000);
      query.updatedBy = null;
      await repo.save(query);
      return { queryId: query.id, term: query.term };
    });
    return { task };
  }

  async claimParkingOperation(agentKey: string, token: string) {
    const agent = await this.authenticateAgent(agentKey, token);
    if (agent.kind !== 'parking_gateway') throw new ForbiddenException('当前代理不是停车系统网关');
    if (!supportsParkingOwnerUpdates(agent.version) || agent.capabilities?.parkingDbWrite !== true) return { task: null };
    const canSyncVehicleInfo = supportsParkingVehicleSync(agent.version);
    const task = await this.parkingOperationRepo.manager.transaction(async (manager) => {
      const repo = manager.getRepository(ParkingOperation);
      const now = new Date();
      const item = await repo.createQueryBuilder('task')
        .where('task.tenant_id = :tenantId', { tenantId: agent.tenantId })
        .andWhere("(task.status = 'pending' OR (task.status = 'running' AND task.lease_expires_at < :now))", { now })
        .andWhere("(task.kind <> 'rebind_owner' OR :canRebind = true)", { canRebind: supportsParkingOwnerRebind(agent.version) })
        .andWhere(canSyncVehicleInfo ? '1=1' : "task.kind <> 'sync_vehicle_info'")
        .orderBy('task.created_at', 'ASC').setLock('pessimistic_write').setOnLocked('skip_locked').getOne();
      if (!item) return null;
      if (item.attempt >= 3) {
        item.status = 'failed'; item.lastError = item.lastError || '停车操作连续失败，请检查旧库日志后重试'; item.completedAt = now;
        item.leaseAgentKey = null; item.leaseExpiresAt = null; await repo.save(item); return null;
      }
      item.status = 'running'; item.attempt += 1; item.leaseAgentKey = agent.agentKey;
      item.leaseExpiresAt = new Date(now.getTime() + 90_000); item.updatedBy = null; await repo.save(item);
      return { taskId: item.id, kind: item.kind, database: item.database, sourceRecordId: item.sourceRecordId, payload: item.payload, expected: item.expected };
    });
    return { task };
  }

  async reportParkingOperation(agentKey: string, token: string, dto: ParkingOperationReportDto) {
    const agent = await this.authenticateAgent(agentKey, token);
    if (agent.kind !== 'parking_gateway') throw new ForbiddenException('当前代理不是停车系统网关');
    await this.parkingOperationRepo.manager.transaction(async (manager) => {
      const repo = manager.getRepository(ParkingOperation);
      const task = await repo.findOne({ where: { id: dto.taskId, tenantId: agent.tenantId } });
      if (!task) throw new NotFoundException('停车操作任务不存在');
      if (task.status !== 'running' || task.leaseAgentKey !== agent.agentKey) throw new BadRequestException('停车操作任务不属于当前网关或已经结束');
      const now = new Date();
      if (dto.result === 'success') {
        if (task.kind === 'rebind_owner') {
          const values = dto.values ?? {};
          const baseRoom = textValue(values.targetRoom);
          const requestedRoom = textValue(task.payload.ownerRoom)?.replace(/-/g, '/').split('/').slice(0, 3).map(Number).join('/');
          if (values.verified !== true || !textValue(values.targetOwnerId) || !baseRoom ||
              baseRoom.split('/').slice(0, 3).join('/') !== requestedRoom ||
              textValue(values.targetPhone) !== textValue(task.payload.ownerPhone) ||
              textValue(values.previousOwnerId) !== textValue(task.payload.previousOwnerId)) {
            throw new BadRequestException('助手没有返回与所选房号、电话和原住户一致的换绑结果，不能标为成功');
          }
        }
        task.status = 'completed'; task.result = dto.values ?? { verified: true }; task.lastError = null; task.completedAt = now;
        const plateBefore = textValue(task.payload.plate || task.payload.oldPlate);
        const plateAfter = textValue(task.payload.newPlate || task.payload.plate);
        const changes = operationChanges(task);
        await manager.getRepository(ParkingHistory).save(manager.getRepository(ParkingHistory).create({
          tenantId: task.tenantId, eventType: operationHistoryType(task.kind), source: 'pms', database: task.database,
          sourceRecordId: task.sourceRecordId, pmsUserId: task.pmsUserId,
          externalOwnerId: textValue(task.result?.targetOwnerId || task.payload.ownerId),
          plateBefore, plateAfter, summary: operationSummary(task), changes, operatorUserId: task.createdBy,
          detectedByQueryId: null, occurredAt: now, timeBasis: 'operation', createdBy: task.createdBy, updatedBy: task.createdBy,
        }));
      } else if (dto.result === 'retry' && task.attempt < 3) {
        task.status = 'pending'; task.lastError = dto.errorMessage?.trim() || '旧停车系统暂时无法执行，正在重试';
      } else {
        task.status = 'failed'; task.lastError = dto.errorMessage?.trim() || '旧停车系统操作失败'; task.completedAt = now;
      }
      task.leaseAgentKey = null; task.leaseExpiresAt = null; task.updatedBy = null; await repo.save(task);
    });
    return { ok: true };
  }

  async reportParkingQuery(agentKey: string, token: string, dto: ParkingQueryReportDto) {
    const agent = await this.authenticateAgent(agentKey, token);
    if (agent.kind !== 'parking_gateway') throw new ForbiddenException('当前代理不是停车系统网关');
    await this.parkingQueryRepo.manager.transaction(async (manager) => {
      const repo = manager.getRepository(ParkingQuery);
      const query = await repo.findOne({ where: { id: dto.queryId, tenantId: agent.tenantId } });
      if (!query) throw new NotFoundException('停车查询任务不存在');
      if (query.status !== 'running' || query.leaseAgentKey !== agent.agentKey) {
        throw new BadRequestException('停车查询任务不属于当前网关或已经结束');
      }

      const now = new Date();
      if (dto.result === 'success') {
        query.status = 'completed';
        query.rows = sanitizeParkingRows(dto.rows ?? []);
        query.lastError = null;
        query.completedAt = now;
        await this.captureParkingHistory(manager, query, now);
      } else if (dto.result === 'retry' && query.attempt < 3) {
        query.status = 'pending';
        query.lastError = dto.errorMessage?.trim() || '停车数据库暂时无法查询，正在重试';
      } else {
        query.status = 'failed';
        query.lastError = dto.errorMessage?.trim() || '停车数据库查询失败';
        query.completedAt = now;
      }
      query.leaseAgentKey = null;
      query.leaseExpiresAt = null;
      query.updatedBy = null;
      await repo.save(query);
    });
    return { ok: true };
  }

  async claimParkingOwnerUpdate(agentKey: string, token: string) {
    const agent = await this.authenticateAgent(agentKey, token);
    if (agent.kind !== 'parking_gateway') throw new ForbiddenException('当前代理不是停车系统网关');
    if (!supportsParkingOwnerUpdates(agent.version) || agent.capabilities?.parkingDbWrite !== true) return { task: null };

    const task = await this.parkingOwnerUpdateRepo.manager.transaction(async (manager) => {
      const repo = manager.getRepository(ParkingOwnerUpdate);
      const now = new Date();
      const update = await repo.createQueryBuilder('task')
        .where('task.tenant_id = :tenantId', { tenantId: agent.tenantId })
        .andWhere("(task.status = 'pending' OR (task.status = 'running' AND task.lease_expires_at < :now))", { now })
        .orderBy('task.created_at', 'ASC')
        .setLock('pessimistic_write')
        .setOnLocked('skip_locked')
        .getOne();
      if (!update) return null;
      if (update.attempt >= 3) {
        update.status = 'failed';
        update.lastError = update.lastError || '停车网关连续更新失败，请重新保存';
        update.completedAt = now;
        update.leaseAgentKey = null;
        update.leaseExpiresAt = null;
        await repo.save(update);
        return null;
      }
      update.status = 'running';
      update.attempt += 1;
      update.leaseAgentKey = agent.agentKey;
      update.leaseExpiresAt = new Date(now.getTime() + 90_000);
      update.updatedBy = null;
      await repo.save(update);
      return {
        taskId: update.id,
        database: update.database,
        externalOwnerId: update.externalOwnerId,
        plate: update.plate,
        expected: update.expectedValues,
        values: update.requestedValues,
        fieldHints: update.fieldHints,
      };
    });
    return { task };
  }

  async reportParkingOwnerUpdate(agentKey: string, token: string, dto: ParkingOwnerUpdateReportDto) {
    const agent = await this.authenticateAgent(agentKey, token);
    if (agent.kind !== 'parking_gateway') throw new ForbiddenException('当前代理不是停车系统网关');
    await this.parkingOwnerUpdateRepo.manager.transaction(async (manager) => {
      const repo = manager.getRepository(ParkingOwnerUpdate);
      const task = await repo.findOne({
        where: { id: dto.taskId, tenantId: agent.tenantId }, lock: { mode: 'pessimistic_write' },
      });
      if (!task) throw new NotFoundException('住户资料更新任务不存在');
      // 回报响应丢失后的重复确认不产生第二条审计，也不把已完成任务判为失败。
      if (task.status === 'completed' && dto.result === 'success' && task.resultValues &&
          !parkingOwnerChanges(task.resultValues, normalizeParkingOwnerValues(dto.values)).length) return;
      if (task.status !== 'running' || task.leaseAgentKey !== agent.agentKey) {
        throw new BadRequestException('住户资料更新任务不属于当前网关或已经结束');
      }

      const now = new Date();
      if (dto.result === 'success') {
        const resultValues = normalizeParkingOwnerValues(dto.values);
        const mismatches = parkingOwnerWriteMismatches(task.requestedValues, resultValues);
        if (mismatches.length) throw new BadRequestException(`停车网关读回的${mismatches.join('、')}与提交内容不一致，请重新查询核对`);
        const changes = parkingOwnerChanges(task.expectedValues, resultValues);
        if (!changes.length) throw new BadRequestException('停车网关未返回已更新的住户资料');
        task.status = 'completed';
        task.resultValues = resultValues;
        task.lastError = null;
        task.completedAt = now;

        const labels = changes.map((item) => item.label).join('、');
        await manager.getRepository(ParkingHistory).save(manager.getRepository(ParkingHistory).create({
          tenantId: task.tenantId,
          eventType: 'owner_info_update',
          source: 'pms',
          database: task.database,
          sourceRecordId: null,
          pmsUserId: task.pmsUserId,
          externalOwnerId: task.externalOwnerId,
          plateBefore: task.plate,
          plateAfter: task.plate,
          summary: `更新旧停车系统住户${labels}`,
          changes,
          operatorUserId: task.createdBy,
          detectedByQueryId: null,
          occurredAt: now,
          timeBasis: 'operation',
          createdBy: task.createdBy,
          updatedBy: task.createdBy,
        }));

        const snapshots = await manager.getRepository(ParkingRecordSnapshot).createQueryBuilder('snapshot')
          .where('snapshot.tenant_id = :tenantId', { tenantId: task.tenantId })
          .andWhere('snapshot.database = :database', { database: task.database })
          .andWhere("snapshot.values ->> 'ownerId' = :ownerId", { ownerId: task.externalOwnerId })
          .getMany();
        for (const snapshot of snapshots) {
          snapshot.values = applyParkingOwnerSnapshot(snapshot.values, resultValues, task.plate!);
          snapshot.observedAt = now;
          snapshot.updatedBy = task.createdBy;
        }
        if (snapshots.length) await manager.getRepository(ParkingRecordSnapshot).save(snapshots);
      } else if (dto.result === 'retry' && task.attempt < 3) {
        task.status = 'pending';
        task.lastError = dto.errorMessage?.trim() || '停车数据库暂时无法更新，正在重试';
      } else {
        task.status = 'failed';
        task.lastError = dto.errorMessage?.trim() || '旧停车系统住户资料更新失败';
        task.completedAt = now;
      }
      task.leaseAgentKey = null;
      task.leaseExpiresAt = null;
      task.updatedBy = null;
      await repo.save(task);
    });
    return { ok: true };
  }

  private async captureParkingHistory(manager: EntityManager, query: ParkingQuery, observedAt: Date) {
    const factsByKey = new Map<string, {
      database: string;
      sourceRecordId: string;
      values: ParkingSnapshotValues;
    }>();
    for (const row of query.rows) {
      const sourceRecordId = parkingSourceRecordId(row.fields);
      if (sourceRecordId) {
        const fact = {
        database: row.database,
        sourceRecordId,
        values: parkingSnapshotValues(row.fields),
        };
        // 同一批结果若重复返回同一主键，只保留最后一份快照，避免一次查询生成多条伪变更。
        factsByKey.set(`${fact.database}\u0000${fact.sourceRecordId}`, fact);
      }
    }
    const facts = Array.from(factsByKey.values());
    if (!facts.length) return;
    const snapshotRepo = manager.getRepository(ParkingRecordSnapshot);
    const historyRepo = manager.getRepository(ParkingHistory);
    const ids = Array.from(new Set(facts.map((item) => item.sourceRecordId)));
    const existing = await snapshotRepo.find({ where: { tenantId: query.tenantId, sourceRecordId: In(ids) } });
    const byKey = new Map(existing.map((item) => [`${item.database}\u0000${item.sourceRecordId}`, item]));
    const phones = Array.from(new Set(facts.map((item) => normalizeParkingPhone(item.values.phone)).filter((item): item is string => Boolean(item))));
    const pmsUsers = phones.length ? await manager.find(User, { where: { tenantId: query.tenantId, phone: In(phones) } }) : [];
    const userByPhone = new Map(pmsUsers.filter((item) => item.phone).map((item) => [normalizeParkingPhone(item.phone), item] as const));
    const histories: ParkingHistory[] = [];
    const snapshots: ParkingRecordSnapshot[] = [];
    const ownerInfoKeys = new Set<string>();

    for (const fact of facts) {
      const key = `${fact.database}\u0000${fact.sourceRecordId}`;
      const prior = byKey.get(key);
      const pmsUser = fact.values.phone ? userByPhone.get(normalizeParkingPhone(fact.values.phone) ?? '') : undefined;
      for (const event of diffParkingSnapshot(prior?.values ?? null, fact.values)) {
        const operationTime = event.eventType === 'plate_change' ? parkingOperationTime(event.occurredAt) : null;
        const dedupeKey = event.eventType === 'owner_info_update'
          ? `${fact.database}\u0000${fact.values.ownerId ?? ''}\u0000${JSON.stringify(event.changes)}`
          : null;
        if (dedupeKey && ownerInfoKeys.has(dedupeKey)) continue;
        if (dedupeKey) ownerInfoKeys.add(dedupeKey);
        histories.push(historyRepo.create({
          tenantId: query.tenantId,
          eventType: event.eventType,
          source: 'parking_gateway',
          database: fact.database,
          sourceRecordId: fact.sourceRecordId,
          pmsUserId: pmsUser?.id ?? null,
          externalOwnerId: fact.values.ownerId ?? prior?.values.ownerId ?? null,
          plateBefore: prior?.values.plate ?? null,
          plateAfter: fact.values.plate,
          summary: event.summary,
          changes: event.changes,
          operatorUserId: null,
          detectedByQueryId: query.id,
          occurredAt: operationTime ?? observedAt,
          timeBasis: operationTime ? 'operation' : 'detected',
          createdBy: null,
          updatedBy: null,
        }));
      }
      const snapshot = prior ?? snapshotRepo.create({
        tenantId: query.tenantId,
        database: fact.database,
        sourceRecordId: fact.sourceRecordId,
        createdBy: null,
      });
      snapshot.values = fact.values;
      snapshot.observedAt = observedAt;
      snapshot.updatedBy = null;
      snapshots.push(snapshot);
      byKey.set(key, snapshot);

      const knownPlateChangeAt = parkingOperationTime(fact.values.plateChangedAt);
      if (knownPlateChangeAt && fact.values.plate) {
        // 旧版曾把“查询发现变化”的时刻记成换牌时间；新助手读到 Up_Issue 后就地校正。
        await historyRepo.createQueryBuilder()
          .update(ParkingHistory)
          .set({ occurredAt: knownPlateChangeAt, timeBasis: 'operation' })
          .where('tenant_id = :tenantId', { tenantId: query.tenantId })
          .andWhere('database = :database', { database: fact.database })
          .andWhere('source_record_id = :sourceRecordId', { sourceRecordId: fact.sourceRecordId })
          .andWhere('plate_after = :plate', { plate: fact.values.plate })
          .andWhere("event_type = 'plate_change'")
          .andWhere("time_basis = 'detected'")
          .execute();
      }
    }
    if (histories.length) await historyRepo.save(histories);
    await snapshotRepo.save(snapshots);
  }

  private async parkingQueryResponse(query: ParkingQuery) {
    const rows = query.status === 'completed'
      ? await this.matchParkingRowsToPms(query.tenantId, query.rows)
      : [];
    return {
      id: query.id,
      term: query.term,
      status: query.status,
      rows,
      error: query.status === 'failed' ? query.lastError : null,
      requestedAt: query.requestedAt,
      completedAt: query.completedAt,
    };
  }

  private parkingOwnerUpdateResponse(task: ParkingOwnerUpdate) {
    return {
      id: task.id,
      database: task.database,
      externalOwnerId: task.externalOwnerId,
      plate: task.plate,
      status: task.status,
      values: task.status === 'completed' ? task.resultValues : null,
      error: task.status === 'failed' ? task.lastError : null,
      requestedAt: task.requestedAt,
      completedAt: task.completedAt,
    };
  }

  private parkingOperationResponse(task: ParkingOperation) {
    return {
      id: task.id, kind: task.kind, database: task.database, sourceRecordId: task.sourceRecordId,
      pmsUserId: task.pmsUserId, status: task.status, attempt: task.attempt, payload: task.payload,
      result: task.result, error: task.status === 'failed' ? task.lastError : null,
      requestedAt: task.requestedAt, completedAt: task.completedAt, rollbackOfOperationId: task.rollbackOfOperationId,
    };
  }

  private historyAuthorizationResponse(task: AccessCardAuthorization) {
    return {
      id: task.id,
      houseId: task.houseId,
      historyRowId: task.historyRowId,
      roomKey: task.roomKey,
      icCardNo: task.icCardNo,
      wgCardNo: task.wgCardNo,
      targetBuildings: task.targetBuildings,
      controllerResults: task.controllerResults,
      status: task.status,
      attempt: task.attempt,
      error: task.status === 'failed' ? task.lastError : null,
      requestedAt: task.requestedAt,
      completedAt: task.completedAt,
    };
  }

  private async enqueueHistoryAuthorization(input: {
    tenantId: number;
    houseId: number;
    historyId: number;
    roomKey: string;
    icCardNo: string | null;
    wgCardNo: string;
    targetBuildings: AccessCardAuthorization['targetBuildings'];
    idempotencyKey: string;
    userId: number;
  }) {
    const running = await this.authorizationRepo.find({
      where: { tenantId: input.tenantId, wgCardNo: input.wgCardNo, status: In(['pending', 'running']) },
    });
    const requestedIds = new Set(input.targetBuildings.map((building) => building.id));
    if (running.some((task) => task.targetBuildings.some((building) => requestedIds.has(building.id)))) {
      throw new BadRequestException('这张卡选择的楼栋已有上传任务正在执行，请等待完成后刷新历史');
    }

    await this.requireHistoryAuthorizationGateway(input.tenantId);
    const now = new Date();
    const task = this.authorizationRepo.create({
      tenantId: input.tenantId,
      houseId: input.houseId,
      historyRowId: input.historyId,
      roomKey: input.roomKey,
      icCardNo: input.icCardNo,
      wgCardNo: input.wgCardNo,
      targetBuildings: input.targetBuildings,
      controllerResults: [],
      idempotencyKey: input.idempotencyKey,
      status: 'pending',
      attempt: 0,
      requestedAt: now,
      completedAt: null,
      leaseAgentKey: null,
      leaseExpiresAt: null,
      lastError: null,
      createdBy: input.userId,
      updatedBy: input.userId,
    });
    return this.historyAuthorizationResponse(await this.authorizationRepo.save(task));
  }

  private async requireHistoryAuthorizationGateway(tenantId: number): Promise<void> {
    const agents = await this.agentRepo.find({ where: { tenantId, kind: 'access_gateway', enabled: true } });
    const gateway = orderAgentsByAvailability(agents).find((agent) =>
      effectiveAgentStatus(agent) === 'online'
      && agent.capabilities?.accessDbWrite === true
      && agent.capabilities?.controllerUpload === true
      && agent.capabilities?.historicalAccessGrant === true);
    if (!gateway) {
      throw new ServiceUnavailableException('楼栋门禁网关尚未支持历史卡追加授权，请在 .88 电脑更新 PMS 数据同步助手后重试');
    }
  }

  private async matchParkingRowsToPms(tenantId: number, rows: ParkingQuery['rows']) {
    const phones = Array.from(new Set(rows
      .map((row) => parkingOwnerJoinedFieldValue(row.fields, ['phone', 'mobile', 'telephone', 'tel', 'ptel', 'ownertel', 'ownermobile', 'ownerphone', '手机', '电话']))
      .map((value) => normalizeParkingPhone(value))
      .filter((value): value is string => Boolean(value))));
    const rowRooms = rows.map((row) => parkingRoomAddress(parkingSnapshotValues(row.fields).room, row.database));
    const roomKeys = new Set(rowRooms.flatMap((address) => address ? [address.key] : []));
    const buildingKeys = new Set(rowRooms.flatMap((address) => address ? [`${address.lane}/${address.buildingNo}`] : []));

    // 房号查询量很小，但旧库与 PMS 的前导零写法不一致，不能依赖数据库字符串等值比较。
    // 先把当前租户楼栋收窄到目标弄号/楼号，再在内存里用统一房号键精确匹配。
    const tenantBuildings = roomKeys.size
      ? await this.buildingRepo.find({ where: { tenantId } })
      : [];
    const roomBuildings = tenantBuildings.filter((building) => {
      const key = parkingPmsBuildingKey(building.lane, building.buildingNo);
      return key ? buildingKeys.has(key) : false;
    });
    const roomBuildingIds = roomBuildings.map((building) => building.id);
    const roomHouses = roomBuildingIds.length
      ? await this.houseRepo.find({ where: { tenantId, buildingId: In(roomBuildingIds) } })
      : [];
    const roomCommunityIds = Array.from(new Set(roomBuildings.map((building) => building.communityId)));
    const roomCommunities = roomCommunityIds.length
      ? await this.communityRepo.find({ where: { tenantId, id: In(roomCommunityIds) } })
      : [];
    const initialBuildingById = new Map(roomBuildings.map((building) => [building.id, building]));
    const initialCommunityById = new Map(roomCommunities.map((community) => [community.id, community]));
    const housesByRoomKey = new Map<string, House[]>();
    for (const house of roomHouses) {
      const building = initialBuildingById.get(house.buildingId);
      const key = building ? parkingPmsHouseKey(building.lane, building.buildingNo, house.roomNo) : null;
      if (!key || !roomKeys.has(key)) continue;
      housesByRoomKey.set(key, [...(housesByRoomKey.get(key) ?? []), house]);
    }
    const roomHouseByKey = new Map<string, House>();
    for (const [key, candidates] of housesByRoomKey) {
      const lane = key.split('/')[0];
      const expectedPhase = lane === '198' ? '一期' : lane === '228' ? '二期' : null;
      const preferred = expectedPhase
        ? candidates.find((house) => {
          const building = initialBuildingById.get(house.buildingId);
          const community = building ? initialCommunityById.get(building.communityId) : undefined;
          return community?.name.includes(expectedPhase);
        })
        : undefined;
      roomHouseByKey.set(key, preferred ?? candidates[0]);
    }
    const roomHouseIds = Array.from(new Set(Array.from(roomHouseByKey.values()).map((house) => house.id)));

    const [phoneUsers, roomUsers] = await Promise.all([
      phones.length
        ? this.userRepo.find({ where: { tenantId, phone: In(phones), role: UserRole.OWNER } })
        : Promise.resolve([]),
      roomHouseIds.length
        ? this.userRepo.find({ where: { tenantId, houseId: In(roomHouseIds), role: UserRole.OWNER } })
        : Promise.resolve([]),
    ]);
    const users = Array.from(new Map([...phoneUsers, ...roomUsers].map((user) => [user.id, user])).values())
      .sort((left, right) => {
        const statusOrder = Number(right.status === UserStatus.ACTIVE) - Number(left.status === UserStatus.ACTIVE);
        return statusOrder || right.updatedAt.getTime() - left.updatedAt.getTime() || right.id - left.id;
      });
    const byPhone = new Map<string, User>();
    const byHouse = new Map<number, User>();
    for (const user of users) {
      const phone = normalizeParkingPhone(user.phone);
      if (phone && !byPhone.has(phone)) byPhone.set(phone, user);
      if (user.houseId && !byHouse.has(user.houseId)) byHouse.set(user.houseId, user);
    }

    const houseIds = Array.from(new Set([
      ...roomHouseIds,
      ...users.map((user) => user.houseId).filter((id): id is number => id !== null),
    ]));
    const knownRoomHouseIds = new Set(roomHouses.map((house) => house.id));
    const missingHouseIds = houseIds.filter((id) => !knownRoomHouseIds.has(id));
    const missingHouses = missingHouseIds.length
      ? await this.houseRepo.find({ where: { tenantId, id: In(missingHouseIds) } })
      : [];
    const houses = [...roomHouses, ...missingHouses];
    const buildingIds = Array.from(new Set(houses.map((house) => house.buildingId)));
    const knownBuildingIds = new Set(roomBuildings.map((building) => building.id));
    const missingBuildingIds = buildingIds.filter((id) => !knownBuildingIds.has(id));
    const missingBuildings = missingBuildingIds.length
      ? await this.buildingRepo.find({ where: { tenantId, id: In(missingBuildingIds) } })
      : [];
    const buildings = [...roomBuildings, ...missingBuildings];
    const communityIds = Array.from(new Set(buildings.map((building) => building.communityId)));
    const knownCommunityIds = new Set(roomCommunities.map((community) => community.id));
    const missingCommunityIds = communityIds.filter((id) => !knownCommunityIds.has(id));
    const missingCommunities = missingCommunityIds.length
      ? await this.communityRepo.find({ where: { tenantId, id: In(missingCommunityIds) } })
      : [];
    const communities = [...roomCommunities, ...missingCommunities];
    const updaterIds = Array.from(new Set(users.map((user) => user.updatedBy).filter((id): id is number => id !== null)));
    const updaters = updaterIds.length ? await this.userRepo.find({ where: { id: In(updaterIds) } }) : [];
    const updaterNameById = new Map(updaters.map((user) => [user.id, user.name || user.loginAccount || `用户 #${user.id}`]));
    const houseById = new Map(houses.map((house) => [house.id, house]));
    const buildingById = new Map(buildings.map((building) => [building.id, building]));
    const communityById = new Map(communities.map((community) => [community.id, community]));
    return rows.map((row) => {
      const rawPhone = parkingOwnerJoinedFieldValue(row.fields, ['phone', 'mobile', 'telephone', 'tel', 'ptel', 'ownertel', 'ownermobile', 'ownerphone', '手机', '电话']);
      const roomAddress = parkingRoomAddress(parkingSnapshotValues(row.fields).room, row.database);
      const matchedHouse = roomAddress ? roomHouseByKey.get(roomAddress.key) : undefined;
      const phoneUser = rawPhone ? byPhone.get(normalizeParkingPhone(rawPhone) ?? '') : undefined;
      const roomUser = matchedHouse ? byHouse.get(matchedHouse.id) : undefined;
      // 旧停车库电话可能多年未更新；完整房号或由数据库确定弄号的两段房号更能定位房产。
      // 房号和电话冲突时优先房号，防止把车辆资料挂到同号码的其他业主名下。
      const user = roomUser ?? phoneUser;
      return {
        ...row,
        pmsMatch: user ? (() => {
          const house = user.houseId ? houseById.get(user.houseId) : undefined;
          const building = house ? buildingById.get(house.buildingId) : undefined;
          const community = building ? communityById.get(building.communityId) : undefined;
          return {
          userId: user.id,
          houseId: user.houseId,
          name: user.name,
          phone: user.phone,
          contactNote: user.contactNote,
          status: user.status,
          source: user.source,
          updatedAt: user.updatedAt.toISOString(),
          updatedByName: user.updatedBy ? updaterNameById.get(user.updatedBy) ?? null : null,
          house: house && building ? {
            id: house.id,
            roomNo: house.roomNo,
            areaSqm: house.areaSqm,
            lane: building.lane,
            buildingNo: building.buildingNo,
            communityId: community?.id ?? null,
            communityName: community?.name ?? null,
          } : null,
          matchedBy: roomUser ? 'room' as const : 'phone' as const,
          };
        })() : null,
        historyRef: {
          database: row.database,
          sourceRecordId: parkingSourceRecordId(row.fields),
          externalOwnerId: parkingExternalOwnerId(row.fields),
          plate: parkingSnapshotValues(row.fields).plate,
          pmsUserId: user?.id ?? null,
        },
      };
    });
  }

  async enrollAgent(dto: EnrollAccessCardAgentDto, user: AuthUser) {
    const tenantId = this.requireTenant(user);
    const issued = issueAgentSecret();
    // 固定服务重新生成密钥时复用原代理 ID；ID 是服务身份，不应因为密钥轮换而变化。
    // 发卡工作站允许同租户多台，因此按名称复用对应工作站。
    const existing = await this.agentRepo.findOne({
      where: dto.kind === 'issuer'
        ? { tenantId, kind: dto.kind, name: dto.name.trim() }
        : { tenantId, kind: dto.kind },
      // 历史版本曾重复注册同类服务；优先接管最近真正心跳过的身份，避免轮换密钥时
      // 又退回早已离线的旧 ID。
      order: { lastSeenAt: 'DESC', id: 'DESC' },
    });
    const agent = existing ?? this.agentRepo.create({
      tenantId,
      agentKey: `${dto.kind}-${randomBytes(8).toString('hex')}`,
      kind: dto.kind,
      version: 'pending',
      lastSeenAt: null,
      createdBy: user.id,
    });
    agent.name = dto.name.trim();
    agent.tokenHash = issued.tokenHash;
    agent.enabled = true;
    agent.status = 'offline';
    agent.capabilities = {};
    agent.updatedBy = user.id;
    const saved = await this.agentRepo.save(agent);
    return {
      id: saved.agentKey,
      kind: saved.kind,
      name: saved.name,
      token: `${saved.agentKey}.${issued.token}`,
      message: '连接密钥只显示这一次；代理 ID 已固定在密钥中，只需粘贴这一项',
    };
  }

  async heartbeat(agentKey: string, token: string, dto: AgentHeartbeatDto) {
    const agent = await this.authenticateAgent(agentKey, token);
    agent.version = dto.version;
    agent.capabilities = dto.capabilities;
    agent.status = 'online';
    agent.lastSeenAt = new Date();
    agent.updatedBy = null;
    await this.agentRepo.save(agent);
    return { ok: true, serverTime: new Date().toISOString() };
  }

  async claimAgentTask(agentKey: string, token: string) {
    const agent = await this.authenticateAgent(agentKey, token);
    // 停车网关使用独立的停车任务队列。在该队列落地前必须返回空，
    // 绝不能落入门禁的 legacy_sync 分支而误领发卡任务。
    if (agent.kind === 'parking_gateway') return { task: null, retryAfterMs: 2500 };
    if (agent.kind === 'access_gateway' &&
        (agent.capabilities?.accessDbWrite !== true || agent.capabilities?.controllerUpload !== true)) {
      return { task: null, retryAfterMs: 2500 };
    }
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + 60_000);
    return this.itemRepo.manager.transaction(async (manager) => {
      const repo = manager.getRepository(AccessCardIssueItem);
      const qb = repo
        .createQueryBuilder('item')
        .innerJoinAndSelect('item.batch', 'batch')
        .where('item.tenant_id = :tenantId', { tenantId: agent.tenantId })
        .andWhere('(item.lease_expires_at IS NULL OR item.lease_expires_at < :now)', { now })
        .orderBy('item.id', 'ASC')
        .setLock('pessimistic_write')
        .setOnLocked('skip_locked');

      if (agent.kind === 'issuer') {
        qb.andWhere('item.card_status = :cardStatus', { cardStatus: 'waiting_for_card' })
          .andWhere('(batch.workstation_id IS NULL OR batch.workstation_id = :agentKey)', { agentKey });
      } else if (agent.kind === 'access_gateway') {
        qb.andWhere('batch.project_phase = :phase', { phase: 'phase2' })
          .andWhere('item.card_status = :cardStatus', { cardStatus: 'card_completed' })
          .andWhere('item.access_status IN (:...accessStatuses)', {
            accessStatuses: ['pending', 'waiting_retry'],
          });
      } else {
        qb.andWhere('item.card_status = :cardStatus', { cardStatus: 'card_completed' })
          .andWhere('item.legacy_sync_status IN (:...legacyStatuses)', {
            legacyStatuses: ['pending', 'waiting_retry'],
          });
      }

      const item = await qb.getOne();
      if (!item) return { task: null, retryAfterMs: 2500 };
      item.leaseAgentKey = agent.agentKey;
      item.leaseExpiresAt = leaseExpiresAt;
      item.attempts += 1;
      await repo.save(item);
      const batch = item.batch;
      const targetBuildings = batch.targetBuildingIds.length
        ? await this.buildingRepo.find({ where: { id: In(batch.targetBuildingIds), tenantId: agent.tenantId } })
        : [];
      const action = agent.kind === 'issuer'
        ? 'write_card'
        : agent.kind === 'access_gateway'
          ? 'activate_access'
          : 'sync_legacy';
      return {
        task: {
          action,
          itemId: item.id,
          batchId: batch.id,
          leaseExpiresAt: leaseExpiresAt.toISOString(),
          attempt: item.attempts,
          address: batch.addressSnapshot,
          roomKey: batch.legacyRoomKey,
          batchSequence: item.sequence,
          projectPhase: batch.projectPhase,
          accessSystem: batch.accessSystem,
          icCardNo: item.icCardNo,
          wgCardNo: item.wgCardNo,
          targetBuildingIds: batch.targetBuildingIds,
          targetBuildings: batch.targetBuildingIds.map((buildingId) => {
            const building = targetBuildings.find((candidate) => candidate.id === buildingId);
            if (!building) throw new BadRequestException(`门禁目标楼栋 ${buildingId} 不存在`);
            return {
              id: building.id,
              buildingNo: building.buildingNo,
              accessSystem: accessSystemOf(batch.projectPhase, building.buildingNo),
            };
          }),
          cardTemplateVersion: this.config.get<string>('ACCESS_CARD_TEMPLATE_VERSION', 'pending-validation'),
        },
      };
    });
  }

  async claimLegacyHistory(agentKey: string, token: string) {
    const agent = await this.authenticateAgent(agentKey, token);
    if (agent.kind !== 'legacy_sync') throw new ForbiddenException('只有 .80 旧库同步代理可以查询历史');
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + 60_000);
    return this.legacySnapshotRepo.manager.transaction(async (manager) => {
      const repo = manager.getRepository(AccessCardLegacySnapshot);
      const snapshot = await repo.createQueryBuilder('snapshot')
        .where('snapshot.tenant_id = :tenantId', { tenantId: agent.tenantId })
        .andWhere('snapshot.status = :status', { status: 'pending' })
        .andWhere('(snapshot.lease_expires_at IS NULL OR snapshot.lease_expires_at < :now)', { now })
        .orderBy('snapshot.requested_at', 'ASC')
        .setLock('pessimistic_write')
        .setOnLocked('skip_locked')
        .getOne();
      if (!snapshot) return { task: null, retryAfterMs: 2500 };
      snapshot.leaseAgentKey = agent.agentKey;
      snapshot.leaseExpiresAt = leaseExpiresAt;
      await repo.save(snapshot);
      return {
        task: {
          action: 'query_legacy_history',
          snapshotId: snapshot.id,
          roomKey: snapshot.roomKey,
          leaseExpiresAt: leaseExpiresAt.toISOString(),
        },
      };
    });
  }

  async cardPreflight(agentKey: string, token: string, dto: CardPreflightDto) {
    const agent = await this.authenticateAgent(agentKey, token);
    if (agent.kind !== 'issuer') throw new ForbiddenException('只有发卡助手可以执行卡片预检');
    const icCardNo = this.normalizeIcCardNo(dto.icCardNo);
    const item = await this.itemRepo.findOne({
      where: { id: dto.itemId, tenantId: agent.tenantId },
      relations: ['batch'],
    });
    if (!item) throw new NotFoundException('发卡任务不存在');
    if (item.leaseAgentKey !== agent.agentKey) throw new ForbiddenException('任务租约不属于当前发卡助手');
    if (item.cardStatus === 'duplicate_card') {
      return { status: 'duplicate', message: item.lastErrorMessage };
    }

    const pmsDuplicate = await this.itemRepo
      .createQueryBuilder('other')
      .innerJoinAndSelect('other.batch', 'batch')
      .where('other.tenant_id = :tenantId', { tenantId: agent.tenantId })
      .andWhere('other.ic_card_no = :icCardNo', { icCardNo })
      .andWhere('other.id <> :itemId', { itemId: item.id })
      .getOne();
    if (pmsDuplicate) {
      const message = `这张卡已在 PMS 发过：${pmsDuplicate.batch.addressSnapshot}，IC 卡号 ${icCardNo}，不能重复发卡。`;
      await this.blockDuplicateCard(item, message);
      return { status: 'duplicate', message };
    }

    let check = await this.legacyCardCheckRepo.findOne({ where: { itemId: item.id } });
    if (!check) {
      check = await this.legacyCardCheckRepo.save(this.legacyCardCheckRepo.create({
        tenantId: agent.tenantId,
        itemId: item.id,
        icCardNo,
        status: 'pending',
        matches: [],
        requestedAt: new Date(),
        checkedAt: null,
        leaseAgentKey: null,
        leaseExpiresAt: null,
        lastError: null,
        createdBy: null,
        updatedBy: null,
      }));
      return { status: 'pending', message: '正在查询捷顺系统是否已登记这张卡' };
    }
    if (check.icCardNo !== icCardNo) {
      check.icCardNo = icCardNo;
      check.status = 'pending';
      check.matches = [];
      check.requestedAt = new Date();
      check.checkedAt = null;
      check.leaseAgentKey = null;
      check.leaseExpiresAt = null;
      check.lastError = null;
      await this.legacyCardCheckRepo.save(check);
      return { status: 'pending', message: '正在查询捷顺系统是否已登记这张卡' };
    }
    if (check.status === 'pending') {
      return { status: 'pending', message: '正在查询捷顺系统是否已登记这张卡' };
    }
    if (check.status === 'error') {
      return { status: 'error', message: check.lastError || '捷顺系统查重失败，已停止写卡' };
    }
    if (check.status === 'duplicate') {
      const message = legacyDuplicateCardMessage(check.matches);
      await this.blockDuplicateCard(item, message);
      return { status: 'duplicate', message, matches: check.matches };
    }
    return { status: 'clear', message: '卡号未在 PMS 或捷顺系统登记，可以继续写卡' };
  }

  async claimLegacyCardCheck(agentKey: string, token: string) {
    const agent = await this.authenticateAgent(agentKey, token);
    if (agent.kind !== 'legacy_sync') throw new ForbiddenException('只有 .80 旧库同步代理可以查询捷顺卡号');
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + 60_000);
    return this.legacyCardCheckRepo.manager.transaction(async (manager) => {
      const repo = manager.getRepository(AccessCardLegacyCardCheck);
      const check = await repo.createQueryBuilder('check')
        .where('check.tenant_id = :tenantId', { tenantId: agent.tenantId })
        .andWhere('check.status = :status', { status: 'pending' })
        .andWhere('(check.lease_expires_at IS NULL OR check.lease_expires_at < :now)', { now })
        .orderBy('check.requested_at', 'ASC')
        .setLock('pessimistic_write')
        .setOnLocked('skip_locked')
        .getOne();
      if (!check) return { task: null, retryAfterMs: 1000 };
      check.leaseAgentKey = agent.agentKey;
      check.leaseExpiresAt = leaseExpiresAt;
      await repo.save(check);
      return { task: { checkId: check.id, icCardNo: check.icCardNo, leaseExpiresAt: leaseExpiresAt.toISOString() } };
    });
  }

  async reportLegacyCardCheck(agentKey: string, token: string, dto: LegacyCardCheckReportDto) {
    const agent = await this.authenticateAgent(agentKey, token);
    if (agent.kind !== 'legacy_sync') throw new ForbiddenException('只有 .80 旧库同步代理可以上报捷顺卡号查询');
    const check = await this.legacyCardCheckRepo.findOne({ where: { id: dto.checkId, tenantId: agent.tenantId } });
    if (!check) throw new NotFoundException('捷顺卡号查询任务不存在');
    if (check.leaseAgentKey !== agent.agentKey) throw new ForbiddenException('查询任务租约不属于当前代理');
    if (dto.result === 'success') {
      check.matches = (dto.matches ?? []).map((match) => ({
        personId: match.personId,
        personNo: match.personNo.trim(),
        personName: match.personName.trim(),
        icCardNo: this.normalizeIcCardNo(match.icCardNo),
        issuedAt: match.issuedAt || null,
      }));
      check.status = check.matches.length ? 'duplicate' : 'clear';
      check.lastError = null;
    } else {
      check.status = dto.result === 'retry' ? 'pending' : 'error';
      check.lastError = dto.errorMessage || '捷顺系统卡号查询失败';
    }
    check.checkedAt = new Date();
    check.leaseAgentKey = null;
    check.leaseExpiresAt = null;
    await this.legacyCardCheckRepo.save(check);
    return { ok: true, checkId: check.id, status: check.status };
  }

  async reportLegacyHistory(agentKey: string, token: string, dto: LegacyHistoryReportDto) {
    const agent = await this.authenticateAgent(agentKey, token);
    if (agent.kind !== 'legacy_sync') throw new ForbiddenException('只有 .80 旧库同步代理可以上报历史');
    const snapshot = await this.legacySnapshotRepo.findOne({
      where: { id: dto.snapshotId, tenantId: agent.tenantId },
    });
    if (!snapshot) throw new NotFoundException('历史查询任务不存在');
    if (snapshot.leaseAgentKey !== agent.agentKey) throw new ForbiddenException('历史查询租约不属于当前代理');
    if (dto.result === 'success') {
      const history = dto.history ?? [];
      snapshot.history = history.map((row) => ({
        personId: row.personId,
        personNo: row.personNo,
        sequence: row.sequence,
        icCardNo: row.icCardNo?.toUpperCase() || null,
        issuedAt: row.issuedAt || null,
      }));
      snapshot.issuedCount = dto.issuedCount ?? history.length;
      snapshot.nextSequence = dto.nextSequence ?? Math.max(0, ...history.map((row) => row.sequence)) + 1;
      snapshot.status = 'ready';
      snapshot.refreshedAt = new Date();
      snapshot.lastError = null;
    } else {
      snapshot.status = dto.result === 'retry' ? 'pending' : 'error';
      snapshot.lastError = dto.errorMessage || '.80 历史查询失败';
    }
    snapshot.leaseAgentKey = null;
    snapshot.leaseExpiresAt = null;
    snapshot.updatedBy = null;
    await this.legacySnapshotRepo.save(snapshot);
    return { ok: true, snapshotId: snapshot.id };
  }

  async claimHistoryAuthorization(agentKey: string, token: string) {
    const agent = await this.authenticateAgent(agentKey, token);
    if (agent.kind !== 'access_gateway') throw new ForbiddenException('只有楼栋门禁网关可以执行历史卡片授权');
    if (agent.capabilities?.historicalAccessGrant !== true) return { task: null };
    const task = await this.authorizationRepo.manager.transaction(async (manager) => {
      const repo = manager.getRepository(AccessCardAuthorization);
      const now = new Date();
      const item = await repo.createQueryBuilder('task')
        .where('task.tenant_id = :tenantId', { tenantId: agent.tenantId })
        .andWhere("task.status = 'pending' OR (task.status = 'running' AND task.lease_expires_at < :now)", { now })
        .orderBy('task.created_at', 'ASC')
        .setLock('pessimistic_write')
        .setOnLocked('skip_locked')
        .getOne();
      if (!item) return null;
      if (item.attempt >= 3) {
        item.status = 'failed';
        item.lastError = item.lastError || '历史卡片追加权限连续失败，请检查门禁数据库和控制器连接';
        item.completedAt = now;
        item.leaseAgentKey = null;
        item.leaseExpiresAt = null;
        await repo.save(item);
        return null;
      }
      item.status = 'running';
      item.attempt += 1;
      item.leaseAgentKey = agent.agentKey;
      item.leaseExpiresAt = new Date(now.getTime() + 90_000);
      item.updatedBy = null;
      await repo.save(item);
      return {
        taskId: item.id,
        action: 'authorize_existing_card',
        address: item.roomKey,
        roomKey: item.roomKey,
        projectPhase: 'phase2',
        icCardNo: item.icCardNo,
        wgCardNo: item.wgCardNo,
        targetBuildingIds: item.targetBuildings.map((building) => building.id),
        targetBuildings: item.targetBuildings,
      };
    });
    return { task };
  }

  async reportHistoryAuthorization(agentKey: string, token: string, dto: AccessCardAuthorizationReportDto) {
    const agent = await this.authenticateAgent(agentKey, token);
    if (agent.kind !== 'access_gateway') throw new ForbiddenException('只有楼栋门禁网关可以上报历史卡片授权');
    await this.authorizationRepo.manager.transaction(async (manager) => {
      const repo = manager.getRepository(AccessCardAuthorization);
      const task = await repo.findOne({ where: { id: dto.taskId, tenantId: agent.tenantId } });
      if (!task) throw new NotFoundException('历史卡片授权任务不存在');
      if (task.status !== 'running' || task.leaseAgentKey !== agent.agentKey) {
        throw new BadRequestException('历史卡片授权任务不属于当前网关或已经结束');
      }
      const now = new Date();
      if (dto.result === 'success') {
        const reportedBuildings = new Set((dto.controllerResults ?? [])
          .map((row) => normalizeBuildingNo(typeof row.buildingNo === 'string' ? row.buildingNo : ''))
          .filter(Boolean));
        const missing = task.targetBuildings.filter((building) =>
          !reportedBuildings.has(normalizeBuildingNo(building.buildingNo)));
        if (missing.length) {
          throw new BadRequestException(`控制器结果缺少 ${missing.map((item) => `${item.buildingNo}号楼`).join('、')}，任务不能标记完成`);
        }
        task.status = 'completed';
        task.controllerResults = dto.controllerResults ?? [];
        task.lastError = null;
        task.completedAt = now;

        const snapshotRepo = manager.getRepository(AccessCardLegacySnapshot);
        const snapshot = await snapshotRepo.findOne({ where: { tenantId: task.tenantId, roomKey: task.roomKey } });
        if (snapshot) {
          const targetNos = new Set(task.targetBuildings.map((item) => normalizeBuildingNo(item.buildingNo)));
          const kept = snapshot.permissions.filter((row) =>
            row.wgCardNo !== task.wgCardNo || !targetNos.has(normalizeBuildingNo(row.buildingNo || '')));
          const additions: AccessCardPermissionEntry[] = task.controllerResults
            .map((row) => ({
              wgCardNo: task.wgCardNo,
              accessSystem: row.accessSystem === 'iccard' ? 'iccard' as const : 'mjsystem' as const,
              buildingNo: typeof row.buildingNo === 'string' ? row.buildingNo : null,
              controller: typeof row.controller === 'string' ? row.controller : null,
              door: typeof row.door === 'string' ? row.door : '楼栋门禁',
              sourceTable: row.accessSystem === 'iccard' ? 't_d_Privilege' as const : 'MJ_MacPower' as const,
            }))
            .filter((row) => row.buildingNo && targetNos.has(normalizeBuildingNo(row.buildingNo)));
          snapshot.permissions = [...kept, ...additions];
          snapshot.permissionStatus = 'ready';
          snapshot.permissionRefreshedAt = now;
          snapshot.permissionLastError = null;
          snapshot.updatedBy = null;
          await snapshotRepo.save(snapshot);
        }
      } else if (dto.result === 'retry' && task.attempt < 3) {
        task.status = 'pending';
        task.lastError = dto.errorMessage?.trim() || '门禁网关暂时无法追加权限，正在重试';
      } else {
        task.status = 'failed';
        task.lastError = dto.errorMessage?.trim() || '历史卡片追加权限失败';
        task.completedAt = now;
      }
      task.leaseAgentKey = null;
      task.leaseExpiresAt = null;
      task.updatedBy = null;
      await repo.save(task);
    });
    return { ok: true };
  }

  async claimAccessPermissions(agentKey: string, token: string) {
    const agent = await this.authenticateAgent(agentKey, token);
    if (agent.kind !== 'access_gateway') throw new ForbiddenException('只有楼栋门禁网关可以查询卡片权限');
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + 60_000);
    return this.legacySnapshotRepo.manager.transaction(async (manager) => {
      const repo = manager.getRepository(AccessCardLegacySnapshot);
      const snapshot = await repo.createQueryBuilder('snapshot')
        .where('snapshot.tenant_id = :tenantId', { tenantId: agent.tenantId })
        .andWhere('snapshot.permission_status = :status', { status: 'pending' })
        .andWhere('(snapshot.permission_lease_expires_at IS NULL OR snapshot.permission_lease_expires_at < :now)', { now })
        .orderBy('snapshot.permission_requested_at', 'ASC')
        .setLock('pessimistic_write')
        .setOnLocked('skip_locked')
        .getOne();
      if (!snapshot) return { task: null, retryAfterMs: 2500 };
      snapshot.permissionStatus = 'running';
      snapshot.permissionLeaseAgentKey = agent.agentKey;
      snapshot.permissionLeaseExpiresAt = leaseExpiresAt;
      await repo.save(snapshot);
      return {
        task: {
          action: 'query_access_permissions',
          snapshotId: snapshot.id,
          cards: snapshot.permissionSubjects,
          leaseExpiresAt: leaseExpiresAt.toISOString(),
        },
      };
    });
  }

  async reportAccessPermissions(agentKey: string, token: string, dto: AccessPermissionReportDto) {
    const agent = await this.authenticateAgent(agentKey, token);
    if (agent.kind !== 'access_gateway') throw new ForbiddenException('只有楼栋门禁网关可以上报卡片权限');
    const snapshot = await this.legacySnapshotRepo.findOne({
      where: { id: dto.snapshotId, tenantId: agent.tenantId },
    });
    if (!snapshot) throw new NotFoundException('卡片权限查询任务不存在');
    if (snapshot.permissionLeaseAgentKey !== agent.agentKey) {
      throw new ForbiddenException('卡片权限查询租约不属于当前代理');
    }
    if (dto.result === 'success') {
      const requestedCards = new Set(snapshot.permissionSubjects.map((item) => item.wgCardNo));
      snapshot.permissions = (dto.permissions ?? [])
        .map((row) => ({
          wgCardNo: row.wgCardNo.trim(),
          accessSystem: row.accessSystem,
          buildingNo: row.buildingNo?.trim() || null,
          controller: row.controller?.trim() || null,
          door: row.door.trim(),
          sourceTable: row.sourceTable,
        }))
        .filter((row) => requestedCards.has(row.wgCardNo) && row.door.length > 0);
      snapshot.permissionStatus = 'ready';
      snapshot.permissionRefreshedAt = new Date();
      snapshot.permissionLastError = null;
    } else {
      snapshot.permissionStatus = dto.result === 'retry' ? 'pending' : 'error';
      snapshot.permissionLastError = dto.errorMessage?.trim() || '楼栋门禁权限查询失败';
    }
    snapshot.permissionLeaseAgentKey = null;
    snapshot.permissionLeaseExpiresAt = null;
    snapshot.updatedBy = null;
    await this.legacySnapshotRepo.save(snapshot);
    return { ok: true, snapshotId: snapshot.id, status: snapshot.permissionStatus };
  }

  async reportAgentTask(agentKey: string, token: string, dto: AgentReportDto) {
    const agent = await this.authenticateAgent(agentKey, token);
    if (agent.kind === 'parking_gateway') {
      throw new ForbiddenException('停车网关不能上报门禁发卡任务');
    }
    const item = await this.itemRepo.findOne({
      where: { id: dto.itemId, tenantId: agent.tenantId },
      relations: ['batch'],
    });
    if (!item) throw new NotFoundException('代理任务不存在');
    if (item.leaseAgentKey !== agent.agentKey) throw new ForbiddenException('任务租约不属于当前代理');

    if (dto.result === 'access_db_written') {
      if (agent.kind !== 'access_gateway') {
        throw new BadRequestException('只有楼栋门禁助手可以上报门禁数据库写入');
      }
      item.accessStatus = 'access_db_written';
      item.controllerResults = dto.controllerResults ?? [];
      item.lastErrorRef = null;
      item.lastErrorMessage = '门禁数据库已写入，等待控制器上传';
    } else if (dto.result === 'success') {
      if (agent.kind === 'issuer') {
        const icCardNo = this.normalizeIcCardNo(dto.icCardNo || '');
        const duplicate = await this.itemRepo
          .createQueryBuilder('item')
          .where('item.tenant_id = :tenantId', { tenantId: agent.tenantId })
          .andWhere('item.ic_card_no = :icCardNo', { icCardNo })
          .andWhere('item.id <> :itemId', { itemId: item.id })
          .getExists();
        if (duplicate) {
          await this.blockDuplicateCard(item, `这张卡已在 PMS 登记：IC 卡号 ${icCardNo}，本次已停止，不会重复写卡。`);
          return { ok: false, itemId: item.id, status: 'duplicate_card', message: item.lastErrorMessage };
        }
        item.icCardNo = icCardNo;
        item.wgCardNo = item.batch.projectPhase === 'phase2' ? icToWg(icCardNo) : null;
        item.cardStatus = 'card_completed';
        item.cardCompletedAt = new Date();
      } else if (agent.kind === 'access_gateway') {
        if (item.cardStatus !== 'card_completed') throw new BadRequestException('实体卡尚未完成，不能同步门禁');
        item.accessStatus = 'controller_uploaded';
        item.accessCompletedAt = new Date();
        item.controllerResults = dto.controllerResults ?? [];
      } else {
        if (!dto.legacyPersonNo || !dto.legacyHouseSequence) {
          throw new BadRequestException('.80 同步服务必须返回旧系统编号和房号累计序号');
        }
        item.legacyPersonNo = dto.legacyPersonNo;
        item.legacyHouseSequence = dto.legacyHouseSequence;
        item.legacySyncStatus = 'synced';
        item.legacySyncedAt = new Date();
      }
      item.lastErrorRef = null;
      item.lastErrorMessage = null;
    } else {
      item.lastErrorRef = dto.errorRef || randomBytes(4).toString('hex').toUpperCase();
      item.lastErrorMessage = dto.errorMessage || '代理执行失败';
      if (agent.kind === 'issuer') {
        item.cardStatus = 'waiting_for_card';
        item.batch.status = dto.result === 'retry' ? 'waiting_for_card' : 'needs_operator';
      } else if (agent.kind === 'access_gateway') {
        item.accessStatus = dto.result === 'retry' ? 'waiting_retry' : 'needs_operator';
      } else {
        item.legacySyncStatus = dto.result === 'retry' ? 'waiting_retry' : 'conflict';
      }
    }
    item.leaseAgentKey = null;
    item.leaseExpiresAt = null;
    item.updatedBy = null;
    await this.itemRepo.save(item);
    await this.refreshBatchStatus(item.batch, agent.tenantId);
    return { ok: true, itemId: item.id };
  }

  async create(dto: CreateAccessCardIssueDto, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    const existing = await this.batchRepo.findOne({
      where: { idempotencyKey: dto.idempotencyKey },
    });
    if (existing) {
      if (existing.tenantId !== tenantId) throw new ForbiddenException('任务幂等键已被占用');
      return this.getBatch(existing.id, user);
    }

    const context = await this.resolveHouse(dto.houseId, tenantId, access);
    if (context.phase === 'phase2' && !context.accessSystem) {
      throw new BadRequestException(`二期 ${context.building.buildingNo} 号楼尚未配置门禁路由，不能发卡`);
    }
    if (context.phase === 'phase1' && dto.extraBuildingIds?.length) {
      throw new BadRequestException('枫桦景苑一期只写卡，不需要选择额外门禁楼栋');
    }

    const extraIds = Array.from(new Set(dto.extraBuildingIds ?? []))
      .filter((id) => id !== context.building.id);
    const extras = extraIds.length
      ? await this.buildingRepo.find({ where: { id: In(extraIds), tenantId } })
      : [];
    if (extras.length !== extraIds.length || extras.some((item) => !belongsToSameAccessArea(context.building, item))) {
      const area = context.building.lane ? `${context.building.lane}弄` : context.community.name;
      throw new BadRequestException(`额外楼栋必须属于当前小区的 ${area} 门禁区域`);
    }
    const unmapped = extras.find((item) => !accessSystemOf(context.phase, item.buildingNo));
    if (unmapped) throw new BadRequestException(`${unmapped.buildingNo} 号楼尚未配置门禁路由`);

    const targetBuildingIds = context.phase === 'phase2'
      ? [context.building.id, ...extraIds]
      : [];
    const created = await this.batchRepo.manager.transaction(async (manager) => {
      const batch = await manager.save(
        manager.create(AccessCardIssueBatch, {
          tenantId,
          houseId: context.house.id,
          communityId: context.community.id,
          buildingId: context.building.id,
          legacyRoomKey: context.legacyStorageRoomKey,
          addressSnapshot: context.roomKey,
          projectPhase: context.phase,
          accessSystem: context.accessSystem,
          quantity: dto.quantity,
          targetBuildingIds,
          workstationId: dto.workstationId ?? null,
          status: 'waiting_for_card',
          currentSequence: 1,
          idempotencyKey: dto.idempotencyKey,
          completedAt: null,
          createdBy: user.id,
          updatedBy: user.id,
        }),
      );
      const items = Array.from({ length: dto.quantity }, (_, index) =>
        manager.create(AccessCardIssueItem, {
          tenantId,
          batchId: batch.id,
          sequence: index + 1,
          cardStatus: 'waiting_for_card',
          accessStatus: context.phase === 'phase1' ? 'not_required' : 'pending',
          legacySyncStatus: 'pending',
          icCardNo: null,
          wgCardNo: null,
          legacyPersonId: null,
          legacyPersonNo: null,
          controllerResults: [],
          lastErrorRef: null,
          lastErrorMessage: null,
          cardCompletedAt: null,
          accessCompletedAt: null,
          legacySyncedAt: null,
          createdBy: user.id,
          updatedBy: user.id,
        }),
      );
      await manager.save(items);
      return batch;
    });
    return this.getBatch(created.id, user);
  }

  async getBatch(id: number, user: AuthUser) {
    const tenantId = this.requireTenant(user);
    const batch = await this.batchRepo.findOne({ where: { id, tenantId } });
    if (!batch) throw new NotFoundException('发卡任务不存在');
    const items = await this.itemRepo.find({
      where: { batchId: id, tenantId },
      order: { sequence: 'ASC' },
    });
    return { ...batch, items, deliverable: this.isDeliverable(batch, items) };
  }

  /** 只重试楼栋门禁控制器下发，不重复写实体卡或旧库人员数据。 */
  async retryAccessUpload(batchId: number, itemId: number, user: AuthUser) {
    const tenantId = this.requireTenant(user);
    const item = await this.itemRepo.findOne({ where: { id: itemId, batchId, tenantId } });
    if (!item) throw new NotFoundException('发卡记录不存在');
    if (!['waiting_retry', 'needs_operator'].includes(item.accessStatus)) {
      throw new BadRequestException('当前门禁下载状态不需要重试');
    }
    item.accessStatus = 'waiting_retry';
    item.lastErrorRef = null;
    item.lastErrorMessage = null;
    item.leaseAgentKey = null;
    item.leaseExpiresAt = null;
    item.updatedBy = user.id;
    await this.itemRepo.save(item);
    return this.getBatch(batchId, user);
  }

  /** 开发/验收环境模拟实体卡、二期数据库和控制器全部成功。生产环境不可调用。 */
  async simulateNext(id: number, user: AuthUser) {
    this.assertSimulation();
    const tenantId = this.requireTenant(user);
    const batch = await this.batchRepo.findOne({ where: { id, tenantId } });
    if (!batch) throw new NotFoundException('发卡任务不存在');
    if (batch.status === 'completed') return this.getBatch(id, user);
    const item = await this.itemRepo.findOne({
      where: { batchId: id, tenantId, cardStatus: 'waiting_for_card' },
      order: { sequence: 'ASC' },
    });
    if (!item) throw new BadRequestException('没有等待放卡的项目');

    const icCardNo = await this.nextSimulationIc(tenantId);
    item.cardStatus = 'card_completed';
    item.icCardNo = icCardNo;
    item.wgCardNo = batch.projectPhase === 'phase2' ? icToWg(icCardNo) : null;
    item.cardCompletedAt = new Date();
    item.updatedBy = user.id;
    if (batch.projectPhase === 'phase2') {
      item.accessStatus = 'controller_uploaded';
      item.accessCompletedAt = new Date();
      item.controllerResults = batch.targetBuildingIds.map((buildingId) => ({
        buildingId,
        status: 'uploaded',
        simulated: true,
      }));
    }
    await this.itemRepo.save(item);

    const remaining = await this.itemRepo.count({
      where: { batchId: id, tenantId, cardStatus: 'waiting_for_card' },
    });
    batch.status = remaining ? 'waiting_for_card' : 'completed';
    batch.currentSequence = remaining ? item.sequence + 1 : item.sequence;
    batch.completedAt = remaining ? null : new Date();
    batch.updatedBy = user.id;
    await this.batchRepo.save(batch);
    return this.getBatch(id, user);
  }

  /** 模拟 .80 异步归档，证明“可交付”和“旧库同步”是两个状态。 */
  async simulateLegacySync(id: number, user: AuthUser) {
    this.assertSimulation();
    const tenantId = this.requireTenant(user);
    const items = await this.itemRepo.find({ where: { batchId: id, tenantId } });
    if (!items.length) throw new NotFoundException('发卡任务不存在');
    let nextNo = 11250 + (await this.itemRepo.count({ where: { tenantId } }));
    for (const item of items) {
      if (item.cardStatus !== 'card_completed' || item.legacySyncStatus === 'synced') continue;
      nextNo += 1;
      item.legacyPersonNo = String(nextNo);
      item.legacySyncStatus = 'synced';
      item.legacySyncedAt = new Date();
      item.updatedBy = user.id;
    }
    await this.itemRepo.save(items);
    return this.getBatch(id, user);
  }

  private async historyForHouse(houseId: number, tenantId: number) {
    const rows = await this.itemRepo
      .createQueryBuilder('item')
      .innerJoinAndSelect('item.batch', 'batch')
      .where('item.tenant_id = :tenantId', { tenantId })
      .andWhere('batch.house_id = :houseId', { houseId })
      .andWhere('item.card_status = :status', { status: 'card_completed' })
      .orderBy('item.card_completed_at', 'ASC', 'NULLS LAST')
      .addOrderBy('item.id', 'ASC')
      .getMany();
    return rows
      .map((item, index) => ({
        id: item.id,
        sequence: item.legacyHouseSequence ?? index + 1,
        legacyPersonNo: item.legacyPersonNo,
        icCardNo: item.icCardNo,
        wgCardNo: item.wgCardNo,
        issuedAt: item.cardCompletedAt,
        accessStatus: item.accessStatus,
        legacySyncStatus: item.legacySyncStatus,
        controllerResults: item.controllerResults,
      }))
      .reverse();
  }

  private async requestLegacyHistory(tenantId: number, roomKey: string, userId: number) {
    const now = new Date();
    let snapshot = await this.legacySnapshotRepo.findOne({ where: { tenantId, roomKey } });
    if (!snapshot) {
      snapshot = await this.legacySnapshotRepo.save(this.legacySnapshotRepo.create({
        tenantId,
        roomKey,
        status: 'pending',
        history: [],
        issuedCount: 0,
        nextSequence: 1,
        requestedAt: now,
        refreshedAt: null,
        leaseAgentKey: null,
        leaseExpiresAt: null,
        lastError: null,
        permissionStatus: 'idle',
        permissionSubjects: [],
        permissions: [],
        permissionRequestedAt: null,
        permissionRefreshedAt: null,
        permissionLeaseAgentKey: null,
        permissionLeaseExpiresAt: null,
        permissionLastError: null,
        createdBy: userId,
        updatedBy: userId,
      }));
      return snapshot;
    }
    const stale = !snapshot.refreshedAt || now.getTime() - snapshot.refreshedAt.getTime() > 30_000;
    if (stale && snapshot.status !== 'pending') {
      snapshot.status = 'pending';
      snapshot.requestedAt = now;
      snapshot.lastError = null;
      snapshot.updatedBy = userId;
      await this.legacySnapshotRepo.save(snapshot);
    }
    return snapshot;
  }

  private permissionSubjects(
    pmsHistory: Array<{ icCardNo: string | null; wgCardNo: string | null }>,
    legacyHistory: AccessCardLegacySnapshot['history'],
  ): AccessCardPermissionSubject[] {
    const subjects = new Map<string, AccessCardPermissionSubject>();
    const add = (icCardNo: string | null, wgCardNo: string | null) => {
      const normalizedIc = icCardNo?.trim().toUpperCase() || '';
      let normalizedWg = wgCardNo?.trim() || '';
      if (!normalizedWg && /^[0-9A-F]{8}$/.test(normalizedIc)) normalizedWg = icToWg(normalizedIc);
      if (!normalizedWg) return;
      subjects.set(normalizedWg, { icCardNo: normalizedIc, wgCardNo: normalizedWg });
    };
    pmsHistory.forEach((row) => add(row.icCardNo, row.wgCardNo));
    legacyHistory.forEach((row) => add(row.icCardNo, null));
    return Array.from(subjects.values()).sort((a, b) =>
      a.wgCardNo.localeCompare(b.wgCardNo, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' }));
  }

  private async requestAccessPermissions(
    snapshot: AccessCardLegacySnapshot,
    subjects: AccessCardPermissionSubject[],
    userId: number,
  ) {
    const now = new Date();
    const subjectSignature = JSON.stringify(subjects);
    const storedSignature = JSON.stringify(snapshot.permissionSubjects ?? []);
    const subjectsChanged = subjectSignature !== storedSignature;
    const stale = !snapshot.permissionRefreshedAt
      || now.getTime() - snapshot.permissionRefreshedAt.getTime() > 30_000;

    if (!subjects.length) {
      if (snapshot.permissionStatus !== 'ready' || snapshot.permissions.length) {
        snapshot.permissionStatus = 'ready';
        snapshot.permissionSubjects = [];
        snapshot.permissions = [];
        snapshot.permissionRequestedAt = now;
        snapshot.permissionRefreshedAt = now;
        snapshot.permissionLeaseAgentKey = null;
        snapshot.permissionLeaseExpiresAt = null;
        snapshot.permissionLastError = null;
        snapshot.updatedBy = userId;
        return this.legacySnapshotRepo.save(snapshot);
      }
      return snapshot;
    }

    if (subjectsChanged || (stale && !['pending', 'running'].includes(snapshot.permissionStatus))) {
      snapshot.permissionStatus = 'pending';
      snapshot.permissionSubjects = subjects;
      if (subjectsChanged) snapshot.permissions = [];
      snapshot.permissionRequestedAt = now;
      snapshot.permissionLeaseAgentKey = null;
      snapshot.permissionLeaseExpiresAt = null;
      snapshot.permissionLastError = null;
      snapshot.updatedBy = userId;
      return this.legacySnapshotRepo.save(snapshot);
    }
    return snapshot;
  }

  private mergeHistory(
    pmsHistory: Array<{
      id: number;
      sequence: number;
      legacyPersonNo: string | null;
      icCardNo: string | null;
      wgCardNo: string | null;
      issuedAt: string | Date | null;
      accessStatus: string;
      legacySyncStatus: string;
      controllerResults: Array<Record<string, unknown>>;
    }>,
    legacyHistory: AccessCardLegacySnapshot['history'],
    phase: 'phase1' | 'phase2',
    permissionStatus: AccessCardLegacySnapshot['permissionStatus'],
    permissions: AccessCardPermissionEntry[],
  ) {
    const permissionsByCard = new Map<string, AccessCardPermissionEntry[]>();
    for (const permission of permissions) {
      const key = permission.wgCardNo.trim();
      const rows = permissionsByCard.get(key) ?? [];
      rows.push(permission);
      permissionsByCard.set(key, rows);
    }
    const withVerifiedPermissions = (row: (typeof pmsHistory)[number]) => {
      if (phase === 'phase1') return row;
      const cardPermissions = row.wgCardNo ? permissionsByCard.get(row.wgCardNo.trim()) ?? [] : [];
      return {
        ...row,
        accessStatus: verifiedHistoryAccessStatus(phase, permissionStatus, cardPermissions.length),
        controllerResults: cardPermissions,
      };
    };
    const byIc = new Map<string, (typeof pmsHistory)[number]>();
    for (const row of pmsHistory) {
      if (row.icCardNo) byIc.set(row.icCardNo.toUpperCase(), row);
    }
    const merged = legacyHistory
      .filter((row) => row.icCardNo)
      .map<(typeof pmsHistory)[number]>((row) => {
        const existing = row.icCardNo ? byIc.get(row.icCardNo.toUpperCase()) : undefined;
        if (existing) {
          byIc.delete(row.icCardNo!.toUpperCase());
          return withVerifiedPermissions({
            ...existing,
            sequence: row.sequence,
            legacyPersonNo: row.personNo,
            issuedAt: row.issuedAt || existing.issuedAt,
            legacySyncStatus: 'synced',
          });
        }
        return withVerifiedPermissions({
          id: -row.personId,
          sequence: row.sequence,
          legacyPersonNo: row.personNo,
          icCardNo: row.icCardNo,
          wgCardNo: phase === 'phase2' && row.icCardNo ? icToWg(row.icCardNo) : null,
          issuedAt: row.issuedAt,
          accessStatus: phase === 'phase1' ? 'not_required' : 'permission_check_pending',
          legacySyncStatus: 'synced',
          controllerResults: [],
        });
      });
    merged.push(...Array.from(byIc.values()).map(withVerifiedPermissions));
    return sortAccessCardHistoryNewestFirst(merged);
  }

  private async authenticateAgent(agentKey: string, token: string): Promise<AccessCardAgent> {
    if (!agentKey || !token) throw new UnauthorizedException('缺少代理凭据');
    const agent = await this.agentRepo.findOne({ where: { agentKey, enabled: true } });
    if (!agent || !agentTokenMatches(token, agent.tokenHash)) {
      throw new UnauthorizedException('代理凭据无效');
    }
    return agent;
  }

  private async refreshBatchStatus(batch: AccessCardIssueBatch, tenantId: number) {
    const items = await this.itemRepo.find({ where: { batchId: batch.id, tenantId } });
    if (items.some((item) => item.cardStatus === 'duplicate_card' || item.accessStatus === 'needs_operator')) {
      batch.status = 'needs_operator';
    } else if (this.isDeliverable(batch, items)) {
      batch.status = 'completed';
      batch.completedAt = batch.completedAt ?? new Date();
    } else if (items.some((item) => item.cardStatus === 'waiting_for_card')) {
      batch.status = 'waiting_for_card';
    } else {
      batch.status = 'processing';
    }
    batch.updatedBy = null;
    await this.batchRepo.save(batch);
  }

  private async resolveHouse(
    houseId: number,
    tenantId: number,
    access?: ResolvedAccess,
  ): Promise<HouseContext> {
    const house = await this.houseRepo.findOne({ where: { id: houseId, tenantId } });
    if (!house) throw new NotFoundException('房号不存在');
    const building = await this.buildingRepo.findOne({
      where: { id: house.buildingId, tenantId },
    });
    if (!building) throw new NotFoundException('房号所属楼栋不存在');
    const community = await this.communityRepo.findOne({
      where: { id: building.communityId, tenantId },
    });
    if (!community) throw new NotFoundException('楼栋所属小区不存在');
    const scope = scopeCommunityIds(access);
    if (scope && !scope.includes(community.id)) throw new ForbiddenException('该房号不在你的管理范围内');
    const phase = projectPhaseOf(community.name);
    if (!phase) throw new BadRequestException('目前只支持枫桦景苑一期和二期发卡');
    return {
      house,
      building,
      community,
      phase,
      accessSystem: accessSystemOf(phase, building.buildingNo),
      roomKey: legacyRoomKey(building.lane, building.buildingNo, house.roomNo),
      legacyStorageRoomKey: legacyDatabaseRoomKey(building.lane, building.buildingNo, house.roomNo),
    };
  }

  private isDeliverable(batch: AccessCardIssueBatch, items: AccessCardIssueItem[]): boolean {
    if (items.length !== batch.quantity) return false;
    return items.every((item) => item.cardStatus === 'card_completed'
      && (batch.projectPhase === 'phase1' || item.accessStatus === 'controller_uploaded'));
  }

  private normalizeIcCardNo(value: string): string {
    const icCardNo = value.replace(/\s+/g, '').toUpperCase();
    if (!/^[0-9A-F]{6,}$/.test(icCardNo)) {
      throw new BadRequestException('发卡助手未返回有效 IC 卡号');
    }
    return icCardNo;
  }

  private async blockDuplicateCard(item: AccessCardIssueItem, message: string): Promise<void> {
    item.cardStatus = 'duplicate_card';
    item.lastErrorRef = randomBytes(4).toString('hex').toUpperCase();
    item.lastErrorMessage = message;
    item.leaseAgentKey = null;
    item.leaseExpiresAt = null;
    item.updatedBy = null;
    await this.itemRepo.save(item);
    item.batch.status = 'needs_operator';
    item.batch.updatedBy = null;
    await this.batchRepo.save(item.batch);
  }

  private async nextSimulationIc(tenantId: number): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const candidate = randomBytes(4).toString('hex').toUpperCase();
      const exists = await this.itemRepo.exist({ where: { tenantId, icCardNo: candidate } });
      if (!exists) return candidate;
    }
    throw new BadRequestException('模拟卡号生成冲突，请重试');
  }

  private simulationEnabled(): boolean {
    const configured = this.config.get<string>('ACCESS_CARD_SIMULATION');
    return configured ? configured === 'true' : this.config.get<string>('NODE_ENV') !== 'production';
  }

  private assertSimulation() {
    if (!this.simulationEnabled()) throw new ForbiddenException('生产环境未开放模拟发卡');
  }

  private requireTenant(user: AuthUser): number {
    if (!user.tenantId) throw new ForbiddenException('tenant scope is required');
    return user.tenantId;
  }
}

function normalizeParkingFieldName(value: string): string {
  return value.toLowerCase().replace(/[\s_\-./]/g, '');
}

function parkingFieldValue(
  fields: Record<string, string | number | boolean | null>,
  aliases: readonly string[],
): string | null {
  const entries = Object.entries(fields).filter(([, value]) => value !== null && String(value).trim() !== '');
  for (const alias of aliases) {
    const normalizedAlias = normalizeParkingFieldName(alias);
    const match = entries.find(([key]) => normalizeParkingFieldName(key).includes(normalizedAlias));
    if (match) return String(match[1]).trim();
  }
  return null;
}

function normalizeParkingPhone(value: string | null): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, '');
  return /^1\d{10}$/.test(digits) ? digits : null;
}

function normalizeParkingText(value: string | null | undefined): string | null {
  const result = value?.trim();
  return result || null;
}

function parkingExactFieldValue(
  fields: Record<string, string | number | boolean | null>,
  aliases: readonly string[],
): string | null {
  for (const alias of aliases) {
    const normalizedAlias = normalizeParkingFieldName(alias);
    const match = Object.entries(fields).find(([key, value]) =>
      value !== null && String(value).trim() !== '' && normalizeParkingFieldName(key) === normalizedAlias);
    if (match) return String(match[1]).trim();
  }
  return null;
}

function parkingSourceRecordId(fields: Record<string, string | number | boolean | null>): string | null {
  for (const alias of ['p_id', 'pid', 'issue_id', 'issueid', 'car_id', 'carid']) {
    const value = normalizeParkingSourceRecordId(parkingExactFieldValue(fields, [alias]));
    if (value) return value;
  }
  return null;
}

function parkingExternalOwnerId(fields: Record<string, string | number | boolean | null>): string | null {
  return parkingExactFieldValue(fields, ['owner_id', 'ownerid', '住户编号', '业主编号']);
}

function parkingSnapshotValues(fields: Record<string, string | number | boolean | null>): ParkingSnapshotValues {
  const owner = parkingLegacyOwnerValuesFromFields(fields);
  const room = parkingLegacyRoomFromName(owner.room) ?? owner.room;
  return {
    plate: normalizeParkingText(parkingFieldValue(fields, ['p_plate', 'carno', 'carcode', 'carnumber', 'plateno', 'plate', 'license', '车牌'])),
    ownerId: parkingExternalOwnerId(fields),
    ownerName: owner.name,
    phone: owner.phone,
    room,
    // P_note 属于 Car_Issue 车辆记录，不应因存在 Owner__ 字段而被住户表联查逻辑遮掉。
    note: normalizeParkingText(parkingFieldValue(fields, ['remark', 'remarks', 'note', 'pnote', '备注'])),
    plateChangedAt: normalizeParkingText(parkingExactFieldValue(fields, ['pmsmeta__platechangedat'])),
  };
}

function parkingOperationTime(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return null;
  // 防止异常旧库值把历史排序推到不可信的年代。
  const earliest = new Date('2000-01-01T00:00:00+08:00').getTime();
  const latest = Date.now() + 24 * 60 * 60 * 1000;
  return parsed.getTime() >= earliest && parsed.getTime() <= latest ? parsed : null;
}

function normalizeParkingOperationPayload(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value || {}).map(([key, item]) => [key, typeof item === 'string' ? item.trim() : item]));
}

function textValue(value: unknown): string | null {
  return value === null || value === undefined || String(value).trim() === '' ? null : String(value).trim();
}

function validateParkingOperation(
  kind: string,
  payload: Record<string, unknown>,
  expected: Record<string, unknown>,
  targetRecordId?: string,
) {
  const requireValue = (key: string, label: string) => { if (!textValue(payload[key])) throw new BadRequestException(`${label}不能为空`); };
  if (kind === 'add_vehicle') { requireValue('plate', '车牌'); requireValue('ownerName', '住户姓名'); requireValue('endDate', '到期日期'); }
  if (kind === 'renew_vehicle') { requireValue('plate', '车牌'); requireValue('endDate', '到期日期'); }
  if (kind === 'change_plate') { requireValue('plate', '原车牌'); requireValue('newPlate', '新车牌'); requireValue('ownerName', '住户姓名'); }
  if (kind === 'rebind_owner') { requireValue('plate', '车牌'); requireValue('ownerRoom', '新绑定房号'); requireValue('previousOwnerId', '当前旧库住户编号，请重新查询车辆'); }
  if (kind === 'update_garages') { requireValue('plate', '车牌'); requireValue('ownerName', '住户姓名'); if (!Object.prototype.hasOwnProperty.call(payload, 'effective')) throw new BadRequestException('请至少选择一个车库授权状态'); }
  if (kind === 'download_vehicle' || kind === 'delete_vehicle') requireValue('plate', '车牌');
  if (kind === 'sync_vehicle_info') {
    requireValue('plate', '车牌');
    requireValue('sourcePlate', '源库车牌');
    requireValue('targetPlate', '目标库车牌');
    requireValue('sourceDatabase', '源停车库');
    requireValue('sourceRecordId', '源车辆记录');
    if (!textValue(targetRecordId)) throw new BadRequestException('目标车辆记录不能为空');
    if (!['parking1', 'parking2'].includes(textValue(payload.sourceDatabase) || '')) {
      throw new BadRequestException('源停车库只能是 parking1 或 parking2');
    }
    const normalizePlate = (value: unknown) => (textValue(value) || '').replace(/[\s·]/g, '').toUpperCase();
    if (normalizePlate(payload.sourcePlate) !== normalizePlate(payload.targetPlate)) {
      throw new BadRequestException('只能同步一期、二期中的同一车牌');
    }
    if (!['room', 'endDate', 'note'].every((key) => Object.prototype.hasOwnProperty.call(expected, key))) {
      throw new BadRequestException('目标资料快照不完整，请重新查询后再同步');
    }
  }
}

function operationHistoryType(kind: ParkingOperation['kind']): ParkingHistoryEventType {
  if (kind === 'change_plate') return 'plate_change';
  if (kind === 'rebind_owner') return 'owner_rebind';
  if (kind === 'renew_vehicle') return 'vehicle_renewed';
  if (kind === 'update_garages') return 'garage_authorization';
  if (kind === 'delete_vehicle') return 'vehicle_deleted';
  if (kind === 'download_vehicle') return 'vehicle_download';
  if (kind === 'sync_vehicle_info') return 'vehicle_sync';
  return 'vehicle_added';
}

function operationSummary(task: ParkingOperation): string {
  const plate = textValue(task.payload.newPlate || task.payload.plate) || '未识别车牌';
  const labels: Record<string, string> = { add_vehicle: '新增车牌', renew_vehicle: '续期车牌', change_plate: '变更车牌', rebind_owner: '变更绑定用户', update_garages: '调整车库授权', download_vehicle: '下发停车设备', sync_vehicle_info: '同步一期二期停车资料', delete_vehicle: '注销车牌' };
  return `${labels[task.kind] || '停车操作'}：${plate}`;
}

function operationChanges(task: ParkingOperation): ParkingHistoryChange[] {
  const p = task.payload;
  if (task.kind === 'rebind_owner') return [{ field: 'owner', label: '绑定房号',
    before: textValue(task.result?.previousRoom), after: textValue(task.result?.targetRoom) }];
  if (task.kind === 'sync_vehicle_info') {
    const result = task.result ?? {};
    return [
      ['room', '房号', result.beforeRoom, result.afterRoom],
      ['endDate', '到期日期', result.beforeEndDate, result.afterEndDate],
      ['note', '备注', result.beforeNote, result.afterNote],
    ].filter(([, , before, after]) => textValue(before) !== null || textValue(after) !== null)
      .filter(([, , before, after]) => String(before ?? '') !== String(after ?? ''))
      .map(([field, label, before, after]) => ({ field: String(field), label: String(label), before: textValue(before), after: textValue(after) }));
  }
  const pairs: Array<[string, string, unknown, unknown]> = [
    ['plate', '车牌', p.plate, p.newPlate || p.plate],
    ['owner', '绑定用户', p.previousOwnerName || p.previousOwnerId, p.ownerName || p.ownerId],
    ['endDate', '到期日期', p.previousEndDate, p.endDate],
    ['effective', '车库授权', p.previousEffective, p.effective],
  ];
  return pairs.filter(([, , before, after]) => textValue(before) !== null || textValue(after) !== null)
    .filter(([, , before, after]) => String(before ?? '') !== String(after ?? ''))
    .map(([field, label, before, after]) => ({ field, label, before: textValue(before), after: textValue(after) }));
}

function sanitizeParkingRows(rows: ParkingQueryReportDto['rows']): ParkingQuery['rows'] {
  return (rows ?? []).slice(0, 100).map((row) => {
    const fields: Record<string, string | number | boolean | null> = {};
    // 旧助手曾把 Car_Issue 全部字段上传到这里，再按出现顺序截 60 个。
    // 住户联表字段排在后面时会在助手端或这里被截掉；接口只保留停车页面和
    // 住户匹配实际需要的白名单字段，且 Owner__ 字段永远优先于其它原始列。
    const entries = Object.entries(row.fields ?? {}).filter(([key]) => isParkingQueryFieldAllowed(key));
    const prioritized = [
      ...entries.filter(([key]) => key.startsWith('PmsMeta__')),
      ...entries.filter(([key]) => key.startsWith('Owner__')),
      ...entries.filter(([key]) => !key.startsWith('PmsMeta__') && !key.startsWith('Owner__')),
    ].slice(0, 60);
    for (const [rawKey, rawValue] of prioritized) {
      const key = rawKey.trim().slice(0, 128);
      if (!key || Object.prototype.hasOwnProperty.call(fields, key)) continue;
      if (rawValue === null || typeof rawValue === 'boolean') fields[key] = rawValue;
      else if (typeof rawValue === 'number' && Number.isFinite(rawValue)) fields[key] = rawValue;
      else if (typeof rawValue === 'string') fields[key] = rawValue.slice(0, 500);
    }
    return { database: row.database.trim().slice(0, 80), fields };
  });
}

const parkingVehicleOutputAliases = [
  'p_id', 'pid', 'issue_id', 'issueid', 'car_id', 'carid', 'owner_id', 'ownerid',
  'p_plate', 'pplate', 'carno', 'carcode', 'carnumber', 'plateno', 'plate', 'license', '车牌',
  'p_effective', 'peffective', 'p_download', 'pdownload', 'p_note', 'pnote', 'remark', 'remarks', 'note', '备注',
  'carbrand', 'carbeand', 'vehicleidentity', 'caridentity', 'ownertype', 'usertype', 'relationtype', 'carlei', '车辆类型', '车辆身份', '性质',
  'enddate', 'expiredate', 'expirydate', 'validto', 'deadline', 'overdate', 'endtime', '到期', '有效期',
  'parkno', 'parkingno', 'spaceno', 'berth', 'garage', '车位', '地库',
  'starttime', 'startdate', 'begintime', 'begindate', 'updatetime', 'updatedate',
] as const;

const parkingOwnerOutputAliases = [
  'userid', 'ownerid', 'customerid', 'personid', 'owner_name', 'ownername', 'owner_add', 'owneradd',
  'owner_address', 'owneraddress', 'roomno', 'roomnumber', 'houseno', 'house', 'address', 'addr', 'room', '房号', '地址',
  'mobile', 'mobilephone', 'telephone', 'phone', 'tel', 'ownertel', 'ownermobile', 'ownerphone', '手机', '电话', '联系电话',
  'name', 'username', 'customername', 'personname', 'residentname', '姓名', '业主姓名', '住户姓名',
  'remarks', 'remark', 'note', 'memo', 'comment', '备注',
] as const;

function isParkingQueryFieldAllowed(key: string): boolean {
  if (key.startsWith('PmsMeta__')) return true;
  const isOwner = key.startsWith('Owner__');
  const candidate = normalizeParkingFieldName(isOwner ? key.slice('Owner__'.length) : key);
  const aliases = isOwner ? parkingOwnerOutputAliases : parkingVehicleOutputAliases;
  return aliases.some((alias) => {
    const normalizedAlias = normalizeParkingFieldName(alias);
    return candidate === normalizedAlias || candidate.includes(normalizedAlias);
  });
}
