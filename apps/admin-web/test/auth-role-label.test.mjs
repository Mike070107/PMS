import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const ts = createRequire(new URL('../../api/package.json', import.meta.url))('typescript');
test('刷新实际业务角色名同步登录用户，不改身份权限或其他用户缓存', () => {
  const storage = () => { const data = new Map(); return { getItem: k => data.get(k) ?? null, setItem: (k,v) => data.set(k,v), removeItem: k => data.delete(k) }; };
  const exports = {};
  const sessionStorage = storage();
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/lib/auth.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, {
    exports, require: () => ({ useSyncExternalStore: () => {} }), window: { sessionStorage, addEventListener: () => {} }, localStorage: storage(),
  });
  exports.auth.setSession('test-token', { id: '7', role: 'manager', name: '用户' });
  exports.auth.updateRoleNames(7, ['办公室管理员']);
  assert.equal(exports.auth.getUser().roleNames.join(' · '), '办公室管理员');
  assert.equal(exports.auth.getUser().role, 'manager');
  assert.equal(exports.auth.getToken(), 'test-token');
  exports.auth.updateRoleNames(9, ['其他人']);
  assert.equal(exports.auth.getUser().roleNames.join(' · '), '办公室管理员');
});
