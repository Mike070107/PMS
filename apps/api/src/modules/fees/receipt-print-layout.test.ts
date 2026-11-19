import test from 'node:test';
import assert from 'node:assert/strict';
import { receiptLines } from './receipt-print-layout';
const receipt = {
  receiptNo: 'S123',
  paidAt: new Date('2026-11-19T00:00:00Z'),
  fullAddress: '测试公寓101室',
  amountCents: 2300,
  items: [{ feeName: '水费', amountCents: 2300 }],
};
test('只输出当前收据且拒绝控制字符和超长内容', () => {
  assert.match(receiptLines(receipt, false).join('\n'), /水费.*23\.00/);
  assert.match(receiptLines(receipt, true).join('\n'), /补打/);
  assert.throws(() =>
    receiptLines(
      { ...receipt, items: Array(50).fill(receipt.items[0]) },
      false,
    ),
  );
  assert.throws(() =>
    receiptLines({ ...receipt, fullAddress: '房号\x1b@' }, false),
  );
});
