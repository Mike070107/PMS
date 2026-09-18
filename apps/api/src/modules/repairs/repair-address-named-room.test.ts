import assert from 'node:assert/strict';
import test from 'node:test';
import { UserRole } from '../../common/enums';
import { RepairsService } from './repairs.service';

/**
 * 办公楼没有「几0几」：物业总公司在宝秀路858号，里面是工程部、采购部、财务部
 * （2026-09-15 Mike：「这种怎么添加，怎么让报修语音识别到」）。
 *
 * 房产管理里可以把「室」直接填成部门名（room_no 存的就是中文），但识别只认数字，
 * 于是：「宝秀路858号工程部空调不制冷」只能落到楼栋级、部门丢掉；
 * 「财务部空调不制冷」整句认不出来。这里锁住这两条路，以及**不许乱认**的那些边界。
 */

const COMMUNITIES = [
  { id: 18, parentId: null, tenantId: 1, enabled: true, name: '吴泾物业总公司' },
  { id: 2, parentId: null, tenantId: 1, enabled: true, name: '枫桦景苑二期' },
];

const BUILDINGS = [
  { id: 563, communityId: 18, lane: null, buildingNo: '858' },
  { id: 103, communityId: 2, lane: '228', buildingNo: '25' },
];

/** 办公楼的房间名字就是房号；住宅仍然是数字 */
const HOUSES = [
  { id: 8244, buildingId: 563, roomNo: '工程部' },
  { id: 8247, buildingId: 563, roomNo: '财务部' },
  { id: 8248, buildingId: 563, roomNo: '工程部仓库' },
  { id: 994, buildingId: 103, roomNo: '301' },
];

function chainableQb(rows: unknown[]) {
  const self: Record<string, unknown> = {};
  for (const name of ['innerJoin', 'where', 'andWhere', 'select', 'addSelect']) {
    self[name] = () => self;
  }
  self.getRawMany = async () => rows;
  return self;
}

function makeService(houses = HOUSES) {
  const service = Object.create(RepairsService.prototype) as any;
  service.resolveTenantId = () => 1;
  service.ownCommunityId = async () => null;
  service.communityRepo = { async find() { return COMMUNITIES; } };
  service.spotRepo = { async find() { return []; } };
  service.buildingRepo = {
    async find() { return BUILDINGS; },
    async findOne({ where }: any) { return BUILDINGS.find((b) => b.id === where.id) ?? null; },
  };
  const named = houses
    .filter((h) => !/^\d+$/.test(h.roomNo))
    .map((h) => ({
      ...h,
      communityId: BUILDINGS.find((b) => b.id === h.buildingId)!.communityId,
    }));
  service.houseRepo = {
    async find({ where }: any) { return houses.filter((h) => h.buildingId === where.buildingId); },
    createQueryBuilder() { return chainableQb(named); },
  };
  service.communityAddressInfo = async () =>
    new Map(COMMUNITIES.map((c) => [c.id, { name: c.name, laneCount: 0 }]));
  return service;
}

test('单栋办公楼：3楼／三楼／三层的财务部都匹配真实房产，不误当三号楼', async () => {
  const houses = [{ id: 9002, buildingId: 563, roomNo: '3楼财务部' }];
  const service = makeService(houses);
  service.buildingRepo.findOne = async () => ({ ...BUILDINGS[0], buildingNo: '' });
  for (const mention of ['3楼财务部', '三楼财务部', '三层的财务部', '第三楼的财务部']) {
    const r = await service.parseAddressByRule({ text: `吴泾物业总公司${mention}空调坏了` }, { id: 7, role: UserRole.STAFF, tenantId: 1 });
    assert.equal(r.houseId, 9002, mention);
    assert.equal(r.addressText, '吴泾物业总公司3楼财务部');
    assert.equal(r.buildingText, '');
    assert.equal(r.matchedRaw, mention);
    assert.equal(`吴泾物业总公司${mention}空调坏了`.replace(r.matchedRaw, ''), '吴泾物业总公司空调坏了');
  }
  for (const floor of ['13楼', '十三楼', '一三楼', '地下3楼', '负三楼']) {
    const wrong = await service.parseAddressByRule({ text: `吴泾物业总公司${floor}财务部空调坏了` }, { id: 7, role: UserRole.STAFF, tenantId: 1 });
    assert.equal(wrong.matched, false, floor);
  }
  const unique = await service.parseAddressByRule({ text: '吴泾物业总公司财务部空调坏了' }, { id: 7, role: UserRole.STAFF, tenantId: 1 });
  assert.equal(unique.houseId, 9002);
  assert.equal(unique.matchedRaw, '财务部');
  const twins = makeService([...houses, { id: 9003, buildingId: 563, roomNo: '4楼财务部' }]);
  const ambiguous = await twins.parseAddressByRule({ text: '吴泾物业总公司财务部空调坏了' }, { id: 7, role: UserRole.STAFF, tenantId: 1 });
  assert.equal(ambiguous.matched, false);
});

