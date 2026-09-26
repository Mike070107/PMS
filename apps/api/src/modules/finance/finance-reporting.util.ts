import { round2 } from './finance-accounting.util';

export type StatementRowKind = 'section' | 'item' | 'detail' | 'subtotal' | 'total';

export type StatementRow = {
  line: number | null;
  label: string;
  kind: StatementRowKind;
  opening?: number;
  closing?: number;
  current?: number;
  ytd?: number;
};

export type BalanceSourceRow = {
  code: string;
  name: string;
  category: string;
  item: string | null;
  opening: number;
  closing: number;
};

export type ProfitSourceRow = {
  code: string;
  name: string;
  item: string | null;
  currentDebit: number;
  currentCredit: number;
  ytdDebit: number;
  ytdCredit: number;
};

export type CashFlowAmounts = Record<number, { current: number; ytd: number }>;

const sum = (values: number[]) => round2(values.reduce((total, value) => total + value, 0));
const line = (lineNo: number | null, label: string, kind: StatementRowKind, values: Partial<StatementRow> = {}): StatementRow => ({ line: lineNo, label, kind, ...values });

function balanceByItems(rows: BalanceSourceRow[], items: string[], direction: 'debit' | 'credit') {
  const selected = rows.filter((row) => row.item && items.includes(row.item));
  const value = (column: 'opening' | 'closing') => sum(selected.map((row) => direction === 'debit' ? row[column] : -row[column]));
  return { opening: value('opening'), closing: value('closing') };
}

function balanceByCodes(rows: BalanceSourceRow[], codes: string[], direction: 'debit' | 'credit') {
  const selected = rows.filter((row) => codes.some((code) => row.code === code || row.code.startsWith(`${code}.`) || row.code.startsWith(code) && row.code.length > code.length));
  const value = (column: 'opening' | 'closing') => sum(selected.map((row) => direction === 'debit' ? row[column] : -row[column]));
  return { opening: value('opening'), closing: value('closing') };
}

const addBalances = (...values: Array<{ opening: number; closing: number }>) => ({
  opening: sum(values.map((value) => value.opening)),
  closing: sum(values.map((value) => value.closing)),
});

const subtractBalances = (left: { opening: number; closing: number }, right: { opening: number; closing: number }) => ({
  opening: round2(left.opening - right.opening),
  closing: round2(left.closing - right.closing),
});

