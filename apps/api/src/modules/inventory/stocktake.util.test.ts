import assert from 'node:assert/strict';
import test from 'node:test';
import { buildStocktakeLines, summarizeStocktake } from './stocktake.util';

test('没盘的行（countedQty 缺省或 null）不进过账清单', () => {
  const lines = buildStocktakeLines(
    [
      { materialId: 1 },
      { materialId: 2, countedQty: null },
      { materialId: 3, countedQty: 5 },
    ],
    new Map([[3, 5]]),
  );
  assert.equal(lines.length, 1);
  assert.equal(lines[0].materialId, 3);
});

test('差异按过账时刻系统数算；没有库存行按 0（全额盘盈）', () => {
  const lines = buildStocktakeLines(
    [
      { materialId: 1, countedQty: 8 }, // 系统 10 → 盘亏 2
      { materialId: 2, countedQty: 3 }, // 没有库存行 → 盘盈 3
    ],
    new Map([[1, 10]]),
  );
  assert.deepEqual(lines[0], { materialId: 1, countedQty: 8, systemQty: 10, diffQty: -2 });
  assert.deepEqual(lines[1], { materialId: 2, countedQty: 3, systemQty: 0, diffQty: 3 });
});

test('两位小数不出浮点尾巴：0.3 - 0.1 = 0.2 整', () => {
  const lines = buildStocktakeLines(
    [{ materialId: 1, countedQty: 0.3 }],
    new Map([[1, 0.1]]),
  );
  assert.equal(lines[0].diffQty, 0.2);
});

test('账实相符（差异 0）的行也保留，过账要写 systemQty 留痕', () => {
  const lines = buildStocktakeLines(
    [{ materialId: 1, countedQty: 6 }],
    new Map([[1, 6]]),
  );
  assert.equal(lines.length, 1);
  assert.equal(lines[0].diffQty, 0);
});

test('实盘数为负直接拒绝', () => {
  assert.throws(() =>
    buildStocktakeLines([{ materialId: 1, countedQty: -1 }], new Map()),
  );
});

test('汇总：盘盈/盘亏分开计，金额读过账快照', () => {
  const summary = summarizeStocktake([
    { countedQty: 5, diffQty: 2, amountCents: 5600 },
    { countedQty: 1, diffQty: -3, amountCents: 8400 },
    { countedQty: 6, diffQty: 0, amountCents: 0 },
    { countedQty: null },
    {},
  ]);
  assert.equal(summary.itemCount, 5);
  assert.equal(summary.countedCount, 3);
  assert.equal(summary.profitQty, 2);
  assert.equal(summary.lossQty, 3);
  assert.equal(summary.profitCents, 5600);
  assert.equal(summary.lossCents, 8400);
});
