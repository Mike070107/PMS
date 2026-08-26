import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Not, Repository } from 'typeorm';
import { UserRole } from '../../common/enums';
import { DEFAULT_ROLE_TEMPLATES, RoleDataScope } from '../../common/pages';
import { Role, RolePermission, Tenant, User, UserRoleAssignment } from '../../entities';

const BUILT_IN_ADMIN_ROLE = '企业超级管理员';

/**
 * 启动种子（幂等）：
 * 1. 每个公司种一个不可删的「企业超级管理员」角色 —— 绑上它就是企业超管，权限直通。
 * 2. 公司第一次跑到这里时，种一批开箱即用的角色（维修工、物业办公室…）。
 *    它们只是**名字 + 勾好的页面 + 数据范围**，可以随便改名、改勾选、删掉，
 *    改完不会被下次启动覆盖回去 —— 靠 tenants.rbac_seeded_at 保证只种一次。
 *
 * 这里没有「角色类型」这种东西：一个人能干什么，只看他绑的角色勾了哪些页面。
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
      // 一家公司的数据有问题不能连累后面所有公司 —— 循环里不兜住，
      // 第一家出错就等于全平台永远迁移不了，而且每次启动重复失败
      try {
        await this.seedTenant(tenant.id);
      } catch (e) {
        this.logger.error(
          `tenant ${tenant.id}: RBAC seed failed: ${(e as Error).message}`,
        );
      }
    }
  }

  /**
   * 单个租户的补齐。平台新开公司时也调它（platform.service）——
   * 否则新公司要等到下次 API 重启才有角色可选，一个员工都建不出来。
   */
  async seedTenant(tenantId: number) {
    const builtIn = await this.ensureBuiltInRole(tenantId);
    await this.seedDefaultRoles(tenantId, builtIn);
  }

  private async ensureBuiltInRole(tenantId: number): Promise<Role> {
    const existing = await this.roleRepo.findOne({ where: { tenantId, builtIn: true } });
    if (existing) return existing;
    const created = await this.roleRepo.save(
      this.roleRepo.create({
        tenantId,
        name: BUILT_IN_ADMIN_ROLE,
        remark: '系统内置：绑定该角色即企业超级管理员，全部页面直通，不可删除',
        dataScope: RoleDataScope.ALL,
        builtIn: true,
        enabled: true,
        createdBy: null,
        updatedBy: null,
      }),
    );
    this.logger.log(`tenant ${tenantId}: seeded built-in admin role`);
    return created;
  }

  /**
   * 开箱即用的几个角色，**每个公司只种一次**。
   *
   * 只种一次是关键：做成每次启动都跑，企业超管之后的任何调整
   * （改名、取消某个入口、停用角色）都会在下次重启被悄悄改回去，
   * 而日志里只有一行「seeded」，没人能把现象和重启联系起来。
   *
   * 同时把还没绑任何角色的存量员工挂到名字对得上的那个角色上，
   * 免得升级当天所有人打开小程序只剩一个「我的」。
   */
  private async seedDefaultRoles(tenantId: number, builtIn: Role) {
    const tenant = await this.tenantRepo.findOne({ where: { id: tenantId } });
    if (!tenant || tenant.rbacSeededAt) return;

    const existing = await this.roleRepo.find({ where: { tenantId } });
    const byName = new Map(existing.map((r) => [r.name, r]));
    const created = new Map<string, Role>();

    for (const tpl of DEFAULT_ROLE_TEMPLATES) {
      if (byName.has(tpl.name)) {
        // 同名角色已经存在（升级前手工建的）：一个字都不改，权限也不碰。
        // 它可能勾着后台的增删改，补进去等于把这些权限发给一批人
        created.set(tpl.name, byName.get(tpl.name)!);
        continue;
      }
      const role = await this.roleRepo.save(
        this.roleRepo.create({
          tenantId,
          name: tpl.name,
          remark: tpl.remark,
          dataScope: RoleDataScope.ALL,
          builtIn: false,
          enabled: true,
          createdBy: null,
          updatedBy: null,
        }),
      );
      const rows = [
        ...Object.entries(tpl.appPages),
        ...Object.entries(tpl.adminPages ?? {}),
      ].map(([pageKey, level]) =>
        this.permRepo.create({
          tenantId,
          roleId: role.id,
          pageKey,
          canView: true,
          canEdit: level === 'e',
          canDelete: false,
          createdBy: null,
          updatedBy: null,
        }),
      );
      if (rows.length) await this.permRepo.save(rows);
      created.set(tpl.name, role);
      byName.set(tpl.name, role);
      this.logger.log(`tenant ${tenantId}: seeded role "${tpl.name}"`);
    }

    await this.bindLegacyUsers(tenantId, byName, builtIn);
    await this.tenantRepo.update({ id: tenantId }, { rbacSeededAt: new Date() });
  }

  /**
   * 给还没绑角色的存量员工挂一个角色。
   *
   * 老库里 users.role 存的是 technician / office / manager / … 这些旧身份，
   * 按下面的对照挂到同名角色上；对不上的（或已经绑了角色的）不动。
   * 挂完把 users.role 统一成 staff —— 从此这一列只回答「哪个端」。
   */
  private async bindLegacyUsers(
    tenantId: number,
    byName: Map<string, Role>,
    builtIn: Role,
  ) {
    const LEGACY_ROLE_TO_NAME: Record<string, string> = {
      technician: '维修工',
      office: '物业办公室',
      manager: '物业经理',
      purchaser: '采购经理',
      guard: '保安',
      neighborhood: '居委会',
      owner_committee: '业委会',
      property_staff: '保安',
    };

    const staff = await this.userRepo.find({
      where: { tenantId, role: Not(In([UserRole.OWNER, UserRole.SUPERADMIN])) },
      select: ['id', 'role'],
    });
    if (!staff.length) return;

    const bound = new Set(
      (
        await this.userRoleRepo.find({
          where: { tenantId, userId: In(staff.map((u) => u.id)) },
          select: ['userId'],
        })
      ).map((b) => b.userId),
    );

    const rows: UserRoleAssignment[] = [];
    for (const user of staff) {
      if (bound.has(user.id)) continue;
      // 老库里的企业管理员：绑内置角色，否则升级后他自己都进不去后台
      const target =
        (user.role as string) === 'admin'
          ? builtIn
          : byName.get(LEGACY_ROLE_TO_NAME[user.role as string] ?? '');
      if (!target) continue;
      rows.push(
        this.userRoleRepo.create({
          tenantId,
          userId: user.id,
          roleId: target.id,
          createdBy: null,
          updatedBy: null,
        }),
      );
    }
    if (rows.length) {
      await this.userRoleRepo.save(rows);
      this.logger.log(`tenant ${tenantId}: bound role to ${rows.length} legacy user(s)`);
    }

    // users.role 从此只表示「哪个端」：业主 / 员工 / 平台
    const normalized = await this.userRepo.update(
      { tenantId, role: Not(In([UserRole.OWNER, UserRole.SUPERADMIN, UserRole.STAFF])) },
      { role: UserRole.STAFF },
    );
    if (normalized.affected) {
      this.logger.log(
        `tenant ${tenantId}: normalized ${normalized.affected} user(s) to role=staff`,
      );
    }
  }
}
