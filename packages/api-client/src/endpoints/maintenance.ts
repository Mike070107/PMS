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

export interface MaintenanceSignSession {
  slot: 'filler' | 'repairer' | 'inspector' | 'owner';
  slotLabel: string;
  paperNo: string | null;
  orderNo: string;
  addressText: string;
  repairItem: string | null;
  unitName: string | null;
  signed: boolean;
  signerName: string | null;
  expiresAt: string;
  order: Record<string, any>;
}

export const list = (query: { status?: 'draft' | 'inspected' | 'all'; q?: string } = {}) =>
  request<MaintenanceListItem[]>({ url: '/maintenance-orders', query });

/** 物业经理从员工端打开一次性整单预览与查验签字链接。 */
export const inspectLink = (id: number | string) =>
  request<MaintenanceSignLink>({ method: 'POST', url: `/maintenance-orders/${id}/inspect-token` });

/** 一次性凭证对应的整张养护单；员工端原生预览和外部网页签字共用。 */
export const signSession = (token: string) =>
  request<MaintenanceSignSession>({
    url: '/sign/session',
    query: { token },
    anonymous: true,
  });

/** 提交一次性手写签名，成功后凭证立即失效。 */
export const submitSignature = (token: string, image: string) =>
  request<{ ok: true; slotLabel: string }>({
    method: 'POST',
    url: '/sign/submit',
    data: { token, image },
    anonymous: true,
  });