export function buildBalanceSheet(rows: BalanceSourceRow[]) {
  const debit = (...items: string[]) => balanceByItems(rows, items, 'debit');
  const credit = (...items: string[]) => balanceByItems(rows, items, 'credit');
  const debitCodes = (...codes: string[]) => balanceByCodes(rows, codes, 'debit');
  const creditCodes = (...codes: string[]) => balanceByCodes(rows, codes, 'credit');

  const cash = debit('cash');
  const shortInvestment = debit('shortInvestment');
  const notesReceivable = debit('notesReceivable');
  const accountsReceivable = debit('accountsReceivable');
  const prepayments = debit('prepayments');
  const dividendsReceivable = debit('dividendsReceivable');
  const interestReceivable = debit('interestReceivable');
  const otherReceivables = debit('otherReceivables');
  const workInProgress = debitCodes('4001', '4101', '4401', '4403');
  const inventory = addBalances(debit('inventory'), workInProgress);
  const rawMaterials = debitCodes('1403');
  const finishedGoods = debitCodes('1405');
  const turnoverMaterials = debitCodes('1411');
  const otherCurrentAssets = debitCodes('1901');
  const currentAssets = addBalances(cash, shortInvestment, notesReceivable, accountsReceivable, prepayments, dividendsReceivable, interestReceivable, otherReceivables, inventory, otherCurrentAssets);

  const longTermDebtInvestment = debitCodes('1501');
  const longTermEquityInvestment = debitCodes('1511');
  const fixedAssetCost = debitCodes('1601');
  const accumulatedDepreciation = creditCodes('1602');
  const fixedAssetNet = subtractBalances(fixedAssetCost, accumulatedDepreciation);
  const constructionInProgress = debitCodes('1604');
  const constructionMaterials = debitCodes('1605');
  const fixedAssetDisposal = debitCodes('1606');
  const biologicalAssets = subtractBalances(debitCodes('1621'), creditCodes('1622'));
  const intangibleAssets = subtractBalances(debitCodes('1701'), creditCodes('1702'));
  const developmentExpenditure = debitCodes('4301');
  const longTermPrepaid = debitCodes('1801');
  const mappedAssetItems = new Set(['cash','shortInvestment','notesReceivable','accountsReceivable','prepayments','dividendsReceivable','interestReceivable','otherReceivables','inventory','longTermInvestment','fixedAssets','accumulatedDepreciation','constructionInProgress','constructionMaterials','fixedAssetDisposal','biologicalAssets','biologicalDepreciation','intangibleAssets','accumulatedAmortization','longTermPrepaid','pendingAssets']);
  const otherNonCurrentAssets = {
    opening: sum(rows.filter((row) => row.category === 'asset' && (!row.item || !mappedAssetItems.has(row.item))).map((row) => row.opening)),
    closing: sum(rows.filter((row) => row.category === 'asset' && (!row.item || !mappedAssetItems.has(row.item))).map((row) => row.closing)),
  };
  const nonCurrentAssets = addBalances(longTermDebtInvestment, longTermEquityInvestment, fixedAssetNet, constructionInProgress, constructionMaterials, fixedAssetDisposal, biologicalAssets, intangibleAssets, developmentExpenditure, longTermPrepaid, otherNonCurrentAssets);
  const assets = addBalances(currentAssets, nonCurrentAssets);

  const shortLoans = credit('shortLoans');
  const notesPayable = credit('notesPayable');
  const accountsPayable = credit('accountsPayable');
  const advances = credit('advances');
  const employeeCompensation = credit('employeeCompensation');
  const taxPayable = credit('taxPayable');
  const interestPayable = credit('interestPayable');
  const profitsPayable = credit('profitsPayable');
  const otherPayables = credit('otherPayables');
  const otherCurrentLiabilities = { opening: 0, closing: 0 };
  const currentLiabilities = addBalances(shortLoans, notesPayable, accountsPayable, advances, employeeCompensation, taxPayable, interestPayable, profitsPayable, otherPayables, otherCurrentLiabilities);
  const longLoans = credit('longLoans');
  const longPayables = credit('longPayables');
  const deferredIncome = credit('deferredIncome');
  const mappedLiabilityItems = new Set(['shortLoans','notesPayable','accountsPayable','advances','employeeCompensation','taxPayable','interestPayable','profitsPayable','otherPayables','longLoans','longPayables','deferredIncome']);
  const otherNonCurrentLiabilities = {
    opening: sum(rows.filter((row) => row.category === 'liability' && (!row.item || !mappedLiabilityItems.has(row.item))).map((row) => -row.opening)),
    closing: sum(rows.filter((row) => row.category === 'liability' && (!row.item || !mappedLiabilityItems.has(row.item))).map((row) => -row.closing)),
  };
  const nonCurrentLiabilities = addBalances(longLoans, longPayables, deferredIncome, otherNonCurrentLiabilities);
  const liabilities = addBalances(currentLiabilities, nonCurrentLiabilities);
  const paidInCapital = credit('paidInCapital');
  const capitalReserve = credit('capitalReserve');
  const surplusReserve = credit('surplusReserve');
  const unclosedProfit = {
    opening: round2(-sum(rows.filter((row) => row.category === 'profit_loss').map((row) => row.opening))),
    closing: round2(-sum(rows.filter((row) => row.category === 'profit_loss').map((row) => row.closing))),
  };
  const retainedEarnings = addBalances(credit('retainedEarnings'), credit('currentYearProfit'), unclosedProfit);
  const equity = addBalances(paidInCapital, capitalReserve, surplusReserve, retainedEarnings);
  const liabilitiesAndEquity = addBalances(liabilities, equity);

  const assetRows: StatementRow[] = [
    line(null, '流动资产：', 'section'), line(1, '货币资金', 'item', cash), line(2, '短期投资', 'item', shortInvestment),
    line(3, '应收票据', 'item', notesReceivable), line(4, '应收账款', 'item', accountsReceivable), line(5, '预付账款', 'item', prepayments),
    line(6, '应收股利', 'item', dividendsReceivable), line(7, '应收利息', 'item', interestReceivable), line(8, '其他应收款', 'item', otherReceivables),
    line(9, '存货', 'item', inventory), line(10, '其中：原材料', 'detail', rawMaterials), line(11, '在产品', 'detail', workInProgress),
    line(12, '库存商品', 'detail', finishedGoods), line(13, '周转材料', 'detail', turnoverMaterials), line(14, '其他流动资产', 'item', otherCurrentAssets),
    line(15, '流动资产合计', 'subtotal', currentAssets), line(null, '非流动资产：', 'section'), line(16, '长期债券投资', 'item', longTermDebtInvestment),
    line(17, '长期股权投资', 'item', longTermEquityInvestment), line(18, '固定资产原价', 'item', fixedAssetCost), line(19, '减：累计折旧', 'item', accumulatedDepreciation),
    line(20, '固定资产账面价值', 'subtotal', fixedAssetNet), line(21, '在建工程', 'item', constructionInProgress), line(22, '工程物资', 'item', constructionMaterials),
    line(23, '固定资产清理', 'item', fixedAssetDisposal), line(24, '生产性生物资产', 'item', biologicalAssets), line(25, '无形资产', 'item', intangibleAssets),
    line(26, '开发支出', 'item', developmentExpenditure), line(27, '长期待摊费用', 'item', longTermPrepaid), line(28, '其他非流动资产', 'item', otherNonCurrentAssets),
    line(29, '非流动资产合计', 'subtotal', nonCurrentAssets), line(30, '资产总计', 'total', assets),
  ];
  const liabilityEquityRows: StatementRow[] = [
    line(null, '流动负债：', 'section'), line(31, '短期借款', 'item', shortLoans), line(32, '应付票据', 'item', notesPayable),
    line(33, '应付账款', 'item', accountsPayable), line(34, '预收账款', 'item', advances), line(35, '应付职工薪酬', 'item', employeeCompensation),
    line(36, '应交税费', 'item', taxPayable), line(37, '应付利息', 'item', interestPayable), line(38, '应付利润', 'item', profitsPayable),
    line(39, '其他应付款', 'item', otherPayables), line(40, '其他流动负债', 'item', otherCurrentLiabilities), line(41, '流动负债合计', 'subtotal', currentLiabilities),
    line(null, '非流动负债：', 'section'), line(42, '长期借款', 'item', longLoans), line(43, '长期应付款', 'item', longPayables),
    line(44, '递延收益', 'item', deferredIncome), line(45, '其他非流动负债', 'item', otherNonCurrentLiabilities), line(46, '非流动负债合计', 'subtotal', nonCurrentLiabilities),
    line(47, '负债合计', 'total', liabilities), line(null, '所有者权益（或股东权益）：', 'section'), line(48, '实收资本（或股本）', 'item', paidInCapital),
    line(49, '资本公积', 'item', capitalReserve), line(50, '盈余公积', 'item', surplusReserve), line(51, '未分配利润', 'item', retainedEarnings),
    line(52, '所有者权益（或股东权益）合计', 'subtotal', equity), line(53, '负债和所有者权益（或股东权益）总计', 'total', liabilitiesAndEquity),
  ];
  return {
    formCode: '会小企 01 表', assetRows, liabilityEquityRows,
    assets: assets.closing, liabilities: liabilities.closing, equity: equity.closing,
    liabilitiesAndEquity: liabilitiesAndEquity.closing,
    openingBalanced: assets.opening === liabilitiesAndEquity.opening,
    balanced: assets.closing === liabilitiesAndEquity.closing,
  };
}

