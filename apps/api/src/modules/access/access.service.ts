import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { AuthUser } from '../../common/current-user.decorator';
import { UserRole } from '../../common/enums';
import {
  ADMIN_PAGE_KEYS,
  PermissionAction,
  RoleDataScope,
} from '../../common/pages';
import {
  Community,
  ManagementOffice,
  Role,
  RolePermission,
  RoleScope,
  Tenant,
  UserRoleAssignment,
} from '../../entities';

export interface PageActions {
  view: boolean;
  edit: boolean;
  delete: boolean;
}

/**
 * 一次请求内解析出的完整访问能力，guard 解析后挂在 req.access 上，
 * controller/service 直接复用，避免同一请求重复查库。
 */
export interface ResolvedAccess {
  /** 平台 superadmin：所有公司所有页面 */
  isPlatformAdmin: boolean;
  /** 企业超管：业务身份 admin，或绑定了内置「企业超级管理员」角色 */
  isTenantAdmin: boolean;
  /** 页面 → 三档权限（已按公司可用页面裁剪） */
  pages: Record<string, PageActions>;
  /** 数据范围是否为全公司 */
  scopeAll: boolean;
  /**
   * 可见小区 id 集合（含分期子小区）。scopeAll=true 时为 null。
   * 空数组表示有账号但一个小区都没授权 —— 查询层应返回空集而不是放行。
   */
  communityIds: number[] | null;
  /** 公司可用页面（null = 全部）。角色矩阵、菜单都以此为上限 */
  enabledPages: string[] | null;
  /** 绑定的后台角色 id（企业超管/平台不填） */
  roleIds: number[];
  /**
   * 生效中的管理处视角（x-acting-office-id）。非 null 时 scopeAll 已被置为 false、
   * communityIds 已收窄为该管理处的小区集合（与本人范围求交，只窄不宽）。
   */
  actingOfficeId: number | null;
}

@Injectable()
export class AccessService {
  constructor(
    @InjectRepository(Tenant)
    private readonly tenantRepo: Repository<Tenant>,
    @InjectRepository(Role)
    private readonly roleRepo: Repository<Role>,
    @InjectRepository(RolePermission)
    private readonly rolePermRepo: Repository<RolePermission>,
    @InjectRepository(RoleScope)
    private readonly roleScopeRepo: Repository<RoleScope>,
    @InjectRepository(UserRoleAssignment)
    private readonly userRoleRepo: Repository<UserRoleAssignment>,
    @InjectRepository(Community)
    private readonly communityRepo: Repository<Community>,
    @InjectRepository(ManagementOffice)
    private readonly officeRepo: Repository<ManagementOffice>,
  ) {}

  private fullPages(keys: readonly string[]): Record<string, PageActions> {
    const pages: Record<string, PageActions> = {};
    for (const key of keys) {
      pages[key] = { view: true, edit: true, delete: true };
    }
    return pages;
  }

  async getAccess(user: AuthUser): Promise<ResolvedAccess> {
    const base = await this.resolveBaseAccess(user);
    return this.applyActingOffice(base, user);
  }

  /** 不含管理处视角收窄的本体权限（切换器的可选项就得按这个算） */
  private async resolveBaseAccess(user: AuthUser): Promise<ResolvedAccess> {
    if (user.role === UserRole.SUPERADMIN) {
      return {
        isPlatformAdmin: true,
        isTenantAdmin: false,
        pages: this.fullPages(ADMIN_PAGE_KEYS),
        scopeAll: true,
        communityIds: null,
        enabledPages: null,
        roleIds: [],
        actingOfficeId: null,
      };
    }

    const tenant = user.tenantId
      ? await this.tenantRepo.findOne({ where: { id: user.tenantId } })
      : null;
    const enabledPages = tenant?.enabledPages ?? null;
    const allowedKeys = enabledPages
      ? ADMIN_PAGE_KEYS.filter((k) => enabledPages.includes(k))
      : [...ADMIN_PAGE_KEYS];

    const asTenantAdmin = (roleIds: number[]): ResolvedAccess => ({
      isPlatformAdmin: false,
      isTenantAdmin: true,
      pages: this.fullPages(allowedKeys),
      scopeAll: true,
      communityIds: null,
      enabledPages,
      roleIds,
      actingOfficeId: null,
    });

    // 业务身份 admin 即企业超管，不看角色矩阵
    if (user.role === UserRole.ADMIN) return asTenantAdmin([]);

    const bindings = await this.userRoleRepo.find({
      where: { userId: user.id },
    });
    const roleIds = bindings.map((b) => b.roleId);
    const roles = roleIds.length
      ? await this.roleRepo.find({
          where: { id: In(roleIds), tenantId: user.tenantId ?? -1, enabled: true },
        })
      : [];

    if (roles.some((r) => r.builtIn)) {
      return asTenantAdmin(roleIds);
    }

    const pages: Record<string, PageActions> = {};
    if (roles.length) {
      const perms = await this.rolePermRepo.find({
        where: { roleId: In(roles.map((r) => r.id)) },
      });
      for (const p of perms) {
        if (!allowedKeys.includes(p.pageKey as (typeof allowedKeys)[number])) {
          continue; // 公司没开通的页面，即使角色里勾了也不生效
        }
        const merged = pages[p.pageKey] ?? {
          view: false,
          edit: false,
          delete: false,
        };
        merged.view = merged.view || p.canView;
        merged.edit = merged.edit || p.canEdit;
        merged.delete = merged.delete || p.canDelete;
        pages[p.pageKey] = merged;
      }
    }

    const scopeAll = roles.some((r) => r.dataScope === RoleDataScope.ALL);
    let communityIds: number[] | null = null;
    if (!scopeAll) {
      communityIds = await this.resolveScopeCommunityIds(
        user.tenantId,
        roles.map((r) => r.id),
      );
    }

    return {
      isPlatformAdmin: false,
      isTenantAdmin: false,
      pages,
      scopeAll,
      communityIds,
      enabledPages,
      roleIds,
      actingOfficeId: null,
    };
  }

