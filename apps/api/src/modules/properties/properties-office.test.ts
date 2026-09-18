import assert from 'node:assert/strict';
import test from 'node:test';
import { PropertiesService } from './properties.service';
import { UserRole } from '../../common/enums';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CreateHouseDto } from './dto';

function fixture() {
  const service = Object.create(PropertiesService.prototype) as any;
  const buildings: any[] = [];
  const houses: any[] = [];
  const user = { id: 7, tenantId: 1, role: UserRole.STAFF } as any;
  service.communityRepo = { findOne: async ({ where }: any) => where.tenantId === 1 && where.id === 18 ? { id: 18, tenantId: 1 } : null };
  service.buildingRepo = {
    findOne: async ({ where }: any) => buildings.find((b) => b.tenantId === where.tenantId &&
      (where.id ? b.id === where.id : b.communityId === where.communityId && b.buildingNo === where.buildingNo)) || null,
    create: (v: any) => ({ ...v, id: buildings.length + 100 }),
    save: async (v: any) => { if (!buildings.includes(v)) buildings.push(v); return v; },
  };
  service.houseRepo = {
    findOne: async ({ where }: any) => houses.find((h) => h.tenantId === where.tenantId &&
      (where.id ? h.id === where.id : h.buildingId === where.buildingId && h.roomNo === where.roomNo)) || null,
    create: (v: any) => ({ ...v, id: houses.length + 1000 }),
    save: async (v: any) => { if (!houses.includes(v)) houses.push(v); return v; },
  };
  service.qrService = { ensureBuildingQr: async () => {} };
  return { service, buildings, houses, user };
}

const office = { communityId: 18, propertyType: '办公楼', singleBuilding: true, roomNo: '3楼财务部' };

test('请求契约：单栋标记必须是布尔值，完整楼层部门文本仍受30字限制', () => {
  assert.deepEqual(validateSync(plainToInstance(CreateHouseDto, office)), []);
  assert.ok(validateSync(plainToInstance(CreateHouseDto, { ...office, singleBuilding: 'true' })).some(e => e.property === 'singleBuilding'));
  assert.ok(validateSync(plainToInstance(CreateHouseDto, { ...office, roomNo: '财'.repeat(31) })).some(e => e.property === 'roomNo'));
});

test('无号办公楼可保存，第二个部门复用同一栋，不制造楼号', async () => {
  const { service, buildings, user } = fixture();
  const a = await service.createHouse(office, user);
  const b = await service.createHouse({ ...office, roomNo: '4楼工程部' }, user);
  assert.equal(buildings.length, 1);
  assert.equal(buildings[0].buildingNo, '');
  assert.equal(buildings[0].lane, null);
  assert.equal(a.buildingId, b.buildingId);
  assert.equal(a.roomNo, '3楼财务部');
});

test('同楼同层同部门禁止重复，另一层同名部门允许，编辑可以改楼层', async () => {
  const { service, user } = fixture();
  const a = await service.createHouse(office, user);
  await assert.rejects(() => service.createHouse({ ...office, roomNo: ' 3楼财务部 ' }, user), /已存在/);
  await service.createHouse({ ...office, roomNo: '4楼财务部' }, user);
  await assert.rejects(() => service.updateHouse(a.id, { roomNo: '4楼财务部' }, user), /已存在/);
  const changed = await service.updateHouse(a.id, { roomNo: '5楼财务部' }, user);
  assert.equal(changed.roomNo, '5楼财务部');
  await assert.rejects(() => service.updateHouse(a.id, { roomNo: ' ' }, user), /房号或房间/);
  await assert.rejects(() => service.updateHouse(a.id, { propertyType: '住宅' }, user), /不能直接改/);
});

test('住宅公寓仍要求楼号，办公楼编号模式也要求；单栋不能混传假编号', async () => {
  const { service, user } = fixture();
  for (const propertyType of ['住宅', '公寓', '商铺']) {
    await assert.rejects(() => service.createHouse({ ...office, propertyType }, user), /只有办公楼/);
  }
  await assert.rejects(() => service.createHouse({ ...office, singleBuilding: false }, user), /请填写楼栋/);
  await assert.rejects(() => service.createHouse({ ...office, buildingNo: '1' }, user), /请清空/);
  await assert.rejects(() => service.createHouse({ ...office, roomNo: ' ' }, user), /房号或房间/);
  const apartment = await service.createHouse({ communityId: 18, propertyType: '公寓', buildingNo: '1', roomNo: '101' }, user);
  assert.equal(apartment.propertyType, '公寓');
  assert.equal(apartment.roomNo, '101');
});

test('无编号模式也必须校验租户与小区权限，拒绝时不创建楼栋', async () => {
  const { service, buildings, user } = fixture();
  await assert.rejects(() => service.createHouse({ ...office, communityId: 99 }, user), /community not found/);
  await assert.rejects(() => service.createHouse(office, user, { scopeAll: false, communityIds: [2] }), /不在你的数据范围/);
  assert.equal(buildings.length, 0);
});
