import assert from 'node:assert/strict';
import test from 'node:test';
import { lockedChanges, MATERIAL_ID_TABLES, MATERIAL_JSON_COLUMNS, usageMessage } from './material-usage.util';

const cur = { name: '角阀', spec: 'DN15', unit: '个', category: '水暖', params: '铜' };

test('只改价格/图片/别名 → 没有锁定栏位变化', () => {
  assert.deepEqual(lockedChanges(cur, {}), []);
});

test('改成同样的值（含首尾空格、空串与 null）不算改动', () => {
  assert.deepEqual(lockedChanges(cur, { name: ' 角阀 ', spec: 'DN15', unit: '个' }), []);
  assert.deepEqual(lockedChanges({ ...cur, params: null }, { params: '' }), []);
});

test('改名称/规格/单位/分类/参数都会被识别', () => {
  assert.deepEqual(
    lockedChanges(cur, { name: '三角阀', spec: 'DN20', unit: '只', category: '五金', params: '不锈钢' }),
    ['名称', '规格型号', '单位', '分类', '参数'],
  );
});

test('使用口径覆盖库存、流水、工单、采购、调拨、盘点、供应商', () => {
  const labels = [...MATERIAL_ID_TABLES.map((t) => t[1]), ...MATERIAL_JSON_COLUMNS.map((t) => t[2])];
  for (const need of ['库存', '出入库流水', '工单用料', '工单缺料', '采购申请', '采购单', '调拨单', '盘点', '供应商报价']) {
    assert.ok(labels.includes(need), need);
  }
});

test('提示文案：删除给停用建议；编辑说明哪些能改；来源去重', () => {
  assert.equal(usageMessage(['库存', '工单用料', '工单用料'], 'delete'), '此SKU已被使用（库存、工单用料），不能删除；不再使用可以停用');
  assert.match(usageMessage(['采购申请'], 'edit', ['名称']), /名称不能修改；参考价格、图片、别名可以改/);
});
