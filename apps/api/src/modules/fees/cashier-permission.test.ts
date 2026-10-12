import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { ADMIN_PAGE_KEYS } from '../../common/pages';
import { PERMISSION_KEY } from '../../common/require-permission.decorator';
import { FeesController } from './fees.controller';
import { PropertiesController } from '../properties/properties.controller';
import { PermissionsGuard } from '../access/permissions.guard';
import { AccessService } from '../access/access.service';
import { STAFF_APP_PAGE_KEYS } from '../../common/pages';
import { Reflector } from '@nestjs/core';

const permits = (controller: any, method: string, action: string) =>
  Reflect.getMetadata(PERMISSION_KEY, controller.prototype[method]).items.some(
    (p: any) => p.pageKey === 'apartment-cashier' && p.action === action,
  );

test('自动保存住户资料要求公寓收费台编辑权', () => {
  assert.ok(permits(FeesController, 'updateCashierContact', 'edit'));
  assert.equal(permits(FeesController, 'updateCashierContact', 'view'), false);
});

test('员工公寓入口只放行选址和收费，不扩大后台账单管理权限', () => {
  assert.ok((STAFF_APP_PAGE_KEYS as readonly string[]).includes('app:apartment-cashier'));
  for (const method of ['listCommunities', 'listBuildings', 'listHouses']) {
    assert.ok(Reflect.getMetadata(PERMISSION_KEY, (PropertiesController.prototype as any)[method]).items.some(
      (p: any) => p.pageKey === 'app:apartment-cashier' && p.action === 'view'), method);
  }
  for (const [method, action] of [['houseDetail', 'view'], ['cashierHistory', 'view'], ['createCashierCharge', 'edit']]) {
    assert.ok(Reflect.getMetadata(PERMISSION_KEY, (FeesController.prototype as any)[method]).items.some(
      (p: any) => p.pageKey === 'app:apartment-cashier' && p.action === action), method);
  }
  for (const method of ['unpayBills', 'deleteBill', 'importFees']) {
    assert.equal(Reflect.getMetadata(PERMISSION_KEY, (FeesController.prototype as any)[method]).items.some(
      (p: any) => p.pageKey === 'app:apartment-cashier'), false);
  }
});

test('公寓收费台可以独立登记和授权', () => {
  assert.ok((ADMIN_PAGE_KEYS as readonly string[]).includes('apartment-cashier'));
});
test('只授权公寓收费台即可读取选址、明细、报表和小票', () => {
  for (const method of ['listCommunities', 'listBuildings', 'listHouses']) {
    assert.ok(permits(PropertiesController, method, 'view'), method);
  }
  for (const method of ['listBills', 'billSummary', 'feeReport', 'feeReconciliation', 'houseDetail', 'cashierHistory', 'cashierToday', 'cashierReceipt', 'reprintReceipt']) {
    assert.ok(permits(FeesController, method, 'view'), method);
  }
});
test('收费与红冲要求编辑权，公寓权限不能批量撤销或删除物业账单', () => {
  for (const method of ['createCashierCharge', 'refundReceipt']) {
    assert.ok(permits(FeesController, method, 'edit'), method);
    assert.equal(permits(FeesController, method, 'view'), false);
  }
  for (const method of ['unpayBills', 'deleteBill', 'importFees']) {
    assert.equal(permits(FeesController, method, 'edit'), false);
    assert.equal(permits(FeesController, method, 'delete'), false);
  }
});

test('实际权限守卫：只有公寓查看权可查报表，不能收费；编辑权可收费', async () => {
  const access: any = { pages: { 'apartment-cashier': { view: true, edit: false, delete: false } } };
  const service = Object.create(AccessService.prototype);
  const guard = new PermissionsGuard(new Reflector(), service);
  const context = (method: string): any => ({
    getHandler: () => (FeesController.prototype as any)[method],
    getClass: () => FeesController,
    switchToHttp: () => ({ getRequest: () => ({ user: { id: 1 }, access }) }),
  });
  assert.equal(await guard.canActivate(context('feeReport')), true);
  await assert.rejects(() => guard.canActivate(context('createCashierCharge')), /权限不足/);
  access.pages['apartment-cashier'].edit = true;
  assert.equal(await guard.canActivate(context('createCashierCharge')), true);
  await assert.rejects(() => guard.canActivate(context('unpayBills')), /权限不足/);
  access.pages = {};
  await assert.rejects(() => guard.canActivate(context('feeReport')), /权限不足/);
});
