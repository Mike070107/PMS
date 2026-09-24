import { request } from '../request';

export interface FinanceAccess { allowed: boolean; canConfigureMailbox: boolean; reason?: string | null }
export interface FinanceProject { id:number; parentId:number|null; name:string }
export interface FinanceEntry { id:number; entryNo:string; businessDate:string; owner:string; reason:string; amount:string; flowType:'income'|'expense'; paymentMethod:string; reimbursementStatus:string }

export const access = () => request<FinanceAccess>({ url: '/finance/access' });
export const projects = () => request<FinanceProject[]>({ url: '/finance/projects' });
export const entries = () => request<FinanceEntry[]>({ url: '/finance/entries' });
export const createEntry = (data: Record<string, unknown>) => request<FinanceEntry>({ method:'POST', url:'/finance/entries', data });
