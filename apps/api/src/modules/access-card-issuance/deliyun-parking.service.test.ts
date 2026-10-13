import assert from 'node:assert/strict';
import test from 'node:test';
import { createDecipheriv } from 'node:crypto';
import {
  buildDeliyunCreatePayload,
  buildDeliyunGarageAuthorizationPayload,
  buildDeliyunRenewalPayload,
  buildDeliyunPlateChangePayload,
  shanghaiDateOnly,
  deliyunFormBody,
  deliyunCreatedVehicleMismatches,
  deliyunGarageAuthorization,
  encryptMiniappData,
  endOfDayEpoch,
  findCivilDefenseGarage,
  legacyDeliyunSign,
  mapDeliyunVehicle,
  miniappSign,
  startOfDayEpoch,
  DeliyunParkingService,
} from './deliyun-parking.service';

test('人防真实字段差异按名称报错；缺失金额不假装已核验，也不误判授权失败', () => {
  const expected = { plateNum: '沪APD0593', cardTypeId: 2, carTypeId: 1, peopleId: 19, money: 0, beginTime: 1, endTime: 2, remark: '原备注' };
  const { money, ...returned } = expected;
  assert.deepEqual(deliyunCreatedVehicleMismatches(returned, expected), []);
  assert.deepEqual(deliyunCreatedVehicleMismatches({ ...returned, endTime: 3, peopleId: 20 }, expected), ['人员关联', '到期日期']);
  assert.deepEqual(deliyunCreatedVehicleMismatches({ ...returned, money: 100 }, expected), ['金额']);
});

test('德立云表单不发送空的数字关联ID，车位号写入卡号', () => {
  const body = deliyunFormBody({ cprtId: '', cardGroupId: ' ', poolId: null, peopleId: '19',
    cardTypeId: 2, carTypeId: 1, money: 0, cardNo: 'B01', remark: '来自PMS' });
  assert.equal(body.has('cprtId'), false);
  assert.equal(body.has('cardGroupId'), false);
  assert.equal(body.has('poolId'), false);
  assert.equal(body.get('peopleId'), '19');
  assert.equal(body.get('money'), '0');
  assert.equal(body.get('cardNo'), 'B01');
  assert.equal(body.get('remark'), '来自PMS');
  assert.equal(deliyunFormBody({ cprtId: 8, cardGroupId: '6', poolId: 0 }).get('cprtId'), '8');
});

test('人防换牌只改车牌，保留车库、用户、卡号、车位备注与原有效期', () => {
  const detail = { plateNum: '沪APD0088', cardNo: '123', pgIds: 'garage-1,garage-2',
    peopleId: 'owner-1', cardTypeId: 7, carTypeId: 1, cprtId: 'space-1', cardGroupId: 'group-1',
    poolId: 'pool-1', money: 150, beginTime: 1000, endTime: 2000, remark: '车位号：B12\n原备注' };
  const result = buildDeliyunPlateChangePayload(detail, 'unit-1', 'vehicle-1', '沪BAU1900');
  assert.equal(result.plateNum, '沪BAU1900');
  for (const key of Object.keys(detail).filter(key => key !== 'plateNum')) assert.deepEqual(result[key], detail[key]);
  assert.equal(result.id, 'vehicle-1');
});

test('人防日期固定上海时区年月日格式，不依赖区域默认分隔符', () => {
  assert.equal(shanghaiDateOnly(new Date('2026-10-11T16:30:00Z')), '2026-10-12');
});

test('德立云失败保留上游具体消息，未返回时明确提示，不能只给通用失败', () => {
  const service = new DeliyunParkingService({ get: () => 'true' } as any) as any;
  assert.throws(() => service.assertSuccess({ ecode: 7, msg: '该车牌已经存在' }, '德立云人防车辆建档失败'), /代码 7.*该车牌已经存在/);
  assert.throws(() => service.assertSuccess({ ecode: 7 }, '德立云人防车辆建档失败'), /未返回具体原因/);
  assert.throws(() => service.assertSuccess({ ecode: 2, msg: '登录过期' }, '车辆查询失败'), /DELIYUN_AUTH_2/);
});

