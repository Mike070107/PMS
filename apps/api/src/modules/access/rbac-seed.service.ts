import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  ASSIGNABLE_STAFF_ROLES,
  USER_ROLE_LABELS,
  UserRole,
} from '../../common/enums';
import {
  ADMIN_PAGE_KEYS,
  DEFAULT_APP_PAGES_BY_IDENTITY,
  RoleDataScope,
  isStaffAppPageKey,
} from '../../common/pages';
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
 * 3. 业务身份与后台角色合并（2026-08-26）后：公司里实际存在的每个业务身份都种一个
 *    同名角色（维修工 / 物业办公室 / …），并把还没有身份角色的人绑上去。
 *    **新种的身份角色权限矩阵故意留空** —— 存量的后台权限还挂在「全功能（兼容）」上，
 *    权限取并集，所以这一步不改变任何人现有的能看能点，只是把「他是哪一行」
 *    这件事从 users.role 挪到角色上，让后台改角色能真正传导到小程序。
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
      // 一家公司的数据有问题（历史脏数据、同名冲突）不能连累后面所有公司 ——
      // 循环里不兜住，第一家出错就等于全平台永远迁移不了，且每次启动重复失败
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
   * 否则新公司要等到下次 API 重启才有身份角色可选，一个员工都建不出来。
   */
  async seedTenant(tenantId: number) {
    await this.ensureBuiltInRole(tenantId);
    await this.ensureCompatBindings(tenantId);
    await this.ensureIdentityRoles(tenantId);
  }

  private async ensureBuiltInRole(tenantId: number) {
    const existing = await this.roleRepo.findOne({
      where: { tenantId, builtIn: true },
    });
    if (existing) {
      // 合并前建的内置角色没有业务身份，补上 —— 不补的话 ensureIdentityRoles
      // 会因为「没有 business_role=admin 的角色」再造一个叫「物业管理员」的，
      // 公司里就并排躺着两个企业超管角色
      if (!existing.businessRole) {
        existing.businessRole = UserRole.ADMIN;
        await this.roleRepo.save(existing);
        this.logger.log(`tenant ${tenantId}: built-in role claimed identity admin`);
      }
      return;
    }
    await this.roleRepo.save(
      this.roleRepo.create({
        tenantId,
        name: BUILT_IN_ADMIN_ROLE,
        remark: '系统内置：绑定该角色即企业超级管理员，不可删除',
        businessRole: UserRole.ADMIN,
        dataScope: RoleDataScope.ALL,
        builtIn: true,
        enabled: true,
        createdBy: null,
        updatedBy: null,
      }),
    );
    this.logger.log(`tenant ${tenantId}: seeded built-in admin role`);
  }

  /**
   * 业务身份 ↔ 角色合并的存量补齐，**每个租户只做一次**（tenants.rbac_seeded_at）。
   *
   * 为什么只做一次：做成每次启动都跑，企业超管之后的任何调整都会被悄悄回滚 ——
   * 他把某个角色的身份清掉、把某个小程序入口取消、把角色停用，重启一次全都变回来，
   * 而日志里只有一行「seeded」，没人能把现象和重启联系起来。
   *
   * 做三件事：
   * 1. 每个业务身份都要有一个对应角色（全部 9 个都种，不只公司里已用到的那几个 ——
   *    否则「开公司第一个保安账号」在下拉里无处可选）。
   * 2. 同名角色**只在它没有任何后台页面权限时**才认领。这一条是安全底线：
   *    升级前手工建的「维修工」角色可能勾着工单管理的增删改，认领后所有维修工
   *    都会被绑上去，等于一次重启把后台权限发给了全体现场人员。
   * 3. 把身上没有「与自己 users.role 相符的身份角色」的人绑上去。
   */
  private async ensureIdentityRoles(tenantId: number) {
    const tenant = await this.tenantRepo.findOne({ where: { id: tenantId } });
    if (!tenant || tenant.rbacSeededAt) return;

    const roles = await this.roleRepo.find({ where: { tenantId } });
    const roleByName = new Map(roles.map((r) => [r.name, r]));
    // 一个身份可以有多个角色（各管理处各一套），这里只关心「种子建的那一个」，
    // 认的是名字：USER_ROLE_LABELS 里的标准名
    const seededByIdentity = new Map<string, Role>();
    for (const r of roles) {
      if (r.businessRole && !seededByIdentity.has(r.businessRole)) {
        seededByIdentity.set(r.businessRole, r);
      }
    }

    for (const identity of ASSIGNABLE_STAFF_ROLES) {
      if (seededByIdentity.has(identity)) continue;
      const name = USER_ROLE_LABELS[identity] ?? identity;
      const sameName = roleByName.get(name);
      if (sameName && !(await this.hasAdminPermissions(sameName.id))) {
        // 同名且没有任何后台权限：就是个空壳，认领它，别并排造第二个「维修工」
        sameName.businessRole = identity;
        await this.roleRepo.save(sameName);
        await this.ensureAppPages(sameName, identity);
        seededByIdentity.set(identity, sameName);
        this.logger.log(`tenant ${tenantId}: claimed empty role "${name}" as ${identity}`);
        continue;
      }
      // 同名角色带着后台权限 —— 不碰它，另起一个名字，让企业超管自己决定怎么合并
      const finalName = sameName ? `${name}（员工端）` : name;
      if (roleByName.has(finalName)) {
        this.logger.warn(
          `tenant ${tenantId}: skip seeding ${identity}, both "${name}" and "${finalName}" exist`,
        );
        continue;
      }
      const created = await this.roleRepo.save(
        this.roleRepo.create({
          tenantId,
          name: finalName,
          remark: sameName
            ? `升级时自动创建：同名角色「${name}」已有后台权限，未合并，请自行取舍`
            : '升级时自动创建：先只带业务身份，网站权限请按需勾选',
          businessRole: identity,
          dataScope: RoleDataScope.ALL,
          builtIn: false,
          enabled: true,
          createdBy: null,
          updatedBy: null,
        }),
      );
      roleByName.set(finalName, created);
      await this.ensureAppPages(created, identity);
      seededByIdentity.set(identity, created);
      this.logger.log(`tenant ${tenantId}: seeded identity role "${finalName}"`);
    }

    await this.bindUsersToIdentityRoles(tenantId, seededByIdentity);
    await this.tenantRepo.update({ id: tenantId }, { rbacSeededAt: new Date() });
  }

  /** 这个角色有没有任何**后台**页面权限（app:* 不算） */
  private async hasAdminPermissions(roleId: number) {
    const perms = await this.permRepo.find({ where: { roleId }, select: ['pageKey'] });
    return perms.some((p) => !isStaffAppPageKey(p.pageKey));
  }

  /**
   * 把人绑到与他 users.role 相符的身份角色上。
   *
   * 判据是「绑的身份角色和 users.role 一致」，不是「绑了任一身份角色」——
   * 后者会把脏数据固化：张三是办公室，却绑着一个碰巧被认领成 technician 的角色，
   * 于是他后台按办公室办事、小程序却是维修工那套，谁也看不出哪里错了。
   */
  private async bindUsersToIdentityRoles(
    tenantId: number,
    roleByIdentity: Map<string, Role>,
  ) {
    const users = await this.userRepo.find({
      where: { tenantId, role: In(ASSIGNABLE_STAFF_ROLES) },
      select: ['id', 'role'],
    });
    if (!users.length) return;
    const bindings = await this.userRoleRepo.find({
      where: { tenantId, userId: In(users.map((u) => u.id)) },
    });
    const identityByRoleId = new Map<number, string>();
    roleByIdentity.forEach((role, identity) => identityByRoleId.set(role.id, identity));

    const toInsert: { userId: number; roleId: number }[] = [];
    for (const user of users) {
      const mine = bindings.filter((b) => b.userId === user.id);
      const matched = mine.some(
        (b) => identityByRoleId.get(b.roleId) === (user.role as string),
      );
      if (matched) continue;
      const target = roleByIdentity.get(user.role as string);
      if (!target) continue;
      toInsert.push({ userId: user.id, roleId: target.id });
    }
    if (!toInsert.length) return;
    await this.userRoleRepo.save(
      toInsert.map((b) =>
        this.userRoleRepo.create({
          tenantId,
          userId: b.userId,
          roleId: b.roleId,
          createdBy: null,
          updatedBy: null,
        }),
      ),
    );
    this.logger.log(
      `tenant ${tenantId}: bound identity role to ${toInsert.length} user(s)`,
    );
  }

  /**
   * 给身份角色补上员工端那几格的默认权限。
   *
   * 只在这个角色**一条 app: 权限都没有**时写 —— 企业超管后来在角色管理里
   * 把某一格取消了，不能被下次启动的种子又加回去。
   */
  private async ensureAppPages(role: Role, identity: string) {
    const existing = await this.permRepo.find({ where: { roleId: role.id } });
    if (existing.some((p) => isStaffAppPageKey(p.pageKey))) return;
    // 推荐组合与后台新建角色时预填的是同一份（common/pages.ts）
    const preset = DEFAULT_APP_PAGES_BY_IDENTITY[identity];
    if (!preset) return;
    await this.permRepo.save(
      Object.entries(preset).map(([pageKey, level]) =>
        this.permRepo.create({
          tenantId: role.tenantId,
          roleId: role.id,
          pageKey,
          canView: true,
          canEdit: level === 'e',
          canDelete: false,
          createdBy: null,
          updatedBy: null,
        }),
      ),
    );
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
