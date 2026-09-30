import assert from 'node:assert/strict';
import test from 'node:test';
import { sortAccessCardHistoryNewestFirst, verifiedHistoryAccessStatus } from './access-card-history.util';

test('history is ordered by issuance time instead of legacy sequence', () => {
  const rows = sortAccessCardHistoryNewestFirst([
    { id: 1, sequence: 99, issuedAt: '2026-09-20T10:00:00+08:00' },
    { id: 2, sequence: 3, issuedAt: '2026-09-29T14:24:04+08:00' },
    { id: 3, sequence: 100, issuedAt: null },
  ]);
  assert.deepEqual(rows.map((row) => row.id), [2, 1, 3]);
});

test('phase2 history only reports uploaded after a permission row is verified', () => {
  assert.equal(verifiedHistoryAccessStatus('phase2', 'ready', 0), 'not_uploaded');
  assert.equal(verifiedHistoryAccessStatus('phase2', 'ready', 1), 'controller_uploaded');
  assert.equal(verifiedHistoryAccessStatus('phase2', 'pending', 1), 'permission_check_pending');
  assert.equal(verifiedHistoryAccessStatus('phase1', 'ready', 0), 'not_required');
});
