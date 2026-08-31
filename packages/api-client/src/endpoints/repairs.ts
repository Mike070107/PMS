import type {
  AssignWorkOrderReq,
  CompleteWorkOrderReq,
  RepairCreateReq,
  TechnicianOption,
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
  /** 被人当场改判过的词，判定时扣分（负样本，见后端 buildNegativeKeywords） */
  negativeKeywords?: string[];
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
  /**
   * 认到的公区点位名（监控室、门卫室、水泵房…），来自后台「公区点位」。
   * 有值时地址就是「小区 [楼栋] 点位名」，不再缀「公共区域」占位，
   * 端上也不用再追问「具体在哪」。
   */
  spotName?: string | null;
  /** 可直接展示/提交的完整地址文案，如「枫桦景苑一期 198弄24号302室」 */
  addressText?: string;
  /** 描述里命中的片段（归一化），如「一期24号」，用于展示与「忽略」去重 */
  matchedText?: string;
  /**
   * 地址在**原话里**实际占的那一段，如「枫桦景苑一期17号201」。
   * **剥故障描述一律用这个**：matchedText 是归一化的、不含小区名，
   * 拿它剥会把「枫桦景苑」剩在描述里。
   */
  matchedRaw?: string;
  /**
   * 语音把小区名听成同音字时的正名版本：「风华一期17号201」→「枫桦景苑一期17号201」。
   * null / 缺省 = 没什么好改的，别动用户说的话。
   * 只在小区是靠分期或弄这类**数字**定位到时才会给值。
   */
  correctedText?: string | null;
  /**
   * 大模型整理出来的那几样（后台没开 AI 辅助识别时不返回这个字段）。
   *
   * 只有语义那一半：地址仍以上面撞过库的字段为准 —— 模型不知道房产库，
   * 它给的地址只是线索，服务端已经拿去撞过一遍了，撞不上就是 matched=false。
   */
  ai?: {
    /** 理顺后的故障描述，只留故障本身 */
    description?: string;
    /** 明确说了人名才有；没说就是空串，不会拿地址或数字充数 */
    contactName?: string;
    /** 说话人是不是在催（急急急、等着用） */
    urgent?: boolean;
  };
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
  /**
   * mine=业主我提交的 / 维修工派给我的；pool=未指派的池子（维修工待接 = 办公室待派）；
   * reported=我提交的（员工替人报的单，不管派给了谁）
   */
  scope?: 'mine' | 'pool' | 'reported' | 'all';
  /** 关键词：单号 / 报修地址 / 故障描述 */
  q?: string;
}

/** 列表按角色收敛：业主只看自己提交的，维修工看 pool / mine */
export const list = (query: ListQuery = {}) =>
  request<WorkOrderListItem[]>({ url: '/work-orders', query: query as any });

/** 工单池里有几条待接（按本人类型过滤），底部 tab 角标用 */
export const poolCount = () => request<{ count: number }>({ url: '/work-orders/pool-count' });

export const detail = (id: number | string) => request<WorkOrderDetail>({ url: `/work-orders/${id}` });

export const accept = (id: number | string) =>
  request<void>({ method: 'POST', url: `/work-orders/${id}/accept` });

/**
 * 派单 / 改派（办公室）。维修工没有这个权限，端上也不该给入口。
 * 不传 slaHours 时沿用工单原有的要求完成时间。
 */
export const assign = (id: number | string, data: AssignWorkOrderReq) =>
  request<void>({ method: 'POST', url: `/work-orders/${id}/assign`, data });

/** 派单台可选的维修工（含在手单数）。走工单页权限，不是「用户管理」权限 */
export const technicians = () =>
  request<TechnicianOption[]>({ url: '/work-orders/technicians' });

export const complete = (id: number | string, data: CompleteWorkOrderReq) =>
  request<void>({ method: 'POST', url: `/work-orders/${id}/complete`, data });

export const review = (
  id: number | string,
  data: { rating: number; comment?: string; attachments?: string[] },
) => request<void>({ method: 'POST', url: `/work-orders/${id}/review`, data });

export const cancel = (id: number | string, data: { reasonCode: string; note?: string }) =>
  request<void>({ method: 'POST', url: `/work-orders/${id}/cancel`, data });

/**
 * 这张工单能领哪些料：默认仓库的库存清单（含可用数量与实物照片）。
 * 「添加用料」用它，别用 /materials/options —— 那个不带库存量。
 * 不传 warehouseId 走默认仓（本小区仓优先，没有则给到有货的仓）；端上切仓库才传。
 */
export const stockOptions = (id: number | string, warehouseId?: number) =>
  request<WorkOrderStockOptions>({
    url: `/work-orders/${id}/stock-options`,
    query: warehouseId ? { warehouseId } : undefined,
  });

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