  /**
   * 管理处视角收窄：把数据范围收到指定管理处的小区集合（含分期），
   * 与本人范围求交 —— 只窄不宽。视角无效（不属本公司、已停用、不在本人
   * 范围内的本地残留选择）时静默忽略，绝不因此把页面弄成全空。
   */
  private async applyActingOffice(
    access: ResolvedAccess,
    user: AuthUser,
  ): Promise<ResolvedAccess> {
    const officeId = user.actingOfficeId;
    if (!officeId || !user.tenantId) return access;
    const office = await this.officeRepo.findOne({
      where: { id: officeId, tenantId: user.tenantId, enabled: true },
    });
    if (!office) return access;
    const officeSet = await this.expandOfficeCommunityIds(user.tenantId, officeId);
    let narrowed: number[];
    if (access.scopeAll) {
      narrowed = officeSet; // 新建管理处还没划小区 → 如实展示空视图
    } else {
      const scope = new Set(access.communityIds ?? []);
      narrowed = officeSet.filter((id) => scope.has(id));
      if (!narrowed.length) return access;
    }
    return { ...access, scopeAll: false, communityIds: narrowed, actingOfficeId: officeId };
  }

  /** 管理处 → 其下顶层小区 + 分期子小区的完整 id 集合 */
  private async expandOfficeCommunityIds(
    tenantId: number,
    officeId: number,
  ): Promise<number[]> {
    const tops = await this.communityRepo.find({
      where: { tenantId, officeId },
      select: ['id'],
    });
    const topIds = tops.map((c) => c.id);
    if (!topIds.length) return [];
    const children = await this.communityRepo.find({
      where: { tenantId, parentId: In(topIds) },
      select: ['id'],
    });
    return [...new Set([...topIds, ...children.map((c) => c.id)])];
  }

  /**
   * 当前用户可切换的管理处（顶栏切换器的选项）：全公司范围 = 全部启用中的
   * 管理处；受限角色 = 与自己小区范围有交集的管理处。按本体权限算，
   * 不受当前已生效的视角影响（否则切进去就找不到其它选项了）。
   */
  async listVisibleOffices(
    user: AuthUser,
  ): Promise<Array<{ id: number; name: string }>> {
    if (!user.tenantId) return [];
    const offices = await this.officeRepo.find({
      where: { tenantId: user.tenantId, enabled: true },
      order: { id: 'ASC' },
    });
    if (!offices.length) return [];
    const base = await this.resolveBaseAccess(user);
    if (base.scopeAll) return offices.map((o) => ({ id: o.id, name: o.name }));
    const scope = new Set(base.communityIds ?? []);
    if (!scope.size) return [];
    const visible: Array<{ id: number; name: string }> = [];
    for (const office of offices) {
      const ids = await this.expandOfficeCommunityIds(user.tenantId, office.id);
      if (ids.some((id) => scope.has(id))) visible.push({ id: office.id, name: office.name });
    }
    return visible;
  }

  /**
   * 把角色范围明细展开成具体小区 id 集合：
   * 管理处 → 其下全部顶层小区；顶层小区 → 追加其分期子小区。
   * （roles 模块判断「角色范围是否不超过操作者范围」时也复用这份展开逻辑。）
   */
  async resolveScopeCommunityIds(
    tenantId: number | null,
    roleIds: number[],
  ): Promise<number[]> {
    if (!tenantId || !roleIds.length) return [];
    const scopes = await this.roleScopeRepo.find({
      where: { roleId: In(roleIds) },
    });
    const officeIds = [
      ...new Set(scopes.map((s) => s.officeId).filter((v): v is number => !!v)),
    ];
    const topIds = new Set(
      scopes.map((s) => s.communityId).filter((v): v is number => !!v),
    );
    if (officeIds.length) {
      const byOffice = await this.communityRepo.find({
        where: { tenantId, officeId: In(officeIds) },
        select: ['id'],
      });
      byOffice.forEach((c) => topIds.add(c.id));
    }
    if (!topIds.size) return [];
    const children = await this.communityRepo.find({
      where: { tenantId, parentId: In([...topIds]) },
      select: ['id'],
    });
    const all = new Set(topIds);
    children.forEach((c) => all.add(c.id));
    return [...all].sort((a, b) => a - b);
  }

  hasPermission(
    access: ResolvedAccess,
    pageKeys: string | string[],
    action: PermissionAction,
  ): boolean {
    if (access.isPlatformAdmin) return true;
    const keys = Array.isArray(pageKeys) ? pageKeys : [pageKeys];
    return keys.some((key) => {
      const p = access.pages[key];
      if (!p) return false;
      if (action === 'view') return p.view;
      if (action === 'edit') return p.edit;
      return p.delete;
    });
  }
}
