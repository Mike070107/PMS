import assert from 'node:assert/strict';
import { test } from 'node:test';
import { materialTotalCents, quotaLabor, totalFeeCents } from './maintenance-money.util';

test('样单 0119524 的口径：0.34 工时 × 17.50 元 = 5.95 元', () => {
  assert.deepEqual(quotaLabor(0.34, 1, 1750), { hours: 0.34, laborFeeCents: 595 });
});

test('（人工费 + 材料费）× 系数，四舍五入到分', () => {
  // （5.95 + 6.00）× 1.0341 = 12.3575 → 12.36
  assert.equal(totalFeeCents([{ laborFeeCents: 595, materialFeeCents: 600 }], 1.0341), 1236);
});

test('多行相加，空格子当 0', () => {
  assert.equal(
    totalFeeCents(
      [
        { laborFeeCents: 595, materialFeeCents: 600 },
        { laborFeeCents: 437, materialFeeCents: null },
        { laborFeeCents: null, materialFeeCents: undefined },
      ],
      1,
    ),
    1632,
  );
});

test('系数缺失/非法时按 1 算，不能把钱算没了', () => {
  assert.equal(totalFeeCents([{ laborFeeCents: 1000 }], Number.NaN), 1000);
  assert.equal(totalFeeCents([{ laborFeeCents: 1000 }], 0), 1000);
});

test('工时按数量翻倍，半分钱进位', () => {
  // 0.25 × 3 = 0.75 工时；0.75 × 17.50 元 = 13.125 元 → 13.13 元
  assert.deepEqual(quotaLabor(0.25, 3, 1750), { hours: 0.75, laborFeeCents: 1313 });
});

test('数量为空/为 0 时按 1 件算，别把一行算成 0 元', () => {
  assert.deepEqual(quotaLabor(0.34, 0, 1750), { hours: 0.34, laborFeeCents: 595 });
});

test('材料合计只加实耗金额', () => {
  assert.equal(
    materialTotalCents([{ amountCents: 600 }, { amountCents: null }, { amountCents: 150 }]),
    750,
  );
});
