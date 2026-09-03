import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { AuthUser } from '../../common/current-user.decorator';
import { UserRole } from '../../common/enums';
import {
  ADMIN_PAGE_KEYS,
  ALL_PAGE_KEYS,
  ALWAYS_ENABLED_PAGES,
  PermissionAction,
  RoleDataScope,
  STAFF_APP_PAGE_KEYS,
  isStaffAppPageKey,
} from '../../common/pages';
import {
  Community,
  ManagementOffice,
  Role,
  RolePermission,
  RoleScope,
  RoleTemplatePermission,
  RoleWarehouse,
  StaffProfile,
  Tenant,
  UserRoleAssignment,
  Warehouse,
} from '../../entities';
import {
  findSmartRepairWarehouse,
  hasSmartRepairSkill,
} from '../../common/warehouse-preference';

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
export class AccessService implements OnModuleInit {
  private readonly logger = new Logger(AccessService.name);

  constructor(
    @InjectRepository(Tenant)
    private readonly tenantRepo: Repository<Tenant>,
    @InjectRepository(Role)
    private readonly roleRepo: Repository<Role>,
    @InjectRepository(RolePermission)
    private readonly rolePermRepo: Repository<RolePermission>,
    @InjectRepository(RoleTemplatePermission)
    private readonly tplPermRepo: Repository<RoleTemplatePermission>,
    @InjectRepository(RoleScope)
    private readonly roleScopeRepo: Repository<RoleScope>,
    @InjectRepository(RoleWarehouse)
    private readonly roleWarehouseRepo: Repository<RoleWarehouse>,
    @InjectRepository(UserRoleAssignment)
    private readonly userRoleRepo: Repository<UserRoleAssignment>,
    @InjectRepository(Community)
    private readonly communityRepo: Repository<Community>,
    @InjectRepository(ManagementOffice)
    private readonly officeRepo: Repository<ManagementOffice>,
    @InjectRepository(StaffProfile)
    private readonly staffProfileRepo: Repository<StaffProfile>,
    @InjectRepository(Warehouse)
    private readonly warehouseRepo: Repository<Warehouse>,
  ) {}

