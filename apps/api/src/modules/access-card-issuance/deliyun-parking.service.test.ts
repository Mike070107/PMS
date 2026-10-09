import assert from 'node:assert/strict';
import test from 'node:test';
import { createDecipheriv } from 'node:crypto';
import { buildDeliyunRenewalPayload, encryptMiniappData, endOfDayEpoch, legacyDeliyunSign, mapDeliyunVehicle, miniappSign } from './deliyun-parking.service';

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
    address: null, cardPoolId: null, cardPoolName: null, poolPeriods: [],
  });
});

test('德立云续期只替换结束日期并保留车辆资料与授权', () => {
  const detail = {
    plateNum: '沪A12345', cardNo: 'C001', pgIds: '11,12', cardTypeId: 2, carTypeId: 1,
    peopleId: 19, cprtId: 8, poolId: '', money: 0, beginTime: 1790784000,
    endTime: 1822320000, remark: '原备注', ignored: '不得提交',
  };
  assert.deepEqual(buildDeliyunRenewalPayload(detail, 'project-key', 'vehicle-1', '2027-10-31'), {
    unitKey: 'project-key', id: 'vehicle-1', plateNum: '沪A12345', cardNo: 'C001', pgIds: '11,12',
    cardTypeId: 2, carTypeId: 1, peopleId: 19, cprtId: 8, poolId: '', money: 0,
    beginTime: 1790784000, endTime: endOfDayEpoch('2027-10-31'), remark: '原备注',
  });
  assert.equal(endOfDayEpoch('2027-10-31'), 1824998399);
});
