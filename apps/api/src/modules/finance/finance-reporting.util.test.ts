import assert from 'node:assert/strict';
import test from 'node:test';
import * as ExcelJS from 'exceljs';
import { FinanceAccountingService } from './finance-accounting.service';
import { buildBalanceSheet, buildCashFlowStatement, buildProfitStatement, classifyCashFlow } from './finance-reporting.util';

test('builds the complete small-enterprise balance sheet and keeps both periods balanced', () => {
  const statement = buildBalanceSheet([
    { code: '1002', name: '银行存款', category: 'asset', item: 'cash', opening: 100_000, closing: 138_000 },
    { code: '1601', name: '固定资产', category: 'asset', item: 'fixedAssets', opening: 40_000, closing: 40_000 },
    { code: '1602', name: '累计折旧', category: 'asset', item: 'accumulatedDepreciation', opening: -5_000, closing: -8_000 },
    { code: '2202', name: '应付账款', category: 'liability', item: 'accountsPayable', opening: -15_000, closing: -20_000 },
    { code: '3001', name: '实收资本', category: 'equity', item: 'paidInCapital', opening: -100_000, closing: -100_000 },
    { code: '3104', name: '利润分配', category: 'equity', item: 'retainedEarnings', opening: -20_000, closing: -20_000 },
    { code: '3103', name: '本年利润', category: 'equity', item: 'currentYearProfit', opening: 0, closing: -20_000 },
    { code: '5001', name: '主营业务收入', category: 'profit_loss', item: 'operatingRevenue', opening: 0, closing: -10_000 },
  ]);
  assert.deepEqual(statement.assetRows.filter((row) => row.line !== null).map((row) => row.line), Array.from({ length: 30 }, (_, index) => index + 1));
  assert.deepEqual(statement.liabilityEquityRows.filter((row) => row.line !== null).map((row) => row.line), Array.from({ length: 23 }, (_, index) => index + 31));
  assert.equal(statement.assets, 170_000);
  assert.equal(statement.liabilitiesAndEquity, 170_000);
  assert.equal(statement.balanced, true);
  assert.equal(statement.openingBalanced, true);
  assert.equal(statement.assetRows.find((row) => row.line === 20)?.closing, 32_000);
});

test('builds all 32 profit-statement lines from current-month and year-to-date movements', () => {
  const statement = buildProfitStatement([
    { code: '5001', name: '主营业务收入', item: 'operatingRevenue', currentDebit: 0, currentCredit: 30_000, ytdDebit: 0, ytdCredit: 120_000 },
    { code: '5401', name: '主营业务成本', item: 'operatingCost', currentDebit: 12_000, currentCredit: 0, ytdDebit: 48_000, ytdCredit: 0 },
    { code: '5602', name: '管理费用', item: 'administrativeExpenses', currentDebit: 3_000, currentCredit: 0, ytdDebit: 11_000, ytdCredit: 0 },
    { code: '5801', name: '所得税费用', item: 'incomeTaxExpense', currentDebit: 3_750, currentCredit: 0, ytdDebit: 15_250, ytdCredit: 0 },
  ]);
  assert.deepEqual(statement.rows.map((row) => row.line), Array.from({ length: 32 }, (_, index) => index + 1));
  assert.equal(statement.rows.find((row) => row.line === 21)?.ytd, 61_000);
  assert.equal(statement.rows.find((row) => row.line === 32)?.current, 11_250);
  assert.equal(statement.netProfit, 45_750);
});

test('builds all cash-flow lines, reconciles ending cash, and exposes classification coverage', () => {
  const statement = buildCashFlowStatement({
    1: { current: 20_000, ytd: 90_000 }, 3: { current: 8_000, ytd: 30_000 }, 4: { current: 5_000, ytd: 20_000 },
    12: { current: 2_000, ytd: 8_000 }, 14: { current: 0, ytd: 10_000 }, 16: { current: 1_000, ytd: 4_000 },
  }, 56_000, 12_000, { explicit: 2, inferred: 3, pending: 1, pendingAmount: 500 });
  assert.deepEqual(statement.rows.filter((row) => row.line !== null).map((row) => row.line), Array.from({ length: 22 }, (_, index) => index + 1));
  assert.equal(statement.rows.find((row) => row.line === 20)?.ytd, 38_000);
  assert.equal(statement.endingCash, 50_000);
  assert.equal(statement.classification.coverage, 83.33);
});

