import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeRequirements } from './require-permission.decorator';

/**
 * 这组测试锁的是一个悄悄断了很久的 bug（2026-08-26 拆端 → 08-31 才发现）：
 * 提交报修的接口写了 `RequirePermission(['work-orders','app:repair-create'], 'edit')`，
 * 而「报修」这一格在权限矩阵里**根本没有编辑档**（STAFF_APP_PAGES 里它没有 editLabel），
 * 于是维修工 / 保安 / 居委会 / 业委会这些**专门用来代报**的角色一个都提交不了报修。
 */

test('普通数组：每个 key 都用默认动作', () => {
  const r = normalizeRequirements(['work-orders', 'app:pool'], 'edit');
  assert.deepEqual(r.items, [
    { pageKey: 'work-orders', action: 'edit' },
    { pageKey: 'app:pool', action: 'edit' },
  ]);
});

test('单个 key 也归一成一条', () => {
  assert.deepEqual(normalizeRequirements('properties', 'view').items, [
    { pageKey: 'properties', action: 'view' },
  ]);
});

test('元组混写：各 key 的动作互不串味（提交报修就是这么配的）', () => {
  const r = normalizeRequirements(
    [['work-orders', 'edit'], ['app:repair-create', 'view']],
    'edit',
  );
  assert.deepEqual(r.items, [
    { pageKey: 'work-orders', action: 'edit' },
    { pageKey: 'app:repair-create', action: 'view' },
  ]);
});

test('单个元组不被当成两个 key', () => {
  assert.deepEqual(normalizeRequirements(['work-orders', 'edit'] as const, 'view').items, [
    { pageKey: 'work-orders', action: 'edit' },
  ]);
});

/** 「view / edit / delete」是动作词，同名页面 key 不存在，所以这个判据是安全的 */
test('两个普通 key 不会被误判成元组', () => {
  const r = normalizeRequirements(['work-orders', 'properties'], 'view');
  assert.equal(r.items.length, 2);
});
