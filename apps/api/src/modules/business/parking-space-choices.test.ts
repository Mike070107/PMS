import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { parkingSpaceChoices, validateSelectedSpaces } from './parking-space-choices';
import { supportsGarageSpaceSelection } from '../access-card-issuance/parking-owner-update.util';
import { AccessCardIssuanceService } from '../access-card-issuance/access-card-issuance.service';

test('同库自然排序、重号禁选、跨库同号互不干扰，已关联车牌仍可选择', () => {
  const choices = parkingSpaceChoices([
    { id: 1, garage: 'main', spaceNo: 'A10' }, { id: 2, garage: 'main', spaceNo: 'A2' },
    { id: 3, garage: 'civil', spaceNo: 'A2' }, { id: 4, garage: 'civil', spaceNo: 'R1' }, { id: 5, garage: 'civil', spaceNo: 'R1' },
  ]);
  assert.deepEqual(choices.filter(s => s.garage === 'main').map(s => s.spaceNo), ['A2', 'A10']);
  assert.equal(choices.filter(s => s.unavailableReason).length, 2);
  assert.deepEqual(validateSelectedSpaces(['phase2', 'main', 'civil'], { main: ' A2 ', civil: 'A2' }, choices), { main: 'A2', civil: 'A2' });
  assert.throws(() => validateSelectedSpaces(['phase2', 'main'], { main: 'R1' }, choices), /大车库/);
  assert.throws(() => validateSelectedSpaces(['phase2', 'civil'], { civil: 'R1' }, choices), /人防/);
  assert.throws(() => validateSelectedSpaces(['phase2', 'civil'], {}, choices), /人防/);
  assert.throws(() => validateSelectedSpaces(['main'], { main: 'A2' }, choices), /二期地面/);
  assert.deepEqual(validateSelectedSpaces(['phase1'], { main: 'obsolete', civil: 'obsolete' }, choices), {});
});

test('授权目录按租户、小区访问范围、枫桦目标过滤，返回最小字段', async () => {
  const calls: any[] = [];
  const service: any = {
    requireTenant: () => 12,
    communityRepo: { find: async (opts: any) => { calls.push(opts); return [{ id: 8 }]; } },
    parkingOperationRepo: { manager: { getRepository: () => ({ find: async (opts: any) => { calls.push(opts); return [{ id: 9, garage: 'main', spaceNo: 'A1', plate: 'private', houseNo: 'private' }]; } }) } },
  };
  const result = await AccessCardIssuanceService.prototype.parkingSpaceChoices.call(service, {} as any, { scopeAll: false, communityIds: [8] } as any);
  assert.deepEqual(result.rows, [{ id: 9, garage: 'main', spaceNo: 'A1', unavailableReason: '' }]);
  assert.equal(calls[0].where.tenantId, 12); assert.equal(calls[1].where.tenantId, 12);
  assert.deepEqual(calls[1].where.garage.value, ['main', 'civil']);
  assert.deepEqual(calls[1].where.communityId.value, [8]);
  await assert.rejects(() => AccessCardIssuanceService.prototype.parkingSpaceChoices.call(service, {} as any), /访问范围/);
  service.communityRepo.find = async () => [];
  assert.deepEqual(await AccessCardIssuanceService.prototype.parkingSpaceChoices.call(service, {} as any, {} as any), { rows: [] });
});

test('新协议只交给支持车位写入读回的助手', () => {
  for (const v of [null, '', '2.5.54', '2.4.99']) assert.equal(supportsGarageSpaceSelection(v), false);
  for (const v of ['2.5.55', '2.5.55.0', '2.6.0', '3.0.0']) assert.equal(supportsGarageSpaceSelection(v), true);
});
