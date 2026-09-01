import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTypeKeywords, classifyByKeywords } from './repair-classify.util';
import { SEED_CONTENT_SUGGESTIONS } from './repair-suggestions.util';
import { DEFAULT_REPAIR_TYPES } from './repair-type-labels';
import { classifyRepairType } from '../../../../../packages/shared-types/src/repair-classify';

/**
 * 判错类型 = 派错工种，师傅白跑一趟。这里锁的是「新租户刚开张、一个字都没配」
 * 的默认词表下的判定结果 —— 关键词由种子短语 + 类型名 + 同义词叠出来。
 */
const types = DEFAULT_REPAIR_TYPES.map((item) => ({
  repairType: item.repairType,
  label: item.label,
  keywords: buildTypeKeywords({
    label: item.label,
    contentSuggestions: SEED_CONTENT_SUGGESTIONS[item.repairType] ?? [],
  }),
}));

const classify = (text: string) => classifyByKeywords(text, types);

test('小区大门那套电控门归智能化，不是修家里门锁的木工', () => {
  // 2026-08-31 用户报的原话：以前一个关键词都没撞上，整单落到「其它」
  assert.equal(classify('电子门旋转打滑'), 'smart');
  assert.equal(classify('一期大门电子门打不开'), 'smart');
  assert.equal(classify('自动门感应不灵'), 'smart');
  assert.equal(classify('旋转门转不动'), 'smart');
});

test('门禁 / 对讲 / 监控 / 道闸 仍然归智能化', () => {
  assert.equal(classify('门禁刷不开'), 'smart');
  assert.equal(classify('可视对讲无画面'), 'smart');
  assert.equal(classify('监控看不了'), 'smart');
  assert.equal(classify('道闸不抬杆'), 'smart');
});

test('明确的门铃设备词压过门窗类型的模糊片段', () => {
  const hit = classifyRepairType('枫桦景苑二期25号303家里门铃打不开门', types);
  assert.equal(hit?.repairType, 'smart');
  assert.ok(hit?.matched.includes('门铃'));
});

test('加了电控门的词之后，家里门窗那几类没被抢走', () => {
  assert.equal(classify('家里门锁打不开'), 'door_window');
  assert.equal(classify('窗户玻璃破了'), 'door_window');
  assert.equal(classify('楼道灯不亮'), 'electric');
  assert.equal(classify('电梯困人'), 'elevator');
  assert.equal(classify('厨房水龙头漏水'), 'water');
});
