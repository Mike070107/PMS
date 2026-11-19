const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const code = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../src/lib/vehicle-intake-operation.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
function fixture(storage = new Map()) {
  let next = 0;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports,
    crypto: { randomUUID: () => `synthetic_operation_${++next}` },
    sessionStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
  });
  return { operation: module.exports.vehicleIntakeOperation, storage };
}
test('ambiguous failure and page reload retain the original operation key', () => {
  const a = fixture();
  const first = a.operation(5, 'paid');
  assert.equal(a.operation(5, 'paid').operationKey, first.operationKey);
  assert.equal(fixture(a.storage).operation(5, 'paid').operationKey, first.operationKey);
  assert.equal(a.storage.size, 1, 'no finally/catch rotation');
  first.resolve();
  assert.equal(a.storage.size, 0);
  assert.notEqual(a.operation(5, 'paid').operationKey, first.operationKey);
});
test('house, workflow and confirmed another-vehicle action have independent persisted identities', () => {
  const { operation } = fixture();
  const operations = [operation(5, 'paid'), operation(6, 'paid'), operation(5, 'family'), operation(5, 'paid', true)];
  assert.equal(new Set(operations.map(o => o.operationKey)).size, 4);
  assert.equal(operations[3].anotherVehicle, true);
  assert.equal(operation(5, 'paid', true).operationKey, operations[3].operationKey);
});
test('late successful response cannot remove a newer pending operation', () => {
  const { operation, storage } = fixture();
  const first = operation(5, 'paid');
  first.resolve();
  const second = operation(5, 'paid');
  first.resolve();
  assert.equal(storage.size, 1);
  assert.equal(operation(5, 'paid').operationKey, second.operationKey);
});
