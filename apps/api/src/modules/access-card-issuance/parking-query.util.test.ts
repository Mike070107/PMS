import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertFreshParkingPlateCheck,
  exactParkingPlateMatches,
  parkingLegacyRoomFromName,
  parkingPlateFromFields,
  parkingPmsHouseKey,
  parkingRoomAddress,
  parseParkingSearch,
  supportsStructuredParkingQueries,
  supportsParkingMovementQueries,
  parseParkingMovementRange,
  parseParkingFeeReportRange,
  supportsParkingFeeReports,
} from './parking-query.util';

const duplicateRows = [{ database: 'parking2', fields: { P_plate: '沪EDK889', Owner__Room_No: '228/5/301' } }];

test('两段房号保留楼栋边界，不把 6 号楼扩成 36 号楼', () => {
  assert.deepEqual(parseParkingSearch('6/502'), { kind: 'house', term: '6/502' });
  assert.deepEqual(parseParkingSearch('06-502'), { kind: 'house', term: '06/502' });
});

test('完整房号兼容弄号文字和旧库卡序号后缀', () => {
  assert.deepEqual(parseParkingSearch('198弄6号402室'), { kind: 'house', term: '198/6/402' });
  assert.deepEqual(parseParkingSearch('228/02/102/5'), { kind: 'house', term: '228/02/102/5' });
});

test('区分完整车牌、车牌尾号、电话和姓名', () => {
  assert.equal(parseParkingSearch('沪BDQ8839').kind, 'plate');
  assert.deepEqual(parseParkingSearch('DQ8839'), { kind: 'plate_tail', term: 'DQ8839' });
  assert.deepEqual(parseParkingSearch('8839'), { kind: 'plate_tail', term: '8839' });
  assert.deepEqual(parseParkingSearch('13800001234'), { kind: 'phone', term: '13800001234' });
  assert.deepEqual(parseParkingSearch('张三'), { kind: 'resident', term: '张三' });
});

test('拒绝会造成大范围扫描的短数字', () => {
  assert.throws(() => parseParkingSearch('502'), /数字信息太少/);
  assert.throws(() => parseParkingSearch('12'), /数字信息太少/);
  assert.throws(() => parseParkingSearch('28/49/1202'), /无法识别查询内容/);
});

test('只有带结构化查询边界的现场助手才能领取查询', () => {
  assert.equal(supportsStructuredParkingQueries('2.3.0'), false);
  assert.equal(supportsStructuredParkingQueries('2.4.0'), true);
  assert.equal(supportsStructuredParkingQueries('0.7.0'), false);
  assert.equal(supportsStructuredParkingQueries('0.8.0'), true);
});

test('进出记录仅交给具备新版协议的助手，必须是完整车牌和不超过 31 天的日期范围', () => {
  assert.equal(supportsParkingMovementQueries('2.5.26'), false);
  assert.equal(supportsParkingMovementQueries('2.5.27'), true);
  assert.deepEqual(parseParkingMovementRange('沪a12345', '2026-09-01', '2026-10-01'), {
    plate: '沪A12345', startDate: '2026-09-01', endDate: '2026-10-01',
  });
  assert.throws(() => parseParkingMovementRange('12345', '2026-09-01', '2026-09-02'), /完整车牌/);
  assert.throws(() => parseParkingMovementRange('沪A12345', '2026-09-01', '2026-10-02'), /31 天/);
  assert.throws(() => parseParkingMovementRange('沪A12345', '2026-02-30', '2026-03-01'), /有效/);
});

test('金额报表按 31 天限制查询，且仅新版助手可领取', () => {
  assert.equal(supportsParkingFeeReports('2.5.26'), false);
  assert.equal(supportsParkingFeeReports('2.5.27'), true);
  assert.deepEqual(parseParkingFeeReportRange('2026-10-01', '2026-10-31'), {
    startDate: '2026-10-01', endDate: '2026-10-31',
  });
  assert.throws(() => parseParkingFeeReportRange('2026-10-01', '2026-11-01'), /31 天/);
  assert.throws(() => parseParkingFeeReportRange('2026-02-30', '2026-03-01'), /有效/);
});

test('P_Owner.owner_Name 中的旧库标准地址按房号解释', () => {
  assert.equal(parkingLegacyRoomFromName('198-6-402'), '198/6/402');
  assert.equal(parkingLegacyRoomFromName('已隐藏228/02/102/5'), '228/2/102');
  assert.equal(parkingLegacyRoomFromName('张三'), null);
});

