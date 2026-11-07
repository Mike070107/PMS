import assert from 'node:assert/strict';
import test from 'node:test';
import { AccessService } from './access.service';
import { RolesService } from '../roles/roles.service';
import { RoleDataScope, DEFAULT_ROLE_TEMPLATES, PAGE_GROUPS, ADMIN_PAGE_KEYS, pageGroupOf } from '../../common/pages';
import { UserRole } from '../../common/enums';

/**
 * 权限模板：角色 `template_id` 有值时，权限从 role_template_permissions 读。
 * 这一层错了后果是「改了模板没生效」或者「一批人突然进不去页面」，
 * 而两者在界面上都看不出原因，所以锁在测试里。
 */

interface FakeCall {
  where: any;
}

function fakeRepo(rows: any[], sink: { last?: FakeCall }) {
  return {
    async find(opts: FakeCall) {
      sink.last = opts;
      return rows;
    },
  };
}

test('启动时把历史合并权限复制为新的独立页面权限', async () => {
  const svc = Object.create(AccessService.prototype) as any;
  const roleSql: string[] = [];
  const templateSql: string[] = [];
  svc.rolePermRepo = {
    async query(sql: string) {
      roleSql.push(sql);
      return [[], 0];
    },
  };
  svc.tplPermRepo = {
    async query(sql: string) {
      templateSql.push(sql);
      return [[], 0];
    },
  };
  svc.tenantRepo = { async query() { return [[], 0]; } };
  svc.logger = { log() {}, warn(message: string) { throw new Error(message); } };
  svc.backfillAssignments = async () => {};

  await svc.onModuleInit();

  const roleRepairSql = roleSql.find((sql) => sql.includes("'app:my-repairs'"));
  const templateRepairSql = templateSql.find((sql) => sql.includes("'app:my-repairs'"));
  assert.ok(roleRepairSql, '角色权限应完成一次性拆分');
  assert.ok(templateRepairSql, '角色模板权限应完成一次性拆分');
  assert.match(roleRepairSql, /src\.page_key = 'app:my-orders'/);
  assert.match(templateRepairSql, /src\.page_key = 'app:my-orders'/);
  assert.match(roleRepairSql, /src\.can_view, false, false/);
  assert.match(templateRepairSql, /src\.can_view, false, false/);
  const roleMaintenanceSql = roleSql.find((sql) => sql.includes("'app:maintenance-inspect'"));
  const templateMaintenanceSql = templateSql.find((sql) => sql.includes("'app:maintenance-inspect'"));
  assert.match(roleMaintenanceSql || '', /src\.page_key = 'maintenance-inspect'/);
  assert.match(templateMaintenanceSql || '', /src\.page_key = 'maintenance-inspect'/);
  const roleExperienceSql = roleSql.find((sql) => sql.includes("'experience-notes'"));
  const templateExperienceSql = templateSql.find((sql) => sql.includes("'experience-notes'"));
  assert.match(roleExperienceSql || '', /src\.page_key = 'work-orders'/);
  assert.match(templateExperienceSql || '', /src\.page_key = 'work-orders'/);
  const roleSignSql = roleSql.filter((sql) => sql.includes("'app:maintenance-sign'"));
  const templateSignSql = templateSql.filter((sql) => sql.includes("'app:maintenance-sign'"));
  assert.equal(roleSignSql.length, 2, '在手工单和派单台两类老角色都要补养护单签字入口');
  assert.equal(templateSignSql.length, 2, '两类老模板都要补养护单签字入口');
  // 撤回 / 作废从「派单」拆出来：目标只有勾中一档，拿源的 can_edit 当 can_view
  for (const target of ['app:order-rollback', 'app:order-void']) {
    const roleSplit = roleSql.find((sql) => sql.includes(`'${target}'`));
    const tplSplit = templateSql.find((sql) => sql.includes(`'${target}'`));
    assert.match(roleSplit || '', /src\.page_key = 'app:dispatch'/, `${target} 应从派单权限回填`);
    assert.match(tplSplit || '', /src\.page_key = 'app:dispatch'/);
    assert.match(roleSplit || '', /src\.can_edit, false, false/, `${target} 的可见性要取派单的「操作」档`);
    assert.match(tplSplit || '', /src\.can_edit, false, false/);
  }
  // 账单与待缴从物业费独立出来：老角色/模板的 fees 权限要幂等补一份 bills，view/edit 跟随
  const roleBillsSql = roleSql.find((sql) => sql.includes("'bills'"));
  const tplBillsSql = templateSql.find((sql) => sql.includes("'bills'"));
  assert.match(roleBillsSql || '', /src\.page_key = 'fees'/);
  assert.match(tplBillsSql || '', /src\.page_key = 'fees'/);
  assert.match(roleBillsSql || '', /src\.can_view, src\.can_edit, false/);
  assert.match(tplBillsSql || '', /src\.can_view, src\.can_edit, false/);
  assert.equal(roleSql.length, 9, '目前角色权限共有九组拆分回填（含 fees → bills）');
  assert.equal(templateSql.length, 9, '目前模板权限共有九组拆分回填（含 fees → bills）');
});

