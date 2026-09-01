import assert from 'node:assert/strict';
import test from 'node:test';
import { AccessService } from './access.service';
import { RolesService } from '../roles/roles.service';

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
