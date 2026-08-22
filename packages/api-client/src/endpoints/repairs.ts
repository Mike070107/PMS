import type {
  CompleteWorkOrderReq,
  RepairCreateReq,
  WorkOrderDetail,
  WorkOrderListItem,
  WorkOrderStatus,
  WorkOrderStockOptions,
} from '@pms/shared-types';
import { request } from '../request';

export interface PublicRepairType {
  repairType: string;
  label: string;
  /** 该类型的常用描述关键词，用于「随手拍报修」自动判定类型 */
  keywords: string[];
}

/** 租户配置的报修类型（启用中的），任意登录角色可读 */
export const types = () => request<PublicRepairType[]>({ url: '/repair-types' });

export interface ActionSuggestion {
  text: string;
  /** 本租户历史里用过多少次；0 = 系统预置、还没人用过 */
  count: number;
}

/**
 * 维修说明的常用话术，按报修类型分组。
 * 排序由历史维修说明归纳（用得多、用得新的排前面），单子越多越贴合本小区。
 */
export const actionSuggestions = () =>
  request<{ byType: Record<string, ActionSuggestion[]>; general: ActionSuggestion[] }>({
    url: '/repair-action-suggestions',
  });

/** 随手拍地址识别的结果；matched=false 表示描述里没有能对上库的地址 */
export interface ParsedRepairAddress {
  matched: boolean;
  /** 识别到的最细粒度：house 到房号 / building 到楼栋 / community 到小区 */
  level?: 'house' | 'building' | 'community';
  communityId?: number;
  communityName?: string;
  buildingId?: number | null;
  buildingText?: string;
  houseId?: number | null;
  roomNo?: string | null;
  /** 可直接展示/提交的完整地址文案，如「枫桦景苑一期 198弄24号302室」 */
  addressText?: string;
  /** 描述里命中的片段（归一化），如「一期24号」，用于展示与「忽略」去重 */
  matchedText?: string;
}

/**
 * 从报修描述里识别地址（「一期24号302」→ 库里真实的楼栋/房号）。
 * 服务端只认撞上真实楼栋/房号的候选，端上拿到 matched=true 才展示。
 */
export const parseAddress = (data: { text: string; communityId?: number }) =>
  request<ParsedRepairAddress>({
    method: 'POST',
    url: '/repair-requests/parse-address',
    data,
  });

/** 业主端提交报修（后端同时建 repair_request 与 work_order） */
export const create = (data: RepairCreateReq) =>
  request<{ request: { id: number }; workOrder: { id: number; orderNo: string } }>({
    method: 'POST',
    url: '/repair-requests',
    data,
  });

export interface ListQuery {
  status?: WorkOrderStatus;
  communityId?: number;
  /** mine=业主我提交的 / 维修工派给我的；pool=待接单池（维修工） */
  scope?: 'mine' | 'pool' | 'all';
}

/** 列表按角色收敛：业主只看自己提交的，维修工看 pool / mine */
export const list = (query: ListQuery = {}) =>
  request<WorkOrderListItem[]>({ url: '/work-orders', query: query as any });

export const detail = (id: number | string) => request<WorkOrderDetail>({ url: `/work-orders/${id}` });

export const accept = (id: number | string) =>
  request<void>({ method: 'POST', url: `/work-orders/${id}/accept` });

export const complete = (id: number | string, data: CompleteWorkOrderReq) =>
  request<void>({ method: 'POST', url: `/work-orders/${id}/complete`, data });

export const review = (
  id: number | string,
  data: { rating: number; comment?: string; attachments?: string[] },
) => request<void>({ method: 'POST', url: `/work-orders/${id}/review`, data });

export const cancel = (id: number | string, data: { reasonCode: string; note?: string }) =>
  request<void>({ method: 'POST', url: `/work-orders/${id}/cancel`, data });

/**
 * 这张工单能领哪些料：本小区仓的库存清单（含可用数量与实物照片）。
 * 「添加用料」用它，别用 /materials/options —— 那个不带库存量。
 */
export const stockOptions = (id: number | string) =>
  request<WorkOrderStockOptions>({ url: `/work-orders/${id}/stock-options` });

export interface MissingMaterialItem {
  /** 从材料库 SKU 选的才有；现场手填的留空 */
  materialId?: number;
  name: string;
  qty: number;
  unit?: string;
}

/**
 * 缺料登记：工单转「等待材料」、退回工单池，并生成采购申请进入审批流。
 * 退回池子是后端做的，端上提交成功后直接回工单池即可。
 */
export const needMaterial = (
  id: number | string,
  data: { missingMaterials: MissingMaterialItem[]; note?: string },
) => request<void>({ method: 'POST', url: `/work-orders/${id}/need-material`, data });

/** 办公室补建 SKU 后更正缺料清单（不新开采购申请，改的是同一张） */
export const updateMissingMaterials = (
  id: number | string,
  data: { missingMaterials: MissingMaterialItem[]; note?: string },
) => request<void>({ method: 'POST', url: `/work-orders/${id}/missing-materials`, data });

export const urge = (id: number | string) =>
  request<void>({ method: 'POST', url: `/work-orders/${id}/urge` });