test('馨香公寓吴泾店1号楼101室精确命中，不受办公楼无楼号适配影响', async () => {
  const apartment = { id: 19, parentId: null, tenantId: 1, enabled: true, name: '馨香公寓吴泾店' };
  const building = { id: 564, communityId: 19, lane: null, buildingNo: '1' };
  const service = makeService([...HOUSES, { id: 10004, buildingId: 564, roomNo: '101' }]);
  service.communityRepo.find = async () => [...COMMUNITIES, apartment];
  service.buildingRepo.find = async () => [...BUILDINGS, building];
  service.communityAddressInfo = async () => new Map([...COMMUNITIES, apartment].map((c) => [c.id, { name: c.name, laneCount: 0 }]));
  const r = await service.parseAddressByRule({ text: '馨香公寓吴泾店1号楼101室漏水' }, { id: 7, role: UserRole.STAFF, tenantId: 1 });
  assert.equal(r.houseId, 10004);
  assert.equal(r.communityId, 19);
  assert.equal(r.buildingId, 564);
  assert.equal(r.roomNo, '101');
});

test('同一小区不同楼栋有同名部门，没说楼栋不能随意选第一间', async () => {
  const service = makeService();
  service.houseRepo.createQueryBuilder = () => chainableQb([
    { id: 10001, buildingId: 563, communityId: 18, roomNo: '工程部' },
    { id: 10002, buildingId: 564, communityId: 18, roomNo: '工程部' },
  ]);
  const r = await service.parseAddressByRule({ text: '吴泾物业总公司工程部空调坏了' }, { id: 7, role: UserRole.STAFF, tenantId: 1 });
  assert.equal(r.matched, false);
});

test('商铺可以按真实店名识别，不必念数字铺位号', async () => {
  const service = makeService();
  service.houseRepo.createQueryBuilder = () => chainableQb([
    { id: 10003, buildingId: 563, communityId: 18, roomNo: '101', shopName: '便民水果店' },
  ]);
  const r = await service.parseAddressByRule({ text: '吴泾物业总公司便民水果店漏水' }, { id: 7, role: UserRole.STAFF, tenantId: 1 });
  assert.equal(r.houseId, 10003);
  assert.equal(r.matchedRaw, '便民水果店');
});

const parse = (text: string, houses = HOUSES) =>
  makeService(houses).parseAddressByRule({ text }, { id: 7, role: UserRole.STAFF, tenantId: 1 });

test('说了门牌 + 部门名：认到那间办公室', async () => {
  const r = await parse('宝秀路858号工程部空调不制冷');
  assert.equal(r.matched, true);
  assert.equal(r.level, 'house');
  assert.equal(r.communityId, 18);
  assert.equal(r.houseId, 8244);
  assert.equal(r.roomNo, '工程部');
  // 剥描述要连部门名一起剥，否则「工程部空调不制冷」整段留在故障里
  assert.equal(r.matchedRaw, '宝秀路858号工程部');
  assert.equal('宝秀路858号工程部空调不制冷'.replace(r.matchedRaw!, '').trim(), '空调不制冷');
});

test('名字长的赢：工程部仓库不会被认成工程部', async () => {
  const r = await parse('宝秀路858号工程部仓库漏水');
  assert.equal(r.houseId, 8248);
  assert.equal(r.roomNo, '工程部仓库');
});

test('一个门牌数字都不说，只念部门名也认得出', async () => {
  const r = await parse('财务部空调不制冷');
  assert.equal(r.matched, true);
  assert.equal(r.level, 'house');
  assert.equal(r.houseId, 8247);
  assert.equal(r.roomNo, '财务部');
  assert.equal(r.addressText, '吴泾物业总公司858号财务部', '「室」只缀数字房号，别拼出「财务部室」');
});

test('「号」后面跟的不是房间名就当没说过，照旧落楼栋级', async () => {
  const r = await parse('宝秀路858号漏水了');
  assert.equal(r.matched, true);
  assert.equal(r.level, 'building');
  assert.equal(r.houseId, null);
  assert.equal(r.matchedRaw, '宝秀路858号');
});

test('住宅的数字房号一点不受影响', async () => {
  const r = await parse('228弄25号301漏水');
  assert.equal(r.houseId, 994);
  assert.equal(r.roomNo, '301');
});

test('库里没有这个名字就不认，绝不拿描述当房号', async () => {
  const r = await parse('宝秀路858号会议室灯不亮');
  assert.equal(r.level, 'building');
  assert.equal(r.houseId, null);
  assert.equal((await parse('空调不制冷')).matched, false);
});

test('同名房间挂在两个小区、报修人又不在其中任何一个：不认', async () => {
  const twins = [
    ...HOUSES,
    { id: 9001, buildingId: 103, roomNo: '财务部' },
  ];
  const r = await parse('财务部空调不制冷', twins);
  assert.equal(r.matched, false);
});
