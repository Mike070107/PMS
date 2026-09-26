import { downloadFileFrom, request, uploadFileTo } from '../request';

export interface FinanceAccess { allowed: boolean; canConfigureMailbox: boolean; reason?: string | null }
export interface FinanceDashboard { month:{ income:string; expense:string; balance:string }; pendingReimbursement:number; invoiceInbox:number; projects:number }
export interface FinanceAttachment { name:string; objectKey:string; contentType?:string; size?:number }
export interface FinanceProject { id:number; parentId:number|null; name:string; description?:string|null; attachments?:FinanceAttachment[] }
export interface FinanceEntry { id:number; entryNo:string; businessDate:string; owner:string; reason:string; amount:string; flowType:'income'|'expense'; paymentMethod:string; reimbursementStatus:string; projectId?:number|null; subProjectId?:number|null; voucherAttachments?:FinanceAttachment[]; score?:number }
export interface FinanceInvoice { id:number; originalName:string; source:'email'|'upload'|'tax_account'; amount:string|null; taxAmount?:string|null; invoiceDate:string|null; invoiceNo?:string|null; status:string; entryId:number|null; createdAt:string; discardReason?:string|null; recognitionStatus?:string; recognitionSource?:string|null; verificationStatus?:string; verifiedAt?:string|null; verificationSource?:string|null }
export interface FinanceInvoiceVerification { id:number; invoiceId:number; status:string; source:string; checkedAt:string; message?:string|null }
export interface FinanceTaxImportBatch { id:number; originalName:string; status:string; totalRows:number; importedRows:number; updatedRows:number; failedRows:number; errors:Array<{row:number;message:string}>; createdAt:string }
export interface FinanceReimbursement { id:number; applicationNo:string; claimantName:string; applicationDate:string; amount:string; status:string; reason:string; entryIds:number[] }
export interface FinanceAccount { id:number; code:string; name:string; category:string; allowPosting:boolean; isActive:boolean }
export interface FinanceVoucherLine { id?:number; accountId:number; summary:string; debit:string|number; credit:string|number; counterpartyName?:string|null; cashFlowItem?:string|null; account?:FinanceAccount }
export interface FinanceVoucher { id:number; voucherNo:string; voucherDate:string; period:string; summary:string; status:'draft'|'reviewed'|'posted'|'void'; totalDebit:string; totalCredit:string; lines:FinanceVoucherLine[] }
export interface FinanceAccountingOverview { accountSet:{ name:string; currentPeriod:string; closedThrough:string|null }; accounts:FinanceAccount[]; voucherCounts:{draft:number;reviewed:number;posted:number}; periods:Array<{period:string;status:string}> }
export interface FinanceStatementRow { line:number|null; label:string; kind:'section'|'item'|'detail'|'subtotal'|'total'; opening?:number; closing?:number; current?:number; ytd?:number }
export interface FinanceReports {
  period:string; entityName:string; accountingStandard:string; unit:string;
  balanceSheet:{ formCode:string; assetRows:FinanceStatementRow[]; liabilityEquityRows:FinanceStatementRow[]; assets:number; liabilities:number; equity:number; liabilitiesAndEquity:number; openingBalanced:boolean; balanced:boolean };
  profitStatement:{ formCode:string; rows:FinanceStatementRow[]; operatingRevenue:number; operatingCosts:number; netProfit:number };
  cashFlowStatement:{ formCode:string; rows:FinanceStatementRow[]; cashIncrease:number; endingCash:number; classification:{explicit:number;inferred:number;pending:number;pendingAmount:number;coverage:number} };
  validations:Array<{key:string;label:string;ok:boolean;warning?:boolean;detail:string}>; traceable:boolean; cashFlowReconciled:boolean;
}
export interface FinanceLedgerRow { account:FinanceAccount; openingDebit:string; openingCredit:string; debit:string; credit:string; closingDebit:string; closingCredit:string }
export interface FinanceLedger { period:string; rows:FinanceLedgerRow[]; validation:{debit:number;credit:number;balanced:boolean} }
export interface FinanceLedgerEntry { id:number; summary:string; debit:string; credit:string; projectName?:string|null; counterpartyName?:string|null; account:FinanceAccount; voucher:{voucherNo:string;voucherDate:string} }
export interface FinanceLedgerDetail { entries:FinanceLedgerEntry[]; projectSummary:Array<{name:string;debit:number;credit:number;entries:number}>; counterpartySummary:Array<{name:string;debit:number;credit:number;entries:number}> }

