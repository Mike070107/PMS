import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTemplateItems, resolveTemplateItems, standardSignature } from './fee-templates.util';

test('模板保留零单价，拒绝重复项目、负数和小数分', () => {
  const item = { feeCode: 'electricity', unitPriceCents: 0, unit: '度', calculation: 'quantity', cycle: 'once' };
  assert.equal(normalizeTemplateItems([item])[0].unitPriceCents, 0);
  assert.throws(() => normalizeTemplateItems([item, item]));
  assert.throws(() => normalizeTemplateItems([{...item, unitPriceCents: -1}]));
  assert.throws(() => normalizeTemplateItems([{...item, unitPriceCents: 0.5}]));
});
test('住户只覆盖一个项目，其余跟随模板；按面积计算只作用于当前解析', () => {
  const items = normalizeTemplateItems([
    { feeCode:'management', unitPriceCents:120, unit:'㎡', calculation:'area', cycle:'month' },
    { feeCode:'parking', unitPriceCents:15000, unit:'月', calculation:'fixed', cycle:'month' },
  ]);
  const result = resolveTemplateItems(items, { parking: 0 }, '80.25');
  assert.equal(result[0].amountCents, 9630);
  assert.equal(result[1].amountCents, 0);
  assert.equal(items[1].unitPriceCents,15000);
  assert.throws(() => resolveTemplateItems(items, {}, null));
  assert.throws(() => resolveTemplateItems(items, {electricity:100},'80.25'));
});
test('迁移同标准分组与项目顺序无关，签报原始标准不同不能合并', () => {
  const a = normalizeTemplateItems([{feeCode:'rent',unitPriceCents:80000,unit:'月',calculation:'fixed',cycle:'month'}, {feeCode:'network',unitPriceCents:5000,unit:'月',calculation:'fixed',cycle:'month'}]);
  assert.equal(standardSignature(a),standardSignature([...a].reverse()));
  assert.notEqual(standardSignature(a),standardSignature([{...a[0],originalStandardCents:90000},a[1]]));
});