  /**
   * 新拆出来的权限格要给老公司补一份，**不能只加进内置模板就完事**。
   *
   * 内置模板只在公司第一次建号时种一次（tenants.rbac_seeded_at），之后往
   * DEFAULT_ROLE_TEMPLATES 里加什么都不会再落库；线上 DB_SYNCHRONIZE=true、
   * migrations 表根本不存在，写在 migration 里的 INSERT 也一句都不跑。
   * 2026-09-01 就是这么翻的车：加了「材料 SKU 库」这一格，办公室角色（跟模板 3）
   * 在小程序上一个新 tab 都没多出来，因为库里既没有角色行也没有模板行。
   *
   * 所以在这里做幂等补齐。已经有目标权限行的（管理员自己配置过的）一概不动：
   * - app:inventory → app:materials：原来同一页里的材料档案入口拆成独立页；
   * - app:my-orders → app:my-repairs：原来的「在手工单 / 我的报修」拆成两格。
   */
  async onModuleInit() {
    const SQL = (
      table: string,
      owner: string,
      sourceKey: string,
      targetKey: string,
      copyEdit: boolean,
    ) => `
      INSERT INTO ${table} (tenant_id, ${owner}, page_key, can_view, can_edit, can_delete, created_at, updated_at)
      SELECT src.tenant_id, src.${owner}, '${targetKey}', src.can_view, ${copyEdit ? 'src.can_edit' : 'false'}, false, now(), now()
        FROM ${table} src
       WHERE src.page_key = '${sourceKey}'
         AND NOT EXISTS (
           SELECT 1 FROM ${table} dst
            WHERE dst.${owner} = src.${owner} AND dst.page_key = '${targetKey}'
         )
    `;
    try {
      const n = (r: unknown) => (Array.isArray(r) && typeof r[1] === 'number' ? r[1] : 0);
      const splits = [
        { source: 'app:inventory', target: 'app:materials', copyEdit: true },
        { source: 'app:my-orders', target: 'app:my-repairs', copyEdit: false },
        { source: 'maintenance-inspect', target: 'app:maintenance-inspect', copyEdit: false },
      ];
      for (const split of splits) {
        const role = await this.rolePermRepo.query(
          SQL('role_permissions', 'role_id', split.source, split.target, split.copyEdit),
        );
        const tpl = await this.tplPermRepo.query(
          SQL(
            'role_template_permissions',
            'template_id',
            split.source,
            split.target,
            split.copyEdit,
          ),
        );
        if (n(role) || n(tpl)) {
          this.logger.log(`补齐 ${split.target}：角色 ${n(role)} 条、模板 ${n(tpl)} 条`);
        }
      }
    } catch (e) {
      // 补不上不该拦住服务启动：大不了管理员去角色页手动勾一下
      this.logger.warn(`补齐拆分权限失败：${(e as Error).message}`);
    }
  }

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
        pages: this.fullPages(ALL_PAGE_KEYS),
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
    // tenants.enabled_pages 是「这家公司买了哪些后台功能」，只裁后台页面。
    // 员工端入口（app:*）不受它限制 —— 存量租户的 enabled_pages 里当然没有
    // 这些新 key，跟着裁会把整个小程序关掉。
    // 「系统设置」不受裁剪：订阅消息模板、自动验收时限是公司自己的配置，
    // 平台没勾它就等于整家公司（连企业超管）都配不了通知 —— 2026-08-26 实际发生过，
    // 用户找遍后台也找不到「系统设置」在哪
    const allowedKeys = enabledPages
      ? [
          ...ADMIN_PAGE_KEYS.filter((k) => enabledPages.includes(k) || ALWAYS_ENABLED_PAGES.includes(k)),
          ...STAFF_APP_PAGE_KEYS,
        ]
      : [...ALL_PAGE_KEYS];

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
      const perms = await this.effectivePermissions(roles);
      for (const p of perms) {
        if (!(allowedKeys as readonly string[]).includes(p.pageKey)) {
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
   * 这些角色加起来有没有一个「网站后台」页面。
   *
   * 「能不能登网页后台」（auth.service）和「建员工时要不要账号密码」
   * （staff.service）用的是同一个判断，所以只留这一份实现，新增入口直接引这里。
   *
   * 必须走 effectivePermissions：跟随模板的角色自己不存 role_permissions，
   * 直接查那张表会把整批「跟随模板」的角色判成没有后台权限 ——
   * 2026-08-31 实际发生过：账号绑「上海新家物业办公室」（跟随「物业办公室」模板），
   * 模板里后台页面勾得好好的，登录却被拒，界面上完全看不出原因。
   */
  async rolesGrantAdminPages(roles: Role[]): Promise<boolean> {
    if (!roles.length) return false;
    // 内置「企业超级管理员」= 全部页面，权限表里没有逐条记录
    if (roles.some((r) => r.builtIn)) return true;
    const perms = await this.effectivePermissions(roles);
    return perms.some((p) => p.canView && !isStaffAppPageKey(p.pageKey));
  }

  /**
   * 这些角色实际生效的页面权限。
   *
   * 跟随权限模板的角色（`roles.template_id` 有值）自己不存 role_permissions，
   * 权限在 role_template_permissions 里 —— 两张表字段一样，取回来按 page_key
   * 取并集即可，调用方不用关心它是哪来的。改模板立刻对所有跟随的角色生效，
   * 靠的就是这里每次请求都现读。
   */
  private async effectivePermissions(
    roles: Role[],
  ): Promise<Array<Pick<RolePermission, 'pageKey' | 'canView' | 'canEdit' | 'canDelete'>>> {
    const ownIds = roles.filter((r) => !r.templateId).map((r) => r.id);
    const templateIds = [
      ...new Set(roles.map((r) => r.templateId).filter((id): id is number => !!id)),
    ];
    const [own, fromTemplates] = await Promise.all([
      ownIds.length ? this.rolePermRepo.find({ where: { roleId: In(ownIds) } }) : [],
      templateIds.length
        ? this.tplPermRepo.find({ where: { templateId: In(templateIds) } })
        : [],
    ]);
    return [...own, ...fromTemplates];
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

  /**
   * 这个人的角色额外授权了哪些仓（role_warehouses 的并集）。
   *
   * 数据范围只能圈到管理处/小区，总仓不挂管理处 —— 「让枫桦景苑办公室用总公司
   * 那个总仓」只能靠这张表。与管理处视角正交：切了视角也照样可见，
   * 因为它是角色本身的授权，不属于任何一个管理处。
   */
  async extraWarehouseIdsOfUser(tenantId: number, userId: number): Promise<number[]> {
    const bindings = await this.userRoleRepo.find({ where: { tenantId, userId } });
    const rows = bindings.length
      ? await this.roleWarehouseRepo.find({
          where: { tenantId, roleId: In(bindings.map((b) => b.roleId)) },
        })
      : [];
    const ids = new Set(rows.map((r) => r.warehouseId));
    // 智能化维修工的专属仓由工种自动授权，不要求办公室再到每个业务角色里重复勾仓库。
    const smartWarehouseId = await this.smartWarehouseIdOfUser(tenantId, userId);
    if (smartWarehouseId) ids.add(smartWarehouseId);
    return [...ids];
  }

  /**
   * smart 工种 → 启用中的「智能化维修工仓库」。库存页默认仓与工单领料共用这一处，
   * 避免两个页面各按文字猜一次后出现不同结果。没有专属仓时返回 null，调用方沿用原规则。
   */
  async smartWarehouseIdOfUser(tenantId: number, userId: number): Promise<number | null> {
    const profile = await this.staffProfileRepo.findOne({
      where: { tenantId, userId },
      select: ['id', 'skills'],
    });
    if (!hasSmartRepairSkill(profile?.skills)) return null;
    const warehouses = await this.warehouseRepo.find({
      where: { tenantId, enabled: true },
      select: ['id', 'name', 'enabled'],
      order: { id: 'ASC' },
    });
    return findSmartRepairWarehouse(warehouses)?.id ?? null;
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

  /**
   * 「谁能做这件事」—— 按权限矩阵反查用户，替代过去的 `where role = 'technician'`。
   *
   * 派单候选人、缺料通知该发给谁、催办升级找谁，这些以前都写成按业务身份查人，
   * 于是「谁是维修工」这件事在库里有两套说法（users.role 和角色绑定），迟早对不上。
   * 现在只有一套：能不能接单 = 他绑的角色里有没有勾「工单池 · 接单」。
   */
  async userIdsWithPermission(
    tenantId: number,
    pageKey: string,
    action: PermissionAction,
  ): Promise<number[]> {
    const bindings = await this.userRoleRepo.find({ where: { tenantId } });
    if (!bindings.length) return [];
    const roleIds = [...new Set(bindings.map((row) => row.roleId))];
    const roles = await this.roleRepo.find({
      where: { tenantId, id: In(roleIds), enabled: true },
    });
    if (!roles.length) return [];

    const ownRoleIds = roles.filter((role) => !role.templateId).map((role) => role.id);
    const templateIds = [
      ...new Set(roles.map((role) => role.templateId).filter((id): id is number => !!id)),
    ];
    const [ownPermissions, templatePermissions] = await Promise.all([
      ownRoleIds.length
        ? this.rolePermRepo.find({ where: { tenantId, roleId: In(ownRoleIds), pageKey } })
        : [],
      templateIds.length
        ? this.tplPermRepo.find({ where: { tenantId, templateId: In(templateIds), pageKey } })
        : [],
    ]);
    const actionField =
      action === 'view' ? 'canView' : action === 'edit' ? 'canEdit' : 'canDelete';
    const permittedRoleIds = new Set(
      roles.filter((role) => role.builtIn).map((role) => role.id),
    );
    ownPermissions
      .filter((permission) => permission[actionField])
      .forEach((permission) => permittedRoleIds.add(permission.roleId));
    const permittedTemplateIds = new Set(
      templatePermissions
        .filter((permission) => permission[actionField])
        .map((permission) => permission.templateId),
    );
    roles
      .filter((role) => role.templateId && permittedTemplateIds.has(role.templateId))
      .forEach((role) => permittedRoleIds.add(role.id));

    return [
      ...new Set(
        bindings
          .filter((binding) => permittedRoleIds.has(binding.roleId))
          .map((binding) => binding.userId),
      ),
    ];
  }

  /** 单个人有没有这一档（派单前校验「这个人真的能接单吗」） */
  async userHasPermission(
    tenantId: number,
    userId: number,
    pageKey: string,
    action: PermissionAction,
  ): Promise<boolean> {
    const ids = await this.userIdsWithPermission(tenantId, pageKey, action);
    return ids.includes(userId);
  }

  /** 管理处 → 其下全部小区 id（含分期子小区）；工单模块按管理处匹配领料仓库用 */
  async officeCommunityIds(tenantId: number, officeId: number): Promise<number[]> {
    return this.expandOfficeCommunityIds(tenantId, officeId);
  }

  /** 小区所属管理处：分期子小区跟着顶层小区走；没挂管理处返回 null */
  async officeIdOfCommunity(tenantId: number, communityId: number): Promise<number | null> {
    const community = await this.communityRepo.findOne({
      where: { tenantId, id: communityId },
      select: ['id', 'officeId', 'parentId'],
    });
    if (!community) return null;
    if (community.officeId) return community.officeId;
    if (!community.parentId) return null;
    const parent = await this.communityRepo.findOne({
      where: { tenantId, id: community.parentId },
      select: ['id', 'officeId'],
    });
    return parent?.officeId ?? null;
  }

  /**
   * 这些人里谁的数据范围覆盖某个管理处（officeId = null 表示「全公司」）。
   * 报修类型配置选默认维修工时用：公司默认模板只能选全公司范围的人；
   * 管理处那套可以选全公司的人 + 范围含该管理处（或其下小区）的人。
   * 「总公司维修工 / 管理处维修工」就是两个数据范围不同的角色 —— 这里只看范围，不看业务身份。
   * 返回 userId → 'all'（全公司）| 'office'（只覆盖这个管理处）；没覆盖的不在 Map 里。
   */
  async filterUsersCoveringOffice(
    tenantId: number,
    userIds: number[],
    officeId: number | null,
  ): Promise<Map<number, 'all' | 'office'>> {
    const result = new Map<number, 'all' | 'office'>();
    if (!userIds.length) return result;
    const bindings = await this.userRoleRepo.find({
      where: { tenantId, userId: In(userIds) },
    });
    if (!bindings.length) return result;
    const roleIds = [...new Set(bindings.map((b) => b.roleId))];
    const roles = await this.roleRepo.find({
      where: { id: In(roleIds), tenantId, enabled: true },
    });
    const allRoleIds = new Set(
      roles
        .filter((r) => r.builtIn || r.dataScope === RoleDataScope.ALL)
        .map((r) => r.id),
    );
    const officeRoleIds = new Set<number>();
    if (officeId) {
      const scopes = await this.roleScopeRepo.find({ where: { roleId: In(roleIds) } });
      const officeCommunities = new Set(await this.expandOfficeCommunityIds(tenantId, officeId));
      for (const s of scopes) {
        if (s.officeId === officeId || (s.communityId && officeCommunities.has(s.communityId))) {
          officeRoleIds.add(s.roleId);
        }
      }
    }
    for (const b of bindings) {
      if (allRoleIds.has(b.roleId)) result.set(b.userId, 'all');
      else if (officeRoleIds.has(b.roleId) && !result.has(b.userId)) result.set(b.userId, 'office');
    }
    return result;
  }

  /**
   * 这个人「属于」哪些管理处 —— 由他绑的角色的数据范围决定，不另存字段。
   * all = 有全公司范围的角色（总公司维修工 / 办公室）；officeIds = 范围里的管理处（含由小区推出来的）。
   * 员工端库存页默认仓、工单选料兜底都按这个匹配仓库的 office_id。
   */
  async userOfficeIds(
    tenantId: number,
    userId: number,
  ): Promise<{ all: boolean; officeIds: number[] }> {
    const bindings = await this.userRoleRepo.find({ where: { tenantId, userId } });
    if (!bindings.length) return { all: false, officeIds: [] };
    const roleIds = bindings.map((b) => b.roleId);
    const roles = await this.roleRepo.find({ where: { id: In(roleIds), tenantId, enabled: true } });
    const all = roles.some((r) => r.builtIn || r.dataScope === RoleDataScope.ALL);
    const scopes = await this.roleScopeRepo.find({ where: { roleId: In(roles.map((r) => r.id)) } });
    const officeIds = new Set(scopes.map((s) => s.officeId).filter((v): v is number => !!v));
    const communityIds = scopes.map((s) => s.communityId).filter((v): v is number => !!v);
    if (communityIds.length) {
      const communities = await this.communityRepo.find({
        where: { tenantId, id: In(communityIds) },
        select: ['id', 'officeId', 'parentId'],
      });
      const parentIds = communities.filter((c) => !c.officeId && c.parentId).map((c) => c.parentId as number);
      const parents = parentIds.length
        ? await this.communityRepo.find({ where: { tenantId, id: In(parentIds) }, select: ['id', 'officeId'] })
        : [];
      for (const c of communities) {
        const oid = c.officeId ?? parents.find((p) => p.id === c.parentId)?.officeId ?? null;
        if (oid) officeIds.add(oid);
      }
    }
    return { all, officeIds: [...officeIds] };
  }

  /** 这个人绑了哪些角色（名字），给前端显示用 */
  async listRoleNames(user: AuthUser): Promise<string[]> {
    if (!user.tenantId) return [];
    const bindings = await this.userRoleRepo.find({
      where: { userId: user.id },
      select: ['roleId'],
    });
    if (!bindings.length) return [];
    const roles = await this.roleRepo.find({
      where: { id: In(bindings.map((b) => b.roleId)), tenantId: user.tenantId },
      select: ['name'],
      order: { id: 'ASC' },
    });
    return roles.map((r) => r.name);
  }

  /** 逐条判断「某个 key 上要有某个动作」，任一条命中即放行 */
  hasAnyPermission(
    access: ResolvedAccess,
    items: Array<{ pageKey: string; action: PermissionAction }>,
  ): boolean {
    if (access.isPlatformAdmin) return true;
    return items.some((item) => this.hasPermission(access, item.pageKey, item.action));
  }

  hasPermission(
    access: ResolvedAccess,
    pageKeys: string | string[],
    action: PermissionAction,
  ): boolean {
    if (access.isPlatformAdmin) return true;
    const keys = Array.isArray(pageKeys) ? pageKeys : [pageKeys];
    const allow = (key: string) => {
      const p = access.pages[key];
      if (!p) return false;
      if (action === 'view') return p.view;
      if (action === 'edit') return p.edit;
      return p.delete;
    };
    // 小程序要用的接口，一律在接口自己的 @RequirePermission 里显式列出 app: key
    // （见 inventory.controller）。这里**不做**「app:inventory 等价于 inventory」
    // 之类的通用映射 —— 那样一格权限会顺带扩散到所有挂同一个后台 key 的接口：
    // 勾个「报修」就能派单、勾个「采购审批」就能清空库存。
    return keys.some(allow);
  }
}
