import type {
  MaterialOption,
  MaterialView,
  PurchaseRequestView,
  StockView,
  WarehouseView,
} from '@pms/shared-types';
import { request } from '../request';

// ---------------- 材料 SKU ----------------

export const listMaterials = () => request<MaterialView[]>({ url: '/materials' });

/**
 * 材料选择器数据源：启用中的 SKU，含实物照片、不含成本价，维修工也能读。
 * 缺料登记这类「挑材料」的场景一律用它，别用 listMaterials（那个维修工没权限）。
 */
export const listMaterialOptions = () =>
  request<MaterialOption[]>({ url: '/materials/options' });

export interface UpsertMaterialReq {
  name: string;
  spec?: string;
  category?: string;
  unit: string;
  defaultCostCents?: number;
  photoUrl?: string;
  aliases?: string[];
  params?: string;
  enabled?: boolean;
}

export const createMaterial = (data: UpsertMaterialReq) =>
  request<MaterialView>({ method: 'POST', url: '/materials', data });

/** 小程序不支持 PATCH，后端另开了等价的 POST 入口 */
export const updateMaterial = (id: number, data: Partial<UpsertMaterialReq>) =>
  request<MaterialView>({ method: 'POST', url: `/materials/${id}/update`, data });

// ---------------- 库存 ----------------

/** scope=mine：只要本人范围能看的仓（自己管理处的排前面 + 公司级），员工端库存页用 */
export const listWarehouses = (query: { scope?: 'mine' } = {}) =>
  request<WarehouseView[]>({ url: '/warehouses', query: query as any });

export const listStocks = (query: { warehouseId?: number; materialId?: number } = {}) =>
  request<StockView[]>({ url: '/stocks', query: query as any });

// ---------------- 采购 ----------------

export const listPurchaseRequests = (query: { status?: string } = {}) =>
  request<PurchaseRequestView[]>({ url: '/purchase-requests', query: query as any });
