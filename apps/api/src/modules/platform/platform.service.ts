import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import bcrypt from 'bcryptjs';
import { DataSource, In, Repository } from 'typeorm';
import { AuthUser } from '../../common/current-user.decorator';
import { UserRole, UserStatus } from '../../common/enums';
import { RoleDataScope } from '../../common/pages';
import { Community, PlatformLog, Role, Tenant, User } from '../../entities';
import { CreateTenantDto, ResetTenantAdminDto, UpdateTenantDto } from './dto';

/** 每个公司自动种下的内置角色名（不可删；绑定即企业超管） */
export const BUILT_IN_ADMIN_ROLE = '企业超级管理员';

@Injectable()
export class PlatformService {
  constructor(
    @InjectRepository(Tenant)
    private readonly tenantRepo: Repository<Tenant>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(Community)
    private readonly communityRepo: Repository<Community>,
    @InjectRepository(PlatformLog)
    private readonly logRepo: Repository<PlatformLog>,
    private readonly dataSource: DataSource,
  ) {}

  async listTenants() {
    const tenants = await this.tenantRepo.find({ order: { id: 'ASC' } });
    if (!tenants.length) return [];
    const ids = tenants.map((t) => t.id);
    const [userCounts, communityCounts, admins] = await Promise.all([
      this.userRepo
        .createQueryBuilder('u')
        .select('u.tenant_id', 'tenantId')
        .addSelect('COUNT(*)', 'count')
        .where('u.tenant_id IN (:...ids)', { ids })
        .groupBy('u.tenant_id')
        .getRawMany<{ tenantId: number; count: string }>(),
      this.communityRepo
        .createQueryBuilder('c')
        .select('c.tenant_id', 'tenantId')
        .addSelect('COUNT(*)', 'count')
        .where('c.tenant_id IN (:...ids)', { ids })
        .andWhere('c.parent_id IS NULL')
        .groupBy('c.tenant_id')
        .getRawMany<{ tenantId: number; count: string }>(),
      this.userRepo.find({
        where: { tenantId: In(ids), role: UserRole.ADMIN },
        select: ['id', 'tenantId', 'name', 'loginAccount', 'status'],
        order: { id: 'ASC' },
      }),
    ]);
    const usersByTenant = new Map(userCounts.map((r) => [Number(r.tenantId), Number(r.count)]));
    const communitiesByTenant = new Map(
      communityCounts.map((r) => [Number(r.tenantId), Number(r.count)]),
    );
    return tenants.map((t) => ({
      id: t.id,
      name: t.name,
      contactName: t.contactName,
      contactPhone: t.contactPhone,
      enabled: t.enabled,
      enabledPages: t.enabledPages,
      expiresAt: t.expiresAt,
      userCount: usersByTenant.get(t.id) ?? 0,
      communityCount: communitiesByTenant.get(t.id) ?? 0,
      admins: admins
        .filter((a) => a.tenantId === t.id)
        .map((a) => ({
          id: a.id,
          name: a.name,
          loginAccount: a.loginAccount,
          status: a.status,
        })),
      createdAt: t.createdAt,
    }));
  }

  async createTenant(dto: CreateTenantDto, operator: AuthUser) {
    const account = dto.admin.account.trim();
    const existing = await this.userRepo.findOne({
      where: { loginAccount: account },
    });
    if (existing) throw new BadRequestException('登录账号已被占用');

    const result = await this.dataSource.transaction(async (em) => {
      const tenant = await em.getRepository(Tenant).save(
        em.getRepository(Tenant).create({
          name: dto.name.trim(),
          contactName: dto.contactName ?? null,
          contactPhone: dto.contactPhone ?? null,
          enabledPages: dto.enabledPages ?? null,
          expiresAt: dto.expiresAt ?? null,
          enabled: true,
          createdBy: operator.id,
          updatedBy: operator.id,
        }),
      );
      await em.getRepository(Role).save(
        em.getRepository(Role).create({
          tenantId: tenant.id,
          name: BUILT_IN_ADMIN_ROLE,
          remark: '系统内置：绑定该角色即企业超级管理员，不可删除',
          dataScope: RoleDataScope.ALL,
          builtIn: true,
          enabled: true,
          createdBy: operator.id,
          updatedBy: operator.id,
        }),
      );
      const admin = await em.getRepository(User).save(
        em.getRepository(User).create({
          tenantId: tenant.id,
          name: dto.admin.name,
          phone: dto.admin.phone ?? null,
          loginAccount: account,
          passwordHash: await bcrypt.hash(dto.admin.password, 10),
          role: UserRole.ADMIN,
          status: UserStatus.ACTIVE,
          wxOpenid: null,
          wxUnionid: null,
          wxNickname: null,
          houseId: null,
          createdBy: operator.id,
          updatedBy: operator.id,
        }),
      );
      return { tenantId: tenant.id, adminUserId: admin.id };
    });

    await this.log(operator, 'tenant_create', result.tenantId, {
      name: dto.name,
      adminAccount: account,
    });
    return result;
  }

