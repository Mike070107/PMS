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
