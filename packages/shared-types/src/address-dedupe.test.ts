import assert from 'node:assert/strict';
import test from 'node:test';
import { dedupeAddressText, formatFullAddress, formatAddressLine, isLaneRedundant, resolveAddressQuery, type AddressTreeLite } from './address';

const building = (lane: string) => ({ lane, buildingNo: '6', roadName: null });

for (const [input, expected] of [
  ['永南140弄/140弄6号 大门', '永南140弄6号 大门'],
  ['永北150弄 / 150弄6号/201', '永北150弄6号201'],
  ['永南150弄 150弄6号 大门🔧', '永南150弄6号 大门🔧'],
  ['永南150弄150弄6号', '永南150弄6号'],
  ['永南150弄／150弄／150弄6号', '永南150弄6号'],
  ['永南1150弄/150弄6号', '永南1150弄/150弄6号'],
  ['永南140弄/40弄6号', '永南140弄/40弄6号'],
  ['永南150弄/1150弄6号', '永南150弄/1150弄6号'],
  ['永南150弄/永北150弄6号', '永南150弄/永北150弄6号'],
  ['枫桦景苑一期/198弄17号/201', '枫桦景苑一期/198弄17号201'],
  ['枫桦景苑一期/228弄17号/201', '枫桦景苑一期/228弄17号201'],
  ['吴泾物业总公司/宝秀路858号/工程部', '吴泾物业总公司/宝秀路858号/工程部'],
  ['150弄/151弄/150弄6号', '150弄/151弄/150弄6号'],
  ['', ''],
]) {
  test(`旧地址展示安全去重：${input || '空值'}`, () => {
    assert.equal(dedupeAddressText(input), expected);
    assert.equal(dedupeAddressText(expected), expected, '重复渲染应幂等');
  });
}

test('南北同弄同楼同室：复制去重地址仍精确检索原社区/楼栋/房产ID', () => {
  const tree: AddressTreeLite[] = ['永南150弄', '永北150弄'].map((name, index) => ({
    id: index + 8, name, mainLane: '150', buildings: [{
      id: index + 11, ...building('150'), houses: [{ id: index + 17, roomNo: '201' }],
    }],
  }));
  for (const c of tree) {
    const text = formatFullAddress(c.name, c.buildings[0], '201');
    assert.deepEqual(resolveAddressQuery(text, tree)?.houseIds, [c.buildings[0].houses[0].id]);
  }
});

test('报修地址：重复弄号只显示一次，保留小区南北身份和室号', () => {
  assert.equal(formatFullAddress('永南140弄', building('140')), '永南140弄6号');
  assert.equal(formatFullAddress('永南150弄', building('150'), '201'), '永南150弄6号201');
  assert.equal(formatFullAddress('永北150弄', building('150'), '201'), '永北150弄6号201');
});

test('数字尾缀不是同一弄：140/40和1150/150不能误删', () => {
  for (const [name, lane] of [['永南140弄', '40'], ['永南1150弄', '150'], ['永南1140弄', '140']]) {
    assert.equal(isLaneRedundant({ name }, lane), false);
    assert.equal(formatAddressLine({ name }, building(lane)), `${name}${lane}弄6号`);
    assert.equal(formatFullAddress(name, building(lane)), `${name}/${lane}弄6号`);
  }
});

test('真实不同弄、路名、未知数量及办公室名字房号继续完整保留', () => {
  assert.equal(formatFullAddress('永南150弄', building('140'), '201'), '永南150弄/140弄6号201');
  assert.equal(formatFullAddress('枫桦景苑一期', building('198'), '201'), '枫桦景苑一期/198弄6号201');
  assert.equal(formatFullAddress('吴泾物业总公司', { lane: null, buildingNo: '858', roadName: '宝秀路' }, '工程部'), '吴泾物业总公司/宝秀路858号工程部');
});