test('跟随模板的角色读模板那份权限，自定义角色读自己的', async () => {
  const svc = Object.create(AccessService.prototype) as any;
  const own = { last: undefined as FakeCall | undefined };
  const tpl = { last: undefined as FakeCall | undefined };
  svc.rolePermRepo = fakeRepo(
    [{ pageKey: 'work-orders', canView: true, canEdit: true, canDelete: false }],
    own,
  );
  svc.tplPermRepo = fakeRepo(
    [{ pageKey: 'materials', canView: true, canEdit: false, canDelete: false }],
    tpl,
  );

  const rows = await svc.effectivePermissions([
    { id: 1, templateId: null },
    { id: 2, templateId: 9 },
    { id: 3, templateId: 9 },
  ]);

  assert.deepEqual(
    rows.map((r: any) => r.pageKey),
    ['work-orders', 'materials'],
    '两张表的行混在一起返回，调用方按 page_key 取并集',
  );
  assert.deepEqual(own.last?.where.roleId.value, [1], '只查自定义角色那几个 id');
  assert.deepEqual(tpl.last?.where.templateId.value, [9], '同一个模板只查一次');
});

test('全部角色都跟随模板时，压根不查 role_permissions', async () => {
  const svc = Object.create(AccessService.prototype) as any;
  let ownCalled = false;
  svc.rolePermRepo = {
    async find() {
      ownCalled = true;
      return [];
    },
  };
  svc.tplPermRepo = fakeRepo([{ pageKey: 'app:dispatch', canView: true }], {});

  const rows = await svc.effectivePermissions([
    { id: 2, templateId: 9 },
    { id: 3, templateId: 10 },
  ]);
  assert.equal(ownCalled, false);
  assert.deepEqual(rows.map((r: any) => r.pageKey), ['app:dispatch']);
});

test('角色列表/可分配角色也按同一套口径拿勾选', async () => {
  const svc = Object.create(RolesService.prototype) as any;
  svc.permRepo = fakeRepo([{ roleId: 1, pageKey: 'work-orders' }], {});
  svc.tplPermRepo = fakeRepo([{ templateId: 9, pageKey: 'app:dispatch' }], {});

  const byRole = await svc.visiblePageKeysByRole([
    { id: 1, templateId: null },
    { id: 2, templateId: 9 },
  ]);
  assert.deepEqual(byRole.get(1), ['work-orders']);
  assert.deepEqual(byRole.get(2), ['app:dispatch'], '跟随模板的角色不能算成「一格都没勾」');
});

/**
 * 2026-08-31 线上故障：账号绑「上海新家物业办公室」（跟随「物业办公室」模板），
 * 模板里后台页面勾得好好的，登录却报「这个账号还不能登录网页后台」——
 * 准入判断直接查了 role_permissions，而跟随模板的角色在那张表里一行都没有。
 * 现在「能不能进后台」只有 rolesGrantAdminPages 这一份实现，锁在这里。
 */
