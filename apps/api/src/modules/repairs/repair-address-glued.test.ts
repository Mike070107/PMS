import assert from 'node:assert/strict';
import test from 'node:test';
import { UserRole } from '../../common/enums';
import { RepairsService } from './repairs.service';

/**
 * 锁住 2026-09-14 的线上反馈：「语音说 198弄xx号 识别不到地址，只能说 枫桦一期xx号」。
 *
 * 查线上 ai_result_cache 那条（2026-09-14 17:22:00）才知道不是「说弄不行」——
 * 识别出来的地址段是 **「1984号」**：语音把中间那个「弄」吞掉了，弄号和门牌粘成了
 * 一个数字。规则拿 1984 去库里找楼栋，一栋都找不到，于是整句没地址；
 * 报修人只好改口说「枫桦一期14号」（对应工单 #73）。
 *
 * 「弄」在这里读 lòng、前后又都是数字，是最容易被识别丢掉的字，所以必须兜：
 * 拿库里**真实存在的弄号**把粘住的数字拆回去，拆出唯一一栋真楼才算数。
 */

const COMMUNITIES = [
  { id: 1, parentId: null, tenantId: 1, enabled: true, name: '枫桦景苑一期' },
  { id: 2, parentId: null, tenantId: 1, enabled: true, name: '枫桦景苑二期' },
  { id: 9, parentId: null, tenantId: 1, enabled: true, name: '永南5511弄' },
];

/** 和线上一致的分布：一期在 198 弄、二期在 228 弄、永南在 5511 弄（那里正好有 228 号楼） */
const BUILDINGS = [
  { id: 3, communityId: 1, lane: '198', buildingNo: '4' },
  { id: 13, communityId: 1, lane: '198', buildingNo: '14' },
  { id: 21, communityId: 1, lane: '198', buildingNo: '24' },
  { id: 60, communityId: 1, lane: null, buildingNo: '199' },
  { id: 92, communityId: 2, lane: '228', buildingNo: '12' },
  { id: 103, communityId: 2, lane: '228', buildingNo: '25' },
  { id: 250, communityId: 9, lane: '5511', buildingNo: '228' },
  { id: 251, communityId: 9, lane: '5511', buildingNo: '236' },
];

const HOUSES = [{ id: 237, buildingId: 21, roomNo: '501' }];

function makeService(buildings = BUILDINGS) {
  const service = Object.create(RepairsService.prototype) as any;
  service.resolveTenantId = () => 1;
  service.ownCommunityId = async () => null;
  service.communityRepo = { async find() { return COMMUNITIES; } };
  service.spotRepo = { async find() { return []; } };
  service.buildingRepo = {
    async find() { return buildings; },
    async findOne() { return null; },
  };
  service.houseRepo = { async find({ where }: any) {
    return HOUSES.filter((h) => h.buildingId === where.buildingId);
  } };
  service.communityAddressInfo = async () =>
    new Map(COMMUNITIES.map((c) => [c.id, { name: c.name, laneCount: 1 }]));
  return service;
}

const parse = (text: string, buildings = BUILDINGS) =>
  makeService(buildings).parseAddressByRule(
    { text },
    { id: 7, role: UserRole.STAFF, tenantId: 1 },
  );

test('弄字被吞、数字粘在一起：按库里真实的弄号拆回去', async () => {
  const r = await parse('1984号门口监控黑屏');
  assert.equal(r.matched, true);
  assert.equal(r.communityId, 1);
  assert.equal(r.buildingId, 3, '198弄4号');
  assert.equal(r.buildingText, '198弄4号');
  // 给用户看的是拆开之后的写法，让他一眼看出这串数字被理解成了什么
  assert.equal(r.matchedText, '198弄4号');
});

test('粘出 5 位也拆得回来（正则只捕 4 位，靠完整数字串）', async () => {
  const r = await parse('19814号监控黑屏');
  assert.equal(r.matched, true);
  assert.equal(r.buildingId, 13, '198弄14号，不是正则捕到的 9814');
  assert.equal(r.buildingText, '198弄14号');
});

test('好好说了「弄」的照旧认得出（不回归）', async () => {
  const r = await parse('198弄4号门口监控黑屏');
  assert.equal(r.buildingId, 3);
  assert.equal(r.matchedText, '198弄4号');
});

test('粘住的数字带室号时，室号照样落到拆出来的楼里', async () => {
  const r = await parse('19824号501灯不亮');
  assert.equal(r.buildingId, 21);
  assert.equal(r.houseId, 237);
  assert.equal(r.roomNo, '501');
  assert.equal(r.matchedText, '198弄24号501室');
});

test('拆出来的楼必须真实存在，否则一律不认', async () => {
  // 198 弄没有 99 号楼，5511 弄也不以 1989 开头 —— 宁可不认
  assert.equal((await parse('19899号灯不亮')).matched, false);
  assert.equal((await parse('9999号灯不亮')).matched, false);
});

test('0 开头的余数不是门牌，不拆', async () => {
  // 「1980号」拆成「198弄0号」是凑出来的，没有 0 号楼
  assert.equal((await parse('1980号大门坏了')).matched, false);
});

test('同一个小区拆出不止一栋 = 歧义，不认', async () => {
  const ambiguous = [
    ...BUILDINGS,
    // 同一个小区里再来一个 19 弄，「1984」既能读成 198弄4号、也能读成 19弄84号
    { id: 500, communityId: 1, lane: '19', buildingNo: '84' },
  ];
  assert.equal((await parse('1984号门口监控黑屏', ambiguous)).matched, false);
});

test('本来就撞得上的门牌号不受影响：不拆、也不改判', async () => {
  const r = await parse('24号501灯不亮');
  assert.equal(r.buildingId, 21);
  assert.equal(r.matchedText, '24号501室');
});

test('小区名里带弄号的那种也拆得回来', async () => {
  const r = await parse('5511228号楼道灯不亮');
  assert.equal(r.communityId, 9);
  assert.equal(r.buildingId, 250, '5511弄228号');
});