test('classifies common cash counterparts and flags ambiguous vouchers', () => {
  assert.deepEqual(classifyCashFlow(['5001'], ['operatingRevenue'], 100), { line: 1, source: 'inferred' });
  assert.deepEqual(classifyCashFlow(['2202'], ['accountsPayable'], -100), { line: 3, source: 'inferred' });
  assert.deepEqual(classifyCashFlow(['9999'], [null], -100), { line: 6, source: 'pending' });
  assert.deepEqual(classifyCashFlow(['9999'], [null], -100, 'tax'), { line: 5, source: 'explicit' });
});

test('exports official statement sheets with full rows, checks, and account balances', async () => {
  const accounts = [
    { id: 1, tenantId: 3, code: '1002', name: '银行存款', category: 'asset', statementMapping: { item: 'cash' }, isActive: true },
    { id: 2, tenantId: 3, code: '5001', name: '主营业务收入', category: 'profit_loss', statementMapping: { item: 'operatingRevenue' }, isActive: true },
  ];
  const vouchers = [{ id: 11, tenantId: 3, voucherDate: '2026-09-08', period: '2026-09', status: 'posted', sourceType: 'manual' }];
  const lines = [
    { id: 21, tenantId: 3, voucherId: 11, accountId: 1, lineNo: 1, debit: '10000.00', credit: '0.00', cashFlowItem: null },
    { id: 22, tenantId: 3, voucherId: 11, accountId: 2, lineNo: 2, debit: '0.00', credit: '10000.00', cashFlowItem: null },
  ];
  const setRepo = { findOne: async () => ({ id: 1, tenantId: 3, name: '测试企业账套' }) };
  const accountRepo = {
    find: async () => accounts,
    create: (value: unknown) => value,
    createQueryBuilder: () => { const builder: any = { insert: () => builder, into: () => builder, values: () => builder, orIgnore: () => builder, execute: async () => ({ identifiers: [] }) }; return builder; },
  };
  const openingRepo = { find: async () => [] };
  const voucherRepo = { find: async () => vouchers };
  const lineRepo = { find: async () => lines };
  const tenantRepo = { findOne: async () => ({ id: 3, name: '上海示例科技有限公司' }) };
  const unused = {} as any;
  const service = new FinanceAccountingService(tenantRepo as any, setRepo as any, accountRepo as any, unused, openingRepo as any, voucherRepo as any, lineRepo as any, unused, unused, unused, unused);
  const user = { id: 7, tenantId: 3, role: 'superadmin' };

  const report = await service.reports(user, '2026-09');
  assert.equal(report.entityName, '上海示例科技有限公司');
  assert.equal(report.balanceSheet.balanced, true);
  assert.equal(report.cashFlowReconciled, true);
  assert.equal(report.profitStatement.rows.length, 32);

  const output = await service.reportWorkbook(user, '2026-09');
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(output as any);
  assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), ['资产负债表','利润表','现金流量表','报表校验','科目余额表']);
  assert.equal(workbook.getWorksheet('资产负债表')?.getCell('A1').value, '资产负债表（小企业会计准则）');
  assert.ok((workbook.getWorksheet('资产负债表')?.rowCount || 0) >= 36);
  assert.ok((workbook.getWorksheet('利润表')?.rowCount || 0) >= 36);
  assert.ok((workbook.getWorksheet('现金流量表')?.rowCount || 0) >= 29);
  assert.equal(workbook.getWorksheet('科目余额表')?.autoFilter?.toString(), 'A1:H1');
});
