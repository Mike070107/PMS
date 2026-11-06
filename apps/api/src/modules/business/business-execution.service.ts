import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { In, LessThan, Repository } from 'typeorm';
import { BusinessLog, BusinessRule, BusinessTransaction, ParkingOperation, VehicleIntake } from '../../entities';
import { findParkingTarget } from './parking-targets';
import { assertFreshParkingPlateCheck } from '../access-card-issuance/parking-query.util';
import { BusinessServiceType } from '../../common/enums';
import { AuthUser } from '../../common/current-user.decorator';
import { DeliyunParkingService, shanghaiDateOnly } from '../access-card-issuance/deliyun-parking.service';
import { AccessCardIssuanceService } from '../access-card-issuance/access-card-issuance.service';
import {
  aggregateSteps,
  ExecutionStep,
  ParkingSystemRef,
  planLocalRenewal,
  splitAmountCents,
  stepKey,
  classifyFailure,
  ExternalSyncStatus,
  nextRetryAt,
  parseSyncMode,
  planDeliyunRenewal,
  RETRYABLE_BY_HAND,
  SyncMode,
} from './business-execution.util';

/** snapshot.execution 的形状 */
export interface ExecutionState {
  connector: 'deliyun';
  mode: SyncMode;
  /** 停车目标 key（来自收费规则 config.parkingTarget） */
  target?: string | null;
  attempts: number;
  nextAt?: string | null;
  lastError?: string | null;
  operationId?: number | null;
  planned?: { vehicleId: string; previousEndDate: string; endDate: string } | null;
  result?: Record<string, unknown> | null;
  finishedAt?: string | null;
  /** 一辆车要在多套停车系统一起续期时，每套一步 */
  steps?: ExecutionStep[];
  registrationQueryId?: number | null;
}

const STALE_RUNNING_MS = 5 * 60_000;

/**
 * 收费后的执行层（P1：停车月租 → 德立云有效期续期）。
 *
 * - 收银确认后排队（queued），立即在后台执行一次，另有每分钟一次的兜底扫描；
 * - 多进程安全：靠 UPDATE ... WHERE external_sync_status IN (queued, retry) 原子领取；
 * - 写入走既有 DeliyunParkingService.renewVehicle（自带幂等：已是目标即成功；写后回读校验）；
 * - 每次真实写入在 parking_operations 留一条 database='deliyun' 记录，与旧页续期同一本账。
 *   注意只写 running/completed/failed 且 lease 为空——现场助手只领 pending 或租约过期的 running，不会误领。
 * - BUSINESS_DELIYUN_SYNC 默认 dry-run：只读查车、记下「将要写什么」，不写入。
 */
@Injectable()
export class BusinessExecutionService {
  private readonly logger = new Logger(BusinessExecutionService.name);
  private sweeping = false;

  constructor(
    @InjectRepository(BusinessTransaction) private readonly txnRepo: Repository<BusinessTransaction>,
    @InjectRepository(BusinessLog) private readonly logRepo: Repository<BusinessLog>,
    @InjectRepository(ParkingOperation) private readonly opRepo: Repository<ParkingOperation>,
    @InjectRepository(BusinessRule) private readonly ruleRepo: Repository<BusinessRule>,
    private readonly deliyun: DeliyunParkingService,
    private readonly config: ConfigService,
    private readonly issuance: AccessCardIssuanceService,
  ) {}

  mode(): SyncMode {
    return parseSyncMode(this.config.get<string>('BUSINESS_DELIYUN_SYNC'));
  }

  /** complete() 落单前调用：决定初始状态与 snapshot.execution */
  initialFor(serviceType: BusinessServiceType): { status: ExternalSyncStatus; execution: ExecutionState | null } {
    if (serviceType !== BusinessServiceType.PARKING_MONTHLY) return { status: 'mocked', execution: null };
    const mode = this.mode();
    if (mode === 'off') return { status: 'mocked', execution: null };
    return { status: 'queued', execution: { connector: 'deliyun', mode, attempts: 0, nextAt: null } };
  }

