import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import bcrypt from 'bcryptjs';
import { Brackets, In, Like, Repository } from 'typeorm';
import { AuthUser } from '../../common/current-user.decorator';
import { nameToInitials } from '../../common/pinyin-initials';
import {
  generatePassword,
  normalizeAccountBase,
  pickAvailableAccount,
} from './credentials.util';
import {
  ASSIGNABLE_STAFF_ROLES,
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
import { AccessService, ResolvedAccess } from '../access/access.service';
import { RolesService } from '../roles/roles.service';
import {
  CreateStaffDto,
  ListStaffQueryDto,
  SuggestCredentialsDto,
  UpdateStaffDto,
} from './dto';

// 名单只此一份（common/enums.ts）：这里和 dto.ts、角色表 business_role 的取值域
// 必须是同一份，否则会出现「后台能选、保存报 invalid role」这种自相矛盾
const ASSIGNABLE_ROLES = ASSIGNABLE_STAFF_ROLES;

/**
 * 「只替住户报修的人」—— 保安、居委会那一类。
 * 判据是他的角色：看不到工单池也看不到派单台，就说明他只是个报修入口。
 * 这也决定了报修位置受不受「可代报小区」限制（见 repairs.service 的 isSelfScoped）。
 */
const reporterOnly = (roles: { pageKeys: string[] }[]) =>
  !roles.some((r) =>
    r.pageKeys.some((k) => k === 'app:pool' || k === 'app:dispatch' || k === 'work-orders'),
  );

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
    private readonly accessService: AccessService,
  ) {}

  async list(query: ListStaffQueryDto, user: AuthUser, access: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    const qb = this.userRepo
      .createQueryBuilder('u')
      .where('u.tenant_id = :tenantId', { tenantId })
      .andWhere('u.role IN (:...roles)', { roles: ASSIGNABLE_ROLES })
      .orderBy('u.id', 'DESC')
      .limit(200);

    // 按业务角色筛 = 按绑定筛，不再有「身份」这一层
    if (query.roleId) {
      qb.andWhere(
        `u.id IN (SELECT ur.user_id FROM user_roles ur WHERE ur.role_id = :roleId)`,
        { roleId: query.roleId },
      );
    }

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

    let users = await qb.getMany();
    if (users.length === 0) return [];

    const rolesByUser = await this.loadRolesByUser(
      tenantId,
      users.map((item) => item.id),
    );
    if (!access.isPlatformAdmin && !access.isTenantAdmin && !access.scopeAll) {
      const roleIds = [
        ...new Set(
          users.flatMap((item) =>
            (rolesByUser.get(item.id) ?? []).map((role) => role.id),
          ),
        ),
      ];
      const roles = roleIds.length
        ? await this.roleRepo.find({ where: { tenantId, id: In(roleIds) } })
        : [];
      const visibleRoleIds = new Set<number>();
      for (const role of roles) {
        if (
          !role.builtIn &&
          (await this.rolesService.roleWithinScope(role, access))
        ) {
          visibleRoleIds.add(role.id);
        }
      }
      users = users.filter((item) => {
        const bound = rolesByUser.get(item.id) ?? [];
        return (
          bound.length > 0 &&
          bound.every((role) => visibleRoleIds.has(role.id))
        );
      });
      if (!users.length) return [];
    }

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
    }
    if (!dto.roleIds?.length) {
      throw new BadRequestException('请给这个人选一个业务角色');
    }
    // 员工统一是 staff，能干什么全看他绑的角色 —— 这里不再有「业务身份」这回事
    const role = UserRole.STAFF;

    /**
     * 账号密码一律选填（2026-09-14 Mike）。
     *
     * 以前「角色能进网站后台」就强制填一组，管理员每建一个办公室的人都得自己想账号、
     * 编一个密码。可进后台本来就有第二条路：本人在员工端小程序用手机号登录，网页扫码
     * 确认就进去了 —— 姓名 + 手机号足够他把活干起来。真需要账号密码时（换电脑、手边
     * 没有微信），再来用户管理里点「自动生成」，账号按姓名拼音首字母、重名加 01/02。
     *
     * 但**不许只给一半**：只有账号没有密码同样登不进去，还让人以为配好了。
     */
    if (dto.loginAccount && !dto.password) {
      throw new BadRequestException('设了登录账号就要一起设密码，否则他还是登不进去');
    }
    if (dto.password && !dto.loginAccount) {
      throw new BadRequestException('设了密码就要一起设登录账号，否则他不知道用什么登录');
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
    if (dto.skills?.length || dto.zones?.length) {
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

    // 「可代报的小区」对谁都能配：只对没有工单池/派单台权限的人真正起限制作用
    const communityIds = dto.reportCommunityIds?.length
      ? await this.replaceReportGrants(tenantId, created.id, dto.reportCommunityIds, user.id)
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

    if (dto.roleIds !== undefined && dto.roleIds.length) {
      await this.validateAssignableRoles(dto.roleIds, tenantId, access);
    }

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

    if (dto.status !== undefined) target.status = dto.status;
    /**
     * 只设密码、却没有登录账号 = 白设一个他用不上的密码。
     * 这里看的是**改完之后**的状态：上面刚把账号清空的情况也要拦住。
     */
    if (dto.password && !target.loginAccount) {
      throw new BadRequestException('这个人还没有登录账号，先设账号再设密码');
    }
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

    const communityIds =
      dto.reportCommunityIds !== undefined
        ? await this.replaceReportGrants(tenantId, id, dto.reportCommunityIds, user.id)
        : (await this.reportGrantRepo.find({ where: { tenantId, userId: id } })).map(
            (g) => g.communityId,
          );

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
    roles: { id: number; name: string; builtIn: boolean }[] = [],
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
      reportCommunityIds,
      roles,
      roleIds: roles.map((r) => r.id),
    };
  }

  private async loadRolesByUser(tenantId: number, userIds: number[]) {
    const map = new Map<
      number,
      { id: number; name: string; builtIn: boolean }[]
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
      });
      map.set(b.userId, list);
    }
    return map;
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

  /**
   * 给这个人拟一组登录账号和初始密码，**只返回建议、不落库** ——
   * 管理员看一眼、需要的话还能改，点保存才算数。
   *
   * 账号 = 姓名拼音首字母，重名依次加 01、02（口径见 credentials.util）。
   * 重名要在**全库**范围内查：login_account 的唯一性本来就不分公司，
   * 只在本公司里查的话，建出来的账号保存时才撞上，等于没帮上忙。
   */
  async suggestCredentials(dto: SuggestCredentialsDto, user: AuthUser) {
    this.requireTenant(user);
    const base = normalizeAccountBase(nameToInitials(dto.name));
    const rows = await this.userRepo.find({
      where: { loginAccount: Like(`${base}%`) },
      select: ['id', 'loginAccount'],
    });
    const taken = rows
      .filter((row) => row.id !== dto.excludeUserId)
      .map((row) => row.loginAccount ?? '');
    return {
      loginAccount: pickAvailableAccount(base, taken),
      password: generatePassword(),
    };
  }

  /**
   * 受限操作者（数据范围非全公司）不能动超出范围的用户：
   * 目标绑了内置角色（企业超管）、或目标绑定的角色范围超出操作者范围时拒绝。
   */
  private async guardManageable(target: User, access: ResolvedAccess) {
    if (access.isPlatformAdmin || access.isTenantAdmin) return;
    if (target.role === UserRole.SUPERADMIN) {
      throw new ForbiddenException('无权管理平台账号');
    }
    if (!target.tenantId) return;
    const targetRoles = (await this.loadRolesByUser(target.tenantId, [target.id])).get(
      target.id,
    );
    if (!targetRoles?.length) {
      throw new ForbiddenException('该用户没有可判断归属的数据范围');
    }
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
