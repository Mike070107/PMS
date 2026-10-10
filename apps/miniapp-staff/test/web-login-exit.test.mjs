import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(
  new URL('../miniprogram/pages/web-login/web-login.ts', import.meta.url),
  'utf8',
);
const template = readFileSync(
  new URL('../miniprogram/pages/web-login/web-login.wxml', import.meta.url),
  'utf8',
);

test('确认登录成功后安排自动关闭，拒绝登录不自动关闭', () => {
  const confirmBody = section('async onConfirm()', 'async onCancel()');
  const cancelBody = section('async onCancel()', 'scheduleAutoClose()');

  assert.match(confirmBody, /scheduleAutoClose/);
  assert.doesNotMatch(cancelBody, /scheduleAutoClose/);
});

test('结果页提供关闭小程序按钮，但不会把内网应用用户送入 PMS 首页', () => {
  assert.match(source, /wx\.exitMiniProgram/);
  assert.match(template, /bindtap="onCloseMiniProgram"/);
  assert.match(template, />关闭小程序</);
  assert.doesNotMatch(template, /onBackHome|返回首页/);
});

test('退出能力失败时向用户展示可执行的关闭提示', () => {
  assert.match(source, /closeHint/);
  assert.match(template, /\{\{closeHint\}\}/);
  assert.match(source, /右上角/);
});

test('确认页保留应用与域名校验信息，但不再要求人工核对四位码', () => {
  assert.match(template, /applicationHostname/);
  assert.doesNotMatch(template, /confirmationCode|核对码/);
});

test('首次绑定保留输入错误反馈并支持显示或隐藏密码', () => {
  assert.match(source, /onBindAndConfirm/);
  assert.match(source, /bindingPassword: ''/);
  assert.match(template, /公寓系统用户名/);
  assert.match(template, /公寓系统密码/);
  assert.match(template, /onTogglePassword/);
  assert.match(template, /\{\{bindingError\}\}/);
});

function section(start, end) {
  const startAt = source.indexOf(start);
  const endAt = source.indexOf(end, startAt + start.length);
  assert.notEqual(startAt, -1, `missing section start: ${start}`);
  assert.notEqual(endAt, -1, `missing section end: ${end}`);
  return source.slice(startAt, endAt);
}
