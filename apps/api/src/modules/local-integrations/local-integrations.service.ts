import { StandardParkingQueryService } from './standard-parking-query.service';
import { StandardCardIssuanceService } from './standard-card-issuance.service';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, Optional, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomBytes } from 'node:crypto';
import { AuthUser } from '../../common/current-user.decorator';
import { LocalIntegration, LocalIntegrationTask } from '../../entities/local-integration.entity';
import { agentTokenMatches, hashAgentToken, issueAgentSecret } from '../access-card-issuance/agent-auth';
import { EnrollIntegrationDto, IntegrationHeartbeatDto, IntegrationTaskDto, IntegrationReportDto } from './dto';
import { PROTOCOL_VERSION, sameJson, validateCommand, validateResources, validateResult } from './protocol';

@Injectable()
export class LocalIntegrationsService {
  constructor(@InjectRepository(LocalIntegration) private readonly integrations: Repository<LocalIntegration>,
    @InjectRepository(LocalIntegrationTask) private readonly tasks: Repository<LocalIntegrationTask>,
    @Optional() private readonly standardCards?: StandardCardIssuanceService,
    @Optional() private readonly standardParkingQueries?: StandardParkingQueryService) {}

  private tenant(user: AuthUser) {
    if (!user.tenantId) throw new ForbiddenException('请选择企业');
    return user.tenantId;
  }
  private checked(validate: () => void) {
    try { validate(); } catch (e) { throw new BadRequestException(e instanceof Error ? e.message : 'Invalid protocol payload'); }
  }
  private publicIntegration(row: LocalIntegration) {
    const { tokenHash, ...publicRow } = row;
    return { ...publicRow, protocolVersion: PROTOCOL_VERSION,
      status: row.enabled && row.lastSeenAt && Date.now() - new Date(row.lastSeenAt).getTime() < 15_000 ? 'online' : 'offline' };
  }
  async list(user: AuthUser) {
    return (await this.integrations.find({ where: { tenantId: this.tenant(user) }, order: { createdAt: 'DESC', id: 'DESC' } })).map(row => this.publicIntegration(row));
  }
  async enroll(dto: EnrollIntegrationDto, user: AuthUser) {
    this.checked(() => validateResources(dto.resources));
    const name = dto.name.trim();
    if (!name) throw new BadRequestException('名称不能为空');
    const secret = issueAgentSecret();
    // A duplicate name must never silently rotate an installed assistant's credentials.
    try {
      const row = await this.integrations.save(this.integrations.create({ tenantId: this.tenant(user), name,
        key: `local-${randomBytes(16).toString('hex')}`, kind: dto.kind, tokenHash: secret.tokenHash,
        resources: dto.resources, ready: [], enabled: true, version: 'pending', lastSeenAt: null,
        createdBy: user.id, updatedBy: user.id }));
      return { ...this.publicIntegration(row), token: `${row.key}.${secret.token}` };
    } catch (error) {
      if ((error as any)?.code === '23505') throw new ConflictException('名称已存在；请使用现有连接，轮换密钥需单独确认');
      throw error;
    }
  }
  private async find(key: string, user: AuthUser) {
    const row = await this.integrations.findOne({ where: { key, tenantId: this.tenant(user) } });
    if (!row) throw new NotFoundException('连接不存在');
    return row;
  }
  async enable(key: string, enabled: boolean, user: AuthUser) {
    const row = await this.find(key, user);
    row.enabled = enabled; row.ready = []; row.lastSeenAt = null; row.updatedBy = user.id;
    await this.integrations.update({ id: row.id, tenantId: row.tenantId }, { enabled, ready: [], lastSeenAt: null, updatedBy: user.id });
    return this.publicIntegration(row);
  }
  async rotate(key: string, user: AuthUser) {
    const row = await this.find(key, user); const secret = issueAgentSecret();
    row.tokenHash = secret.tokenHash; row.ready = []; row.lastSeenAt = null; row.updatedBy = user.id;
    await this.integrations.update({ id: row.id, tenantId: row.tenantId }, { tokenHash: secret.tokenHash, ready: [], lastSeenAt: null, updatedBy: user.id });
    return { ...this.publicIntegration(row), token: `${row.key}.${secret.token}` };
  }
  async authenticate(key: string, token: string, repo = this.integrations, lock = false) {
    const row = await repo.findOne({ where: { key, enabled: true }, ...(lock ? { lock: { mode: 'pessimistic_write' as const } } : {}) });
    const raw = token.startsWith(`${key}.`) ? token.slice(key.length + 1) : token;
    if (!row || !raw || !agentTokenMatches(raw, row.tokenHash)) throw new UnauthorizedException('连接密钥无效或已停用');
    return row;
  }
  async heartbeat(key: string, token: string, dto: IntegrationHeartbeatDto) {
    const row = await this.authenticate(key, token);
    if (dto.protocolVersion !== PROTOCOL_VERSION) throw new BadRequestException('Unsupported protocol version');
    // An empty ready list means no usable device/database, NOT implicit readiness.
    if (dto.ready.length) this.checked(() => validateResources(dto.ready));
    for (const ready of dto.ready) {
      const permitted = row.resources.find(r => r.id === ready.id);
      if (!permitted || ready.capabilities.some(c => !permitted.capabilities.some(p => p.operation === c.operation && p.revision === c.revision))) throw new ForbiddenException('能力超出注册范围');
    }
    row.version = dto.version; row.ready = dto.ready; row.lastSeenAt = new Date(); row.updatedBy = null;
    const updated = await this.integrations.update({ id: row.id, enabled: true, tokenHash: row.tokenHash },
      { version: row.version, ready: row.ready, lastSeenAt: row.lastSeenAt, updatedBy: null });
    if (!updated.affected) throw new UnauthorizedException('连接密钥已轮换或已停用');
    return { protocolVersion: PROTOCOL_VERSION, heartbeatIntervalMs: 5000, serverTime: new Date().toISOString() };
  }
  async createTask(key: string, dto: IntegrationTaskDto, user: AuthUser) {
    const row = await this.find(key, user);
    this.checked(() => validateCommand(dto.operation, dto.command));
    // A caller-supplied allocationId is not proof of a real reserved card number.
    // Only formal batch creation + the existing .80 allocation ledger may create a bound physical write.
    if (dto.operation === 'card.write') throw new BadRequestException('标准写卡必须经过真实卡号分配；请使用门禁发卡的正式写卡工作站通道');
    if (dto.revision !== 1 || !row.resources.some(r => r.id === dto.resourceId && r.capabilities.some(c => c.operation === dto.operation && c.revision === dto.revision))) throw new BadRequestException('未注册该资源/能力版本');
    const identity = { tenantId: row.tenantId, integrationKey: key, idempotencyKey: dto.idempotencyKey };
    const existing = await this.tasks.findOne({ where: identity });
    const replay = (task: LocalIntegrationTask) => {
      if (task.resourceId !== dto.resourceId || task.operation !== dto.operation || task.revision !== dto.revision || !sameJson(task.command, dto.command)) throw new ConflictException('幂等键已用于不同操作');
      return this.publicTask(task);
    };
    if (existing) return replay(existing);
    if (!row.enabled) throw new BadRequestException('连接已停用');
    try { return this.publicTask(await this.tasks.save(this.tasks.create({ ...identity, resourceId: dto.resourceId, operation: dto.operation,
      revision: dto.revision, command: dto.command, status: 'pending', createdBy: user.id, updatedBy: user.id }))); }
    catch (error) {
      if ((error as any)?.code !== '23505') throw error;
      const raced = await this.tasks.findOne({ where: identity });
      if (!raced) throw error;
      return replay(raced);
    }
  }
  private publicTask(task: LocalIntegrationTask) {
    const { leaseToken, ...publicTask } = task;
    return { ...publicTask, protocolVersion: PROTOCOL_VERSION };
  }
  async getTask(key: string, id: number, user: AuthUser) {
    await this.find(key, user);
    const row = await this.tasks.findOne({ where: { id, integrationKey: key, tenantId: this.tenant(user) } });
    if (!row) throw new NotFoundException('任务不存在');
    return this.publicTask(row);
  }
  async claim(key: string, token: string) {
    return this.tasks.manager.transaction(async manager => {
      const agent = await this.authenticate(key, token, manager.getRepository(LocalIntegration), true);
      if (!agent.lastSeenAt || Date.now() - new Date(agent.lastSeenAt).getTime() >= 15000) return { task: null };
      const repo = manager.getRepository(LocalIntegrationTask);
      // Expired physical side effects are unknown, never automatically executed again.
      const expired = await repo.createQueryBuilder('task')
        .where('task.tenant_id = :tenant AND task.integration_key = :key AND task.status = :status AND task.lease_expires_at < :now',
          { tenant: agent.tenantId, key, status: 'running', now: new Date() }).getMany();
      for (const task of expired) {
        task.status = 'unknown';
        await this.standardCards?.acceptResult(manager, task);
        await this.standardParkingQueries?.acceptResult(manager, task);
        await repo.save(task);
      }
      const task = await repo.createQueryBuilder('task').setLock('pessimistic_write').setOnLocked('skip_locked')
        .where('task.tenant_id = :tenant AND task.integration_key = :key AND task.status = :status', { tenant: agent.tenantId, key, status: 'pending' })
        .andWhere('EXISTS (SELECT 1 FROM jsonb_array_elements(:ready::jsonb) r, jsonb_array_elements(r->\'capabilities\') c WHERE r->>\'id\' = task.resource_id AND c->>\'operation\' = task.operation AND (c->>\'revision\')::int = task.revision)', { ready: JSON.stringify(agent.ready) })
        .orderBy('task.id', 'ASC').getOne();
      if (!task) return { task: null };
      task.status = 'running'; task.leaseToken = randomBytes(32).toString('hex'); task.leaseExpiresAt = new Date(Date.now() + 60000);
      await repo.save(task);
      return { task: { ...this.publicTask(task), leaseToken: task.leaseToken }, retryAfterMs: 2500 };
    });
  }
  async report(key: string, token: string, id: number, dto: IntegrationReportDto) {
    return this.tasks.manager.transaction(async manager => {
      const agent = await this.authenticate(key, token, manager.getRepository(LocalIntegration), true);
      const repo = manager.getRepository(LocalIntegrationTask);
      const task = await repo.findOne({ where: { id, tenantId: agent.tenantId, integrationKey: key }, lock: { mode: 'pessimistic_write' } });
      if (!task) throw new NotFoundException('任务不存在');
      if (!task.leaseToken || !agentTokenMatches(dto.leaseToken, hashAgentToken(task.leaseToken))) throw new ConflictException('任务租约不匹配');
      this.checked(() => { validateResult(task.operation, dto.result); });
      if (task.result) {
        if (!sameJson(task.result, dto.result)) throw new ConflictException('结果已保存，不能覆盖');
        return this.publicTask(task);
      }
      if (!['running', 'unknown'].includes(task.status)) throw new ConflictException('任务尚未领取');
      task.result = dto.result; task.status = dto.result.outcome as LocalIntegrationTask['status']; task.completedAt = new Date();
      await this.standardCards?.acceptResult(manager, task);
      await this.standardParkingQueries?.acceptResult(manager, task);
      return this.publicTask(await repo.save(task));
    });
  }
}
