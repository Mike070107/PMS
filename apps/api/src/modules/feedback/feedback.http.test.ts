import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Module, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FeedbackController } from './feedback.controller';
import { FeedbackService } from './feedback.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../access/permissions.guard';
import { AccessService } from '../access/access.service';

/** 真实 DTO/守卫，不启动 AppModule 或数据库：验证提交开放、列表 logs:view、处理 logs:edit。 */
test('反馈 HTTP：提交任何登录用户可用，列表 logs:view，处理 logs:edit，非法筛选 400', async () => {
  let last: any;
  const capture = (kind: string) => (...args: any[]) => { last = { kind, args }; return { kind }; };
  const target = { create: capture('create'), list: capture('list'), update: capture('update') };
  const access: any = {
    hasPermission: AccessService.prototype.hasPermission,
    hasAnyPermission: AccessService.prototype.hasAnyPermission,
  };
  @Module({
    controllers: [FeedbackController],
    providers: [
      { provide: FeedbackService, useValue: target },
      JwtAuthGuard,
      PermissionsGuard,
      { provide: AccessService, useValue: access },
    ],
  })
  class Fixture {}
  const app = await NestFactory.create(Fixture, { logger: false });
  for (const mod of (app as any).container.getModules().values()) {
    for (const map of [mod.providers, mod.injectables]) {
      for (const wrapper of map.values()) {
        if (wrapper.instance instanceof JwtAuthGuard) {
          wrapper.instance.canActivate = (ctx: any) => {
            const request = ctx.switchToHttp().getRequest();
            request.user = { id: 7, tenantId: 1 };
            request.access = {
              scopeAll: false,
              communityIds: [10],
              pages: { logs: { view: request.headers['x-test-view'] === 'yes', edit: request.headers['x-test-edit'] === 'yes' } },
            };
            return true;
          };
        }
      }
    }
  }
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
  await app.listen(0, '127.0.0.1');
  const base = (await app.getUrl()) + '/feedback';
  const headers = { 'content-type': 'application/json', 'x-test-view': 'yes' };
  try {
    let response = await fetch(base, { method: 'POST', headers, body: JSON.stringify({ content: '希望字体大一点', kind: 'suggestion' }) });
    assert.equal(response.status, 201, '任何登录用户都能提交');
    assert.equal(last.kind, 'create');

    response = await fetch(base);
    assert.equal(response.status, 403, '列表需要 logs:view');
    response = await fetch(base, { headers });
    assert.equal(response.status, 200);
    assert.equal(last.kind, 'list');
    response = await fetch(base + '?kind=error&status=handled&from=2026-11-01&to=2026-11-08&page=2&pageSize=10', { headers });
    assert.equal(response.status, 200);
    const query = last.args[0];
    assert.equal(query.kind, 'error');
    assert.equal(query.status, 'handled');
    assert.equal(query.page, 2);
    assert.equal(query.pageSize, 10);
    for (const bad of ['?kind=bogus', '?status=bogus', '?from=2026-13-01', '?pageSize=101', '?page=0']) {
      assert.equal((await fetch(base + bad, { headers })).status, 400, bad);
    }

    response = await fetch(base + '/3', { method: 'PATCH', headers: { ...headers, 'x-test-edit': 'no' }, body: '{}' });
    assert.equal(response.status, 403, '标记处理需要 logs:edit');
    response = await fetch(base + '/3', { method: 'PATCH', headers: { ...headers, 'x-test-edit': 'yes' }, body: JSON.stringify({ status: 'pending' }) });
    assert.equal(response.status, 200);
    assert.equal(last.kind, 'update');
    assert.equal(last.args[0], '3');
    assert.equal(last.args[1].status, 'pending');
    response = await fetch(base + '/log-9', { method: 'PATCH', headers: { ...headers, 'x-test-edit': 'yes' }, body: '{}' });
    assert.equal(response.status, 200);
    assert.equal(last.args[0], 'log-9', '历史记录用 log-<id> 处理');
  } finally {
    await app.close();
  }
});
