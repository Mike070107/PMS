import { request, uploadFileTo } from '../request';

export interface FinanceAccess { allowed: boolean; canConfigureMailbox: boolean; reason?: string | null }
export interface FinanceDashboard { month:{ income:string; expense:string; balance:string }; pendingReimbursement:number; invoiceInbox:number; projects:number }
export interface FinanceProject { id:number; parentId:number|null; name:string; description?:string|null }
export interface FinanceEntry { id:number; entryNo:string; businessDate:string; owner:string; reason:string; amount:string; flowType:'income'|'expense'; paymentMethod:string; reimbursementStatus:string; projectId?:number|null; subProjectId?:number|null; score?:number }
export interface FinanceInvoice { id:number; originalName:string; source:'email'|'upload'; amount:string|null; invoiceDate:string|null; status:string; entryId:number|null; createdAt:string; discardReason?:string|null }
export interface FinanceReimbursement { id:number; applicationNo:string; claimantName:string; applicationDate:string; amount:string; status:string; reason:string; entryIds:number[] }

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
export const reimbursements = () => request<FinanceReimbursement[]>({ url:'/finance/reimbursements' });
export const createReimbursement = (data: Record<string, unknown>) => request<FinanceReimbursement>({ method:'POST', url:'/finance/reimbursements', data });
export const markReimbursementPaid = (id:number) => request({ method:'POST', url:`/finance/reimbursements/${id}/paid` });
