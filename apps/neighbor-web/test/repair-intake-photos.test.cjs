const test = require('node:test');
const assert = require('node:assert/strict');
const { harness, house, publicArea, prefill, text } = require('./new-order-sheet.test.cjs');

const photos = h => h.find('PhotoField');
const submit = h => h.find('button', n => text(n) === '提交报修');
const ready = h => { h.change('问题描述', '大门异响'); };

test('小区公区只提交communityId，照片成功URL进入同一真实创建载荷', async () => {
  const h = harness();
  h.find('HousePicker').props.onPublicPick({ ...publicArea, buildingId: undefined, fullText: '永南150弄/公共区域' }); h.render();
  ready(h); h.change('具体位置', '南门');
  photos(h).props.onChange(['/api/upload/file?key=test.png']); h.render();
  h.click('提交报修');
  const payload = JSON.parse(JSON.stringify(h.requests[0].payload));
  assert.equal(payload.communityId, publicArea.communityId);
  assert.ok(!('buildingId' in payload)); assert.ok(!('houseId' in payload));
  assert.equal(payload.addressText, '永南150弄/公共区域 南门');
  assert.deepEqual(payload.attachments, ['/api/upload/file?key=test.png']);
  h.requests[0].reject(new Error('测试提交失败')); await h.settle();
  assert.equal(h.input('问题描述').props.value, '大门异响');
  assert.deepEqual(photos(h).props.value, ['/api/upload/file?key=test.png']);
});

test('有楼栋和住户时透传原ID，预填仅有地址时不得猜ID', () => {
  for (const choice of ['house', 'building', 'prefill']) {
    const h = harness(choice === 'prefill' ? prefill : null);
    if (choice === 'house') h.find('HousePicker').props.onPick({ ...house, buildingId: 99 });
    if (choice === 'building') h.find('HousePicker').props.onPublicPick(publicArea);
    h.render(); ready(h); h.click('提交报修');
    const p = JSON.parse(JSON.stringify(h.requests[0].payload));
    assert.equal(p.buildingId, choice === 'house' ? 99 : choice === 'building' ? publicArea.buildingId : undefined);
    assert.equal(p.houseId, choice === 'house' ? house.houseId : undefined);
  }
});

test('上传等待和失败未处理时无法提交，照片完成后方可提交', () => {
  const h = harness(prefill); ready(h);
  for (const status of [{uploading:true,failedCount:0}, {uploading:false,failedCount:1}]) {
    photos(h).props.onStatusChange(status); h.render();
    assert.equal(submit(h).props.disabled, true);
    h.click('提交报修');
    assert.equal(h.requests.length, 0);
    assert.match(text(h.find('ErrorNote')), /照片|上传/);
  }
  photos(h).props.onStatusChange({uploading:false,failedCount:0}); h.render();
  assert.equal(submit(h).props.disabled, false);
  photos(h).props.onChange(['/test.png']); h.render(); h.click('提交报修');
  assert.deepEqual(h.requests[0].payload.attachments, ['/test.png']);
});

test('提交未决时不能关闭重开并让旧响应覆盖新草稿，失败后允许关闭', async () => {
  const h = harness(prefill); let closed = 0; h.props.onClose = () => closed++;
  ready(h); h.click('提交报修');
  h.find('Sheet').props.onClose(); assert.equal(closed, 0);
  h.find('button', n => text(n) === '提交中…').props.onClick(); assert.equal(h.requests.length, 1);
  h.requests[0].reject(new Error('可重试')); await h.settle();
  h.find('Sheet').props.onClose(); assert.equal(closed, 1);
  assert.equal(h.input('问题描述').props.value, '大门异响');
});

test('清空/重开更换上传实例，不能保留失败状态或上一单URL', () => {
  const h = harness(prefill); const before = photos(h).key;
  photos(h).props.onChange(['/previous.png']); photos(h).props.onStatusChange({uploading:false,failedCount:1}); h.render();
  h.find('Btn', n => text(n) === '清空').props.onClick(); h.render();
  assert.equal(photos(h).props.value.length, 0);
  assert.notEqual(photos(h).key, before);
  assert.equal(submit(h).props.disabled, false);
  photos(h).props.onChange(['/previous-2.png']); h.render();
  h.props.open = false; h.render(); h.props.open = true; h.render();
  assert.equal(photos(h).props.value.length, 0);
});
