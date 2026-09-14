import assert from 'node:assert/strict';
import test from 'node:test';
import { hanziInitial, nameToInitials } from './pinyin-initials';

/**
 * 账号是发给人用的，认错一个字母他就登不进去。这里锁的是「常见姓名必须对」，
 * 以及「认不出来时返回空串，绝不编一个字母出来」。
 */

test('常见姓名取首字母', () => {
  assert.equal(nameToInitials('赵丽萍'), 'zlp');
  assert.equal(nameToInitials('叶双'), 'ys');
  assert.equal(nameToInitials('李建国'), 'ljg');
  assert.equal(nameToInitials('王建军'), 'wjj');
  assert.equal(nameToInitials('徐余平'), 'xyp');
  assert.equal(nameToInitials('欧阳明'), 'oym');
  assert.equal(nameToInitials('孔赟'), 'ky');
});

test('姓氏多音字按姓氏的读音，且只管第一个字', () => {
  // 「曾」排序在 c（曾经），做姓念 Zēng
  assert.equal(nameToInitials('曾国藩'), 'zgf');
  assert.equal(nameToInitials('单田芳'), 'stf');
  assert.equal(nameToInitials('解晓东'), 'xxd');
  assert.equal(nameToInitials('查文斌'), 'zwb');
  assert.equal(nameToInitials('翟志刚'), 'zzg');
  // 名字里的「乐」不是姓，仍按常用读音 lè
  assert.equal(nameToInitials('张乐'), 'zl');
  // 「乐」在姓上才按 Yuè
  assert.equal(nameToInitials('乐嘉'), 'yj');
});

test('中英混写和标点', () => {
  assert.equal(nameToInitials('Anna 王'), 'annaw');
  assert.equal(nameToInitials('李 明'), 'lm');
  // 买m 买m 提t 吐t 尔e 逊x
  assert.equal(nameToInitials('买买提·吐尔逊'), 'mmttex');
  assert.equal(nameToInitials('Tom'), 'tom');
});

test('认不出来就返回空串，不编字母', () => {
  assert.equal(nameToInitials(''), '');
  assert.equal(nameToInitials('   '), '');
  assert.equal(nameToInitials('···'), '');
  assert.equal(hanziInitial('A'), '');
  assert.equal(hanziInitial('7'), '');
});