function movementByItem(rows: ProfitSourceRow[], item: string, direction: 'debit' | 'credit') {
  const selected = rows.filter((row) => row.item === item);
  const amount = (period: 'current' | 'ytd') => sum(selected.map((row) => direction === 'credit'
    ? row[period === 'current' ? 'currentCredit' : 'ytdCredit'] - row[period === 'current' ? 'currentDebit' : 'ytdDebit']
    : row[period === 'current' ? 'currentDebit' : 'ytdDebit'] - row[period === 'current' ? 'currentCredit' : 'ytdCredit']));
  return { current: amount('current'), ytd: amount('ytd') };
}

function movementByName(rows: ProfitSourceRow[], parentItem: string, pattern: RegExp, direction: 'debit' | 'credit' = 'debit') {
  const selected = rows.filter((row) => row.item === parentItem && pattern.test(row.name));
  const amount = (period: 'current' | 'ytd') => sum(selected.map((row) => direction === 'credit'
    ? row[period === 'current' ? 'currentCredit' : 'ytdCredit'] - row[period === 'current' ? 'currentDebit' : 'ytdDebit']
    : row[period === 'current' ? 'currentDebit' : 'ytdDebit'] - row[period === 'current' ? 'currentCredit' : 'ytdCredit']));
  return { current: amount('current'), ytd: amount('ytd') };
}

