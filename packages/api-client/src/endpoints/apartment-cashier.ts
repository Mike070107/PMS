/**
 * 公寓收费工作台（收费业务 → 公寓收费工作台 / 员工端「更多」里的同名入口）。
 *
 * 和网站后台页调的是同一批接口，没有另造一套：选址走房产那三个列表接口，
 * 收费、历史、今日流水、补打、红冲走 /fees/cashier/*。后端对这些接口放开了
 * `app:apartment-cashier` 这一格权限（见 require-permission.decorator 的说明）。
 */
import { request } from '../request';

export interface CashierCommunity {
  id: number;
  name: string;
}

export interface CashierBuilding {
  id: number;
  communityId: number;
  communityName?: string;
  buildingNo: string;
  lane?: string | null;
}

export interface CashierOwner {
  id: number;
  name: string | null;
  phone: string | null;
}

export interface CashierHouse {
  id: number;
  communityId: number;
  communityName: string;
  buildingId: number;
  buildingNo: string;
  roomNo: string;
  fullAddress: string | null;
  owner: CashierOwner | null;
}

export interface CashierHistoryRow {
  receiptNo: string;
  paidAt: string;
  paymentMethod: string;
  cashier: string | null;
  amountCents: number;
  status: string;
  items: Array<{ feeName: string }>;
}

export interface CashierChargeItem {
  feeCode: string;
  quantity: number;
  unit: string;
  unitPriceCents: number;
  amountCents: number;
  serviceFrom?: string;
  serviceTo?: string;
  vehiclePlate?: string;
}

export interface CashierChargeReq {
  houseId: number;
  ownerId?: number;
  ownerName?: string;
  ownerPhone?: string;
  paymentMethod: string;
  remark?: string;
  items: CashierChargeItem[];
}

/** 不传 page 时后端返回裸数组（收费台和物业费页都依赖这个行为） */
export const communities = () => request<CashierCommunity[]>({ url: '/communities' });

export const buildings = (communityId: number) =>
  request<CashierBuilding[]>({ url: '/buildings', query: { communityId } });

export const houses = (buildingId: number) =>
  request<CashierHouse[]>({ url: '/houses', query: { buildingId } });

/** 这个房间当前生效的收费标准，用来预填单价 */
export const standards = (houseId: number) =>
  request<{ standards: Array<{ feeCode: string; amountCents: number; status: string }> }>({
    url: `/fees/houses/${houseId}`,
  });

export const history = (houseId: number, page = 1) =>
  request<{ rows: CashierHistoryRow[]; total: number }>({
    url: `/fees/cashier/houses/${houseId}/history`,
    query: { page },
  });

export const today = (page = 1) =>
  request<{
    rows: Array<CashierHistoryRow & { buildingNo: string; roomNo: string; ownerName: string | null }>;
    total: number;
    totalCents: number;
  }>({ url: '/fees/cashier/today', query: { page } });

export const charge = (data: CashierChargeReq) =>
  request<{ receiptNo: string }>({ method: 'POST', url: '/fees/cashier/charges', data: data as any });