  /** 落单后立刻在后台跑一次，不阻塞收银返回 */
  kick(id: number) {
    setImmediate(() => { this.runOne(id).catch((e) => this.logger.error(`execution ${id} crashed: ${e?.message || e}`)); });
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async sweep() {
    if (this.sweeping || this.mode() === 'off') return;
    this.sweeping = true;
    try {
      // 进程中途退出留下的 running：超过 5 分钟没动静，放回重试
      await this.txnRepo.update(
        { externalSyncStatus: 'running', serviceType: BusinessServiceType.PARKING_MONTHLY, updatedAt: LessThan(new Date(Date.now() - STALE_RUNNING_MS)) },
        { externalSyncStatus: 'retry' },
      );
      const due = await this.txnRepo.createQueryBuilder('t')
        .select('t.id', 'id')
        .where('t.service_type = :st', { st: BusinessServiceType.PARKING_MONTHLY })
        .andWhere('t.external_sync_status IN (:...ss)', { ss: ['queued', 'retry'] })
        .andWhere("(t.snapshot->'execution'->>'nextAt' IS NULL OR (t.snapshot->'execution'->>'nextAt')::timestamptz <= now())")
        .orderBy('t.id', 'ASC').limit(20).getRawMany<{ id: number }>();
      for (const { id } of due) await this.runOne(Number(id));
    } catch (e) {
      this.logger.error(`sweep failed: ${(e as Error)?.message || e}`);
    } finally {
      this.sweeping = false;
    }
  }

  /** 人工重试（转人工 / 失败 / 演练 → 重新排队） */
  /** 人工已在停车系统办好（自动执行转人工的单）：记下谁、何时、备注，状态改为已生效 */
  async markDone(id: number, note: string | undefined, user: AuthUser, scope: number[] | null) {
    const txn = await this.txnRepo.findOne({ where: { id, tenantId: user.tenantId! } });
    if (!txn) throw new NotFoundException('流水不存在');
    if (scope && (txn.communityId == null || !scope.includes(txn.communityId))) throw new BadRequestException('这笔不在你的管理范围内');
    if (!['manual', 'failed', 'dry_run'].includes(txn.externalSyncStatus)) throw new BadRequestException('只有转人工、失败或演练的单可以标记已办好');
    const text = (note || '').trim().slice(0, 200);
    if (!text) throw new BadRequestException('请写明在哪个系统怎么办好的，供审计');
    const execution = { ...((txn.snapshot?.execution as object) || {}), manualDone: { by: user.id, at: new Date().toISOString(), note: text }, lastError: null, nextAt: null };
    const done = await this.txnRepo.createQueryBuilder().update(BusinessTransaction)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .set({ externalSyncStatus: 'synced', snapshot: { ...(txn.snapshot || {}), execution } as any, updatedBy: user.id })
      .where('id = :id AND external_sync_status IN (:...ss)', { id, ss: ['manual', 'failed', 'dry_run'] }).execute();
    if (!done.affected) throw new BadRequestException('状态已变化，请刷新');
    await this.txnRepo.manager.save(BusinessLog, this.txnRepo.manager.create(BusinessLog, { tenantId: txn.tenantId, transactionId: id, action: 'manual_done', detail: { note: text }, createdBy: user.id, updatedBy: user.id }));
    return { id, externalSyncStatus: 'synced' as const };
  }

  async retry(id: number, user: AuthUser) {
    const txn = await this.txnRepo.findOne({ where: { id, tenantId: user.tenantId! } });
    if (!txn) throw new NotFoundException('流水不存在');
    if (txn.serviceType !== BusinessServiceType.PARKING_MONTHLY) throw new BadRequestException('这笔业务还没有接入自动执行');
    if (!RETRYABLE_BY_HAND.includes(txn.externalSyncStatus as ExternalSyncStatus) && txn.externalSyncStatus !== 'mocked') {
      throw new BadRequestException(`当前状态「${txn.externalSyncStatus}」不能重试`);
    }
    const prev = (txn.snapshot?.execution as ExecutionState | undefined) ?? null;
    // 保留各系统步骤：已完成的不重做，只重跑失败/转人工的那几套
    const steps = prev?.steps?.map((s) => (s.status === 'done' || s.status === 'waiting' ? s : { ...s, status: 'pending' as const }));
    const execution: ExecutionState = { connector: 'deliyun', mode: this.mode(), attempts: 0, nextAt: null, lastError: null, operationId: prev?.operationId ?? null, ...(steps ? { steps } : {}) };
    await this.txnRepo.update({ id }, { externalSyncStatus: 'queued', // eslint-disable-next-line @typescript-eslint/no-explicit-any
      snapshot: { ...(txn.snapshot || {}), execution } as any, updatedBy: user.id });
    await this.log(txn, 'external_sync_retry_requested', { from: txn.externalSyncStatus, by: user.id }, user.id);
    this.kick(id);
    return { id, externalSyncStatus: 'queued' };
  }

  async runOne(id: number) {
    // 原子领取：同一笔只会有一个进程执行
    const claimed = await this.txnRepo.createQueryBuilder().update(BusinessTransaction)
      .set({ externalSyncStatus: 'running' })
      .where('id = :id AND external_sync_status IN (:...ss)', { id, ss: ['queued', 'retry'] })
      .execute();
    if (!claimed.affected) return;

    const txn = await this.txnRepo.findOneOrFail({ where: { id } });
    const prev = (txn.snapshot?.execution as ExecutionState | undefined) ?? { connector: 'deliyun', mode: this.mode(), attempts: 0 };
    const mode = this.mode();
    const attempts = (prev.attempts || 0) + 1;
    const plate = String((txn.snapshot?.vehicle as { plateNo?: string } | undefined)?.plateNo || '').trim().toUpperCase();
    const targetEndDate = (txn.endDate as unknown as string | null) || null;
    let op: ParkingOperation | null = null;

    const parkingSnap = txn.snapshot?.parking as { systems?: ParkingSystemRef[]; newVehicle?: boolean } | undefined;
    const systems = parkingSnap?.systems ?? [];
    if (parkingSnap?.newVehicle) return this.runRegistration(txn, prev, mode, attempts, plate, targetEndDate);
    if (plate && systems.length) return this.runSystems(txn, prev, mode, attempts, plate, targetEndDate, systems);

    try {
      if (!plate) throw new BadRequestException('这笔停车收费没有车牌，无法同步停车系统');
      // 按收费规则绑定的停车目标分发：德立云哪个场 / 本地停车库
      const rule = txn.ruleId ? await this.ruleRepo.findOne({ where: { id: txn.ruleId, tenantId: txn.tenantId } }) : null;
      const target = findParkingTarget(rule?.config?.parkingTarget);
      prev.target = target?.key ?? null;
      if (!target) {
        return await this.finish(txn, 'manual', { ...prev, mode, attempts, nextAt: null,
          lastError: `收费规则「${rule?.name || txn.ruleId}」没有绑定停车场，无法判断续哪套停车系统；请在「收费标准」给规则选好停车场，或人工续期` });
      }
      if (target.system === 'local') {
        return await this.finish(txn, 'manual', { ...prev, mode, attempts, nextAt: null,
          lastError: `「${target.label}」在本地停车库，自动续期正在接入；请暂在旧「停车管理」页给 ${plate} 续期到 ${targetEndDate || '本次到期日'}` });
      }
      const parkName = target.deliyunPark!;
      const found = await this.deliyun.findVehiclesByPlate(plate, parkName);
      const plan = planDeliyunRenewal({
        plate, targetEndDate,
        rows: found.rows.map((r) => ({ id: r.id, plate: r.plate, endDate: r.endDate, cardPoolId: r.cardPoolId })),
      });

      if (plan.action === 'manual') {
        return await this.finish(txn, 'manual', { ...prev, mode, attempts, lastError: `[${target.label}] ${plan.reason}`, nextAt: null });
      }
      if (plan.action === 'noop') {
        return await this.finish(txn, 'synced', { ...prev, mode, attempts, lastError: null, nextAt: null, result: { vehicleId: plan.vehicleId, endDate: plan.endDate, verified: true, note: plan.reason } });
      }
      const planned = { vehicleId: plan.vehicleId, previousEndDate: plan.previousEndDate, endDate: plan.endDate };
      if (mode !== 'on') {
        return await this.finish(txn, 'dry_run', { ...prev, mode, attempts, planned, lastError: null, nextAt: null });
      }

      op = await this.opRepo.save(this.opRepo.create({
        tenantId: txn.tenantId, kind: 'renew_vehicle', database: 'deliyun',
        idempotencyKey: `biz:${txn.txnNo}:${attempts}`, sourceRecordId: plan.vehicleId, pmsUserId: null,
        payload: { plate, previousEndDate: plan.previousEndDate, endDate: plan.endDate, businessTxnNo: txn.txnNo, park: parkName },
        expected: { previousEndDate: plan.previousEndDate }, result: null,
        status: 'running', attempt: 1, requestedAt: new Date(), completedAt: null,
        leaseAgentKey: null, leaseExpiresAt: null, lastError: null, rollbackOfOperationId: null,
        createdBy: txn.createdBy, updatedBy: txn.createdBy,
      }));
      const result = await this.deliyun.renewVehicle({ vehicleId: plan.vehicleId, plate, previousEndDate: plan.previousEndDate, endDate: plan.endDate, parkName });
      op.status = 'completed'; op.result = result as unknown as Record<string, unknown>; op.completedAt = new Date();
      await this.opRepo.save(op);
      return await this.finish(txn, 'synced', { ...prev, mode, attempts, planned, operationId: op.id, lastError: null, nextAt: null, result: result as unknown as Record<string, unknown> });
    } catch (error) {
      const { status, message } = classifyFailure(error, attempts);
      if (op) {
        op.status = 'failed'; op.lastError = message; op.completedAt = new Date();
        await this.opRepo.save(op).catch(() => undefined);
      }
      return await this.finish(txn, status, {
        ...prev, mode, attempts, operationId: op?.id ?? prev.operationId ?? null, lastError: message,
        nextAt: status === 'retry' ? nextRetryAt(attempts).toISOString() : null,
      });
    }
  }

  /**
   * 收银台登记了这辆车在哪几套系统（旧库一期/二期记录、德立云某场）时，逐套续到同一个到期日。
   * - 旧库：经现场助手的 parking_operations 队列（renew_vehicle，助手写后回读）；这里只建任务，下一轮扫描读结果；
   * - 德立云：直接调接口续期并回读；
   * - 已完成的步骤不重做；任何一步对不上转人工，不退款、不影响其他步骤；
   * - 演练模式只核对、写下每套系统「将要怎么续」，不建任务、不写入。
   */
  private async runSystems(txn: BusinessTransaction, prev: ExecutionState, mode: SyncMode, attempts: number,
    plate: string, targetEndDate: string | null, systems: ParkingSystemRef[]) {
    const old = new Map((prev.steps ?? []).map((s) => [s.key, s]));
    const locals = systems.filter((s) => s.kind === 'local');
    const amounts = splitAmountCents(txn.amountCents, locals.length);
    const steps: ExecutionStep[] = [];
    for (const sys of systems) {
      const key = stepKey(sys);
      const was = old.get(key);
      const step: ExecutionStep = { key, label: sys.label, kind: sys.kind, status: 'pending', operationId: was?.operationId ?? null, note: null };
      steps.push(step);
      if (was?.status === 'done') { Object.assign(step, was); continue; }
      try {
        if (sys.kind === 'deliyun') {
          const found = await this.deliyun.findVehiclesByPlate(plate, sys.park);
          const plan = planDeliyunRenewal({ plate, targetEndDate, rows: found.rows.map((r) => ({ id: r.id, plate: r.plate, endDate: r.endDate, cardPoolId: r.cardPoolId })) });
          if (plan.action === 'manual') { step.status = 'manual'; step.note = plan.reason; continue; }
          if (plan.action === 'noop') { step.status = 'done'; step.note = plan.reason; continue; }
          if (mode !== 'on') { step.status = 'dry_run'; step.note = `将把 ${plan.previousEndDate} 续到 ${plan.endDate}`; continue; }
          const result = await this.deliyun.renewVehicle({ vehicleId: plan.vehicleId, plate, previousEndDate: plan.previousEndDate, endDate: plan.endDate, parkName: sys.park });
          const op = await this.opRepo.save(this.opRepo.create({
            tenantId: txn.tenantId, kind: 'renew_vehicle', database: 'deliyun', idempotencyKey: `biz:${txn.txnNo}:${key}:${attempts}`,
            sourceRecordId: plan.vehicleId, pmsUserId: null,
            payload: { plate, previousEndDate: plan.previousEndDate, endDate: plan.endDate, businessTxnNo: txn.txnNo, park: sys.park },
            expected: { previousEndDate: plan.previousEndDate }, result: result as unknown as Record<string, unknown>,
            status: 'completed', attempt: 1, requestedAt: new Date(), completedAt: new Date(),
            leaseAgentKey: null, leaseExpiresAt: null, lastError: null, rollbackOfOperationId: null,
            createdBy: txn.createdBy, updatedBy: txn.createdBy,
          }));
          step.status = 'done'; step.operationId = op.id; step.note = `已续到 ${plan.endDate}（已回读）`;
          continue;
        }
        // 本地旧库：先看上一轮建的任务有没有结果
        if (step.operationId) {
          const op = await this.opRepo.findOne({ where: { id: step.operationId, tenantId: txn.tenantId } });
          if (op?.status === 'completed') { step.status = 'done'; step.note = `已续到 ${targetEndDate}（现场助手已回读）`; continue; }
          if (op && (op.status === 'pending' || op.status === 'running')) { step.status = 'waiting'; step.note = '现场助手处理中'; continue; }
          if (op?.status === 'failed') { step.status = 'failed'; step.note = op.lastError || '现场助手执行失败'; step.operationId = null; continue; }
        }
        const plan = planLocalRenewal({ previousEndDate: sys.previousEndDate, targetEndDate });
        if (plan.action === 'manual') { step.status = 'manual'; step.note = plan.reason ?? null; continue; }
        if (plan.action === 'noop') { step.status = 'done'; step.note = plan.reason ?? null; continue; }
        if (mode !== 'on') { step.status = 'dry_run'; step.note = `将经现场助手把 ${(sys.previousEndDate || '无到期日').slice(0, 10)} 续到 ${targetEndDate}`; continue; }
        const created = await this.issuance.createParkingOperation({
          database: sys.database, kind: 'renew_vehicle', sourceRecordId: sys.sourceRecordId,
          idempotencyKey: `biz:${txn.txnNo}:${key}:${attempts}`,
          payload: { plate, endDate: targetEndDate, previousEndDate: (sys.previousEndDate || '').slice(0, 10), amount: amounts[locals.indexOf(sys)] / 100, businessTxnNo: txn.txnNo },
        } as never, { id: txn.createdBy ?? 0, tenantId: txn.tenantId } as unknown as AuthUser);
        step.operationId = Number((created as { id?: number }).id) || null;
        step.status = 'waiting'; step.note = '已交给现场助手';
      } catch (error) {
        const { status, message } = classifyFailure(error, attempts);
        step.status = status === 'manual' ? 'manual' : 'failed';
        step.note = message;
        if (status === 'retry') step.status = 'pending';
      }
    }
    const status = aggregateSteps(steps);
    const waiting = steps.some((s) => s.status === 'waiting');
    const retrying = steps.some((s) => s.status === 'pending');
    const finalStatus: ExternalSyncStatus = retrying ? (attempts >= 3 ? 'failed' : 'retry') : status;
    const problems = steps.filter((s) => ['manual', 'failed', 'pending'].includes(s.status)).map((s) => `[${s.label}] ${s.note || s.status}`);
    // 等现场助手：放回队列，一分钟后的扫描再来读结果（不算一次失败）
    const nextAt = waiting ? new Date(Date.now() + 30_000).toISOString() : retrying ? nextRetryAt(attempts).toISOString() : null;
    return this.finish(txn, finalStatus, {
      ...prev, mode, attempts: waiting && !retrying ? attempts - 1 : attempts, steps, nextAt,
      lastError: problems.length ? problems.join('；') : null,
    });
  }

  /** 新办付费车：审核凭证 → 双库查重 → 稳定幂等新增 → 回读 → 设备确认。 */
  private async runRegistration(txn: BusinessTransaction, prev: ExecutionState, mode: SyncMode, attempts: number,
    plate: string, endDate: string | null) {
    const user = { id: txn.createdBy!, tenantId: txn.tenantId } as AuthUser;
    const steps: ExecutionStep[] = [];
    const wait = () => this.finish(txn, 'queued', { ...prev, mode, attempts: attempts - 1, steps,
      nextAt: new Date(Date.now() + 5000).toISOString(), lastError: null });
    try {
      const intakeId = Number((txn.snapshot?.intake as { id?: number })?.id);
      const intake = await this.txnRepo.manager.getRepository(VehicleIntake).findOne({ where: { id: intakeId || 0, tenantId: txn.tenantId } });
      if (!intake || intake.kind !== 'paid' || intake.status !== 'approved' || intake.houseId !== txn.houseId ||
          intake.transactionId !== txn.id || intake.plate !== plate) throw new BadRequestException('新车资料未通过审核或与原收款记录不一致，禁止自动开通');
      if (!plate || !endDate || !/^\d{4}-\d{2}-\d{2}$/.test(endDate) || !txn.startDate || !txn.createdBy) throw new BadRequestException('新车登记缺少车牌、有效期或原办理人');
      const roomMatch = intake.houseLabel.match(/(198|228)弄\s*(\d+)号\s*(\d+)/);
      if (!roomMatch) throw new BadRequestException('新车房号无法转换为停车库房号，请先核对房产档案');
      const ownerRoom = roomMatch.slice(1).map(Number).join('/');
      const selected = [...new Set(intake.garages)];
      const defs = selected.map(key => findParkingTarget(key));
      if (!defs.length || defs.some(d => !d)) throw new BadRequestException('新车登记未选择有效车库');
      // 不把其它德立云场套入枫桦人防新增接口；未选择人防不访问德立云。
      if (defs.some(d => d!.system !== 'local' && d!.key !== 'deliyun:枫桦景苑')) throw new BadRequestException('该云停车场没有已验证的新增协议，未执行；不能套用枫桦人防接口');
      const civil = selected.includes('deliyun:枫桦景苑');
      if (civil && (!intake.garageNumbers.civil?.trim() || !selected.some(k => k === 'local:phase2_parking' || k === 'local:phase2_main_garage'))) throw new BadRequestException('人防新办须明确人防车位号并同时选择二期地面入口');
      const databases = [...new Set(defs.filter(d => d!.system === 'local').map(d => d!.database!))];
      const garages = selected.flatMap(k => k === 'local:phase1_parking' ? ['phase1'] : k === 'local:phase2_parking' ? ['phase2'] : k === 'local:phase2_main_garage' ? ['phase2', 'main'] : []);
      if (garages.includes('main') && !intake.garageNumbers.main?.trim()) throw new BadRequestException('大车库新办缺少车位号，未执行');
      const identity = intake.vehicleClass.includes('租') ? '租户车' : intake.vehicleClass.includes('产权') ? '产权车位' : intake.vehicleClass.includes('住户') || intake.vehicleClass.includes('业主') ? '住户车' : '';
      if (!identity) throw new BadRequestException('新办车辆类别无法对应停车库授权类型，请核对');
      const adds: Array<(Pick<ParkingOperation, 'id' | 'status' | 'result'> & { lastError?: string | null }) | null> = await Promise.all(databases.map(database => this.opRepo.findOne({ where: { tenantId: txn.tenantId, idempotencyKey: `biz:${txn.txnNo}:register:${database}` } })));
      if (mode !== 'on') return this.finish(txn, 'dry_run', { ...prev, mode, attempts, nextAt: null, lastError: null,
        result: { action: 'add_vehicle', plate, endDate, systems: defs.map(d => d!.label) } });
      // 幂等任务已存在时直接读取，不要求重新查重（新增后当然会查到自己）。
      let query: Awaited<ReturnType<AccessCardIssuanceService['getParkingQuery']>> | null = null;
      if (adds.some(op => !op)) {
        if (adds.some(Boolean)) throw new BadRequestException('部分车库已创建登记任务，其余未建；为避免跨库重复新增已停止，请核对原任务');
        query = prev.registrationQueryId ? await this.issuance.getParkingQuery(prev.registrationQueryId, user) : await this.issuance.createParkingQuery({ term: plate }, user);
        prev = { ...prev, registrationQueryId: query.id };
        if (query.status === 'pending' || query.status === 'running') { steps.push({ key: 'registration:check', kind: 'local', label: '一期、二期车牌查重', status: 'waiting', operationId: null, note: '等待现场助手查重，尚未新增' }); return wait(); }
        if (query.status !== 'completed') throw new BadRequestException('现场车牌查重失败，未执行新增，请核对后重试');
        assertFreshParkingPlateCheck(query as never, plate);
      }
      for (let index = 0; index < databases.length; index++) {
        const database = databases[index];
        const label = database === 'parking1' ? '一期停车库' : '二期停车库';
        const effective = Array(256).fill('0');
        const channels = database === 'parking1' ? [5, 7] : garages.includes('main') ? [9, 11, 13, 15, 17, 19, 21] : [9, 11, 13];
        channels.forEach(c => effective[c - 1] = '1');
        const bits = effective.join('');
        let add = adds[index];
        if (!add) add = await this.issuance.createParkingOperation({ database, kind: 'add_vehicle',
          idempotencyKey: `biz:${txn.txnNo}:register:${database}`,
          payload: { plate, ownerRoom, ownerName: intake.ownerName || ownerRoom, ownerAddress: ownerRoom,
            ownerPhone: intake.contactPhone || intake.ownerPhone, identity, amount: index === 0 ? txn.amountCents / 100 : 0,
            startDate: txn.startDate, endDate, effective: bits, download: '0'.repeat(256), state: 1,
            garages: [...new Set(garages.filter(g => database === 'parking1' ? g === 'phase1' : g !== 'phase1'))],
            garageNumbers: intake.garageNumbers, spaces: database === 'parking2' ? intake.garageNumbers.main || '' : '',
            duplicateCheckQueryId: query!.id, businessTxnNo: txn.txnNo, note: `操作来源：PMS系统；新办流水 ${txn.txnNo}` },
        }, user);
        const step: ExecutionStep = { key: `registration:${database}`, kind: 'local', label, status: 'waiting', operationId: add.id, note: '等待现场助手新增登记并回读' };
        steps.push(step);
        if (add.status === 'failed') { step.status = 'manual'; step.note = add.lastError || '新增任务失败；保留原任务，禁止重复新增'; continue; }
        if (add.status !== 'completed') continue;
        const result = add.result;
        if (!result || result.verified !== true || result.plate !== plate || result.endDate !== endDate || result.effective !== bits || Number(result.state) !== 1 || !result.issueId) {
          step.status = 'manual'; step.note = '新增后车牌、到期日、有效状态或授权回读不一致，未下发设备'; continue;
        }
        let download: (Pick<ParkingOperation, 'id' | 'status' | 'result'> & { lastError?: string | null }) | null = await this.opRepo.findOne({ where: { tenantId: txn.tenantId, idempotencyKey: `biz:${txn.txnNo}:register-download:${database}` } });
        if (!download) download = await this.issuance.createParkingOperation({ database, kind: 'download_vehicle', sourceRecordId: String(result.issueId),
          idempotencyKey: `biz:${txn.txnNo}:register-download:${database}`, payload: { plate, effective: bits, businessTxnNo: txn.txnNo } }, user);
        step.operationId = download.id; step.note = '旧库已新增并回读，等待停车设备下发确认';
        if (download.status === 'failed') { step.status = 'manual'; step.note = download.lastError || '设备下发失败，旧库登记保留，禁止重复新增'; }
        if (download.status === 'completed') {
          if (download.result?.verified === true && download.result?.deviceVerification === 'confirmed') { step.status = 'done'; step.note = `已新增至 ${endDate}，旧库回读及停车设备下发确认完成`; }
          else { step.status = 'manual'; step.note = '设备任务结束但没有有效设备确认，不能标为已生效'; }
        }
      }
      if (steps.some(s => s.status === 'manual')) return this.finish(txn, 'manual', { ...prev, mode, attempts, steps, nextAt: null, lastError: steps.filter(s => s.status === 'manual').map(s => `[${s.label}] ${s.note}`).join('；') });
      if (civil && steps.every(s => s.status === 'done')) {
        steps.push(await this.runCivilRegistration(txn, plate, ownerRoom, intake.garageNumbers.civil, endDate));
        if (steps.some(s => s.status === 'manual')) return this.finish(txn, 'manual', { ...prev, mode, attempts, steps, nextAt: null, lastError: steps.at(-1)!.note });
      }
      if (steps.every(s => s.status === 'done')) return this.finish(txn, 'synced', { ...prev, mode, attempts, steps, nextAt: null, lastError: null });
      return wait();
    } catch (error) {
      const failure = classifyFailure(error, attempts);
      return this.finish(txn, failure.status, { ...prev, mode, attempts, steps, lastError: failure.message,
        nextAt: failure.status === 'retry' ? nextRetryAt(attempts).toISOString() : null });
    }
  }

  /** 仅枫桦人防：新增前查重，持久记录再调用；未知写结果不自动重放。 */
  private async runCivilRegistration(txn: BusinessTransaction, plate: string, ownerRoom: string, parkingSpace: string, endDate: string): Promise<ExecutionStep> {
    const step: ExecutionStep = { key: 'registration:deliyun:枫桦景苑', kind: 'deliyun', label: '二期人防车库', status: 'manual', operationId: null, note: null };
    const idempotencyKey = `biz:${txn.txnNo}:register:deliyun:枫桦景苑`;
    const existing = await this.opRepo.findOne({ where: { tenantId: txn.tenantId, idempotencyKey } });
    if (existing) {
      step.operationId = existing.id;
      if (existing.status === 'completed' && existing.result?.verified === true && existing.result?.plate === plate && existing.result?.ownerRoom === ownerRoom && existing.result?.parkingSpace === parkingSpace && existing.result?.endDate === endDate) { step.status = 'done'; step.note = '人防新增已回读核对，不重复新增'; }
      else step.note = '人防已有原新增任务，执行结果未确认；保留任务，禁止自动重放，请核对后处理';
      return step;
    }
    let op: ParkingOperation | null = null;
    try {
      const found = await this.deliyun.findVehiclesByPlate(plate, '枫桦景苑');
      if (found.rows.length) { step.note = '德立云已有该车牌，不能将他人或已有车辆当作新车覆盖；请核对原登记'; return step; }
      op = await this.opRepo.save(this.opRepo.create({ tenantId: txn.tenantId, database: 'deliyun', kind: 'add_vehicle', idempotencyKey,
        payload: { plate, ownerRoom, parkingSpace, endDate, businessTxnNo: txn.txnNo, park: '枫桦景苑' }, expected: {}, sourceRecordId: null, pmsUserId: null,
        status: 'running', attempt: 1, requestedAt: new Date(), completedAt: null, result: null,
        leaseAgentKey: null, leaseExpiresAt: null, lastError: null, rollbackOfOperationId: null, createdBy: txn.createdBy, updatedBy: txn.createdBy }));
      step.operationId = op.id;
      // 现有人防新增接口始期固定为办理当天；历史起期不能悄悄改成今天。
      const today = shanghaiDateOnly(new Date());
      if (String(txn.startDate).slice(0, 10) !== today) throw new BadRequestException('人防新增接口仅支持办理当天起效；此单起期不是今天，未调用新增，请核对');
      const created = await this.deliyun.setCivilDefenseAuthorization({ plate, authorized: true, createOnly: true, ownerRoom, parkingSpace, beginDate: txn.startDate!, endDate, remark: '来自PMS' });
      const after = await this.deliyun.findVehiclesByPlate(plate, '枫桦景苑');
      const row = after.rows[0];
      if (!created.verified || !created.created || after.rows.length !== 1 || row.id !== created.vehicleId || row.plate !== plate ||
          row.ownerName !== ownerRoom || row.cardNo !== parkingSpace || row.endDate !== endDate || !row.civilDefenseAuthorized) throw new BadRequestException('人防已发出新增但车牌、房号、车位、日期或授权回读不一致；请核对原任务，勿重复新增');
      op.status = 'completed'; op.completedAt = new Date(); op.sourceRecordId = created.vehicleId;
      op.result = { ...created, ownerRoom, parkingSpace, endDate, verified: true };
      await this.opRepo.save(op);
      step.status = 'done'; step.note = `人防新车已建立并回读至 ${endDate}；云授权已核对，现场通行未验`;
    } catch (error) {
      step.note = error instanceof Error ? error.message.slice(0, 300) : '人防新增结果未确认，请核对原任务';
      if (op) { op.status = 'failed'; op.lastError = step.note; op.completedAt = new Date(); await this.opRepo.save(op); }
    }
    return step;
  }

  private async finish(txn: BusinessTransaction, status: ExternalSyncStatus, execution: ExecutionState) {
    const final = status === 'synced' || status === 'manual' || status === 'failed' || status === 'dry_run';
    const exec = { ...execution, finishedAt: final ? new Date().toISOString() : null };
    await this.txnRepo.update({ id: txn.id }, { externalSyncStatus: status, // eslint-disable-next-line @typescript-eslint/no-explicit-any
      snapshot: { ...(txn.snapshot || {}), execution: exec } as any });
    // 等现场助手回执的轮询（queued→queued）不重复记日志
    const prevStatus = (txn.snapshot?.execution as ExecutionState | undefined)?.steps?.length ? txn.externalSyncStatus : null;
    if (!(status === 'queued' && (prevStatus === 'queued' || prevStatus === 'running'))) {
      await this.log(txn, `external_sync_${status}`, {
        connector: 'deliyun', mode: exec.mode, attempts: exec.attempts, lastError: exec.lastError ?? null,
        planned: exec.planned ?? null, operationId: exec.operationId ?? null,
        steps: exec.steps?.map((s) => ({ label: s.label, status: s.status, note: s.note ?? null })) ?? null,
      }, txn.createdBy);
    }
    return { id: txn.id, externalSyncStatus: status };
  }

  private log(txn: BusinessTransaction, action: string, detail: Record<string, unknown>, by: number | null) {
    return this.logRepo.save(this.logRepo.create({
      tenantId: txn.tenantId, transactionId: txn.id, action: action.slice(0, 60), detail, createdBy: by, updatedBy: by,
    })).catch((e) => this.logger.warn(`log ${action} failed: ${e?.message || e}`));
  }

  /** 给前端的执行状态汇总（待处理页用） */
  async pending(tenantId: number, scope: number[] | null) {
    const where = {
      tenantId,
      serviceType: BusinessServiceType.PARKING_MONTHLY,
      externalSyncStatus: In(['awaiting_docs', 'review', 'rejected', 'queued', 'running', 'retry', 'manual', 'failed', 'dry_run']),
      ...(scope ? { communityId: In(scope) } : {}),
    };
    return this.txnRepo.find({ where, order: { id: 'DESC' }, take: 200 });
  }
}
