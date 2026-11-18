import { request } from '../request';
import type { PurchaseRequestView } from '@pms/shared-types';
import type { FamilyCarDetail } from './family-cars';
export type Category = 'purchase' | 'summary' | 'transfer' | 'family' | 'familyOffice' | 'vehicle' | 'business' | 'stocktake' | 'maintenance';
export interface CenterRow {
  key: string; category: Category; id: number; title: string; subtitle: string;
  at: string; result: string; note?: string;
  detail?: PurchaseRequestView | FamilyCarDetail | Record<string, any>;
}
export interface CenterResponse {
  rows: CenterRow[]; categories: { key: Category; label: string; count: number }[];
  tabs: { pending: number; done: number }; allCount: number; total: number; page: number; hasMore: boolean;
}
export const list = (query: { tab?: 'pending' | 'done'; category?: Category | 'all'; q?: string; page?: number; pageSize?: number } = {}) =>
  request<CenterResponse>({ url: '/approval-center', query });
export const decide = (category: Category, id: number, approved: boolean, note?: string) =>
  request<unknown>({ method: 'POST', url: `/approval-center/${category}/${id}/decision`, data: { approved, note } });
