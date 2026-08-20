import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { UserRole } from '../../common/enums';
import { ADMIN_PAGE_KEYS, RoleDataScope } from '../../common/pages';
import { Role, RolePermission, Tenant, User, UserRoleAssignment } from '../../entities';

const BUILT_IN_ADMIN_ROLE = '企业超级管理员';
const COMPAT_ROLE = '全功能（兼容）';

/** 上线前就存在的后台身份：自动挂兼容角色，避免权限体系上线当天他们菜单全空 */
const LEGACY_WEB_ROLES: UserRole[] = [
  UserRole.MANAGER,
  UserRole.OFFICE,
  UserRole.PURCHASER,
];

/**
 * 启动种子（幂等，每次启动跑一遍）：
 * 1. 每个公司种一个不可删的「企业超级管理员」内置角色（绑定即企业超管）。
 * 2. 存量 manager/office/purchaser 账号若没绑任何后台角色，自动绑「全功能（兼容）」，
 *    之后由企业超管在角色管理里逐个收紧。业务身份 admin 天然是企业超管，不用绑。
 */
@Injectable()
export class RbacSeedService implements OnApplicationBootstrap {
  private readonly logger = new Logger(RbacSeedService.name);

  constructor(
    @InjectRepository(Tenant)
    private readonly tenantRepo: Repository<Tenant>,
    @InjectRepository(Role)
    private readonly roleRepo: Repository<Role>,
    @InjectRepository(RolePermission)
    private readonly permRepo: Repository<RolePermission>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(UserRoleAssignment)
    private readonly userRoleRepo: Repository<UserRoleAssignment>,
  ) {}

  async onApplicationBootstrap() {
    try {
      await this.seed();
    } catch (e) {
      // 种子失败不该拦着服务起来（比如首次部署时表还没建好），下次启动再补
      this.logger.error(`RBAC seed failed: ${(e as Error).message}`);
    }
  }

  private async seed() {
    const tenants = await this.tenantRepo.find({ select: ['id'] });
    for (const tenant of tenants) {
      await this.ensureBuiltInRole(tenant.id);
      await this.ensureCompatBindings(tenant.id);
    }
  }

  private async ensureBuiltInRole(tenantId: number) {
    const existing = await this.roleRepo.findOne({
      where: { tenantId, builtIn: true },
    });
    if (existing) return;
    await this.roleRepo.save(
      this.roleRepo.create({
        tenantId,
        name: BUILT_IN_ADMIN_ROLE,
        remark: '系统内置：绑定该角色即企业超级管理员，不可删除',
        dataScope: RoleDataScope.ALL,
        builtIn: true,
        enabled: true,
        createdBy: null,
        updatedBy: null,
      }),
    );
    this.logger.log(`tenant ${tenantId}: seeded built-in admin role`);
  }

  private async ensureCompatBindings(tenantId: number) {
    const legacyUsers = await this.userRepo.find({
      where: { tenantId, role: In(LEGACY_WEB_ROLES) },
      select: ['id'],
    });
    if (!legacyUsers.length) return;
    const bound = await this.userRoleRepo.find({
      where: { tenantId, userId: In(legacyUsers.map((u) => u.id)) },
      select: ['userId'],
    });
    const boundIds = new Set(bound.map((b) => b.userId));
    const unbound = legacyUsers.filter((u) => !boundIds.has(u.id));
    if (!unbound.length) return;

    let compat = await this.roleRepo.findOne({
      where: { tenantId, name: COMPAT_ROLE },
    });
    if (!compat) {
      compat = await this.roleRepo.save(
        this.roleRepo.create({
          tenantId,
          name: COMPAT_ROLE,
          remark: '升级权限体系时自动创建：全部页面全部权限，建议逐步换成收紧后的角色',
          dataScope: RoleDataScope.ALL,
          builtIn: false,
          enabled: true,
          createdBy: null,
          updatedBy: null,
        }),
      );
      await this.permRepo.save(
        ADMIN_PAGE_KEYS.map((pageKey) =>
          this.permRepo.create({
            tenantId,
            roleId: compat!.id,
            pageKey,
            canView: true,
            canEdit: true,
            canDelete: true,
            createdBy: null,
            updatedBy: null,
          }),
        ),
      );
    }

    await this.userRoleRepo.save(
      unbound.map((u) =>
        this.userRoleRepo.create({
          tenantId,
          userId: u.id,
          roleId: compat!.id,
          createdBy: null,
          updatedBy: null,
        }),
      ),
    );
    this.logger.log(
      `tenant ${tenantId}: bound compat role to ${unbound.length} legacy user(s)`,
    );
  }
}
