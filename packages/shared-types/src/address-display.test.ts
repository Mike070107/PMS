import assert from 'node:assert/strict';
import test from 'node:test';
import { dedupeAddressText, formatAddressLine, formatFullAddress, resolveAddressQuery, type AddressTreeLite } from './address';

for (const name of ['永南150弄', '永北150弄']) {
  test(`${name}房号直接接在号后，不额外加斜杠或室`, () => {
    const building = { lane: '150', buildingNo: '6', roadName: null };
    assert.equal(formatFullAddress(name, building, '201'), `${name}6号201`);
    assert.equal(formatAddressLine({ name }, building, '201'), `${name}6号201`);
    assert.equal(dedupeAddressText(`${name}/150弄6号/201 大门`), `${name}6号201 大门`);
  });
}

test('旧数字房号只去掉楼栋与房号间的分隔，不删其他路径和公区说明', () => {
  assert.equal(dedupeAddressText('永南150弄/150弄6号／0201'), '永南150弄6号0201');
  assert.equal(dedupeAddressText('一期/198弄6号/201室 大门'), '一期/198弄6号201室 大门');
  assert.equal(dedupeAddressText('一期/198弄6号/2号门'), '一期/198弄6号/2号门');
  assert.equal(dedupeAddressText('一期/198弄6号/公共区域 大门'), '一期/198弄6号/公共区域 大门');
  assert.equal(dedupeAddressText('150/6/201'), '150/6/201', '搜索短写不应被重建');
});

test('结构化字母房号直接连接，办公室无楼号仍保留层级且不伪造号', () => {
  assert.equal(formatFullAddress('一期', { lane: '198', buildingNo: '6', roadName: null }, '201A'), '一期/198弄6号201A');
  assert.equal(formatFullAddress('总公司', { lane: null, buildingNo: '', roadName: null }, '3楼财务部'), '总公司/3楼财务部');
  assert.equal(formatFullAddress('总公司', { lane: '', buildingNo: '', roadName: '宝秀路' }, '工程部'), '总公司/宝秀路/工程部');
});

test('无分隔房号仍唯一检索永南/永北各自房产', () => {
  const tree: AddressTreeLite[] = ['永南150弄', '永北150弄'].map((name, i) => ({
    id: i + 1, name, mainLane: '150', buildings: [{
      id: i + 11, lane: '150', buildingNo: '6', roadName: null, houses: [{ id: i + 21, roomNo: '201' }],
    }],
  }));
  for (const c of tree) assert.deepEqual(resolveAddressQuery(formatFullAddress(c.name, c.buildings[0], '201'), tree)?.houseIds, [c.buildings[0].houses[0].id]);
});