const addMovements = (...values: Array<{ current: number; ytd: number }>) => ({ current: sum(values.map((value) => value.current)), ytd: sum(values.map((value) => value.ytd)) });
const subtractMovements = (left: { current: number; ytd: number }, ...values: Array<{ current: number; ytd: number }>) => ({ current: round2(left.current - sum(values.map((value) => value.current))), ytd: round2(left.ytd - sum(values.map((value) => value.ytd))) });

export function buildProfitStatement(rows: ProfitSourceRow[]) {
  const operatingRevenue = addMovements(movementByItem(rows, 'operatingRevenue', 'credit'), movementByItem(rows, 'otherRevenue', 'credit'));
  const operatingCost = addMovements(movementByItem(rows, 'operatingCost', 'debit'), movementByItem(rows, 'otherCost', 'debit'));
  const taxes = movementByItem(rows, 'taxAndSurcharges', 'debit');
  const selling = movementByItem(rows, 'sellingExpenses', 'debit');
  const admin = movementByItem(rows, 'administrativeExpenses', 'debit');
  const finance = movementByItem(rows, 'financialExpenses', 'debit');
  const investment = movementByItem(rows, 'investmentIncome', 'credit');
  const operatingProfit = addMovements(subtractMovements(operatingRevenue, operatingCost, taxes, selling, admin, finance), investment);
  const nonOperatingIncome = movementByItem(rows, 'nonOperatingIncome', 'credit');
  const nonOperatingExpense = movementByItem(rows, 'nonOperatingExpense', 'debit');
  const totalProfit = subtractMovements(addMovements(operatingProfit, nonOperatingIncome), nonOperatingExpense);
  const incomeTax = movementByItem(rows, 'incomeTaxExpense', 'debit');
  const netProfit = subtractMovements(totalProfit, incomeTax);
  const values = (value: { current: number; ytd: number }) => ({ current: value.current, ytd: value.ytd });
  const resultRows: StatementRow[] = [
    line(1, '一、营业收入', 'total', values(operatingRevenue)), line(2, '减：营业成本', 'item', values(operatingCost)), line(3, '营业税金及附加', 'item', values(taxes)),
    line(4, '其中：消费税', 'detail', values(movementByName(rows, 'taxAndSurcharges', /消费税/))), line(5, '营业税', 'detail', values(movementByName(rows, 'taxAndSurcharges', /营业税/))),
    line(6, '城市维护建设税', 'detail', values(movementByName(rows, 'taxAndSurcharges', /城市维护建设税|城建税/))), line(7, '资源税', 'detail', values(movementByName(rows, 'taxAndSurcharges', /资源税/))),
    line(8, '土地增值税', 'detail', values(movementByName(rows, 'taxAndSurcharges', /土地增值税/))), line(9, '城镇土地使用税、房产税、车船税、印花税', 'detail', values(movementByName(rows, 'taxAndSurcharges', /土地使用税|房产税|车船税|印花税/))),
    line(10, '教育费附加、矿产资源补偿费、排污费', 'detail', values(movementByName(rows, 'taxAndSurcharges', /教育费附加|矿产资源补偿费|排污费/))),
    line(11, '销售费用', 'item', values(selling)), line(12, '其中：商品维修费', 'detail', values(movementByName(rows, 'sellingExpenses', /商品维修费|维修费/))),
    line(13, '广告费和业务宣传费', 'detail', values(movementByName(rows, 'sellingExpenses', /广告费|业务宣传费/))), line(14, '管理费用', 'item', values(admin)),
    line(15, '其中：开办费', 'detail', values(movementByName(rows, 'administrativeExpenses', /开办费/))), line(16, '业务招待费', 'detail', values(movementByName(rows, 'administrativeExpenses', /业务招待费/))),
    line(17, '研究费用', 'detail', values(movementByName(rows, 'administrativeExpenses', /研究费用|研发费用/))), line(18, '财务费用', 'item', values(finance)),
    line(19, '其中：利息费用（收入以“-”号填列）', 'detail', values(movementByName(rows, 'financialExpenses', /利息/))), line(20, '加：投资收益（损失以“-”号填列）', 'item', values(investment)),
    line(21, '二、营业利润（亏损以“-”号填列）', 'total', values(operatingProfit)), line(22, '加：营业外收入', 'item', values(nonOperatingIncome)),
    line(23, '其中：政府补助', 'detail', values(movementByName(rows, 'nonOperatingIncome', /政府补助/, 'credit'))), line(24, '减：营业外支出', 'item', values(nonOperatingExpense)),
    line(25, '其中：坏账损失', 'detail', values(movementByName(rows, 'nonOperatingExpense', /坏账损失/))), line(26, '无法收回的长期债券投资损失', 'detail', values(movementByName(rows, 'nonOperatingExpense', /长期债券投资损失/))),
    line(27, '无法收回的长期股权投资损失', 'detail', values(movementByName(rows, 'nonOperatingExpense', /长期股权投资损失/))), line(28, '自然灾害等不可抗力因素造成的损失', 'detail', values(movementByName(rows, 'nonOperatingExpense', /自然灾害|不可抗力/))),
    line(29, '税收滞纳金', 'detail', values(movementByName(rows, 'nonOperatingExpense', /税收滞纳金|滞纳金/))), line(30, '三、利润总额（亏损总额以“-”号填列）', 'total', values(totalProfit)),
    line(31, '减：所得税费用', 'item', values(incomeTax)), line(32, '四、净利润（净亏损以“-”号填列）', 'total', values(netProfit)),
  ];
  return { formCode: '会小企 02 表', rows: resultRows, operatingRevenue: operatingRevenue.ytd, operatingCosts: sum([operatingCost.ytd, taxes.ytd, selling.ytd, admin.ytd, finance.ytd]), netProfit: netProfit.ytd };
}

