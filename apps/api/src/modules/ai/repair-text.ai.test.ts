import assert from 'node:assert/strict';
import test from 'node:test';
import { matchCompletionMaterials, validateCompletionFeeRule } from './repair-text.ai';

const catalog = [
  { id: 1, name: '不锈钢角阀', spec: 'DN15', unit: '只', aliases: ['角阀'] },
  { id: 2, name: '生料带', unit: '卷', aliases: ['密封带'] },
  { id: 3, name: 'PVC弯头', spec: '20mm', unit: '个', aliases: ['弯头'] },
  { id: 4, name: 'PPR弯头', spec: '20mm', unit: '个', aliases: ['弯头'] },
];

test('材料口语名唯一命中别名且数量明确时可形成草稿候选', () => {
  const [row] = matchCompletionMaterials([{ name: '角阀', qty: 1, unit: '只' }], catalog);
  assert.equal(row.materialId, 1);
  assert.equal(row.match, 'exact');
  assert.equal(row.needsConfirmation, false);
});

test('同一别名对应多个 SKU 时必须人工选择', () => {
  const [row] = matchCompletionMaterials([{ name: '弯头', qty: 1, unit: '个' }], catalog);
  assert.equal(row.match, 'candidate');
  assert.equal(row.needsConfirmation, true);
});

test('没说数量时即便 SKU 唯一也不能自动补数量', () => {
  const [row] = matchCompletionMaterials([{ name: '生料带', qty: null, unit: '' }], catalog);
  assert.equal(row.match, 'exact');
  assert.equal(row.needsConfirmation, true);
});

test('收费必须同时命中已有规则编码和适用词', () => {
  const rules = [
    { code: 'replace_valve', name: '更换角阀', feeCents: 5000, keywords: ['更换角阀', '换角阀'] },
  ];
  assert.equal(
    validateCompletionFeeRule('replace_valve', rules, '已更换角阀并测试无渗漏')?.feeCents,
    5000,
  );
  assert.equal(validateCompletionFeeRule('replace_valve', rules, '只是紧固接头'), null);
  assert.equal(validateCompletionFeeRule('replace_valve', rules, '免费更换角阀'), null);
});
