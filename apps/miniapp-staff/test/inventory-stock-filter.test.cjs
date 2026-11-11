const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const req = createRequire(path.resolve(__dirname, '../../api/package.json'));
const ts = req('typescript');

function fixture() {
  let config;
  const source = fs.readFileSync(path.resolve(__dirname, '../miniprogram/pages/inventory/inventory.ts'), 'utf8');
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, {
    exports: {}, Page: value => { config = value; }, require: name => name === '@pms/shared-types' ? { PurchaseRequestStatus: {}, MATERIAL_UNITS: [] } : { guideHandlers: () => ({}) }, console,
  });
  const page = { ...config, data: { ...config.data, warehouses: [{ id: 2 }], warehouseNames: ['全部仓库', '智能化维修工仓库'], warehouseIndex: 1 }, setData(value, callback) { Object.assign(this.data, value); callback?.(); } };
  page.materials = [1, 2].map(id => ({ id, name: id === 1 ? '电子浮球阀' : '电源', code: `M${id}`, enabled: true, photoUrls: [], aliases: [] }));
  page.sumStock = id => ({ found: true, qty: id === 1 ? 0 : 3, safetyQty: 1 });
  page.workShortageMaterialIds = () => new Set();
  page.buildRow = (m, qty, safetyQty) => ({ materialId: m.id, name: m.name, qty, low: qty <= safetyQty });
  return page;
}

test('库存默认隐藏转出后为零的材料，可显示并再次隐藏，补货概览仍含零库存', () => {
  const page = fixture();
  page.applyFilter();
  assert.equal(page.data.onlyStocked, true);
  assert.deepEqual(Array.from(page.data.rows, r => r.materialId), [2]);
  assert.equal(page.data.overviewOutCount, 1);
  page.onToggleStocked({ detail: { value: [] } });
  assert.equal(page.data.rows.length, 2);
  page.onToggleStocked({ detail: { value: ['1'] } });
  assert.equal(page.data.rows.length, 1);
  page.onToggleLow();
  assert.deepEqual(Array.from(page.data.rows, r => r.materialId), [1]);
});
