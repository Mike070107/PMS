import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(
  new URL('../miniprogram/pages/web-login/web-login.ts', import.meta.url),
  'utf8',
);
const template = readFileSync(
  new URL('../miniprogram/pages/web-login/web-login.wxml', import.meta.url),
  'utf8',
);

test('确认成功后定时退出，取消和确认失败时保持结果页', async () => {
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  for (const outcome of ['confirmed', 'cancelled', 'failed']) {
    let page, timer;
    let exits = 0;
    const auth = {
      qrLoginConfirm: async () => { if (outcome === 'failed') throw new Error('确认失败'); },
      qrLoginCancel: async () => {},
    };
    vm.runInNewContext(compiled, {
      exports: {}, require: () => ({ auth }), Page: definition => { page = definition; },
      setTimeout: callback => { timer = callback; return 1; }, clearTimeout() {},
      wx: { exitMiniProgram: () => { exits++; } },
    });
    page.setData = patch => Object.assign(page.data, patch);
    if (outcome === 'cancelled') await page.onCancel();
    else await page.onConfirm();
    assert.equal(page.data.done, outcome === 'failed' ? '' : outcome);
    assert.equal(exits, 0);
    if (outcome === 'confirmed') { timer(); assert.equal(exits, 1); }
    else assert.equal(timer, undefined);
  }
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
