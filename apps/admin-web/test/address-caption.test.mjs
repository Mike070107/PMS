import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const requireApi = createRequire(new URL('../../api/package.json', import.meta.url));
const ts = requireApi('typescript');
const shared = {};
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../../../packages/shared-types/src/address.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText, { exports: shared });

// Extract actual pure display functions, not a parallel implementation or a live React/API app.
function loadFunction(relative, name) {
  const source = readFileSync(new URL(relative, import.meta.url), 'utf8');
  const file = ts.createSourceFile(relative, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const node = file.statements.find(n => n.name?.text === name || n.declarationList?.declarations.some(d => d.name.text === name));
  assert.ok(node, `Missing actual function ${name}`);
  const exports = {};
  vm.runInNewContext(ts.transpileModule(node.getText(file) + `\nexports.fn = ${name};`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, { exports, dedupeAddressText: shared.dedupeAddressText });
  return exports.fn;
}
const splitCaption = loadFunction('../src/pages/QrPage.tsx', 'splitCaption');
const place = loadFunction('../../neighbor-web/src/pages/Fees.tsx', 'place');
for (const communityName of ['永南150弄', '永北150弄']) {
  test(`旧/新二维码及收费流水统一去重但不丢社区：${communityName}`, () => {
    for (const caption of [null, `${communityName} 150弄6号 · 扫码报修`]) {
      const result = splitCaption({ communityName, buildingText: '150弄6号', qr: { caption } });
      assert.equal(result.title, `${communityName}6号`);
      assert.equal(result.sub, '扫码报修');
    }
    assert.equal(place({ communityName, lane: '150', buildingNo: '6', roomNo: '201' }), `${communityName} 6号 201`);
  });
}
test('流水不同弄号、房号保持完整', () => {
  assert.equal(place({ communityName: '永南1150弄', lane: '150', buildingNo: '6', roomNo: '201' }), '永南1150弄 150弄 6号 201');
});
