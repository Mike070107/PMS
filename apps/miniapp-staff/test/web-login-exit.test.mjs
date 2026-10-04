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

test('结果页提供关闭小程序按钮，并保留返回首页兜底', () => {
  assert.match(source, /wx\.exitMiniProgram/);
  assert.match(template, /bindtap="onCloseMiniProgram"/);
  assert.match(template, />关闭小程序</);
  assert.match(template, /bindtap="onBackHome"/);
});

test('退出能力失败时向用户展示可执行的关闭提示', () => {
  assert.match(source, /closeHint/);
  assert.match(template, /\{\{closeHint\}\}/);
  assert.match(source, /右上角/);
});

function section(start, end) {
  const startAt = source.indexOf(start);
  const endAt = source.indexOf(end, startAt + start.length);
  assert.notEqual(startAt, -1, `missing section start: ${start}`);
  assert.notEqual(endAt, -1, `missing section end: ${end}`);
  return source.slice(startAt, endAt);
}
