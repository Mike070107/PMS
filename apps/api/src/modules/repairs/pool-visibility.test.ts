import assert from 'node:assert/strict';
import test from 'node:test';
import { poolTypeScopes, type PoolCommunityLike, type PoolRuleLike } from './pool-visibility';

/**
 * 2026-09-08 Mike 的分工：总公司维修工只管智能化 / 防水（各小区都找他们），
 * 水 / 电 / 木工默认只由本管理处的维修工修，疑难杂症等办公室指派。
 * 这里锁的是「谁在哪个小区能看到哪些类型的待接单」。
 *
 * A = 总公司维修工（数据范围全公司），B = 枫桦景苑维修工。
 * 办公室 1 = 枫桦景苑管理处，办公室 2 = 永德管理处。
 */
const A = 101;
const B = 202;

const rule = (
  repairType: string,
  officeId: number | null,
  assigneeIds: number[],
  enabled = true,
): PoolRuleLike => ({ repairType, officeId, enabled, assigneeId: null, assigneeIds });

const communities: PoolCommunityLike[] = [
  { id: 11, officeId: 1, parentId: null }, // 枫桦景苑
  { id: 12, officeId: null, parentId: 11 }, // 枫桦景苑二期（跟父级的管理处）
  { id: 21, officeId: 2, parentId: null }, // 永德
  { id: 31, officeId: null, parentId: null }, // 还没挂管理处的小区 → 走公司模板
];

test('总公司维修工：智能化各处都看得到，电相关只在把他列进去的那个管理处看得到', () => {
  const rules = [
    // 枫桦有自己的一套：智能化列了 A（总公司），电相关只列 B
    rule('menjing', 1, [A]),
    rule('electric', 1, [B]),
    // 永德也有自己的一套：智能化列了 A，电相关也列了 A（这个处没有自己的电工）
    rule('menjing', 2, [A]),
    rule('electric', 2, [A]),
  ];
  const scopes = poolTypeScopes(A, rules, communities, null);
  const typesOf = (communityId: number) =>
    scopes.find((item) => item.communityIds.includes(communityId))?.types.slice().sort() ?? [];
  // 枫桦（含二期子小区）：A 只看得到智能化，看不到电相关
  assert.deepEqual(typesOf(11), ['menjing']);
  assert.deepEqual(typesOf(12), ['menjing']);
  // 永德：A 两类都看得到
  assert.deepEqual(typesOf(21), ['electric', 'menjing']);
});

test('本管理处维修工只看本处：枫桦的 B 在永德什么都看不到', () => {
  const rules = [rule('electric', 1, [B]), rule('electric', 2, [A])];
  const scopes = poolTypeScopes(B, rules, communities, null);
  const ids = scopes.flatMap((item) => item.communityIds).sort((x, y) => x - y);
  assert.deepEqual(ids, [11, 12]);
  assert.deepEqual(scopes[0].types, ['electric']);
});

test('管理处有自己的一套就完全不看公司模板（哪怕模板里列了这个人）', () => {
  const rules = [
    rule('water', null, [A]), // 公司模板：A 管水
    rule('menjing', 1, [A]), // 枫桦自己的一套里没有 water
    rule('water', 1, [B], false), // 枫桦把 water 停用了，也仍算「有自己的一套」
  ];
  const scopes = poolTypeScopes(A, rules, communities, null);
  const typesOf = (communityId: number) =>
    scopes.find((item) => item.communityIds.includes(communityId))?.types.slice().sort() ?? [];
  assert.deepEqual(typesOf(11), ['menjing']);
  // 永德没有自己的一套 → 退回模板，A 管水
  assert.deepEqual(typesOf(21), ['water']);
  // 没挂管理处的小区也走模板
  assert.deepEqual(typesOf(31), ['water']);
});

test('数据范围之外的小区一个都不带出来；一条规则都没列到我时返回空', () => {
  const rules = [rule('menjing', 1, [A]), rule('menjing', 2, [A])];
  const scoped = poolTypeScopes(A, rules, communities, [21]);
  assert.deepEqual(scoped.flatMap((item) => item.communityIds), [21]);
  assert.deepEqual(poolTypeScopes(999, rules, communities, null), []);
});

test('停用的规则不算数', () => {
  const rules = [rule('menjing', 1, [A], false)];
  assert.deepEqual(poolTypeScopes(A, rules, communities, null), []);
});
