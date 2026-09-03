/** 养护单（《房屋修理养护任务单》）的前端类型，与后端 maintenance 模块同源 */

export interface MaintenanceItem {
  part: string;
  name: string;
  surveyQty: number | null;
  actualQty: number | null;
  actualHours: number | null;
  measureQty: number | null;
  quotaCode: string;
  quotaHours: number | null;
  laborFeeCents: number | null;
  materialFeeCents: number | null;
  quality: string;
  note: string;
}

export interface MaintenanceMaterial {
  name: string;
  spec: string;
  unit: string;
  estQty: number | null;
  pickQty: number | null;
  usedQty: number | null;
  returnQty: number | null;
  amountCents: number | null;
  note: string;
}

export type MaintenanceStatus =
  | 'filling'
  | 'waiting_filler'
  | 'waiting_repairer'
  | 'waiting_inspector'
  | 'pending_print'
  | 'completed'
  | 'void';

export interface MaintenanceOrder {
  id: number;
  orderNo: string;
  paperNo: string | null;
  workOrderId: number;
  workOrderNo: string | null;
  requestId: number | null;
  communityId: number;
  status: MaintenanceStatus;
  unitName: string | null;
  reporterName: string | null;
  addrVillage: string | null;
  addrRoad: string | null;
  addrLane: string | null;
  addrBuildingNo: string | null;
  addrRoom: string | null;
  reportedOn: string | null;
  presentTime: string | null;
  faultPart: string | null;
  repairItem: string | null;
  appointOn: string | null;
  startOn: string | null;
  finishOn: string | null;
  partCategory: string | null;
  feeCategory: string | null;
  shareMethod: string | null;
  repairDateText: string | null;
  feeCategoryText: string | null;
  shareMethodText: string | null;
  items: MaintenanceItem[];
  materials: MaintenanceMaterial[];
  laborRateCents: number;
  coefficient: number;
  totalCents: number;
  materialTotalCents: number;
  voucherIssue: string | null;
  fillerId: number | null;
  fillerName: string | null;
  fillerSignUrl: string | null;
  repairerId: number | null;
  repairerName: string | null;
  repairerSignUrl: string | null;
  inspectorId: number | null;
  inspectorName: string | null;
  inspectorSignUrl: string | null;
  inspectedAt: string | null;
  ownerSignUrl: string | null;
  scrapNote: string | null;
  serviceRecord: string | null;
  followUpRecord: string | null;
  addressText?: string;
  createdAt?: string;
  /** 服务端算的下一张实体联单号（库里最大号 + 上一张单印了几张纸）；没用过号时为 null */
  suggestedPaperNo?: string | null;
}

export interface MaintenanceListRow {
  id: number;
  orderNo: string;
  paperNo: string | null;
  workOrderId: number;
  workOrderNo: string | null;
  status: MaintenanceStatus;
  communityId: number;
  unitName: string | null;
  reporterName: string | null;
  addressText: string;
  repairItem: string | null;
  fillerName: string | null;
  repairerName: string | null;
  inspectorName: string | null;
  inspectedAt: string | null;
  totalCents: number;
  materialTotalCents: number;
  finishOn: string | null;
  createdAt: string;
}

export interface QuotaItemRow {
  id: number;
  code: string;
  name: string;
  unit: string;
  hours: string;
  materialFeeCents: number;
  remark: string | null;
  enabled: boolean;
  sortOrder: number;
}

export interface QuotaParams {
  laborRateCents: number;
  coefficient: number;
}

/** 签名位：纸上四个要签字的地方 */
export type SignSlot = 'filler' | 'repairer' | 'inspector' | 'owner';

export const MAINTENANCE_STATUS_LABELS: Record<MaintenanceStatus, string> = {
  filling: '填单中',
  waiting_filler: '待填单人签字',
  waiting_repairer: '待修理人签字',
  waiting_inspector: '待查验员签字',
  pending_print: '待打印',
  completed: '已完成',
  void: '已作废',
};

/** 正面一张纸 4 行明细，背面一张纸 7 行材料 —— 超了就再印一张 */
export const ITEMS_PER_SHEET = 4;
export const MATERIALS_PER_SHEET = 7;