export function buildCashFlowStatement(amounts: CashFlowAmounts, openingCurrent: number, openingYtd: number, classification: { explicit: number; inferred: number; pending: number; pendingAmount: number }) {
  const get = (lineNo: number) => amounts[lineNo] || { current: 0, ytd: 0 };
  const operatingNet = subtractMovements(addMovements(get(1), get(2)), get(3), get(4), get(5), get(6));
  const investingNet = subtractMovements(addMovements(get(8), get(9), get(10)), get(11), get(12));
  const financingNet = subtractMovements(addMovements(get(14), get(15)), get(16), get(17), get(18));
  const cashIncrease = addMovements(operatingNet, investingNet, financingNet);
  const opening = { current: round2(openingCurrent), ytd: round2(openingYtd) };
  const closing = addMovements(opening, cashIncrease);
  const values = (value: { current: number; ytd: number }) => ({ current: value.current, ytd: value.ytd });
  const rows: StatementRow[] = [
    line(null, '一、经营活动产生的现金流量：', 'section'), line(1, '销售产成品、商品、提供劳务收到的现金', 'item', values(get(1))),
    line(2, '收到其他与经营活动有关的现金', 'item', values(get(2))), line(3, '购买原材料、商品、接受劳务支付的现金', 'item', values(get(3))),
    line(4, '支付的职工薪酬', 'item', values(get(4))), line(5, '支付的税费', 'item', values(get(5))), line(6, '支付其他与经营活动有关的现金', 'item', values(get(6))),
    line(7, '经营活动产生的现金流量净额', 'subtotal', values(operatingNet)), line(null, '二、投资活动产生的现金流量：', 'section'),
    line(8, '收回短期投资、长期债券投资和长期股权投资收到的现金', 'item', values(get(8))), line(9, '取得投资收益收到的现金', 'item', values(get(9))),
    line(10, '处置固定资产、无形资产和其他非流动资产收回的现金净额', 'item', values(get(10))), line(11, '短期投资、长期债券投资和长期股权投资支付的现金', 'item', values(get(11))),
    line(12, '购建固定资产、无形资产和其他非流动资产支付的现金', 'item', values(get(12))), line(13, '投资活动产生的现金流量净额', 'subtotal', values(investingNet)),
    line(null, '三、筹资活动产生的现金流量：', 'section'), line(14, '取得借款收到的现金', 'item', values(get(14))), line(15, '吸收投资者投资收到的现金', 'item', values(get(15))),
    line(16, '偿还借款本金支付的现金', 'item', values(get(16))), line(17, '偿还借款利息支付的现金', 'item', values(get(17))), line(18, '分配利润支付的现金', 'item', values(get(18))),
    line(19, '筹资活动产生的现金流量净额', 'subtotal', values(financingNet)), line(20, '四、现金净增加额', 'total', values(cashIncrease)),
    line(21, '加：期初现金余额', 'item', values(opening)), line(22, '五、期末现金余额', 'total', values(closing)),
  ];
  const classified = classification.explicit + classification.inferred;
  const total = classified + classification.pending;
  return { formCode: '会小企 03 表', rows, cashIncrease: cashIncrease.ytd, endingCash: closing.ytd, classification: { ...classification, coverage: total ? round2(classified / total * 100) : 100 } };
}

