import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import bcrypt from 'bcryptjs';
import { Brackets, In, Repository } from 'typeorm';
import { AuthUser } from '../../common/current-user.decorator';
import {
  ASSIGNABLE_STAFF_ROLES,
  REPORTER_ROLES,
  STAFF_APP_ROLES,
  USER_ROLE_LABELS,
  UserRole,
  UserStatus,
} from '../../common/enums';
import {
  Role,
  StaffProfile,
  User,
  UserReportCommunity,
  UserRoleAssignment,
} from '../../entities';
import { ResolvedAccess } from '../access/access.service';
import { RolesService } from '../roles/roles.service';
import { CreateStaffDto, ListStaffQueryDto, UpdateStaffDto } from './dto';

// 名单只此一份（common/enums.ts）：这里和 dto.ts、角色表 business_role 的取值域
// 必须是同一份，否则会出现「后台能选、保存报 invalid role」这种自相矛盾
const ASSIGNABLE_ROLES = ASSIGNABLE_STAFF_ROLES;

const isReporter = (role: UserRole) => REPORTER_ROLES.includes(role);

/** 报错文案里回显手机号，中间四位打码 */
const maskPhone = (phone: string) =>
  phone.length >= 7 ? `${phone.slice(0, 3)}****${phone.slice(-4)}` : phone;

