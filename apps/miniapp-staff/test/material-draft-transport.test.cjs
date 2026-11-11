const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const apiRequire = createRequire(path.resolve(__dirname, '../../api/package.json'));
const ts = apiRequire('typescript');

test('微信真实请求层：用料草稿使用支持的请求方法，保存备注并刷新重读', async () => {
  const cache = new Map();
  let stored = { version: 0, rows: [] };
  const sent = [];
  const wx = { request(options) {
    sent.push({ method: options.method, url: options.url });
    if (options.method === 'PUT') stored = { version: stored.version + 1, rows: options.data.rows };
    options.success({ statusCode: 200, data: stored });
  } };
  function load(filename) {
    if (cache.has(filename)) return cache.get(filename);
    const exports = {};
    cache.set(filename, exports);
    const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText;
    vm.runInNewContext(code, { exports, wx, console, setTimeout, clearTimeout,
      require: name => {
        if (name === './compress') return {};
        if (name === '@pms/shared-types') return {};
        if (name.startsWith('.')) return load(path.resolve(path.dirname(filename), name + '.ts'));
        throw new Error(name);
      },
    });
    return exports;
  }
  const root = path.resolve(__dirname, '../../../packages/api-client/src');
  const { configure } = load(path.join(root, 'request.ts'));
  const repairs = load(path.join(root, 'endpoints/repairs.ts'));
  configure({ baseURL: 'https://fixture.invalid/api/v1', getToken: () => 'isolated' });
  const rows = [{ materialId: 1, warehouseId: 2, name: '示例电源', qty: 1, note: '住户门口更换' }];
  const saved = await repairs.saveMaterialDraft(9, { version: 0, rows });
  assert.equal(saved.version, 1);
  assert.equal(saved.rows[0].note, rows[0].note);
  assert.equal((await repairs.materialDraft(9)).rows[0].note, rows[0].note);
  assert.deepEqual(sent.map(value => value.method), ['PUT', 'GET']);
  assert.equal(sent[0].url, 'https://fixture.invalid/api/v1/work-orders/9/material-draft');
});