  async updateTenant(id: number, dto: UpdateTenantDto, operator: AuthUser) {
    const tenant = await this.tenantRepo.findOne({ where: { id } });
    if (!tenant) throw new NotFoundException('公司不存在');
    const before = {
      name: tenant.name,
      enabled: tenant.enabled,
      enabledPages: tenant.enabledPages,
      expiresAt: tenant.expiresAt,
    };
    if (dto.name !== undefined) tenant.name = dto.name.trim();
    if (dto.contactName !== undefined) tenant.contactName = dto.contactName;
    if (dto.contactPhone !== undefined) tenant.contactPhone = dto.contactPhone;
    if ('enabledPages' in dto) tenant.enabledPages = dto.enabledPages ?? null;
    if ('expiresAt' in dto) tenant.expiresAt = dto.expiresAt ?? null;
    if (dto.enabled !== undefined) tenant.enabled = dto.enabled;
    tenant.updatedBy = operator.id;
    await this.tenantRepo.save(tenant);

    await this.log(
      operator,
      dto.enabled === false ? 'tenant_disable' : 'tenant_update',
      id,
      { before, after: dto },
    );
    return { id: tenant.id };
  }

  /** 重置某公司管理员的密码（帮客户找回入口） */
  async resetAdminPassword(
    tenantIdParam: number,
    dto: ResetTenantAdminDto,
    operator: AuthUser,
  ) {
    const target = await this.userRepo.findOne({
      where: { id: dto.userId, tenantId: tenantIdParam },
    });
    if (!target) throw new NotFoundException('用户不存在');
    if (target.role !== UserRole.ADMIN) {
      throw new BadRequestException('只能在这里重置企业管理员的密码');
    }
    target.passwordHash = await bcrypt.hash(dto.password, 10);
    target.updatedBy = operator.id;
    await this.userRepo.save(target);
    await this.log(operator, 'admin_reset_password', tenantIdParam, {
      userId: target.id,
      account: target.loginAccount,
    });
    return { ok: true };
  }

  /** 进入公司视角（Login As）：只做审计与回显，实际身份由请求头切换 */
  async enterTenant(id: number, operator: AuthUser) {
    const tenant = await this.tenantRepo.findOne({ where: { id } });
    if (!tenant) throw new NotFoundException('公司不存在');
    await this.log(operator, 'tenant_switch', id, { name: tenant.name });
    return {
      id: tenant.id,
      name: tenant.name,
      enabled: tenant.enabled,
      enabledPages: tenant.enabledPages,
      expiresAt: tenant.expiresAt,
    };
  }

  async exitTenant(id: number, operator: AuthUser) {
    await this.log(operator, 'tenant_exit', id, null);
    return { ok: true };
  }

  async listLogs(tenantId?: number) {
    return this.logRepo.find({
      where: tenantId ? { targetTenantId: tenantId } : {},
      order: { id: 'DESC' },
      take: 200,
    });
  }

  private async log(
    operator: AuthUser,
    action: string,
    targetTenantId: number | null,
    detail: Record<string, unknown> | null,
  ) {
    // 审计失败不阻塞主流程
    try {
      await this.logRepo.save(
        this.logRepo.create({
          actorUserId: operator.id,
          action,
          targetTenantId,
          detail,
          createdBy: operator.id,
          updatedBy: operator.id,
        }),
      );
    } catch {
      /* noop */
    }
  }
}