export const access = () => request<FinanceAccess>({ url: '/finance/access' });
export const dashboard = () => request<FinanceDashboard>({ url: '/finance/dashboard' });
export const projects = () => request<FinanceProject[]>({ url: '/finance/projects' });
export const createProject = (data: Record<string, unknown>) => request<FinanceProject>({ method:'POST', url:'/finance/projects', data });
export const entries = () => request<FinanceEntry[]>({ url: '/finance/entries' });
export const createEntry = (data: Record<string, unknown>) => request<FinanceEntry>({ method:'POST', url:'/finance/entries', data });
export const invoices = () => request<FinanceInvoice[]>({ url:'/finance/invoices' });
export const invoiceCandidates = (id:number) => request<FinanceEntry[]>({ url:`/finance/invoices/${id}/candidates` });
export const matchInvoice = (id:number, entryId:number) => request({ method:'POST', url:`/finance/invoices/${id}/match`, data:{entryId} });
export const discardInvoice = (id:number) => request({ method:'POST', url:`/finance/invoices/${id}/discard`, data:{reason:'小程序人工确认无需入账'} });
export const restoreInvoice = (id:number) => request({ method:'POST', url:`/finance/invoices/${id}/restore` });
export const uploadInvoice = (tempFilePath:string) => uploadFileTo(tempFilePath, '/finance/invoices/upload', 120000);
export const uploadAttachment = (tempFilePath:string) => uploadFileTo<FinanceAttachment>(tempFilePath, '/finance/attachments', 120000);
export const downloadAttachment = (objectKey:string) => downloadFileFrom(`/finance/files?key=${encodeURIComponent(objectKey)}`, 120000);
export const invoiceVerificationHistory = (id:number) => request<FinanceInvoiceVerification[]>({ url:`/finance/invoices/${id}/verification-history` });
export const verifyInvoice = (id:number, provider='default') => request<FinanceInvoice>({ method:'POST', url:`/finance/invoices/${id}/verify`, data:{provider} });
export const taxImportBatches = () => request<FinanceTaxImportBatch[]>({ url:'/finance/tax-account-imports' });
export const uploadTaxAccountExport = (tempFilePath:string) => uploadFileTo(tempFilePath, '/finance/tax-account-imports', 120000);
export const reimbursements = () => request<FinanceReimbursement[]>({ url:'/finance/reimbursements' });
export const createReimbursement = (data: Record<string, unknown>) => request<FinanceReimbursement>({ method:'POST', url:'/finance/reimbursements', data });
export const markReimbursementPaid = (id:number) => request({ method:'POST', url:`/finance/reimbursements/${id}/paid` });
export const accountingOverview = (period?:string) => request<FinanceAccountingOverview>({ url:`/finance/accounting/overview${period ? `?period=${encodeURIComponent(period)}` : ''}` });
export const accountingVouchers = (period:string) => request<FinanceVoucher[]>({ url:`/finance/accounting/vouchers?period=${encodeURIComponent(period)}` });
export const accountingReports = (period:string) => request<FinanceReports>({ url:`/finance/accounting/reports?period=${encodeURIComponent(period)}` });
export const accountingLedger = (period:string) => request<FinanceLedger>({ url:`/finance/accounting/ledger?period=${encodeURIComponent(period)}` });
export const accountingLedgerEntries = (period:string) => request<FinanceLedgerDetail>({ url:`/finance/accounting/ledger-entries?period=${encodeURIComponent(period)}` });
export const createVoucher = (data:Record<string,unknown>) => request<FinanceVoucher>({ method:'POST', url:'/finance/accounting/vouchers', data });
export const updateVoucher = (id:number, data:Record<string,unknown>) => request<FinanceVoucher>({ method:'PUT', url:`/finance/accounting/vouchers/${id}`, data });
export const changeVoucherStatus = (id:number, action:'review'|'post'|'unpost') => request<FinanceVoucher>({ method:'POST', url:`/finance/accounting/vouchers/${id}/status`, data:{action} });
