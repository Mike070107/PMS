import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const ts = createRequire(new URL('../../api/package.json', import.meta.url))('typescript');
const exports = {};
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/lib/wechatLaunch.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports });
test('只允许有效票据通过微信官方 Scheme 唤起，过期和取消立即失效', () => {
  const url = 'weixin://dl/business/?t=test';
  assert.equal(exports.wechatLaunchHref(url, 'pending', false, 2000, 1000), url);
  assert.equal(exports.wechatLaunchHref(url, 'scanned', false, 2000, 1000), url);
  for (const status of ['expired', 'cancelled']) assert.equal(exports.wechatLaunchHref(url, status, false, 2000, 1000), undefined);
  assert.equal(exports.wechatLaunchHref(url, 'pending', true, 2000, 1000), undefined);
  assert.equal(exports.wechatLaunchHref(url, 'pending', false, 2000, 2000), undefined);
  for (const invalid of [null, '', 'javascript:alert(1)', 'https://example.com', 'weixin://other']) assert.equal(exports.wechatLaunchHref(invalid, 'pending', false, 2000, 1000), undefined);
});
