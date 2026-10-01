import { BadRequestException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { AuthUser } from '../../common/current-user.decorator';
import { STAFF_APP_ROLES, UserStatus } from '../../common/enums';
import { ExternalAccessApp, ExternalAccessGrant, LanGatewayAgent, User } from '../../entities';
import { CloudflareGatewayService } from './cloudflare-gateway.service';
import {
  CreateExternalAccessAppDto,
  CreateLanGatewayAgentDto,
  EnrollLanGatewayAgentDto,
  LanGatewayHeartbeatDto,
  UpdateExternalAccessAppDto,
  UpdateLanGatewayAgentDto,
} from './dto';
import { normalizeExternalRoute, resolveExternalAccessProvider } from './external-access.util';
import {
  createGatewayDeviceToken,
  createGatewayInstallCode,
  gatewaySecretMatches,
  hashGatewaySecret,
  signGatewayConfiguration,
} from './lan-gateway-security';

@Injectable()
export class ExternalAccessService {
  private readonly enrollmentRate = new Map<string, { count: number; resetAt: number }>();
  constructor(
    @InjectRepository(ExternalAccessApp)
    private readonly appRepo: Repository<ExternalAccessApp>,
    @InjectRepository(ExternalAccessGrant)
    private readonly grantRepo: Repository<ExternalAccessGrant>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(LanGatewayAgent)
    private readonly agentRepo: Repository<LanGatewayAgent>,
    private readonly cloudflare: CloudflareGatewayService,
  ) {}

  async list(user: AuthUser) {
    const tenantId = this.requireTenant(user);
    const apps = await this.appRepo.find({ where: { tenantId }, order: { id: 'ASC' } });
    const grants = apps.length
      ? await this.grantRepo.find({ where: { tenantId, appId: In(apps.map((app) => app.id)) } })
      : [];
    const agentIds = [...new Set(apps.map((app) => app.agentId).filter((id): id is number => !!id))];
    const agents = agentIds.length ? await this.agentRepo.find({ where: { tenantId, id: In(agentIds) } }) : [];
    const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
    const byApp = new Map<number, number[]>();
    for (const grant of grants) {
      const ids = byApp.get(grant.appId) ?? [];
      ids.push(grant.userId);
      byApp.set(grant.appId, ids);
    }
    return apps.map((app) => this.view(app, byApp.get(app.id) ?? [], app.agentId ? agentsById.get(app.agentId) : undefined));
  }

  async users(user: AuthUser) {
    const tenantId = this.requireTenant(user);
    const rows = await this.userRepo.find({
      where: { tenantId, role: In(STAFF_APP_ROLES) },
      order: { name: 'ASC', id: 'ASC' },
    });
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      phone: row.phone,
      status: row.status,
      wxBound: !!row.wxOpenid,
    }));
  }

  configuration() {
    const provider = resolveExternalAccessProvider();
    return {
      provider,
      providerLabel: provider === 'domestic' ? '腾讯云 WSS 网关' : 'Cloudflare Tunnel',
    };
  }

  async listAgents(user: AuthUser) {
    const tenantId = this.requireTenant(user);
    const agents = await this.agentRepo.find({ where: { tenantId }, order: { id: 'ASC' } });
    const appCounts = await this.appRepo
      .createQueryBuilder('app')
      .select('app.agent_id', 'agentId')
      .addSelect('COUNT(*)', 'count')
      .where('app.tenant_id = :tenantId', { tenantId })
      .andWhere('app.agent_id IS NOT NULL')
      .groupBy('app.agent_id')
      .getRawMany<{ agentId: string; count: string }>();
    const counts = new Map(appCounts.map((row) => [Number(row.agentId), Number(row.count)]));
    return agents.map((agent) => this.agentView(agent, counts.get(agent.id) ?? 0));
  }

  async createAgent(dto: CreateLanGatewayAgentDto, user: AuthUser) {
    const tenantId = this.requireTenant(user);
    const installCode = createGatewayInstallCode();
    const agent = await this.agentRepo.save(this.agentRepo.create({
      tenantId,
      name: dto.name.trim(),
      deviceKey: `lan-${createGatewayDeviceToken().slice(0, 20)}`,
      tokenHash: null,
      installCodeHash: hashGatewaySecret(installCode),
      installCodeExpiresAt: new Date(Date.now() + 10 * 60_000),
      enrolledAt: null,
      status: 'pending',
      version: null,
      computerName: null,
      desiredRevision: 0,
      appliedRevision: 0,
      lastSeenAt: null,
      lastError: null,
      enabled: true,
      createdBy: user.id,
      updatedBy: user.id,
    }));
    return { ...this.agentView(agent, 0), installCode, installCodeExpiresAt: agent.installCodeExpiresAt };
  }

  async updateAgent(id: number, dto: UpdateLanGatewayAgentDto, user: AuthUser) {
    const tenantId = this.requireTenant(user);
    const agent = await this.agentRepo.findOne({ where: { id, tenantId } });
    if (!agent) throw new NotFoundException('代理设备不存在');
    if (dto.name !== undefined) agent.name = dto.name.trim();
    if (dto.enabled !== undefined) {
      agent.enabled = dto.enabled;
      agent.status = dto.enabled ? (agent.tokenHash ? 'offline' : 'pending') : 'disabled';
    }
    agent.updatedBy = user.id;
    await this.agentRepo.save(agent);
    return this.agentView(agent, await this.appRepo.count({ where: { tenantId, agentId: id } }));
  }

  async rotateAgentInstallCode(id: number, user: AuthUser) {
    const tenantId = this.requireTenant(user);
    const agent = await this.agentRepo.findOne({ where: { id, tenantId } });
    if (!agent) throw new NotFoundException('代理设备不存在');
    const installCode = createGatewayInstallCode();
    agent.installCodeHash = hashGatewaySecret(installCode);
    agent.installCodeExpiresAt = new Date(Date.now() + 10 * 60_000);
    agent.updatedBy = user.id;
    await this.agentRepo.save(agent);
    return { installCode, installCodeExpiresAt: agent.installCodeExpiresAt };
  }

  async enrollAgent(dto: EnrollLanGatewayAgentDto, clientIp = 'unknown') {
    this.assertEnrollmentRate(clientIp);
    const normalizedCode = dto.installCode.trim().toUpperCase();
    const agent = await this.agentRepo.findOne({ where: { installCodeHash: hashGatewaySecret(normalizedCode) } });
    if (!agent || !agent.installCodeExpiresAt || agent.installCodeExpiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException('安装码无效或已过期，请在 PMS 重新生成');
    }
    if (!agent.enabled) throw new ForbiddenException('这台代理设备已停用');
    const frpToken = process.env.LAN_GATEWAY_FRP_TOKEN?.trim();
    if (!frpToken) throw new BadRequestException('网关平台尚未配置代理凭据');
    const deviceToken = createGatewayDeviceToken();
    agent.tokenHash = hashGatewaySecret(deviceToken);
    agent.installCodeHash = null;
    agent.installCodeExpiresAt = null;
    agent.enrolledAt = new Date();
    agent.status = 'online';
    agent.version = dto.version.trim();
    agent.computerName = dto.computerName.trim();
    agent.lastSeenAt = new Date();
    agent.lastError = null;
    await this.agentRepo.save(agent);
    return {
      deviceId: agent.deviceKey,
      deviceToken,
      frpToken,
      apiBaseUrl: process.env.PUBLIC_API_BASE_URL?.replace(/\/$/, '') || 'https://prsznh.cn/api/v1',
    };
  }

  async agentConfiguration(deviceKey: string, token: string) {
    const agent = await this.authenticateAgent(deviceKey, token);
    const apps = await this.appRepo.find({ where: { tenantId: agent.tenantId, agentId: agent.id }, order: { id: 'ASC' } });
    const configuration = JSON.stringify({
      deviceId: agent.deviceKey,
      revision: agent.desiredRevision,
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      serverAddress: process.env.LAN_GATEWAY_SERVER_ADDRESS?.trim() || 'gateway.prsznh.cn',
      serverPort: Number(process.env.LAN_GATEWAY_SERVER_PORT || 443),
      routes: apps.map((app) => ({
        appId: app.id,
        id: app.slug,
        name: app.name,
        publicHostname: app.publicHostname,
        localUrl: `${app.originUrl}${app.entryPath === '/' ? '' : app.entryPath || ''}`,
        remotePort: app.gatewayPort,
        enabled: app.enabled,
      })),
    });
    return { configuration, signature: signGatewayConfiguration(configuration, token) };
  }

  async agentHeartbeat(deviceKey: string, token: string, dto: LanGatewayHeartbeatDto) {
    const agent = await this.authenticateAgent(deviceKey, token);
    agent.version = dto.version.trim();
    agent.lastSeenAt = new Date();
    agent.appliedRevision = Math.min(dto.appliedRevision, agent.desiredRevision);
    agent.lastError = dto.error?.trim() || null;
    agent.status = !dto.processRunning || agent.lastError ? 'degraded' : 'online';
    await this.agentRepo.save(agent);

    const apps = await this.appRepo.find({ where: { tenantId: agent.tenantId, agentId: agent.id } });
    const reports = new Map(dto.routes.map((route) => [route.appId, route]));
    const publicChecks = new Map(await Promise.all(apps
      .filter((app) => app.enabled && agent.appliedRevision >= app.desiredRevision && dto.processRunning && reports.get(app.id)?.healthy)
      .map(async (app) => [app.id, await this.checkPublicGateway(app.publicHostname)] as const)));
    for (const app of apps) {
      const report = reports.get(app.id);
      const revisionApplied = agent.appliedRevision >= app.desiredRevision;
      app.appliedRevision = revisionApplied ? app.desiredRevision : app.appliedRevision;
      app.originCheckedAt = report ? new Date() : app.originCheckedAt;
      if (!app.enabled) {
        app.publishStatus = 'disabled';
        app.lastSyncError = null;
      } else if (!revisionApplied || !dto.processRunning) {
        app.publishStatus = 'publishing';
        app.lastSyncError = dto.error?.trim() || null;
      } else if (!report?.healthy) {
        app.publishStatus = 'error';
        app.lastSyncError = report?.message?.trim() || '代理已应用配置，但无法访问内网网站';
      } else {
        const publicCheck = publicChecks.get(app.id) ?? { ok: false, message: '公网 HTTPS 尚未完成检查' };
        app.publishStatus = publicCheck.ok ? 'online' : 'publishing';
        app.lastSyncError = publicCheck.ok ? null : publicCheck.message;
        if (publicCheck.ok) app.lastSyncedAt = new Date();
      }
      await this.appRepo.save(app);
    }
    return { ok: true, desiredRevision: agent.desiredRevision, refreshConfiguration: agent.appliedRevision < agent.desiredRevision };
  }

  async authorizeFrpOperation(pluginSecret: string, operation: string, request: Record<string, any>) {
    const expectedSecret = process.env.LAN_GATEWAY_FRP_PLUGIN_SECRET?.trim();
    if (!expectedSecret || !gatewaySecretMatches(pluginSecret, hashGatewaySecret(expectedSecret))) {
      throw new NotFoundException('FRP admission endpoint not found');
    }
    const content = request?.content ?? {};
    const user = operation === 'Login' ? content : content.user ?? {};
    const deviceKey = String(user.user || '').trim();
    const deviceToken = String(user.metas?.deviceToken || '').trim();
    try {
      const agent = await this.authenticateAgent(deviceKey, deviceToken);
      if (operation === 'Login') return { reject: false, unchange: true };
      if (operation !== 'NewProxy') return { reject: true, reject_reason: 'operation is not allowed' };
      const remotePort = Number(content.remote_port);
      const proxyName = String(content.proxy_name || '').replace(`${deviceKey}.`, '');
      const app = await this.appRepo.findOne({
        where: { tenantId: agent.tenantId, agentId: agent.id, gatewayPort: remotePort, slug: proxyName, enabled: true },
      });
      if (!app || content.proxy_type !== 'tcp' || content.use_encryption !== true) {
        return { reject: true, reject_reason: 'proxy is not assigned to this device' };
      }
      return { reject: false, unchange: true };
    } catch {
      return { reject: true, reject_reason: 'device authentication failed' };
    }
  }

  async resolveGatewayApplication(hostname: string) {
    const normalized = String(hostname || '').trim().toLowerCase().split(':')[0];
    const app = await this.appRepo.findOne({ where: { publicHostname: normalized, enabled: true } });
    if (!app) throw new NotFoundException('这个域名没有已发布的内网应用');
    const agent = app.agentId ? await this.agentRepo.findOne({ where: { id: app.agentId, tenantId: app.tenantId } }) : null;
    if (!agent || !agent.enabled || !agent.lastSeenAt || Date.now() - agent.lastSeenAt.getTime() > 90_000) {
      throw new ServiceUnavailableException('内网代理设备离线或已停用');
    }
    if (app.publishStatus !== 'online' || !app.gatewayPort) {
      throw new ServiceUnavailableException(app.lastSyncError || '内网应用尚未完成发布');
    }
    return app;
  }

  createGatewaySession(app: ExternalAccessApp, userId: number) {
    const secret = this.gatewaySessionSecret();
    const seconds = app.sessionDuration === '30m' ? 1800 : app.sessionDuration === '4h' ? 14400 : 3600;
    const now = Math.floor(Date.now() / 1000);
    const payload = Buffer.from(JSON.stringify({
      userId,
      appId: app.id,
      slug: app.slug,
      iat: now,
      exp: now + seconds,
      jti: randomBytes(12).toString('base64url'),
    })).toString('base64url');
    const signature = createHmac('sha256', secret).update(payload).digest('base64url');
    return { token: `${payload}.${signature}`, maxAge: seconds };
  }

  async verifyGatewaySession(hostname: string, token: string) {
    const app = await this.resolveGatewayApplication(hostname);
    const [payload, signature, extra] = String(token || '').split('.');
    if (!payload || !signature || extra) throw new UnauthorizedException('请先扫码授权');
    const expected = createHmac('sha256', this.gatewaySessionSecret()).update(payload).digest();
    let actual: Buffer;
    try { actual = Buffer.from(signature, 'base64url'); } catch { throw new UnauthorizedException('登录会话无效'); }
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new UnauthorizedException('登录会话无效');
    }
    let claims: { userId?: number; appId?: number; slug?: string; exp?: number };
    try { claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); }
    catch { throw new UnauthorizedException('登录会话无效'); }
    if (claims.appId !== app.id || claims.slug !== app.slug || !claims.userId || !claims.exp || claims.exp <= Math.floor(Date.now() / 1000)) {
      throw new UnauthorizedException('登录会话已过期或不属于当前应用');
    }
    const grant = await this.grantRepo.findOne({ where: { appId: app.id, userId: claims.userId } });
    const user = await this.userRepo.findOne({ where: { id: claims.userId, tenantId: app.tenantId } });
    if (!grant || !user || user.status !== UserStatus.ACTIVE || !STAFF_APP_ROLES.includes(user.role)) {
      throw new ForbiddenException('你已没有这个内网应用的访问权限');
    }
    const origin = new URL(app.originUrl);
    return {
      appId: app.id,
      slug: app.slug,
      name: app.name,
      userId: claims.userId,
      upstream: `http://127.0.0.1:${app.gatewayPort}`,
      originHost: origin.host,
      entryPath: app.entryPath || '/',
    };
  }

  async create(dto: CreateExternalAccessAppDto, user: AuthUser) {
    const tenantId = this.requireTenant(user);
    const normalized = this.normalize(dto.publicHostname, dto.originUrl);
    await this.validateUsers(tenantId, dto.userIds);
    await this.assertRouteAvailable(tenantId, normalized.publicHostname);
    const provider = resolveExternalAccessProvider();
    const agent = provider === 'domestic' ? await this.requireAgent(tenantId, dto.agentId) : null;
    const gatewayPort = provider === 'domestic' ? await this.allocateGatewayPort() : null;
    const app = await this.appRepo.save(
      this.appRepo.create({
        tenantId,
        slug: await this.deriveUniqueSlug(tenantId, normalized.publicHostname),
        name: dto.name.trim(),
        ...normalized,
        sessionDuration: dto.sessionDuration ?? '1h',
        enabled: dto.enabled ?? true,
        agentId: agent?.id ?? null,
        gatewayPort,
        publishStatus: provider === 'domestic' ? 'waiting_agent' : 'draft',
        desiredRevision: 0,
        appliedRevision: 0,
        originCheckedAt: null,
        cloudflareAppId: null,
        cloudflarePolicyId: null,
        cloudflareDnsRecordId: null,
        lastSyncedAt: null,
        lastSyncError: null,
        createdBy: user.id,
        updatedBy: user.id,
      }),
    );
    await this.replaceGrants(app, dto.userIds, user.id);
    if (agent) await this.bumpAgentRevision(agent, [app]);
    else await this.syncAndRecord(app);
    return this.view(app, dto.userIds, agent ?? undefined);
  }

  async update(id: number, dto: UpdateExternalAccessAppDto, user: AuthUser) {
    const tenantId = this.requireTenant(user);
    const app = await this.appRepo.findOne({ where: { id, tenantId } });
    if (!app) throw new NotFoundException('内网应用不存在');
    if (dto.userIds !== undefined) {
      await this.validateUsers(tenantId, dto.userIds);
    }
    const oldHostname = app.publicHostname;
    const oldAgentId = app.agentId;
    if (dto.name !== undefined) app.name = dto.name.trim();
    if (dto.sessionDuration !== undefined) app.sessionDuration = dto.sessionDuration;
    if (dto.enabled !== undefined) app.enabled = dto.enabled;
    if (dto.agentId !== undefined && resolveExternalAccessProvider() === 'domestic') {
      app.agentId = (await this.requireAgent(tenantId, dto.agentId)).id;
    }
    if (dto.publicHostname !== undefined || dto.originUrl !== undefined) {
      const normalized = this.normalize(
        dto.publicHostname ?? app.publicHostname,
        dto.originUrl ?? `${app.originUrl}${app.entryPath || '/'}`,
      );
      await this.assertRouteAvailable(tenantId, normalized.publicHostname, app.id);
      Object.assign(app, normalized);
    }
    app.updatedBy = user.id;
    await this.appRepo.save(app);
    if (dto.userIds !== undefined) {
      await this.replaceGrants(app, dto.userIds, user.id);
    }
    if (resolveExternalAccessProvider() === 'domestic') {
      if (!app.gatewayPort) app.gatewayPort = await this.allocateGatewayPort();
      const affectedIds = [...new Set([oldAgentId, app.agentId].filter((id): id is number => !!id))];
      for (const agentId of affectedIds) {
        const agent = await this.agentRepo.findOne({ where: { id: agentId, tenantId } });
        if (agent) await this.bumpAgentRevision(agent, agentId === app.agentId ? [app] : []);
      }
    } else await this.syncAndRecord(app, oldHostname);
    const grants = await this.grantRepo.find({ where: { appId: app.id } });
    const currentAgent = app.agentId ? await this.agentRepo.findOne({ where: { id: app.agentId, tenantId } }) : null;
    return this.view(app, grants.map((grant) => grant.userId), currentAgent ?? undefined);
  }

  async sync(id: number, user: AuthUser) {
    const tenantId = this.requireTenant(user);
    const app = await this.appRepo.findOne({ where: { id, tenantId } });
    if (!app) throw new NotFoundException('内网应用不存在');
    if (resolveExternalAccessProvider() === 'domestic') {
      const agent = await this.requireAgent(tenantId, app.agentId ?? undefined);
      await this.bumpAgentRevision(agent, [app]);
    } else await this.syncAndRecord(app, undefined, true);
    return { ok: true, syncedAt: app.lastSyncedAt };
  }

  private async syncAndRecord(
    app: ExternalAccessApp,
    oldHostname?: string,
    throwOnError = false,
  ) {
    if (resolveExternalAccessProvider() === 'domestic') {
      throw new BadRequestException('国内网关必须通过受管代理发布');
    }
    try {
      const allApps = await this.appRepo.find({ where: { tenantId: app.tenantId } });
      await this.cloudflare.syncApp(app, allApps, oldHostname);
      app.lastSyncedAt = new Date();
      app.lastSyncError = null;
      app.publishStatus = app.enabled ? 'online' : 'disabled';
      app.appliedRevision = app.desiredRevision;
      await this.appRepo.save(app);
    } catch (error) {
      app.lastSyncError = (error as Error).message.slice(0, 1000);
      app.publishStatus = 'error';
      await this.appRepo.save(app);
      if (throwOnError) throw error;
    }
  }

  private normalize(publicHostname: string, originUrl: string) {
    const zone = process.env.CLOUDFLARE_ZONE_NAME?.trim().toLowerCase() || 'prsznh.cn';
    return normalizeExternalRoute(publicHostname, originUrl, zone);
  }

  private async validateUsers(tenantId: number, userIds: number[]) {
    const unique = [...new Set(userIds)];
    if (!unique.length) throw new BadRequestException('至少授权一个用户');
    const users = await this.userRepo.find({ where: { tenantId, id: In(unique) } });
    if (users.length !== unique.length) throw new BadRequestException('授权名单中包含无效用户');
    const invalid = users.find(
      (item) => !STAFF_APP_ROLES.includes(item.role) || item.status !== UserStatus.ACTIVE,
    );
    if (invalid) throw new BadRequestException(`用户「${invalid.name || invalid.id}」不是有效员工账号`);
  }

  private async assertRouteAvailable(tenantId: number, hostname: string, exceptId?: number) {
    const existing = await this.appRepo.findOne({ where: { publicHostname: hostname } });
    if (existing && existing.id !== exceptId) {
      throw new BadRequestException(
        existing.tenantId === tenantId
          ? '这个外网域名已用于其他内网应用'
          : '这个外网域名已被占用，请更换子域名',
      );
    }
  }

  private async deriveUniqueSlug(tenantId: number, hostname: string) {
    const zone = process.env.CLOUDFLARE_ZONE_NAME?.trim().toLowerCase() || 'prsznh.cn';
    const prefix = hostname.slice(0, -(zone.length + 1));
    const base = prefix.replace(/\./g, '-').replace(/[^a-z0-9-]/g, '-').slice(0, 52);
    for (let suffix = 0; suffix < 1000; suffix += 1) {
      const slug = suffix ? `${base}-${suffix + 1}` : base;
      const existing = await this.appRepo.findOne({ where: { tenantId, slug } });
      if (!existing) return slug;
    }
    throw new BadRequestException('无法生成唯一权限标识，请更换外网子域名');
  }

  private async replaceGrants(app: ExternalAccessApp, userIds: number[], operatorId: number) {
    await this.grantRepo.delete({ appId: app.id });
    const unique = [...new Set(userIds)];
    if (!unique.length) return;
    await this.grantRepo.save(
      unique.map((userId) =>
        this.grantRepo.create({
          tenantId: app.tenantId,
          appId: app.id,
          userId,
          createdBy: operatorId,
          updatedBy: operatorId,
        }),
      ),
    );
  }

  private view(app: ExternalAccessApp, userIds: number[], agent?: LanGatewayAgent) {
    const stale = !!agent && (!agent.lastSeenAt || Date.now() - agent.lastSeenAt.getTime() > 90_000);
    const agentStatus = !agent ? null : !agent.enabled ? 'disabled' : agent.tokenHash && stale ? 'offline' : agent.status;
    return { ...app, userIds, agentName: agent?.name ?? null, agentStatus };
  }

  private async requireAgent(tenantId: number, agentId?: number) {
    if (!agentId) throw new BadRequestException('请选择一台内网代理设备');
    const agent = await this.agentRepo.findOne({ where: { id: agentId, tenantId } });
    if (!agent) throw new BadRequestException('选择的内网代理不存在');
    if (!agent.enabled) throw new BadRequestException(`内网代理「${agent.name}」已停用`);
    return agent;
  }

  private async allocateGatewayPort() {
    const min = Number(process.env.LAN_GATEWAY_PORT_MIN || 18050);
    const max = Number(process.env.LAN_GATEWAY_PORT_MAX || 18999);
    if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1024 || max < min) {
      throw new BadRequestException('网关自动端口范围配置无效');
    }
    const rows = await this.appRepo
      .createQueryBuilder('app')
      .select('app.gateway_port', 'port')
      .where('app.gateway_port IS NOT NULL')
      .getRawMany<{ port: number }>();
    const used = new Set(rows.map((row) => Number(row.port)));
    for (let port = min; port <= max; port += 1) if (!used.has(port)) return port;
    throw new BadRequestException('网关可用通道已用完，请联系管理员扩容');
  }

  private async bumpAgentRevision(agent: LanGatewayAgent, apps: ExternalAccessApp[]) {
    agent.desiredRevision += 1;
    await this.agentRepo.save(agent);
    for (const app of apps) {
      app.desiredRevision = agent.desiredRevision;
      app.publishStatus = app.enabled ? 'waiting_agent' : 'disabled';
      app.lastSyncError = app.enabled && !agent.tokenHash ? '代理尚未安装，请输入 PMS 生成的安装码' : null;
      await this.appRepo.save(app);
    }
  }

  private async authenticateAgent(deviceKey: string, token: string) {
    const agent = await this.agentRepo.findOne({ where: { deviceKey: (deviceKey || '').trim() } });
    if (!agent || !agent.enabled || !gatewaySecretMatches(token, agent.tokenHash)) {
      throw new UnauthorizedException('代理设备凭据无效');
    }
    return agent;
  }

  private agentView(agent: LanGatewayAgent, appCount: number) {
    const stale = !agent.lastSeenAt || Date.now() - agent.lastSeenAt.getTime() > 90_000;
    const status = !agent.enabled ? 'disabled' : agent.tokenHash && stale ? 'offline' : agent.status;
    return {
      id: agent.id,
      name: agent.name,
      deviceKey: agent.deviceKey,
      status,
      version: agent.version,
      computerName: agent.computerName,
      desiredRevision: agent.desiredRevision,
      appliedRevision: agent.appliedRevision,
      lastSeenAt: agent.lastSeenAt,
      lastError: agent.lastError,
      enabled: agent.enabled,
      enrolled: !!agent.tokenHash,
      appCount,
    };
  }

  private gatewaySessionSecret() {
    const secret = process.env.LAN_GATEWAY_SESSION_SECRET?.trim();
    if (!secret || secret.length < 32) throw new ServiceUnavailableException('网关会话签名密钥尚未正确配置');
    return secret;
  }

  private assertEnrollmentRate(identity: string) {
    const now = Date.now();
    const current = this.enrollmentRate.get(identity);
    if (!current || current.resetAt <= now) {
      this.enrollmentRate.set(identity, { count: 1, resetAt: now + 10 * 60_000 });
      return;
    }
    current.count += 1;
    if (current.count > 20) throw new UnauthorizedException('安装码尝试过于频繁，请十分钟后再试');
  }

  private requireTenant(user: AuthUser) {
    if (!user.tenantId) throw new BadRequestException('企业范围缺失');
    return user.tenantId;
  }

  private async checkPublicGateway(hostname: string): Promise<{ ok: boolean; message: string | null }> {
    try {
      const response = await fetch(`https://${hostname}/_pms_gateway/healthz`, {
        headers: { 'cache-control': 'no-cache' },
        redirect: 'manual',
        signal: AbortSignal.timeout(5_000),
      });
      if (response.ok) return { ok: true, message: null };
      return { ok: false, message: `内网代理已就绪，公网 HTTPS 检查返回 ${response.status}` };
    } catch {
      return { ok: false, message: '内网代理已就绪，正在等待公网域名与 HTTPS 入口生效' };
    }
  }
}
