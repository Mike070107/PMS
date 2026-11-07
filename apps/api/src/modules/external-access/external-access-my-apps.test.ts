import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ExternalAccessService } from './external-access.service';
import { ExternalAccessController } from './external-access.controller';
import { PERMISSION_KEY } from '../../common/require-permission.decorator';

const onlineApp = {
  id: 9,
  tenantId: 1,
  name: '用友财务系统',
  slug: 'finance',
  entryPath: '/tplus/view/login.html',
  publicHostname: 'caiwu.prsznh.cn',
  originUrl: 'http://192.168.1.2:8050',
  enabled: true,
  publishStatus: 'online',
};
const publishingApp = { ...onlineApp, id: 10, name: '未发布系统', slug: 'unpublished', publicHostname: 'unpublished.prsznh.cn', publishStatus: 'publishing' };

function fixture(apps: any[], authorizedIds: number[]) {
  let findCalls = 0;
  const appRepo = {
    find: async (options: any) => {
      findCalls += 1;
      assert.equal(options.where.tenantId, 1);
      assert.equal(options.where.enabled, true);
      assert.equal(options.where.publishStatus, 'online');
      return apps.filter((app) => app.enabled === options.where.enabled && app.publishStatus === options.where.publishStatus);
    },
  };
  const access = { externalAppIdsOfUser: async () => authorizedIds };
  const service = new ExternalAccessService(appRepo as any, {} as any, {} as any, {} as any, access as any);
  return { service, calls: () => findCalls };
}

test('my-apps：有 externalAppIds 授权、无 intranet 页面权限也返回已上线应用', async () => {
  const { service } = fixture([onlineApp], [9]);
  const apps = await service.listMyApps({ id: 7, tenantId: 1 } as any);
  assert.deepEqual(apps, [{
    id: 9,
    name: '用友财务系统',
    slug: 'finance',
    entryPath: '/tplus/view/login.html',
    publicHostname: 'caiwu.prsznh.cn',
    originUrl: 'http://192.168.1.2:8050',
    url: 'https://caiwu.prsznh.cn/tplus/view/login.html',
    publishStatus: 'online',
  }]);
  // my-apps 是任意登录用户的应用入口，不挂 intranet/settings 页面权限。
  assert.equal(Reflect.getMetadata(PERMISSION_KEY, ExternalAccessController.prototype.myApps), undefined);
  // 管理端列表保持 settings:view 不变。
  assert.deepEqual(Reflect.getMetadata(PERMISSION_KEY, ExternalAccessController.prototype.list), {
    items: [{ pageKey: 'settings', action: 'view' }],
  });
});

test('my-apps：没有任何 externalAppIds 授权返回空数组，不查应用表', async () => {
  const { service, calls } = fixture([onlineApp], []);
  assert.deepEqual(await service.listMyApps({ id: 7, tenantId: 1 } as any), []);
  assert.equal(calls(), 0, '无授权时不应查询应用表');
});

test('my-apps：未上线（publishing/draft/error）应用不返回', async () => {
  const draftApp = { ...onlineApp, id: 11, name: '草稿', slug: 'draft', publicHostname: 'draft.prsznh.cn', publishStatus: 'draft' };
  const { service } = fixture([onlineApp, publishingApp, draftApp], [9, 10, 11]);
  const apps = await service.listMyApps({ id: 7, tenantId: 1 } as any);
  assert.deepEqual(apps.map((app) => app.id), [9], '只返回 publishStatus=online 的应用');
});