test('跟随模板的角色，模板勾了后台页面就能登后台', async () => {
  const svc = Object.create(AccessService.prototype) as any;
  svc.rolePermRepo = {
    async find() {
      throw new Error('跟随模板的角色不该去查 role_permissions');
    },
  };
  svc.tplPermRepo = fakeRepo(
    [
      { pageKey: 'app:pool', canView: true },
      { pageKey: 'work-orders', canView: true },
    ],
    {},
  );

  assert.equal(await svc.rolesGrantAdminPages([{ id: 2, templateId: 9 }]), true);
});

test('模板只勾了小程序入口时不算后台权限', async () => {
  const svc = Object.create(AccessService.prototype) as any;
  svc.tplPermRepo = fakeRepo([{ pageKey: 'app:pool', canView: true }], {});

  assert.equal(await svc.rolesGrantAdminPages([{ id: 2, templateId: 9 }]), false);
});

test('内网应用授权只支持自定义角色和跟随模板角色', async () => {
  const svc = Object.create(AccessService.prototype) as any;
  svc.userRoleRepo = fakeRepo(
    [{ tenantId: 1, userId: 7, roleId: 11 }, { tenantId: 1, userId: 7, roleId: 12 }],
    {},
  );
  svc.roleRepo = fakeRepo(
    [
      { id: 11, tenantId: 1, enabled: true, templateId: null, externalAppIds: [91] },
      { id: 12, tenantId: 1, enabled: true, templateId: 8, externalAppIds: [] },
    ],
    {},
  );
  svc.roleTemplateRepo = fakeRepo(
    [{ id: 8, tenantId: 1, externalAppIds: [92, 91] }],
    {},
  );

  assert.deepEqual(
    (await svc.externalAppIdsOfUser(1, 7)).sort((a: number, b: number) => a - b),
    [91, 92],
  );
  assert.equal(await svc.userHasExternalAppAccess(1, 7, 92), true);
  assert.equal(await svc.userHasExternalAppAccess(1, 7, 99), false);
});

test('发布清单可反查有哪些角色授权了指定内网应用', async () => {
  const svc = Object.create(AccessService.prototype) as any;
  svc.roleRepo = fakeRepo(
    [
      { id: 11, tenantId: 1, enabled: true, templateId: null, externalAppIds: [91] },
      { id: 12, tenantId: 1, enabled: true, templateId: 8, externalAppIds: [] },
      { id: 13, tenantId: 1, enabled: true, templateId: null, externalAppIds: [92] },
    ],
    {},
  );
  svc.roleTemplateRepo = fakeRepo([{ id: 8, tenantId: 1, externalAppIds: [91] }], {});

  assert.deepEqual(await svc.roleIdsWithExternalApp(1, 91), [11, 12]);
});

test('勾了后台页面但没打勾「查看」不算 —— 只是被列出来不等于能看', async () => {
  const svc = Object.create(AccessService.prototype) as any;
  svc.tplPermRepo = fakeRepo(
    [{ pageKey: 'work-orders', canView: false, canEdit: true }],
    {},
  );

  assert.equal(await svc.rolesGrantAdminPages([{ id: 2, templateId: 9 }]), false);
});

test('内置企业超管角色直通，一张权限表都不用查', async () => {
  const svc = Object.create(AccessService.prototype) as any;
  svc.rolePermRepo = {
    async find() {
      throw new Error('内置角色不该翻权限表');
    },
  };
  svc.tplPermRepo = svc.rolePermRepo;

  assert.equal(
    await svc.rolesGrantAdminPages([{ id: 1, templateId: null, builtIn: true }]),
    true,
  );
  assert.equal(await svc.rolesGrantAdminPages([]), false, '一个角色都没绑：不放行');
});

