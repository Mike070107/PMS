import assert from 'node:assert/strict';
import test from 'node:test';
import { RepairSource, UserRole } from '../../common/enums';
import { RepairsService } from './repairs.service';

function fixture(owners: Array<Record<string, unknown>>) {
  const updates: Array<{ id: number; patch: Record<string, unknown> }> = [];
  const warnings: string[] = [];
  const service = Object.create(RepairsService.prototype) as any;
  service.userRepo = {
    find: async () => owners,
    findOne: async () => null,
    update: async (id: number, patch: Record<string, unknown>) => updates.push({ id, patch }),
    create: (value: unknown) => value,
    save: async () => assert.fail('已有房号业主时不应新建档案'),
  };
  service.logger = { warn: (message: string) => warnings.push(message) };
  return { service, updates, warnings };
}

test('业主主动填写报修电话时即使号码未变化，也用工单生成时间更新', async () => {
  const { service, updates } = fixture([
    { id: 31, tenantId: 1, houseId: 970, role: UserRole.OWNER, name: '刘薇薇', phone: '13000000000' },
  ]);
  service.userRepo.findOne = async () => ({ id: 31, phone: '13800138000' });
  const createdAt = new Date('2026-10-15T10:23:47.482+08:00');
  await service.rememberContactAsOwner(
    { houseId: 970, contactName: '刘薇薇', contactPhone: '13800138000' },
    1,
    RepairSource.OWNER_MINIAPP,
    31,
    createdAt,
  );

  assert.equal(updates.length, 1);
  assert.equal(updates[0].id, 31);
  assert.equal(updates[0].patch.phone, '13800138000');
  assert.equal(updates[0].patch.updatedAt, createdAt);
  assert.equal(updates[0].patch.updatedBy, 31);
});

test('业主未主动填写报修电话时不更新电话和资料时间', async () => {
  const { service, updates } = fixture([
    { id: 31, tenantId: 1, houseId: 970, role: UserRole.OWNER, name: '刘薇薇', phone: '13800138000' },
  ]);
  await service.rememberContactAsOwner(
    { houseId: 970, contactName: '刘薇薇' },
    1,
    RepairSource.OWNER_MINIAPP,
    31,
    new Date('2026-10-15T10:23:47.482+08:00'),
  );

  assert.equal(updates.length, 0);
});

test('同房多业主只在姓名能唯一匹配时更新', async () => {
  const { service, updates } = fixture([
    { id: 31, name: '刘薇薇', phone: '13000000000' },
    { id: 32, name: '陈猛', phone: '13100000000' },
  ]);
  await service.rememberContactAsOwner(
    { houseId: 970, contactName: '陈猛', contactPhone: '13900139000' },
    1,
    RepairSource.STAFF_MINIAPP,
    8,
    new Date('2026-10-15T12:00:00+08:00'),
  );
  assert.deepEqual(updates.map((item) => item.id), [32]);
});

test('同房多业主无法唯一确定时不覆盖任何人', async () => {
  const { service, updates, warnings } = fixture([
    { id: 31, name: '刘薇薇', phone: '13000000000' },
    { id: 32, name: '刘薇薇', phone: '13100000000' },
  ]);
  await service.rememberContactAsOwner(
    { houseId: 970, contactName: '刘薇薇', contactPhone: '13900139000' },
    1,
    RepairSource.OFFICE_WEB,
    8,
    new Date(),
  );
  assert.equal(updates.length, 0);
  assert.match(warnings[0], /无法唯一定位/);
});
