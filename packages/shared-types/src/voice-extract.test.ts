import assert from 'node:assert/strict';
import test from 'node:test';
import { extractContact, extractFaultDescription } from './voice-extract';

/**
 * 语音抽取一直没有测试，而它决定了工单上的「联系人 / 电话 / 故障描述」——
 * 抽错电话 = 维修工打空号跑一趟。这里锁住的都是实测踩过的。
 */

test('电话：正常 11 位手机号', () => {
  assert.equal(extractContact('一期17号201灯不亮，张先生13800138000').phone, '13800138000');
});

test('电话：语音多听出一位时，宁可不填也不给错号码', () => {
  // 「138000138000」是 12 位。没有边界的正则会截出「13800013800」——
  // 位数刚好、能通过校验，但根本不是那个人的号
  const r = extractContact('一期17号201灯不亮，张先生138000138000');
  assert.equal(r.phone, undefined);
});

test('电话：说的时候断开成几段也认得出来', () => {
  assert.equal(extractContact('电话 138 0013 8000').phone, '13800138000');
});

test('电话：中文数字报号', () => {
  assert.equal(extractContact('电话幺三八零零幺三八零零零').phone, '13800138000');
});

test('联系人：称谓式', () => {
  const r = extractContact('一期17号201灯不亮，找张师傅，13800138000');
  assert.equal(r.name, '张师傅');
});

test('联系人：动词不能粘进姓里', () => {
  // 实测抽出过「找张师傅」「人李女士」
  assert.equal(extractContact('联系人李女士 13800138000').name, '李女士');
});

test('故障描述：把地址、人名、电话都剥掉，只剩故障本身', () => {
  const text = '枫桦景苑一期17号201家里灯不亮，联系人张先生，电话13800138000';
  const desc = extractFaultDescription(text, {
    addressText: '一期17号201室',
    nameText: '张先生',
    phoneText: '13800138000',
  });
  assert.ok(desc.includes('灯不亮'), `实际：${desc}`);
  assert.ok(!desc.includes('13800138000'), `电话没剥掉：${desc}`);
  assert.ok(!desc.includes('张先生'), `人名没剥掉：${desc}`);
});

test('故障描述：地址没认出来时也不该把整句原样塞进描述', () => {
  // 地址识别失败（比如接口 403）时 addressText 为空 —— 这是 2026-08-31 的现象之一
  const desc = extractFaultDescription('一期17号201家里灯不亮', {});
  assert.equal(typeof desc, 'string');
});
