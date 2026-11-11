import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Module, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { RepairsController } from './repairs.controller';
import { RepairsService } from './repairs.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesOrPermissionGuard } from '../access/roles-or-permission.guard';
import { AccessService } from '../access/access.service';

test('工单用料草稿 HTTP 入口校验编辑权限和请求字段', async () => {
  let calls = 0;
  const service = { getMaterialDraft: async () => { calls++; return { version: 0, rows: [] }; }, saveMaterialDraft: async (_id: number, dto: any) => { calls++; return dto; }, listWorkOrders: async (query: any) => query };
  const access = { hasAnyPermission: (resolved: any) => !!resolved.allow };
  @Module({ controllers: [RepairsController], providers: [{ provide: RepairsService, useValue: service }, JwtAuthGuard, RolesOrPermissionGuard, { provide: AccessService, useValue: access }] }) class Fixture {}
  const app = await NestFactory.create(Fixture, { logger: false });
  for (const mod of (app as any).container.getModules().values()) for (const map of [mod.providers, mod.injectables]) for (const wrapper of map.values()) {
    if (wrapper.instance instanceof JwtAuthGuard) wrapper.instance.canActivate = (ctx: any) => {
      const req = ctx.switchToHttp().getRequest(); req.user = { id: 7, tenantId: 1 }; req.access = { allow: req.headers['x-edit'] === 'yes' }; return true;
    };
  }
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  await app.listen(0, '127.0.0.1');
  const url = await app.getUrl() + '/work-orders/9/material-draft';
  const patch = (body: any, edit = true) => fetch(url, { method: 'PATCH', headers: { 'content-type': 'application/json', 'x-edit': edit ? 'yes' : 'no' }, body: JSON.stringify(body) });
  const put = (body: any, edit = true) => fetch(url, { method: 'PUT', headers: { 'content-type': 'application/json', 'x-edit': edit ? 'yes' : 'no' }, body: JSON.stringify(body) });
  try {
    assert.equal((await fetch(url)).status, 403);
    assert.equal((await patch({ version: 0, rows: [] }, false)).status, 403);
    assert.equal((await patch({ version: 0, rows: [{ qty: -1 }] })).status, 400);
    assert.equal(calls, 0);
    assert.equal((await patch({ version: 0, rows: [{ materialId: 20, warehouseId: 10, name: '电源', qty: 1, note: '测试' }] })).status, 200);
    assert.equal((await fetch(url, { headers: { 'x-edit': 'yes' } })).status, 200);
    assert.equal(calls, 2);
    assert.equal((await put({ version: 0, rows: [] }, false)).status, 403);
    assert.equal((await put({ version: 0, rows: [{ qty: -1 }] })).status, 400);
    assert.equal(calls, 2);
    assert.equal((await put({ version: 0, rows: [{ materialId: 20, warehouseId: 10, name: '电源', qty: 1, note: '微信备注' }] })).status, 200);
    assert.equal(calls, 3);
    const list = await fetch((await app.getUrl()) + '/work-orders?scope=all&status=completed&sort=newest', { headers: { 'x-edit': 'yes' } });
    assert.equal(list.status, 200);
    assert.equal((await list.json() as any).sort, 'newest');
    assert.equal((await fetch((await app.getUrl()) + '/work-orders?sort=unknown', { headers: { 'x-edit': 'yes' } })).status, 400);
  } finally { await app.close(); }
});
