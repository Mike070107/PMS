const test = require('node:test');
const assert = require('node:assert/strict');
const { harness, communities } = require('./address-picker-shared.test.cjs');

test('小区公区是二级叶子；无楼栋小区也可登记，默认选房不出现', () => {
  const picked = [];
  const tree = [...communities, { id: 3, name: '永南150弄', buildings: [] }];
  const h = harness('HouseAddressPicker.tsx', { communities: tree, allowPublicArea: true, onPicked: value => picked.push(value) });
  h.render();
  for (const community of h.control.props.options) {
    const area = community.children.find(item => item.kind === 'public');
    assert.ok(area, '每个真实小区均有公区，不借用楼栋/住户');
    assert.equal(area, community.children[0], '小区公区应在楼栋之前，不必滚过大量楼栋');
    h.control.props.onChange([community.value, area.value]); h.render();
    assert.equal(picked.at(-1).locationKind, 'public');
    assert.equal(picked.at(-1).communityId, community.value);
    assert.equal(picked.at(-1).buildingId, undefined);
    assert.equal(picked.at(-1).houseId, undefined);
    assert.equal(picked.at(-1).fullText, community.community.name + '/公共区域');
  }
  h.props.allowPublicArea = false; h.render();
  assert.ok(h.control.props.options.every(item => !item.children.some(child => child.kind === 'public')));
});

test('HousePicker恢复社区公区为2级路径，不产生undefined楼栋或不完整告警', () => {
  const publicValue = { locationKind: 'public', communityId: 1, communityName: '一期', fullText: '一期/公共区域' };
  const picked = [];
  const h = harness('HousePicker.tsx', { communities, allowPublicArea: true, publicValue, onPick() {}, onPublicPick: value => picked.push(value) });
  h.render();
  assert.deepEqual(Array.from(h.control.props.value), [1, '__public_area__']);
  h.control.props.onChange([1, '__public_area__']);
  h.control.props.onPicked(publicValue); h.render();
  assert.deepEqual(Array.from(h.control.props.value), [1, '__public_area__']);
  assert.equal(picked.length, 1);
});
