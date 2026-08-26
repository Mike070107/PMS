import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Repository } from 'typeorm';
import { AuthUser } from '../../common/current-user.decorator';
import { ASSIGNABLE_STAFF_ROLES, UserRole } from '../../common/enums';
import {
  ADMIN_PAGE_KEYS,
  ALL_PAGE_KEYS,
  RoleDataScope,
  STAFF_APP_PAGE_KEYS,
} from '../../common/pages';
import {
  Community,
  ManagementOffice,
  Role,
  RolePermission,
  RoleScope,
  User,
  UserRoleAssignment,
} from '../../entities';
import { AccessService, ResolvedAccess } from '../access/access.service';
import { SaveRoleDto } from './dto';

@Injectable()
export class RolesService {
  constructor(
    @InjectRepository(Role)
    private readonly roleRepo: Repository<Role>,
    @InjectRepository(RolePermission)
    private readonly permRepo: Repository<RolePermission>,
    @InjectRepository(RoleScope)
    private readonly scopeRepo: Repository<RoleScope>,
    @InjectRepository(UserRoleAssignment)
    private readonly userRoleRepo: Repository<UserRoleAssignment>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(ManagementOffice)
    private readonly officeRepo: Repository<ManagementOffice>,
    @InjectRepository(Community)
    private readonly communityRepo: Repository<Community>,
    private readonly accessService: AccessService,
    private readonly dataSource: DataSource,
  ) {}

  async list(user: AuthUser) {
    const tenantId = this.requireTenant(user);
    const roles = await this.roleRepo.find({
      where: { tenantId },
      order: { builtIn: 'DESC', id: 'ASC' },
    });
    if (!roles.length) return [];
    const ids = roles.map((r) => r.id);
    const [perms, scopes, bindings] = await Promise.all([
      this.permRepo.find({ where: { roleId: In(ids) } }),
      this.scopeRepo.find({ where: { roleId: In(ids) } }),
      this.userRoleRepo.find({ where: { roleId: In(ids) } }),
    ]);
    const countByRole = new Map<number, number>();
    bindings.forEach((b) =>
      countByRole.set(b.roleId, (countByRole.get(b.roleId) ?? 0) + 1),
    );
    return roles.map((r) => ({
      id: r.id,
      name: r.name,
      remark: r.remark,
      businessRole: r.businessRole,
      dataScope: r.dataScope,
      builtIn: r.builtIn,
      enabled: r.enabled,
      userCount: countByRole.get(r.id) ?? 0,
      permissions: perms
        .filter((p) => p.roleId === r.id)
        .map((p) => ({
          pageKey: p.pageKey,
          canView: p.canView,
          canEdit: p.canEdit,
          canDelete: p.canDelete,
        })),
      officeIds: scopes
        .filter((s) => s.roleId === r.id && s.officeId)
        .map((s) => s.officeId as number),
      communityIds: scopes
        .filter((s) => s.roleId === r.id && s.communityId)
        .map((s) => s.communityId as number),
    }));
  }

  /** 角色编辑页的数据范围可选项：管理处 + 顶层小区（标注归属管理处） */
  async scopeOptions(user: AuthUser) {
    const tenantId = this.requireTenant(user);
    const [offices, tops] = await Promise.all([
      this.officeRepo.find({ where: { tenantId }, order: { id: 'ASC' } }),
      this.communityRepo
        .createQueryBuilder('c')
        .where('c.tenant_id = :tenantId', { tenantId })
        .andWhere('c.parent_id IS NULL')
        .orderBy('c.id', 'ASC')
        .getMany(),
    ]);
    return {
      offices: offices.map((o) => ({
        id: o.id,
        name: o.name,
        enabled: o.enabled,
      })),
      communities: tops.map((c) => ({
        id: c.id,
        name: c.name,
        officeId: c.officeId,
      })),
    };
  }

