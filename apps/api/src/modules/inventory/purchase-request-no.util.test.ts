import assert from 'node:assert/strict';
import test from 'node:test';
import { nextPurchaseRequestNo } from './purchase-request-no.util';

test('采购申请号按天短序号，不再携带六位工单 id', async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const manager = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      return sql.startsWith('SELECT request_no')
        ? [{ request_no: 'PR-260902-001' }, { request_no: 'PR-260902-009' }]
        : [];
    },
  } as any;
  const value = await nextPurchaseRequestNo(manager, 3, new Date(2026, 8, 2, 10, 30));
  assert.equal(value, 'PR-260902-010');
  assert.match(calls[0].sql, /pg_advisory_xact_lock/);
  assert.equal(calls[1].params[1], 'PR-260902-%');
});

test('当天第一张从 001 开始', async () => {
  const manager = { query: async () => [] } as any;
  assert.equal(
    await nextPurchaseRequestNo(manager, 1, new Date(2026, 0, 3)),
    'PR-260103-001',
  );
});
