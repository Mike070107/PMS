import { BadRequestException, ConflictException, ForbiddenException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { AuthUser } from '../../common/current-user.decorator';
import { ParkingQuery, TenantConfig } from '../../entities';
import { LocalIntegration, LocalIntegrationTask } from '../../entities/local-integration.entity';
import { normalizeParkingSourceRecordId } from '../access-card-issuance/parking-history.util';
import { parseParkingSearch } from '../access-card-issuance/parking-query.util';
import { captureParkingQueryHistory, parkingOperationTime } from '../access-card-issuance/parking-query-history';
import { sameJson } from './protocol';

type Route = { integrationKey: string; resourceId: string };
type Routes = Partial<Record<'parking1' | 'parking2', Route | null>>;
const KEY = 'standard_parking_query_routes';
const plain = (v: any): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
@Injectable()
export class StandardParkingQueryService {
  constructor(@InjectRepository(LocalIntegrationTask) private readonly tasks: Repository<LocalIntegrationTask>) {}
  private tenant(user: AuthUser) { if (!user.tenantId) throw new ForbiddenException('请选择企业'); return user.tenantId; }
  private validateRoutes(value: unknown): asserts value is Routes {
    if (!plain(value) || Object.keys(value).some(k => !['parking1', 'parking2'].includes(k))) throw new BadRequestException('停车查询路由格式不正确');
    const bindings = new Set<string>();
    for (const route of Object.values(value)) {
      if (route === null) continue;
      if (!plain(route) || Object.keys(route).sort().join(',') !== 'integrationKey,resourceId' ||
          !['integrationKey', 'resourceId'].every(k => typeof route[k] === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$/.test(route[k]))) {
        throw new BadRequestException('停车查询路由必须绑定连接和逻辑资源');
      }
      const binding = `${route.integrationKey}\0${route.resourceId}`;
      if (bindings.has(binding)) throw new BadRequestException('一期、二期必须使用各自独立的逻辑停车资源');
      bindings.add(binding);
    }
  }
  private async routes(manager: EntityManager, tenantId: number): Promise<Routes> {
    const config = await manager.getRepository(TenantConfig).findOneBy({ tenantId, key: KEY });
    const value = config?.value ?? {}; this.validateRoutes(value); return value;
  }
  async getRoutes(user: AuthUser) { return this.routes(this.tasks.manager, this.tenant(user)); }
  async readiness(tenantId: number) {
    const routes = Object.values(await this.routes(this.tasks.manager, tenantId)).filter((route): route is Route => !!route);
    if (!routes.length) return null;
    let ready = false;
    for (const route of routes) {
      try { await this.assertReady(this.tasks.manager, tenantId, route); ready = true; }
      catch (error) { if (!(error instanceof ServiceUnavailableException)) throw error; }
    }
    return ready
      ? { ready: true, reason: 'ready', message: '标准停车查询仅支持明确数据库与完整车牌；其他操作仍检查原网关能力' }
      : { ready: false, reason: 'standard_unavailable', message: '已绑定的标准停车查询资源均离线、禁用或未就绪；不会自动切换旧网关' };
  }
  private async assertReady(manager: EntityManager, tenantId: number, route: Route) {
    const integration = await manager.getRepository(LocalIntegration).findOneBy({ tenantId, key: route.integrationKey });
    const capable = (resources: LocalIntegration['resources']) => resources.some(r => r.id === route.resourceId && r.capabilities.some(c => c.operation === 'parking.query' && c.revision === 1));
    if (!integration?.enabled || !integration.lastSeenAt || Date.now() - new Date(integration.lastSeenAt).getTime() >= 15_000 || !capable(integration.resources) || !capable(integration.ready)) {
      throw new ServiceUnavailableException('已绑定的标准停车查询资源离线、禁用或未就绪；不会自动切换旧网关');
    }
  }
  async setRoutes(value: unknown, user: AuthUser) {
    this.validateRoutes(value); const tenantId = this.tenant(user);
    return this.tasks.manager.transaction(async manager => {
      for (const route of Object.values(value)) if (route) await this.assertReady(manager, tenantId, route);
      await manager.getRepository(TenantConfig).upsert({ tenantId, key: KEY, value: value as Record<string, any>, createdBy: user.id, updatedBy: user.id }, ['tenantId', 'key']);
      return this.routes(manager, tenantId);
    });
  }
  async tryCreateVehicleQuery(term: string, database: 'parking1' | 'parking2' | undefined, user: AuthUser): Promise<ParkingQuery | null> {
    const tenantId = this.tenant(user);
    return this.tasks.manager.transaction(async manager => {
      const routes = await this.routes(manager, tenantId);
      if (!database && Object.values(routes).some(Boolean)) throw new BadRequestException('标准停车查询请明确选择一期或二期数据库');
      const route = database ? routes[database] : null;
      if (!route) return null; // No standard binding: retain the original legacy business path.
      // Revision 1 cannot distinguish phone/tail/fuzzy searches; never silently broaden one.
      if (parseParkingSearch(term).kind !== 'plate') throw new BadRequestException('当前标准停车查询仅支持完整车牌；不支持尾号、电话、姓名或房号查询');
      await this.assertReady(manager, tenantId, route);
      const query = await manager.getRepository(ParkingQuery).save({ tenantId, term, queryKind: 'vehicle', database,
        rangeStart: null, rangeEnd: null, status: 'running', rows: [], attempt: 0, requestedAt: new Date(), completedAt: null,
        // A standard-owned running query has no legacy lease. It is never eligible for legacy claim/reclaim.
        leaseAgentKey: null, leaseExpiresAt: null, lastError: null, createdBy: user.id, updatedBy: user.id });
      await manager.getRepository(LocalIntegrationTask).save({ tenantId, integrationKey: route.integrationKey, resourceId: route.resourceId,
        operation: 'parking.query', revision: 1, idempotencyKey: `parking-query:${query.id}`, command: { query: { field: 'plate', value: term } },
        status: 'pending', parkingQueryId: query.id, issuanceItemId: null, allocationId: null, leaseToken: null, leaseExpiresAt: null,
        result: null, completedAt: null, createdBy: user.id, updatedBy: user.id });
      return query;
    });
  }
  async acceptResult(manager: EntityManager, task: LocalIntegrationTask) {
    if (task.parkingQueryId == null) return;
    const repo = manager.getRepository(ParkingQuery);
    const query = await repo.findOne({ where: { id: task.parkingQueryId, tenantId: task.tenantId }, lock: { mode: 'pessimistic_write' } });
    if (!query || task.operation !== 'parking.query' || task.revision !== 1 || task.issuanceItemId != null || task.allocationId != null ||
        task.idempotencyKey !== `parking-query:${query.id}` || query.queryKind !== 'vehicle' || !['parking1', 'parking2'].includes(query.database ?? '') ||
        !sameJson(task.command, { query: { field: 'plate', value: query.term } }) ||
        !(query.status === 'running' || (query.status === 'failed' && query.lastError?.startsWith('STD_QUERY_UNKNOWN:')))) {
      throw new ConflictException('标准停车回执与原业务查询绑定或状态不一致');
    }
    const now = new Date();
    if (task.status === 'succeeded') {
      const records = task.result?.records;
      if (!Array.isArray(records)) throw new BadRequestException('标准停车成功回执必须包含完整结果列表（无记录时为空数组）');
      const ids = new Set<string>();
      query.rows = records.map(record => {
        if (!plain(record) || typeof record.externalId !== 'string' || normalizeParkingSourceRecordId(record.externalId) !== record.externalId || record.externalId.length > 100 ||
            record.plate !== query.term || ids.has(record.externalId) ||
            !['ownerId', 'name', 'phone', 'room', 'note', 'plateChangedAt'].every(k => Object.hasOwn(record, k) && (record[k] === null || typeof record[k] === 'string')) ||
            (record.plateChangedAt !== null && !parkingOperationTime(record.plateChangedAt))) {
          throw new BadRequestException('标准停车结果必须绑定精确车牌、唯一记录号和完整住户快照，缺字段不能当作空值');
        }
        ids.add(record.externalId);
        return { database: query.database!, fields: { p_id: record.externalId, p_plate: record.plate, owner_id: record.ownerId,
          Owner__name: record.name, Owner__phone: record.phone, Owner__room: record.room, p_note: record.note, pms_meta__platechangedat: record.plateChangedAt } };
      });
      query.status = 'completed'; query.lastError = null;
      await captureParkingQueryHistory(manager, query, now, fields => ({
        plate: fields.p_plate as string, ownerId: fields.owner_id as string | null,
        ownerName: fields.Owner__name as string | null, phone: fields.Owner__phone as string | null,
        room: fields.Owner__room as string | null, note: fields.p_note as string | null,
        plateChangedAt: fields.pms_meta__platechangedat as string | null,
      }));
    } else if (task.status === 'failed' || task.status === 'unknown') {
      query.status = 'failed';
      query.lastError = task.status === 'unknown' ? 'STD_QUERY_UNKNOWN: 标准查询结果未知，请查原任务；不会自动改走旧网关' : 'STD_QUERY_FAILED: 标准停车查询失败';
    } else throw new ConflictException('标准停车任务尚无可保存的结果');
    query.completedAt = now; query.updatedBy = null;
    await repo.save(query);
  }
}