export function classifyCashFlow(counterpartCodes: string[], counterpartItems: Array<string | null>, cashDelta: number, explicit?: string | null) {
  const aliases: Record<string, number> = {
    sales: 1, operating_receipt: 2, purchase: 3, payroll: 4, tax: 5, operating_payment: 6,
    investment_recovery: 8, investment_income: 9, asset_disposal: 10, investment_purchase: 11, asset_purchase: 12,
    borrowing: 14, capital_contribution: 15, loan_repayment: 16, interest_payment: 17, profit_distribution: 18,
  };
  if (explicit && aliases[explicit]) return { line: aliases[explicit], source: 'explicit' as const };
  const starts = (...prefixes: string[]) => counterpartCodes.some((code) => prefixes.some((prefix) => code.startsWith(prefix)));
  const hasItem = (...items: string[]) => counterpartItems.some((item) => item && items.includes(item));
  if (cashDelta > 0 && hasItem('operatingRevenue','otherRevenue')) return { line: 1, source: 'inferred' as const };
  if (cashDelta < 0 && (starts('14','2201','2202') || hasItem('operatingCost','otherCost'))) return { line: 3, source: 'inferred' as const };
  if (cashDelta < 0 && starts('2211')) return { line: 4, source: 'inferred' as const };
  if (cashDelta < 0 && starts('2221')) return { line: 5, source: 'inferred' as const };
  if (starts('1101','1501','1511')) return { line: cashDelta > 0 ? 8 : 11, source: 'inferred' as const };
  if (cashDelta > 0 && hasItem('investmentIncome')) return { line: 9, source: 'inferred' as const };
  if (starts('160','162','170','180')) return { line: cashDelta > 0 ? 10 : 12, source: 'inferred' as const };
  if (starts('2001','2501')) return { line: cashDelta > 0 ? 14 : 16, source: 'inferred' as const };
  if (cashDelta > 0 && starts('3001')) return { line: 15, source: 'inferred' as const };
  if (cashDelta < 0 && hasItem('financialExpenses')) return { line: 17, source: 'inferred' as const };
  if (cashDelta < 0 && starts('2232','3104')) return { line: 18, source: 'inferred' as const };
  return { line: cashDelta > 0 ? 2 : 6, source: 'pending' as const };
}
