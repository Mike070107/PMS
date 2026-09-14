import assert from 'node:assert/strict';
import test from 'node:test';
import { acceptMergedSpeech } from './repair-speech-merge.ai';

/**
 * 多段口述合并的收口闸门。模型输出什么样都可能，这一层决定「敢不敢用」——
 * 不敢用就退回原来的拼接，用户至少不会白说一遍。
 */

const THREE = ['一期43号大门坏了', '198弄44号202报修大门坏了', '说错了是一期40号大门坏'];

test('像样的归纳：比拼起来短、信息还在 —— 采用', () => {
  assert.equal(acceptMergedSpeech(THREE, '一期40号大门坏了'), '一期40号大门坏了');
});

test('只有一段不合并', () => {
  assert.equal(acceptMergedSpeech(['一期40号大门坏了'], '一期40号大门坏了'), null);
});

test('模型把几段原样拼回来（没变短）= 没合并，不采用', () => {
  assert.equal(acceptMergedSpeech(THREE, THREE.join('，')), null);
  // 比拼接还长的一律是模型自己加了内容
  assert.equal(acceptMergedSpeech(THREE, THREE.join('，') + '，请尽快处理'), null);
});

test('短得不像话 = 信息被丢了（地址没了），不采用', () => {
  assert.equal(acceptMergedSpeech(THREE, '大门'), null);
});

test('空结果、空白一律不采用', () => {
  assert.equal(acceptMergedSpeech(THREE, ''), null);
  assert.equal(acceptMergedSpeech(THREE, '   '), null);
  assert.equal(acceptMergedSpeech(THREE, null), null);
});

test('补充型（后面只补联系人）也算数：仍然比拼接短就采用', () => {
  const segs = ['枫桦一期17号201家里灯不亮', '哦对了联系人是张先生电话13800138000'];
  assert.equal(
    acceptMergedSpeech(segs, '枫桦一期17号201家里灯不亮，联系人张先生13800138000'),
    '枫桦一期17号201家里灯不亮，联系人张先生13800138000',
  );
});
