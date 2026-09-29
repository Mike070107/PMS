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
import { In, Repository } from 'typeorm';
import { AuthUser } from '../../common/current-user.decorator';
import {
  AccessCardAgent,
  AccessCardIssueBatch,
  AccessCardIssueItem,
  AccessCardLegacySnapshot,
  Building,
  Community,
  House,
  ParkingQuery,
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
  normalizeBuildingNo,
  projectPhaseOf,
} from './access-card-routing';
import { CreateAccessCardIssueDto } from './dto';
import {
  AgentHeartbeatDto,
  AgentReportDto,
  CreateParkingQueryDto,
  EnrollAccessCardAgentDto,
  LegacyHistoryReportDto,
  ParkingQueryReportDto,
} from './dto';
import { agentTokenMatches, issueAgentSecret } from './agent-auth';
import { effectiveAgentStatus, orderAgentsByAvailability } from './agent-status';
import { DeliyunParkingService } from './deliyun-parking.service';

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
    @InjectRepository(AccessCardAgent)
    private readonly agentRepo: Repository<AccessCardAgent>,
    @InjectRepository(AccessCardLegacySnapshot)
    private readonly legacySnapshotRepo: Repository<AccessCardLegacySnapshot>,
    @InjectRepository(House)
    private readonly houseRepo: Repository<House>,
    @InjectRepository(Building)
    private readonly buildingRepo: Repository<Building>,
    @InjectRepository(Community)
    private readonly communityRepo: Repository<Community>,
    @InjectRepository(ParkingQuery)
    private readonly parkingQueryRepo: Repository<ParkingQuery>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly config: ConfigService,
    private readonly deliyun: DeliyunParkingService,
  ) {}

  async getHouseContext(houseId: number, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    const context = await this.resolveHouse(houseId, tenantId, access);
    const [buildings, pmsHistory, legacySnapshot] = await Promise.all([
      this.buildingRepo.find({
        where: { tenantId, communityId: context.community.id },
      }),
      this.historyForHouse(houseId, tenantId),
      this.requestLegacyHistory(tenantId, context.legacyStorageRoomKey, user.id),
    ]);
    const legacyReady = legacySnapshot.refreshedAt !== null;
    const history = this.mergeHistory(pmsHistory, legacyReady ? legacySnapshot.history : [], context.phase);

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
        message: legacyReady
          ? `已合并 192.168.1.80 历史记录，旧库下一序号 #${legacySnapshot.nextSequence}`
          : legacySnapshot.lastError || '暂未取得 192.168.1.80 的历史记录，如需重新查询，请点击“刷新历史”',
      },
    };
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
    return {
      simulationEnabled,
      features: {
        cardWrite: false,
        legacyDbWrite: false,
        accessDbWrite: false,
        parkingDbRead: true,
        parkingDbWrite,
        controllerUpload: false,
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
    const term = dto.term.trim().replace(/\s+/g, ' ');
    if (term.length < 2) throw new BadRequestException('请输入至少 2 个字符，可输入房号、住户或车牌');

    const agents = await this.agentRepo.find({ where: { tenantId, kind: 'parking_gateway', enabled: true } });
    const gateway = orderAgentsByAvailability(agents).find((agent) =>
      effectiveAgentStatus(agent) === 'online' &&
      agent.capabilities?.parkingDbRead === true &&
      supportsParkingQueries(agent.version));
    if (!gateway) {
      throw new ServiceUnavailableException('停车网关尚未连接，或 Windows 数据同步助手需要升级到 0.4.0');
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

  async claimParkingQuery(agentKey: string, token: string) {
    const agent = await this.authenticateAgent(agentKey, token);
    if (agent.kind !== 'parking_gateway') throw new ForbiddenException('当前代理不是停车系统网关');
    if (!supportsParkingQueries(agent.version)) return { task: null };

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

  async reportParkingQuery(agentKey: string, token: string, dto: ParkingQueryReportDto) {
    const agent = await this.authenticateAgent(agentKey, token);
    if (agent.kind !== 'parking_gateway') throw new ForbiddenException('当前代理不是停车系统网关');
    const query = await this.parkingQueryRepo.findOne({ where: { id: dto.queryId, tenantId: agent.tenantId } });
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
    await this.parkingQueryRepo.save(query);
    return { ok: true };
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

  private async matchParkingRowsToPms(tenantId: number, rows: ParkingQuery['rows']) {
    const phones = Array.from(new Set(rows
      .map((row) => parkingFieldValue(row.fields, ['phone', 'mobile', 'telephone', 'tel', '手机', '电话']))
      .map((value) => normalizeParkingPhone(value))
      .filter((value): value is string => Boolean(value))));
    const users = phones.length
      ? await this.userRepo.find({ where: { tenantId, phone: In(phones) } })
      : [];
    const byPhone = new Map(users
      .filter((user) => user.phone)
      .map((user) => [normalizeParkingPhone(user.phone), user] as const));
    const houseIds = Array.from(new Set(users.map((user) => user.houseId).filter((id): id is number => id !== null)));
    const houses = houseIds.length ? await this.houseRepo.find({ where: { tenantId, id: In(houseIds) } }) : [];
    const buildingIds = Array.from(new Set(houses.map((house) => house.buildingId)));
    const buildings = buildingIds.length ? await this.buildingRepo.find({ where: { tenantId, id: In(buildingIds) } }) : [];
    const communityIds = Array.from(new Set(buildings.map((building) => building.communityId)));
    const communities = communityIds.length ? await this.communityRepo.find({ where: { tenantId, id: In(communityIds) } }) : [];
    const houseById = new Map(houses.map((house) => [house.id, house]));
    const buildingById = new Map(buildings.map((building) => [building.id, building]));
    const communityById = new Map(communities.map((community) => [community.id, community]));
    return rows.map((row) => {
      const rawPhone = parkingFieldValue(row.fields, ['phone', 'mobile', 'telephone', 'tel', '手机', '电话']);
      const user = rawPhone ? byPhone.get(normalizeParkingPhone(rawPhone) ?? '') : undefined;
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
          house: house && building ? {
            id: house.id,
            roomNo: house.roomNo,
            areaSqm: house.areaSqm,
            lane: building.lane,
            buildingNo: building.buildingNo,
            communityId: community?.id ?? null,
            communityName: community?.name ?? null,
          } : null,
          matchedBy: 'phone' as const,
          };
        })() : null,
      };
    });
  }

  async enrollAgent(dto: EnrollAccessCardAgentDto, user: AuthUser) {
    const tenantId = this.requireTenant(user);
    const issued = issueAgentSecret();
    const agentKey = `${dto.kind}-${randomBytes(8).toString('hex')}`;
    const agent = await this.agentRepo.save(this.agentRepo.create({
      tenantId,
      agentKey,
      kind: dto.kind,
      name: dto.name.trim(),
      version: 'pending',
      tokenHash: issued.tokenHash,
      enabled: true,
      status: 'offline',
      capabilities: {},
      lastSeenAt: null,
      createdBy: user.id,
      updatedBy: user.id,
    }));
    return {
      id: agent.agentKey,
      kind: agent.kind,
      name: agent.name,
      token: issued.token,
      message: '代理密钥只显示这一次，请立即保存到对应电脑的 DPAPI 配置中',
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

    if (dto.result === 'success') {
      if (agent.kind === 'issuer') {
        const icCardNo = (dto.icCardNo || '').replace(/\s+/g, '').toUpperCase();
        if (!/^[0-9A-F]{6,}$/.test(icCardNo)) throw new BadRequestException('发卡助手未返回有效 IC 卡号');
        const duplicate = await this.itemRepo
          .createQueryBuilder('item')
          .where('item.tenant_id = :tenantId', { tenantId: agent.tenantId })
          .andWhere('item.ic_card_no = :icCardNo', { icCardNo })
          .andWhere('item.id <> :itemId', { itemId: item.id })
          .getExists();
        if (duplicate) throw new BadRequestException('该 IC 卡已经登记，不能重复发卡');
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
  ) {
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
          return {
            ...existing,
            sequence: row.sequence,
            legacyPersonNo: row.personNo,
            issuedAt: row.issuedAt || existing.issuedAt,
            legacySyncStatus: 'synced',
          };
        }
        return {
          id: -row.personId,
          sequence: row.sequence,
          legacyPersonNo: row.personNo,
          icCardNo: row.icCardNo,
          wgCardNo: phase === 'phase2' && row.icCardNo ? icToWg(row.icCardNo) : null,
          issuedAt: row.issuedAt,
          accessStatus: phase === 'phase1' ? 'not_required' : 'controller_uploaded',
          legacySyncStatus: 'synced',
          controllerResults: [],
        };
      });
    merged.push(...Array.from(byIc.values()));
    return merged.sort((a, b) => b.sequence - a.sequence || Number(b.id) - Number(a.id));
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
    if (items.some((item) => item.accessStatus === 'needs_operator')) {
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

function supportsParkingQueries(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version || '');
  if (!match) return false;
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return major > 0 || minor > 4 || (minor === 4 && patch >= 0);
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

function sanitizeParkingRows(rows: ParkingQueryReportDto['rows']): ParkingQuery['rows'] {
  return (rows ?? []).slice(0, 100).map((row) => {
    const fields: Record<string, string | number | boolean | null> = {};
    for (const [rawKey, rawValue] of Object.entries(row.fields ?? {}).slice(0, 60)) {
      const key = rawKey.trim().slice(0, 128);
      if (!key || Object.prototype.hasOwnProperty.call(fields, key)) continue;
      if (rawValue === null || typeof rawValue === 'boolean') fields[key] = rawValue;
      else if (typeof rawValue === 'number' && Number.isFinite(rawValue)) fields[key] = rawValue;
      else if (typeof rawValue === 'string') fields[key] = rawValue.slice(0, 500);
    }
    return { database: row.database.trim().slice(0, 80), fields };
  });
}
