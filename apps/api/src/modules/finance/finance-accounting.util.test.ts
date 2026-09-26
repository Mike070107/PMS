import assert from 'node:assert/strict';
import test from 'node:test';
import { FinanceAccountingService } from './finance-accounting.service';
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

function insertOnlyRepo(uniqueKey: (row: any) => string) {
  const rows: any[] = [];
  let nextId = 1;
  return {
    rows,
    create: (value: any) => ({ ...value }),
    findOne: async ({ where }: any) => rows.find((row) => Object.entries(where).every(([key, value]) => row[key] === value)) ?? null,
    find: async ({ where }: any) => rows.filter((row) => Object.entries(where).every(([key, value]) => row[key] === value)),
    createQueryBuilder: () => {
      let values: any[] = [];
      const builder: any = {
        insert: () => builder,
        into: () => builder,
        values: (input: any | any[]) => { values = Array.isArray(input) ? input : [input]; return builder; },
        orIgnore: () => builder,
        execute: async () => {
          // Yield so two callers both finish their initial read before either insert.
          await new Promise((resolve) => setImmediate(resolve));
          for (const value of values) {
            if (!rows.some((row) => uniqueKey(row) === uniqueKey(value))) rows.push({ ...value, id: nextId++ });
          }
          return { identifiers: [] };
        },
      };
      return builder;
    },
  };
}

test('first accounting requests initialize one account set and one copy of every standard account', async () => {
  const setRepo = insertOnlyRepo((row) => String(row.tenantId));
  const accountRepo = insertOnlyRepo((row) => `${row.tenantId}:${row.code}`);
  const unused = {} as any;
  const service = new FinanceAccountingService(
    setRepo as any, accountRepo as any, unused, unused, unused, unused, unused, unused, unused, unused,
  );
  const user = { id: 7, tenantId: 3, role: 'superadmin' };

  const initialized = await Promise.all([
    service.ensureAccountSet(user),
    service.ensureAccountSet(user),
    service.ensureAccountSet(user),
  ]);

  assert.equal(setRepo.rows.length, 1);
  assert.equal(new Set(accountRepo.rows.map((row) => `${row.tenantId}:${row.code}`)).size, accountRepo.rows.length);
  assert.ok(accountRepo.rows.length > 20);
  assert.deepEqual(initialized.map((row) => row.id), [1, 1, 1]);
});