  /**
   * 用户管理页可分配的角色。
   * 企业超管：全部启用角色（含内置，用来任命其他企业超管）。
   * 受限操作者：非内置、启用、且数据范围不超过自己的角色。
   */
  async assignable(user: AuthUser, access: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    const roles = await this.roleRepo.find({
      where: { tenantId, enabled: true },
      order: { builtIn: 'DESC', id: 'ASC' },
    });
    const isAdmin = access.isPlatformAdmin || access.isTenantAdmin;
    const result: { id: number; name: string; builtIn: boolean; dataScope: string }[] = [];
    for (const r of roles) {
      if (isAdmin) {
        result.push(this.toOption(r));
        continue;
      }
      if (r.builtIn) continue;
      if (await this.roleWithinScope(r, access)) result.push(this.toOption(r));
    }
    return result;
  }

  /** 角色的数据范围是否不超过操作者的范围 */
  async roleWithinScope(role: Role, access: ResolvedAccess): Promise<boolean> {
    if (access.scopeAll) return true;
    if (role.dataScope === RoleDataScope.ALL) return false;
    const roleCommunityIds = await this.accessService.resolveScopeCommunityIds(
      role.tenantId,
      [role.id],
    );
    const mine = new Set(access.communityIds ?? []);
    return roleCommunityIds.every((id) => mine.has(id));
  }

  async create(dto: SaveRoleDto, user: AuthUser, access: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    this.requireRoleManager(access);
    this.validateScopePayload(dto);
    await this.ensureNameFree(tenantId, dto.name);
    const businessRole = this.normalizeBusinessRole(dto.businessRole);
    return this.dataSource.transaction(async (em) => {
      const role = await em.getRepository(Role).save(
        em.getRepository(Role).create({
          tenantId,
          name: dto.name.trim(),
          remark: dto.remark ?? null,
          businessRole,
          dataScope: dto.dataScope,
          builtIn: false,
          enabled: dto.enabled ?? true,
          createdBy: user.id,
          updatedBy: user.id,
        }),
      );
      await this.writePermsAndScopes(em, role, dto, user.id, access);
      return { id: role.id };
    });
  }

  async update(id: number, dto: SaveRoleDto, user: AuthUser, access: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    this.requireRoleManager(access);
    const role = await this.roleRepo.findOne({ where: { id, tenantId } });
    if (!role) throw new NotFoundException('角色不存在');
    if (role.builtIn) {
      throw new BadRequestException('内置角色不可修改');
    }
    this.validateScopePayload(dto);
    if (dto.name.trim() !== role.name) {
      await this.ensureNameFree(tenantId, dto.name);
    }
    const businessRole = this.normalizeBusinessRole(dto.businessRole);
    await this.assertNoBoundUsersOnIdentityChange(
      role,
      businessRole,
      dto.enabled ?? role.enabled,
    );
    const businessRoleChanged = businessRole !== role.businessRole;
    return this.dataSource.transaction(async (em) => {
      role.name = dto.name.trim();
      role.remark = dto.remark ?? null;
      role.businessRole = businessRole;
      role.dataScope = dto.dataScope;
      if (dto.enabled !== undefined) role.enabled = dto.enabled;
      role.updatedBy = user.id;
      await em.getRepository(Role).save(role);
      await em.getRepository(RolePermission).delete({ roleId: role.id });
      await em.getRepository(RoleScope).delete({ roleId: role.id });
      await this.writePermsAndScopes(em, role, dto, user.id, access);
      // 改了业务身份就得把已绑的人一起改过来 —— 否则后台显示「维修工」、
      // 小程序里他还是按办公室那套渲染，正是合并前最招骂的那个现象
      if (businessRoleChanged) {
        const bound = await em
          .getRepository(UserRoleAssignment)
          .find({ where: { roleId: role.id }, select: ['userId'] });
        await this.syncBusinessRole(
          em,
          tenantId,
          bound.map((b) => b.userId),
          user.id,
        );
      }
      return { id: role.id };
    });
  }

  async remove(id: number, user: AuthUser, access: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    this.requireRoleManager(access);
    const role = await this.roleRepo.findOne({ where: { id, tenantId } });
    if (!role) throw new NotFoundException('角色不存在');
    if (role.builtIn) throw new BadRequestException('内置角色不可删除');
    const bound = await this.userRoleRepo.count({ where: { roleId: id } });
    if (bound > 0) {
      throw new BadRequestException(
        `仍有 ${bound} 个用户绑定该角色，请先在用户管理里解绑`,
      );
    }
    await this.dataSource.transaction(async (em) => {
      await em.getRepository(RolePermission).delete({ roleId: id });
      await em.getRepository(RoleScope).delete({ roleId: id });
      await em.getRepository(Role).delete({ id });
    });
    return { ok: true };
  }