export const PART_CATEGORY_OPTIONS = [
  { value: 'self', label: '自用\n部位' },
  { value: 'shared', label: '共用\n部位' },
  { value: 'public', label: '公共\n设施' },
];

export const FEE_CATEGORY_OPTIONS = [
  { value: 'owner', label: '业主\n自理' },
  { value: 'repair_fund', label: '修缮\n基金' },
  { value: 'elevator_fund', label: '电梯水\n泵基金' },
  { value: 'public_fund', label: '公共设\n施基金' },
];

export const SHARE_METHOD_OPTIONS = [
  { value: 'natural', label: '自然\n幢' },
  { value: 'door', label: '门牌\n幢' },
  { value: 'zone', label: '住宅\n区域' },
];

/** 括号里那行字：勾了什么就写什么（去掉换行） */
export function optionText(
  options: { value: string; label: string }[],
  value: string | null,
): string {
  if (!value) return '';
  return options.find((item) => item.value === value)?.label.replace('\n', '') || '';
}

/**
 * 三笔钱的算法。**与 apps/api/src/modules/maintenance/maintenance-money.util.ts 同源**
 * （API 不依赖 @pms/shared-types，nest build 编不进包外的源码），改一处两边一起改；
 * 那边有单测（maintenance-money.util.test.ts）压着口径。
 *
 * 这里算是为了填单时即时回显；落库的数以服务端重算的为准。
 */
export function totalFeeCents(
  items: Array<{ laborFeeCents?: number | null; materialFeeCents?: number | null }>,
  coefficient: number,
): number {
  const base = (items ?? []).reduce(
    (sum, item) => sum + (item.laborFeeCents ?? 0) + (item.materialFeeCents ?? 0),
    0,
  );
  const rate = Number.isFinite(coefficient) && coefficient > 0 ? coefficient : 1;
  return Math.round(base * rate);
}

export function materialTotalCents(rows: Array<{ amountCents?: number | null }>): number {
  return (rows ?? []).reduce((sum, row) => sum + (row.amountCents ?? 0), 0);
}

/** 选了定额编号后，这一行的工时与人工费 */
export function quotaLabor(
  hoursPerUnit: number,
  qty: number,
  laborRateCents: number,
): { hours: number; laborFeeCents: number } {
  const perUnit = Number.isFinite(hoursPerUnit) ? hoursPerUnit : 0;
  const count = Number.isFinite(qty) && qty > 0 ? qty : 1;
  const hours = Math.round(perUnit * count * 1000) / 1000;
  return {
    hours,
    laborFeeCents: Math.round(hours * (Number.isFinite(laborRateCents) ? laborRateCents : 0)),
  };
}

export function centsToYuan(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '';
  return (cents / 100).toFixed(2);
}

export function yuanToCents(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? Math.round(value * 100) : null;
}

export function numText(value: number | null | undefined): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

export function toNum(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

/** 日期在纸上只写「8/11」，存库仍是完整日期 */
export function formatMD(iso: string | null | undefined): string {
  if (!iso) return '';
  const date = parseIsoDate(iso);
  if (!date) return '';
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

/** 「8/11」/「2026-08-11」都收；只填月日时按参考年份补 */
export function parseMD(text: string, refIso?: string | null): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const full = trimmed.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (full) {
    return `${full[1]}-${pad2(full[2])}-${pad2(full[3])}`;
  }
  const md = trimmed.match(/^(\d{1,2})[-/.](\d{1,2})$/);
  if (md) {
    const year = parseIsoDate(refIso)?.getFullYear() ?? new Date().getFullYear();
    return `${year}-${pad2(md[1])}-${pad2(md[2])}`;
  }
  return null;
}

function pad2(value: string | number): string {
  return String(value).padStart(2, '0');
}

/**
 * 日期解析一律先按标准 ISO 直接 new Date：
 * 先把 '-' 换成 '/' 会把 2026-08-09T10:30:00Z 变成 2026/08/09T10:30:00，
 * V8 和 iOS 都判 Invalid Date，页面上时间全成空白（踩过）。
 */
export function parseIsoDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const direct = new Date(value);
  if (!Number.isNaN(direct.getTime())) return direct;
  const fallback = new Date(String(value).replace(/-/g, '/'));
  return Number.isNaN(fallback.getTime()) ? null : fallback;
}