test('按权限反查通知收件人时包含跟随模板的角色，不再只剩企业超管', async () => {
  const svc = Object.create(AccessService.prototype) as any;
  svc.userRoleRepo = fakeRepo(
    [
      { tenantId: 1, userId: 101, roleId: 11 },
      { tenantId: 1, userId: 102, roleId: 12 },
      { tenantId: 1, userId: 103, roleId: 13 },
    ],
    {},
  );
  svc.roleRepo = fakeRepo(
    [
      { id: 11, tenantId: 1, templateId: 9, enabled: true, builtIn: false },
      { id: 12, tenantId: 1, templateId: null, enabled: true, builtIn: false },
      { id: 13, tenantId: 1, templateId: null, enabled: true, builtIn: true },
    ],
    {},
  );
  svc.rolePermRepo = fakeRepo(
    [{ roleId: 12, pageKey: 'app:dispatch', canView: true, canEdit: true, canDelete: false }],
    {},
  );
  svc.tplPermRepo = fakeRepo(
    [{ templateId: 9, pageKey: 'app:dispatch', canView: true, canEdit: true, canDelete: false }],
    {},
  );

  assert.deepEqual(
    await svc.userIdsWithPermission(1, 'app:dispatch', 'edit'),
    [101, 102, 103],
    '模板角色、自定义角色和内置超管都应成为新报修通知候选人',
  );
});

test('数据范围只看员工工作范围：多个管理处取并集，角色范围不再参与', async () => {
  const svc = Object.create(AccessService.prototype) as any;
  svc.tenantRepo = { async findOne() { return { enabledPages: null }; } };
  svc.userRoleRepo = fakeRepo([{ userId: 7, roleId: 11 }], {});
  // 角色上仍是旧的「全公司」范围，也不能把人放成全公司
  svc.roleRepo = fakeRepo(
    [{ id: 11, tenantId: 1, enabled: true, builtIn: false, dataScope: RoleDataScope.ALL }],
    {},
  );
  svc.effectivePermissions = async () => [];
  svc.assignmentsOf = async () => new Map([[7, [
    { officeId: 3, skills: ['welding'] },
    { officeId: 5, skills: ['electric', 'mason'] },
  ]]]);
  let askedOffices: number[] = [];
  svc.communityIdsOfOffices = async (_tenantId: number, officeIds: number[]) => {
    askedOffices = officeIds;
    return [10, 11, 20];
  };

  const access = await svc.getAccess({ id: 7, tenantId: 1, role: UserRole.STAFF });
  assert.equal(access.scopeAll, false);
  assert.deepEqual(access.communityIds, [10, 11, 20]);
  assert.deepEqual(askedOffices, [3, 5]);
});

test('工作范围里有「全部管理处」才放开全公司，且不再解析局部清单', async () => {
  const svc = Object.create(AccessService.prototype) as any;
  svc.tenantRepo = { async findOne() { return { enabledPages: null }; } };
  svc.userRoleRepo = fakeRepo([{ userId: 7, roleId: 11 }], {});
  svc.roleRepo = fakeRepo(
    [{ id: 11, tenantId: 1, enabled: true, builtIn: false, dataScope: RoleDataScope.OFFICES }],
    {},
  );
  svc.effectivePermissions = async () => [];
  svc.assignmentsOf = async () => new Map([[7, [
    { officeId: null, skills: ['smart'] },
    { officeId: 5, skills: ['electric'] },
  ]]]);
  svc.communityIdsOfOffices = async () => {
    throw new Error('全部管理处时不应再解析局部范围');
  };

  const access = await svc.getAccess({ id: 7, tenantId: 1, role: UserRole.STAFF });
  assert.equal(access.scopeAll, true);
  assert.equal(access.communityIds, null);
});

test('回填工作范围只处理还没有工作范围的员工（幂等），按角色旧范围推出', async () => {
  const svc = Object.create(AccessService.prototype) as any;
  svc.logger = { log() {}, warn() {} };
  svc.userRoleRepo = {
    async find() {
      return [
        { tenantId: 1, userId: 3, roleId: 39 },
        { tenantId: 1, userId: 4, roleId: 24 },
        { tenantId: 1, userId: 9, roleId: 40 },
      ];
    },
  };
  const saved: any[] = [];
  svc.assignmentRepo = {
    async find() { return [{ userId: 9 }]; }, // 9 号已经在员工页配过，不能动
    create(row: any) { return row; },
    async save(rows: any[]) { saved.push(...rows); return rows; },
  };
  const asked: number[] = [];
  svc.deriveAssignmentsFromRoles = async (_t: number, userId: number) => {
    asked.push(userId);
    return userId === 3
      ? [{ officeId: 1, skills: ['electric'] }]
      : [{ officeId: null, skills: ['water'] }];
  };

  await svc.backfillAssignments();

  assert.deepEqual(asked, [3, 4]);
  assert.deepEqual(saved, [
    { tenantId: 1, userId: 3, officeId: 1, skills: ['electric'] },
    { tenantId: 1, userId: 4, officeId: null, skills: ['water'] },
  ]);
});