  private toOption(r: Role) {
    return {
      id: r.id,
      name: r.name,
      builtIn: r.builtIn,
      dataScope: r.dataScope,
      businessRole: r.businessRole,
    };
  }

  /** 一期约定：只有企业超管（或平台）能建/改/删角色 */
  private requireRoleManager(access: ResolvedAccess) {
    if (!access.isPlatformAdmin && !access.isTenantAdmin) {
      throw new ForbiddenException('只有企业超级管理员可以管理角色');
    }
  }

  private validateScopePayload(dto: SaveRoleDto) {
    if (dto.dataScope === RoleDataScope.OFFICES && !dto.officeIds?.length) {
      throw new BadRequestException('数据范围为指定管理处时必须选择管理处');
    }
    if (dto.dataScope === RoleDataScope.COMMUNITIES && !dto.communityIds?.length) {
      throw new BadRequestException('数据范围为指定小区时必须选择小区');
    }
  }

  private normalizeBusinessRole(value?: string | null): string | null {
    if (!value) return null;
    if (!ASSIGNABLE_STAFF_ROLES.includes(value as UserRole)) {
      throw new BadRequestException('业务身份不可用');
    }
    return value;
  }

  /**
   * 改身份、停用，都会让已绑这个角色的人「后台显示的和实际能干的」对不上：
   * users.role 是绑角色时写下的派生列，这里改角色不会去改它。
   * 所以只要还有人绑着，就不许动 —— 和 remove() 一个口径（那边也是有人绑就不让删）。
   *
   * 同一个身份可以有多个角色（各管理处各有各的「维修工」），不做唯一限制；
   * 真正必须唯一的是「一个人只能绑一个带身份的角色」，那条在保存用户时校验。
   */
  private async assertNoBoundUsersOnIdentityChange(
    role: Role,
    nextBusinessRole: string | null,
    nextEnabled: boolean,
  ) {
    const identityChanged = nextBusinessRole !== role.businessRole;
    const beingDisabled = role.enabled && !nextEnabled;
    if (!identityChanged && !beingDisabled) return;
    const bound = await this.userRoleRepo.count({ where: { roleId: role.id } });
    if (!bound) return;
    throw new BadRequestException(
      identityChanged
        ? `还有 ${bound} 个用户绑着这个角色，改「角色类型」会让他们在小程序和后台对不上。` +
          '请先在用户管理里把这些人改到别的角色，再回来改类型'
        : `还有 ${bound} 个用户绑着这个角色，停用会让他们既进不了后台、小程序也只剩「我的」。` +
          '请先在用户管理里把这些人改到别的角色，再停用',
    );
  }

  /**
   * 按用户当前绑定的角色，回写 users.role（业务身份的唯一写入口）。
   *
   * users.role 合并后是派生列：谁都不该再手工设它 —— @Roles、jwt payload、
   * 小程序登录跳转、SELF_SCOPED_ROLES 的数据隔离全读这一列，手工设和角色绑定
   * 一旦对不上，就会出现「后台看是维修工、端上还是办公室」。
   *
   * 一个人只绑得到一个带 business_role 的角色（保存时已校验），所以这里取到什么就是什么；
   * 一个都没绑（存量、或只绑了纯权限角色）时保持原值不动，不把人的身份洗成空。
   */
  async syncBusinessRole(
    em: EntityManager,
    tenantId: number,
    userIds: number[],
    operatorId: number,
  ) {
    if (!userIds.length) return;
    const bindings = await em
      .getRepository(UserRoleAssignment)
      .find({ where: { tenantId, userId: In(userIds) } });
    const roleIds = [...new Set(bindings.map((b) => b.roleId))];
    if (!roleIds.length) return;
    const roles = await em
      .getRepository(Role)
      .find({ where: { id: In(roleIds), tenantId } });
    const businessByRole = new Map(roles.map((r) => [r.id, r.businessRole]));
    for (const userId of userIds) {
      const identity = bindings
        .filter((b) => b.userId === userId)
        .map((b) => businessByRole.get(b.roleId))
        .find((v) => !!v);
      if (!identity) continue;
      await em
        .getRepository(User)
        .update({ id: userId, tenantId }, { role: identity as UserRole, updatedBy: operatorId });
    }
  }

