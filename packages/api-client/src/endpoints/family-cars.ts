import { request } from '../request';

export type FamilyCarStatus = 'upload' | 'office' | 'manager' | 'returned' | 'opening' | 'active' | 'expired' | 'void';

export interface FamilyCarRow {
  id: number;
  houseId: number | null;
  lane: string;
  buildingNo: string;
  roomNo: string;
  roomKey: string;
  ownerName: string;
  ownerPhone: string;
  carOwnerName: string;
  carOwnerPhone: string;
  relation: string;
  plate: string;
  remark: string;
  status: FamilyCarStatus;
  statusLabel: string;
  mode: 'new' | 'existing';
  ownerFill: boolean;
  startDate: string | null;
  endDate: string | null;
  daysLeft: number | null;
  expiringSoon: boolean;
  garages: string[];
  garageNumbers: Record<string, string>;
  fileCount: number;
  lastError: string | null;
  previousId: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface FamilyCarFile {
  index: number;
  fileName: string;
  contentType: string;
  source: 'office' | 'owner';
  uploadedAt: string;
  fileUrl: string;
}

export interface FamilyCarOperationState {
  id: number;
  status: 'pending' | 'running' | 'completed' | 'failed';
  error: string | null;
  completedAt: string | null;
}

export interface FamilyCarDetail extends FamilyCarRow {
  files: FamilyCarFile[];
  proofUploadId: number | null;
  officeNote: string;
  officeReviewedAt: string | null;
  managerNote: string;
  managerReviewedAt: string | null;
  log: Array<{ at: string; userId: number | null; userName: string; action: string; note?: string }>;
  operationStates?: Record<'registration' | 'open' | 'renew' | 'civil' | 'expire', FamilyCarOperationState | null>;
  upload?: { id: number; expiresAt: string; status: 'waiting' | 'opened' | 'submitted' | 'expired' } | null;
}

export interface FamilyCarQr {
  id: number;
  plate: string;
  url: string;
  qrDataUrl: string;
  expiresAt: string;
  status: 'waiting';
}

export interface FamilyCarHouseContext {
  house: {
    houseId: number; lane: string; buildingNo: string; roomNo: string; roomKey: string; communityName: string;
    ownerName: string; ownerPhone: string; database: 'parking1' | 'parking2'; garages: string[];
  };
  rows: FamilyCarRow[];
}

export interface CreateFamilyCarReq {
  houseId: number;
  plate: string;
  duplicateCheckQueryId: number;
  ownerFill?: boolean;
  carOwnerName?: string;
  carOwnerPhone?: string;
  relation?: string;
  remark?: string;
  garages: string[];
  garageNumbers?: Record<string, string>;
  previousId?: number;
}

export const list = (params: { status?: string; lane?: string; q?: string } = {}) => {
  const query = Object.entries(params).filter(([, value]) => value).map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`).join('&');
  return request<{ rows: FamilyCarRow[]; today: string }>({ url: `/family-cars${query ? `?${query}` : ''}`, method: 'GET' });
};

export const pendingManager = () =>
  request<FamilyCarDetail[]>({ url: '/family-cars/pending-manager', method: 'GET' });

export const detail = (id: number) => request<FamilyCarDetail>({ url: `/family-cars/${id}`, method: 'GET' });

export const houseContext = (houseId: number) =>
  request<FamilyCarHouseContext>({ url: `/family-cars/houses/${houseId}`, method: 'GET' });

export const create = (data: CreateFamilyCarReq) =>
  request<FamilyCarDetail & { qr: FamilyCarQr }>({ url: '/family-cars', method: 'POST', data });

export const update = (id: number, data: Partial<Pick<FamilyCarRow, 'carOwnerName' | 'carOwnerPhone' | 'relation' | 'remark' | 'garages' | 'garageNumbers'>>) =>
  request<FamilyCarDetail>({ url: `/family-cars/${id}`, method: 'PATCH', data });

export const regenerateQr = (id: number) =>
  request<FamilyCarDetail & { qr: FamilyCarQr }>({ url: `/family-cars/${id}/qr`, method: 'POST' });

export const removeFile = (id: number, index: number) =>
  request<FamilyCarDetail>({ url: `/family-cars/${id}/files/${index}`, method: 'DELETE' });

export const submit = (id: number) => request<FamilyCarDetail>({ url: `/family-cars/${id}/submit`, method: 'POST' });

export const officeReview = (id: number, decision: 'approve' | 'reupload' | 'void', note?: string) =>
  request<FamilyCarDetail & { qr?: FamilyCarQr }>({ url: `/family-cars/${id}/office-review`, method: 'POST', data: { decision, note } });

export const managerReview = (id: number, decision: 'approve' | 'return', note?: string) =>
  request<FamilyCarDetail>({ url: `/family-cars/${id}/manager-review`, method: 'POST', data: { decision, note } });

export const retry = (id: number) => request<FamilyCarDetail>({ url: `/family-cars/${id}/retry`, method: 'POST' });

export const stop = (id: number, note: string) =>
  request<FamilyCarDetail>({ url: `/family-cars/${id}/stop`, method: 'POST', data: { note } });
