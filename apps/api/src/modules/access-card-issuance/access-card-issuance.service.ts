import { loadAddressTreeLite, resolveAddressForTenant } from '../../common/address-lookup';
import {
  BadRequestException,
  ForbiddenException,
  HttpException,
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
  BusinessLog,
  Community,
  House,
  ParkingQuery,
  ParkingOwnerUpdate,
  ParkingHistory,
  ParkingRecordSnapshot,
  ParkingOperation,
  ParkingProofUpload,
  User,
} from '../../entities';
import { ResolvedAccess } from '../access/access.service';
import { scopeCommunityIds } from '../access/scope.util';
import {
  accessBuildingsForHouse,
  accessCardHistoryRoomLabel,
  accessCardUserDisplayName,
  accessSystemOf,
  belongsToSameAccessArea,
  icToWg,
  legacyRoomKey,
  legacyDatabaseRoomKey,
  legacyDuplicateCardMessage,
  normalizeBuildingNo,
  projectPhaseOf,
  parseLegacyAccessCardRoomName,
  supportsAccessCardDisplayName,
  supportsAccessCardOperationMode,
  supportsAccessCardPermissionRevoke,
  supportsRemoteDoorControl,
} from './access-card-routing';
import { CreateAccessCardIssueDto, CreateParkingFeeDetailDto } from './dto';
import {
  AgentHeartbeatDto,
  AgentReportDto,
  CardPreflightDto,
  CreateParkingQueryDto,
  CreateParkingMovementQueryDto,
  CreateParkingFeeReportDto,
  RenewDeliyunVehicleDto,
  ChangeDeliyunPlateDto,
  SetDeliyunCivilDefenseAuthorizationDto,
  CreateParkingOwnerUpdateDto,
  EnrollAccessCardAgentDto,
  LegacyCardCheckReportDto,
  LegacyHistoryReportDto,
  ParkingQueryReportDto,
  ParkingOwnerUpdateReportDto,
  CreateParkingOperationDto,
  CreateAccessCardAuthorizationDto,
  CreateAccessCardControllerUploadDto,
  CreateAccessDoorOperationDto,
  AccessCardAuthorizationReportDto,
  ParkingOperationReportDto,
  ParkingHistoryQueryDto,
  CreateAccessCardLifecycleDto,
  OpenAccessDoorDto,
  CheckDoorOnlineDto,
  ApplyLegacyCardMdbDto,
  GrantLegacyCardBoardsDto,
} from './dto';
import { agentTokenMatches, issueAgentSecret } from './agent-auth';
import { prepareFamilyRegistration, validateRegistrationGarageNumbers, supportsFamilyActivation } from './parking-family';
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
  mapLegacyCardRow,
  normalizeLegacyNumber,
  parseLegacyCardRoomInput,
  type LegacyCardRow,
} from './legacy-card-history.util';
import {
  parkingLegacyRoomFromName,
  parkingPmsBuildingKey,
  parkingPmsHouseKey,
  parkingRoomAddress,
  parseParkingSearch,
  assertFreshParkingPlateCheck,
  supportsStructuredParkingQueries,
  supportsParkingMovementQueries,
  parseParkingMovementRange,
  parseParkingFeeReportRange,
  supportsParkingFeeReports,
  supportsParkingFeeDetails,
  supportsLegacyRecentCards,
  supportsParkingIdentityList,
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
  supportsParkingAuthorizationFixes,
  supportsParkingDeviceConfirmation,
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

/** 行级任务聚合结果（appliedSystems/grantedBuildings 仍为 Set，输出时转数组）。 */
type AuthorizationTaskAggregate = {
  appliedSystems: Set<string>;
  grantedBuildings: Set<string>;
  latestTaskAt: number;
  grantedAtByBuilding: Map<string, number>;
  accessSystemByBuilding: Map<string, string>;
};

/** 权限读回来源展示文案（接口固定返回，供前端显示“可验证依据”）。 */
const ACCESS_PERMISSION_SOURCE = '.88 Access 门禁权限表（MjSystem / iCCard）';

/** 最近 30 笔捷顺发卡记录的固定 room_key；.80 助手按此读取快照。 */
const RECENT_LEGACY_ROOM_KEY = '__recent_js_cards__';
/** 快照新鲜期：过期才允许 GET 入队刷新，避免每次打开页面都重置 ready 快照。 */
const RECENT_LEGACY_STALE_MS = 60_000;
/** error 状态的重试节流：30s 内 GET 直接返回错误，不重复入队并白等 8s。 */
const RECENT_LEGACY_ERROR_RETRY_MS = 30_000;
/** GET 等待助手回传的上限；超时返回 pending + 上一次 rows。 */
const RECENT_LEGACY_WAIT_TIMEOUT_MS = 8_000;
/** 等待期间轮询快照的间隔。 */
const RECENT_LEGACY_POLL_MS = 300;

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
    const latestAuthorizationByRowAndOperation = new Map<string, AccessCardAuthorization>();
    for (const task of authorizationTasks) {
      if (!latestAuthorizationByRow.has(task.historyRowId)) latestAuthorizationByRow.set(task.historyRowId, task);
      const key = `${task.historyRowId}:${task.operation}`;
      if (!latestAuthorizationByRowAndOperation.has(key)) latestAuthorizationByRowAndOperation.set(key, task);
    }
    const history = mergedHistory.map((row) => ({
      ...row,
      roomLabel: accessCardHistoryRoomLabel(context.roomKey, row.sequence, row.roomLabel),
      latestAuthorization: latestAuthorizationByRow.has(row.id)
        ? this.historyAuthorizationResponse(latestAuthorizationByRow.get(row.id)!)
        : null,
      accessDatabaseTask: this.historyAuthorizationResponse(
        latestAuthorizationByRowAndOperation.get(`${row.id}:access_database_only`) ?? null),
      controllerTask: this.historyAuthorizationResponse(
        latestAuthorizationByRowAndOperation.get(`${row.id}:controller_upload`) ?? null),
      revokeTask: this.historyAuthorizationResponse(
        latestAuthorizationByRowAndOperation.get(`${row.id}:controller_revoke`) ?? null),
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

  async getRecentCards(user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    const communityIds = scopeCommunityIds(access);
    if (communityIds?.length === 0) return [];

    const query = this.itemRepo.createQueryBuilder('item')
      .innerJoinAndSelect('item.batch', 'batch')
      .where('item.tenant_id = :tenantId', { tenantId })
      .andWhere('item.card_status = :cardStatus', { cardStatus: 'card_completed' });
    if (communityIds) {
      query.andWhere('batch.community_id IN (:...communityIds)', { communityIds });
    }
    const rows = await query
      // batch 是多对一关系，每张卡只会连接一条批次记录，可直接使用 SQL LIMIT。
      // TypeORM 0.3.30 的 take() + 关联查询会进入分页别名重写并在生产抛出 databaseName 错误。
      .orderBy('item.cardCompletedAt', 'DESC', 'NULLS LAST')
      .addOrderBy('item.id', 'DESC')
      .limit(30)
      .getMany();

    return rows.map((item) => ({
      id: item.id,
      batchId: item.batchId,
      houseId: item.batch.houseId,
      address: item.batch.addressSnapshot,
      projectPhase: item.batch.projectPhase,
      accessSystem: item.batch.accessSystem,
      icCardNo: item.icCardNo,
      wgCardNo: item.wgCardNo,
      legacyPersonNo: item.legacyPersonNo,
      cardCompletedAt: item.cardCompletedAt,
      accessStatus: item.accessStatus,
      legacySyncStatus: item.legacySyncStatus,
      controllerResults: item.controllerResults,
      lastErrorRef: item.lastErrorRef,
      lastErrorMessage: item.lastErrorMessage,
    }));
  }

  async requestRecentLegacyCards(user: AuthUser, access: ResolvedAccess) {
    if (!access.scopeAll) throw new ForbiddenException('捷顺全库最近发卡记录仅对全公司数据范围开放');
    const tenantId = this.requireTenant(user);
    const agents = await this.agentRepo.find({ where: { tenantId, kind: 'legacy_sync', enabled: true } });
    if (!agents.some((agent) => effectiveAgentStatus(agent) === 'online' && supportsLegacyRecentCards(agent.version)))
      throw new ServiceUnavailableException('捷顺最近 30 笔查询需要在线的 2.5.28 或更新版本 .80 数据同步助手');
    // 显式刷新一次就等到助手回传，避免前端自己再轮询多轮。
    const snapshot = await this.waitLegacyRecent(
      await this.requestRecentLegacySnapshot(tenantId, user.id),
      tenantId,
    );
    return this.recentLegacyCardResponse(snapshot, tenantId);
  }

  /** 轮询端点：只在无快照或超过 60s 时入队，不等待回传。 */
  async getRecentLegacyCards(user: AuthUser, access: ResolvedAccess) {
    if (!access.scopeAll) throw new ForbiddenException('捷顺全库最近发卡记录仅对全公司数据范围开放');
    const tenantId = this.requireTenant(user);
    const snapshot = await this.ensureRecentLegacySnapshot(tenantId, user.id);
    return this.recentLegacyCardResponse(snapshot, tenantId);
  }

  private async recentLegacyCardResponse(snapshot: AccessCardLegacySnapshot, tenantId: number) {
    // pending/error 时 history 保留上一次成功回传的数据：刷新期间仍返回旧 rows，
    // 而不是把页面清空；助手成功回传时 reportLegacyHistory 会整体替换 history。
    const sourceRows = snapshot.history ?? [];
    const buildings = sourceRows.length ? await this.buildingRepo.find({ where: { tenantId } }) : [];
    const buildingIds = buildings.map((building) => building.id);
    const houses = buildingIds.length ? await this.houseRepo.find({ where: { tenantId, buildingId: In(buildingIds) } }) : [];
    const communityIds = Array.from(new Set(buildings.map((building) => building.communityId)));
    const communities = communityIds.length ? await this.communityRepo.find({ where: { tenantId, id: In(communityIds) } }) : [];
    const cardNumbers = sourceRows
      .map((row) => row.icCardNo && /^[0-9A-F]{8}$/.test(row.icCardNo) ? icToWg(row.icCardNo) : null)
      .filter((value): value is string => Boolean(value));
    const tasks = cardNumbers.length ? await this.authorizationRepo.find({
      where: { tenantId, wgCardNo: In(cardNumbers) }, order: { createdAt: 'DESC' },
    }) : [];
    const latestTask = new Map<string, AccessCardAuthorization>();
    for (const task of tasks) {
      const key = `${task.wgCardNo}:${task.operation}`;
      if (!latestTask.has(key)) latestTask.set(key, task);
    }
    // 同一次 find 的任务顺带做行级聚合（appliedSystems/grantedBuildings/latestTaskAt），不再按卡查询。
    const taskAggregates = this.aggregateAuthorizationTasks(tasks);
    const normalizeAddressPart = (value?: string | null) => {
      const trimmed = (value ?? '').trim();
      return /^\d+$/.test(trimmed) ? String(Number(trimmed)) : trimmed;
    };
    // 行映射只做一次：mapLegacyCardRow 负责 roomLabel/hidden/status/person* 等公共字段，
    // 这里再补 PMS 匹配出的社区/楼栋/房产字段（供页面“查看该户历史”直接跳转）。
    const rows = sourceRows.map((row, index) => {
      const wgCardNo = row.icCardNo && /^[0-9A-F]{8}$/.test(row.icCardNo) ? icToWg(row.icCardNo) : null;
      const parsed = parseLegacyAccessCardRoomName(row.personName);
      const building = parsed ? buildings.find((candidate) =>
        normalizeAddressPart(candidate.lane) === normalizeAddressPart(parsed.lane)
        && normalizeAddressPart(candidate.buildingNo) === normalizeAddressPart(parsed.buildingNo)) : undefined;
      const house = building && parsed ? houses.find((candidate) =>
        candidate.buildingId === building.id
        && normalizeAddressPart(candidate.roomNo) === normalizeAddressPart(parsed.roomNo)) : undefined;
      const community = building ? communities.find((candidate) => candidate.id === building.communityId) : undefined;
      const phase = community ? projectPhaseOf(community.name) : parsed?.lane === '198' ? 'phase1' : null;
      const system = phase && building ? accessSystemOf(phase, building.buildingNo) : null;
      const canManageAccess = phase === 'phase2' && Boolean(house && system && wgCardNo);
      const actionMessage = phase === 'phase1'
        ? '198弄一期卡不需要添加到 .88 门禁系统'
        : !parsed ? '捷顺登记名称不是“弄号/楼栋/室号/序号”格式，无法匹配房号'
          : !house ? '未在 PMS 精确匹配到这个房号'
            : !system ? '该楼栋门禁路由尚未配置'
              : !wgCardNo ? 'IC 卡号无法换算 WG 卡号'
                : null;
      const roomKey = house && building ? legacyRoomKey(building.lane, building.buildingNo, house.roomNo) : null;
      const mapped = mapLegacyCardRow(row, index + 1, roomKey);
      const aggregate = wgCardNo ? taskAggregates.get(wgCardNo) : undefined;
      return {
        ...mapped,
        wgCardNo: mapped.wgCardNo ?? wgCardNo,
        communityId: community?.id ?? null,
        communityName: community?.name ?? null,
        buildingId: building?.id ?? null,
        lane: building?.lane ?? null,
        roomNo: house?.roomNo ?? null,
        buildingNo: building?.buildingNo ?? null,
        houseId: house?.id ?? null,
        roomKey,
        projectPhase: phase,
        accessSystem: system,
        homeBuildingNo: building?.buildingNo ?? null,
        canManageAccess,
        actionMessage,
        appliedSystems: aggregate ? [...aggregate.appliedSystems].sort() : [],
        grantedBuildings: aggregate ? [...aggregate.grantedBuildings].sort() : [],
        latestTaskAt: aggregate && aggregate.latestTaskAt ? new Date(aggregate.latestTaskAt).toISOString() : null,
        accessDatabaseTask: wgCardNo ? this.historyAuthorizationResponse(latestTask.get(`${wgCardNo}:access_database_only`) ?? null) : null,
        controllerTask: wgCardNo ? this.historyAuthorizationResponse(latestTask.get(`${wgCardNo}:controller_upload`) ?? null) : null,
      };
    });
    return {
      status: snapshot.status,
      rows,
      fieldsIncomplete: rows.length > 0 && rows.every((row) => row.fieldsIncomplete),
      refreshing: snapshot.status === 'pending',
      error: snapshot.status === 'error' ? snapshot.lastError : null,
      refreshedAt: snapshot.refreshedAt,
      permissionStatus: snapshot.permissionStatus,
      permissions: snapshot.permissionStatus === 'ready' ? snapshot.permissions : [],
      permissionError: snapshot.permissionStatus === 'error' ? snapshot.permissionLastError : null,
    };
  }

  /** 按户查询捷顺发卡历史；地址支持 228/50/202、228/50/202/4、已隐藏前缀。 */
  async getLegacyCardHistory(
    communityId: number,
    address: string | undefined,
    roomKey: string | undefined,
    user: AuthUser,
    access?: ResolvedAccess,
  ) {
    const tenantId = this.requireTenant(user);
    const context = await this.resolveLegacyRoomByInput(tenantId, communityId, address || roomKey || '', access);
    const legacyAgents = await this.agentRepo.find({ where: { tenantId, kind: 'legacy_sync', enabled: true } });
    if (!legacyAgents.some((agent) => effectiveAgentStatus(agent) === 'online')) {
      throw new ServiceUnavailableException('捷顺发卡历史查询需要在线的 .80 旧库同步助手');
    }
    const snapshot = await this.waitLegacyHistory(
      await this.requestLegacyHistory(tenantId, context.legacyStorageRoomKey, user.id),
      tenantId,
    );
    const phase = projectPhaseOf(context.community.name);
    // 该户所属楼栋在 .88 二期联网门禁里的系统；一期/未配置路由为 null。
    const accessSystem = phase ? accessSystemOf(phase, context.building.buildingNo) : null;
    const rows = snapshot.status === 'ready'
      ? snapshot.history.map((row, index) => ({
        ...mapLegacyCardRow(row, index + 1, context.roomKey),
        accessSystem,
      }))
      : [];
    // 一次批量聚合本户所有卡的已写入系统/已授权楼栋/最近任务时间。
    const aggregates = await this.batchCardTaskAggregates(tenantId, rows.map((row) =>
      row.icCardNo && /^[0-9A-F]{8}$/.test(row.icCardNo) ? icToWg(row.icCardNo) : row.wgCardNo));
    const rowsWithAggregates = rows.map((row) => {
      const aggregate = row.wgCardNo ? aggregates.get(row.wgCardNo) : undefined;
      return {
        ...row,
        appliedSystems: aggregate ? [...aggregate.appliedSystems].sort() : [],
        grantedBuildings: aggregate ? [...aggregate.grantedBuildings].sort() : [],
        latestTaskAt: aggregate && aggregate.latestTaskAt ? new Date(aggregate.latestTaskAt).toISOString() : null,
      };
    });
    return {
      communityId,
      address: address || roomKey || context.roomKey,
      roomKey: context.roomKey,
      status: snapshot.status,
      fieldsIncomplete: rowsWithAggregates.length > 0 && rowsWithAggregates.every((row) => row.fieldsIncomplete),
      rows: rowsWithAggregates,
      error: snapshot.status === 'error' ? snapshot.lastError : null,
      refreshedAt: snapshot.refreshedAt,
    };
  }

  /** 最近 30 笔捷顺发卡记录；全公司或当前管理处范围。 */
  async getLegacyCardRecent(user: AuthUser, access?: ResolvedAccess, limit = 30) {
    const tenantId = this.requireTenant(user);
    const scope = scopeCommunityIds(access);
    const max = Math.min(Math.max(Number.isFinite(limit) ? Math.trunc(limit) : 30, 1), 30);
    const agents = await this.agentRepo.find({ where: { tenantId, kind: 'legacy_sync', enabled: true } });
    if (!agents.some((agent) => effectiveAgentStatus(agent) === 'online' && supportsLegacyRecentCards(agent.version))) {
      throw new ServiceUnavailableException('捷顺最近发卡查询需要在线的 2.5.28 或更新版本 .80 数据同步助手');
    }
    const snapshot = await this.legacySnapshotRepo.findOne({ where: { tenantId, roomKey: RECENT_LEGACY_ROOM_KEY } });
    // error 30s 内直接返回错误：避免每次打开页面都重新入队并等满 8s。
    if (snapshot && !this.recentSnapshotNeedsRefresh(snapshot) && snapshot.status === 'error') {
      return this.legacyCardRecentPayload(snapshot, tenantId, scope, max);
    }
    let current = snapshot;
    if (!current || this.recentSnapshotNeedsRefresh(current)) {
      current = await this.requestRecentLegacySnapshot(tenantId, user.id);
    }
    // pending 说明助手正在回传（或刚入队）；有界等待后返回，ready 快照无需等待。
    current = await this.waitLegacyRecent(current, tenantId);
    return this.legacyCardRecentPayload(current, tenantId, scope, max);
  }

  /** GET cards/recent 的最终响应：按数据范围过滤、截断，再据实际返回行计算 fieldsIncomplete。 */
  private async legacyCardRecentPayload(
    snapshot: AccessCardLegacySnapshot,
    tenantId: number,
    scope: number[] | null,
    max: number,
  ) {
    const recent = await this.recentLegacyCardResponse(snapshot, tenantId);
    let rows = recent.rows;
    if (scope) rows = rows.filter((row) => row.communityId != null && scope.includes(row.communityId));
    const limited = rows.slice(0, max);
    return {
      ...recent,
      fieldsIncomplete: limited.length > 0 && limited.every((row) => row.fieldsIncomplete),
      refreshing: recent.status === 'pending',
      rows: limited,
    };
  }

  /** 单卡详情 + 已写入 Access 库/已授权楼栋聚合。 */
  async getLegacyCard(id: number, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    const found = await this.findLegacyCardById(tenantId, id);
    if (!found) throw new NotFoundException('捷顺发卡记录不存在或已过期，请先刷新发卡历史');
    const context = await this.resolveLegacyCardRoom(tenantId, found.row, access);
    const mapped = mapLegacyCardRow(found.row, 1, context?.roomKey ?? null);
    const tasks = mapped.wgCardNo
      ? await this.authorizationRepo.find({
        where: { tenantId, wgCardNo: mapped.wgCardNo },
        order: { createdAt: 'DESC' },
        take: 100,
      })
      : [];
    const appliedSystems = new Set<string>();
    const grantedBuildings = new Set<string>();
    if (found.snapshot.permissionStatus === 'ready' && mapped.wgCardNo) {
      for (const permission of found.snapshot.permissions) {
        if (permission.wgCardNo !== mapped.wgCardNo) continue;
        appliedSystems.add(permission.accessSystem);
        if (permission.buildingNo) grantedBuildings.add(normalizeBuildingNo(permission.buildingNo));
      }
    }
    for (const task of [...tasks].reverse()) {
      if (task.status !== 'completed') continue;
      if (task.operation === 'access_database_only') {
        for (const target of task.targetBuildings ?? []) appliedSystems.add(target.accessSystem);
      } else if (task.operation === 'controller_upload') {
        for (const target of task.targetBuildings ?? []) {
          appliedSystems.add(target.accessSystem);
          grantedBuildings.add(normalizeBuildingNo(target.buildingNo));
        }
      } else if (task.operation === 'controller_revoke') {
        for (const target of task.targetBuildings ?? []) grantedBuildings.delete(normalizeBuildingNo(target.buildingNo));
      }
    }
    const permissionCheckedAt = found.snapshot.permissionRefreshedAt
      ? new Date(found.snapshot.permissionRefreshedAt).toISOString()
      : null;
    const taskAggregate = mapped.wgCardNo ? this.aggregateAuthorizationTasks(tasks).get(mapped.wgCardNo) : undefined;
    const buildingDetails = new Map<string, {
      buildingNo: string;
      accessSystem: string;
      granted: boolean;
      source: 'permission_readback' | 'task';
      checkedAt: string | null;
      sourceTable?: string;
    }>();
    // 先放任务回执聚合，再用权限读回覆盖同一楼栋（permission_readback 优先）。
    if (taskAggregate) {
      for (const buildingNo of taskAggregate.grantedBuildings) {
        const grantedAt = taskAggregate.grantedAtByBuilding.get(buildingNo);
        buildingDetails.set(`${buildingNo}:${taskAggregate.accessSystemByBuilding.get(buildingNo) ?? ''}`, {
          buildingNo,
          accessSystem: taskAggregate.accessSystemByBuilding.get(buildingNo) ?? accessSystemOf('phase2', buildingNo) ?? '',
          granted: true,
          source: 'task',
          checkedAt: grantedAt ? new Date(grantedAt).toISOString() : null,
        });
      }
    }
    if (found.snapshot.permissionStatus === 'ready' && mapped.wgCardNo) {
      for (const permission of found.snapshot.permissions) {
        if (permission.wgCardNo !== mapped.wgCardNo || !permission.buildingNo) continue;
        const buildingNo = normalizeBuildingNo(permission.buildingNo);
        buildingDetails.set(`${buildingNo}:${permission.accessSystem}`, {
          buildingNo,
          accessSystem: permission.accessSystem,
          granted: true,
          source: 'permission_readback',
          checkedAt: permissionCheckedAt,
          sourceTable: permission.sourceTable,
        });
      }
    }
    const grantedBuildingDetails = [...buildingDetails.values()]
      .filter((detail) => detail.buildingNo)
      .sort((left, right) =>
        left.buildingNo.localeCompare(right.buildingNo, 'zh-CN', { numeric: true })
        || left.accessSystem.localeCompare(right.accessSystem));
    return {
      ...mapped,
      communityId: context?.community.id ?? null,
      buildingNo: context?.building.buildingNo ?? null,
      roomKey: context?.roomKey ?? null,
      houseId: context?.house.id ?? null,
      appliedSystems: [...appliedSystems].sort(),
      grantedBuildings: [...grantedBuildings].sort(),
      permissionCheckedAt,
      permissionSource: ACCESS_PERMISSION_SOURCE,
      grantedBuildingDetails,
      latestTasks: tasks.slice(0, 10).map((task) => this.historyAuthorizationResponse(task)),
    };
  }

  /**
   * POST /cards/:id/verify-grant：从 .88 Access 门禁权限表只读读回这张卡的授权。
   *
   * 真实语义：本接口只读 Access 权限表（MjSystem / iCCard），不写 Access 库、不操作控制器；
   * 取/建该户权限快照并复用 requestAccessPermissions 的 .88 读回流程，
   * 等助手回传 permissions 后返回可验证的楼栋/系统清单。网关离线/读取失败/超时 → 503，不伪造 granted。
   */
  async verifyLegacyCardGrant(id: number, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    const found = await this.findLegacyCardById(tenantId, id);
    if (!found) throw new NotFoundException('捷顺发卡记录不存在或已过期，请先刷新发卡历史');
    const context = await this.resolveLegacyCardRoom(tenantId, found.row, access, true);
    if (!context) throw new BadRequestException('未能匹配这张卡的房号，无法从 .88 Access 权限表验证授权');
    const mapped = mapLegacyCardRow(found.row, 1, context.roomKey);
    const wgCardNo = mapped.wgCardNo;
    if (!wgCardNo) throw new BadRequestException('IC 卡号无法换算 WG 卡号，无法从 .88 Access 权限表验证授权');
    const accessSystem = accessSystemOf('phase2', context.building.buildingNo);
    if (!accessSystem) throw new BadRequestException('该楼栋门禁路由尚未配置，无法从 .88 Access 权限表验证授权');
    const gatewayAgents = await this.agentRepo.find({ where: { tenantId, kind: 'access_gateway', enabled: true } });
    if (!gatewayAgents.some((agent) => effectiveAgentStatus(agent) === 'online')) {
      throw new ServiceUnavailableException('门禁网关离线，暂时无法从 .88 Access 权限表读回授权');
    }
    const snapshot = await this.requestLegacyHistory(tenantId, context.legacyStorageRoomKey, user.id);
    const requested = await this.requestAccessPermissions(
      snapshot,
      [{ icCardNo: (mapped.icCardNo ?? '').toUpperCase(), wgCardNo }],
      user.id,
    );
    const settled = await this.waitAccessPermissions(requested, tenantId);
    if (settled.permissionStatus === 'error') {
      throw new ServiceUnavailableException(settled.permissionLastError || '从 .88 Access 权限表读取授权失败');
    }
    if (settled.permissionStatus !== 'ready') {
      throw new ServiceUnavailableException('从 .88 Access 权限表读取授权超时，请稍后重试');
    }
    const checkedAt = settled.permissionRefreshedAt
      ? new Date(settled.permissionRefreshedAt).toISOString()
      : new Date().toISOString();
    const permissions = settled.permissions.filter((permission) => permission.wgCardNo === wgCardNo && permission.buildingNo);
    const appliedSystems = new Set<string>();
    const grantedBuildings = new Map<string, {
      buildingNo: string;
      accessSystem: 'mjsystem' | 'iccard';
      granted: boolean;
      sourceTable: string;
    }>();
    for (const permission of permissions) {
      const buildingNo = normalizeBuildingNo(permission.buildingNo ?? '');
      if (!buildingNo) continue;
      appliedSystems.add(permission.accessSystem);
      grantedBuildings.set(`${buildingNo}:${permission.accessSystem}`, {
        buildingNo,
        accessSystem: permission.accessSystem,
        granted: true,
        sourceTable: permission.sourceTable,
      });
    }
    return {
      checkedAt,
      accessSystem,
      wgCardNo,
      appliedSystems: [...appliedSystems].sort(),
      grantedBuildings: [...grantedBuildings.values()].sort((left, right) =>
        left.buildingNo.localeCompare(right.buildingNo, 'zh-CN', { numeric: true })
        || left.accessSystem.localeCompare(right.accessSystem)),
      message: permissions.length
        ? `已从 .88 Access 权限表读回 ${permissions.length} 条门栋授权`
        : '门禁权限表中未查到该卡的门栋授权（未写入 Access 库，如需授权请先提交授权楼栋任务）',
    };
  }

  /** verify-grant 有界等待 .88 权限读回（默认 8s，300ms 轮询）；测试可覆盖本方法。 */
  private async waitAccessPermissions(
    snapshot: AccessCardLegacySnapshot,
    tenantId: number,
    timeoutMs = 8_000,
  ) {
    let current = snapshot;
    const deadline = Date.now() + timeoutMs;
    while (['pending', 'running'].includes(current.permissionStatus) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      const next = await this.legacySnapshotRepo.findOne({ where: { id: current.id, tenantId } });
      if (!next) break;
      current = next;
    }
    return current;
  }

  /**
   * 发卡页「授权楼栋」：返回该卡所在小区的二期联网门禁门栋（复用设备管理的 phase2 路由），
   * 同时给出本楼栋号/本楼栋系统，默认值由前端使用 homeBuildingNo。
   */
  async getLegacyCardGrantOptions(id: number, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    const found = await this.findLegacyCardById(tenantId, id);
    if (!found) throw new NotFoundException('捷顺发卡记录不存在或已过期，请先刷新发卡历史');
    const context = await this.resolveLegacyCardRoom(tenantId, found.row, access);
    if (!context) throw new BadRequestException('未能在 PMS 精确匹配这张卡的房号，无法选择授权楼栋');
    const phase = projectPhaseOf(context.community.name);
    const homeBuildingNo = context.building.buildingNo;
    const accessSystem = phase ? accessSystemOf(phase, homeBuildingNo) : null;
    // 复用 listDoorControllers 的 phase2 路由（只含 accessSystemOf('phase2', buildingNo) !== null 的楼栋），
    // 一期/未联网小区返回空门栋列表，不伪造选项。
    const controllers = phase === 'phase2'
      ? (await this.listDoorControllers(user, access, context.community.id)).controllers
      : [];
    const seen = new Set<string>();
    const options = controllers
      .filter((controller) => {
        const key = normalizeBuildingNo(controller.buildingNo);
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((controller) => ({
        buildingNo: controller.buildingNo,
        doorName: controller.doorName,
        accessSystem: controller.accessSystem,
      }))
      .sort((left, right) => left.buildingNo.localeCompare(right.buildingNo, 'zh-CN', { numeric: true }));
    return {
      communityId: context.community.id,
      houseId: context.house.id,
      homeBuildingNo,
      accessSystem,
      options,
    };
  }

  /** 把捷顺卡写入 .88 Access 库（iCCard / MjSystem），复用历史卡授权任务通道。 */
  async applyLegacyCardMdb(id: number, dto: ApplyLegacyCardMdbDto, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    const found = await this.findLegacyCardById(tenantId, id);
    if (!found) throw new NotFoundException('捷顺发卡记录不存在或已过期，请先刷新发卡历史');
    const context = await this.resolveLegacyCardRoom(tenantId, found.row, access, true);
    if (!context) throw new BadRequestException('未能在 PMS 精确匹配这张卡的房号，无法写入 Access 库');
    const mapped = mapLegacyCardRow(found.row, 1, context.roomKey);
    if (!mapped.wgCardNo) throw new BadRequestException('IC 卡号无法换算 WG 卡号，无法写入 Access 库');
    const homeSystem = accessSystemOf('phase2', context.building.buildingNo);
    // systems 可选：不传/空数组时默认写这张卡所属楼栋的系统，前端无需先猜 iccard/mjsystem。
    const systems = dto.systems?.length ? dto.systems : (homeSystem ? [homeSystem] : []);
    if (!systems.length) throw new BadRequestException('该楼栋门禁路由尚未配置，无法写入 Access 库');
    const results: Array<{ system: 'iccard' | 'mjsystem'; status: 'queued' | 'failed'; taskId?: number; error?: string }> = [];
    const taskIds: number[] = [];
    for (const system of Array.from(new Set(systems))) {
      if (homeSystem !== system) {
        results.push({
          system,
          status: 'failed',
          error: `这张卡属于 ${homeSystem ?? '未配置'} 门禁系统，不能直接写入 ${system}；请先授权对应楼栋主板`,
        });
        continue;
      }
      try {
        const task = await this.enqueueHistoryAuthorization({
          tenantId,
          houseId: context.house.id,
          historyId: 0,
          roomKey: context.roomKey,
          cardSequence: mapped.sequence,
          operation: 'access_database_only',
          icCardNo: mapped.icCardNo,
          wgCardNo: mapped.wgCardNo,
          targetBuildings: [{
            id: context.building.id,
            buildingNo: context.building.buildingNo,
            accessSystem: system,
          }],
          idempotencyKey: `card-apply-${id}-${system}-${Date.now()}`,
          userId: user.id,
        });
        if (!task) throw new ServiceUnavailableException('Access 库写入任务创建失败');
        taskIds.push(task.id);
        results.push({ system, status: 'queued', taskId: task.id });
      } catch (error) {
        results.push({ system, status: 'failed', error: error instanceof Error ? error.message : '写入任务创建失败' });
      }
    }
    await this.writeLegacyCardAudit(tenantId, id, 'access_card_apply_mdb', {
      systems: Array.from(new Set(systems)),
      taskIds,
      results,
    }, user.id);
    return { taskIds, results };
  }

  /**
   * 授权/撤销到多栋楼主板：每栋一条任务，单栋入队失败不影响其他楼栋。
   * 返回的 ok 是“任务已入队”，最终控制器回执看 GET /cards/:id 或任务详情。
   */
  async grantLegacyCardBoards(id: number, dto: GrantLegacyCardBoardsDto, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    const found = await this.findLegacyCardById(tenantId, id);
    if (!found) throw new NotFoundException('捷顺发卡记录不存在或已过期，请先刷新发卡历史');
    if (!dto.buildingNos?.length) throw new BadRequestException('请至少选择一栋楼');
    const context = await this.resolveLegacyCardRoom(tenantId, found.row, access, true);
    if (!context) throw new BadRequestException('未能在 PMS 精确匹配这张卡的房号，无法授权楼栋主板');
    const mapped = mapLegacyCardRow(found.row, 1, context.roomKey);
    const buildings = await this.buildingRepo.find({ where: { tenantId, communityId: context.community.id } });
    const gatewayAgents = await this.agentRepo.find({ where: { tenantId, kind: 'access_gateway', enabled: true } });
    const gateway = orderAgentsByAvailability(gatewayAgents).find((agent) =>
      effectiveAgentStatus(agent) === 'online'
      && agent.capabilities?.remoteDoorControl === true
      && supportsRemoteDoorControl(agent.version));
    const results: Array<{ buildingNo: string; status: 'ok' | 'offline' | 'failed'; taskId?: number; error?: string }> = [];
    const taskIds: number[] = [];
    for (const rawBuildingNo of Array.from(new Set(dto.buildingNos))) {
      const buildingNo = normalizeBuildingNo(rawBuildingNo);
      const building = buildings.find((item) => normalizeBuildingNo(item.buildingNo) === buildingNo);
      if (!building) {
        results.push({ buildingNo: rawBuildingNo, status: 'failed', error: '楼栋不属于这张卡所在小区' });
        continue;
      }
      if (!mapped.wgCardNo) {
        results.push({ buildingNo: rawBuildingNo, status: 'failed', error: 'IC 卡号无法换算 WG 卡号' });
        continue;
      }
      const system = accessSystemOf('phase2', building.buildingNo);
      if (!system) {
        results.push({ buildingNo: rawBuildingNo, status: 'failed', error: '该楼栋门禁路由尚未配置' });
        continue;
      }
      if (!gateway) {
        results.push({ buildingNo: rawBuildingNo, status: 'offline', error: '门禁网关离线或版本低于 2.5.46' });
        continue;
      }
      try {
        const task = await this.enqueueHistoryAuthorization({
          tenantId,
          houseId: context.house.id,
          historyId: 0,
          roomKey: context.roomKey,
          cardSequence: mapped.sequence,
          operation: dto.mode === 'add' ? 'controller_upload' : 'controller_revoke',
          icCardNo: mapped.icCardNo,
          wgCardNo: mapped.wgCardNo,
          targetBuildings: [{
            id: building.id,
            buildingNo: building.buildingNo,
            accessSystem: system,
          }],
          idempotencyKey: `card-grant-${id}-${buildingNo}-${dto.mode}-${Date.now()}-${taskIds.length}`,
          userId: user.id,
        });
        if (!task) throw new ServiceUnavailableException('门禁任务创建失败');
        taskIds.push(task.id);
        results.push({ buildingNo: rawBuildingNo, status: 'ok', taskId: task.id });
      } catch (error) {
        results.push({ buildingNo: rawBuildingNo, status: 'failed', error: error instanceof Error ? error.message : '门禁任务创建失败' });
      }
    }
    await this.writeLegacyCardAudit(tenantId, id, `access_card_grant_boards_${dto.mode}`, {
      buildingNos: dto.buildingNos,
      boardKeys: dto.boardKeys ?? null,
      taskIds,
      results,
    }, user.id);
    return { taskIds, results };
  }

  async operateRecentLegacyCard(
    personId: number,
    operation: AccessCardAuthorization['operation'],
    dto: CreateAccessCardControllerUploadDto,
    user: AuthUser,
    access: ResolvedAccess,
  ) {
    if (!access.scopeAll) throw new ForbiddenException('捷顺全库发卡操作仅对全公司数据范围开放');
    const tenantId = this.requireTenant(user);
    const snapshot = await this.legacySnapshotRepo.findOne({ where: { tenantId, roomKey: '__recent_js_cards__' } });
    if (!snapshot || snapshot.status !== 'ready') throw new BadRequestException('请先刷新捷顺数据库最新30笔发卡记录');
    const source = snapshot.history.find((row) => row.personId === personId);
    if (!source) throw new NotFoundException('这条捷顺发卡记录已不在最新30笔中，请刷新后重试');
    const response = await this.recentLegacyCardResponse(snapshot, tenantId);
    const matched = response.rows.find((row) => row.personId === personId);
    if (!matched?.canManageAccess || !matched.houseId || !matched.wgCardNo) {
      throw new BadRequestException(matched?.actionMessage || '这条发卡记录无法匹配二期门禁房号');
    }
    const context = await this.getHouseContext(matched.houseId, user, access);
    const historyRow = context.history.find((row) => row.icCardNo?.toUpperCase() === source.icCardNo?.toUpperCase());
    if (!historyRow?.wgCardNo) throw new NotFoundException('房号历史中没有找到这张卡，请刷新房号历史后重试');
    if (operation === 'controller_upload') {
      return this.uploadHistoryCardToController(matched.houseId, historyRow.id, dto, user, access);
    }
    const homeBuilding = context.availableBuildings.find((building) => building.id === context.house.buildingId);
    if (!homeBuilding?.routeReady || !homeBuilding.accessSystem) {
      throw new BadRequestException(`本楼栋 ${context.house.buildingNo} 号楼的门禁路由尚未配置`);
    }
    if (operation === 'access_database_only') {
      const alreadyRegistered = (historyRow.controllerResults ?? []).some((row) =>
        normalizeBuildingNo(typeof row.buildingNo === 'string' ? row.buildingNo : '')
          === normalizeBuildingNo(homeBuilding.buildingNo));
      if (alreadyRegistered) throw new BadRequestException('这张卡已经存在本楼栋门禁管理系统中，无需重复添加');
    }
    return this.enqueueHistoryAuthorization({
      tenantId,
      houseId: matched.houseId,
      historyId: historyRow.id,
      roomKey: context.house.roomKey,
      cardSequence: historyRow.sequence,
      operation,
      icCardNo: historyRow.icCardNo,
      wgCardNo: historyRow.wgCardNo,
      targetBuildings: [{
        id: homeBuilding.id,
        buildingNo: homeBuilding.buildingNo,
        accessSystem: homeBuilding.accessSystem,
      }],
      idempotencyKey: dto.idempotencyKey.trim(),
      userId: user.id,
    });
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
      cardSequence: historyRow.sequence,
      operation: 'controller_upload',
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

  async revokeHistoryAuthorization(
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
    if (context.projectPhase !== 'phase2') throw new BadRequestException('枫桦景苑一期卡片没有楼栋门禁权限可撤销');
    const historyRow = context.history.find((row) => row.id === historyId);
    if (!historyRow?.wgCardNo) throw new NotFoundException('没有找到这张历史卡片，或卡片缺少 WG 卡号');
    if (!dto.targetBuildingIds.length) throw new BadRequestException('请至少选择一个要撤销权限的楼栋');
    const availableById = new Map(context.availableBuildings.map((building) => [building.id, building]));
    const selected = dto.targetBuildingIds.map((id) => availableById.get(id));
    if (selected.some((building) => !building || !building.routeReady || !building.accessSystem)) {
      throw new BadRequestException('所选楼栋不属于当前门禁区域，或门禁路由尚未配置');
    }
    const authorized = new Set((historyRow.controllerResults ?? [])
      .map((row) => normalizeBuildingNo(typeof row.buildingNo === 'string' ? row.buildingNo : ''))
      .filter(Boolean));
    const missing = selected.filter((building) => !authorized.has(normalizeBuildingNo(building!.buildingNo)));
    if (missing.length) throw new BadRequestException(`这张卡没有 ${missing.map((item) => `${item!.buildingNo}号楼`).join('、')} 权限，不能撤销`);
    await this.requirePermissionRevokeGateway(tenantId);
    return this.enqueueHistoryAuthorization({
      tenantId, houseId, historyId, roomKey: context.house.roomKey, cardSequence: historyRow.sequence,
      operation: 'controller_revoke', icCardNo: historyRow.icCardNo, wgCardNo: historyRow.wgCardNo,
      targetBuildings: selected.map((building) => ({
        id: building!.id, buildingNo: building!.buildingNo, accessSystem: building!.accessSystem!,
      })),
      idempotencyKey, userId: user.id,
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
    const sameOperation = await this.authorizationRepo.findOne({
      where: { tenantId, houseId, historyRowId: historyId, operation: 'controller_upload' },
      order: { createdAt: 'DESC' },
    });
    if (sameOperation && ['pending', 'running', 'completed'].includes(sameOperation.status)) {
      return this.historyAuthorizationResponse(sameOperation);
    }
    if (sameOperation?.status === 'failed') {
      return this.retryHistoryAuthorization(sameOperation.id, user, access);
    }
    if (historyRow.accessStatus !== 'controller_uploaded') {
      throw new BadRequestException('请先将这张卡添加至门禁管理系统，确认已添加后再下发控制器');
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
      cardSequence: historyRow.sequence,
      operation: 'controller_upload',
      icCardNo: historyRow.icCardNo,
      wgCardNo: historyRow.wgCardNo,
      targetBuildings: context.availableBuildings.filter((building) => building.id === homeBuilding.id
        || historyRow.controllerResults.some((row) => normalizeBuildingNo(String(row.buildingNo || ''))
          === normalizeBuildingNo(building.buildingNo))).map((building) => {
        if (!building.routeReady || !building.accessSystem) {
          throw new BadRequestException(`${building.buildingNo}号楼的门禁路由尚未配置`);
        }
        return { id: building.id, buildingNo: building.buildingNo, accessSystem: building.accessSystem };
      }),
      idempotencyKey,
      userId: user.id,
    });
  }

  async addHistoryCardToAccessDatabase(
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
    if (context.projectPhase !== 'phase2') throw new BadRequestException('枫桦景苑一期卡片不需要添加楼栋门禁权限');
    const historyRow = context.history.find((row) => row.id === historyId);
    if (!historyRow) throw new NotFoundException('没有找到这张历史卡片');
    if (!historyRow.wgCardNo) throw new BadRequestException('这张卡没有 WG 卡号，无法添加至门禁管理系统');
    const sameOperation = await this.authorizationRepo.findOne({
      where: { tenantId, houseId, historyRowId: historyId, operation: 'access_database_only' },
      order: { createdAt: 'DESC' },
    });
    if (sameOperation && ['pending', 'running', 'completed'].includes(sameOperation.status)) {
      return this.historyAuthorizationResponse(sameOperation);
    }
    const homeBuilding = context.availableBuildings.find((building) => building.id === context.house.buildingId);
    if (!homeBuilding?.routeReady || !homeBuilding.accessSystem) {
      throw new BadRequestException(`本楼栋 ${context.house.buildingNo} 号楼的门禁路由尚未配置`);
    }
    if (historyRow.controllerResults.some((row) =>
      normalizeBuildingNo(typeof row.buildingNo === 'string' ? row.buildingNo : '')
        === normalizeBuildingNo(homeBuilding.buildingNo))) {
      const completed = this.authorizationRepo.create({
        tenantId, houseId, historyRowId: historyId, roomKey: context.house.roomKey,
        cardSequence: historyRow.sequence, operation: 'access_database_only', icCardNo: historyRow.icCardNo,
        wgCardNo: historyRow.wgCardNo, targetBuildings: [{ id: homeBuilding.id, buildingNo: homeBuilding.buildingNo, accessSystem: homeBuilding.accessSystem }],
        durationSeconds: null, controllerResults: [], idempotencyKey, status: 'completed', attempt: 0,
        requestedAt: new Date(), completedAt: new Date(), leaseAgentKey: null, leaseExpiresAt: null,
        lastError: null, createdBy: user.id, updatedBy: user.id,
      });
      return this.historyAuthorizationResponse(await this.authorizationRepo.save(completed));
    }
    return this.enqueueHistoryAuthorization({
      tenantId, houseId, historyId, roomKey: context.house.roomKey, cardSequence: historyRow.sequence,
      operation: 'access_database_only', icCardNo: historyRow.icCardNo, wgCardNo: historyRow.wgCardNo,
      targetBuildings: [{ id: homeBuilding.id, buildingNo: homeBuilding.buildingNo, accessSystem: homeBuilding.accessSystem }],
      idempotencyKey, userId: user.id,
    });
  }

  async createDoorOperation(
    houseId: number,
    dto: CreateAccessDoorOperationDto,
    user: AuthUser,
    access?: ResolvedAccess,
  ) {
    const tenantId = this.requireTenant(user);
    const idempotencyKey = dto.idempotencyKey.trim();
    const existing = await this.authorizationRepo.findOne({ where: { tenantId, idempotencyKey } });
    if (existing) return this.historyAuthorizationResponse(existing);
    const context = await this.getHouseContext(houseId, user, access);
    if (context.projectPhase !== 'phase2') throw new BadRequestException('枫桦景苑一期没有联网门禁控制器');
    const building = context.availableBuildings.find((item) => item.id === dto.buildingId);
    if (!building?.routeReady || !building.accessSystem) {
      throw new BadRequestException('所选楼栋不属于当前门禁区域，或门禁路由尚未配置');
    }
    if (building.accessSystem === 'mjsystem' && dto.operation !== 'remote_open') {
      throw new BadRequestException('MjSystem 当前只开放已现场验证的立即远程开门；设备检测和临时常开协议尚未验收');
    }
    const agents = await this.agentRepo.find({ where: { tenantId, kind: 'access_gateway', enabled: true } });
    const gateway = orderAgentsByAvailability(agents).find((agent) => effectiveAgentStatus(agent) === 'online'
      && agent.capabilities?.remoteDoorControl === true && supportsRemoteDoorControl(agent.version));
    if (!gateway) throw new ServiceUnavailableException('门禁远程控制需要 .88 电脑升级 PMS 数据同步助手 2.5.46 或更新版本');
    const durationSeconds = dto.operation === 'temporary_open' ? dto.durationSeconds : null;
    if (dto.operation === 'temporary_open' && (!durationSeconds || durationSeconds < 60 || durationSeconds > 86_400)) {
      throw new BadRequestException('临时开门时长必须在 1 分钟至 24 小时之间');
    }
    return this.enqueueHistoryAuthorization({
      tenantId, houseId, historyId: 0, roomKey: context.house.roomKey, cardSequence: null,
      operation: dto.operation, icCardNo: null, wgCardNo: '__door_operation__',
      targetBuildings: [{ id: building.id, buildingNo: building.buildingNo, accessSystem: building.accessSystem }],
      durationSeconds, idempotencyKey, userId: user.id,
    });
  }

  async createStandaloneDoorOperation(
    dto: CreateAccessDoorOperationDto,
    user: AuthUser,
    access?: ResolvedAccess,
  ) {
    const tenantId = this.requireTenant(user);
    const building = await this.buildingRepo.findOne({ where: { id: dto.buildingId, tenantId } });
    if (!building) throw new NotFoundException('所选楼栋不存在');
    const community = await this.communityRepo.findOne({ where: { id: building.communityId, tenantId } });
    if (!community || projectPhaseOf(community.name) !== 'phase2') {
      throw new BadRequestException('所选楼栋不属于枫桦景苑二期门禁区域');
    }
    const scope = scopeCommunityIds(access);
    if (scope && !scope.includes(community.id)) throw new ForbiddenException('该楼栋不在你的管理范围内');
    if (!accessSystemOf('phase2', building.buildingNo)) {
      throw new BadRequestException('所选楼栋的门禁路由尚未配置');
    }
    const referenceHouse = await this.houseRepo.findOne({
      where: { tenantId, buildingId: building.id },
      order: { id: 'ASC' },
    });
    if (!referenceHouse) throw new BadRequestException('所选楼栋没有可用于门禁任务的房产记录');
    return this.createDoorOperation(referenceHouse.id, dto, user, access);
  }

  /**
   * 门禁主板远程控制：复用既有 AccessCardAuthorization 任务通道（access_gateway 领取、
   * history-authorizations/report 回报），不新建任务表/任务队列。
   *
   * controllerId 当前即 PMS 楼栋 ID：现场路由是「一栋楼 → 唯一实体门/控制器」，
   * doorNo 只做一致性校验；以后支持一楼多门时再扩展。
   */
  async openDoor(dto: OpenAccessDoorDto, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    const building = await this.buildingRepo.findOne({ where: { id: dto.controllerId, tenantId } });
    if (!building) throw new NotFoundException('门禁控制器不存在');
    if (building.communityId !== dto.communityId) throw new BadRequestException('控制器不属于所选小区');
    const community = await this.communityRepo.findOne({ where: { id: building.communityId, tenantId } });
    if (!community || projectPhaseOf(community.name) !== 'phase2') {
      throw new BadRequestException('所选控制器不属于枫桦景苑二期联网门禁区域');
    }
    const scope = scopeCommunityIds(access);
    if (scope && !scope.includes(community.id)) throw new ForbiddenException('该控制器不在你的管理范围内');
    const accessSystem = accessSystemOf('phase2', building.buildingNo);
    if (!accessSystem) throw new BadRequestException('所选楼栋的门禁路由尚未配置');
    const logicalDoorNo = this.logicalDoorNo(building.buildingNo);
    if (dto.doorNo != null && logicalDoorNo != null && dto.doorNo !== logicalDoorNo) {
      throw new BadRequestException(`该楼栋只支持一个实体门，门号应为 ${logicalDoorNo}`);
    }

    let durationSeconds: number | null = null;
    if (dto.operation === 'temporary_open') {
      if (!dto.minutes || dto.minutes < 1 || dto.minutes > 60) {
        throw new BadRequestException('临时常开时长必须在 1–60 分钟之间');
      }
      // MjSystem 临时常开协议未现场验收：明确拒绝，不进入任务重试。
      if (accessSystem === 'mjsystem') {
        throw new BadRequestException('当前控制器不支持常开：MjSystem 仅开放立即远程开门');
      }
      durationSeconds = dto.minutes * 60;
    } else if (dto.minutes != null) {
      throw new BadRequestException('远程开门不需要 minutes');
    }

    const idempotencyKey = dto.idempotencyKey.trim();
    const existing = await this.authorizationRepo.findOne({ where: { tenantId, idempotencyKey } });
    if (existing) {
      const existingTarget = existing.targetBuildings?.[0];
      if (existingTarget && existingTarget.id !== building.id) {
        throw new BadRequestException('该幂等键已用于其他控制器/门禁任务，请刷新后重试');
      }
      return this.doorTaskResponse(existing, building);
    }

    const task = await this.createStandaloneDoorOperation({
      buildingId: building.id,
      operation: dto.operation,
      durationSeconds: durationSeconds ?? undefined,
      idempotencyKey,
    }, user, access);
    if (!task) throw new ServiceUnavailableException('门禁任务创建失败，请稍后重试');
    await this.writeDoorAudit(tenantId, task.id, building, dto, durationSeconds, user.id);
    return this.doorTaskResponse(task, building);
  }

  async getDoorTask(id: number, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    const task = await this.authorizationRepo.findOne({ where: { id, tenantId } });
    if (!task || !this.isDoorOperation(task.operation)) throw new NotFoundException('门禁控制任务不存在');
    const target = task.targetBuildings?.[0];
    const building = target
      ? await this.buildingRepo.findOne({ where: { id: target.id, tenantId } })
      : null;
    if (building) {
      const scope = scopeCommunityIds(access);
      if (scope && !scope.includes(building.communityId)) throw new ForbiddenException('该任务不在你的管理范围内');
    }
    return this.doorTaskResponse(task, building ?? undefined);
  }

  /**
   * 控制器/门板在线状态。
   * 没有单独的硬件在线表：复用 access_card_authorizations 中 agent 最近一次
   * controller_detect / remote_open / temporary_open 的逐楼回执（含 controller/SN/时间），
   * 叠加 access_gateway 心跳能力，推导 online/offline/pending/unknown。
   */
  async listDoorControllers(user: AuthUser, access?: ResolvedAccess, communityId?: number) {
    const tenantId = this.requireTenant(user);
    const scope = scopeCommunityIds(access);
    // 网关在线判定与「所选小区是否二期」解耦：先看真实 access_gateway，
    // 再看有哪些二期小区可远程控制，避免一期小区被误报成助手离线。
    const communities = (await this.communityRepo.find({ where: { tenantId, enabled: true } }))
      .filter((community) => !scope || scope.includes(community.id));
    const phase2Communities = communities.filter((community) => projectPhaseOf(community.name) === 'phase2');
    const gatewayAgents = await this.agentRepo.find({ where: { tenantId, kind: 'access_gateway', enabled: true } });
    const gateway = orderAgentsByAvailability(gatewayAgents).find((agent) =>
      effectiveAgentStatus(agent) === 'online'
      && agent.capabilities?.remoteDoorControl === true
      && supportsRemoteDoorControl(agent.version));
    const gatewayInfo = {
      agentOnline: Boolean(gateway),
      gatewayVersion: gateway?.version ?? null,
      checkedAt: new Date().toISOString(),
    };
    const selectedPhase2 = communityId == null
      ? phase2Communities
      : phase2Communities.filter((community) => community.id === communityId);
    if (!selectedPhase2.length) {
      // 一期/不存在的小区确实没有二期控制器，但网关状态必须反映真实心跳。
      const doorControlNames = phase2Communities.map((community) => community.name).join('、');
      const selectedCommunity = communityId == null
        ? null
        : communities.find((community) => community.id === communityId);
      const message = communityId == null
        ? '当前没有可远程控制的二期联网门禁小区'
        : selectedCommunity
          ? `所选小区「${selectedCommunity.name}」不属于二期联网门禁，可远程控制的是：${doorControlNames || '（暂无二期小区）'}`
          : '所选小区不存在或不在你的管理范围内';
      return { ...gatewayInfo, message, controllers: [] };
    }
    const communityIds = selectedPhase2.map((community) => community.id);
    const [buildings, tasks] = await Promise.all([
      this.buildingRepo.find({ where: { tenantId, communityId: In(communityIds) } }),
      this.authorizationRepo.find({
        where: { tenantId, operation: In(['controller_detect', 'remote_open', 'temporary_open']) },
        order: { createdAt: 'DESC' },
        take: 300,
      }),
    ]);
    const controllers = buildings
      .filter((building) => accessSystemOf('phase2', building.buildingNo) !== null)
      .map((building) => {
        const system = accessSystemOf('phase2', building.buildingNo)!;
        const lastTask = tasks.find((task) =>
          (task.targetBuildings ?? []).some((target) =>
            target.id === building.id
            || normalizeBuildingNo(target.buildingNo) === normalizeBuildingNo(building.buildingNo)));
        const receipt = lastTask?.controllerResults?.[lastTask.controllerResults.length - 1]
          ?? lastTask?.controllerResults?.[0];
        let controllerStatus: 'online' | 'offline' | 'pending' | 'unknown' = 'unknown';
        if (!gateway) controllerStatus = 'offline';
        else if (lastTask?.status === 'completed') controllerStatus = 'online';
        else if (lastTask?.status === 'failed') controllerStatus = 'offline';
        else if (lastTask && ['pending', 'running'].includes(lastTask.status)) controllerStatus = 'pending';
        return {
          communityId: building.communityId,
          communityName: selectedPhase2.find((community) => community.id === building.communityId)?.name ?? null,
          controllerId: building.id,
          buildingNo: building.buildingNo,
          doorNo: this.logicalDoorNo(building.buildingNo),
          doorName: typeof receipt?.door === 'string' ? receipt.door : `${building.buildingNo}号楼门`,
          controllerName: typeof receipt?.controller === 'string' ? receipt.controller : null,
          accessSystem: system,
          routeReady: true,
          agentOnline: Boolean(gateway),
          status: controllerStatus,
          supportRemoteOpen: true,
          supportTemporaryOpen: system === 'iccard',
          lastOperation: lastTask?.operation ?? null,
          lastCheckedAt: lastTask ? (lastTask.completedAt ?? lastTask.requestedAt) : null,
          lastError: lastTask?.status === 'failed' ? lastTask.lastError : null,
        };
      })
      .sort((left, right) => left.buildingNo.localeCompare(right.buildingNo, 'zh-CN', { numeric: true }));
    return {
      ...gatewayInfo,
      message: null as string | null,
      controllers,
    };
  }

  /**
   * 重新检查在线状态：复用 controller_detect 任务通道，逐控制器入队探测任务。
   * - 每块控制器一条任务（现有 ExecuteDoorOperation 只支持单目标）；
   * - agent 离线或版本 < 2.5.46 直接 503，不入队；
   * - 同一控制器 10 秒内复用原任务，不重复下发；
   * - MjSystem 检测协议未验收，跳过并明确返回原因，不伪造在线。
   */
  async checkDoorOnline(dto: CheckDoorOnlineDto, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    const community = await this.communityRepo.findOne({
      where: { id: dto.communityId, tenantId, enabled: true },
    });
    if (!community || projectPhaseOf(community.name) !== 'phase2') {
      throw new BadRequestException('所选小区不属于枫桦景苑二期联网门禁区域');
    }
    const scope = scopeCommunityIds(access);
    if (scope && !scope.includes(community.id)) throw new ForbiddenException('该小区不在你的管理范围内');

    const buildings = await this.buildingRepo.find({ where: { tenantId, communityId: community.id } });
    const byId = new Map(buildings.map((building) => [building.id, building]));
    const requestedIds = Array.from(new Set(dto.controllerIds ?? []));
    let selected: Building[];
    if (requestedIds.length) {
      selected = requestedIds.map((id) => {
        const building = byId.get(id);
        if (!building) throw new NotFoundException(`控制器 ${id} 不存在或不属于该小区`);
        if (!accessSystemOf('phase2', building.buildingNo)) {
          throw new BadRequestException(`${building.buildingNo}号楼的门禁路由尚未配置`);
        }
        return building;
      });
    } else {
      selected = buildings.filter((building) => accessSystemOf('phase2', building.buildingNo) !== null);
    }

    const agents = await this.agentRepo.find({ where: { tenantId, kind: 'access_gateway', enabled: true } });
    const gateway = orderAgentsByAvailability(agents).find((agent) =>
      effectiveAgentStatus(agent) === 'online'
      && agent.capabilities?.remoteDoorControl === true
      && supportsRemoteDoorControl(agent.version));
    if (!gateway) {
      throw new ServiceUnavailableException('门禁在线检查需要 .88 电脑升级 PMS 数据同步助手 2.5.46 或更新版本，且网关在线');
    }

    // 10 秒防抖：同一控制器的 pending/running 任务，或 10 秒内已完成/失败的任务，直接复用。
    const recentTasks = await this.authorizationRepo.find({
      where: { tenantId, operation: In(['controller_detect']) },
      order: { createdAt: 'DESC' },
      take: 200,
    });
    const cutoff = Date.now() - 10_000;
    const reusable = new Map<number, AccessCardAuthorization>();
    for (const task of recentTasks) {
      const active = task.status === 'pending' || task.status === 'running';
      const createdAt = task.createdAt?.getTime() ?? task.requestedAt?.getTime() ?? 0;
      if (!active && createdAt < cutoff) continue;
      for (const target of task.targetBuildings ?? []) {
        if (!reusable.has(target.id)) reusable.set(target.id, task);
      }
    }

    const taskIds: number[] = [];
    const skipped: Array<{ controllerId: number; buildingNo: string; reason: string }> = [];
    let queued = 0;
    let reused = 0;
    for (const building of selected) {
      const system = accessSystemOf('phase2', building.buildingNo);
      if (system !== 'iccard') {
        skipped.push({
          controllerId: building.id,
          buildingNo: building.buildingNo,
          reason: 'MjSystem 检测协议未验收，仅支持立即远程开门',
        });
        continue;
      }
      const existing = reusable.get(building.id);
      if (existing) {
        taskIds.push(existing.id);
        reused += 1;
        continue;
      }
      const task = await this.createStandaloneDoorOperation({
        buildingId: building.id,
        operation: 'controller_detect',
        idempotencyKey: `door-check-${community.id}-${building.id}-${Date.now()}-${taskIds.length}`,
      }, user, access);
      if (!task) throw new ServiceUnavailableException('门禁探测任务创建失败，请稍后重试');
      taskIds.push(task.id);
      queued += 1;
    }

    await this.writeDoorCheckAudit(tenantId, community.id, dto, taskIds, queued, reused, skipped, user.id);
    return { taskIds, queued, reused, skipped };
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
    if (task.operation === 'controller_revoke') {
      await this.requirePermissionRevokeGateway(tenantId);
    } else {
      await this.requireHistoryAuthorizationGateway(tenantId);
    }
    task.status = 'pending';
    task.attempt = 0;
    task.controllerResults = task.controllerResults.filter((row) => this.authorizationResultSucceeded(task.operation, row));
    task.completedAt = null;
    task.leaseAgentKey = null;
    task.leaseExpiresAt = null;
    task.lastError = null;
    task.updatedBy = user.id;
    return this.historyAuthorizationResponse(await this.authorizationRepo.save(task));
  }

  /**
   * 延期/挂失/解挂/注销/换卡/补卡：接口先占位，明确拒绝而不是猜测外部库语义。
   * 现场确认 .80 捷顺库/ .88 Access 库的状态码与表字段后，再逐项接入 Agent 任务与写库。
   */
  async requestCardLifecycle(dto: CreateAccessCardLifecycleDto, user: AuthUser) {
    this.requireTenant(user);
    const labels: Record<CreateAccessCardLifecycleDto['operation'], string> = {
      extend: '延期',
      lost: '挂失',
      unlost: '解挂',
      cancel: '注销',
      replace: '换卡',
      reissue: '补卡',
    };
    throw new HttpException({
      statusCode: 501,
      error: 'Not Implemented',
      message: `门禁卡「${labels[dto.operation]}」暂未开放：.80 捷顺库与 .88 Access 库的写入语义（状态码、表字段、是否走原厂 SDK）尚未现场取证。已完成只读查询、能力探测与副本写测试，详见 docs/access-card-gap.md 与 tools/access-db-lab。`,
      operation: dto.operation,
    }, 501);
  }

  async readiness(user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    const [agents, communities] = await Promise.all([
      this.agentRepo.find({ where: { tenantId }, order: { id: 'ASC' } }),
      this.communityRepo.find({ where: { tenantId, enabled: true } }),
    ]);
    const scope = scopeCommunityIds(access);
    // 前端据此渲染小区下拉并默认选中二期，避免按地址树顺序猜（communities[0] 常是一期）。
    const doorControlCommunities = communities
      .filter((community) => projectPhaseOf(community.name) === 'phase2')
      .filter((community) => !scope || scope.includes(community.id))
      .map((community) => ({ id: community.id, name: community.name }))
      .sort((left, right) => left.id - right.id);
    const phase2CommunityIds = doorControlCommunities.map((community) => community.id);
    const doorBuildings = phase2CommunityIds.length
      ? await this.buildingRepo.find({ where: { tenantId, communityId: In(phase2CommunityIds) } })
      : [];
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
    const cardWrite = agents.some((agent) =>
      agent.kind === 'issuer' && effectiveAgentStatus(agent) === 'online'
      && agent.capabilities?.cardWrite === true);
    const legacyDbWrite = agents.some((agent) =>
      agent.kind === 'legacy_sync' && effectiveAgentStatus(agent) === 'online'
      && agent.capabilities?.legacyDbWrite === true);
    // 只读查询能力：.88 按房号/卡号/姓名/通行记录查询，.80 人员与卡搜索。
    const accessCardQuery = agents.some((agent) =>
      agent.kind === 'access_gateway' && effectiveAgentStatus(agent) === 'online'
      && agent.capabilities?.accessCardQuery === true);
    const legacyCardQuery = agents.some((agent) =>
      agent.kind === 'legacy_sync' && effectiveAgentStatus(agent) === 'online'
      && agent.capabilities?.legacyCardQuery === true);
    return {
      simulationEnabled,
      features: {
        cardWrite,
        legacyDbWrite,
        accessDbWrite,
        parkingDbRead: true,
        parkingDbWrite,
        controllerUpload,
        historicalAccessGrant,
        accessCardQuery,
        legacyCardQuery,
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
      doorControlBuildings: doorBuildings
        .map((building) => ({
          id: building.id,
          buildingNo: building.buildingNo,
          accessSystem: accessSystemOf('phase2', building.buildingNo),
          routeReady: accessSystemOf('phase2', building.buildingNo) !== null,
        }))
        .filter((building) => building.routeReady)
        .sort((left, right) => left.buildingNo.localeCompare(right.buildingNo, 'zh-CN', { numeric: true })),
      doorControlCommunities,
      deliyun,
    };
  }

  /** 搜索词能唯一落到一户时，返回 弄/楼号/室号；否则 null（照原样交给 parseParkingSearch） */
  private async houseTermFromAddress(tenantId: number, input: string): Promise<string | null> {
    const ds = this.parkingQueryRepo.manager.connection;
    const hit = await resolveAddressForTenant(ds, tenantId, input).catch(() => null);
    if (!hit || hit.level !== 'house' || hit.houseIds.length !== 1) return null;
    for (const c of await loadAddressTreeLite(ds, tenantId)) {
      for (const b of c.buildings) {
        const h = b.houses.find((x) => x.id === hit.houseIds[0]);
        if (h) return b.lane ? `${b.lane}/${b.buildingNo}/${h.roomNo}` : null;
      }
    }
    return null;
  }

  async createParkingQuery(dto: CreateParkingQueryDto, user: AuthUser) {
    const tenantId = this.requireTenant(user);
    let term: string;
    // 一期20号601、枫桦景苑一期20号601室… 先按地址簿落到唯一一户，再写成停车库认的 198/20/601
    const raw = (await this.houseTermFromAddress(tenantId, dto.term)) ?? dto.term;
    try {
      term = parseParkingSearch(raw).term;
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
      queryKind: 'vehicle',
      database: dto.database ?? null,
      rangeStart: null,
      rangeEnd: null,
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

  async findDeliyunVehicles(plate: string, user: AuthUser) {
    this.requireTenant(user);
    return this.deliyun.findVehiclesByPlate(plate);
  }

  async renewDeliyunVehicle(dto: RenewDeliyunVehicleDto, user: AuthUser) {
    const tenantId = this.requireTenant(user);
    const idempotencyKey = dto.idempotencyKey.trim();
    const existing = await this.parkingOperationRepo.findOne({ where: { tenantId, idempotencyKey } });
    if (existing) return this.parkingOperationResponse(existing);
    const now = new Date();
    const task = await this.parkingOperationRepo.save(this.parkingOperationRepo.create({
      tenantId, kind: 'renew_vehicle', database: 'deliyun', idempotencyKey,
      sourceRecordId: dto.vehicleId.trim(), pmsUserId: null,
      payload: { plate: dto.plate.trim().toUpperCase(), previousEndDate: dto.previousEndDate, endDate: dto.endDate },
      expected: { previousEndDate: dto.previousEndDate }, result: null, status: 'running', attempt: 1,
      requestedAt: now, completedAt: null, leaseAgentKey: null, leaseExpiresAt: null,
      lastError: null, rollbackOfOperationId: null, createdBy: user.id, updatedBy: user.id,
    }));
    try {
      task.result = await this.deliyun.renewVehicle({
        vehicleId: dto.vehicleId, plate: dto.plate,
        previousEndDate: dto.previousEndDate, endDate: dto.endDate,
      });
      task.status = 'completed';
      task.completedAt = new Date();
      task.lastError = null;
    } catch (error) {
      task.status = 'failed';
      task.completedAt = new Date();
      task.lastError = (error instanceof Error ? error.message : '德立云有效期续期失败').slice(0, 500);
    }
    task.updatedBy = user.id;
    return this.parkingOperationResponse(await this.parkingOperationRepo.save(task));
  }

  async changeDeliyunPlate(dto: ChangeDeliyunPlateDto, user: AuthUser) {
    const tenantId = this.requireTenant(user);
    const idempotencyKey = dto.idempotencyKey.trim();
    const existing = await this.parkingOperationRepo.findOne({ where: { tenantId, idempotencyKey } });
    if (existing) return this.parkingOperationResponse(existing);
    const task = await this.parkingOperationRepo.save(this.parkingOperationRepo.create({
      tenantId, kind: 'change_plate', database: 'deliyun', idempotencyKey,
      sourceRecordId: dto.vehicleId.trim(), pmsUserId: null,
      payload: { plate: dto.plate, newPlate: dto.newPlate }, expected: { plate: dto.plate },
      result: null, status: 'running', attempt: 1, requestedAt: new Date(), completedAt: null,
      leaseAgentKey: null, leaseExpiresAt: null, lastError: null, rollbackOfOperationId: null,
      createdBy: user.id, updatedBy: user.id,
    }));
    try {
      task.result = await this.deliyun.changePlate(dto);
      task.status = 'completed';
    } catch (error) {
      task.status = 'failed';
      task.lastError = (error instanceof Error ? error.message : '人防换牌失败').slice(0, 500);
    }
    task.completedAt = new Date();
    return this.parkingOperationResponse(await this.parkingOperationRepo.save(task));
  }

  async setDeliyunCivilDefenseAuthorization(dto: SetDeliyunCivilDefenseAuthorizationDto, user: AuthUser, retryFailed = false) {
    const tenantId = this.requireTenant(user);
    const idempotencyKey = dto.idempotencyKey.trim();
    const existing = await this.parkingOperationRepo.findOne({ where: { tenantId, idempotencyKey } });
    if (dto.authorized) {
      const proof = await this.parkingOperationRepo.manager.getRepository(ParkingProofUpload).findOne({ where: { tenantId, plate: dto.plate.trim().toUpperCase() }, order: { createdAt: 'DESC' } });
      if (proof?.registrationId && proof.reviewStatus !== 'approved') throw new BadRequestException('亲情车资料尚未审核通过，不允许开通人防车库');
    }
    if (existing && (!retryFailed || existing.status !== 'failed')) return this.parkingOperationResponse(existing);
    if (existing) {
      const acquired = await this.parkingOperationRepo.manager.transaction(async (manager) => {
        const repo = manager.getRepository(ParkingOperation);
        const locked = await repo.findOne({ where: { id: existing.id, tenantId }, lock: { mode: 'pessimistic_write' } });
        if (!locked || locked.status !== 'failed') return false;
        locked.status = 'running'; locked.attempt += 1; locked.lastError = null; locked.completedAt = null;
        await repo.save(locked); Object.assign(existing, locked); return true;
      });
      if (!acquired) return this.parkingOperationResponse((await this.parkingOperationRepo.findOne({ where: { id: existing.id, tenantId } }))!);
    }
    const now = new Date();
    const task = existing || await this.parkingOperationRepo.save(this.parkingOperationRepo.create({
      tenantId, kind: 'update_garages', database: 'deliyun', idempotencyKey,
      sourceRecordId: dto.vehicleId?.trim() || null, pmsUserId: null,
      payload: {
        plate: dto.plate.trim().toUpperCase(), authorized: dto.authorized,
        ownerRoom: dto.ownerRoom || null, parkingSpace: dto.parkingSpace || null,
        beginDate: dto.beginDate || null, endDate: dto.endDate || null, remark: dto.remark || null,
      },
      expected: { vehicleId: dto.vehicleId?.trim() || null }, result: null, status: 'running', attempt: 1,
      requestedAt: now, completedAt: null, leaseAgentKey: null, leaseExpiresAt: null,
      lastError: null, rollbackOfOperationId: null, createdBy: user.id, updatedBy: user.id,
    }));
    try {
      task.result = await this.deliyun.setCivilDefenseAuthorization({
        plate: dto.plate,
        authorized: dto.authorized,
        ownerRoom: dto.ownerRoom,
        parkingSpace: dto.parkingSpace,
        vehicleId: dto.vehicleId,
        beginDate: dto.beginDate,
        endDate: dto.endDate,
        remark: dto.remark,
      });
      task.status = 'completed';
      task.completedAt = new Date();
      task.lastError = null;
    } catch (error) {
      task.status = 'failed';
      task.completedAt = new Date();
      task.lastError = (error instanceof Error ? error.message : '德立云人防车库授权失败').slice(0, 500);
    }
    task.updatedBy = user.id;
    return this.parkingOperationResponse(await this.parkingOperationRepo.save(task));
  }

  async getParkingQuery(id: number, user: AuthUser) {
    const tenantId = this.requireTenant(user);
    const query = await this.parkingQueryRepo.findOne({ where: { id, tenantId, queryKind: 'vehicle' } });
    if (!query) throw new NotFoundException('停车查询不存在或已失效');
    return this.parkingQueryResponse(query);
  }

  async createParkingMovementQuery(dto: CreateParkingMovementQueryDto, user: AuthUser) {
    const tenantId = this.requireTenant(user);
    let input: ReturnType<typeof parseParkingMovementRange>;
    try { input = parseParkingMovementRange(dto.plate, dto.startDate, dto.endDate); }
    catch (error) { throw new BadRequestException(error instanceof Error ? error.message : '进出记录查询条件不正确'); }
    const agents = await this.agentRepo.find({ where: { tenantId, kind: 'parking_gateway', enabled: true } });
    const gateway = orderAgentsByAvailability(agents).find((agent) =>
      effectiveAgentStatus(agent) === 'online' && agent.capabilities?.parkingDbRead === true &&
      supportsParkingMovementQueries(agent.version));
    if (!gateway) throw new ServiceUnavailableException('进出记录查询需要在线的 2.5.27 或更新版本数据同步助手');
    const query = this.parkingQueryRepo.create({
      tenantId, term: input.plate, queryKind: 'movement', rangeStart: input.startDate, rangeEnd: input.endDate,
      status: 'pending', rows: [], attempt: 0, requestedAt: new Date(), completedAt: null,
      leaseAgentKey: null, leaseExpiresAt: null, lastError: null, createdBy: user.id, updatedBy: user.id,
    });
    return this.parkingMovementResponse(await this.parkingQueryRepo.save(query));
  }

  async getParkingMovementQuery(id: number, user: AuthUser) {
    const tenantId = this.requireTenant(user);
    const query = await this.parkingQueryRepo.findOne({ where: { id, tenantId, queryKind: 'movement' } });
    if (!query) throw new NotFoundException('进出记录查询不存在或已失效');
    return this.parkingMovementResponse(query);
  }

  async createParkingFeeReport(dto: CreateParkingFeeReportDto, user: AuthUser, access: ResolvedAccess) {
    if (!access.scopeAll) throw new ForbiddenException('停车金额报表目前仅支持全公司数据范围；请退出管理处视角或联系管理员');
    const tenantId = this.requireTenant(user);
    try { parseParkingFeeReportRange(dto.startDate, dto.endDate); }
    catch (error) { throw new BadRequestException(error instanceof Error ? error.message : '金额报表日期不正确'); }
    const agents = await this.agentRepo.find({ where: { tenantId, kind: 'parking_gateway', enabled: true } });
    const gateway = orderAgentsByAvailability(agents).find((agent) =>
      effectiveAgentStatus(agent) === 'online' && agent.capabilities?.parkingDbRead === true &&
      supportsParkingFeeReports(agent.version));
    if (!gateway) throw new ServiceUnavailableException('金额报表需要在线的 2.5.27 或更新版本数据同步助手');
    const query = this.parkingQueryRepo.create({
      tenantId, term: '停车金额报表', queryKind: 'fee_report', rangeStart: dto.startDate, rangeEnd: dto.endDate,
      status: 'pending', rows: [], attempt: 0, requestedAt: new Date(), completedAt: null,
      leaseAgentKey: null, leaseExpiresAt: null, lastError: null, createdBy: user.id, updatedBy: user.id,
    });
    return this.parkingFeeReportResponse(await this.parkingQueryRepo.save(query));
  }

  async getParkingFeeReport(id: number, user: AuthUser, access: ResolvedAccess) {
    if (!access.scopeAll) throw new ForbiddenException('当前数据范围不能查看全公司停车金额报表');
    const tenantId = this.requireTenant(user);
    const query = await this.parkingQueryRepo.findOne({ where: { id, tenantId, queryKind: 'fee_report' } });
    if (!query) throw new NotFoundException('金额报表查询不存在或已失效');
    return this.parkingFeeReportResponse(query);
  }

  /** 旧停车库按车辆授权类型拉整张清单（只读），如「亲情车」；结果在 parking_queries.rows */
  async createParkingIdentityList(identity: string, user: AuthUser) {
    const tenantId = this.requireTenant(user);
    const agents = await this.agentRepo.find({ where: { tenantId, kind: 'parking_gateway', enabled: true } });
    if (!orderAgentsByAvailability(agents).some((agent) => effectiveAgentStatus(agent) === 'online' &&
      agent.capabilities?.parkingDbRead === true && supportsParkingIdentityList(agent.version)))
      throw new ServiceUnavailableException('从旧停车库拉清单需要在线的 2.5.49 或更新版本数据同步助手（会自动升级，稍后再试）');
    const query = this.parkingQueryRepo.create({
      tenantId, term: identity, queryKind: 'identity_list', rangeStart: null, rangeEnd: null,
      status: 'pending', rows: [], attempt: 0, requestedAt: new Date(), completedAt: null,
      leaseAgentKey: null, leaseExpiresAt: null, lastError: null, createdBy: user.id, updatedBy: user.id,
    });
    return this.parkingQueryRepo.save(query);
  }

  async getParkingIdentityList(id: number, user: AuthUser) {
    const tenantId = this.requireTenant(user);
    const query = await this.parkingQueryRepo.findOne({ where: { id, tenantId, queryKind: 'identity_list' } });
    if (!query) throw new NotFoundException('清单查询不存在或已失效');
    return query;
  }

  async createParkingFeeDetail(dto: CreateParkingFeeDetailDto, user: AuthUser, access: ResolvedAccess) {
    if (!access.scopeAll) throw new ForbiddenException('当前数据范围不能查看全公司停车金额明细');
    const tenantId = this.requireTenant(user);
    try { parseParkingFeeReportRange(dto.startDate, dto.endDate); }
    catch (error) { throw new BadRequestException(error instanceof Error ? error.message : '金额明细日期不正确'); }
    if (!['renewal', 'temporary'].includes(dto.category) || !Number.isInteger(dto.page) || dto.page < 1 || dto.page > 1000)
      throw new BadRequestException('金额明细类别或页码不正确');
    const agents = await this.agentRepo.find({ where: { tenantId, kind: 'parking_gateway', enabled: true } });
    if (!orderAgentsByAvailability(agents).some((agent) => effectiveAgentStatus(agent) === 'online' &&
      agent.capabilities?.parkingDbRead === true && supportsParkingFeeDetails(agent.version)))
      throw new ServiceUnavailableException('金额明细分页需要在线的 2.5.28 或更新版本数据同步助手');
    const query = this.parkingQueryRepo.create({
      tenantId, term: `${dto.category}:${dto.page}`, queryKind: 'fee_detail', rangeStart: dto.startDate, rangeEnd: dto.endDate,
      status: 'pending', rows: [], attempt: 0, requestedAt: new Date(), completedAt: null,
      leaseAgentKey: null, leaseExpiresAt: null, lastError: null, createdBy: user.id, updatedBy: user.id,
    });
    return this.parkingFeeReportResponse(await this.parkingQueryRepo.save(query));
  }

  async getParkingFeeDetail(id: number, user: AuthUser, access: ResolvedAccess) {
    if (!access.scopeAll) throw new ForbiddenException('当前数据范围不能查看全公司停车金额明细');
    const tenantId = this.requireTenant(user);
    const query = await this.parkingQueryRepo.findOne({ where: { id, tenantId, queryKind: 'fee_detail' } });
    if (!query) throw new NotFoundException('金额明细查询不存在或已失效');
    return this.parkingFeeReportResponse(query);
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
      (!(dto.payload?.identity === '亲情车' || dto.payload?.familyReviewId) || supportsFamilyActivation(agent.version)) &&
      (dto.kind !== 'rebind_owner' || supportsParkingOwnerRebind(agent.version)) &&
      (dto.kind !== 'sync_vehicle_info' || supportsParkingVehicleSync(agent.version)) &&
      (!['update_garages', 'update_vehicle_type', 'download_vehicle'].includes(dto.kind) || supportsParkingAuthorizationFixes(agent.version)) &&
      (dto.kind !== 'download_vehicle' || supportsParkingDeviceConfirmation(agent.version)));
    if (!gateway) throw new ServiceUnavailableException(dto.payload?.identity === '亲情车' || dto.payload?.familyReviewId ? '亲情车待审核登记与自动开通需要现场助手升级到 2.5.40' : dto.kind === 'rebind_owner'
      ? '变更绑定用户需要 PMS 数据同步助手 2.5.20 及以上版本，请先更新现场助手'
      : dto.kind === 'sync_vehicle_info' ? '车辆资料复用需要 PMS 数据同步助手 2.5.23 及以上版本，请先在现场电脑升级'
      : dto.kind === 'download_vehicle' ? '停车设备下发需要 PMS 数据同步助手 2.5.47 或更新版本，旧版只能写入队列、不能确认设备完成'
      : ['update_garages', 'update_vehicle_type'].includes(dto.kind) ? '车库授权和车辆类型修改需要 PMS 数据同步助手 2.5.21 及以上版本，请先更新现场助手'
      : '停车网关尚未就绪：请安装 2.4.0 及以上助手并确认旧库存储过程写入权限');
    const payload = normalizeParkingOperationPayload(dto.payload);
    const expected = normalizeParkingOperationPayload(dto.expected ?? {});
    let familyProof: ParkingProofUpload | null = null;
    if (dto.kind === 'add_vehicle' && payload.identity === '亲情车') {
      familyProof = await this.parkingOperationRepo.manager.getRepository(ParkingProofUpload).findOne({ where: { id: Number(payload.proofUploadId) || 0, tenantId } });
      prepareFamilyRegistration(payload, familyProof);
    }
    if (['update_garages', 'download_vehicle'].includes(dto.kind)) {
      const proof = await this.parkingOperationRepo.manager.getRepository(ParkingProofUpload).findOne({ where: { tenantId, plate: String(payload.plate || '').trim().toUpperCase() }, order: { createdAt: 'DESC' } });
      if (proof?.registrationId && proof.reviewStatus !== 'approved') throw new BadRequestException('亲情车资料尚未审核通过，不允许授权或下发');
      if (payload.familyReviewId && (!proof || proof.id !== Number(payload.familyReviewId) || proof.reviewStatus !== 'approved')) throw new BadRequestException('亲情车审核凭证不匹配');
      if (payload.familyReviewId && !supportsFamilyActivation(gateway.version))
        throw new ServiceUnavailableException('亲情车审核自动开通需要现场助手升级到 2.5.40');
    }
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
    if (familyProof) {
      return this.parkingOperationRepo.manager.transaction(async (manager) => {
        const proofs = manager.getRepository(ParkingProofUpload);
        const locked = await proofs.findOne({ where: { id: familyProof!.id, tenantId }, lock: { mode: 'pessimistic_write' } });
        prepareFamilyRegistration(payload, locked);
        const saved = await manager.getRepository(ParkingOperation).save(task);
        locked!.registrationId = saved.id;
        locked!.updatedBy = user.id;
        await proofs.save(locked!);
        return this.parkingOperationResponse(saved);
      });
    }
    return this.parkingOperationResponse(await this.parkingOperationRepo.save(task));
  }

  async reviewParkingProof(id: number, decision: 'approved' | 'rejected', reason: string | undefined, user: AuthUser) {
    const tenantId = this.requireTenant(user);
    const proof = await this.parkingOperationRepo.manager.transaction(async (manager) => {
      const repo = manager.getRepository(ParkingProofUpload);
      const row = await repo.findOne({ where: { id, tenantId }, lock: { mode: 'pessimistic_write' } });
      if (!row) throw new NotFoundException('亲情车资料不存在');
      // 亲情车管理登记的资料要走办公室 + 物业经理两级审核，不能在停车管理里一步通过
      if (row.familyCarId) throw new BadRequestException('该车辆在「亲情车管理」办理，请到亲情车管理审核');
      if (row.reviewStatus === 'approved' && decision !== 'approved') throw new BadRequestException('已通过审核的车辆不能直接驳回，请先调整车库授权');
      if (decision === 'rejected' && !reason?.trim()) throw new BadRequestException('请填写驳回原因');
      if (decision === 'approved' && !row.submittedAt) throw new BadRequestException('用户尚未上传证明材料，不能通过审核');
      if (!row.registrationId) throw new BadRequestException('请先保存待审核车牌');
      const registration = await manager.getRepository(ParkingOperation).findOne({ where: { id: row.registrationId, tenantId } });
      if (registration?.status !== 'completed') throw new BadRequestException('待审核车辆尚未完成旧库保存，请先确认原登记结果');
      if (row.reviewStatus !== 'approved') {
        row.reviewStatus = decision; row.reviewReason = decision === 'rejected' ? reason!.trim() : null;
        row.reviewedBy = user.id; row.reviewedAt = new Date(); row.updatedBy = user.id;
        await repo.save(row);
      }
      return row;
    });
    if (decision === 'rejected') return { reviewStatus: decision, operation: null, cloudOperation: null };
    const registration = await this.parkingOperationRepo.findOne({ where: { id: proof.registrationId!, tenantId } });
    const p = registration!.payload;
    const garages = (p.garages as string[]).filter((key) => key !== 'civil');
    // 既有助手一次 update_garages 会同时对一期/二期读回；稳定键使重复审核不会重复建任务。
    let operation = await this.createParkingOperation({
      kind: 'update_garages', database: registration!.database as 'parking1' | 'parking2',
      idempotencyKey: `family-review-${id}-local`, payload: { ...p, ownerRoom: p.ownerAddress, garages, familyReviewId: id, state: 1 },
    }, user);
    if (operation.status === 'failed') {
      operation = await this.parkingOperationRepo.manager.transaction(async (manager) => {
        const repo = manager.getRepository(ParkingOperation);
        const locked = await repo.findOne({ where: { id: operation.id, tenantId }, lock: { mode: 'pessimistic_write' } });
        if (!locked || Number(locked.payload.familyReviewId) !== id) throw new BadRequestException('亲情车授权原任务不匹配');
        if (locked.status === 'failed') {
          locked.status = 'pending'; locked.attempt = 0; locked.completedAt = null; locked.lastError = null;
          locked.leaseAgentKey = null; locked.leaseExpiresAt = null; locked.updatedBy = user.id; await repo.save(locked);
        }
        return this.parkingOperationResponse(locked);
      });
    }
    const cloudOperation = (p.garages as string[]).includes('civil') ? await this.setDeliyunCivilDefenseAuthorization({
      plate: proof.plate, authorized: true, beginDate: String(p.startDate), endDate: String(p.endDate),
      ownerRoom: String(p.ownerAddress || ''), parkingSpace: String((p.garageNumbers as Record<string, unknown> | undefined)?.civil || p.spaces || ''),
      remark: String(p.note || ''),
      idempotencyKey: `family-review-${id}-civil`,
    }, user, true) : null;
    return { reviewStatus: 'approved' as const, operation, cloudOperation };
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

    const canQueryMovements = supportsParkingMovementQueries(agent.version);
    const canQueryFees = supportsParkingFeeReports(agent.version);
    const canQueryFeeDetails = supportsParkingFeeDetails(agent.version);
    const canListIdentity = supportsParkingIdentityList(agent.version);

    const task = await this.parkingQueryRepo.manager.transaction(async (manager) => {
      const repo = manager.getRepository(ParkingQuery);
      const now = new Date();
      const query = await repo.createQueryBuilder('query')
        .where('query.tenant_id = :tenantId', { tenantId: agent.tenantId })
        .andWhere("(query.status = 'pending' OR (query.status = 'running' AND query.lease_expires_at < :now))", { now })
        .andWhere("(query.query_kind = 'vehicle' OR (query.query_kind = 'movement' AND :canQueryMovements = true) OR (query.query_kind = 'fee_report' AND :canQueryFees = true) OR (query.query_kind = 'fee_detail' AND :canQueryFeeDetails = true) OR (query.query_kind = 'identity_list' AND :canListIdentity = true))", { canQueryMovements, canQueryFees, canQueryFeeDetails, canListIdentity })
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
      return { queryId: query.id, term: query.term, queryKind: query.queryKind, startDate: query.rangeStart, endDate: query.rangeEnd, database: query.database };
    });
    return { task };
  }

  async claimParkingOperation(agentKey: string, token: string) {
    const agent = await this.authenticateAgent(agentKey, token);
    if (agent.kind !== 'parking_gateway') throw new ForbiddenException('当前代理不是停车系统网关');
    if (!supportsParkingOwnerUpdates(agent.version) || agent.capabilities?.parkingDbWrite !== true) return { task: null };
    const canSyncVehicleInfo = supportsParkingVehicleSync(agent.version);
    const canUseAuthorizationFixes = supportsParkingAuthorizationFixes(agent.version);
    const canConfirmParkingDevice = supportsParkingDeviceConfirmation(agent.version);
    const task = await this.parkingOperationRepo.manager.transaction(async (manager) => {
      const repo = manager.getRepository(ParkingOperation);
      const now = new Date();
      const item = await repo.createQueryBuilder('task')
        .where('task.tenant_id = :tenantId', { tenantId: agent.tenantId })
        .andWhere("(task.status = 'pending' OR (task.status = 'running' AND task.lease_expires_at < :now))", { now })
        .andWhere("(task.kind <> 'rebind_owner' OR :canRebind = true)", { canRebind: supportsParkingOwnerRebind(agent.version) })
        .andWhere(canSyncVehicleInfo ? '1=1' : "task.kind <> 'sync_vehicle_info'")
        .andWhere(canUseAuthorizationFixes ? '1=1' : "task.kind NOT IN ('update_garages', 'update_vehicle_type', 'download_vehicle')")
        .andWhere(canConfirmParkingDevice ? '1=1' : "task.kind <> 'download_vehicle'")
        .andWhere(supportsFamilyActivation(agent.version) ? '1=1' : "NOT (task.payload ? 'familyReviewId')")
        .andWhere(supportsFamilyActivation(agent.version) ? '1=1' : "NOT (task.kind = 'add_vehicle' AND task.payload->>'requiresProofReview' = 'true')")
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
        if (task.kind === 'add_vehicle' && task.payload.requiresProofReview) {
          const values = dto.values ?? {};
          if (values.verified !== true || Number(values.state) !== 0 || String(values.effective || '') !== '0'.repeat(256))
            throw new BadRequestException('亲情车旧库待审核状态或零授权未读回一致，不能标为成功');
        }
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
        if (task.kind === 'update_garages') {
          const requested = parkingGarageKeys(task.payload.garages);
          const values = dto.values ?? {};
          if (values.verified !== true || !Array.isArray(values.databases) || values.databases.length < 2) {
            throw new BadRequestException('助手没有返回一期、二期车库授权读回结果，不能标为成功');
          }
          const readable = new Map(values.databases.map((item: any) => [textValue(item.database), item]));
          for (const database of ['parking1', 'parking2']) {
            const row = readable.get(database);
            if (!row || !garageBitsMatch(textValue(row.effective), requested, database)) {
              throw new BadRequestException(`${database === 'parking1' ? '一期' : '二期'}车库授权读回结果与本次勾选不一致，不能标为成功`);
            }
            if (task.payload.familyReviewId && row.existed !== false && Number(row.state) !== 1)
              throw new BadRequestException('亲情车开通状态未读回验证，不能标为成功');
          }
        }
        if (task.kind === 'update_vehicle_type') {
          const values = dto.values ?? {};
          if (values.verified !== true || textValue(values.identity) !== textValue(task.payload.identity)) {
            throw new BadRequestException('助手没有返回与本次选择一致的车辆授权类型，不能标为成功');
          }
        }
        if (task.kind === 'download_vehicle') {
          const values = dto.values ?? {};
          if (values.verified !== true || textValue(values.deviceVerification) !== 'confirmed') {
            throw new BadRequestException('助手没有确认 P_Download 已覆盖全部现行授权通道，不能标为成功');
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
        query.rows = query.queryKind === 'movement'
          ? sanitizeParkingMovementRows(dto.rows ?? [], query.term)
          : query.queryKind === 'fee_report'
            ? sanitizeParkingFeeRows(dto.rows ?? [], query.rangeStart, query.rangeEnd)
            : query.queryKind === 'fee_detail'
              ? sanitizeParkingFeeDetailRows(dto.rows ?? [], query.term.split(':')[0], query.rangeStart, query.rangeEnd)
            : sanitizeParkingRows(dto.rows ?? [], query.queryKind === 'identity_list' ? 3000 : 100);
        query.lastError = null;
        query.completedAt = now;
        if (query.queryKind === 'vehicle') await this.captureParkingHistory(manager, query, now);
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
      database: query.database,
      status: query.status,
      rows,
      error: query.status === 'failed' ? query.lastError : null,
      requestedAt: query.requestedAt,
      completedAt: query.completedAt,
    };
  }

  private parkingMovementResponse(query: ParkingQuery) {
    const movements = query.status === 'completed'
      ? query.rows.map((row) => ({
        database: row.database,
        plate: String(row.fields.carNo ?? ''),
        cardType: row.fields.cardTypeName == null ? null : String(row.fields.cardTypeName),
        resident: row.fields.personName == null ? null : String(row.fields.personName),
        inTime: row.fields.inTime == null ? null : String(row.fields.inTime),
        outTime: row.fields.outTime == null ? null : String(row.fields.outTime),
        inGate: row.fields.inGate == null ? null : String(row.fields.inGate),
        outGate: row.fields.outGate == null ? null : String(row.fields.outGate),
      }))
        .sort((a, b) => String(b.outTime || b.inTime || '').localeCompare(String(a.outTime || a.inTime || '')))
      : [];
    return {
      id: query.id, plate: query.term, status: query.status, startDate: query.rangeStart,
      endDate: query.rangeEnd, movements,
      error: query.status === 'failed' ? query.lastError : null,
      requestedAt: query.requestedAt, completedAt: query.completedAt,
    };
  }

  private parkingFeeReportResponse(query: ParkingQuery) {
    return {
      id: query.id, status: query.status, startDate: query.rangeStart, endDate: query.rangeEnd,
      rows: query.status === 'completed' ? query.rows : [],
      error: query.status === 'failed' ? query.lastError : null,
      requestedAt: query.requestedAt, completedAt: query.completedAt,
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

  /**
   * 行级授权聚合（GET /cards/recent、/cards/history、/cards/:id 共用）：
   * 已完成 access_database_only/controller_upload 累加系统与楼栋，controller_revoke 扣减楼栋；
   * latestTaskAt 取该卡全部任务中最近 completedAt/requestedAt。
   * 只做内存聚合：调用方必须一次性批量取回这些卡的任务，禁止按卡 N+1。
   */
  private aggregateAuthorizationTasks(tasks: AccessCardAuthorization[]): Map<string, AuthorizationTaskAggregate> {
    const byCard = new Map<string, AuthorizationTaskAggregate>();
    const ordered = [...tasks].sort((left, right) =>
      new Date(left.createdAt ?? left.requestedAt).getTime() - new Date(right.createdAt ?? right.requestedAt).getTime());
    for (const task of ordered) {
      const wgCardNo = task.wgCardNo?.trim();
      if (!wgCardNo) continue;
      const bucket = byCard.get(wgCardNo) ?? {
        appliedSystems: new Set<string>(),
        grantedBuildings: new Set<string>(),
        latestTaskAt: 0,
        grantedAtByBuilding: new Map<string, number>(),
        accessSystemByBuilding: new Map<string, string>(),
      };
      const at = new Date(task.completedAt ?? task.requestedAt).getTime();
      if (Number.isFinite(at)) bucket.latestTaskAt = Math.max(bucket.latestTaskAt, at);
      if (task.status === 'completed') {
        const completedAt = task.completedAt ? new Date(task.completedAt).getTime() : at;
        if (task.operation === 'access_database_only') {
          for (const target of task.targetBuildings ?? []) bucket.appliedSystems.add(target.accessSystem);
        } else if (task.operation === 'controller_upload') {
          for (const target of task.targetBuildings ?? []) {
            bucket.appliedSystems.add(target.accessSystem);
            const buildingNo = normalizeBuildingNo(target.buildingNo);
            bucket.grantedBuildings.add(buildingNo);
            bucket.accessSystemByBuilding.set(buildingNo, target.accessSystem);
            bucket.grantedAtByBuilding.set(buildingNo, Math.max(bucket.grantedAtByBuilding.get(buildingNo) ?? 0, completedAt));
          }
        } else if (task.operation === 'controller_revoke') {
          for (const target of task.targetBuildings ?? []) {
            bucket.grantedBuildings.delete(normalizeBuildingNo(target.buildingNo));
          }
        }
      }
      byCard.set(wgCardNo, bucket);
    }
    return byCard;
  }

  /** 一次 find 批量取这些卡的任务并聚合；供 recent/history 行级 additive 字段使用。 */
  private async batchCardTaskAggregates(
    tenantId: number,
    wgCardNos: Array<string | null | undefined>,
  ): Promise<Map<string, AuthorizationTaskAggregate>> {
    const unique = Array.from(new Set(wgCardNos
      .map((value) => value?.trim())
      .filter((value): value is string => Boolean(value))));
    if (!unique.length) return new Map();
    const tasks = await this.authorizationRepo.find({ where: { tenantId, wgCardNo: In(unique) } });
    return this.aggregateAuthorizationTasks(tasks);
  }

  private historyAuthorizationResponse(task: AccessCardAuthorization | null) {
    if (!task) return null;
    const acknowledgements = (task.controllerResults ?? [])
      .map((row) => {
        const acknowledgement = typeof row.acknowledgement === 'string' ? row.acknowledgement.trim() : '';
        const error = typeof row.error === 'string' ? row.error.trim() : '';
        const text = acknowledgement || error;
        if (!text) return null;
        const building = typeof row.buildingNo === 'string' ? row.buildingNo
          : row.buildingId != null ? String(row.buildingId) : '';
        return building ? `${building}: ${text}` : text;
      })
      .filter((value): value is string => Boolean(value));
    return {
      id: task.id,
      houseId: task.houseId,
      historyRowId: task.historyRowId,
      roomKey: task.roomKey,
      cardSequence: task.cardSequence,
      operation: task.operation,
      icCardNo: task.icCardNo,
      wgCardNo: task.wgCardNo,
      targetBuildings: task.targetBuildings,
      controllerResults: task.controllerResults,
      status: task.status,
      attempt: task.attempt,
      error: task.status === 'failed' ? task.lastError : null,
      requestedAt: task.requestedAt,
      completedAt: task.completedAt,
      finishedAt: task.completedAt,
      durationSeconds: task.durationSeconds,
      acknowledgements,
    };
  }

  private isDoorOperation(operation: AccessCardAuthorization['operation']): boolean {
    return ['controller_detect', 'remote_open', 'temporary_open', 'restore_normal'].includes(operation);
  }

  private doorTaskStatus(status: AccessCardAuthorization['status']): 'pending' | 'sent' | 'succeeded' | 'failed' {
    if (status === 'pending') return 'pending';
    if (status === 'running') return 'sent';
    if (status === 'completed') return 'succeeded';
    return 'failed';
  }

  private logicalDoorNo(buildingNo: string): number | null {
    const match = /(\d{1,3})/.exec(buildingNo?.trim() ?? '');
    return match ? Number(match[1]) : null;
  }

  /**
   * 门禁任务对外统一回执。pending=已入队；sent=网关已领取/发送中；
   * succeeded=控制器回执确认；failed=明确失败（不是重试中）。
   */
  private doorTaskResponse(task: {
    id: number;
    operation: AccessCardAuthorization['operation'];
    status: AccessCardAuthorization['status'];
    targetBuildings: AccessCardAuthorization['targetBuildings'];
    durationSeconds: number | null;
    controllerResults: Array<Record<string, unknown>>;
    lastError?: string | null;
    error?: string | null;
    requestedAt: Date;
    completedAt: Date | null;
    attempt: number;
  }, building?: Building) {
    const target = task.targetBuildings?.[0];
    const receipt = task.controllerResults?.[task.controllerResults.length - 1]
      ?? task.controllerResults?.[0] ?? null;
    return {
      taskId: task.id,
      operation: task.operation,
      status: this.doorTaskStatus(task.status),
      rawStatus: task.status,
      communityId: building?.communityId ?? null,
      controllerId: target?.id ?? building?.id ?? null,
      doorNo: this.logicalDoorNo(target?.buildingNo ?? building?.buildingNo ?? ''),
      buildingNo: target?.buildingNo ?? building?.buildingNo ?? null,
      accessSystem: target?.accessSystem ?? null,
      minutes: task.durationSeconds ? Math.round(task.durationSeconds / 60) : null,
      controller: typeof receipt?.controller === 'string' ? receipt.controller : null,
      door: typeof receipt?.door === 'string' ? receipt.door : null,
      protocol: typeof receipt?.protocol === 'string' ? receipt.protocol : null,
      acknowledgement: typeof receipt?.acknowledgement === 'string' ? receipt.acknowledgement : null,
      receipt,
      controllerResults: task.controllerResults ?? [],
      error: task.lastError ?? task.error ?? null,
      attempt: task.attempt,
      requestedAt: task.requestedAt,
      completedAt: task.completedAt,
    };
  }

  /** 审计：复用 business_logs，transactionId 存门禁任务 ID；报告完成时回写结果。 */
  private async writeDoorAudit(
    tenantId: number,
    taskId: number,
    building: Building,
    dto: OpenAccessDoorDto,
    durationSeconds: number | null,
    userId: number,
  ): Promise<void> {
    const repo = this.authorizationRepo.manager.getRepository(BusinessLog);
    await repo.save(repo.create({
      tenantId,
      transactionId: taskId,
      action: `access_door_${dto.operation}`,
      detail: {
        taskId,
        communityId: building.communityId,
        controllerId: building.id,
        buildingNo: building.buildingNo,
        doorNo: this.logicalDoorNo(building.buildingNo),
        operation: dto.operation,
        minutes: durationSeconds ? Math.round(durationSeconds / 60) : null,
        reason: dto.reason?.trim() || null,
        requestedBy: userId,
        requestedAt: new Date().toISOString(),
        status: 'pending',
        result: null,
      },
      createdBy: userId,
      updatedBy: userId,
    }));
  }

  private async writeDoorCheckAudit(
    tenantId: number,
    communityId: number,
    dto: CheckDoorOnlineDto,
    taskIds: number[],
    queued: number,
    reused: number,
    skipped: Array<{ controllerId: number; buildingNo: string; reason: string }>,
    userId: number,
  ): Promise<void> {
    const repo = this.authorizationRepo.manager.getRepository(BusinessLog);
    await repo.save(repo.create({
      tenantId,
      transactionId: taskIds[0] ?? null,
      action: 'access_door_check_online',
      detail: {
        communityId,
        controllerIds: dto.controllerIds ?? null,
        taskIds,
        queued,
        reused,
        skipped,
        triggeredBy: userId,
        triggeredAt: new Date().toISOString(),
        status: 'pending',
      },
      createdBy: userId,
      updatedBy: userId,
    }));
  }

  private async updateDoorAudit(manager: EntityManager, task: AccessCardAuthorization): Promise<void> {
    if (!this.isDoorOperation(task.operation)) return;
    const repo = manager.getRepository(BusinessLog);
    const entry = await repo.findOne({
      where: { tenantId: task.tenantId, transactionId: task.id, action: `access_door_${task.operation}` },
    });
    if (!entry) return;
    const receipt = task.controllerResults?.[task.controllerResults.length - 1] ?? null;
    entry.detail = {
      ...entry.detail,
      status: task.status,
      result: task.status === 'completed' ? 'succeeded' : task.status === 'failed' ? 'failed' : 'sent',
      attempt: task.attempt,
      controllerResults: task.controllerResults,
      controller: typeof receipt?.controller === 'string' ? receipt.controller : null,
      door: typeof receipt?.door === 'string' ? receipt.door : null,
      acknowledgement: typeof receipt?.acknowledgement === 'string' ? receipt.acknowledgement : null,
      error: task.lastError ?? null,
      updatedAt: new Date().toISOString(),
    };
    entry.updatedBy = task.createdBy ?? null;
    await repo.save(entry);
  }

  private authorizationResultSucceeded(operation: AccessCardAuthorization['operation'], row: Record<string, unknown>) {
    const expected = operation === 'access_database_only' ? 'access_db_written'
      : operation === 'controller_revoke' ? 'controller_removed'
        : operation === 'controller_detect' ? 'controller_detected'
          : operation === 'remote_open' ? 'door_opened'
            : operation === 'temporary_open' ? 'door_held_open'
              : operation === 'restore_normal' ? 'door_restored'
                : 'controller_uploaded';
    return row.status === expected;
  }

  private mergeAuthorizationResults(
    operation: AccessCardAuthorization['operation'],
    previous: Array<Record<string, unknown>>,
    current: Array<Record<string, unknown>>,
  ) {
    const merged = new Map<string, Record<string, unknown>>();
    for (const row of previous) {
      const key = normalizeBuildingNo(typeof row.buildingNo === 'string' ? row.buildingNo : '');
      if (key && this.authorizationResultSucceeded(operation, row)) merged.set(key, row);
    }
    for (const row of current) {
      const key = normalizeBuildingNo(typeof row.buildingNo === 'string' ? row.buildingNo : '');
      if (key && !merged.has(key)) merged.set(key, row);
    }
    return [...merged.values()];
  }

  private async enqueueHistoryAuthorization(input: {
    tenantId: number;
    houseId: number;
    historyId: number;
    roomKey: string;
    cardSequence: number | null;
    operation: AccessCardAuthorization['operation'];
    icCardNo: string | null;
    wgCardNo: string;
    targetBuildings: AccessCardAuthorization['targetBuildings'];
    durationSeconds?: number | null;
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
      cardSequence: input.cardSequence,
      operation: input.operation,
      icCardNo: input.icCardNo,
      wgCardNo: input.wgCardNo,
      targetBuildings: input.targetBuildings,
      durationSeconds: input.durationSeconds ?? null,
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
      && agent.capabilities?.historicalAccessGrant === true
      && supportsAccessCardOperationMode(agent.version));
    if (!gateway) {
      throw new ServiceUnavailableException('楼栋门禁网关需要 PMS 数据同步助手 2.5.30 或更新版本，请在 .88 电脑更新后重试');
    }
  }

  private async requirePermissionRevokeGateway(tenantId: number): Promise<void> {
    const agents = await this.agentRepo.find({ where: { tenantId, kind: 'access_gateway', enabled: true } });
    const gateway = orderAgentsByAvailability(agents).find((agent) =>
      effectiveAgentStatus(agent) === 'online'
      && agent.capabilities?.accessDbWrite === true
      && agent.capabilities?.controllerUpload === true
      && agent.capabilities?.historicalAccessGrant === true
      && supportsAccessCardPermissionRevoke(agent.version));
    if (!gateway) {
      throw new ServiceUnavailableException('撤销门栋权限需要 .88 电脑升级 PMS 数据同步助手 2.5.44 或更新版本');
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
        (agent.capabilities?.accessDbWrite !== true || agent.capabilities?.controllerUpload !== true ||
          !supportsAccessCardDisplayName(agent.version))) {
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
          .andWhere('item.legacy_house_sequence IS NOT NULL')
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
      const cardCheck = await manager.getRepository(AccessCardLegacyCardCheck).findOne({ where: { itemId: item.id } });
      item.leaseAgentKey = agent.agentKey;
      item.leaseExpiresAt = leaseExpiresAt;
      item.attempts += 1;
      await repo.save(item);
      const batch = item.batch;
      const targetBuildings = batch.targetBuildingIds.length
        ? await this.buildingRepo.find({ where: { id: In(batch.targetBuildingIds), tenantId: agent.tenantId } })
        : [];
      const uploadedBuildings = new Set((item.controllerResults ?? [])
        .filter((row) => row.status === 'controller_uploaded')
        .map((row) => normalizeBuildingNo(typeof row.buildingNo === 'string' ? row.buildingNo : '')));
      const pendingBuildingIds = batch.targetBuildingIds.filter((buildingId) => {
        const building = targetBuildings.find((candidate) => candidate.id === buildingId);
        return !building || !uploadedBuildings.has(normalizeBuildingNo(building.buildingNo));
      });
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
          displayName: accessCardUserDisplayName(batch.addressSnapshot, item.legacyHouseSequence),
          roomKey: batch.legacyRoomKey,
          batchSequence: item.sequence,
          projectPhase: batch.projectPhase,
          accessSystem: batch.accessSystem,
          icCardNo: item.icCardNo,
          wgCardNo: item.wgCardNo,
          legacyIcNo: cardCheck?.allocatedIcNo ?? null,
          targetBuildingIds: pendingBuildingIds,
          targetBuildings: pendingBuildingIds.map((buildingId) => {
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
        allocatedIcNo: null,
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
      check.allocatedIcNo = null;
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
    if (!check.allocatedIcNo) return { status: 'pending', message: '正在由 .80 分配唯一 ICNO' };
    return { status: 'clear', message: '卡号未在 PMS 或捷顺系统登记，可以继续写卡', allocatedIcNo: check.allocatedIcNo };
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
      const reservedLegacyIcNos = (await repo.createQueryBuilder('reserved')
        .select('reserved.allocated_ic_no', 'allocatedIcNo')
        .where('reserved.tenant_id = :tenantId', { tenantId: agent.tenantId })
        .andWhere('reserved.allocated_ic_no IS NOT NULL')
        .getRawMany<{ allocatedIcNo: number | string }>())
        .map((row) => Number(row.allocatedIcNo))
        .filter((value) => Number.isInteger(value) && value > 0);
      return {
        task: {
          checkId: check.id,
          icCardNo: check.icCardNo,
          reservedLegacyIcNos,
          leaseExpiresAt: leaseExpiresAt.toISOString(),
        },
      };
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
      check.allocatedIcNo = check.matches.length ? null : (dto.allocatedIcNo ?? null);
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
        personName: row.personName?.trim() || null,
        cardInfoId: row.cardInfoId ?? null,
        personCreatedAt: row.personCreatedAt || null,
        lastSwipeAt: row.lastSwipeAt || null,
        lastDevice: row.lastDevice?.trim() || null,
      }));
      snapshot.issuedCount = dto.issuedCount ?? history.length;
      snapshot.nextSequence = dto.nextSequence ?? Math.max(0, ...history.map((row) => row.sequence)) + 1;
      snapshot.status = 'ready';
      snapshot.refreshedAt = new Date();
      snapshot.lastError = null;
      if (snapshot.roomKey === '__recent_js_cards__') {
        snapshot.permissionSubjects = this.permissionSubjects([], snapshot.history);
        snapshot.permissions = [];
        snapshot.permissionStatus = snapshot.permissionSubjects.length ? 'pending' : 'ready';
        snapshot.permissionRequestedAt = new Date();
        snapshot.permissionRefreshedAt = snapshot.permissionSubjects.length ? null : new Date();
        snapshot.permissionLeaseAgentKey = null;
        snapshot.permissionLeaseExpiresAt = null;
        snapshot.permissionLastError = null;
      }
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
    if (agent.capabilities?.historicalAccessGrant !== true || !supportsAccessCardOperationMode(agent.version)) return { task: null };
    const task = await this.authorizationRepo.manager.transaction(async (manager) => {
      const repo = manager.getRepository(AccessCardAuthorization);
      const now = new Date();
      const query = repo.createQueryBuilder('task')
        .where('task.tenant_id = :tenantId', { tenantId: agent.tenantId })
        .andWhere("(task.status = 'pending' OR (task.status = 'running' AND task.lease_expires_at < :now))", { now })
        .andWhere('task.requested_at <= :now', { now })
        .orderBy('task.created_at', 'ASC');
      if (agent.capabilities?.remoteDoorControl !== true || !supportsRemoteDoorControl(agent.version)) {
        query.andWhere('task.operation NOT IN (:...doorOperations)', {
          doorOperations: ['controller_detect', 'remote_open', 'temporary_open', 'restore_normal'],
        });
      }
      // 2.5.43 及更早版本的 iCCard 撤销帧协议不正确，已排队任务也不能被旧助手领取。
      if (!supportsAccessCardPermissionRevoke(agent.version)) {
        query.andWhere('task.operation <> :revokeOperation', { revokeOperation: 'controller_revoke' });
      }
      const item = await query
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
      const completedBuildings = new Set(item.controllerResults
        .filter((row) => this.authorizationResultSucceeded(item.operation, row))
        .map((row) => normalizeBuildingNo(typeof row.buildingNo === 'string' ? row.buildingNo : '')));
      const pendingBuildings = item.targetBuildings.filter((building) =>
        !completedBuildings.has(normalizeBuildingNo(building.buildingNo)));
      return {
        taskId: item.id,
        action: 'authorize_existing_card',
        operation: item.operation,
        address: item.roomKey,
        displayName: accessCardUserDisplayName(item.roomKey, item.cardSequence),
        roomKey: item.roomKey,
        projectPhase: 'phase2',
        icCardNo: item.icCardNo,
        wgCardNo: item.wgCardNo,
        durationSeconds: item.durationSeconds,
        targetBuildingIds: pendingBuildings.map((building) => building.id),
        targetBuildings: pendingBuildings,
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
      task.controllerResults = this.mergeAuthorizationResults(
        task.operation, task.controllerResults, dto.controllerResults ?? []);
      const succeededNos = new Set(task.controllerResults
        .filter((row) => this.authorizationResultSucceeded(task.operation, row))
        .map((row) => normalizeBuildingNo(typeof row.buildingNo === 'string' ? row.buildingNo : '')));
      const allSucceeded = task.targetBuildings.every((building) =>
        succeededNos.has(normalizeBuildingNo(building.buildingNo)));

      const isDoorOperation = ['controller_detect', 'remote_open', 'temporary_open', 'restore_normal'].includes(task.operation);
      if (succeededNos.size && !isDoorOperation) {
        const snapshotRepo = manager.getRepository(AccessCardLegacySnapshot);
        const snapshots = await snapshotRepo.find({
          where: { tenantId: task.tenantId, roomKey: In([task.roomKey, '__recent_js_cards__']) },
        });
        for (const snapshot of snapshots) {
          if (snapshot.roomKey === '__recent_js_cards__'
            && !snapshot.permissionSubjects.some((row) => row.wgCardNo === task.wgCardNo)) continue;
          if (task.operation === 'controller_revoke') {
            snapshot.permissions = snapshot.permissions.filter((row) =>
              row.wgCardNo !== task.wgCardNo || !succeededNos.has(normalizeBuildingNo(row.buildingNo || '')));
          } else {
            const kept = snapshot.permissions.filter((row) =>
              row.wgCardNo !== task.wgCardNo || !succeededNos.has(normalizeBuildingNo(row.buildingNo || '')));
            const additions: AccessCardPermissionEntry[] = task.controllerResults
              .filter((row) => this.authorizationResultSucceeded(task.operation, row))
              .map((row) => ({
                wgCardNo: task.wgCardNo,
                accessSystem: row.accessSystem === 'iccard' ? 'iccard' as const : 'mjsystem' as const,
                buildingNo: typeof row.buildingNo === 'string' ? row.buildingNo : null,
                controller: typeof row.controller === 'string' ? row.controller : null,
                door: typeof row.door === 'string' ? row.door : '楼栋门禁',
                sourceTable: row.accessSystem === 'iccard' ? 't_d_Privilege' as const : 'MJ_MacPower' as const,
              }));
            snapshot.permissions = [...kept, ...additions];
          }
          snapshot.permissionStatus = 'ready';
          snapshot.permissionRefreshedAt = now;
          snapshot.permissionLastError = null;
          snapshot.updatedBy = null;
          await snapshotRepo.save(snapshot);
        }
      }

      if (allSucceeded) {
        task.status = 'completed';
        task.lastError = null;
        task.completedAt = now;
        if (task.operation === 'temporary_open' && task.durationSeconds) {
          const restoreAt = new Date(now.getTime() + task.durationSeconds * 1000);
          const restoreKey = `door-restore-${task.id}`;
          const existingRestore = await repo.findOne({ where: { tenantId: task.tenantId, idempotencyKey: restoreKey } });
          if (!existingRestore) {
            await repo.save(repo.create({
              tenantId: task.tenantId, houseId: task.houseId, historyRowId: 0,
              roomKey: task.roomKey, cardSequence: null, operation: 'restore_normal',
              icCardNo: null, wgCardNo: '__door_operation__', targetBuildings: task.targetBuildings,
              durationSeconds: null, controllerResults: [], idempotencyKey: restoreKey,
              status: 'pending', attempt: 0, requestedAt: restoreAt, completedAt: null,
              leaseAgentKey: null, leaseExpiresAt: null, lastError: null,
              createdBy: task.createdBy, updatedBy: task.createdBy,
            }));
          }
        }
      } else if (dto.result === 'retry' && task.attempt < 3) {
        task.status = 'pending';
        task.lastError = dto.errorMessage?.trim() || '部分楼栋操作失败，正在只重试失败楼栋';
      } else {
        task.status = 'failed';
        task.lastError = dto.errorMessage?.trim() || '历史卡片门栋权限操作失败';
        task.completedAt = now;
      }
      task.leaseAgentKey = null;
      task.leaseExpiresAt = null;
      task.updatedBy = null;
      await repo.save(task);
      if (isDoorOperation) await this.updateDoorAudit(manager, task);
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
      snapshot.permissionStatus = dto.result === 'retry' && snapshot.roomKey !== '__recent_js_cards__' ? 'pending' : 'error';
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
      item.lastErrorMessage = '门禁数据库已写入，等待控制器下发';
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
        item.controllerResults = this.mergeAuthorizationResults(
          'controller_upload', item.controllerResults ?? [], dto.controllerResults ?? []);
        const allSucceeded = item.batch.targetBuildingIds.every((buildingId) =>
          item.controllerResults.some((row) => Number(row.buildingId) === buildingId && row.status === 'controller_uploaded'));
        if (!allSucceeded) throw new BadRequestException('控制器结果缺少部分目标楼栋，不能标记全部完成');
        item.accessStatus = 'controller_uploaded';
        item.accessCompletedAt = new Date();
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
      if (agent.kind === 'access_gateway' && dto.controllerResults?.length) {
        item.controllerResults = this.mergeAuthorizationResults(
          'controller_upload', item.controllerResults ?? [], dto.controllerResults);
      }
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
        roomLabel: null,
      }))
      .reverse();
  }

  /**
   * 入队一次最近 30 笔刷新。
   * - 已在 pending（含已分配租约）不重复重置，避免把正在回传的任务顶掉或刷新 requestedAt；
   * - 刷新期间保留上一次 history（状态置 pending），助手成功回传时整体替换。
   */
  private async requestRecentLegacySnapshot(tenantId: number, userId: number) {
    const snapshot = await this.legacySnapshotRepo.findOne({ where: { tenantId, roomKey: RECENT_LEGACY_ROOM_KEY } });
    if (!snapshot) {
      return this.legacySnapshotRepo.save(this.legacySnapshotRepo.create({
        tenantId, roomKey: RECENT_LEGACY_ROOM_KEY, status: 'pending',
        history: [], issuedCount: 0, nextSequence: 1, requestedAt: new Date(), refreshedAt: null,
        leaseAgentKey: null, leaseExpiresAt: null, lastError: null, permissionStatus: 'idle',
        permissionSubjects: [], permissions: [], permissionRequestedAt: null, permissionRefreshedAt: null,
        permissionLeaseAgentKey: null, permissionLeaseExpiresAt: null, permissionLastError: null,
        createdBy: userId, updatedBy: userId,
      }));
    }
    if (snapshot.status === 'pending') return snapshot;
    snapshot.status = 'pending';
    snapshot.requestedAt = new Date();
    snapshot.leaseAgentKey = null;
    snapshot.leaseExpiresAt = null;
    snapshot.lastError = null;
    snapshot.updatedBy = userId;
    return this.legacySnapshotRepo.save(snapshot);
  }

  /** 快照是否需要入队刷新：无快照/ready 过期/error 超过重试节流。 */
  private recentSnapshotNeedsRefresh(
    snapshot: AccessCardLegacySnapshot,
    errorRetryMs = RECENT_LEGACY_ERROR_RETRY_MS,
  ) {
    if (snapshot.status === 'pending') return false;
    if (snapshot.status === 'error') {
      const failedAt = snapshot.requestedAt?.getTime() ?? 0;
      return !failedAt || Date.now() - failedAt > errorRetryMs;
    }
    const refreshedAt = snapshot.refreshedAt?.getTime() ?? 0;
    return !refreshedAt || Date.now() - refreshedAt > RECENT_LEGACY_STALE_MS;
  }

  /** 轮询端点：只在无快照或超过 60s 时入队刷新，ready 快照绝不无条件重置。 */
  private async ensureRecentLegacySnapshot(tenantId: number, userId: number) {
    const snapshot = await this.legacySnapshotRepo.findOne({ where: { tenantId, roomKey: RECENT_LEGACY_ROOM_KEY } });
    if (!snapshot || this.recentSnapshotNeedsRefresh(snapshot, RECENT_LEGACY_STALE_MS)) {
      return this.requestRecentLegacySnapshot(tenantId, userId);
    }
    return snapshot;
  }

  /**
   * 有界等待 .80 助手回传最近 30 笔。
   * poll 间隔与总超时做成可覆盖的 private helper，测试里覆盖 sleepLegacyRecentPoll
   * 或直接覆盖本方法，避免真实等待 8 秒拖慢测试。
   */
  private async waitLegacyRecent(
    snapshot: AccessCardLegacySnapshot,
    tenantId: number,
    timeoutMs = RECENT_LEGACY_WAIT_TIMEOUT_MS,
  ) {
    if (snapshot.status !== 'pending') return snapshot;
    const deadline = Date.now() + timeoutMs;
    let current = snapshot;
    while (current.status === 'pending' && Date.now() < deadline) {
      await this.sleepLegacyRecentPoll();
      if (current.status !== 'pending') break;
      const next = await this.legacySnapshotRepo.findOne({ where: { id: current.id, tenantId } });
      if (!next) break;
      current = next;
    }
    return current;
  }

  private async sleepLegacyRecentPoll() {
    await new Promise((resolve) => setTimeout(resolve, RECENT_LEGACY_POLL_MS));
  }

  /** 房号地址 → PMS 楼栋/房产（支持 228/50/202、已隐藏前缀、省略弄号）。 */
  private async resolveLegacyRoomByInput(
    tenantId: number,
    communityId: number,
    input: string,
    access?: ResolvedAccess,
  ): Promise<{
    community: Community;
    building: Building;
    house: House;
    roomKey: string;
    legacyStorageRoomKey: string;
  }> {
    const community = await this.communityRepo.findOne({ where: { id: communityId, tenantId } });
    if (!community) throw new NotFoundException('小区不存在');
    const scope = scopeCommunityIds(access);
    if (scope && !scope.includes(community.id)) throw new ForbiddenException('该小区不在你的管理范围内');
    const trimmed = (input ?? '').trim();
    if (!trimmed) throw new BadRequestException('请输入房号，如 228/50/202');
    const parsed = parseLegacyCardRoomInput(trimmed);
    const buildings = await this.buildingRepo.find({ where: { tenantId, communityId: community.id } });
    let building: Building | undefined;
    let house: House | undefined;
    if (parsed) {
      building = buildings.find((item) =>
        (parsed.lane == null || normalizeLegacyNumber(item.lane) === normalizeLegacyNumber(parsed.lane))
        && normalizeLegacyNumber(item.buildingNo) === normalizeLegacyNumber(parsed.buildingNo));
      if (building) {
        house = await this.houseRepo.findOne({ where: { tenantId, buildingId: building.id, roomNo: parsed.roomNo } }) ?? undefined;
        if (!house) {
          const houses = await this.houseRepo.find({ where: { tenantId, buildingId: building.id } });
          house = houses.find((item) => normalizeLegacyNumber(item.roomNo) === normalizeLegacyNumber(parsed.roomNo));
        }
      }
    }
    if (!building || !house) {
      const hit = await resolveAddressForTenant(this.houseRepo.manager.connection, tenantId, trimmed).catch(() => null);
      const candidateIds = hit?.allHouseIds ?? [];
      if (candidateIds.length) {
        const houses = await this.houseRepo.find({ where: { tenantId, id: In(candidateIds) } });
        for (const candidate of houses) {
          const candidateBuilding = buildings.find((item) => item.id === candidate.buildingId);
          if (candidateBuilding) { building = candidateBuilding; house = candidate; break; }
        }
      }
    }
    if (!building || !house) throw new NotFoundException('PMS 中没有找到这个房号');
    return {
      community,
      building,
      house,
      roomKey: legacyRoomKey(building.lane, building.buildingNo, house.roomNo),
      legacyStorageRoomKey: legacyDatabaseRoomKey(building.lane, building.buildingNo, house.roomNo),
    };
  }

  /** 捷顺卡记录的房号 → PMS 楼栋/房产；写入类接口要求 phase2。 */
  private async resolveLegacyCardRoom(
    tenantId: number,
    row: { personName?: string | null },
    access?: ResolvedAccess,
    requireWritable = false,
  ): Promise<{
    community: Community;
    building: Building;
    house: House;
    roomKey: string;
    legacyStorageRoomKey: string;
  } | null> {
    const parsed = parseLegacyAccessCardRoomName(row.personName)
      ?? parseLegacyCardRoomInput((row.personName ?? '').replace(/^\s*已隐藏\s*/, ''));
    if (!parsed) return null;
    const buildings = await this.buildingRepo.find({ where: { tenantId } });
    const matches = buildings.filter((item) =>
      (parsed.lane == null || normalizeLegacyNumber(item.lane) === normalizeLegacyNumber(parsed.lane))
      && normalizeLegacyNumber(item.buildingNo) === normalizeLegacyNumber(parsed.buildingNo));
    if (matches.length !== 1) return null;
    const building = matches[0];
    const community = await this.communityRepo.findOne({ where: { id: building.communityId, tenantId } });
    if (!community) return null;
    const scope = scopeCommunityIds(access);
    if (scope && !scope.includes(community.id)) throw new ForbiddenException('这张卡不在你的管理范围内');
    if (requireWritable && projectPhaseOf(community.name) !== 'phase2') {
      throw new BadRequestException('一期门禁卡不需要写入 .88 楼栋门禁系统');
    }
    const houses = await this.houseRepo.find({ where: { tenantId, buildingId: building.id } });
    const house = houses.find((item) => normalizeLegacyNumber(item.roomNo) === normalizeLegacyNumber(parsed.roomNo));
    if (!house) return null;
    return {
      community,
      building,
      house,
      roomKey: legacyRoomKey(building.lane, building.buildingNo, house.roomNo),
      legacyStorageRoomKey: legacyDatabaseRoomKey(building.lane, building.buildingNo, house.roomNo),
    };
  }

  private async waitLegacyHistory(snapshot: AccessCardLegacySnapshot, tenantId: number) {
    let current = snapshot;
    for (let attempt = 0; attempt < 10 && current.status === 'pending'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      const next = await this.legacySnapshotRepo.findOne({ where: { id: current.id, tenantId } });
      if (!next) break;
      current = next;
    }
    return current;
  }

  private async findLegacyCardById(tenantId: number, id: number) {
    const snapshots = await this.legacySnapshotRepo.find({
      where: { tenantId },
      order: { refreshedAt: 'DESC' },
      take: 200,
    });
    for (const snapshot of snapshots) {
      const row = snapshot.history.find((entry) =>
        (typeof entry.cardInfoId === 'number' ? entry.cardInfoId : null) === id
        || (entry.cardInfoId == null && entry.personId === id));
      if (row) return { row, snapshot };
    }
    return null;
  }

  private async writeLegacyCardAudit(
    tenantId: number,
    cardId: number,
    action: string,
    detail: Record<string, unknown>,
    userId: number,
  ): Promise<void> {
    const repo = this.authorizationRepo.manager.getRepository(BusinessLog);
    await repo.save(repo.create({
      tenantId,
      transactionId: null,
      action,
      detail: {
        cardId,
        ...detail,
        triggeredBy: userId,
        triggeredAt: new Date().toISOString(),
      },
      createdBy: userId,
      updatedBy: userId,
    }));
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
      roomLabel?: string | null;
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
            roomLabel: row.personName,
            issuedAt: row.issuedAt || existing.issuedAt,
            legacySyncStatus: 'synced',
          });
        }
        return withVerifiedPermissions({
          id: -row.personId,
          sequence: row.sequence,
          legacyPersonNo: row.personNo,
          roomLabel: row.personName,
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
      && item.legacySyncStatus === 'synced'
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

function parkingGarageKeys(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : String(textValue(value) || '').split(',');
  return Array.from(new Set(raw.map((item) => textValue(item)).filter((item): item is string => !!item && ['phase1', 'phase2', 'main'].includes(item))));
}

function garageBitsMatch(effective: string | null, garages: string[], database: string): boolean {
  if (!effective || !/^[01]{16,}$/.test(effective)) return false;
  const selected = new Set(garages);
  const hasAny = (channels: number[]) => channels.some((channel) => effective[channel - 1] === '1');
  if (database === 'parking1') return hasAny([5, 7]) === selected.has('phase1');
  return hasAny([9, 11, 13]) === selected.has('phase2') && hasAny([15, 17, 19, 21]) === selected.has('main');
}

function validateParkingOperation(
  kind: string,
  payload: Record<string, unknown>,
  expected: Record<string, unknown>,
  targetRecordId?: string,
) {
  const requireValue = (key: string, label: string) => { if (!textValue(payload[key])) throw new BadRequestException(`${label}不能为空`); };
  if (kind === 'add_vehicle') { requireValue('plate', '车牌'); requireValue('ownerName', '住户姓名'); requireValue('endDate', '到期日期'); validateRegistrationGarageNumbers(payload); }
  if (kind === 'renew_vehicle') { requireValue('plate', '车牌'); requireValue('endDate', '到期日期'); }
  if (kind === 'change_plate') { requireValue('plate', '原车牌'); requireValue('newPlate', '新车牌'); requireValue('ownerName', '住户姓名'); }
  if (kind === 'rebind_owner') { requireValue('plate', '车牌'); requireValue('ownerRoom', '新绑定房号'); requireValue('previousOwnerId', '当前旧库住户编号，请重新查询车辆'); }
  if (kind === 'update_garages') {
    requireValue('plate', '车牌'); requireValue('ownerRoom', '房号');
    const garages = Array.isArray(payload.garages) ? payload.garages.map((item) => textValue(item)).filter(Boolean) : String(textValue(payload.garages) || '').split(',').map((item) => textValue(item)).filter(Boolean);
    if (!garages.length && !payload.familyReviewId) throw new BadRequestException('请至少选择一个车库授权状态');
    const invalid = garages.find((item) => !['phase1', 'phase2', 'main'].includes(item!));
    if (invalid) throw new BadRequestException(`不支持的车库授权：${invalid}；二期人防车库以德立云系统为准`);
    payload.garages = garages;
    delete payload.effective;
  }
  if (kind === 'update_vehicle_type') { requireValue('plate', '车牌'); requireValue('ownerRoom', '房号'); requireValue('identity', '车辆授权类型'); }
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
    if (!['room', 'note'].every((key) => Object.prototype.hasOwnProperty.call(expected, key))) {
      throw new BadRequestException('目标资料快照不完整，请重新查询后再同步');
    }
  }
}

function operationHistoryType(kind: ParkingOperation['kind']): ParkingHistoryEventType {
  if (kind === 'change_plate') return 'plate_change';
  if (kind === 'rebind_owner') return 'owner_rebind';
  if (kind === 'renew_vehicle') return 'vehicle_renewed';
  if (kind === 'update_garages') return 'garage_authorization';
  if (kind === 'update_vehicle_type') return 'vehicle_type_update';
  if (kind === 'delete_vehicle') return 'vehicle_deleted';
  if (kind === 'download_vehicle') return 'vehicle_download';
  if (kind === 'sync_vehicle_info') return 'vehicle_sync';
  return 'vehicle_added';
}

function operationSummary(task: ParkingOperation): string {
  const plate = textValue(task.payload.newPlate || task.payload.plate) || '未识别车牌';
  const labels: Record<string, string> = { add_vehicle: '新增车牌', renew_vehicle: '续期车牌', change_plate: '变更车牌', rebind_owner: '变更绑定用户', update_garages: '调整车库授权', update_vehicle_type: '修改车辆授权类型', download_vehicle: '下发停车设备', sync_vehicle_info: '同步一期二期停车资料', delete_vehicle: '注销车牌' };
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
      ['note', '备注', result.beforeNote, result.afterNote],
    ].filter(([, , before, after]) => textValue(before) !== null || textValue(after) !== null)
      .filter(([, , before, after]) => String(before ?? '') !== String(after ?? ''))
      .map(([field, label, before, after]) => ({ field: String(field), label: String(label), before: textValue(before), after: textValue(after) }));
  }
  if (task.kind === 'update_vehicle_type') {
    return [{ field: 'identity', label: '车辆授权类型',
      before: textValue(task.result?.previousIdentity), after: textValue(task.result?.identity || task.payload.identity) }];
  }
  const pairs: Array<[string, string, unknown, unknown]> = [
    ['plate', '车牌', p.plate, p.newPlate || p.plate],
    ['owner', '绑定用户', p.previousOwnerName || p.previousOwnerId, p.ownerName || p.ownerId],
    ['endDate', '到期日期', p.previousEndDate, p.endDate],
    ['effective', '车库授权', p.previousGarages, p.garages || p.effective],
  ];
  return pairs.filter(([, , before, after]) => textValue(before) !== null || textValue(after) !== null)
    .filter(([, , before, after]) => String(before ?? '') !== String(after ?? ''))
    .map(([field, label, before, after]) => ({ field, label, before: textValue(before), after: textValue(after) }));
}

export function sanitizeParkingRows(rows: ParkingQueryReportDto['rows'], limit = 100): ParkingQuery['rows'] {
  return (rows ?? []).slice(0, limit).map((row) => {
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

export function sanitizeParkingMovementRows(rows: ParkingQueryReportDto['rows'], requestedPlate: string): ParkingQuery['rows'] {
  if ((rows ?? []).length > 100) throw new BadRequestException('进出记录返回超过 100 条，请缩小日期范围');
  return (rows ?? []).map((row) => {
    const database = row.database?.trim().toLowerCase();
    const fields = row.fields ?? {};
    const carNo = String(fields.carNo ?? '').replace(/[\s·]/g, '').toUpperCase();
    const time = (value: unknown) => value == null || value === '' ? null : String(value);
    const inTime = time(fields.inTime);
    const outTime = time(fields.outTime);
    if ((database !== 'parking1' && database !== 'parking2') || carNo !== requestedPlate ||
        ![inTime, outTime].some((value) => value && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) ||
        [inTime, outTime].some((value) => value && !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value))) {
      throw new BadRequestException('停车网关返回的进出记录与所查车牌或时间格式不一致');
    }
    return {
      database,
      fields: {
        carNo,
        cardTypeName: fields.cardTypeName == null ? null : String(fields.cardTypeName).slice(0, 80),
        personName: fields.personName == null ? null : String(fields.personName).slice(0, 100),
        inTime,
        outTime,
        inGate: fields.inGate == null ? null : String(fields.inGate).slice(0, 100),
        outGate: fields.outGate == null ? null : String(fields.outGate).slice(0, 100),
      },
    };
  });
}

export function sanitizeParkingFeeRows(rows: ParkingQueryReportDto['rows'], startDate: string | null, endDate: string | null): ParkingQuery['rows'] {
  // 31 天 × 两期 × 两类的每日行，再加跨期每日行与 4 个汇总，最多 190 行。
  if ((rows ?? []).length > 200) throw new BadRequestException('金额报表汇总返回超过日期范围上限');
  const sanitized = (rows ?? []).map((row) => {
    const f = row.fields ?? {};
    const database = row.database?.trim().toLowerCase();
    const kind = String(f.kind ?? '');
    const category = String(f.category ?? '');
    const count = Number(f.count);
    const amountCents = Number(f.amountCents);
    if (!['parking1', 'parking2', 'both'].includes(database) ||
        !['summary', 'daily'].includes(kind) ||
        !['renewal', 'temporary'].includes(category) ||
        !Number.isSafeInteger(count) || count < 0 ||
        !Number.isSafeInteger(amountCents) || Math.abs(amountCents) > 100_000_000_000_000 ||
        (kind === 'daily' && (!/^\d{4}-\d{2}-\d{2}$/.test(String(f.day ?? '')) ||
          String(f.day) < String(startDate) || String(f.day) > String(endDate))) ||
        (kind === 'detail' && (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(f.occurredAt ?? '')) ||
          String(f.occurredAt).slice(0, 10) < String(startDate) || String(f.occurredAt).slice(0, 10) > String(endDate)))) {
      throw new BadRequestException('停车网关返回的金额报表字段不正确');
    }
    return { database, fields: {
      kind, category, count, amountCents,
      day: kind === 'daily' ? String(f.day) : null,
      occurredAt: kind === 'detail' ? String(f.occurredAt) : null,
      plate: kind === 'detail' ? String(f.plate ?? '').slice(0, 24) : null,
      operator: kind === 'detail' ? String(f.operator ?? '').slice(0, 80) : null,
    } };
  });
  for (const category of ['renewal', 'temporary']) for (const database of ['parking1', 'parking2']) {
    if (sanitized.filter((row) => row.database === database && row.fields.kind === 'summary' && row.fields.category === category).length !== 1)
      throw new BadRequestException('停车网关返回的金额报表缺少一期或二期汇总');
  }
  for (const category of ['renewal', 'temporary']) {
    const summary = sanitized.filter((row) => row.fields.kind === 'summary' && row.fields.category === category);
    const daily = sanitized.filter((row) => row.fields.kind === 'daily' && row.fields.category === category && row.database === 'both');
    if (summary.reduce((sum, row) => sum + Number(row.fields.amountCents), 0) !==
          daily.reduce((sum, row) => sum + Number(row.fields.amountCents), 0) ||
        summary.reduce((sum, row) => sum + Number(row.fields.count), 0) !==
          daily.reduce((sum, row) => sum + Number(row.fields.count), 0)) {
      throw new BadRequestException('金额报表每日汇总与一期、二期总额不一致');
    }
    for (const database of ['parking1', 'parking2']) {
      const source = summary.find((row) => row.database === database);
      const sourceDays = sanitized.filter((row) => row.fields.kind === 'daily' && row.fields.category === category && row.database === database);
      if (!source || Number(source.fields.amountCents) !== sourceDays.reduce((sum, row) => sum + Number(row.fields.amountCents), 0) ||
          Number(source.fields.count) !== sourceDays.reduce((sum, row) => sum + Number(row.fields.count), 0))
        throw new BadRequestException(`${database} 金额逐日汇总与分期总额不一致`);
    }
  }
  return sanitized;
}

export function sanitizeParkingFeeDetailRows(rows: ParkingQueryReportDto['rows'], category: string,
  startDate: string | null, endDate: string | null): ParkingQuery['rows'] {
  if ((rows ?? []).length > 50) throw new BadRequestException('金额明细单页超过 50 条');
  return (rows ?? []).map((row) => {
    const fields = row.fields ?? {};
    const database = row.database?.trim().toLowerCase();
    const occurredAt = String(fields.occurredAt ?? '');
    const amountCents = Number(fields.amountCents);
    if (!['parking1', 'parking2'].includes(database) || fields.kind !== 'detail' ||
        fields.category !== category || !Number.isSafeInteger(amountCents) ||
        Math.abs(amountCents) > 100_000_000_000_000 ||
        !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(occurredAt) ||
        occurredAt.slice(0, 10) < String(startDate) || occurredAt.slice(0, 10) > String(endDate))
      throw new BadRequestException('停车网关返回的金额明细字段不正确');
    return { database, fields: {
      kind: 'detail', category, count: 1, amountCents, day: null, occurredAt,
      plate: String(fields.plate ?? '').slice(0, 24), operator: String(fields.operator ?? '').slice(0, 80),
    } };
  });
}

const parkingVehicleOutputAliases = [
  'p_id', 'pid', 'issue_id', 'issueid', 'car_id', 'carid', 'owner_id', 'ownerid',
  'p_plate', 'pplate', 'carno', 'carcode', 'carnumber', 'plateno', 'plate', 'license', '车牌',
  'p_effective', 'peffective', 'p_download', 'pdownload', 'p_note', 'pnote', 'remark', 'remarks', 'note', '备注',
  'carbrand', 'carbeand', 'vehicleidentity', 'caridentity', 'ownertype', 'usertype', 'relationtype', 'carlei', '车辆类型', '车辆身份', '性质',
  'enddate', 'expiredate', 'expirydate', 'validto', 'deadline', 'overdate', 'endtime', '到期', '有效期',
  'parkno', 'parkingno', 'spaceno', 'berth', 'garage', '车位', '地库',
  'sarttime', 'dstratime', 'starttime', 'startdate', 'begintime', 'begindate', 'updatetime', 'updatedate',
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
