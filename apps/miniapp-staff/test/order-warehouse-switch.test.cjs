const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '../../..');
const dir = path.join(root, 'apps/miniapp-staff/miniprogram/pages/order-detail');
const ts = createRequire(path.join(root, 'apps/api/package.json'))('typescript');
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(count = 12) {
  let definition;
  const calls = [], actionErrors = [];
  const warehouses = Array.from({ length: count }, (_, i) => ({ id: i + 1, name: i === 0 ? '智能化维修工仓库' : `第${i + 1}仓库`, own: i === 0, hasStock: i !== 10 }));
  const f = { calls, actionErrors, warehouses, fail: false, wait: null };
  const repairs = { async stockOptions(id, warehouseId) {
    calls.push({ id, warehouseId }); if (f.wait) await f.wait; if (f.fail) throw Error('网络暂不可用');
    const warehouse = warehouses.find(w => w.id === (warehouseId || 1));
    return { warehouseId: warehouse?.id || null, warehouseName: warehouse?.name || '', warehouses, items: warehouse?.hasStock ? [{ materialId: warehouse.id * 10, name: '交换机', spec: '16口 百兆', code: 'ZNH-0003', category: '智能化', qty: warehouse.id, unit: '台' }] : [] };
  } };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(dir, 'order-detail.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, {
    exports: {}, Page: value => { definition = value; }, requirePlugin: () => { throw Error('isolated fixture'); }, console, setTimeout, clearTimeout,
    require: name => name === '@pms/api-client' ? { repairs } : name.endsWith('/guide') ? { guideHandlers: () => ({}) } : name.endsWith('/navigation') ? { swipeBackHandlers: () => ({}), goBack: () => { f.back = true; } } : {},
    wx: { showActionSheet(options) { // WeChat itemList has a six-item upper bound.
      if (options.itemList.length > 6) { const err = { errMsg: 'showActionSheet:fail itemList.length should not be larger than 6' }; actionErrors.push(err); options.fail?.(err); }
      else options.success?.({ tapIndex: 0 });
    } },
  });
  f.ctx = { ...definition, data: { ...JSON.parse(JSON.stringify(definition.data)), id: 'isolated-order', skuOpen: true, panel: 'material' }, setData(patch, done) { Object.assign(this.data, patch); done?.(); } };
  return f;
}
const pick = value => ({ detail: { value: String(value) } });

test('超过六个仓库：选择第12仓后确实按该仓请求库存并刷新标题/数量，不再静默失败', async () => {
  const f = fixture(); await f.ctx.loadSkus(); f.ctx.data.skuKeyword = '旧搜索';
  await f.ctx.onSwitchWarehouse(pick(11)); await tick();
  assert.equal(f.actionErrors.length, 0, 'must not hit showActionSheet six-item limit');
  assert.equal(f.calls.at(-1).warehouseId, 12);
  assert.equal(f.ctx.data.skuWarehouseId, 12); assert.equal(f.ctx.warehouseId, 12);
  assert.equal(f.ctx.data.skuTitle, '第12仓库库存'); assert.equal(f.ctx.data.skuList[0].qty, 12);
  assert.equal(f.ctx.data.skuKeyword, ''); assert.equal(f.ctx.data.skuWarehouseIndex, 11);
  assert.equal(f.ctx.data.skuWarehouseNames.length, 12);
  assert.match(f.ctx.data.skuWarehouseNames[0], /本单默认/); assert.match(f.ctx.data.skuWarehouseNames[10], /暂无库存/);
});

test('原生选择器两个入口均支持完整列表和当前仓库定位，无仓/加载时禁用', () => {
  const wxml = fs.readFileSync(path.join(dir, 'order-detail.wxml'), 'utf8');
  const pickers = [...wxml.matchAll(/<picker\b[^>]*bindchange="onSwitchWarehouse"[^>]*>[\s\S]*?<\/picker>/g)].map(m => m[0]);
  assert.equal(pickers.length, 2, 'header change and no-warehouse choose must share native selector');
  for (const picker of pickers) { assert.match(picker, /range="\{\{skuWarehouseNames\}\}"/); assert.match(picker, /value="\{\{skuWarehouseIndex\}\}"/); assert.match(picker, /disabled="\{\{[^}]*skuLoading/); }
  assert.doesNotMatch(wxml, /bindtap="onSwitchWarehouse"/);
});

test('少量仓库、同仓、非法索引、空仓库和加载中：不误请求/不丢用料草稿', async () => {
  const f = fixture(2); await f.ctx.loadSkus();
  const draft = [{ name: '已选材料', qty: '3' }]; f.ctx.data.materialRows = draft;
  for (const value of [0, -1, 99, 'not-a-number']) await f.ctx.onSwitchWarehouse(pick(value));
  assert.equal(f.calls.length, 1);
  f.ctx.data.skuLoading = true; await f.ctx.onSwitchWarehouse(pick(1)); assert.equal(f.calls.length, 1);
  f.ctx.data.skuLoading = false; await f.ctx.onSwitchWarehouse(pick(1)); await tick(); assert.equal(f.calls.at(-1).warehouseId, 2);
  assert.equal(f.ctx.data.materialRows, draft);
  f.ctx.onCloseSku(); assert.equal(f.ctx.data.skuOpen, false); assert.equal(f.ctx.data.panel, 'material');
  assert.equal(f.ctx.data.materialRows, draft);
  const empty = fixture(0); await empty.ctx.loadSkus(); await empty.ctx.onSwitchWarehouse(pick(0)); assert.equal(empty.calls.length, 1);
});

test('等待与请求失败可见；失败不更改已选仓库/用料，重试成功可刷新；空仓提示正确', async () => {
  const f = fixture(); await f.ctx.loadSkus();
  let release; f.wait = new Promise(resolve => { release = resolve; });
  f.fail = true; const pending = f.ctx.onSwitchWarehouse(pick(7));
  assert.equal(f.ctx.data.skuLoading, true); release(); await pending; await tick();
  assert.equal(f.ctx.data.skuLoading, false); assert.equal(f.ctx.data.skuError, '网络暂不可用'); assert.equal(f.ctx.data.skuWarehouseId, 1);
  f.fail = false; f.wait = null; await f.ctx.onSwitchWarehouse(pick(7)); await tick();
  assert.equal(f.ctx.data.skuWarehouseId, 8); assert.equal(f.ctx.data.skuError, '');
  await f.ctx.onSwitchWarehouse(pick(10)); await tick();
  assert.equal(f.ctx.data.skuWarehouseId, 11); assert.equal(f.ctx.data.skuList.length, 0); assert.match(f.ctx.data.skuEmptyHint, /一件货都没有/);
});
module.exports = { fixture };
