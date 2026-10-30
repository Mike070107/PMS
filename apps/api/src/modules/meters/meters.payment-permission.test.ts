import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { MetersController } from './meters.controller';
import { PERMISSION_KEY } from '../../common/require-permission.decorator';

test('抄表收款允许后台编辑或员工收费编辑，不向仅抄表权限开放', () => {
  const permission = Reflect.getMetadata(PERMISSION_KEY, MetersController.prototype.pay);
  assert.deepEqual(permission.items, [
    { pageKey: 'meters', action: 'edit' }, { pageKey: 'app:apartment-cashier', action: 'edit' },
  ]);
  assert.equal(permission.items.some((item: any) => item.pageKey === 'app:meters'), false);
});
