import assert from 'node:assert/strict';
import test from 'node:test';
import { roundStocktakeQty, stocktakeDifference, stocktakeProgress } from './stocktake.util';

test('盘点差异保留两位并避免浮点尾差', () => {
  assert.equal(stocktakeDifference(0.1, 0.3), 0.2);
  assert.equal(stocktakeDifference(12, 10), -2);
  assert.equal(roundStocktakeQty(1.236), 1.24);
});

test('盘点进度只把已填写实盘数量的行算作已盘', () => {
  assert.deepEqual(
    stocktakeProgress([
      { actualQty: 10, differenceQty: -2 },
      { actualQty: 0, differenceQty: 0 },
      { actualQty: null, differenceQty: null },
    ]),
    { totalCount: 3, countedCount: 2, differenceCount: 1 },
  );
});
