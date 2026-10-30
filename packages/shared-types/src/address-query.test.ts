import assert from 'node:assert/strict';
import test from 'node:test';
import { addressSearchKey, resolveAddressQuery, tokenizeAddress, type AddressTreeLite } from './address';

/** 线上真实形状：枫桦一期只有 198 弄，二期 228 弄，两期都有 20 号楼 */
const h = (id: number, roomNo: string, ownerName?: string) => ({ id, roomNo, ownerName });
const tree: AddressTreeLite[] = [
  { id: 1, name: '枫桦景苑一期', mainLane: '198', buildings: [
    { id: 17, lane: '198', buildingNo: '20', roadName: null, houses: [h(101, '601', '张三'), h(102, '602')] },
    { id: 18, lane: '198', buildingNo: '201', roadName: null, houses: [h(103, '101')] },
    { id: 19, lane: '198', buildingNo: '2', roadName: null, houses: [h(104, '2001')] },
  ] },
  { id: 2, name: '枫桦景苑二期', mainLane: '228', buildings: [
    { id: 99, lane: '228', buildingNo: '20', roadName: null, houses: [h(912, '601')] },
  ] },
  { id: 8, name: '永南150弄', mainLane: '150', buildings: [
    { id: 212, lane: '150', buildingNo: '20', roadName: null, houses: [] },
  ] },
];

test('汉字和数字连写也能切开；1期 = 一期', () => {
  assert.deepEqual(tokenizeAddress('一期20'), ['一期', '20']);
  assert.deepEqual(tokenizeAddress('枫桦景苑一期20号楼'), ['枫桦景苑一期', '20']);
  assert.deepEqual(tokenizeAddress('枫桦1期20号'), ['枫桦一期', '20']);
  assert.deepEqual(tokenizeAddress('228弄4号201室'), ['228', '4', '201']);
  assert.deepEqual(tokenizeAddress('永德路153号'), ['永德路', '153']);
});

test('同一栋楼的各种写法都只命中这一栋', () => {
  for (const q of ['198/20', '一期20', '枫桦景苑一期20号楼', '198弄20号', '枫桦景苑一期/198弄20号', '1期20', '枫桦一期 20']) {
    const r = resolveAddressQuery(q, tree);
    assert.ok(r, q);
    assert.equal(r.level, 'building', q);
    assert.deepEqual(r.buildingIds, [17], q);
  }
});

test('不因为前缀把 201 号楼、2001 室带进来', () => {
  assert.deepEqual(resolveAddressQuery('198/20', tree)!.buildingIds, [17]);
  // 只打「20」：所有小区的 20 号楼，不含 201 号楼
  assert.deepEqual(resolveAddressQuery('20', tree)!.buildingIds.sort((a, b) => a - b), [17, 99, 212]);
});

test('到户：带弄号精确到一户；省掉小区时两期同号都列出', () => {
  assert.deepEqual(resolveAddressQuery('198/20/601', tree)!.houseIds, [101]);
  assert.deepEqual(resolveAddressQuery('一期20号601', tree)!.houseIds, [101]);
  assert.deepEqual(resolveAddressQuery('20/601', tree)!.houseIds.sort((a, b) => a - b), [101, 912]);
  assert.deepEqual(resolveAddressQuery('张三', tree)!.houseIds, [101]);
});

test('小区名 / 弄号 → 整个小区；不像地址返回 null', () => {
  assert.deepEqual(resolveAddressQuery('枫桦景苑二期', tree)!.communityIds, [2]);
  assert.equal(resolveAddressQuery('228', tree)!.level, 'community');
  assert.equal(resolveAddressQuery('漏水', tree), null);
  assert.equal(resolveAddressQuery('RX-20261030', tree), null);
});

test('下拉选到哪一层就写成哪一层的短写', () => {
  const c = { name: '枫桦景苑一期' };
  assert.equal(addressSearchKey(c, { lane: '198', buildingNo: '20', roadName: null }, '601'), '198/20/601');
  assert.equal(addressSearchKey(c, { lane: '198', buildingNo: '20', roadName: null }), '198/20');
  assert.equal(addressSearchKey(c), '枫桦景苑一期');
  assert.equal(addressSearchKey({ name: '物业总公司' }, { lane: null, buildingNo: '858', roadName: '宝秀路' }), '物业总公司/宝秀路/858');
});
