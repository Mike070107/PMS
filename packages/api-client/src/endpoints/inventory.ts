import type {
  MaterialCategoryView,
  MaterialOption,
  MaterialView,
  PurchaseRequestView,
  StockLotView,
  StockMovementView,
  StocktakeOrderView,
  StockView,
  WarehouseLocationView,
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
  /** 传 photoUrls 就够了，photoUrl 由服务端取第一张同步 */
  photoUrl?: string;
  photoUrls?: string[];
  aliases?: string[];
  params?: string;
  enabled?: boolean;
}

export const createMaterial = (data: UpsertMaterialReq) =>
  request<MaterialView>({ method: 'POST', url: '/materials', data });

/** 小程序不支持 PATCH，后端另开了等价的 POST 入口 */
export const updateMaterial = (id: number, data: Partial<UpsertMaterialReq>) =>
  request<MaterialView>({ method: 'POST', url: `/materials/${id}/update`, data });

// ---------------- 材料类别 ----------------

/**
 * 材料类别档案（后台可增删改）。**新建 / 编辑 SKU 的类别下拉一律用它**，
 * 不要再引 shared-types 里的 MATERIAL_CATEGORIES 常量 —— 那只是种子。
 */
export const listMaterialCategories = () =>
  request<MaterialCategoryView[]>({ url: '/material-categories' });

// ---------------- 库存 ----------------

/** scope=mine：只要本人范围能看的仓（自己管理处的排前面 + 公司级），员工端库存页用 */
export const listWarehouses = (query: { scope?: 'mine' | 'visible' } = {}) =>
  request<WarehouseView[]>({ url: '/warehouses', query: query as any });

/** 某个仓的库位（货架格），入库时选存放位置 */
export const listWarehouseLocations = (query: { warehouseId?: number } = {}) =>
  request<WarehouseLocationView[]>({ url: '/warehouse-locations', query: query as any });

export const listStocks = (query: { warehouseId?: number; materialId?: number } = {}) =>
  request<StockView[]>({ url: '/stocks', query: query as any });

/** 某条库存的批次明细（含已耗尽的），先进先出顺序 */
export const listStockLots = (stockId: number) =>
  request<StockLotView[]>({ url: `/stocks/${stockId}/lots` });

/** 出入库流水，最新在前，默认 100 条 */
export const listStockMovements = (query: { warehouseId?: number; materialId?: number; limit?: number } = {}) =>
  request<StockMovementView[]>({ url: '/stock-movements', query: query as any });

// ---------------- 入库 ----------------

export interface GeneralReceiptItemReq {
  materialId: number;
  qty: number;
  unitCostCents: number;
  /** 实物照片，选填 —— 货先入账，照片事后补 */
  photoUrls?: string[];
  locationId?: number;
}

export interface CreateGeneralReceiptReq {
  warehouseId: number;
  /** 材料来源，必填：如「XX 五金店零星采买」 */
  sourceText: string;
  /** 小票 / 发票等凭证，选填 */
  attachments?: string[];
  items: GeneralReceiptItemReq[];
}

/**
 * 一般入库（无采购单的零星采买）。会写一张入库单 + 批次 + 出入库流水，
 * 库存清单和「入库记录」立刻能查到。
 */
export const createGeneralReceipt = (data: CreateGeneralReceiptReq) =>
  request<{ id: number; receiptNo: string }>({
    method: 'POST',
    url: '/goods-receipts/general',
    data,
  });

// ---------------- 采购 ----------------

export const listPurchaseRequests = (query: { status?: string } = {}) =>
  request<PurchaseRequestView[]>({ url: '/purchase-requests', query: query as any });

// ---------------- 盘点单 ----------------

/** 盘点单列表（不带明细行，只有进度和过账汇总），最新在前 */
export const listStocktakeOrders = (query: { status?: string } = {}) =>
  request<StocktakeOrderView[]>({ url: '/stocktake-orders', query: query as any });

/** 盘点单详情：明细行已带材料名/编码/照片/当前账面数，端上直接渲染 */
export const getStocktakeOrder = (id: number) =>
  request<StocktakeOrderView>({ url: `/stocktake-orders/${id}` });

/** 开一张盘点单：按当时该仓的库存行生成盘点清单 */
export const createStocktakeOrder = (data: { warehouseId: number; note?: string }) =>
  request<StocktakeOrderView>({ method: 'POST', url: '/stocktake-orders', data });

/**
 * 分批保存实盘数（只传这次改过的行）。账上没有、实物有的材料
 * 也从这里进：传一个不在清单里的 materialId 就会补一行。
 */
export const saveStocktakeCounts = (
  id: number,
  data: { items: Array<{ materialId: number; countedQty?: number; note?: string }> },
) => request<StocktakeOrderView>({ method: 'POST', url: `/stocktake-orders/${id}/counts`, data });

/** 盘完提交审核（counting → pending_review）；审核和过账在管理后台完成 */
export const submitStocktakeOrder = (id: number) =>
  request<StocktakeOrderView>({ method: 'POST', url: `/stocktake-orders/${id}/submit` });