@Injectable()
export class StaffService {
  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(StaffProfile)
    private readonly profileRepo: Repository<StaffProfile>,
    @InjectRepository(UserReportCommunity)
    private readonly reportGrantRepo: Repository<UserReportCommunity>,
    @InjectRepository(Role)
    private readonly roleRepo: Repository<Role>,
    @InjectRepository(UserRoleAssignment)
    private readonly userRoleRepo: Repository<UserRoleAssignment>,
    private readonly rolesService: RolesService,
  ) {}

  async list(query: ListStaffQueryDto, user: AuthUser) {
    const tenantId = this.requireTenant(user);
    const qb = this.userRepo
      .createQueryBuilder('u')
      .where('u.tenant_id = :tenantId', { tenantId })
      .andWhere('u.role IN (:...roles)', {
        roles: query.role ? [query.role] : ASSIGNABLE_ROLES,
      })
      .orderBy('u.id', 'DESC')
      .limit(200);

    if (query.status) qb.andWhere('u.status = :status', { status: query.status });
    if (query.q) {
      qb.andWhere(
        new Brackets((sub) => {
          sub
            .where('u.name ILIKE :kw', { kw: `%${query.q}%` })
            .orWhere('u.phone ILIKE :kw', { kw: `%${query.q}%` })
            .orWhere('u.login_account ILIKE :kw', { kw: `%${query.q}%` });
        }),
      );
    }

    const users = await qb.getMany();
    if (users.length === 0) return [];

    const profiles = await this.profileRepo.find({
      where: { tenantId, userId: In(users.map((u) => u.id)) },
    });
    const profileByUser = new Map(profiles.map((p) => [p.userId, p]));

    const grants = await this.reportGrantRepo.find({
      where: { tenantId, userId: In(users.map((u) => u.id)) },
    });
    const grantsByUser = new Map<number, number[]>();
    for (const grant of grants) {
      const list = grantsByUser.get(grant.userId) ?? [];
      list.push(grant.communityId);
      grantsByUser.set(grant.userId, list);
    }

    const rolesByUser = await this.loadRolesByUser(
      tenantId,
      users.map((u) => u.id),
    );

    return users.map((u) =>
      this.toView(
        u,
        profileByUser.get(u.id) ?? null,
        grantsByUser.get(u.id) ?? [],
        rolesByUser.get(u.id) ?? [],
      ),
    );
  }

  async create(dto: CreateStaffDto, user: AuthUser, access: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    if (dto.roleIds?.length) {
      await this.validateAssignableRoles(dto.roleIds, tenantId, access);
      await this.rolesService.assertSingleIdentity(tenantId, dto.roleIds);
    }
    // 业务身份由所选角色带出来（合并后后台只选「角色」这一栏）。
    // dto.role 只是老客户端的兜底入口，新前端不再传。
    const role = (await this.resolveIdentity(tenantId, dto.roleIds)) ?? dto.role;
    if (!role || !ASSIGNABLE_ROLES.includes(role)) {
      throw new BadRequestException('请为该用户选择一个带业务身份的角色');
    }
    this.guardAdminIdentity(role, access);

    // 维修工和代报角色都走微信登录，后台账号密码选填（填了即可授权网页登录，
    // 还需在「后台角色」里绑一个角色，adminLogin 对无角色绑定的业务身份一律拦）
    const needsLogin = role !== UserRole.TECHNICIAN && !isReporter(role);
    if (needsLogin && (!dto.loginAccount || !dto.password)) {
      throw new BadRequestException(
        'loginAccount and password are required for this role',
      );
    }
    if (dto.loginAccount) {
      const existing = await this.userRepo.findOne({
        where: { loginAccount: dto.loginAccount },
      });
      if (existing) throw new BadRequestException('loginAccount already exists');
    }
    const passwordHash = dto.password ? await bcrypt.hash(dto.password, 10) : null;

    // 一个人只留一条员工端档案。同手机号已经有员工端账号（含保安/居委会等代报
    // 角色）时直接拦下并指名道姓，让管理员去改那一条 —— 不然「用户管理」里会并排
    // 冒出两个同名的人（2026-08 实际发生过：叶双同时挂着维修工和保安两条档案，
    // 微信绑定、接单记录和代报授权跟着劈成两半，谁也说不清哪条才是他）。
    // 业主档案（role=owner，走业主端小程序）不在此列：那是同一个人在另一个端的
    // 身份，两边各自独立，建员工账号时不去动它。
    if (dto.phone) {
      const dup = await this.userRepo.findOne({
        where: { tenantId, phone: dto.phone, role: In(STAFF_APP_ROLES) },
        order: { id: 'ASC' },
      });
      if (dup) {
        const label = USER_ROLE_LABELS[dup.role] ?? dup.role;
        throw new BadRequestException(
          `手机号 ${maskPhone(dto.phone)} 已开通员工账号「${dup.name || '未填姓名'}（${label}）」，` +
            '请直接编辑那条记录调整身份，不要重复建档',
        );
      }
    }
    const created = await this.userRepo.save(
      this.userRepo.create({
        tenantId,
        wxOpenid: null,
        wxUnionid: null,
        name: dto.name,
        phone: dto.phone,
        wxNickname: null,
        passwordHash,
        loginAccount: dto.loginAccount ?? null,
        role,
        houseId: null,
        status: UserStatus.ACTIVE,
        createdBy: user.id,
        updatedBy: user.id,
      }),
    );

    let profile: StaffProfile | null = null;
    if (role === UserRole.TECHNICIAN || dto.skills?.length || dto.zones?.length) {
      profile = await this.profileRepo.save(
        this.profileRepo.create({
          tenantId,
          userId: created.id,
          skills: dto.skills ?? [],
          zones: (dto.zones ?? []).map(String),
          onDuty: true,
          createdBy: user.id,
          updatedBy: user.id,
        }),
      );
    }

    const communityIds = isReporter(role)
      ? await this.replaceReportGrants(tenantId, created.id, dto.reportCommunityIds ?? [], user.id)
      : [];

    const roles = dto.roleIds?.length
      ? await this.replaceRoleBindings(tenantId, created.id, dto.roleIds, user.id)
      : [];

    return this.toView(created, profile, communityIds, roles);
  }

  async update(id: number, dto: UpdateStaffDto, user: AuthUser, access: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    const target = await this.userRepo.findOne({ where: { id, tenantId } });
    if (!target) throw new NotFoundException('staff not found');
    if (!ASSIGNABLE_ROLES.includes(target.role)) {
      throw new BadRequestException('cannot edit this user via /staff');
    }
    await this.guardManageable(target, access);

    if (dto.role && !ASSIGNABLE_ROLES.includes(dto.role)) {
      throw new BadRequestException('invalid role');
    }
    if (dto.roleIds !== undefined && dto.roleIds.length) {
      await this.validateAssignableRoles(dto.roleIds, tenantId, access);
      await this.rolesService.assertSingleIdentity(tenantId, dto.roleIds);
    }
    // 换角色 = 换身份：这一句就是「后台把人改成维修工，员工端立刻变成维修工那套」
    const nextRole =
      dto.roleIds !== undefined
        ? (await this.resolveIdentity(tenantId, dto.roleIds)) ?? dto.role
        : dto.role;
    if (nextRole) this.guardAdminIdentity(nextRole, access);
    if (dto.loginAccount !== undefined) {
      const account = dto.loginAccount.trim();
      if (account && account !== target.loginAccount) {
        const existing = await this.userRepo.findOne({ where: { loginAccount: account } });
        if (existing && existing.id !== target.id) {
          throw new BadRequestException('loginAccount already exists');
        }
        target.loginAccount = account;
      } else if (!account) {
        target.loginAccount = null;
      }
    }
    if (dto.name !== undefined) target.name = dto.name;
    if (dto.phone !== undefined && dto.phone !== target.phone) {
      // 改手机号同样要防撞：建档时拦住了，编辑时放过去照样能造出两条同一个人
      if (dto.phone) {
        const dup = await this.userRepo.findOne({
          where: { tenantId, phone: dto.phone, role: In(STAFF_APP_ROLES) },
        });
        if (dup && dup.id !== target.id) {
          const label = USER_ROLE_LABELS[dup.role] ?? dup.role;
          throw new BadRequestException(
            `手机号 ${maskPhone(dto.phone)} 已被员工账号「${dup.name || '未填姓名'}（${label}）」占用`,
          );
        }
      }
      target.phone = dto.phone;
    }
    const previousRole = target.role;
    if (nextRole) target.role = nextRole;
    if (dto.status !== undefined) target.status = dto.status;
    if (dto.password) target.passwordHash = await bcrypt.hash(dto.password, 10);
    target.updatedBy = user.id;
    await this.userRepo.save(target);

    let profile = await this.profileRepo.findOne({
      where: { tenantId, userId: id },
    });
    if (dto.skills !== undefined || dto.zones !== undefined) {
      if (!profile) {
        profile = this.profileRepo.create({
          tenantId,
          userId: id,
          skills: dto.skills ?? [],
          zones: (dto.zones ?? []).map(String),
          onDuty: true,
          createdBy: user.id,
          updatedBy: user.id,
        });
      } else {
        if (dto.skills !== undefined) profile.skills = dto.skills;
        if (dto.zones !== undefined) profile.zones = dto.zones.map(String);
        profile.updatedBy = user.id;
      }
      profile = await this.profileRepo.save(profile);
    }

    // 身份从代报角色改走（保安转岗成维修工）时，代报授权要一并收回 ——
    // 留着的话他哪天再被改回保安，几个月前的授权原地复活，没人记得授过
    if (!isReporter(target.role) && previousRole !== target.role) {
      await this.reportGrantRepo.delete({ tenantId, userId: id });
    }
    const communityIds = isReporter(target.role)
      ? dto.reportCommunityIds !== undefined
        ? await this.replaceReportGrants(tenantId, id, dto.reportCommunityIds, user.id)
        : (await this.reportGrantRepo.find({ where: { tenantId, userId: id } })).map(
            (g) => g.communityId,
          )
      : [];

    const roles =
      dto.roleIds !== undefined
        ? await this.replaceRoleBindings(tenantId, id, dto.roleIds, user.id)
        : (await this.loadRolesByUser(tenantId, [id])).get(id) ?? [];

    return this.toView(target, profile ?? null, communityIds, roles);
  }

  /**
   * 整份覆盖代报授权。先删后插而不是增量对比：授权就几条，
   * 增量逻辑写错会留下收不回的权限，代价比多一次删除大得多。
   */
  private async replaceReportGrants(
    tenantId: number,
    userId: number,
    communityIds: number[],
    operatorId: number,
  ): Promise<number[]> {
    const unique = Array.from(new Set(communityIds.filter((id) => Number.isFinite(id))));
    await this.reportGrantRepo.delete({ tenantId, userId });
    if (unique.length) {
      await this.reportGrantRepo.save(
        unique.map((communityId) =>
          this.reportGrantRepo.create({
            tenantId,
            userId,
            communityId,
            createdBy: operatorId,
            updatedBy: operatorId,
          }),
        ),
      );
    }
    return unique;
  }

  /** 解绑员工端微信：员工换手机/换微信或离职后由管理员操作 */
  async unbindWx(id: number, user: AuthUser, access: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    const target = await this.userRepo.findOne({ where: { id, tenantId } });
    if (!target) throw new NotFoundException('staff not found');
    if (!ASSIGNABLE_ROLES.includes(target.role)) {
      throw new BadRequestException('cannot edit this user via /staff');
    }
    await this.guardManageable(target, access);
    if (!target.wxOpenid && !target.wxUnionid) {
      throw new BadRequestException('该员工尚未绑定微信');
    }
    target.wxOpenid = null;
    target.wxUnionid = null;
    target.updatedBy = user.id;
    await this.userRepo.save(target);

    const profile = await this.profileRepo.findOne({ where: { tenantId, userId: id } });
    const roles = (await this.loadRolesByUser(tenantId, [id])).get(id) ?? [];
    return this.toView(target, profile ?? null, [], roles);
  }

  private toView(
    user: User,
    profile: StaffProfile | null,
    reportCommunityIds: number[] = [],
    roles: { id: number; name: string; builtIn: boolean; businessRole: string | null }[] = [],
  ) {
    return {
      id: user.id,
      tenantId: user.tenantId,
      name: user.name,
      phone: user.phone,
      role: user.role,
      loginAccount: user.loginAccount,
      status: user.status,
      wxBound: !!user.wxOpenid,
      skills: profile?.skills ?? [],
      zones: profile?.zones ?? [],
      onDuty: profile?.onDuty ?? true,
      isReporter: isReporter(user.role),
      reportCommunityIds,
      roles,
      roleIds: roles.map((r) => r.id),
    };
  }

  private async loadRolesByUser(tenantId: number, userIds: number[]) {
    const map = new Map<
      number,
      { id: number; name: string; builtIn: boolean; businessRole: string | null }[]
    >();
    if (!userIds.length) return map;
    const bindings = await this.userRoleRepo.find({
      where: { tenantId, userId: In(userIds) },
    });
    if (!bindings.length) return map;
    const roles = await this.roleRepo.find({
      where: { id: In([...new Set(bindings.map((b) => b.roleId))]) },
    });
    const roleById = new Map(roles.map((r) => [r.id, r]));
    for (const b of bindings) {
      const role = roleById.get(b.roleId);
      if (!role) continue;
      const list = map.get(b.userId) ?? [];
      list.push({
        id: role.id,
        name: role.name,
        builtIn: role.builtIn,
        businessRole: role.businessRole,
      });
      map.set(b.userId, list);
    }
    return map;
  }

  /**
   * 从所选角色里解析业务身份。
   *
   * 合并后「角色」自带业务身份（roles.business_role），用户管理页因此只剩一个下拉。
   * 一个人只绑得到一个带身份的角色（保存前 assertSingleIdentity 已拦），
   * 只绑纯权限角色时返回 null，由调用方保持原身份不变。
   */
  private async resolveIdentity(
    tenantId: number,
    roleIds?: number[],
  ): Promise<UserRole | null> {
    if (!roleIds?.length) return null;
    const roles = await this.roleRepo.find({
      where: { id: In([...new Set(roleIds)]), tenantId },
    });
    const identity = roles.map((r) => r.businessRole).find((v) => !!v);
    if (!identity) return null;
    if (!ASSIGNABLE_ROLES.includes(identity as UserRole)) {
      throw new BadRequestException(`角色绑定的业务身份「${identity}」不可用`);
    }
    return identity as UserRole;
  }

  /** 整份覆盖后台角色绑定，返回绑定后的角色摘要 */
  private async replaceRoleBindings(
    tenantId: number,
    userId: number,
    roleIds: number[],
    operatorId: number,
  ) {
    const unique = [...new Set(roleIds.filter((id) => Number.isFinite(id)))];
    await this.userRoleRepo.delete({ tenantId, userId });
    if (unique.length) {
      await this.userRoleRepo.save(
        unique.map((roleId) =>
          this.userRoleRepo.create({
            tenantId,
            userId,
            roleId,
            createdBy: operatorId,
            updatedBy: operatorId,
          }),
        ),
      );
    }
    return (await this.loadRolesByUser(tenantId, [userId])).get(userId) ?? [];
  }

  /** 业务身份 admin 即企业超管，只有企业超管/平台能开 */
  private guardAdminIdentity(role: UserRole, access: ResolvedAccess) {
    if (role === UserRole.ADMIN && !access.isTenantAdmin && !access.isPlatformAdmin) {
      throw new ForbiddenException('只有企业超级管理员可以开通管理员账号');
    }
  }

  /**
   * 受限操作者（数据范围非全公司）不能动超出范围的用户：
   * 目标是企业超管（业务身份 admin 或绑了内置角色）、或目标绑定的角色
   * 范围超出操作者范围时拒绝。
   */
  private async guardManageable(target: User, access: ResolvedAccess) {
    if (access.isPlatformAdmin || access.isTenantAdmin) return;
    if (target.role === UserRole.ADMIN || target.role === UserRole.SUPERADMIN) {
      throw new ForbiddenException('无权管理企业超级管理员账号');
    }
    if (!target.tenantId) return;
    const targetRoles = (await this.loadRolesByUser(target.tenantId, [target.id])).get(
      target.id,
    );
    if (!targetRoles?.length) return;
    if (targetRoles.some((r) => r.builtIn)) {
      throw new ForbiddenException('无权管理企业超级管理员账号');
    }
    const fullRoles = await this.roleRepo.find({
      where: { id: In(targetRoles.map((r) => r.id)) },
    });
    for (const role of fullRoles) {
      if (!(await this.rolesService.roleWithinScope(role, access))) {
        throw new ForbiddenException('该用户的角色范围超出你的管理范围');
      }
    }
  }

  /** 校验待绑定角色都在本公司、启用，且不超过操作者的可分配范围 */
  private async validateAssignableRoles(
    roleIds: number[],
    tenantId: number,
    access: ResolvedAccess,
  ) {
    const unique = [...new Set(roleIds)];
    const roles = await this.roleRepo.find({
      where: { id: In(unique), tenantId },
    });
    if (roles.length !== unique.length) {
      throw new BadRequestException('角色不存在');
    }
    if (roles.some((r) => !r.enabled)) {
      throw new BadRequestException('不能绑定已停用的角色');
    }
    const isAdmin = access.isPlatformAdmin || access.isTenantAdmin;
    if (isAdmin) return;
    for (const role of roles) {
      if (role.builtIn) {
        throw new ForbiddenException('只有企业超级管理员可以任命企业超级管理员');
      }
      if (!(await this.rolesService.roleWithinScope(role, access))) {
        throw new ForbiddenException(`角色「${role.name}」的范围超出你的管理范围`);
      }
    }
  }

  private requireTenant(user: AuthUser): number {
    if (!user.tenantId) {
      throw new ForbiddenException('tenant scope is required');
    }
    return user.tenantId;
  }
}
