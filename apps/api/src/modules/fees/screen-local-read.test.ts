import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { FeesController } from './fees.controller';
import { ScreenSettingsController } from './screen-settings.controller';

test('大屏固定本地：不读全局数据源模式，不调用MIS直连，失败不回退', async () => {
  const c: any = Object.create(FeesController.prototype);
  let reads = 0;
  c.misFeesService = { screenSummary: () => { throw Error('Forbidden direct MIS'); } };
  c.misMirrorService = {
    mode: () => { throw Error('Must not inspect global switch'); },
    screenSummary: async (q: any, user: any, access: any) => { reads++; assert.deepEqual(q.communityIds, [1, 2]); assert.equal(user.tenantId, 1); assert.deepEqual(access.communityIds, [1, 2]); return { source: 'mirror', dataAsOf: '2026-11-08T12:00:00Z' }; },
  };
  const out = await c.misScreenSummary({ year: 2026, communityIds: '1,2', granularity: 'day' }, { tenantId: 1 }, { communityIds: [1, 2] });
  assert.equal(out.source, 'mirror'); assert.equal(reads, 1);
  c.misMirrorService.screenSummary = () => Promise.reject(Error('本地同步尚未初始化'));
  await assert.rejects(c.misScreenSummary({}, { tenantId: 1 }, {}), /本地同步/);
});

test('大屏小区选项复用本地授权范围，不读取MIS元数据', async () => {
  const c: any = Object.create(ScreenSettingsController.prototype);
  c.screenSettingsService = { scope: async (_user: any, access: any) => { assert.deepEqual(access.communityIds, [1]); return [{ id: 1, name: '枫桦景苑一期' }]; } };
  const out = await c.screenOptions({ tenantId: 1 }, { communityIds: [1] });
  assert.deepEqual(out, { communities: [{ id: 1, name: '枫桦景苑一期' }] });
});
