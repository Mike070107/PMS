import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { AuthUser } from '../../common/current-user.decorator';
import { STAFF_APP_ROLES, UserStatus } from '../../common/enums';
import { ExternalAccessApp, ExternalAccessGrant, User } from '../../entities';
import { CloudflareGatewayService } from './cloudflare-gateway.service';
import { CreateExternalAccessAppDto, UpdateExternalAccessAppDto } from './dto';
import { normalizeExternalRoute } from './external-access.util';

@Injectable()
export class ExternalAccessService {
  constructor(
    @InjectRepository(ExternalAccessApp)
    private readonly appRepo: Repository<ExternalAccessApp>,
    @InjectRepository(ExternalAccessGrant)
    private readonly grantRepo: Repository<ExternalAccessGrant>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly cloudflare: CloudflareGatewayService,
  ) {}

  async list(user: AuthUser) {
    const tenantId = this.requireTenant(user);
    const apps = await this.appRepo.find({ where: { tenantId }, order: { id: 'ASC' } });
    const grants = apps.length
      ? await this.grantRepo.find({ where: { tenantId, appId: In(apps.map((app) => app.id)) } })
      : [];
    const byApp = new Map<number, number[]>();
    for (const grant of grants) {
      const ids = byApp.get(grant.appId) ?? [];
      ids.push(grant.userId);
      byApp.set(grant.appId, ids);
    }
    return apps.map((app) => this.view(app, byApp.get(app.id) ?? []));
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

  async create(dto: CreateExternalAccessAppDto, user: AuthUser) {
    const tenantId = this.requireTenant(user);
    const normalized = this.normalize(dto.publicHostname, dto.originUrl);
    await this.validateUsers(tenantId, dto.userIds);
    await this.assertRouteAvailable(tenantId, normalized.publicHostname);
    const app = await this.appRepo.save(
      this.appRepo.create({
        tenantId,
        slug: await this.deriveUniqueSlug(tenantId, normalized.publicHostname),
        name: dto.name.trim(),
        ...normalized,
        sessionDuration: dto.sessionDuration ?? '8h',
        enabled: dto.enabled ?? true,
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
    await this.syncAndRecord(app);
    return this.view(app, dto.userIds);
  }

  async update(id: number, dto: UpdateExternalAccessAppDto, user: AuthUser) {
    const tenantId = this.requireTenant(user);
    const app = await this.appRepo.findOne({ where: { id, tenantId } });
    if (!app) throw new NotFoundException('内网应用不存在');
    if (dto.userIds !== undefined) {
      await this.validateUsers(tenantId, dto.userIds);
    }
    const oldHostname = app.publicHostname;
    if (dto.name !== undefined) app.name = dto.name.trim();
    if (dto.sessionDuration !== undefined) app.sessionDuration = dto.sessionDuration;
    if (dto.enabled !== undefined) app.enabled = dto.enabled;
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
    await this.syncAndRecord(app, oldHostname);
    const grants = await this.grantRepo.find({ where: { appId: app.id } });
    return this.view(app, grants.map((grant) => grant.userId));
  }

  async sync(id: number, user: AuthUser) {
    const tenantId = this.requireTenant(user);
    const app = await this.appRepo.findOne({ where: { id, tenantId } });
    if (!app) throw new NotFoundException('内网应用不存在');
    await this.syncAndRecord(app, undefined, true);
    return { ok: true, syncedAt: app.lastSyncedAt };
  }

  private async syncAndRecord(
    app: ExternalAccessApp,
    oldHostname?: string,
    throwOnError = false,
  ) {
    try {
      const allApps = await this.appRepo.find({ where: { tenantId: app.tenantId } });
      await this.cloudflare.syncApp(app, allApps, oldHostname);
      app.lastSyncedAt = new Date();
      app.lastSyncError = null;
      await this.appRepo.save(app);
    } catch (error) {
      app.lastSyncError = (error as Error).message.slice(0, 1000);
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

  private view(app: ExternalAccessApp, userIds: number[]) {
    return { ...app, userIds };
  }

  private requireTenant(user: AuthUser) {
    if (!user.tenantId) throw new BadRequestException('企业范围缺失');
    return user.tenantId;
  }
}
