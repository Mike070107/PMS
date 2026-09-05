import type {
  AssignWorkOrderReq,
  CompleteWorkOrderReq,
  RepairCreateReq,
  RollbackMaterialLine,
  RollbackPreview,
  TechnicianOption,
  UsedMaterialLine,
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
  /** 后台“猜你想输”明确配置的生效关键词；AI 与规则判断均优先采用 */
  configuredKeywords?: string[];
  /** 被人当场改判过的词，判定时扣分（负样本，见后端 buildNegativeKeywords） */
  negativeKeywords?: string[];
}

/** 租户配置的报修类型（启用中的），任意登录角色可读 */
export const types = (communityId?: number) => request<PublicRepairType[]>({
  url: '/repair-types',
  query: communityId ? { communityId } : undefined,
});

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
   * 这单坏在**公共区域**（门口机、单元门、楼道…），不是坏在某一户里。
   * 报修人常连着自己的门牌一起说，服务端已经把地址退回楼栋级 +「公共区域」了。
   */
  publicArea?: boolean;
  /**
   * 报修人自己的房号。公区单的地址里没有它，但它仍然有用 ——
   * 原话没留姓名时，端上按「228/2/802」格式当联系人标识；
   * 只留姓名或电话时，另一项不再混入登录人的默认资料。
   */
  reporterRoomNo?: string | null;
  /**
   * 大模型整理出来的那几样（后台没开 AI 辅助识别时不返回这个字段）。
   *
   * 只有语义那一半：地址仍以上面撞过库的字段为准 —— 模型不知道房产库，
   * 它给的地址只是线索，服务端已经拿去撞过一遍了，撞不上就是 matched=false。
   */
  ai?: {
    /** 模型圈出的地址原话，只用于纠错记录；真正地址仍用上方撞库结果 */
    addressText?: string;
    /** 理顺后的故障描述，只留故障本身 */
    description?: string;
    /** 明确说了人名才有；没说就是空串，不会拿地址或数字充数 */
    contactName?: string;
    phone?: string;
    /** 说话人是不是在催（急急急、等着用） */
    urgent?: boolean;
    publicArea?: boolean;
    /** AI 按当前项目可用类型给出的类型编码；明确关键词规则优先，AI 用于无命中/模糊命中 */
    repairType?: string;
    /** 完全命中管理员确认过的样例，可覆盖端上旧关键词误判 */
    sampleMatched?: boolean;
  };
}

/** 把模型草稿随最终表单带回。服务端只用它计算人工纠错，不用它覆盖业务字段。 */
export function buildRepairAiAssist(sourceText: string, parsed?: ParsedRepairAddress | null) {
  if (!sourceText.trim() || !parsed?.ai) return undefined;
  return {
    sourceText: sourceText.trim(),
    draft: {
      addressText: parsed.ai.addressText || '',
      description: parsed.ai.description || '',
      contactName: parsed.ai.contactName || '',
      phone: parsed.ai.phone || '',
      urgent: !!parsed.ai.urgent,
      publicArea: !!parsed.ai.publicArea,
      repairType: parsed.ai.repairType || '',
      sampleMatched: !!parsed.ai.sampleMatched,
    },
  };
}

/**
 * 从报修描述里识别地址（「一期24号302」→ 库里真实的楼栋/房号）。
 * 服务端只认撞上真实楼栋/房号的候选，端上拿到 matched=true 才展示。
 */
/** lite：填表报修边打字边识别用，服务端规则先撞库、撞到楼栋/房号就不调大模型（省费用） */
export const parseAddress = (data: { text: string; communityId?: number; lite?: boolean }) =>
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
   * mine=业主我提交的 / 维修工派给我的；pool=维修工待接池；dispatch=办公室待派单；
   * reported=我提交的（员工替人报的单，不管派给了谁）；
   * done=已完结（办公室看管理处范围内全部，维修工看自己类别的：类型规则里有他 / 派给他 / 候选有他）
   */
  scope?: 'mine' | 'pool' | 'dispatch' | 'reported' | 'all' | 'done';
  /** 关键词：单号 / 报修地址 / 故障描述 */
  q?: string;
}

