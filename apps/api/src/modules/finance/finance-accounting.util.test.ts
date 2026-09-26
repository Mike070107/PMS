import assert from 'node:assert/strict';
import test from 'node:test';
import { validateBalanced, validateOpeningEquation } from './finance-accounting.util';

test('voucher must balance and contain a positive amount', () => {
  assert.deepEqual(validateBalanced([{ debit: 100, credit: 0 }, { debit: 0, credit: 100 }]), { debit: 100, credit: 100, balanced: true });
  assert.equal(validateBalanced([{ debit: 100, credit: 0 }, { debit: 0, credit: 99.99 }]).balanced, false);
  assert.equal(validateBalanced([{ debit: 0, credit: 0 }]).balanced, false);
});

test('opening balance validates trial balance and accounting equation independently', () => {
  const result = validateOpeningEquation([
    { category: 'asset', debit: 120, credit: 0 },
    { category: 'liability', debit: 0, credit: 20 },
    { category: 'equity', debit: 0, credit: 100 },
  ]);
  assert.equal(result.balanced, true);
  assert.equal(result.equationBalanced, true);
  assert.equal(result.assets, 120);
  assert.equal(result.liabilitiesAndEquity, 120);
});
