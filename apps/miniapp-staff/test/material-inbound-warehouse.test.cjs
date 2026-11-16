const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '../../..');
const ts = createRequire(path.join(root, 'apps/api/package.json'))('typescript');
function fixture(confirm = true) {
  let definition; const requests = [], dialogs = [];
  const inventory = { createGeneralReceipt: async body => { requests.push(body); return { receiptNo: 'TEST' }; }, createGoodsReceipt: async body => { requests.push(body); return { receiptNo: 'TEST-PO' }; }, listWarehouseLocations: async () => [] };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(root, 'apps/miniapp-staff/miniprogram/pages/material-inbound/material-inbound.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, {
    exports: {}, Page: value => definition = value, requirePlugin: () => { throw Error('no speech'); },
    require: name => name === '@pms/api-client' ? { inventory } : name === '@pms/shared-types' ? { MATERIAL_UNITS: ['个'] } : name.endsWith('/guide') ? { guideHandlers: () => ({}) } : {},
    wx: { showModal: options => { dialogs.push(options); if (options.title === '确认入库仓库') options.success({ confirm }); }, showToast: () => {}, navigateBack: () => {} },
  });
  const ctx = { ...definition, materials: [], stocks: [], data: { ...JSON.parse(JSON.stringify(definition.data)), selected: { materialId: 7, title: '隔离材料', unit: '个' }, warehouses: [{ id: 83, name: '甲仓', enabled: true }, { id: 12, name: '乙仓', enabled: true }], warehouseNames: ['甲仓', '乙仓'], inboundForm: { qty: '2', priceYuan: '3', sourceText: '隔离测试' } }, setData(patch, cb) { Object.assign(this.data, patch); cb?.(); } };
  return { ctx, requests, dialogs };
}
test('未选择/索引伪造/列表重排均不能默默提交到首仓', async () => {
  const { ctx, requests } = fixture();
  await ctx.onSubmitInbound(); assert.equal(requests.length, 0);
  ctx.data.warehouseIndex = 0; await ctx.onSubmitInbound(); assert.equal(requests.length, 0);
  ctx.onPickWarehouse({ currentTarget: { dataset: { index: 1 } } });
  assert.equal(ctx.data.selectedWarehouseId, 12); assert.equal(ctx.data.selectedWarehouseName, '乙仓');
  ctx.data.warehouses.reverse(); await ctx.onSubmitInbound(); assert.equal(requests.length, 0);
});
test('显式选择乙仓：确认目标名/ID、payload一致；取消保留输入不写库存', async () => {
  for (const confirm of [false, true]) {
    const { ctx, requests, dialogs } = fixture(confirm);
    ctx.onPickWarehouse({ currentTarget: { dataset: { index: 1 } } });
    await ctx.onSubmitInbound();
    assert.match(dialogs[0].content, /乙仓（编号 12）/);
    assert.equal(requests.length, confirm ? 1 : 0);
    if (confirm) assert.equal(requests[0].warehouseId, 12);
    assert.equal(ctx.data.inboundForm.qty, '2'); assert.equal(ctx.data.saving, false);
  }
});
test('采购单路径保留明确目标，不强制切首仓，确认后按原单入库', async () => {
  const { ctx, requests } = fixture();
  ctx.onPickWarehouse({ currentTarget: { dataset: { index: 1 } } });
  ctx.data.poOrder = { id: 51, orderNo: 'PO-TEST', supplierName: '隔离供应商' };
  ctx.data.poRows = [{ materialId: 7, title: '材料', qty: '1', priceYuan: '3' }];
  ctx.loadPurchaseOrders = async () => {};
  await ctx.onSubmitPoReceipt();
  assert.equal(requests[0].purchaseOrderId, 51); assert.equal(requests[0].warehouseId, 12);
});