test('同房号重复人员直接复用有效ID，返回顺序变化不新建或更换关联', async () => {
  const service = new DeliyunParkingService({ get: () => 'true' } as any);
  const internal = service as any;
  const people = [{ id: '20', pname: '228/53/301' }, { id: '', pname: '228/53/301' },
    { id: '3', pname: '228/53/301' }, { id: '1', pname: '228/53/301/2' }];
  internal.h5Get = async () => ({ ecode: 0, data: people });
  internal.h5Post = async () => assert.fail('已有人员不得调用新建');
  const session = { park: { unitKey: 'park' }, token: 'test' };
  const first = await internal.ensureOwnerRoom('228/53/301', session);
  people.reverse();
  assert.equal(await internal.ensureOwnerRoom('228/53/301', session), first);
  assert.ok(['3', '20'].includes(first));
});

test('房号无可用人员才新建，且必须回读有效ID', async () => {
  const service = new DeliyunParkingService({ get: () => 'true' } as any);
  const internal = service as any;
  let created = false;
  internal.h5Get = async () => ({ ecode: 0, data: created ? [{ id: '42', pname: '198/6/501' }] : [{ id: '1', pname: '198/36/501' }] });
  internal.h5Post = async (path: string, payload: any) => {
    assert.equal(path, '/pma/card/addPeople'); assert.equal(payload.name, '198/6/501');
    assert.equal(created, false); created = true; return { ecode: 0 };
  };
  assert.equal(await internal.ensureOwnerRoom('198/6/501', { park: { unitKey: 'park' }, token: 'test' }), '42');
});

test('人防直接换牌调用更新不删除；失败回读不报告成功', async () => {
  const service = new DeliyunParkingService({ get: () => 'true' } as any);
  const internal = service as any;
  const before = { id: 'v1', plateNum: '沪APD0088', pgIds: 'garage', peopleId: 'p1', beginTime: 1, endTime: 2, remark: '车位号：B01' };
  let saved: any;
  internal.ensureMiniappSession = async () => ({ park: { unitKey: 'park' }, token: 'test' });
  internal.vehicleDetail = async () => saved || before;
  internal.findVehiclesByPlate = async () => ({ rows: [] });
  internal.h5Post = async (path: string, payload: any) => { assert.equal(path, '/pma/card/updateCard'); saved = payload; return { ecode: 0 }; };
  assert.equal((await service.changePlate({ vehicleId: 'v1', plate: before.plateNum, newPlate: '沪BAU1900' })).verified, true);
  saved = undefined;
  internal.h5Post = async () => ({ ecode: 0 });
  await assert.rejects(service.changePlate({ vehicleId: 'v1', plate: before.plateNum, newPlate: '沪BAU1900' }), /回读不一致/);
});

test('人防授权按项目车辆列表存在判断，不要求详情重复返回车库字段', () => {
  assert.equal(deliyunGarageAuthorization({ id: 'vehicle-1', plateNum: '沪APD0088' }).civilDefenseAuthorized, true);
});

test('取消人防授权删除车辆并回读不存在，不调用 updateCard', async () => {
  const service = new DeliyunParkingService({ get: () => 'true' } as any);
  const calls: Array<{ path: string; payload: unknown }> = [];
  const internal = service as any;
  internal.ensureMiniappSession = async () => ({ park: { unitKey: 'park' }, token: 'test' });
  internal.civilDefenseGarage = async () => ({ id: '27031' });
  internal.findVehiclesByPlate = async () => ({ rows: calls.length ? [] : [{ id: 'v1', plate: '沪APD0088', civilDefenseAuthorized: true }] });
  internal.vehicleDetail = async () => ({ id: 'v1', plateNum: '沪APD0088', pgIds: '27031' });
  internal.h5Post = async (path: string, payload: unknown) => { calls.push({ path, payload }); return { ecode: 0, data: 1 }; };
  const result = await service.setCivilDefenseAuthorization({ plate: '沪APD0088', authorized: false, vehicleId: 'v1' });
  assert.deepEqual(calls, [{ path: '/pma/card/deleteCard', payload: { unitKey: 'park', id: 'v1' } }]);
  assert.equal(result.verified, true);
  assert.equal(result.authorized, false);
});

