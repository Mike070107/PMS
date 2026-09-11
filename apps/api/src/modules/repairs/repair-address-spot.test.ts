import assert from 'node:assert/strict';
import test from 'node:test';
import { UserRole } from '../../common/enums';
import { RepairsService } from './repairs.service';

/**
 * 锁住 2026-09-11 的线上事故：语音报「上海新家门卫室的道闸没有网络」，
 * 系统认成了「永南5511弄 门卫室」—— 不是「识别不到地址」，是**认到了别人家**，
 * 单子连带派进了另一个管理处。
 *
 * 成因是两条规则叠在一起：
 *   1. extractAddressCandidate 没有「期」也没有「号」就返回 null（纯公区报修就是这样），
 *      于是小区名根本没机会参与收敛，候选池是全公司；
 *   2. 点位匹配只按「谁排前面」挑，上海新家一个点位都没建档，
 *      全公司只有永南5511弄有「门卫室」，它就赢了。
 *
 * 这里测的口径：**说出口的小区名优先于点位名**；小区没建点位也要认到小区级，
 * 而不是整句认不出来。
 */

const COMMUNITIES = [
  { id: 2, parentId: null, tenantId: 1, enabled: true, name: '枫桦景苑二期' },
  { id: 9, parentId: null, tenantId: 1, enabled: true, name: '永南5511弄' },
  { id: 16, parentId: null, tenantId: 1, enabled: true, name: '上海新家' },
];

/** 线上就是这个分布：只有 2 和 9 建了点位，上海新家一个都没有 */
const SPOTS = [
  { id: 31, name: '监控室', communityId: 2, buildingId: null },
  { id: 41, name: '监控室', communityId: 9, buildingId: null },
  { id: 42, name: '门卫室', communityId: 9, buildingId: null },
];

function makeService() {
  const service = Object.create(RepairsService.prototype) as any;
  service.resolveTenantId = () => 1;
  service.ownCommunityId = async () => null;
  service.communityRepo = { async find() { return COMMUNITIES; } };
  // 故意不按 communityId 过滤：查询条件之外还要有一道收敛，漏进来的点位不能算数
  service.spotRepo = { async find() { return SPOTS; } };
  service.buildingRepo = { async find() { return []; }, async findOne() { return null; } };
  return service;
}

const parse = (text: string) =>
  makeService().parseAddressByRule({ text }, { id: 7, role: UserRole.STAFF, tenantId: 1 });

test('说了小区名，就不许被别的小区的同名点位抢走', async () => {
  const r = await parse('上海新家门卫室的道闸没有网络');
  assert.equal(r.matched, true);
  assert.equal(r.communityId, 16, '必须是上海新家，不是有门卫室的永南5511弄');
  assert.equal(r.level, 'community');
  assert.equal(r.spotName, '门卫室');
  assert.equal(r.addressText, '上海新家 门卫室');
});

test('小区名和点位名中间隔开也一样', async () => {
  const r = await parse('上海新家 门卫室 道闸坏了');
  assert.equal(r.communityId, 16);
  assert.equal(r.addressText, '上海新家 门卫室');
});

test('同名点位挂在两个小区时，也听说出口的那个小区', async () => {
  const r = await parse('上海新家监控室摄像头坏了');
  assert.equal(r.communityId, 16);
  assert.equal(r.spotName, '监控室');
});

test('本来就建了点位的小区，走原来的点位那条路', async () => {
  const r = await parse('永南5511弄门卫室的道闸没有网络');
  assert.equal(r.communityId, 9);
  assert.equal(r.spotName, '门卫室');
  assert.equal(r.addressText, '永南5511弄 门卫室');
});

test('没说小区名时的既有行为不变：全公司只有一个门卫室就认它', async () => {
  const r = await parse('门卫室的灯不亮');
  assert.equal(r.matched, true);
  assert.equal(r.communityId, 9);
});

test('没说小区名、同名点位又有两个：宁可不认', async () => {
  const r = await parse('监控室的灯不亮');
  assert.equal(r.matched, false);
});

test('说了小区名但没说地点的，绝不写成「公共区域」', async () => {
  // 302 室是户内，认成公区会把房号丢掉，维修工不知道进哪一户
  const r = await parse('上海新家302室漏水');
  assert.equal(r.matched, false);
});

test('说了小区名、故障也在户内：同样不认，让人自己填房号', async () => {
  const r = await parse('上海新家卫生间马桶堵了');
  assert.equal(r.matched, false);
});
