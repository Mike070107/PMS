import assert from 'node:assert/strict';
import test from 'node:test';
import {
  generatePassword,
  normalizeAccountBase,
  pickAvailableAccount,
} from './credentials.util';

test('账号只留小写字母数字，认不出来时兜底', () => {
  assert.equal(normalizeAccountBase('ZLP'), 'zlp');
  assert.equal(normalizeAccountBase('l.m-2'), 'lm2');
  assert.equal(normalizeAccountBase(''), 'user');
  assert.equal(normalizeAccountBase('···'), 'user');
});

test('重名依次加 01、02、03', () => {
  assert.equal(pickAvailableAccount('zlp', []), 'zlp');
  assert.equal(pickAvailableAccount('zlp', ['zlp']), 'zlp01');
  assert.equal(pickAvailableAccount('zlp', ['zlp', 'zlp01']), 'zlp02');
  // 中间空出来的号补回去，别一路往后跳
  assert.equal(pickAvailableAccount('zlp', ['zlp', 'zlp02']), 'zlp01');
});

test('占用判断不分大小写、忽略空白', () => {
  assert.equal(pickAvailableAccount('zlp', [' ZLP ']), 'zlp01');
});

test('前缀相同但不是同一串的不算占用', () => {
  // zlpa 不挡 zlp
  assert.equal(pickAvailableAccount('zlp', ['zlpa', 'zlping']), 'zlp');
});

test('99 个以后继续往下给，不会卡死', () => {
  const taken = ['zlp'];
  for (let i = 1; i <= 99; i += 1) taken.push(`zlp${String(i).padStart(2, '0')}`);
  assert.equal(pickAvailableAccount('zlp', taken), 'zlp100');
});

test('初始密码：8 位、避开易混字符、每次都不一样', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 200; i += 1) {
    const pwd = generatePassword();
    assert.equal(pwd.length, 8, pwd);
    // 0/o/O、1/l/I 一律不出现，管理员抄给人时不会认错
    assert.ok(!/[0o1lLiI]/.test(pwd), `不该出现易混字符：${pwd}`);
    assert.ok(/^[a-z]{4}\d{4}$/.test(pwd), `格式应为 4 字母 + 4 数字：${pwd}`);
    seen.add(pwd);
  }
  assert.ok(seen.size > 150, `随机性不足，200 次只出了 ${seen.size} 种`);
});
