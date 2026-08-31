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
  DEFAULT_ROLE_TEMPLATES,
  RoleDataScope,
  STAFF_APP_PAGE_KEYS,
} from '../../common/pages';
import {
  Community,
  ManagementOffice,
  Role,
  RolePermission,
  RoleScope,
  RoleTemplate,
  RoleTemplatePermission,
  RoleWarehouse,
  Warehouse,
  User,
  UserRoleAssignment,
} from '../../entities';
import { AccessService, ResolvedAccess } from '../access/access.service';
import { SaveAsTemplateDto, SaveRoleDto, SaveRoleTemplateDto } from './dto';

@Injectable()
export class RolesService {
  constructor(
    @InjectRepository(Role)
    private readonly roleRepo: Repository<Role>,
    @InjectRepository(RolePermission)
    private readonly permRepo: Repository<RolePermission>,
    @InjectRepository(RoleTemplate)
    private readonly tplRepo: Repository<RoleTemplate>,
    @InjectRepository(RoleTemplatePermission)
    private readonly tplPermRepo: Repository<RoleTemplatePermission>,
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
    const [perms, scopes, bindings, extraWarehouses, templates] = await Promise.all([
      this.permRepo.find({ where: { roleId: In(ids) } }),
      this.scopeRepo.find({ where: { roleId: In(ids) } }),
      this.userRoleRepo.find({ where: { roleId: In(ids) } }),
      this.dataSource.getRepository(RoleWarehouse).find({ where: { roleId: In(ids) } }),
      this.tplRepo.find({ where: { tenantId } }),
    ]);
    // 跟随模板的角色，列表里也要显示模板那份权限 —— 否则「能看到什么」一列是空的，
    // 看列表的人会以为这个角色什么都没配
    const tplPerms = templates.length
      ? await this.tplPermRepo.find({ where: { templateId: In(templates.map((t) => t.id)) } })
      : [];
    const tplNameById = new Map(templates.map((t) => [t.id, t.name]));
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
      templateId: r.templateId,
      templateName: r.templateId ? tplNameById.get(r.templateId) ?? null : null,
      userCount: countByRole.get(r.id) ?? 0,
      permissions: (r.templateId
        ? tplPerms.filter((p) => p.templateId === r.templateId)
        : perms.filter((p) => p.roleId === r.id)
      ).map((p) => ({
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
      warehouseIds: extraWarehouses
        .filter((w) => w.roleId === r.id)
        .map((w) => w.warehouseId),
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
    const warehouses = await this.dataSource.getRepository(Warehouse).find({
      where: { tenantId },
      order: { id: 'ASC' },
    });
    const officeNameById = new Map(offices.map((o) => [o.id, o.name]));
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
      // 「额外可见的仓库」的可选项。带上归属，配的人才看得出哪些是总仓
      warehouses: warehouses
        .filter((w) => w.enabled)
        .map((w) => ({
          id: w.id,
          name: w.name,
          type: w.type,
          officeName: w.officeId ? officeNameById.get(w.officeId) ?? null : null,
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
    // 要不要「可代报的小区」，不用再去猜角色的性质。
    // 跟随模板的角色，勾选在模板那张表里
    const pageKeysByRole = await this.visiblePageKeysByRole(picked);
    return picked.map((r) => {
      const keys = pageKeysByRole.get(r.id) ?? [];
      return {
        ...this.toOption(r),
        // 内置角色全部页面直通，权限表里没有逐条记录
        hasAdminPages: r.builtIn || keys.some((k) => !k.startsWith('app:')),
        appPageKeys: r.builtIn ? [...STAFF_APP_PAGE_KEYS] : keys.filter((k) => k.startsWith('app:')),
      };
    });
  }

  /**
   * 每个角色「能看到哪些页面」的 key 集合。自定义角色读 role_permissions，
   * 跟随模板的角色读模板那份 —— 判断口径的唯一出处，新增用到勾选的地方直接引这里。
   */
  private async visiblePageKeysByRole(roles: Role[]): Promise<Map<number, string[]>> {
    const ownIds = roles.filter((r) => !r.templateId).map((r) => r.id);
    const tplIds = [
      ...new Set(roles.map((r) => r.templateId).filter((id): id is number => !!id)),
    ];
    const [own, tpl] = await Promise.all([
      ownIds.length
        ? this.permRepo.find({
            where: { roleId: In(ownIds), canView: true },
            select: ['roleId', 'pageKey'],
          })
        : [],
      tplIds.length
        ? this.tplPermRepo.find({
            where: { templateId: In(tplIds), canView: true },
            select: ['templateId', 'pageKey'],
          })
        : [],
    ]);
    const out = new Map<number, string[]>();
    for (const role of roles) {
      out.set(
        role.id,
        role.templateId
          ? tpl.filter((p) => p.templateId === role.templateId).map((p) => p.pageKey)
          : own.filter((p) => p.roleId === role.id).map((p) => p.pageKey),
      );
    }
    return out;
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
    const templateId = await this.resolveTemplateId(tenantId, dto.templateId);
    return this.dataSource.transaction(async (em) => {
      const role = await em.getRepository(Role).save(
        em.getRepository(Role).create({
          tenantId,
          name: dto.name.trim(),
          remark: dto.remark ?? null,
          templateId,
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
    const nextTemplateId = await this.resolveTemplateId(tenantId, dto.templateId);
    // 从「跟随模板」改回「自定义」而端上没送来勾选：把模板当前那份固化成自己的，
    // 免得一次解绑把绑这个角色的人全部挡在门外
    const fallback =
      !nextTemplateId && role.templateId && !dto.permissions?.length
        ? (
            await this.tplPermRepo.find({ where: { templateId: role.templateId } })
          ).map((p) => ({
            pageKey: p.pageKey,
            canView: p.canView,
            canEdit: p.canEdit,
            canDelete: p.canDelete,
          }))
        : null;
    return this.dataSource.transaction(async (em) => {
      role.name = dto.name.trim();
      role.remark = dto.remark ?? null;
      role.templateId = nextTemplateId;
      role.dataScope = dto.dataScope;
      if (dto.enabled !== undefined) role.enabled = dto.enabled;
      role.updatedBy = user.id;
      await em.getRepository(Role).save(role);
      await em.getRepository(RolePermission).delete({ roleId: role.id });
      await em.getRepository(RoleScope).delete({ roleId: role.id });
      await em.getRepository(RoleWarehouse).delete({ roleId: role.id });
      await this.writePermsAndScopes(
        em,
        role,
        fallback ? { ...dto, permissions: fallback } : dto,
        user.id,
        access,
      );
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
      await em.getRepository(RoleWarehouse).delete({ roleId: id });
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
    // 跟随模板的角色不存自己的权限：权限只有模板那一份出处，
    // 这里再存一份就会出现「改了模板没生效」这种查不出来的鬼故事
    const byPage = role.templateId
      ? new Map<string, { canView: boolean; canEdit: boolean; canDelete: boolean }>()
      : this.normalizePermissions(dto.permissions, access);
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

    // 额外可见的仓库：和数据范围无关，全公司范围的角色也能配（配了也不多给，它本来就全看得到）
    const warehouseIds = [...new Set(dto.warehouseIds ?? [])];
    if (warehouseIds.length) {
      const found = await em.getRepository(Warehouse).count({
        where: { id: In(warehouseIds), tenantId: role.tenantId },
      });
      if (found !== warehouseIds.length) throw new BadRequestException('仓库不存在');
      await em.getRepository(RoleWarehouse).save(
        warehouseIds.map((warehouseId) =>
          em.getRepository(RoleWarehouse).create({
            tenantId: role.tenantId,
            roleId: role.id,
            warehouseId,
            createdBy: operatorId,
            updatedBy: operatorId,
          }),
        ),
      );
    }
  }

  /**
   * 权限矩阵去重 + 裁剪到公司可用页面；勾了编辑/删除但没勾查看的自动补查看。
   * 员工端入口（app:*）不受 enabled_pages 裁剪，理由见 access.service。
   * 角色和权限模板共用这一份 —— 两边各写一套迟早会不一致。
   */
  private normalizePermissions(
    permissions: SaveRoleDto['permissions'],
    access: ResolvedAccess,
  ) {
    const allowed: string[] = access.enabledPages
      ? [
          ...ADMIN_PAGE_KEYS.filter(
            (k) => access.enabledPages!.includes(k) || ALWAYS_ENABLED_PAGES.includes(k),
          ),
          ...STAFF_APP_PAGE_KEYS,
        ]
      : [...ALL_PAGE_KEYS];
    const byPage = new Map<
      string,
      { canView: boolean; canEdit: boolean; canDelete: boolean }
    >();
    for (const p of permissions ?? []) {
      if (!allowed.includes(p.pageKey)) continue;
      const canEdit = p.canEdit;
      const canDelete = p.canDelete;
      const canView = p.canView || canEdit || canDelete;
      if (!canView) continue;
      byPage.set(p.pageKey, { canView, canEdit, canDelete });
    }
    return byPage;
  }

  // ---------------- 权限模板 ----------------

  /** 传进来的 templateId 是不是本公司的模板；空值一律当「自定义」 */
  private async resolveTemplateId(
    tenantId: number,
    templateId: number | null | undefined,
  ): Promise<number | null> {
    if (!templateId) return null;
    const tpl = await this.tplRepo.findOne({ where: { id: templateId, tenantId } });
    if (!tpl) throw new BadRequestException('权限模板不存在');
    return tpl.id;
  }

  async listTemplates(user: AuthUser) {
    const tenantId = this.requireTenant(user);
    const templates = await this.tplRepo.find({
      where: { tenantId },
      order: { id: 'ASC' },
    });
    if (!templates.length) return [];
    const ids = templates.map((t) => t.id);
    const [perms, roles] = await Promise.all([
      this.tplPermRepo.find({ where: { templateId: In(ids) } }),
      this.roleRepo.find({ where: { tenantId, templateId: In(ids) } }),
    ]);
    return templates.map((t) => ({
      id: t.id,
      name: t.name,
      remark: t.remark,
      permissions: perms
        .filter((p) => p.templateId === t.id)
        .map((p) => ({
          pageKey: p.pageKey,
          canView: p.canView,
          canEdit: p.canEdit,
          canDelete: p.canDelete,
        })),
      // 有哪些角色在跟随：改模板前看得见影响面，删模板时也靠它拦下来
      roles: roles
        .filter((r) => r.templateId === t.id)
        .map((r) => ({ id: r.id, name: r.name })),
    }));
  }

  async createTemplate(dto: SaveRoleTemplateDto, user: AuthUser, access: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    this.requireRoleManager(access);
    await this.ensureTemplateNameFree(tenantId, dto.name, null);
    return this.dataSource.transaction(async (em) => {
      const tpl = await em.getRepository(RoleTemplate).save(
        em.getRepository(RoleTemplate).create({
          tenantId,
          name: dto.name.trim(),
          remark: dto.remark ?? null,
          createdBy: user.id,
          updatedBy: user.id,
        }),
      );
      await this.writeTemplatePerms(em, tpl, dto.permissions, user.id, access);
      return { id: tpl.id };
    });
  }

  /**
   * 改模板 = 改所有跟随它的角色的权限，这正是它存在的意义，所以这里不做二次确认；
   * 影响面在列表里写着（跟随的角色名），端上改之前会提示。
   */
  async updateTemplate(
    id: number,
    dto: SaveRoleTemplateDto,
    user: AuthUser,
    access: ResolvedAccess,
  ) {
    const tenantId = this.requireTenant(user);
    this.requireRoleManager(access);
    const tpl = await this.tplRepo.findOne({ where: { id, tenantId } });
    if (!tpl) throw new NotFoundException('权限模板不存在');
    await this.ensureTemplateNameFree(tenantId, dto.name, id);
    return this.dataSource.transaction(async (em) => {
      tpl.name = dto.name.trim();
      tpl.remark = dto.remark ?? null;
      tpl.updatedBy = user.id;
      await em.getRepository(RoleTemplate).save(tpl);
      await em.getRepository(RoleTemplatePermission).delete({ templateId: tpl.id });
      await this.writeTemplatePerms(em, tpl, dto.permissions, user.id, access);
      return { id: tpl.id };
    });
  }

  async removeTemplate(id: number, user: AuthUser, access: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    this.requireRoleManager(access);
    const tpl = await this.tplRepo.findOne({ where: { id, tenantId } });
    if (!tpl) throw new NotFoundException('权限模板不存在');
    const used = await this.roleRepo.find({ where: { tenantId, templateId: id } });
    if (used.length) {
      throw new BadRequestException(
        `还有 ${used.length} 个角色在跟随这个模板（${used
          .map((r) => r.name)
          .join('、')}），请先把它们改成自定义或换个模板`,
      );
    }
    await this.dataSource.transaction(async (em) => {
      await em.getRepository(RoleTemplatePermission).delete({ templateId: id });
      await em.getRepository(RoleTemplate).delete({ id });
    });
    return { ok: true };
  }

  /**
   * 把一个现成角色的勾选另存为模板，并让这个角色跟随它。
   * 权限一模一样，所以对这个角色本身没有任何变化 —— 变的是从此以后
   * 改模板它会跟着变，别的同类角色也能一勾跟上。
   */
  async saveRoleAsTemplate(
    roleId: number,
    dto: SaveAsTemplateDto,
    user: AuthUser,
    access: ResolvedAccess,
  ) {
    const tenantId = this.requireTenant(user);
    this.requireRoleManager(access);
    const role = await this.roleRepo.findOne({ where: { id: roleId, tenantId } });
    if (!role) throw new NotFoundException('角色不存在');
    if (role.builtIn) throw new BadRequestException('内置角色的权限是全通的，没什么可存成模板');
    if (role.templateId) {
      throw new BadRequestException('这个角色本来就在跟随模板，不用再存一份');
    }
    await this.ensureTemplateNameFree(tenantId, dto.name, null);
    const perms = await this.permRepo.find({ where: { roleId } });
    if (!perms.length) {
      throw new BadRequestException('这个角色一格权限都没勾，存成模板没有意义');
    }
    return this.dataSource.transaction(async (em) => {
      const tpl = await em.getRepository(RoleTemplate).save(
        em.getRepository(RoleTemplate).create({
          tenantId,
          name: dto.name.trim(),
          remark: dto.remark ?? role.remark ?? null,
          createdBy: user.id,
          updatedBy: user.id,
        }),
      );
      await this.writeTemplatePerms(
        em,
        tpl,
        perms.map((p) => ({
          pageKey: p.pageKey,
          canView: p.canView,
          canEdit: p.canEdit,
          canDelete: p.canDelete,
        })),
        user.id,
        access,
      );
      // 源角色改成跟随：权限没变，但从此只有模板一份出处
      role.templateId = tpl.id;
      role.updatedBy = user.id;
      await em.getRepository(Role).save(role);
      await em.getRepository(RolePermission).delete({ roleId });
      return { id: tpl.id };
    });
  }

  /**
   * 把代码里那几个开箱模板（维修工 / 物业办公室 / 物业经理…）导进来变成可编辑的模板行。
   * 已存在同名模板的跳过，绝不覆盖 —— 覆盖等于把人家改过的权限悄悄改回去。
   */
  async importBuiltInTemplates(user: AuthUser, access: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    this.requireRoleManager(access);
    const existing = await this.tplRepo.find({ where: { tenantId } });
    const taken = new Set(existing.map((t) => t.name));
    const created: string[] = [];
    for (const preset of DEFAULT_ROLE_TEMPLATES) {
      if (taken.has(preset.name)) continue;
      await this.dataSource.transaction(async (em) => {
        const tpl = await em.getRepository(RoleTemplate).save(
          em.getRepository(RoleTemplate).create({
            tenantId,
            name: preset.name,
            remark: preset.remark,
            createdBy: user.id,
            updatedBy: user.id,
          }),
        );
        await this.writeTemplatePerms(
          em,
          tpl,
          Object.entries({ ...preset.appPages, ...(preset.adminPages ?? {}) }).map(
            ([pageKey, level]) => ({
              pageKey,
              canView: true,
              canEdit: level === 'e',
              canDelete: false,
            }),
          ),
          user.id,
          access,
        );
      });
      created.push(preset.name);
    }
    return { created, skipped: DEFAULT_ROLE_TEMPLATES.length - created.length };
  }

  private async writeTemplatePerms(
    em: EntityManager,
    tpl: RoleTemplate,
    permissions: SaveRoleDto['permissions'],
    operatorId: number,
    access: ResolvedAccess,
  ) {
    const byPage = this.normalizePermissions(permissions, access);
    if (!byPage.size) {
      throw new BadRequestException('至少勾一个页面 —— 空模板套上去的角色什么也打不开');
    }
    await em.getRepository(RoleTemplatePermission).save(
      [...byPage.entries()].map(([pageKey, v]) =>
        em.getRepository(RoleTemplatePermission).create({
          tenantId: tpl.tenantId,
          templateId: tpl.id,
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

  private async ensureTemplateNameFree(
    tenantId: number,
    name: string,
    selfId: number | null,
  ) {
    const existing = await this.tplRepo.findOne({
      where: { tenantId, name: name.trim() },
    });
    if (existing && existing.id !== selfId) {
      throw new BadRequestException('模板名已存在');
    }
  }

  private requireTenant(user: AuthUser): number {
    if (!user.tenantId) {
      throw new ForbiddenException('tenant scope is required');
    }
    return user.tenantId;
  }
}
