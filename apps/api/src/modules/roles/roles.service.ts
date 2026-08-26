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
  ALWAYS_ENABLED_PAGES,
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
    const picked: Role[] = [];
    for (const r of roles) {
      if (isAdmin) {
        picked.push(r);
        continue;
      }
      if (r.builtIn) continue;
      if (await this.roleWithinScope(r, access)) picked.push(r);
    }
    if (!picked.length) return [];
    // 带上「这个角色都勾了什么」：用户管理据此决定要不要账号密码、
    // 要不要「可代报的小区」，不用再去猜角色的性质
    const perms = await this.permRepo.find({
      where: { roleId: In(picked.map((r) => r.id)), canView: true },
      select: ['roleId', 'pageKey'],
    });
    return picked.map((r) => {
      const keys = perms.filter((p) => p.roleId === r.id).map((p) => p.pageKey);
      return {
        ...this.toOption(r),
        // 内置角色全部页面直通，权限表里没有逐条记录
        hasAdminPages: r.builtIn || keys.some((k) => !k.startsWith('app:')),
        appPageKeys: r.builtIn ? [...STAFF_APP_PAGE_KEYS] : keys.filter((k) => k.startsWith('app:')),
      };
    });
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
    return this.dataSource.transaction(async (em) => {
      const role = await em.getRepository(Role).save(
        em.getRepository(Role).create({
          tenantId,
          name: dto.name.trim(),
          remark: dto.remark ?? null,
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
    await this.assertNoBoundUsersOnDisable(role, dto.enabled ?? role.enabled);
    return this.dataSource.transaction(async (em) => {
      role.name = dto.name.trim();
      role.remark = dto.remark ?? null;
      role.dataScope = dto.dataScope;
      if (dto.enabled !== undefined) role.enabled = dto.enabled;
      role.updatedBy = user.id;
      await em.getRepository(Role).save(role);
      await em.getRepository(RolePermission).delete({ roleId: role.id });
      await em.getRepository(RoleScope).delete({ roleId: role.id });
      await this.writePermsAndScopes(em, role, dto, user.id, access);
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

  /**
   * 停用一个还有人绑着的角色，会让这些人既进不了后台、小程序也只剩「我的」，
   * 而且后台看不出原因。和 remove() 一个口径：有人绑着就先别动。
   */
  private async assertNoBoundUsersOnDisable(role: Role, nextEnabled: boolean) {
    if (!(role.enabled && !nextEnabled)) return;
    const bound = await this.userRoleRepo.count({ where: { roleId: role.id } });
    if (!bound) return;
    throw new BadRequestException(
      `还有 ${bound} 个用户绑着这个角色，停用会让他们既进不了后台、小程序也只剩「我的」。` +
        '请先在用户管理里把这些人改到别的角色，再停用',
    );
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
      ? [
          ...ADMIN_PAGE_KEYS.filter(
            (k) => access.enabledPages!.includes(k) || ALWAYS_ENABLED_PAGES.includes(k),
          ),
          ...STAFF_APP_PAGE_KEYS,
        ]
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
