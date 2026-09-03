import { request } from '../request';

export interface MaintenanceListItem {
  id: number;
  orderNo: string;
  paperNo: string | null;
  workOrderNo: string | null;
  status: 'draft' | 'inspected' | 'void';
  addressText: string;
  repairItem: string | null;
  reporterName: string | null;
  repairerName: string | null;
  totalCents: number;
  createdAt: string;
}

export interface MaintenanceSignLink {
  token: string;
  url: string;
  qrDataUrl: string;
  slot: 'inspector';
  slotLabel: string;
  expiresInSec: number;
  expiresAt: string;
}

export const list = (query: { status?: 'draft' | 'inspected' | 'all'; q?: string } = {}) =>
  request<MaintenanceListItem[]>({ url: '/maintenance-orders', query });

/** 物业经理从员工端打开一次性整单预览与查验签字链接。 */
export const inspectLink = (id: number | string) =>
  request<MaintenanceSignLink>({ method: 'POST', url: `/maintenance-orders/${id}/inspect-token` });
