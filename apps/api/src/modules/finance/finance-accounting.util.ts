export type StandardAccount = {
  code: string;
  name: string;
  category: 'asset' | 'liability' | 'equity' | 'cost' | 'profit_loss';
  direction: 'debit' | 'credit';
  mapping?: Record<string, string>;
};

// 《小企业会计准则》常用一级科目。一级科目由系统维护；企业仅能在其下增加明细科目。
export const SMALL_ENTERPRISE_ACCOUNTS: StandardAccount[] = [
  ['1001','库存现金','asset','debit','cash'],['1002','银行存款','asset','debit','cash'],['1012','其他货币资金','asset','debit','cash'],
  ['1101','短期投资','asset','debit','shortInvestment'],['1121','应收票据','asset','debit','notesReceivable'],['1122','应收账款','asset','debit','accountsReceivable'],['1123','预付账款','asset','debit','prepayments'],['1131','应收股利','asset','debit','dividendsReceivable'],['1132','应收利息','asset','debit','interestReceivable'],['1221','其他应收款','asset','debit','otherReceivables'],
  ['1401','材料采购','asset','debit','inventory'],['1402','在途物资','asset','debit','inventory'],['1403','原材料','asset','debit','inventory'],['1404','材料成本差异','asset','debit','inventory'],['1405','库存商品','asset','debit','inventory'],['1407','商品进销差价','asset','credit','inventory'],['1408','委托加工物资','asset','debit','inventory'],['1411','周转材料','asset','debit','inventory'],['1421','消耗性生物资产','asset','debit','inventory'],
  ['1501','长期债券投资','asset','debit','longTermInvestment'],['1511','长期股权投资','asset','debit','longTermInvestment'],['1601','固定资产','asset','debit','fixedAssets'],['1602','累计折旧','asset','credit','accumulatedDepreciation'],['1604','在建工程','asset','debit','constructionInProgress'],['1605','工程物资','asset','debit','constructionMaterials'],['1606','固定资产清理','asset','debit','fixedAssetDisposal'],['1621','生产性生物资产','asset','debit','biologicalAssets'],['1622','生产性生物资产累计折旧','asset','credit','biologicalDepreciation'],['1701','无形资产','asset','debit','intangibleAssets'],['1702','累计摊销','asset','credit','accumulatedAmortization'],['1801','长期待摊费用','asset','debit','longTermPrepaid'],['1901','待处理财产损溢','asset','debit','pendingAssets'],
  ['2001','短期借款','liability','credit','shortLoans'],['2201','应付票据','liability','credit','notesPayable'],['2202','应付账款','liability','credit','accountsPayable'],['2203','预收账款','liability','credit','advances'],['2211','应付职工薪酬','liability','credit','employeeCompensation'],['2221','应交税费','liability','credit','taxPayable'],['2231','应付利息','liability','credit','interestPayable'],['2232','应付利润','liability','credit','profitsPayable'],['2241','其他应付款','liability','credit','otherPayables'],['2401','递延收益','liability','credit','deferredIncome'],['2501','长期借款','liability','credit','longLoans'],['2701','长期应付款','liability','credit','longPayables'],
  ['3001','实收资本','equity','credit','paidInCapital'],['3002','资本公积','equity','credit','capitalReserve'],['3101','盈余公积','equity','credit','surplusReserve'],['3103','本年利润','equity','credit','currentYearProfit'],['3104','利润分配','equity','credit','retainedEarnings'],
  ['4001','生产成本','cost','debit'],['4101','制造费用','cost','debit'],['4301','研发支出','cost','debit'],['4401','工程施工','cost','debit'],['4403','机械作业','cost','debit'],
  ['5001','主营业务收入','profit_loss','credit','operatingRevenue'],['5051','其他业务收入','profit_loss','credit','otherRevenue'],['5111','投资收益','profit_loss','credit','investmentIncome'],['5301','营业外收入','profit_loss','credit','nonOperatingIncome'],
  ['5401','主营业务成本','profit_loss','debit','operatingCost'],['5402','其他业务成本','profit_loss','debit','otherCost'],['5403','税金及附加','profit_loss','debit','taxAndSurcharges'],['5601','销售费用','profit_loss','debit','sellingExpenses'],['5602','管理费用','profit_loss','debit','administrativeExpenses'],['5603','财务费用','profit_loss','debit','financialExpenses'],['5711','营业外支出','profit_loss','debit','nonOperatingExpense'],['5801','所得税费用','profit_loss','debit','incomeTaxExpense'],
].map(([code,name,category,direction,map]) => ({ code, name, category, direction, mapping: map ? { item: map } : {} } as StandardAccount));

export type AccountingLine = { debit: number; credit: number };
export function validateBalanced(lines: AccountingLine[]) {
  const debit = round2(lines.reduce((sum, line) => sum + Number(line.debit || 0), 0));
  const credit = round2(lines.reduce((sum, line) => sum + Number(line.credit || 0), 0));
  return { debit, credit, balanced: debit > 0 && debit === credit };
}

export function validateOpeningEquation(rows: Array<AccountingLine & { category: StandardAccount['category'] }>) {
  const totals = validateBalanced(rows);
  const assets = round2(rows.filter((r) => r.category === 'asset').reduce((s, r) => s + Number(r.debit) - Number(r.credit), 0));
  const liabilitiesAndEquity = round2(rows.filter((r) => r.category === 'liability' || r.category === 'equity').reduce((s, r) => s + Number(r.credit) - Number(r.debit), 0));
  return { ...totals, assets, liabilitiesAndEquity, equationBalanced: assets === liabilitiesAndEquity };
}

export function round2(value: number) { return Math.round((value + Number.EPSILON) * 100) / 100; }
