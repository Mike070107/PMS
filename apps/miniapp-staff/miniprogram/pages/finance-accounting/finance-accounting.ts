import {
  finance,
  type FinanceAccount,
  type FinanceAccountingOverview,
  type FinanceLedger,
  type FinanceLedgerDetail,
  type FinanceReports,
  type FinanceStatementRow,
  type FinanceVoucher,
} from '@pms/api-client';

const currentPeriod = () => {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
};
const today = () => new Date().toISOString().slice(0, 10);
const money = (value: unknown) => Number(value || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const statusLabels: Record<string, string> = { draft: '待复核', reviewed: '待过账', posted: '已过账', void: '已作废' };
const cashFlowOptions = [
  { value: '', label: '系统自动判断' },
  { value: 'sales', label: '销售商品或提供劳务收款' }, { value: 'operating_receipt', label: '其他经营活动收款' },
  { value: 'purchase', label: '购买商品或接受劳务付款' }, { value: 'payroll', label: '支付职工薪酬' },
  { value: 'tax', label: '支付税费' }, { value: 'operating_payment', label: '其他经营活动付款' },
  { value: 'investment_recovery', label: '收回投资' }, { value: 'investment_income', label: '取得投资收益' },
  { value: 'asset_disposal', label: '处置长期资产收款' }, { value: 'investment_purchase', label: '投资付款' },
  { value: 'asset_purchase', label: '购建长期资产付款' }, { value: 'borrowing', label: '取得借款' },
  { value: 'capital_contribution', label: '吸收投资' }, { value: 'loan_repayment', label: '偿还借款本金' },
  { value: 'interest_payment', label: '偿还借款利息' }, { value: 'profit_distribution', label: '分配利润' },
];

type DisplayRow = FinanceStatementRow & { openingText:string; closingText:string; currentText:string; ytdText:string };
type VoucherView = FinanceVoucher & { statusText:string; debitText:string; creditText:string };
type VoucherFormLine = { accountId:number|null; accountIndex:number; accountText:string; summary:string; debit:string; credit:string; cashFlowItem:string; cashFlowIndex:number; cashFlowText:string };

const displayRows = (rows: FinanceStatementRow[] = []): DisplayRow[] => rows.map((row) => ({
  ...row,
  openingText: row.opening === undefined ? '' : money(row.opening), closingText: row.closing === undefined ? '' : money(row.closing),
  currentText: row.current === undefined ? '' : money(row.current), ytdText: row.ytd === undefined ? '' : money(row.ytd),
}));
const blankLine = (): VoucherFormLine => ({ accountId:null, accountIndex:0, accountText:'请选择科目', summary:'', debit:'', credit:'', cashFlowItem:'', cashFlowIndex:0, cashFlowText:'系统自动判断' });

Page({
  data: {
    loading: true, saving: false, period: currentPeriod(), activeTab: 'reports', reportTab: 'balance', ledgerTab: 'balance',
    entityName: '当前公司', draftCount: 0,
    overview: null as FinanceAccountingOverview | null, reports: null as FinanceReports | null, ledger: null as FinanceLedger | null, ledgerDetail: null as FinanceLedgerDetail | null,
    accounts: [] as FinanceAccount[], accountOptions: [] as string[], vouchers: [] as VoucherView[],
    assetRows: [] as DisplayRow[], liabilityRows: [] as DisplayRow[], profitRows: [] as DisplayRow[], cashRows: [] as DisplayRow[],
    assetTotalText:'0.00', liabilityEquityText:'0.00', netProfitText:'0.00', endingCashText:'0.00',
    voucherSheet: false, editingId: null as number|null, voucherDate: today(), voucherSummary: '', voucherLines: [blankLine(), blankLine()] as VoucherFormLine[],
    cashFlowOptions, cashFlowOptionLabels: cashFlowOptions.map((item) => item.label),
  },

  onLoad() { void this.load(); },
  onPullDownRefresh() { this.load().finally(() => wx.stopPullDownRefresh()); },

  async load() {
    this.setData({ loading: true });
    try {
      const period = this.data.period;
      const [overview, reports, vouchers, ledger, ledgerDetail] = await Promise.all([
        finance.accountingOverview(period), finance.accountingReports(period), finance.accountingVouchers(period),
        finance.accountingLedger(period), finance.accountingLedgerEntries(period),
      ]);
      const accounts = overview.accounts.filter((account) => account.isActive && account.allowPosting);
      this.setData({
        overview, reports, ledger, ledgerDetail, accounts, entityName:reports.entityName || '当前公司', draftCount:overview.voucherCounts.draft,
        accountOptions: ['请选择会计科目', ...accounts.map((account) => `${account.code} ${account.name}`)],
        vouchers: vouchers.map((voucher) => ({ ...voucher, statusText: statusLabels[voucher.status] || voucher.status, debitText: money(voucher.totalDebit), creditText: money(voucher.totalCredit) })),
        assetRows: displayRows(reports.balanceSheet.assetRows), liabilityRows: displayRows(reports.balanceSheet.liabilityEquityRows),
        profitRows: displayRows(reports.profitStatement.rows), cashRows: displayRows(reports.cashFlowStatement.rows),
        assetTotalText: money(reports.balanceSheet.assets), liabilityEquityText: money(reports.balanceSheet.liabilitiesAndEquity),
        netProfitText: money(reports.profitStatement.netProfit), endingCashText: money(reports.cashFlowStatement.endingCash),
      });
    } catch (error: any) { wx.showToast({ icon:'none', title:error?.message || '账务数据加载失败' }); }
    finally { this.setData({ loading:false }); }
  },

  setTab(event: any) { this.setData({ activeTab:event.currentTarget.dataset.key }); },
  setReportTab(event: any) { this.setData({ reportTab:event.currentTarget.dataset.key }); },
  setLedgerTab(event: any) { this.setData({ ledgerTab:event.currentTarget.dataset.key }); },
  onPeriod(event: any) { this.setData({ period:String(event.detail.value).slice(0, 7) }); void this.load(); },

  openVoucher(event?: any) {
    const id = Number(event?.currentTarget?.dataset?.id || 0);
    const voucher = id ? this.data.vouchers.find((item) => item.id === id) : null;
    if (voucher && voucher.status === 'posted') return wx.showToast({ icon:'none', title:'已过账凭证需先取消过账' });
    const lines = voucher ? voucher.lines.map((line) => {
      const accountIndex = Math.max(0, this.data.accounts.findIndex((account) => account.id === line.accountId) + 1);
      const cashFlowIndex = Math.max(0, cashFlowOptions.findIndex((item) => item.value === (line.cashFlowItem || '')));
      return { accountId:line.accountId, accountIndex, accountText:this.data.accountOptions[accountIndex] || '请选择会计科目', summary:line.summary || voucher.summary, debit:Number(line.debit) ? String(line.debit) : '', credit:Number(line.credit) ? String(line.credit) : '', cashFlowItem:line.cashFlowItem || '', cashFlowIndex, cashFlowText:cashFlowOptions[cashFlowIndex].label };
    }) : [blankLine(), blankLine()];
    this.setData({ voucherSheet:true, editingId:voucher?.id || null, voucherDate:voucher?.voucherDate || today(), voucherSummary:voucher?.summary || '', voucherLines:lines });
  },
  closeVoucher() { if (!this.data.saving) this.setData({ voucherSheet:false }); },
  onVoucherDate(event:any) { this.setData({ voucherDate:event.detail.value }); },
  onVoucherSummary(event:any) { this.setData({ voucherSummary:event.detail.value }); },
  onLineInput(event:any) { const index=Number(event.currentTarget.dataset.index); const field=event.currentTarget.dataset.field; this.setData({ [`voucherLines[${index}].${field}`]:event.detail.value }); },
  onLineAccount(event:any) {
    const index=Number(event.currentTarget.dataset.index); const accountIndex=Number(event.detail.value); const account=this.data.accounts[accountIndex-1];
    this.setData({ [`voucherLines[${index}].accountIndex`]:accountIndex, [`voucherLines[${index}].accountId`]:account?.id || null, [`voucherLines[${index}].accountText`]:this.data.accountOptions[accountIndex] });
  },
  onLineCashFlow(event:any) {
    const index=Number(event.currentTarget.dataset.index); const optionIndex=Number(event.detail.value); const option=cashFlowOptions[optionIndex];
    this.setData({ [`voucherLines[${index}].cashFlowIndex`]:optionIndex, [`voucherLines[${index}].cashFlowItem`]:option.value, [`voucherLines[${index}].cashFlowText`]:option.label });
  },
  addVoucherLine() { this.setData({ voucherLines:[...this.data.voucherLines, blankLine()] }); },
  removeVoucherLine(event:any) { const index=Number(event.currentTarget.dataset.index); if(this.data.voucherLines.length<=2)return wx.showToast({icon:'none',title:'凭证至少保留两行'}); const next=this.data.voucherLines.slice();next.splice(index,1);this.setData({voucherLines:next}); },
  async saveVoucher() {
    const summary=this.data.voucherSummary.trim(); if(!summary)return wx.showToast({icon:'none',title:'请填写凭证摘要'});
    const lines=this.data.voucherLines.map((line)=>({accountId:line.accountId,summary:line.summary.trim()||summary,debit:Number(line.debit||0),credit:Number(line.credit||0),cashFlowItem:line.cashFlowItem||null}));
    if(lines.some((line)=>!line.accountId))return wx.showToast({icon:'none',title:'请选择每一行的会计科目'});
    if(lines.some((line)=>(line.debit>0)===(line.credit>0)))return wx.showToast({icon:'none',title:'每行只能填写借方或贷方金额'});
    const debit=lines.reduce((sum,line)=>sum+line.debit,0); const credit=lines.reduce((sum,line)=>sum+line.credit,0);
    if(!debit||Math.abs(debit-credit)>0.005)return wx.showToast({icon:'none',title:`借贷不平：借方 ${money(debit)}，贷方 ${money(credit)}`});
    this.setData({saving:true});
    try { const data={voucherDate:this.data.voucherDate,summary,lines}; if(this.data.editingId)await finance.updateVoucher(this.data.editingId,data);else await finance.createVoucher(data); wx.showToast({icon:'success',title:this.data.editingId?'修改已保存':'凭证已创建'});this.setData({voucherSheet:false});await this.load(); }
    catch(error:any){wx.showToast({icon:'none',title:error?.message||'保存失败'});}finally{this.setData({saving:false});}
  },
  async changeStatus(event:any) {
    const id=Number(event.currentTarget.dataset.id); const action=event.currentTarget.dataset.action as 'review'|'post'|'unpost';
    const labels={review:'复核',post:'过账',unpost:'取消过账'};
    const result=await wx.showModal({title:`确认${labels[action]}？`,content:action==='post'?'过账后将计入账簿和财务报表。':'系统会保留完整操作记录。'});if(!result.confirm)return;
    try{await finance.changeVoucherStatus(id,action);wx.showToast({icon:'success',title:`已${labels[action]}`});await this.load();}catch(error:any){wx.showToast({icon:'none',title:error?.message||'操作失败'});}
  },
  noop() {},
});