test('启动时给只勾了 fees 的公司 enabled_pages 幂等补 bills', async () => {
  const svc = Object.create(AccessService.prototype) as any;
  const tenantSql: string[] = [];
  svc.rolePermRepo = { async query() { return [[], 0]; } };
  svc.tplPermRepo = { async query() { return [[], 0]; } };
  svc.tenantRepo = {
    async query(sql: string) {
      tenantSql.push(sql);
      return [[], 3];
    },
  };
  svc.logger = { log() {}, warn(message: string) { throw new Error(message); } };
  svc.backfillAssignments = async () => {};

  await svc.onModuleInit();

  assert.equal(tenantSql.length, 1, '只跑一条 enabled_pages 补齐 SQL');
  assert.match(tenantSql[0], /UPDATE tenants/);
  assert.match(tenantSql[0], /enabled_pages \? 'fees'/);
  assert.match(tenantSql[0], /NOT enabled_pages \? 'bills'/, '已含 bills 的公司不重复追加');
  assert.match(tenantSql[0], /enabled_pages \|\| '\["bills"\]'::jsonb/, 'jsonb 数组追加，幂等只加行');
});

/**
 * 2026-11 权限体系回归：ADMIN_PAGE_KEYS 与分组定义必须一一对应。
 * 之前 bills 只加到页面注册表、没进权限矩阵/分组，用户发现「账单与待缴」根本没法授权。
 * 以后新加页面漏进 PAGE_GROUPS 会在这里直接失败。
 */
test('页面注册表：每个后台页面在 PAGE_GROUPS 里有且仅有一个归属', () => {
  const grouped = PAGE_GROUPS.flatMap((group) => group.pageKeys);
  assert.equal(new Set(grouped).size, grouped.length, '同一页面不能出现在两个分组');
  assert.deepEqual([...grouped].sort(), [...ADMIN_PAGE_KEYS].sort(), 'ADMIN_PAGE_KEYS 与分组定义必须一一对应');
  for (const key of ADMIN_PAGE_KEYS) assert.ok(pageGroupOf(key), `${key} 未分组，权限界面会看不到它`);
  assert.deepEqual(
    PAGE_GROUPS.map((group) => group.title),
    ['总览', '收费办理', '车辆管理', '门禁管理', '报修养护', '库存与盘点', '分析', '档案', '系统'],
    '分组标题与顺序必须和首页菜单 Shell.tsx 一致',
  );
});

test('页面注册表：api 与 shared-types 两份同源同序，防止只改一边', () => {
  // api 不依赖 @pms/shared-types（见 common/enums.ts 注释），两份注册表靠这条测试锁同步。
  const shared = require('../../../../../packages/shared-types/src/pages');
  assert.deepEqual([...ADMIN_PAGE_KEYS], shared.ADMIN_PAGE_KEYS, '两份 ADMIN_PAGE_KEYS 必须同序同步');
  assert.deepEqual(PAGE_GROUPS, shared.PAGE_GROUPS, '两份 PAGE_GROUPS 必须一致');
});

test('内置角色模板只引用已注册的后台页面', () => {
  for (const template of DEFAULT_ROLE_TEMPLATES) {
    for (const key of Object.keys(template.adminPages ?? {})) {
      assert.ok((ADMIN_PAGE_KEYS as readonly string[]).includes(key), `${template.name} 引用了未注册页面 ${key}`);
    }
  }
});