test('P_Owner.owner_Name 裸房号按停车库补全所属弄号但不猜未知库', () => {
  assert.equal(parkingLegacyRoomFromName('12/101', 'parking1'), '198/12/101');
  assert.equal(parkingLegacyRoomFromName('12/101', 'parking2'), '228/12/101');
  assert.equal(parkingLegacyRoomFromName('已隐藏12/0101/3换车牌', 'parking2'), '228/12/101');
  assert.equal(parkingLegacyRoomFromName('28/49/1202', 'parking2'), null);
  assert.equal(parkingLegacyRoomFromName('12/101'), null);
  assert.equal(parkingLegacyRoomFromName('12/101', 'unknown'), null);
});

test('同户多卡的隐藏标识、前导零及卡序号不改变房号', () => {
  for (const value of ['228/2/102', '228/02/102', '已隐藏228/02/102', '已隐藏228/02/102/5']) {
    assert.equal(parkingRoomAddress(value)?.key, '228/2/102', value);
  }
  assert.notEqual(parkingRoomAddress('228/02/101')?.key, '228/2/102');
});

test('停车旧库的多种房号格式统一匹配同一套 PMS 房产', () => {
  const expected = '198/6/402';
  for (const value of ['198/6/402', '198/06/402', '198-6-402', '198-06-402', '198弄6号402室']) {
    assert.equal(parkingRoomAddress(value)?.key, expected);
  }
  assert.equal(parkingPmsHouseKey('198', '06', '0402'), expected);
});

test('换车牌是旧库名称的操作说明，不参与 PMS 房产匹配', () => {
  const expected = parkingPmsHouseKey('228', '16', '201');
  for (const value of [
    '228-16-201换车牌', '228/16/201', '228-16-201',
    '228/16/201换车牌', '228弄16号201室换车牌', '已隐藏228/16/201/5换车牌',
  ]) {
    assert.equal(parkingRoomAddress(value)?.key, expected, value);
    assert.equal(parkingLegacyRoomFromName(value), '228/16/201', value);
  }
});

test('带说明的房号仍按完整弄号、楼栋、室号匹配，不截断数字或猜测多个地址', () => {
  assert.equal(parkingRoomAddress('228-16-2010换车牌')?.key, '228/16/2010');
  assert.equal(parkingRoomAddress('198-16-201换车牌')?.key, '198/16/201');
  for (const value of ['228-116-201换车牌', '228-16-20101换车牌', '228-16-201换车牌228-16-202', '车牌228-16-201']) {
    assert.equal(parkingRoomAddress(value), null, value);
  }
});

test('真实住户匹配方法将三种旧库名称关联到同一 PMS 二期房产业主，保留原名称', async () => {
  const { AccessCardIssuanceService } = await import('./access-card-issuance.service');
  const service = Object.create(AccessCardIssuanceService.prototype) as InstanceType<typeof AccessCardIssuanceService>;
  const building = { id: 16, tenantId: 1, communityId: 2, lane: '228', buildingNo: '16' };
  const house = { id: 16201, tenantId: 1, buildingId: 16, roomNo: '201', areaSqm: '90' };
  const owner = { id: 321, tenantId: 1, houseId: house.id, name: '测试业主', phone: null,
    status: 'active', updatedAt: new Date('2026-10-02T00:00:00Z'), updatedBy: null };
  Object.assign(service, {
    buildingRepo: { find: async ({ where }: any) => { assert.equal(where.tenantId, 1); return [building]; } },
    houseRepo: { find: async () => [house] },
    communityRepo: { find: async () => [{ id: 2, tenantId: 1, name: '枫桦景苑二期' }] },
    userRepo: { find: async ({ where }: any) => { assert.equal(where.tenantId, 1); return [owner]; } },
  });
  const names = ['228-16-201换车牌', '228/16/201', '228-16-201'];
  const rows = names.map((name) => ({ database: 'parking2', fields: {
    Owner__owner_Name: name, Owner__owner_Tel: null, Owner_ID: 1851, P_plate: '沪A12345',
  } }));
  const result = await service['matchParkingRowsToPms'](1, rows);
  for (const [index, row] of result.entries()) {
    assert.equal(row.pmsMatch?.userId, owner.id);
    assert.equal(row.pmsMatch?.matchedBy, 'room');
    assert.equal(row.pmsMatch?.house?.communityName, '枫桦景苑二期');
    assert.equal(row.pmsMatch?.house?.lane, '228');
    assert.equal(row.pmsMatch?.house?.buildingNo, '16');
    assert.equal(row.pmsMatch?.house?.roomNo, '201');
    assert.equal(row.fields.Owner__owner_Name, names[index]);
  }
});

