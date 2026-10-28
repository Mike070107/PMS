import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { In, LessThan, Repository } from 'typeorm';
import { BusinessLog, BusinessRule, BusinessTransaction, ParkingOperation } from '../../entities';
import { findParkingTarget } from './parking-targets';
import { BusinessServiceType } from '../../common/enums';
import { AuthUser } from '../../common/current-user.decorator';
import { DeliyunParkingService } from '../access-card-issuance/deliyun-parking.service';
import {
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
  async retry(id: number, user: AuthUser) {
    const txn = await this.txnRepo.findOne({ where: { id, tenantId: user.tenantId! } });
    if (!txn) throw new NotFoundException('流水不存在');
    if (txn.serviceType !== BusinessServiceType.PARKING_MONTHLY) throw new BadRequestException('这笔业务还没有接入自动执行');
    if (!RETRYABLE_BY_HAND.includes(txn.externalSyncStatus as ExternalSyncStatus) && txn.externalSyncStatus !== 'mocked') {
      throw new BadRequestException(`当前状态「${txn.externalSyncStatus}」不能重试`);
    }
    const prev = (txn.snapshot?.execution as ExecutionState | undefined) ?? null;
    const execution: ExecutionState = { connector: 'deliyun', mode: this.mode(), attempts: 0, nextAt: null, lastError: null, operationId: prev?.operationId ?? null };
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

  private async finish(txn: BusinessTransaction, status: ExternalSyncStatus, execution: ExecutionState) {
    const final = status === 'synced' || status === 'manual' || status === 'failed' || status === 'dry_run';
    const exec = { ...execution, finishedAt: final ? new Date().toISOString() : null };
    await this.txnRepo.update({ id: txn.id }, { externalSyncStatus: status, // eslint-disable-next-line @typescript-eslint/no-explicit-any
      snapshot: { ...(txn.snapshot || {}), execution: exec } as any });
    await this.log(txn, `external_sync_${status}`, {
      connector: 'deliyun', mode: exec.mode, attempts: exec.attempts, lastError: exec.lastError ?? null,
      planned: exec.planned ?? null, operationId: exec.operationId ?? null,
    }, txn.createdBy);
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
      externalSyncStatus: In(['queued', 'running', 'retry', 'manual', 'failed', 'dry_run']),
      ...(scope ? { communityId: In(scope) } : {}),
    };
    return this.txnRepo.find({ where, order: { id: 'DESC' }, take: 200 });
  }
}