/** 列表按角色收敛：pool 含公开待接单及定向派给本人的待接单，mine 从接单后开始。 */
export const list = (query: ListQuery = {}) =>
  request<WorkOrderListItem[]>({ url: '/work-orders', query: query as any });

/** 底部 tab 角标一次拿齐：工单池 / 派单台 / 在手工单各几件。没权限的格给 0 */
export interface BadgeCounts {
  pool: number;
  dispatch: number;
  mine: number;
}
export const badgeCounts = () => request<BadgeCounts>({ url: '/work-orders/badge-counts' });

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
export const technicians = (communityId?: number, skill?: string) =>
  request<TechnicianOption[]>({
    url: '/work-orders/technicians',
    query: {
      ...(communityId ? { communityId } : {}),
      ...(skill ? { skill } : {}),
    },
  });

export const complete = (id: number | string, data: CompleteWorkOrderReq) =>
  request<void>({ method: 'POST', url: `/work-orders/${id}/complete`, data });

/** 维修中追加一条带照片的进度记录，不改变工单状态。 */
export const addProgress = (
  id: number | string,
  data: { note?: string; attachments?: string[] },
) => request<void>({ method: 'POST', url: `/work-orders/${id}/progress`, data });

/** 当前维修工把工单退回所属管理处，清空类型后等待重新派单。 */
export const requestTransfer = (id: number | string, data: { note: string }) =>
  request<void>({ method: 'POST', url: `/work-orders/${id}/transfer-request`, data });

/**
 * 撤回预览：将退回哪个状态、会退哪些材料、会驳回哪张采购申请，全部由后端算。
 * 打开撤回弹窗前先调一次，用它渲染确认文案，**不要**在端上自己推导目标状态。
 */
export const rollbackPreview = (id: number | string) =>
  request<RollbackPreview>({ url: `/work-orders/${id}/rollback-preview` });

/**
 * 办公室/管理员撤回上一笔业务操作；原因会写入工单时间轴。
 * 撤回完工时会同时把那一次扣的料退回原仓原批次，返回值里带退料明细。
 */
export const rollback = (id: number | string, data: { reason: string }) =>
  request<RollbackResult>({ method: 'POST', url: `/work-orders/${id}/rollback`, data });
/** 作废工单：退回已领用料、排除统计；confirmReversal 必须为 true（服务端会拦） */
export const voidWorkOrder = (id: number | string, data: { reason: string; confirmReversal: boolean }) =>
  request<void>({ method: 'POST', url: `/work-orders/${id}/void`, data });

/** 撤回接口的返回：工单本体之外，额外说明这次撤回实际做了什么 */
export interface RollbackResult {
  rollback: {
    rolledBackAction?: string;
    rolledBackActionLabel?: string;
    fromStatus: WorkOrderStatus;
    targetStatus?: WorkOrderStatus;
    targetStatusLabel?: string;
    returnedMaterials: RollbackMaterialLine[];
    returnedQty: number;
    completionBatchId: number | null;
    rejectedPurchaseRequests: string[];
    maintenanceOrderVoided: number | null;
    reviewReversed: boolean;
  };
}

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
  /** 判定为不足时所选的仓；服务端用它维护该仓的材料清单 */
  warehouseId?: number;
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
  data: {
    missingMaterials: MissingMaterialItem[];
    /** 混合选料时同步领用的有库存材料；后端与缺料提报在同一事务中扣减 */
    usedMaterials?: UsedMaterialLine[];
    note?: string;
  },
) => request<void>({ method: 'POST', url: `/work-orders/${id}/need-material`, data });

/** 删除已扣库的工单用料，服务端会按原批次自动退库 */
export const removeUsedMaterial = (id: number | string, usageId: number | string) =>
  request<{ ok: true }>({
    method: 'DELETE',
    url: `/work-orders/${id}/materials/${usageId}`,
  });

/** 办公室补建 SKU 后更正缺料清单（不新开采购申请，改的是同一张） */
export const updateMissingMaterials = (
  id: number | string,
  data: { missingMaterials: MissingMaterialItem[]; note?: string },
) => request<void>({ method: 'POST', url: `/work-orders/${id}/missing-materials`, data });

export const urge = (id: number | string) =>
  request<void>({ method: 'POST', url: `/work-orders/${id}/urge` });