test('真实住户匹配方法按数据库把裸房号关联到对应弄号，并优先房号而非过期电话', async () => {
  const { AccessCardIssuanceService } = await import('./access-card-issuance.service');
  const service = Object.create(AccessCardIssuanceService.prototype) as InstanceType<typeof AccessCardIssuanceService>;
  const buildings = [
    { id: 112, tenantId: 1, communityId: 1, lane: '198', buildingNo: '12' },
    { id: 212, tenantId: 1, communityId: 2, lane: '228', buildingNo: '12' },
  ];
  const houses = [
    { id: 10198, tenantId: 1, buildingId: 112, roomNo: '101', areaSqm: '80' },
    { id: 10228, tenantId: 1, buildingId: 212, roomNo: '101', areaSqm: '90' },
  ];
  const owners = [
    { id: 19801, tenantId: 1, houseId: 10198, name: '一期业主', phone: '13800000001', role: 'owner',
      status: 'active', updatedAt: new Date('2026-10-02T00:00:00Z'), updatedBy: null },
    { id: 22801, tenantId: 1, houseId: 10228, name: '二期业主', phone: '13800000002', role: 'owner',
      status: 'active', updatedAt: new Date('2026-10-02T00:00:00Z'), updatedBy: null },
  ];
  Object.assign(service, {
    buildingRepo: { find: async () => buildings },
    houseRepo: { find: async () => houses },
    communityRepo: { find: async () => [
      { id: 1, tenantId: 1, name: '枫桦景苑一期' },
      { id: 2, tenantId: 1, name: '枫桦景苑二期' },
    ] },
    userRepo: { find: async ({ where }: any) => {
      if (where.phone) return [owners[1]];
      if (where.houseId) return owners;
      return [];
    } },
  });
  const rows = [
    { database: 'parking1', fields: { Owner__owner_Name: '12/101', Owner__owner_Tel: '13800000002', Owner_ID: 1, P_plate: '沪A11111' } },
    { database: 'parking2', fields: { Owner__owner_Name: '12/101', Owner__owner_Tel: null, Owner_ID: 2, P_plate: '沪A22222' } },
  ];
  const result = await service['matchParkingRowsToPms'](1, rows);
  assert.equal(result[0].pmsMatch?.userId, 19801);
  assert.equal(result[0].pmsMatch?.matchedBy, 'room');
  assert.equal(result[0].pmsMatch?.house?.lane, '198');
  assert.equal(result[1].pmsMatch?.userId, 22801);
  assert.equal(result[1].pmsMatch?.matchedBy, 'room');
  assert.equal(result[1].pmsMatch?.house?.lane, '228');
});

test('新增车牌查重按旧库车牌字段做精确匹配', () => {
  assert.equal(parkingPlateFromFields({ P_plate: ' 沪E·DK889 ' }), '沪EDK889');
  assert.equal(exactParkingPlateMatches(duplicateRows, '沪EDK889').length, 1);
  assert.equal(exactParkingPlateMatches(duplicateRows, '沪EDK88').length, 0);
});

test('已存在车牌不能通过新增车牌查重', () => {
  assert.throws(() => assertFreshParkingPlateCheck({
    term: '沪EDK889', status: 'completed', rows: duplicateRows, completedAt: '2026-10-01T10:00:00.000Z',
  }, '沪EDK889', new Date('2026-10-01T10:01:00.000Z')), /已存在于枫桦景苑二期停车系统/);
});

test('新增车牌提交只接受当前车牌五分钟内完成的真实查重', () => {
  const clearQuery = { term: '沪A12345', status: 'completed', rows: [], completedAt: '2026-10-01T10:00:00.000Z' };
  assert.doesNotThrow(() => assertFreshParkingPlateCheck(clearQuery, '沪A12345', new Date('2026-10-01T10:04:59.000Z')));
  assert.throws(() => assertFreshParkingPlateCheck(clearQuery, '沪B12345', new Date('2026-10-01T10:01:00.000Z')), /当前车牌不一致/);
  assert.throws(() => assertFreshParkingPlateCheck(clearQuery, '沪A12345', new Date('2026-10-01T10:05:01.000Z')), /超过 5 分钟/);
});