  /** 保存用户绑定前的校验：不能同时绑两个带业务身份的角色 */
  async assertSingleIdentity(tenantId: number, roleIds: number[]) {
    if (roleIds.length < 2) return;
    const roles = await this.roleRepo.find({ where: { id: In(roleIds), tenantId } });
    const identities = roles.filter((r) => r.businessRole);
    if (identities.length > 1) {
      throw new BadRequestException(
        `一个人只能有一个业务身份，这里选了 ${identities
          .map((r) => r.name)
          .join('、')}；其余请选纯后台角色`,
      );
    }
  }

  private async ensureNameFree(tenantId: number, name: string) {
    const existing = await this.roleRepo.findOne({
      where: { tenantId, name: name.trim() },
    });
    if (existing) throw new BadRequestException('角色名已存在');
  }

  private async writePermsAndScopes(
    em: EntityManager,
    role: Role,
    dto: SaveRoleDto,
    operatorId: number,
    access: ResolvedAccess,
  ) {
    // 权限矩阵去重 + 裁剪到公司可用页面；勾了编辑/删除但没勾查看的自动补查看。
    // 员工端入口（app:*）不受 enabled_pages 裁剪，理由见 access.service。
    const allowed: string[] = access.enabledPages
      ? [...ADMIN_PAGE_KEYS.filter((k) => access.enabledPages!.includes(k)), ...STAFF_APP_PAGE_KEYS]
      : [...ALL_PAGE_KEYS];
    const byPage = new Map<string, { canView: boolean; canEdit: boolean; canDelete: boolean }>();
    for (const p of dto.permissions) {
      if (!allowed.includes(p.pageKey)) continue;
      const canEdit = p.canEdit;
      const canDelete = p.canDelete;
      const canView = p.canView || canEdit || canDelete;
      if (!canView) continue;
      byPage.set(p.pageKey, { canView, canEdit, canDelete });
    }
    if (byPage.size) {
      await em.getRepository(RolePermission).save(
        [...byPage.entries()].map(([pageKey, v]) =>
          em.getRepository(RolePermission).create({
            tenantId: role.tenantId,
            roleId: role.id,
            pageKey,
            canView: v.canView,
            canEdit: v.canEdit,
            canDelete: v.canDelete,
            createdBy: operatorId,
            updatedBy: operatorId,
          }),
        ),
      );
    }

    if (role.dataScope === RoleDataScope.OFFICES) {
      const ids = [...new Set(dto.officeIds ?? [])];
      const found = await em.getRepository(ManagementOffice).count({
        where: { id: In(ids), tenantId: role.tenantId },
      });
      if (found !== ids.length) throw new BadRequestException('管理处不存在');
      await em.getRepository(RoleScope).save(
        ids.map((officeId) =>
          em.getRepository(RoleScope).create({
            tenantId: role.tenantId,
            roleId: role.id,
            officeId,
            communityId: null,
            createdBy: operatorId,
            updatedBy: operatorId,
          }),
        ),
      );
    } else if (role.dataScope === RoleDataScope.COMMUNITIES) {
      const ids = [...new Set(dto.communityIds ?? [])];
      const found = await em.getRepository(Community).find({
        where: { id: In(ids), tenantId: role.tenantId },
        select: ['id', 'parentId'],
      });
      if (found.length !== ids.length) throw new BadRequestException('小区不存在');
      if (found.some((c) => c.parentId !== null)) {
        throw new BadRequestException('数据范围请选择顶层小区（分期会自动包含）');
      }
      await em.getRepository(RoleScope).save(
        ids.map((communityId) =>
          em.getRepository(RoleScope).create({
            tenantId: role.tenantId,
            roleId: role.id,
            officeId: null,
            communityId,
            createdBy: operatorId,
            updatedBy: operatorId,
          }),
        ),
      );
    }
  }

  private requireTenant(user: AuthUser): number {
    if (!user.tenantId) {
      throw new ForbiddenException('tenant scope is required');
    }
    return user.tenantId;
  }
}
