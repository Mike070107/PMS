export type StandardAccount = {
  code: string;
  name: string;
  category: 'asset' | 'liability' | 'equity' | 'cost' | 'profit_loss';
  direction: 'debit' | 'credit';
  mapping?: Record<string, string>;
};

export type StandardDetailAccount = {
  code: string;
  name: string;
  parentCode: string;
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

// 日常记账中通用性较高的明细科目。客户、供应商、银行账号等特定对象仍由企业自行新增。
// 代码和上级关系固定，报表映射从一级科目继承，不改变《小企业会计准则》的报表口径。
export const SMALL_ENTERPRISE_DETAIL_ACCOUNTS: StandardDetailAccount[] = [
  ['100101','人民币','1001'],['100102','外币','1001'],
  ['100201','基本存款账户','1002'],['100202','一般存款账户','1002'],
  ['101201','银行汇票存款','1012'],['101202','银行本票存款','1012'],['101203','信用卡存款','1012'],['101204','信用证保证金存款','1012'],['101205','第三方支付平台','1012'],
  ['110101','股票','1101'],['110102','债券','1101'],['110103','基金','1101'],
  ['122101','员工借款','1221'],['122102','押金保证金','1221'],['122103','应收赔款','1221'],['122199','其他','1221'],
  ['140301','主要材料','1403'],['140302','辅助材料','1403'],['140303','包装材料','1403'],
  ['140501','产成品','1405'],['140502','外购商品','1405'],['140503','发出商品','1405'],
  ['141101','低值易耗品','1411'],['141102','包装物','1411'],
  ['160101','房屋及建筑物','1601'],['160102','机器设备','1601'],['160103','运输工具','1601'],['160104','电子设备','1601'],['160105','办公家具','1601'],['160199','其他固定资产','1601'],
  ['160201','房屋及建筑物折旧','1602'],['160202','机器设备折旧','1602'],['160203','运输工具折旧','1602'],['160204','电子设备折旧','1602'],['160205','办公家具折旧','1602'],['160299','其他固定资产折旧','1602'],
  ['170101','软件','1701'],['170102','专利权','1701'],['170103','商标权','1701'],['170104','土地使用权','1701'],
  ['170201','软件累计摊销','1702'],['170202','专利权累计摊销','1702'],['170203','商标权累计摊销','1702'],['170204','土地使用权累计摊销','1702'],
  ['180101','装修改造支出','1801'],['180102','租入固定资产改良支出','1801'],['180199','其他长期待摊费用','1801'],
  ['200101','信用借款','2001'],['200102','抵押借款','2001'],['200103','保证借款','2001'],
  ['221101','工资','2211'],['221102','奖金津贴和补贴','2211'],['221103','职工福利费','2211'],['221104','社会保险费','2211'],['221105','住房公积金','2211'],['221106','工会经费','2211'],['221107','职工教育经费','2211'],
  ['222101','应交增值税','2221'],['22210101','进项税额','222101'],['22210102','已交税金','222101'],['22210103','减免税款','222101'],['22210104','转出未交增值税','222101'],['22210105','销项税额','222101'],['22210106','出口退税','222101'],['22210107','进项税额转出','222101'],['22210108','转出多交增值税','222101'],
  ['222102','未交增值税','2221'],['222103','预交增值税','2221'],['222104','待抵扣进项税额','2221'],['222105','待认证进项税额','2221'],['222106','待转销项税额','2221'],['222107','简易计税','2221'],['222108','应交企业所得税','2221'],['222109','应交个人所得税','2221'],['222110','应交城市维护建设税','2221'],['222111','应交教育费附加','2221'],['222112','应交地方教育附加','2221'],['222113','应交印花税','2221'],['222114','应交房产税','2221'],['222115','应交城镇土地使用税','2221'],['222116','应交车船税','2221'],
  ['224101','应付报销款','2241'],['224102','押金保证金','2241'],['224103','应付投资人款','2241'],['224199','其他','2241'],
  ['250101','抵押借款','2501'],['250102','保证借款','2501'],
  ['300101','法人投入资本','3001'],['300102','个人投入资本','3001'],
  ['310101','法定盈余公积','3101'],['310102','任意盈余公积','3101'],
  ['310401','未分配利润','3104'],['310402','提取法定盈余公积','3104'],['310403','提取任意盈余公积','3104'],['310404','应付利润','3104'],
  ['400101','直接材料','4001'],['400102','直接人工','4001'],['400103','制造费用','4001'],['400104','劳务成本','4001'],
  ['410101','职工薪酬','4101'],['410102','机物料消耗','4101'],['410103','折旧费','4101'],['410104','修理费','4101'],['410105','水电费','4101'],['410199','其他','4101'],
  ['430101','费用化支出','4301'],['430102','资本化支出','4301'],
  ['500101','销售商品收入','5001'],['500102','提供劳务收入','5001'],['500103','工程结算收入','5001'],
  ['505101','材料销售收入','5051'],['505102','租赁收入','5051'],['505199','其他','5051'],
  ['530101','政府补助','5301'],['530102','盘盈收益','5301'],['530103','捐赠收益','5301'],['530199','其他','5301'],
  ['540101','销售商品成本','5401'],['540102','提供劳务成本','5401'],['540103','工程结算成本','5401'],
  ['540201','材料销售成本','5402'],['540202','租赁成本','5402'],['540299','其他','5402'],
  ['540301','城市维护建设税','5403'],['540302','教育费附加','5403'],['540303','地方教育附加','5403'],['540304','印花税','5403'],['540305','房产税','5403'],['540306','城镇土地使用税','5403'],
  ['560101','职工薪酬','5601'],['560102','广告宣传费','5601'],['560103','业务招待费','5601'],['560104','差旅费','5601'],['560105','运输费','5601'],['560106','办公费','5601'],['560107','折旧费','5601'],['560108','修理费','5601'],['560109','保险费','5601'],['560199','其他','5601'],
  ['560201','职工薪酬','5602'],['560202','办公费','5602'],['560203','差旅费','5602'],['560204','业务招待费','5602'],['560205','咨询服务费','5602'],['560206','审计费','5602'],['560207','租赁费','5602'],['560208','水电物业费','5602'],['560209','折旧费','5602'],['560210','无形资产摊销','5602'],['560211','长期待摊费用摊销','5602'],['560212','修理费','5602'],['560213','保险费','5602'],['560214','低值易耗品摊销','5602'],['560299','其他','5602'],
  ['560301','利息费用','5603'],['560302','利息收入','5603'],['560303','银行手续费','5603'],['560304','汇兑损益','5603'],
  ['571101','非流动资产处置损失','5711'],['571102','盘亏损失','5711'],['571103','罚款滞纳金','5711'],['571104','捐赠支出','5711'],['571199','其他','5711'],
].map(([code, name, parentCode]) => ({ code, name, parentCode }));

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