test('新建使用今天、二期截止日、已有房号人员及车位备注，金额为零且回读字段', async () => {
  const service = new DeliyunParkingService({ get: () => 'true' } as any);
  const internal = service as any;
  let payload: Record<string, any> | null = null;
  internal.ensureMiniappSession = async () => ({ park: { unitKey: 'park' }, token: 'test' });
  internal.civilDefenseGarage = async () => ({ id: '27031' });
  internal.findVehiclesByPlate = async () => ({ rows: payload ? [{ id: 'v1', civilDefenseAuthorized: true }] : [] });
  internal.h5Get = async (path: string) => ({ ecode: 0, data: path.includes('CardType') ? [{ id: 2, tname: '月票车' }] : path.includes('CarType') ? [{ id: 1, tname: '小型车' }] : [{ id: 9, pname: '228/53/1401' }] });
  internal.h5Post = async (path: string, value: Record<string, any>) => {
    assert.equal(path, '/pma/card/addCard'); payload = value; return { ecode: 0 };
  };
  // 真实详情接口不返回 money，不能将缺失字段误报为写入不一致。
  internal.vehicleDetail = async () => { const { money, ...detail } = payload!; return detail; };
  await service.setCivilDefenseAuthorization({ plate: '沪APD0088', authorized: true, beginDate: '2000-01-01', endDate: '2099-12-31', ownerRoom: '228/53/1401', parkingSpace: 'B008', remark: '原备注' });
  const saved = payload as unknown as Record<string, any>;
  assert.equal(saved.beginTime, startOfDayEpoch(new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' })));
  assert.equal(saved.endTime, endOfDayEpoch('2099-12-31'));
  assert.equal(saved.peopleId, '9');
  assert.equal(saved.money, 0);
  assert.equal(saved.cardNo, 'B008');
  assert.equal(saved.remark, '来自PMS');
});

test('删除响应成功但车辆仍存在时不得报告取消完成', async () => {
  const service = new DeliyunParkingService({ get: () => 'true' } as any);
  const internal = service as any;
  internal.ensureMiniappSession = async () => ({ park: { unitKey: 'park' }, token: 'test' });
  internal.findVehiclesByPlate = async () => ({ rows: [{ id: 'v1', civilDefenseAuthorized: true }] });
  internal.h5Post = async () => ({ ecode: 0 });
  await assert.rejects(service.setCivilDefenseAuthorization({ plate: '沪APD0088', authorized: false }), /车辆仍存在/);
});

test('德立云旧协议签名与参数传入顺序无关', () => {
  const first = legacyDeliyunSign({ version: 'v1', accessKeyID: 'id', data: '{}', timestamp: '1', commKey: 'park' }, 'secret');
  const second = legacyDeliyunSign({ commKey: 'park', timestamp: '1', data: '{}', accessKeyID: 'id', version: 'v1' }, 'secret');
  assert.equal(first, second);
  assert.match(first, /^[a-f0-9]{32}$/);
});

test('德立云签名不包含空参数', () => {
  assert.equal(legacyDeliyunSign({ accessKeyID: 'id', optional: '' }, 'secret'), legacyDeliyunSign({ accessKeyID: 'id' }, 'secret'));
});

test('德立云签名按文档示例追加 accessKeySecret 键值', () => {
  assert.equal(
    legacyDeliyunSign({ version: '1.0', accessKeyID: 'id' }, 'secret'),
    'b8ea5ec91c37c1364f1386715aa804f9',
  );
});

test('德立云小程序请求使用 AES-128-CBC 和紧凑 JSON', () => {
  const key = '1234567890abcdef';
  const iv = 'abcdef1234567890';
  const encrypted = encryptMiniappData({ pageNum: 1, name: '枫桦景苑' }, key, iv);
  const decipher = createDecipheriv('aes-128-cbc', Buffer.from(key), Buffer.from(iv));
  const plain = Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64')), decipher.final()]).toString('utf8');
  assert.equal(plain, '{"pageNum":1,"name":"枫桦景苑"}');
});

test('德立云小程序签名保持协议字段固定顺序', () => {
  assert.equal(
    miniappSign({ ver: '3.0', times: '1', reqid: 'request', token: 'token', data: 'cipher' }, 'secret'),
    '9c5cc3f92477c68c046f57da7f0030d5ff6ac47d80d8844466aa3841f432b61a',
  );
});

test('德立云车辆响应只映射页面需要的字段', () => {
  assert.deepEqual(mapDeliyunVehicle({
    id: 12, plateNum: '沪A12345', cardType: '月票车', beginDate: '2026-01-01', endDate: '2026-12-31',
    pname: '张三', pmobile: '13800000000', ignoredSecret: 'never-return',
  }), {
    id: '12', plate: '沪A12345', cardNo: null, carType: null, cardType: '月票车',
    beginDate: '2026-01-01', endDate: '2026-12-31', ownerName: '张三', ownerPhone: '13800000000',
    address: null, cardPoolId: null, cardPoolName: null, garageNames: [], civilDefenseAuthorized: false, poolPeriods: [],
  });
});

test('德立云续期只替换结束日期并保留车辆资料与授权', () => {
  const detail = {
    plateNum: '沪A12345', cardNo: 'C001', pgIds: '11,12', cardTypeId: 2, carTypeId: 1,
    peopleId: 19, cprtId: 8, cardGroupId: 6, poolId: '', money: 0, beginTime: 1790784000,
    endTime: 1822320000, remark: '原备注', ignored: '不得提交',
  };
  assert.deepEqual(buildDeliyunRenewalPayload(detail, 'project-key', 'vehicle-1', '2027-10-31'), {
    unitKey: 'project-key', id: 'vehicle-1', plateNum: '沪A12345', cardNo: 'C001', pgIds: '11,12',
    cardTypeId: 2, carTypeId: 1, peopleId: 19, cprtId: 8, cardGroupId: 6, poolId: '', money: 0,
    beginTime: 1790784000, endTime: endOfDayEpoch('2027-10-31'), remark: '原备注',
  });
  assert.equal(endOfDayEpoch('2027-10-31'), 1824998399);
});

test('德立云项目车辆存在即授权，同时保留真实车库名称供展示', () => {
  const garage = findCivilDefenseGarage([
    { id: 27028, pgName: '二期地面车位' },
    { id: 27031, pgName: '二期民防车库' },
  ]);
  assert.deepEqual(garage, { id: '27031', name: '二期民防车库' });
  assert.deepEqual(deliyunGarageAuthorization({
    id: 'v1', plateNum: '沪APD0088',
    pgIds: [27028, 27029, 27030, 27031],
    pgNames: ['二期地面车位', '一期地面车位', '二期大车库', '二期民防车库'],
  }), {
    garageNames: ['二期地面车位', '一期地面车位', '二期大车库', '二期民防车库'],
    civilDefenseAuthorized: true,
  });
});

test('德立云授权只追加人防车库并保留车辆原资料', () => {
  const detail = {
    plateNum: '沪A12345', cardNo: 'C001', pgIds: [27028, 27030], cardTypeId: 2, carTypeId: 122300,
    peopleId: 19, cprtId: 8, cardGroupId: 6, poolId: '', money: 0, beginTime: 1790784000,
    endTime: 1822320000, remark: '原备注', ignored: '不得提交',
  };
  assert.deepEqual(buildDeliyunGarageAuthorizationPayload(detail, 'project-key', 'vehicle-1', '27031', true), {
    unitKey: 'project-key', id: 'vehicle-1', plateNum: '沪A12345', cardNo: 'C001', pgIds: '27028,27030,27031',
    cardTypeId: 2, carTypeId: 122300, peopleId: 19, cprtId: 8, cardGroupId: 6, poolId: '', money: 0,
    beginTime: 1790784000, endTime: 1822320000, remark: '原备注',
  });
});

test('德立云不存在车牌时按月票小型车建档，不记收费', () => {
  assert.deepEqual(buildDeliyunCreatePayload({
    unitKey: 'project-key', plate: '沪A12345', civilDefenseGarageId: '27031', cardTypeId: '2', carTypeId: '122300',
    beginDate: '2026-10-01', endDate: '2027-09-30', remark: '原备注',
  }), {
    unitKey: 'project-key', plateNum: '沪A12345', cardNo: '', pgIds: '27031', cardTypeId: '2', carTypeId: '122300',
    peopleId: '', cprtId: '', cardGroupId: '', poolId: '', money: 0,
    beginTime: startOfDayEpoch('2026-10-01'), endTime: endOfDayEpoch('2027-09-30'),
    remark: '来自PMS',
  });
});
