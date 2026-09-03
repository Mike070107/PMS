import {
  App as AntdApp,
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  Col,
  Collapse,
  DatePicker,
  Descriptions,
  Divider,
  Drawer,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Pagination,
  Popconfirm,
  Rate,
  Radio,
  Row,
  Segmented,
  Select,
  Space,
  Spin,
  Switch,
  Table,
  Tabs,
  Tag,
  Timeline,
  Tooltip,
  Typography,
  Upload,
  Image,
  App as _AntdApp,
} from 'antd';
import type { UploadFile, UploadProps } from 'antd/es/upload/interface';
import {
  ClockCircleOutlined,
  DownOutlined,
  FileTextOutlined,
  SettingOutlined,
  PhoneOutlined,
  PlusOutlined,
  ReloadOutlined,
  SearchOutlined,
  ToolOutlined,
  UploadOutlined,
  VideoCameraOutlined,
  HolderOutlined,
  ArrowUpOutlined,
  ArrowDownOutlined,
  DeleteOutlined,
  BellOutlined,
  StopOutlined,
  UndoOutlined,
  WarningOutlined,
  BulbOutlined,
  CheckCircleOutlined,
  RightOutlined,
  UserOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import type {
  ClassifiableType,
  CompletionDraft,
  RollbackPreview,
  TechnicianOption,
  UsedMaterialLine,
} from '@pms/shared-types';
import { classifyRepairType, compareWorkOrderRoutePriority } from '@pms/shared-types';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import type { CSSProperties, ReactNode } from 'react';
import { request } from '../lib/api';
import { auth, useAuth, usePagePerm } from '../lib/auth';
import { searchableWideSelectProps, withOptionTitles } from '../lib/selectProps';
import { isVideoUrl } from '@pms/shared-types';
import type { AddressCommunity } from '@pms/shared-types';
import HouseAddressPicker, {
  UNKNOWN_HOUSE_VALUE,
  type PickedAddress,
} from '../components/HouseAddressPicker';
import MissingMaterialsInput, {
  type MissingMaterialRow,
} from '../components/MissingMaterialsInput';
import { useTableColumnPrefs, type PrefsColumn } from '../components/tableColumnPrefs';
import { nameOr } from '../lib/displayName';
import { compressImageFile } from '../lib/compressImage';
import { DetailHero, DetailMetrics, DetailSection } from '../components/DetailPrimitives';
import {
  DEFAULT_CONTENT_SUGGESTIONS,
  DEFAULT_LOCATION_SUGGESTIONS,
  formatDateTimeCn,
  formatDuration,
  stayDays,
  stayTone,
  UserRole,
  WorkOrderStatus,
  repairTypeAndSlaLockReason,
} from '@pms/shared-types';

const { Title, Text } = Typography;
const { TextArea } = Input;

interface Staff {
  id: number;
  name?: string | null;
  phone?: string | null;
  role: UserRole;
  status: 'active' | 'disabled';
  onDuty?: boolean;
  skills?: string[];
}
interface WorkOrderRow {
  id: number;
  orderNo: string;
  status: WorkOrderStatus;
  communityId: number;
  assigneeId: number | null;
  candidateIds?: number[];
  /** 维修工姓名，由接口给（本页的 staffById 只是兜底） */
  assigneeName?: string | null;
  repairType?: string | null;
  summaryAddress?: string | null;
  summaryContent?: string | null;
  /** 报修时拍的图片（接口已裁成最多 4 张，列表直接展示缩略图） */
  photos?: string[];
  photoCount?: number;
  contactName?: string | null;
  reporterRoleLabel?: string | null;
  sourceLabel?: string | null;
  /** 报修时就说了「急修」：列表第一格挂红色「紧急」标 */
  urgent?: boolean;
  skill?: string | null;
  feeCents?: number;
  dispatchedAt?: string | null;
  completedAt?: string | null;
  slaDueAt?: string | null;
  faultLocation?: string | null;
  faultSymptom?: string | null;
  repairContent?: string | null;
  usedMaterials?: Array<{ materialId?: number; name?: string; qty: number; unit?: string }>;
  resultAttachments?: string[];
  actionNote?: string | null;
  missingMaterials?: Array<{ materialId?: number; name: string; qty: number; unit?: string }>;
  createdAt?: string;
}
interface RepairRequestDetail {
  id: number;
  source: string;
  communityId: number;
  buildingId: number | null;
  houseId: number | null;
  addressText: string | null;
  contactName: string | null;
  contactPhone: string | null;
  /** 代报角色编码；业主本人报的为 null */
  reporterRole: string | null;
  /** 中文身份：保安 / 居委会 / 业委会 */
  reporterRoleLabel: string | null;
  /** 报修人认证的登记地址；账号没绑房（办公室录入、扫码未认证）时为 null */
  reporterAddressText?: string | null;
  repairType: string | null;
  content: string;
  /** 报修时就说了「急修」：详情和列表挂红色「紧急」标 */
  urgent?: boolean;
  attachments: string[];
}
interface WorkOrderLog {
  id: number;
  fromStatus: WorkOrderStatus | null;
  toStatus: WorkOrderStatus;
  action: string;
  operatorId: number | null;
  operatorName?: string | null;
  note: string | null;
  attachments?: string[];
  createdAt: string;
}
interface WorkOrderDetail {
  workOrder: WorkOrderRow;
  request: RepairRequestDetail;
  logs: WorkOrderLog[];
  materialUsages?: Array<{
    id: number;
    materialId: number;
    warehouseId: number;
    qty: number;
    name?: string;
    unit?: string;
  }>;
  /** 完工被撤回后留下的草稿：材料已退库，重新提交完工时才会再次扣库 */
  completionDraft?: CompletionDraft | null;
}
interface RepairTypeRule {
  id: number;
  /** 归属管理处；null = 总公司（各管理处的模板） */
  officeId: number | null;
  repairType: string;
  label: string;
  /** 兼容字段，等于 assigneeIds[0]；页面只用 assigneeIds */
  assigneeId: number | null;
  /** 默认维修工，可多人：新单通知他们并进各自的工单池，谁先接归谁 */
  assigneeIds: number[];
  slaHours: number | null;
  sortOrder: number;
  enabled: boolean;
  /**
   * 生效的「猜你想输」关键词 = 本处增补 ∪（公司模板 − 本处屏蔽）。
   * 录入页和类型判定都用这一份，别再自己拼。
   */
  contentSuggestions: string[];
  /** 从公司模板继承来的词（本处屏蔽掉的已剔除）；总公司那一页等于它自己 */
  templateSuggestions: string[];
  /** 本处自己加的词。总公司那一页恒为空 —— 那一页改的就是模板 */
  extraSuggestions: string[];
  /** 本处停用的模板词 */
  mutedSuggestions: string[];
}
interface RepairSuggestion {
  text: string;
  count: number;
}
interface RepairSuggestions {
  locations: RepairSuggestion[];
  /** 未选报修类型时的通用高频短语 */
  contents: RepairSuggestion[];
  /** 按报修类型归纳的高频短语：repairType -> 短语 */
  contentsByType: Record<string, RepairSuggestion[]>;
  /** 已配置关键词的真实使用次数（当前口径）：repairType -> 关键词 -> 次数 */
  keywordUsageByType: Record<string, Record<string, number>>;
  /** 同一批词的全公司次数，和上面并排显示，一眼看出「本地词」还是「全公司都在说」 */
  companyKeywordUsageByType?: Record<string, Record<string, number>>;
  /** 这份数据按谁的历史算出来的 */
  scope?: SuggestionScope;
  officeScoped?: boolean;
}
type SuggestionScope = 'office_first' | 'company';
/** 报修类型配置弹窗的管理处 Tab（带各自的「猜你想输」口径开关） */
interface RuleOffice {
  id: number;
  name: string;
  suggestionScope: SuggestionScope;
  suggestionFeedback: boolean;
}
interface RepairHistoryRow {
  requestId: number;
  workOrderId: number | null;
  orderNo: string | null;
  status: WorkOrderStatus | null;
  repairType: string | null;
  summaryAddress: string | null;
  summaryContent: string;
  createdAt?: string;
  completedAt?: string | null;
}
interface WorkOrderStats {
  total: number;
  byStatus: Partial<Record<WorkOrderStatus, number>>;
}
interface UploadResponse {
  publicUrl: string;
  objectKey?: string;
  bucket?: string;
}

const statusMeta: Record<WorkOrderStatus, { label: string; color: string }> = {
  created: { label: '待处理', color: 'default' },
  dispatched: { label: '已派单', color: 'processing' },
  in_progress: { label: '维修中', color: 'blue' },
  waiting_material: { label: '等待材料', color: 'orange' },
  done_pending_review: { label: '待业主验收', color: 'purple' },
  completed: { label: '已完成', color: 'success' },
  // 撤单是「不用办了」，不是出了错。红色会让人以为这单出了问题、还得去处理
  cancelled: { label: '已撤单', color: 'default' },
  voided: { label: '已作废', color: 'default' },
};

// 撤回目标状态一律由后端 /rollback-preview 给出。
// 这里以前硬编码「维修中 → 已派单」，可维修中也可能来自主动认领或等待材料接回，
// 弹窗上写的和真正发生的事对不上（2026-09-03 改造）。

/** 距要求完成截止不足这个数就标红（含已超时） */
const SLA_WARN_MS = 4 * 60 * 60 * 1000;

/**
 * 要不要把这单标红：设了截止时间、还没完结，且距截止不足 4 小时或已超时。
 * 已完结的单不标 —— 完结了再喊「超时」只会把整个列表染红。
 */
function slaDanger(r: { slaDueAt?: string | null; status: WorkOrderStatus }): boolean {
  if (!r.slaDueAt) return false;
  if ([WorkOrderStatus.COMPLETED, WorkOrderStatus.CANCELLED, WorkOrderStatus.VOIDED].includes(r.status)) return false;
  const due = new Date(r.slaDueAt).getTime();
  return !Number.isNaN(due) && due - Date.now() <= SLA_WARN_MS;
}

/** 「已超时 3 小时」/「距截止还有 2 小时」 */
function slaCountdownText(slaDueAt: string): string {
  const diff = new Date(slaDueAt).getTime() - Date.now();
  const abs = Math.abs(diff);
  const label = abs >= 3600000
    ? `${Math.floor(abs / 3600000)} 小时`
    : `${Math.max(1, Math.round(abs / 60000))} 分钟`;
  return diff < 0 ? `已超时 ${label}` : `距截止还有 ${label}`;
}

const repairTypeOptions = [
  { value: 'water', label: '水相关' },
  { value: 'electric', label: '电相关' },
  { value: 'door_window', label: '家里门锁/门窗相关' },
  { value: 'appliance', label: '家电/设备相关' },
  { value: 'elevator', label: '电梯相关' },
  { value: 'smart', label: '智能化相关' },
  { value: 'public', label: '公共设施相关' },
  { value: 'other', label: '其它' },
];
// 旧编码仅用于历史数据展示
const legacyRepairTypeLabels: Array<[string, string]> = [
  ['plumbing', '水相关'],
  ['lock', '家里门锁/门窗相关'],
];
const fallbackRepairTypeLabelByValue = new Map([
  ...repairTypeOptions.map((item) => [item.value, item.label] as [string, string]),
  ...legacyRepairTypeLabels,
]);

const MAX_SUGGESTION_TAGS = 10;
/** 每个报修类型最多配置多少个关键词（与后端 MAX_CONTENT_SUGGESTIONS 一致） */
const MAX_KEYWORDS_PER_TYPE = 20;
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api/v1';
const MAX_IMAGE_COUNT = 3;
const MAX_VIDEO_COUNT = 1;
/** 工单池表格最窄多少：再窄单号/状态/停留几列就挤到一起；容器不够宽时表格自己横向滚，页面不滚 */
const WORK_ORDER_TABLE_MIN_WIDTH = 920;
/** 要求完成截止时间只到半小时：办公室口头约的都是「上午十点半」这种，不需要精确到分钟 */
const SLA_MINUTE_STEP = 30;

const FILTER_TABS: Array<{ label: string; value: 'all' | WorkOrderStatus }> = [
  { label: '全部', value: 'all' },
  { label: '待派单/待接单', value: WorkOrderStatus.CREATED },
  { label: '已派单', value: WorkOrderStatus.DISPATCHED },
  { label: '维修中', value: WorkOrderStatus.IN_PROGRESS },
  { label: '等待材料', value: WorkOrderStatus.WAITING_MATERIAL },
  { label: '待验收', value: WorkOrderStatus.DONE_PENDING_REVIEW },
  { label: '已完成', value: WorkOrderStatus.COMPLETED },
  { label: '已作废', value: WorkOrderStatus.VOIDED },
];

/**
 * 从业主提交那一刻算起的自然日跨天数，和两个小程序同一套口径。
 *
 * 已撤单的单**不写 completedAt**（撤单不算完工），拿它当「还没结束」算的话，
 * 撤了三个月的单会一直涨到「90 天」还标着红 —— 那是在催一件早就不用办的事。
 * 所以撤单按最后一次更新时间收口（撤单就是那一次更新）。
 */
function stayDaysOf(row: {
  createdAt?: string;
  completedAt?: string | null;
  updatedAt?: string | null;
  status?: WorkOrderStatus;
}) {
  if (!row.createdAt) return 0;
  const closedAt =
    row.completedAt || ([WorkOrderStatus.CANCELLED, WorkOrderStatus.VOIDED].includes(row.status as WorkOrderStatus) ? row.updatedAt : null);
  const end = closedAt ? new Date(closedAt) : new Date();
  return stayDays(row.createdAt, Number.isNaN(end.getTime()) ? new Date() : end);
}

/**
 * 「已停留」那枚标签的颜色。**已经结束的单一律灰**（撤单、完成）——
 * 单子都结束了还标红标橙，等于在催一件不用办的事；一屏红色，真正压着的那几单就淹了。
 */
function stayTagColor(row: { status?: WorkOrderStatus }, days: number): string {
  if ([WorkOrderStatus.CANCELLED, WorkOrderStatus.COMPLETED, WorkOrderStatus.VOIDED].includes(row.status as WorkOrderStatus)) {
    return 'default';
  }
  const tone = stayTone(days);
  return tone === 'danger' ? 'error' : tone === 'warn' ? 'warning' : 'default';
}

/**
 * 状态看板：每个环节积压多少，点一下就筛。
 * 取代原来的七格分段控件 —— 那个控件把「筛选器」和「统计」挤在同一行小字里，
 * 结果两件事都看不清。
 */
function StatusBoard({
  value,
  counts,
  urgentCount,
  overdueCount,
  onChange,
}: {
  value: 'all' | WorkOrderStatus;
  counts: WorkOrderStats;
  urgentCount: number;
  overdueCount: number;
  onChange: (next: 'all' | WorkOrderStatus) => void;
}) {
  return (
    <div className="pms-dispatch-board">
      <div className="pms-dispatch-metrics" aria-label="调度待办概览">
        <div className="pms-dispatch-metric is-danger">
          <span><WarningOutlined /> 当前列表紧急</span>
          <strong>{urgentCount} 单</strong>
        </div>
        <div className="pms-dispatch-metric is-danger">
          <span><ClockCircleOutlined /> 已超时或临期</span>
          <strong>{overdueCount} 单</strong>
        </div>
        <button
          type="button"
          className={`pms-dispatch-metric${value === WorkOrderStatus.CREATED ? ' is-selected' : ''}`}
          onClick={() => onChange(WorkOrderStatus.CREATED)}
        >
          <span><UserOutlined /> 等待派单</span>
          <strong>{counts.byStatus[WorkOrderStatus.CREATED] || 0} 单</strong>
        </button>
        <button
          type="button"
          className={`pms-dispatch-metric is-warning${value === WorkOrderStatus.WAITING_MATERIAL ? ' is-selected' : ''}`}
          onClick={() => onChange(WorkOrderStatus.WAITING_MATERIAL)}
        >
          <span><FileTextOutlined /> 等待材料</span>
          <strong>{counts.byStatus[WorkOrderStatus.WAITING_MATERIAL] || 0} 单</strong>
        </button>
      </div>
      <div className="pms-dispatch-filters" aria-label="工单状态筛选">
        {FILTER_TABS.map((tab) => {
          const active = value === tab.value;
          const count = tab.value === 'all'
            ? counts.total
            : counts.byStatus[tab.value as WorkOrderStatus] || 0;
          return (
            <button
              type="button"
              key={tab.value}
              className={active ? 'is-selected' : ''}
              aria-pressed={active}
              onClick={() => onChange(tab.value)}
            >
              {tab.label} <span>{count}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function getRepairTypeLabel(value: string | null | undefined, rules: RepairTypeRule[] = []) {
  if (!value) return '-';
  const rule = rules.find((item) => item.repairType === value);
  return rule?.label || fallbackRepairTypeLabelByValue.get(value) || value;
}

function buildRepairTypeSelectOptions(rules: RepairTypeRule[] = []) {
  const activeRules = rules.filter((item) => item.enabled);
  return activeRules.length
    ? activeRules.map((item) => ({ value: item.repairType, label: item.label }))
    : repairTypeOptions;
}

function dispatchWaitingText(createdAt?: string) {
  if (!createdAt) return '报修时间待补';
  const elapsed = Math.max(0, Date.now() - new Date(createdAt).getTime());
  if (elapsed < 60 * 60 * 1000) return `已等待 ${Math.max(1, Math.floor(elapsed / 60000))} 分钟`;
  if (elapsed < 24 * 60 * 60 * 1000) return `已等待 ${Math.floor(elapsed / 3600000)} 小时`;
  return `已等待 ${stayDaysOf({ createdAt })} 天`;
}

function DispatchOrderCard({
  row,
  repairTypeRules,
  recommended,
  canVoid,
  quickAssigning,
  onOpen,
  onAssign,
  onQuickAssign,
  onVoid,
}: {
  row: WorkOrderRow;
  repairTypeRules: RepairTypeRule[];
  recommended?: TechnicianOption;
  canVoid: boolean;
  quickAssigning: boolean;
  onOpen: () => void;
  onAssign: () => void;
  onQuickAssign: () => void;
  onVoid: () => void;
}) {
  const pendingAssign = row.status === WorkOrderStatus.CREATED;
  const waitingOfficeDispatch = pendingAssign && !row.assigneeId && !row.candidateIds?.length;
  const waitingCandidateAcceptance = pendingAssign && !!row.candidateIds?.length;
  const canReassign = row.status === WorkOrderStatus.DISPATCHED || row.status === WorkOrderStatus.IN_PROGRESS;
  // “推荐”只服务于办公室尚未派单的决策。已经自动匹配进工单池、已定向派单或维修中的单，
  // 再显示推荐人会让人误以为系统还没有确定处理路径。
  const showRecommendation = waitingOfficeDispatch && !!recommended;
  const stateLabel = pendingAssign
    ? row.candidateIds?.length ? '待维修工接单' : '待办公室派单'
    : statusMeta[row.status].label;
  return (
    <article
      className={`pms-dispatch-order${row.urgent ? ' is-urgent' : ''}${slaDanger(row) ? ' is-sla-danger' : ''}`}
      onClick={onOpen}
    >
      <div className="pms-dispatch-order__photo">
        <RepairPhotoCell photos={row.photos || []} total={row.photoCount || 0} />
      </div>
      <div className="pms-dispatch-order__main">
        <div className="pms-dispatch-order__title-row">
          <h3>{row.summaryAddress || '地址待补充'}</h3>
          {row.urgent && <Tag color="error">紧急</Tag>}
          <Tag color={statusMeta[row.status].color}>{stateLabel}</Tag>
        </div>
        <p className="pms-dispatch-order__problem">
          {row.summaryContent || '暂无故障描述'}
          <span> · {getRepairTypeLabel(row.repairType || row.skill, repairTypeRules)}</span>
        </p>
        <div className="pms-dispatch-order__meta">
          <span>联系人：{row.contactName || '未填写'}</span>
          <span>报修时间：{formatDateTimeCn(row.createdAt) || '-'}</span>
          <span>工单编号：{row.orderNo}</span>
        </div>
      </div>
      <div className="pms-dispatch-order__dispatch">
        <div className={`pms-dispatch-order__waiting${slaDanger(row) ? ' is-danger' : ''}`}>
          <ClockCircleOutlined />
          <strong>{row.slaDueAt && slaDanger(row) ? slaCountdownText(row.slaDueAt) : dispatchWaitingText(row.createdAt)}</strong>
        </div>
        {showRecommendation && recommended ? (
          <div className="pms-dispatch-recommendation">
            <span>推荐维修工</span>
            <strong>{recommended.name}</strong>
            <small>
              {formatSkillList(recommended.skills, repairTypeRules) || '综合维修'} · 当前 {recommended.openCount} 单
            </small>
          </div>
        ) : (
          <div className={`pms-dispatch-recommendation${waitingCandidateAcceptance ? '' : ' is-empty'}`}>
            <span>{waitingCandidateAcceptance ? '自动派单结果' : '当前负责人'}</span>
            <strong>
              {waitingCandidateAcceptance
                ? `已通知 ${row.candidateIds?.length || 0} 位默认维修工`
                : row.assigneeName || '尚未选择维修工'}
            </strong>
            <small>
              {waitingCandidateAcceptance
                ? '等待其中一人接单，接单后显示实际负责人'
                : waitingOfficeDispatch
                  ? '请按工种筛选并选择维修人员'
                  : '已接单，不再显示推荐维修工'}
            </small>
          </div>
        )}
      </div>
      <div className="pms-dispatch-order__actions" onClick={(event) => event.stopPropagation()}>
        {showRecommendation && recommended && (
          <Popconfirm
            title={`确认派给${recommended.name}？`}
            description={`该维修工当前有 ${recommended.openCount} 张在手工单`}
            okText="确认派单"
            cancelText="取消"
            onConfirm={onQuickAssign}
          >
            <Button type="primary" size="large" loading={quickAssigning}>派给{recommended.name}</Button>
          </Popconfirm>
        )}
        {(pendingAssign || canReassign) && (
          <Button size="large" onClick={onAssign}>
            {waitingOfficeDispatch ? '选择维修工' : '改派维修工'}
          </Button>
        )}
        <Button type="link" size="large" onClick={onOpen}>查看详情 <RightOutlined /></Button>
        {row.status !== WorkOrderStatus.VOIDED && (
          <Tooltip title={canVoid ? '作废后记录仍可筛选查看，但不再参与统计，并按规则退回库存' : '只有办公室人员或管理员可以作废'}>
            <Button type="link" danger disabled={!canVoid} onClick={onVoid}>作废</Button>
          </Tooltip>
        )}
      </div>
    </article>
  );
}

function formatSkillList(skills: string[] | undefined, rules: RepairTypeRule[] = []) {
  return skills?.length
    ? skills.map((item) => getRepairTypeLabel(item, rules)).join('、')
    : '';
}

export default function WorkOrdersPage() {
  const { message } = AntdApp.useApp();
  const { access } = useAuth();
  const { canEdit } = usePagePerm('work-orders');
  const [addressTree, setAddressTree] = useState<AddressCommunity[]>([]);
  const [addressLoading, setAddressLoading] = useState(false);
  const [staffList, setStaffList] = useState<Staff[]>([]);
  /** 能接单的人（后端按「工单池 · 接单」这一格查），派单下拉用它 */
  const [dispatchTechnicians, setDispatchTechnicians] = useState<TechnicianOption[]>([]);
  const [repairTypeRules, setRepairTypeRules] = useState<RepairTypeRule[]>([]);
  const [repairSuggestions, setRepairSuggestions] = useState<RepairSuggestions>({ locations: [], contents: [], contentsByType: {}, keywordUsageByType: {} });
  const [rows, setRows] = useState<WorkOrderRow[]>([]);
  const [statusCounts, setStatusCounts] = useState<WorkOrderStats>({ total: 0, byStatus: {} });
  const [loading, setLoading] = useState(false);
  // 调度人员进来先处理还没人负责的单；查历史时再自动切到“全部”。
  const [filter, setFilter] = useState<'all' | WorkOrderStatus>(WorkOrderStatus.CREATED);
  // 搜索框：输入即查，敲字停 300ms 再发请求；地址「198/47/201」/「198」、维修工姓名、单号都走同一个 q
  const [searchInput, setSearchInput] = useState('');
  const [searchQ, setSearchQ] = useState('');
  const [detailId, setDetailId] = useState<number | null>(null);
  const [voidTarget, setVoidTarget] = useState<WorkOrderRow | null>(null);
  const [dispatchTarget, setDispatchTarget] = useState<WorkOrderRow | null>(null);
  const [quickAssigningId, setQuickAssigningId] = useState<number | null>(null);
  const [viewMode, setViewMode] = useState<'cards' | 'table'>('cards');
  const [page, setPage] = useState(1);
  const [repairDockOpenSignal, setRepairDockOpenSignal] = useState(0);
  const [ruleOpen, setRuleOpen] = useState(false);
  // 企业超管 / 平台超管：以权限矩阵为准，users.role 已经不表达身份了
  const isAdmin = !!access?.isTenantAdmin || !!access?.isPlatformAdmin;

  const staffById = useMemo(() => {
    const m = new Map<number, Staff>();
    staffList.forEach((s) => m.set(s.id, s));
    return m;
  }, [staffList]);

  /* 工单池的列：拖列宽、拖列序，按「登录用户 + 表格」自动存 localStorage，刷新不丢
     （2026-08-27 反馈「一刷新就恢复了」）。每列必须有稳定 key，它是存档标识。 */
  const poolColumns: PrefsColumn<WorkOrderRow>[] = [
    {
      title: '报修图片', key: 'photos', width: 92, fixed: 'left',
      render: (_, r) => <RepairPhotoCell photos={r.photos || []} total={r.photoCount || 0} />,
    },
    {
      // 调度最先要回答「去哪儿」，地址不能再作为类型后面的一段灰色小字。
      // 固定在图片之后，横向滚动时始终可见。
      title: '报修地址', key: 'address', width: 250, fixed: 'left',
      render: (_, r) => (
        <div className="pms-workorder-address">
          <strong title={r.summaryAddress || undefined}>{r.summaryAddress || '地址待补充'}</strong>
          <Text
            type="secondary"
            title={[r.contactName, r.reporterRoleLabel, r.sourceLabel].filter(Boolean).join(' · ') || undefined}
          >
            {[r.contactName || '未填报修人', r.reporterRoleLabel, r.sourceLabel].filter(Boolean).join(' · ')}
          </Text>
        </div>
      ),
    },
    {
      title: '问题描述', key: 'summary', width: 320,
      render: (_, r) => (
        <div className="pms-workorder-problem">
          <div>
            {r.urgent && <Tag color="error">紧急</Tag>}
            <Tag color="blue">{getRepairTypeLabel(r.repairType || r.skill, repairTypeRules)}</Tag>
          </div>
          <Text ellipsis={{ tooltip: r.summaryContent || '-' }}>{r.summaryContent || '-'}</Text>
        </div>
      ),
    },
    {
      title: '处理状态', key: 'status', width: 178,
      render: (_, r) => (
        <div className="pms-workorder-state">
          <Tag color={statusMeta[r.status].color}>
            {r.status === WorkOrderStatus.CREATED
              ? r.candidateIds?.length ? '待接单' : '待派单'
              : statusMeta[r.status].label}
          </Tag>
          {slaDanger(r) && r.slaDueAt && (
            <span className="pms-workorder-sla">
              <ClockCircleOutlined style={{ marginRight: 4 }} />
              {slaCountdownText(r.slaDueAt)}
            </span>
          )}
        </div>
      ),
    },
    {
      // 已停留是催办的唯一依据，必须常驻列表，而不是点进详情才看得到
      title: '已停留',
      key: 'stay',
      // 表头「已停留」加上排序箭头要 100 出头，窄了会折成「已停 / 留」
      width: 108,
      sorter: (a, b) => stayDaysOf(a) - stayDaysOf(b),
      render: (_, r) => {
        const days = stayDaysOf(r);
        return <Tag color={stayTagColor(r, days)}>{days} 天</Tag>;
      },
    },
    {
      title: '当前负责人', key: 'assignee', dataIndex: 'assigneeId', width: 120,
      // 姓名优先用接口给的（它按 tenant 查过了）；staffById 是本页自己拉的员工表，作兜底
      render: (id: number | null, r) =>
        id ? nameOr(r.assigneeName || staffById.get(id)?.name, '维修工') : <Text type="secondary">未派单</Text>,
    },
    {
      title: '报修时间', key: 'createdAt', dataIndex: 'createdAt', width: 180,
      // 和进度时间轴、两个小程序统一：2026/8/9 17:07 周日；「周日」不许折到第二行
      render: (v: string) => <span style={{ whiteSpace: 'nowrap' }}>{formatDateTimeCn(v) || '-'}</span>,
    },
    {
      title: '工单编号', key: 'orderNo', dataIndex: 'orderNo', width: 180,
      render: (v: string) => (
        <Text copyable={{ text: v }} type="secondary" style={{ fontVariantNumeric: 'tabular-nums' }}>{v}</Text>
      ),
    },
    {
      title: '操作', key: 'actions', width: 150, fixed: 'right',
      render: (_, r) => (
        <Space size={0} onClick={(event) => event.stopPropagation()}>
          <Button type="link" onClick={() => setDetailId(r.id)}>详情</Button>
          {r.status !== WorkOrderStatus.VOIDED && <Tooltip title={canEdit ? '作废后记录仍可筛选查看，但不再参与统计，并按规则退回库存' : '只有办公室人员或管理员可以作废'}>
            <span>
              <Button
                type="link"
                danger
                icon={<StopOutlined />}
                disabled={!canEdit}
                onClick={() => setVoidTarget(r)}
              >
                作废
              </Button>
            </span>
          </Tooltip>}
        </Space>
      ),
    },
  ];
  const poolPrefs = useTableColumnPrefs('work-orders.pool', poolColumns);

  const sortedRows = useMemo(() => [...rows].sort(compareWorkOrderRoutePriority), [rows]);
  const pageSize = 10;
  const pagedRows = sortedRows.slice((page - 1) * pageSize, page * pageSize);
  const urgentRows = pagedRows.filter((row) => row.urgent);
  const normalRows = pagedRows.filter((row) => !row.urgent);
  const recommendTechnician = useCallback((row: WorkOrderRow) => {
    const candidates = row.candidateIds?.length
      ? dispatchTechnicians.filter((item) => row.candidateIds?.includes(item.id))
      : dispatchTechnicians.filter((item) => {
          const skill = row.repairType || row.skill;
          return skill ? item.skills?.includes(skill) : false;
        });
    return [...candidates].sort((a, b) => a.openCount - b.openCount || a.id - b.id)[0];
  }, [dispatchTechnicians]);

  // 全量地址树，一次拉完；报修录入靠它做「228/4/201」的即时联想，不再逐级请求
  const loadAddressTree = useCallback(async () => {
    setAddressLoading(true);
    try {
      setAddressTree(await request<AddressCommunity[]>({ url: '/address-tree' }));
    } catch (e: any) {
      message.error(e?.message || '加载地址簿失败');
    } finally {
      setAddressLoading(false);
    }
  }, [message]);

  const loadStaff = useCallback(async () => {
    try {
      const [list, techs] = await Promise.all([
        request<Staff[]>({ url: '/staff' }),
        request<TechnicianOption[]>({ url: '/work-orders/technicians' }).catch(() => []),
      ]);
      setStaffList(list);
      setDispatchTechnicians(techs);
    } catch (e: any) {
      // 静默：可能此账号无权访问，工单仍可看
      console.warn(e);
    }
  }, []);

  const loadRepairTypeRules = useCallback(async () => {
    try {
      // 工单录入只需要类型名称和关键词，不需要默认维修工等内部配置。
      // 受限管理处账号不能读取总公司配置页，但仍要能正常显示类型名称。
      const types = await request<
        Array<{ repairType: string; label: string; keywords: string[] }>
      >({ url: '/repair-types' });
      setRepairTypeRules(
        types.map((item, index) => ({
          id: -(index + 1),
          officeId: null,
          repairType: item.repairType,
          label: item.label,
          assigneeId: null,
          assigneeIds: [],
          slaHours: null,
          sortOrder: index,
          enabled: true,
          contentSuggestions: item.keywords ?? [],
          templateSuggestions: [],
          extraSuggestions: [],
          mutedSuggestions: [],
        })),
      );
    } catch (e: any) {
      message.error(e?.message || '加载报修类型失败');
    }
  }, [message]);

  const loadRepairSuggestions = useCallback(async () => {
    try {
      setRepairSuggestions(await request<RepairSuggestions>({ url: '/repair-suggestions' }));
    } catch (e) {
      setRepairSuggestions({ locations: [], contents: [], contentsByType: {}, keywordUsageByType: {} });
    }
  }, []);

  const loadOrders = useCallback(async () => {
    setLoading(true);
    try {
      const query: any = {};
      if (filter !== 'all') query.status = filter;
      // 已按类型匹配到候选维修工并推送的 CREATED 工单是在等维修工接单，
      // 不属于办公室待派事项；默认“待派单”只取真正没有去向的单。
      if (filter === WorkOrderStatus.CREATED) query.scope = 'dispatch';
      if (searchQ) query.q = searchQ;
      const r = await request<WorkOrderRow[] | { list: WorkOrderRow[] }>({
        url: '/work-orders',
        query,
      });
      setRows(Array.isArray(r) ? r : r.list || []);
    } catch (e: any) {
      message.error(e?.message || '加载工单失败');
    } finally {
      setLoading(false);
    }
  }, [filter, searchQ, message]);

  const loadOrderStats = useCallback(async () => {
    try {
      const query: any = {};
      // 状态看板的数字和列表必须同一套口径：搜索时看板也只数命中的单
      if (searchQ) query.q = searchQ;
      setStatusCounts(await request<WorkOrderStats>({ url: '/work-orders/stats', query }));
    } catch (e: any) {
      message.error(e?.message || '加载工单统计失败');
    }
  }, [searchQ, message]);

  const quickAssign = useCallback(async (row: WorkOrderRow, technician: TechnicianOption) => {
    setQuickAssigningId(row.id);
    try {
      await request({
        method: 'POST',
        url: `/work-orders/${row.id}/assign`,
        data: { assigneeId: technician.id, skill: row.repairType || row.skill || undefined },
      });
      message.success(`已派给${technician.name}`);
      await Promise.all([loadOrders(), loadOrderStats(), loadStaff()]);
    } catch (e: any) {
      message.error(e?.message || '派单失败');
    } finally {
      setQuickAssigningId(null);
    }
  }, [loadOrderStats, loadOrders, loadStaff, message]);

  useEffect(() => {
    loadAddressTree();
    loadStaff();
    loadRepairTypeRules();
    loadRepairSuggestions();
  }, [loadAddressTree, loadRepairSuggestions, loadRepairTypeRules, loadStaff]);
  useEffect(() => { loadOrders(); }, [loadOrders]);
  useEffect(() => { loadOrderStats(); }, [loadOrderStats]);
  useEffect(() => { setPage(1); }, [filter, searchQ]);
  useEffect(() => {
    const next = searchInput.trim();
    const timer = window.setTimeout(() => {
      setSearchQ((prev) => {
        // 从空到有字 = 开始查历史：把状态筛选放回「全部」，已完成的老单才查得到
        if (next && !prev) setFilter('all');
        return next;
      });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  const renderDispatchGroup = (title: string, list: WorkOrderRow[], urgent = false) => {
    if (!list.length) return null;
    return (
      <section className="pms-dispatch-group">
        <div className={`pms-dispatch-group__head${urgent ? ' is-urgent' : ''}`}>
          <h2>{title} · {list.length} 单</h2>
          <span>同等优先级按日期和相邻地址编排</span>
        </div>
        <div className="pms-dispatch-order-list">
          {list.map((row) => {
            const recommended = row.status === WorkOrderStatus.CREATED && !row.candidateIds?.length
              ? recommendTechnician(row)
              : undefined;
            return (
              <DispatchOrderCard
                key={row.id}
                row={row}
                repairTypeRules={repairTypeRules}
                recommended={recommended}
                canVoid={canEdit}
                quickAssigning={quickAssigningId === row.id}
                onOpen={() => setDetailId(row.id)}
                onAssign={() => setDispatchTarget(row)}
                onQuickAssign={() => recommended && quickAssign(row, recommended)}
                onVoid={() => setVoidTarget(row)}
              />
            );
          })}
        </div>
      </section>
    );
  };

  return (
    <div className="pms-workorder-page">
      <section className="pms-dispatch-shell">
        <div className="pms-dispatch-header">
          <div>
            <h1><ToolOutlined /> 工单调度台</h1>
            <p>先处理紧急、超时和待派工单，再查看普通工单。</p>
          </div>
          <Button
            type="primary"
            size="large"
            icon={<PlusOutlined />}
            onClick={() => setRepairDockOpenSignal((value) => value + 1)}
          >
            录入报修
          </Button>
        </div>

        <div className="pms-dispatch-toolbar">
          <Input
            size="large"
            allowClear
            prefix={<SearchOutlined />}
            placeholder="搜索小区、房号、维修工、电话或工单编号"
            className="pms-workorder-search"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            autoComplete="off"
          />
          <Segmented
            size="large"
            value={viewMode}
            options={[{ label: '卡片调度', value: 'cards' }, { label: '表格明细', value: 'table' }]}
            onChange={(value) => setViewMode(value as 'cards' | 'table')}
          />
          {viewMode === 'table' && poolPrefs.customized && (
            <Button size="large" onClick={poolPrefs.reset}>恢复默认列</Button>
          )}
          <Button size="large" icon={<ReloadOutlined />} onClick={() => { loadOrders(); loadOrderStats(); loadStaff(); }}>刷新</Button>
        </div>

        <StatusBoard
          value={filter}
          counts={statusCounts}
          urgentCount={rows.filter((row) => row.urgent).length}
          overdueCount={rows.filter(slaDanger).length}
          onChange={(next) => setFilter(next)}
        />

        {viewMode === 'table' ? (
          <div className="pms-workorder-pool pms-workorder-pool-card">
            <Table
              rowKey="id"
              size="large"
              loading={loading}
              dataSource={sortedRows}
              tableLayout="fixed"
              scroll={{ x: WORK_ORDER_TABLE_MIN_WIDTH + 508 }}
              pagination={{ pageSize, showSizeChanger: false }}
              rowClassName={(r) => [
                slaDanger(r) ? 'pms-row-sla-danger' : '',
                r.urgent ? 'pms-row-urgent' : '',
                r.status === WorkOrderStatus.CREATED ? 'pms-row-action-needed' : '',
              ].filter(Boolean).join(' ')}
              onRow={(r) => ({ onClick: () => setDetailId(r.id), style: { cursor: 'pointer' } })}
              locale={{ emptyText: searchQ ? `没有匹配「${searchQ}」的工单` : undefined }}
              columns={poolPrefs.columns}
              components={poolPrefs.components}
            />
          </div>
        ) : (
          <Spin spinning={loading}>
            <div className="pms-dispatch-card-view">
              {!pagedRows.length ? (
                <Empty description={searchQ ? `没有匹配“${searchQ}”的工单` : '当前筛选下没有工单'} />
              ) : (
                <>
                  {renderDispatchGroup('紧急工单 · 先处理', urgentRows, true)}
                  {renderDispatchGroup('普通工单', normalRows)}
                  <Pagination
                    current={page}
                    pageSize={pageSize}
                    total={sortedRows.length}
                    showSizeChanger={false}
                    hideOnSinglePage
                    onChange={setPage}
                  />
                </>
              )}
            </div>
          </Spin>
        )}
      </section>

      <RepairSubmitDock
        openSignal={repairDockOpenSignal}
        addressTree={addressTree}
        addressLoading={addressLoading}
        repairTypeRules={repairTypeRules}
        suggestions={repairSuggestions}
        canManageRepairTypes={isAdmin && canEdit}
        onManageRepairTypes={() => setRuleOpen(true)}
        onOpenWorkOrder={(id) => setDetailId(id)}
        onSubmitted={() => { loadOrders(); loadOrderStats(); loadRepairSuggestions(); }}
      />

      <AssignModal
        open={Boolean(dispatchTarget)}
        workOrderId={dispatchTarget?.id ?? null}
        communityId={dispatchTarget?.communityId}
        technicians={dispatchTechnicians}
        repairTypeRules={repairTypeRules}
        currentSkill={dispatchTarget?.repairType || dispatchTarget?.skill || undefined}
        onClose={() => setDispatchTarget(null)}
        onDone={async () => {
          setDispatchTarget(null);
          await Promise.all([loadOrders(), loadOrderStats(), loadStaff()]);
        }}
      />

      <WorkOrderDetailDrawer
        id={detailId}
        staffList={staffList}
        dispatchTechnicians={dispatchTechnicians}
        repairTypeRules={repairTypeRules}
        onClose={() => setDetailId(null)}
        onChanged={() => { loadOrders(); loadOrderStats(); }}
      />
      <VoidWorkOrderModal
        open={!!voidTarget}
        workOrder={voidTarget}
        materialLines={voidTarget?.usedMaterials?.length ?? 0}
        onClose={() => setVoidTarget(null)}
        onDone={() => {
          setVoidTarget(null);
          loadOrders();
          loadOrderStats();
          loadRepairSuggestions();
        }}
      />
      <RepairTypeRuleModal
        open={ruleOpen}
        technicians={dispatchTechnicians}
        suggestions={repairSuggestions}
        onClose={() => setRuleOpen(false)}
        onDone={() => { loadRepairTypeRules(); loadRepairSuggestions(); loadOrders(); loadOrderStats(); }}
      />
    </div>
  );
}

/** 表单里任何一格有内容就算「有草稿」：数组看长度，勾选框 false 不算，空串不算 */
function isFilledFormValue(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return value !== undefined && value !== null && value !== '' && value !== false;
}

/**
 * 同楼栋历史报修：房号下面一张独立的折叠卡片，默认收起、标题带条数。
 * 之前是一行一条直接铺在表单里 —— 一栋楼几十条历史就把录入面板塞满了（2026-08-27 反馈）。
 * 展开是「时间 / 地址 / 报修内容 / 状态」的小表格，限高自己滚，点一行打开工单详情；
 * 换了房号自动收回去，别让上一栋楼的列表挡着新的录入。
 */
function RepairHistoryInline({
  title,
  rows,
  loading,
  repairTypeRules,
  onOpenWorkOrder,
}: {
  title: string;
  rows: RepairHistoryRow[];
  loading: boolean;
  repairTypeRules: RepairTypeRule[];
  onOpenWorkOrder: (id: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  useEffect(() => { setExpanded(false); }, [title]);
  if (!title) return null;
  const empty = !loading && rows.length === 0;
  return (
    <Collapse
      className="pms-repair-dock__history"
      size="small"
      activeKey={expanded && !empty ? ['history'] : []}
      onChange={(keys) => setExpanded((Array.isArray(keys) ? keys : [keys]).includes('history'))}
      collapsible={empty || loading ? 'disabled' : 'header'}
      items={[{
        key: 'history',
        label: (
          <span className="pms-repair-dock__history-label">
            <Text strong>同楼栋历史报修</Text>
            <Text type="secondary" className="pms-repair-dock__history-title" title={title}>{title}</Text>
          </span>
        ),
        extra: loading
          ? <Spin size="small" />
          : <Text type={rows.length ? undefined : 'secondary'} className="pms-repair-dock__history-count">{rows.length ? `${rows.length} 条` : '暂无'}</Text>,
        children: (
          <Table<RepairHistoryRow>
            className="pms-repair-dock__history-table"
            rowKey={(r) => String(r.workOrderId || `req-${r.requestId}`)}
            size="small"
            dataSource={rows}
            pagination={false}
            tableLayout="fixed"
            scroll={rows.length > 6 ? { y: 264 } : undefined}
            onRow={(r) => ({
              onClick: () => { if (r.workOrderId) onOpenWorkOrder(r.workOrderId); },
              style: { cursor: r.workOrderId ? 'pointer' : 'default' },
              title: r.workOrderId ? '点击查看工单详情' : '还没建工单',
            })}
            columns={[
              {
                title: '时间', dataIndex: 'createdAt', width: 92,
                render: (v: string) => {
                  // 「2026/8/24 23:44 周一」拆成两行，窄列里不至于挤成一坨
                  const text = formatDateTimeCn(v) || '-';
                  const cut = text.indexOf(' ');
                  return cut > 0
                    ? <span className="pms-repair-dock__history-when">{text.slice(0, cut)}<br />{text.slice(cut + 1)}</span>
                    : text;
                },
              },
              {
                title: '地址', dataIndex: 'summaryAddress', width: 110, ellipsis: true,
                render: (v: string | null) => v || '-',
              },
              {
                title: '报修内容', key: 'content', ellipsis: true,
                render: (_, r) => (
                  <span title={`${getRepairTypeLabel(r.repairType, repairTypeRules)} · ${r.summaryContent || '-'}`}>
                    <Text type="secondary">{getRepairTypeLabel(r.repairType, repairTypeRules)} · </Text>
                    {r.summaryContent || '-'}
                  </span>
                ),
              },
              {
                title: '状态', dataIndex: 'status', width: 84,
                render: (s: WorkOrderStatus | null) => s
                  ? <Tag color={statusMeta[s].color} style={{ marginInlineEnd: 0 }}>{statusMeta[s].label}</Tag>
                  : <Tag style={{ marginInlineEnd: 0 }}>未建单</Tag>,
              },
            ]}
          />
        ),
      }]}
    />
  );
}

// ---------------- 办公室录入报修：右下角悬浮面板 ----------------
/** Form 起个名字，字段 id 才稳定（officeRepair_houseRef），展开面板时好把光标放进房号框 */
const OFFICE_REPAIR_FORM_NAME = 'officeRepair';
const OFFICE_REPAIR_DOCK_ID = 'pms-repair-dock';

/**
 * 为什么是悬浮面板而不是左右分栏（2026-08-26 反馈）：
 * 办公室的屏幕小，分栏之后工单池只剩一半，表格每格换行。现在工单池独占整页，
 * 录入报修收成右下角一颗按钮；点开是一块固定在右下角的面板（不遮工单池的标题和状态看板），
 * 提交成功自动缩回。没提交就收起，填了一半的内容原样留在面板里，按钮上带红点提示
 * 「有没提交的草稿」—— 接电话记到一半被打断，回来接着填，不用重来。
 */
function RepairSubmitDock({
  openSignal, addressTree, addressLoading, repairTypeRules, suggestions, canManageRepairTypes,
  onManageRepairTypes, onOpenWorkOrder, onSubmitted,
}: {
  openSignal: number;
  addressTree: AddressCommunity[];
  addressLoading: boolean;
  repairTypeRules: RepairTypeRule[];
  suggestions: RepairSuggestions;
  canManageRepairTypes: boolean;
  onManageRepairTypes: () => void;
  onOpenWorkOrder: (id: number) => void;
  onSubmitted: () => void;
}) {
  const { message } = AntdApp.useApp();
  const { canEdit } = usePagePerm('work-orders');
  const [form] = Form.useForm();
  const [open, setOpen] = useState(false);
  const [fileList, setFileList] = useState<UploadFile<UploadResponse>[]>([]);
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [confirmValues, setConfirmValues] = useState<Record<string, any> | null>(null);
  const [formHasValue, setFormHasValue] = useState(false);
  const [historyRows, setHistoryRows] = useState<RepairHistoryRow[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyTitle, setHistoryTitle] = useState('');
  const [pickedAddressText, setPickedAddressText] = useState('');
  // 连着换两次房号时，只认最后一次的返回
  const historySeqRef = useRef(0);
  const hasDraft = formHasValue || fileList.length > 0;
  // 「猜你想输」要跟着当前选中的报修类型变，所以得订阅这个字段
  const pickedRepairType: string | undefined = Form.useWatch('repairType', form);
  const pickedRepairTypeLabel = pickedRepairType
    ? getRepairTypeLabel(pickedRepairType, repairTypeRules)
    : '';
  const pickedHouseRef: unknown = Form.useWatch('houseRef', form);
  const pickedCommunityId = Array.isArray(pickedHouseRef) ? (pickedHouseRef[0] as number | undefined) : undefined;
  const contentValue: string | undefined = Form.useWatch('content', form);
  /**
   * 按描述自动判报修类型（2026-08-31）。
   *
   * 以前这一栏纯手选：办公室接完电话得自己想「旋钮打滑算智能化还是门窗」，
   * 想错了就通知错维修工。判定用的关键词和小程序端是同一份（GET /repair-types 下发，
   * 含类型名切词和同义词），所以后台和业主端不会一个判得出、一个判不出。
   */
  const [publicTypes, setPublicTypes] = useState<ClassifiableType[]>([]);
  const [predicted, setPredicted] = useState<{ repairType: string; label: string; matched: string[] } | null>(null);
  /** 人一旦自己动过这个下拉框，就不再自动改它 —— 别跟正在录入的人抢方向盘 */
  const typeTouchedRef = useRef(false);
  /** 该小区所属管理处口径的「猜你想输」，拿不到就退回页面级那份（全公司） */
  const [dockSuggestions, setDockSuggestions] = useState<RepairSuggestions | null>(null);
  const activeSuggestions = dockSuggestions ?? suggestions;

  useEffect(() => {
    if (openSignal > 0) setOpen(true);
  }, [openSignal]);

  // 类型关键词和常用短语都跟着报修小区走：不同管理处可以有自己的类型和本地叫法
  useEffect(() => {
    if (!open) return;
    let alive = true;
    const query = pickedCommunityId ? { communityId: pickedCommunityId } : {};
    Promise.all([
      request<ClassifiableType[]>({ url: '/repair-types', query }).catch(() => [] as ClassifiableType[]),
      request<RepairSuggestions>({ url: '/repair-suggestions', query }).catch(() => null),
    ]).then(([types, sugg]) => {
      if (!alive) return;
      setPublicTypes(Array.isArray(types) ? types : []);
      setDockSuggestions(sugg);
    });
    return () => { alive = false; };
  }, [open, pickedCommunityId]);

  // 边打字边判，350ms 防抖：接电话时是一句一句敲进来的，每个字都算一次既费也晃眼
  useEffect(() => {
    const text = (contentValue || '').trim();
    if (!open || text.length < 2 || !publicTypes.length) {
      setPredicted(null);
      return;
    }
    const timer = window.setTimeout(() => {
      const hit = classifyRepairType(text, publicTypes);
      setPredicted(hit ? { repairType: hit.repairType, label: hit.label, matched: hit.matched } : null);
      if (hit && !typeTouchedRef.current) form.setFieldsValue({ repairType: hit.repairType });
    }, 350);
    return () => window.clearTimeout(timer);
  }, [contentValue, publicTypes, open, form]);

  // 展开后光标直接进房号框：办公室接着电话就能敲「228/4/201」
  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => {
      document.getElementById(`${OFFICE_REPAIR_FORM_NAME}_houseRef`)?.focus();
    }, 240);
    return () => window.clearTimeout(timer);
  }, [open]);

  const loadBuildingHistory = useCallback(async (buildingId?: number, title?: string) => {
    const seq = ++historySeqRef.current;
    if (!buildingId) {
      setHistoryRows([]);
      setHistoryTitle('');
      setHistoryLoading(false);
      return;
    }
    setHistoryTitle(title || '同楼栋历史报修');
    setHistoryLoading(true);
    try {
      const list = await request<RepairHistoryRow[]>({ url: '/repair-history', query: { buildingId } });
      if (seq === historySeqRef.current) setHistoryRows(list);
    } catch (e: any) {
      if (seq === historySeqRef.current) message.error(e?.message || '加载历史报修失败');
    } finally {
      if (seq === historySeqRef.current) setHistoryLoading(false);
    }
  }, [message]);

  const resetForm = () => {
    form.resetFields();
    setFileList([]);
    setFormHasValue(false);
    setPredicted(null);
    setConfirming(false);
    setConfirmValues(null);
    setPickedAddressText('');
    typeTouchedRef.current = false;
    loadBuildingHistory(undefined);
  };

  const onReview = async () => {
    const values = await form.validateFields();
    if (fileList.some((file) => file.status === 'uploading')) {
      message.warning('照片或视频还在上传，请稍后确认');
      return;
    }
    if (fileList.some((file) => file.status === 'error')) {
      message.error('有附件上传失败，请删除后重新上传');
      return;
    }
    setConfirmValues(values);
    setConfirming(true);
  };

  const onSubmit = async () => {
    const v = await form.validateFields();
    const [communityId, buildingId, houseId] = v.houseRef || [];
    if (!communityId) {
      message.error('请选择报修人房号');
      return;
    }
    if (fileList.some((file) => file.status === 'uploading')) {
      message.warning('照片或视频还在上传，请稍后提交');
      return;
    }
    if (fileList.some((file) => file.status === 'error')) {
      message.error('有附件上传失败，请删除后重新上传');
      return;
    }
    const resolvedHouseId = houseId === UNKNOWN_HOUSE_VALUE ? undefined : houseId;
    const attachments = fileList
      .map((file) => file.response?.publicUrl)
      .filter(Boolean);
    setSaving(true);
    try {
      await request({
        method: 'POST',
        url: '/repair-requests/office',
        data: {
          communityId,
          buildingId: buildingId ?? undefined,
          houseId: resolvedHouseId ?? undefined,
          contactName: v.contactName,
          contactPhone: v.contactPhone || undefined,
          repairType: v.repairType,
          content: v.content,
          urgent: Boolean(v.urgent),
          addressText: v.spotText,
          attachments,
          // 系统当时判的是什么：和最终提交的不一致时服务端记一条负样本，
          // 同一个词被改走两次以上就自动降权（见 buildNegativeKeywords）
          predictedRepairType: predicted?.repairType,
          // 勾了「要求完成截止日期」才带；没勾走类型规则里的默认时限
          slaDueAt: v.slaEnabled && v.slaDueAt ? v.slaDueAt.toISOString() : undefined,
        },
      });
      message.success('报修已提交，工单已建档');
      resetForm();
      // 提交完自动缩回，把整块屏幕还给工单池
      setOpen(false);
      onSubmitted();
    } catch (e: any) {
      message.error(e?.message || '提交失败');
    } finally {
      setSaving(false);
    }
  };

  const onAddressPicked = (picked: PickedAddress | null) => {
    setPickedAddressText(picked?.fullText || '');
    if (!picked?.buildingId) {
      loadBuildingHistory(undefined);
      return;
    }
    loadBuildingHistory(picked.buildingId, picked.fullText);
    if (picked.ownerName || picked.ownerPhone) {
      form.setFieldsValue({
        contactName: picked.ownerName || undefined,
        contactPhone: picked.ownerPhone || undefined,
      });
      setFormHasValue(true);
    }
  };
  const repairTypeSelectOptions = buildRepairTypeSelectOptions(repairTypeRules);
  const locationSuggestions = mergeSuggestionTexts(
    activeSuggestions.locations.map((item) => item.text),
    DEFAULT_LOCATION_SUGGESTIONS,
  );
  // 「猜你想输」跟着报修类型走：先按配置好的顺序展示（后台可调序/按次数排序），
  // 再把历史里自动归纳出、还没配进去的高频短语补在后面
  const pickedRule = pickedRepairType
    ? repairTypeRules.find((rule) => rule.repairType === pickedRepairType)
    : undefined;
  const contentSuggestions = pickedRepairType
    ? mergeSuggestionTexts(
        pickedRule?.contentSuggestions || [],
        (activeSuggestions.contentsByType?.[pickedRepairType] || []).map((item) => item.text),
      )
    : mergeSuggestionTexts(
        activeSuggestions.contents.map((item) => item.text),
        DEFAULT_CONTENT_SUGGESTIONS,
      );
  const contentSuggestionTitle = pickedRepairTypeLabel
    ? `${pickedRepairTypeLabel}·猜你想输`
    : '猜你想输';
  const uploadProps = buildAttachmentUploadProps({ fileList, setFileList, message });

  // 只有查看权限：按钮留着但置灰，并说明去哪儿开权限，别让人对着整页找不到入口
  const fabButton = (
    <Button
      type="primary"
      size="large"
      shape="round"
      icon={<PhoneOutlined />}
      disabled={!canEdit}
      aria-expanded={open}
      aria-controls={OFFICE_REPAIR_DOCK_ID}
      onClick={() => setOpen(true)}
    >
      {hasDraft ? '继续录入报修' : '录入报修'}
    </Button>
  );

  // 挂到 body 上，而不是留在页面树里：外层 .pms-content 带进场动画（transform），
  // 会把 position:fixed 的参照系从视口变成它自己，按钮就沉到页面最底下看不见了
  // （2026-08-26 headless 里量到 fabTop=1431 > innerHeight=720）。antd 的 Drawer/Modal 也是这么做的。
  return createPortal(
    <>
      <div className={`pms-repair-dock-fab${open ? ' is-hidden' : ''}`}>
        {canEdit ? (
          <Badge dot={hasDraft} offset={[-6, 6]} title="有没提交的草稿">
            {fabButton}
          </Badge>
        ) : (
          <Tooltip title="当前账号对「工单管理」只有查看权限，不能录入报修。请管理员在「业务角色」里把这一行的「编辑」勾上，重新登录即可。">
            <span>{fabButton}</span>
          </Tooltip>
        )}
      </div>

      {canEdit && (
        <>
          <div className={`pms-repair-dock-backdrop${open ? ' is-open' : ''}`} aria-hidden="true" />
          <section
            id={OFFICE_REPAIR_DOCK_ID}
            className={`pms-repair-dock${open ? ' is-open' : ''}`}
            aria-label="办公室录入报修"
            aria-hidden={!open}
          >
          <div className="pms-repair-dock__head">
            <div className="pms-repair-dock__title">
              {confirming ? <CheckCircleOutlined /> : <PhoneOutlined />}
              {confirming ? '提交前确认' : '办公室录入报修'}
            </div>
            <Space size={0}>
              <Popconfirm
                title="清空已填的内容？"
                okText="清空"
                cancelText="再想想"
                disabled={!hasDraft}
                onConfirm={resetForm}
              >
                <Button type="text" disabled={!hasDraft}>清空</Button>
              </Popconfirm>
              <Button type="text" icon={<DownOutlined />} onClick={() => setOpen(false)}>收起</Button>
            </Space>
          </div>
          <div className="pms-repair-dock__body">
            {confirming && confirmValues ? (
              <div className="pms-repair-confirm">
                <div className="pms-repair-confirm__intro">
                  <CheckCircleOutlined />
                  <div><h2>请核对重点信息</h2><p>重点看地址、联系电话和故障描述，确认无误后再提交。</p></div>
                </div>
                <dl className="pms-repair-confirm__list">
                  <div><dt>报修地址</dt><dd>{pickedAddressText || '已选择房屋'}{confirmValues.spotText ? ` · ${confirmValues.spotText}` : ''}</dd></div>
                  <div><dt>联系人</dt><dd>{confirmValues.contactName || '未填写'} · {confirmValues.contactPhone || '未填写电话'}</dd></div>
                  <div><dt>报修内容</dt><dd>{confirmValues.content}</dd></div>
                  <div><dt>报修类型</dt><dd>{getRepairTypeLabel(confirmValues.repairType, repairTypeRules)}</dd></div>
                  <div><dt>紧急程度</dt><dd>{confirmValues.urgent ? '紧急，需要优先处理' : '普通'}</dd></div>
                  <div><dt>完成时限</dt><dd>{confirmValues.slaEnabled && confirmValues.slaDueAt ? confirmValues.slaDueAt.format('YYYY-MM-DD HH:mm') : '按报修类型默认时限'}</dd></div>
                  <div><dt>附件资料</dt><dd>{fileList.length ? `${fileList.length} 个照片或视频` : '未添加附件'}</dd></div>
                </dl>
                <Alert type="info" showIcon message="提交后自动进入待派单列表，并根据工种推荐维修人员。" />
              </div>
            ) : (
              <Form
                form={form}
                name={OFFICE_REPAIR_FORM_NAME}
                layout="vertical"
                requiredMark="optional"
                size="large"
                initialValues={{ urgent: false, slaEnabled: false }}
                autoComplete="off"
                onValuesChange={(_, all) => setFormHasValue(Object.values(all).some(isFilledFormValue))}
              >
                <section className="pms-repair-form-section">
                  <div className="pms-repair-form-section__head"><span>1</span><div><h2>先确认报修地址</h2><p>接电话时可以直接输入“228/2/802”查找。</p></div></div>
                  <Form.Item name="houseRef" label="房屋或公共区域" rules={[{ required: true, message: '请选择小区/楼栋/室号' }]}>
                    <HouseAddressPicker communities={addressTree} loading={addressLoading} onPicked={onAddressPicked} />
                  </Form.Item>
                  <RepairHistoryInline title={historyTitle} rows={historyRows} loading={historyLoading} repairTypeRules={repairTypeRules} onOpenWorkOrder={onOpenWorkOrder} />
                  <Form.Item name="spotText" label="具体位置">
                    <Input placeholder="例如：大门、4楼电梯口、楼道公共区域" autoComplete="off" />
                  </Form.Item>
                  <SuggestionTags items={locationSuggestions} onPick={(text) => { form.setFieldsValue({ spotText: text }); setFormHasValue(true); }} />
                </section>

                <section className="pms-repair-form-section">
                  <div className="pms-repair-form-section__head"><span>2</span><div><h2>联系人怎么称呼</h2><p>姓名和电话按居民实际提供的内容填写。</p></div></div>
                  <Row gutter={16}>
                    <Col xs={24} md={12}><Form.Item name="contactName" label="联系人"><Input placeholder="例如：李阿姨" autoComplete="off" /></Form.Item></Col>
                    <Col xs={24} md={12}><Form.Item name="contactPhone" label="联系电话" rules={[{ pattern: /^1[3-9]\d{9}$/, message: '请填写正确的手机号' }]}><Input placeholder="手机号" autoComplete="off" /></Form.Item></Col>
                  </Row>
                </section>

                <section className="pms-repair-form-section">
                  <div className="pms-repair-form-section__head"><span>3</span><div><h2>居民遇到了什么问题</h2><p>尽量记录居民原话，系统会自动识别报修类型。</p></div></div>
                  <Form.Item name="content" label="报修内容" rules={[{ required: true, message: '请填写故障描述' }]}>
                    <TextArea rows={4} placeholder="例如：家里门铃打不开楼下单元门" />
                  </Form.Item>
                  <SuggestionTags title={contentSuggestionTitle} items={contentSuggestions} onPick={(text) => { form.setFieldsValue({ content: text }); setFormHasValue(true); }} />
                  {predicted && (
                    <div className="pms-repair-ai-result">
                      <BulbOutlined />
                      <div><span>AI识别的报修类型</span><strong>{predicted.label}</strong><small>{predicted.matched.length ? `识别依据：${predicted.matched.slice(0, 3).join('、')}` : '根据报修内容判断'}</small></div>
                    </div>
                  )}
                  <Form.Item name="repairType" label={<Space size={8}><span>报修类型</span>{canManageRepairTypes && <Button type="link" size="small" icon={<SettingOutlined />} onClick={onManageRepairTypes}>配置</Button>}</Space>}>
                    <Select {...searchableWideSelectProps} placeholder="系统自动识别，也可以人工修改" options={withOptionTitles(repairTypeSelectOptions)} allowClear onChange={() => { typeTouchedRef.current = true; }} />
                  </Form.Item>
                </section>

                <section className="pms-repair-form-section">
                  <div className="pms-repair-form-section__head"><span>4</span><div><h2>是否紧急</h2><p>默认普通；只有确实需要优先处理时才选择紧急。</p></div></div>
                  <Form.Item name="urgent">
                    <Radio.Group className="pms-repair-urgency">
                      <Radio value={false}><strong>普通（默认）</strong><span>按正常顺序派单处理</span></Radio>
                      <Radio value={true}><strong>紧急</strong><span>进入紧急工单组并优先处理</span></Radio>
                    </Radio.Group>
                  </Form.Item>
                  <Form.Item label="要求完成截止日期" extra="不设定时，按报修类型的默认时限执行。">
                    <Space align="center" wrap>
                      <Form.Item name="slaEnabled" valuePropName="checked" noStyle><Checkbox>手动设定</Checkbox></Form.Item>
                      <Form.Item noStyle shouldUpdate={(prev, cur) => prev.slaEnabled !== cur.slaEnabled}>
                        {({ getFieldValue }) => getFieldValue('slaEnabled') ? (
                          <Form.Item name="slaDueAt" noStyle rules={[{ required: true, message: '请选择截止时间' }]}>
                            <DatePicker showTime={{ format: 'HH:mm', minuteStep: SLA_MINUTE_STEP }} format="YYYY-MM-DD HH:mm" placeholder="选择日期时间" />
                          </Form.Item>
                        ) : null}
                      </Form.Item>
                    </Space>
                  </Form.Item>
                </section>

                <section className="pms-repair-form-section">
                  <div className="pms-repair-form-section__head"><span>5</span><div><h2>补充照片或视频</h2><p>可选；有现场照片时更方便维修工判断。</p></div></div>
                  <Form.Item label="上传照片 / 视频">
                    <Upload.Dragger {...uploadProps} style={attachmentDropStyle}>
                      <p className="pms-repair-upload-icon"><UploadOutlined /></p>
                      <p>点击上传，或把照片、视频拖到这里</p>
                      <Text type="secondary">照片最多 {MAX_IMAGE_COUNT} 张，视频最多 {MAX_VIDEO_COUNT} 个；单个不超过 50MB。</Text>
                      <AttachmentUploadPreview files={fileList} onRemove={(uid) => setFileList((list) => list.filter((file) => file.uid !== uid))} />
                    </Upload.Dragger>
                  </Form.Item>
                </section>
              </Form>
            )}
          </div>
          <div className="pms-repair-dock__foot">
            {confirming ? (
              <div className="pms-repair-dock__foot-actions">
                <Button size="large" onClick={() => setConfirming(false)}>返回修改</Button>
                <Button type="primary" size="large" loading={saving} onClick={onSubmit} icon={<CheckCircleOutlined />}>确认提交报修</Button>
              </div>
            ) : (
              <Button type="primary" size="large" onClick={onReview} block icon={<RightOutlined />}>下一步：确认报修信息</Button>
            )}
            <span className="pms-repair-dock__foot-hint">必填项完整后再进入确认；收起不会清除已填写内容。</span>
          </div>
          </section>
        </>
      )}
    </>,
    document.body,
  );
}

/**
 * primary 原样保序展示（后台配好的关键词），extra 只用来补位。
 * 补位词如果和已有词首尾重叠（「跳闸」已在，就别再补「跳闸推不上去」）就丢掉，
 * 避免同一个意思占两个标签位；「灯不亮」和「楼道灯不亮」不算重叠，都保留。
 */
function mergeSuggestionTexts(primary: string[], extra: string[]) {
  const picked: string[] = [];
  const push = (raw: string, dropOverlap: boolean) => {
    const text = String(raw ?? '').trim();
    if (!text || picked.includes(text)) return;
    if (dropOverlap && picked.some((item) => item.startsWith(text) || text.startsWith(item))) return;
    picked.push(text);
  };
  primary.forEach((item) => push(item, false));
  extra.forEach((item) => push(item, true));
  return picked.slice(0, MAX_SUGGESTION_TAGS);
}

/** 「本处 3 次 · 全公司 24 次」：一个词是本地叫法还是全公司通用，看这两个数的差 */
function KeywordUsage({
  word, usage, companyUsage, scoped,
}: {
  word: string;
  usage: Record<string, number>;
  companyUsage: Record<string, number>;
  scoped: boolean;
}) {
  const own = usage[word] || 0;
  const all = companyUsage[word] || 0;
  const text = scoped ? `本处 ${own} · 全公司 ${all}` : `${own} 次`;
  return (
    <Text
      type="secondary"
      title={scoped
        ? `本管理处历史里用过 ${own} 次，全公司 ${all} 次`
        : `历史里用过 ${own} 次`}
      style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}
    >
      {text}
    </Text>
  );
}

/**
 * 报修类型配置里的「猜你想输」关键词编辑器。
 *
 * 三层（2026-08-31）：本处增补（可增删调序）+ 公司模板（只能停用/恢复，公司层改了立刻跟着变）。
 * 总公司那一页只有一层 —— 那一页改的就是模板本身，所以 template/muted 都传空。
 *
 * 关键词同时是报修类型的判定依据，所以加词时要挡撞车：同一套里一个词只能属于一个类型，
 * 两边都配了系统只会按排序悄悄挑一个（服务端 assertNoKeywordConflict 也会再拦一道）。
 */
function KeywordEditor({
  keywords, template, muted, usage, companyUsage, scoped, isTemplateTab,
  draft, learned, conflictOf, similarOf,
  onDraftChange, onAdd, onRemove, onMove, onSortByUsage, onToggleMute,
}: {
  /** 本处增补（总公司那一页就是模板词本身） */
  keywords: string[];
  /** 继承自公司模板的词，含已停用的 */
  template: string[];
  muted: string[];
  usage: Record<string, number>;
  companyUsage: Record<string, number>;
  scoped: boolean;
  isTemplateTab: boolean;
  draft: string;
  learned: RepairSuggestion[];
  /** 这个词被本套里的哪个类型占了；没占返回 null */
  conflictOf: (word: string) => string | null;
  /** 包含关系的近似词（不拦，只提醒） */
  similarOf: (word: string) => { word: string; label: string } | null;
  onDraftChange: (value: string) => void;
  onAdd: (text: string) => void;
  onRemove: (index: number) => void;
  onMove: (index: number, delta: number) => void;
  onSortByUsage: () => void;
  onToggleMute: (word: string) => void;
}) {
  const draftWord = draft.trim();
  const draftConflict = draftWord ? conflictOf(draftWord) : null;
  const draftSimilar = draftWord && !draftConflict ? similarOf(draftWord) : null;

  const rowStyle = (last: boolean) => ({
    display: 'flex' as const,
    alignItems: 'center' as const,
    gap: 8,
    minHeight: 44,
    padding: '4px 8px 4px 12px',
    borderBottom: last ? 'none' : '1px solid #f5f5f5',
  });

  return (
    <div>
      <Space.Compact style={{ width: '100%' }}>
        <Input
          value={draft}
          placeholder="添加关键词，如：水管漏水"
          maxLength={30}
          status={draftConflict ? 'error' : undefined}
          onChange={(e) => onDraftChange(e.target.value)}
          onPressEnter={(e) => { e.preventDefault(); onAdd(draft); }}
        />
        <Button type="primary" icon={<PlusOutlined />} onClick={() => onAdd(draft)}>添加</Button>
      </Space.Compact>

      {draftConflict && (
        <Text type="danger" style={{ display: 'block', fontSize: 12, marginTop: 6 }}>
          <WarningOutlined /> 「{draftWord}」已经是「{draftConflict}」的关键词。
          同一个词只能属于一个类型，否则系统只能按排序挑一个，判得准不准全看运气。
        </Text>
      )}
      {draftSimilar && (
        <Text type="warning" style={{ display: 'block', fontSize: 12, marginTop: 6 }}>
          <BulbOutlined /> 「{draftSimilar.label}」里有个相近的「{draftSimilar.word}」。
          两个词长短不同，系统按字数多的那个判，一般不会打架 —— 确认是两回事就直接加。
        </Text>
      )}

      <Space size={8} style={{ marginTop: 8 }}>
        <Button size="small" onClick={onSortByUsage} disabled={keywords.length < 2}>
          按使用次数排序
        </Button>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {scoped ? '次数按本管理处的历史报修算' : '次数来自历史报修内容归纳'}
        </Text>
      </Space>

      {!isTemplateTab && (
        <Text type="secondary" style={{ display: 'block', fontSize: 12, marginTop: 12 }}>
          本处关键词（{keywords.length}）· 只在这个管理处生效，排在模板词前面
        </Text>
      )}
      {keywords.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={isTemplateTab ? '还没有关键词' : '本处还没有自己的词，下面的模板词已经在用了'}
          style={{ margin: '12px 0' }}
        />
      ) : (
        <div style={{ marginTop: 8, border: '1px solid #f0f0f0', borderRadius: 8 }}>
          {keywords.map((keyword, index) => (
            <div key={keyword} style={rowStyle(index === keywords.length - 1)}>
              <Text style={{ flex: 1, minWidth: 0 }} ellipsis={{ tooltip: keyword }}>{keyword}</Text>
              <KeywordUsage word={keyword} usage={usage} companyUsage={companyUsage} scoped={scoped} />
              <Button
                type="text"
                aria-label={`上移 ${keyword}`}
                title="上移"
                disabled={index === 0}
                icon={<ArrowUpOutlined />}
                onClick={() => onMove(index, -1)}
              />
              <Button
                type="text"
                aria-label={`下移 ${keyword}`}
                title="下移"
                disabled={index === keywords.length - 1}
                icon={<ArrowDownOutlined />}
                onClick={() => onMove(index, 1)}
              />
              <Button
                type="text"
                danger
                aria-label={`删除 ${keyword}`}
                title="删除"
                icon={<DeleteOutlined />}
                onClick={() => onRemove(index)}
              />
            </div>
          ))}
        </div>
      )}

      {!isTemplateTab && template.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            公司模板（{template.length}）· 总公司那一页改了这里立刻跟着变；本处用不上的可以停用
          </Text>
          <div style={{ marginTop: 8, border: '1px solid #f0f0f0', borderRadius: 8, background: '#fafafa' }}>
            {template.map((keyword, index) => {
              const off = muted.includes(keyword);
              return (
                <div key={keyword} style={rowStyle(index === template.length - 1)}>
                  <Text
                    delete={off}
                    type={off ? 'secondary' : undefined}
                    style={{ flex: 1, minWidth: 0 }}
                    ellipsis={{ tooltip: keyword }}
                  >
                    {keyword}
                  </Text>
                  {off
                    ? <Tag style={{ marginInlineEnd: 0 }}>本处已停用</Tag>
                    : <KeywordUsage word={keyword} usage={usage} companyUsage={companyUsage} scoped={scoped} />}
                  <Button
                    type="text"
                    aria-label={`${off ? '恢复' : '停用'} ${keyword}`}
                    title={off ? '在本处恢复这个词' : '在本处停用这个词（不影响其它管理处）'}
                    icon={off ? <UndoOutlined /> : <StopOutlined />}
                    onClick={() => onToggleMute(keyword)}
                  />
                </div>
              );
            })}
          </div>
        </div>
      )}

      {learned.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {isTemplateTab
              ? '各管理处历史里常被输入、模板还没收的（点一下收进模板）：'
              : '本处历史里常被输入、还没加进来的（点一下加入）：'}
          </Text>
          <Space size={[6, 6]} wrap style={{ marginTop: 6 }}>
            {learned.map((item) => {
              const taken = conflictOf(item.text);
              return (
                <Tag
                  key={item.text}
                  color={taken ? 'default' : 'blue'}
                  title={taken ? `已经是「${taken}」的关键词，加不进来` : `历史里出现 ${item.count} 次`}
                  style={{ cursor: taken ? 'not-allowed' : 'pointer', marginInlineEnd: 0, opacity: taken ? 0.55 : 1 }}
                  onClick={() => { if (!taken) onAdd(item.text); }}
                >
                  {item.text} · {item.count}
                </Tag>
              );
            })}
          </Space>
        </div>
      )}
    </div>
  );
}

function SuggestionTags({
  items, onPick, title = '猜你想输',
}: {
  items: string[];
  onPick: (text: string) => void;
  title?: string;
}) {
  if (!items.length) return null;
  return (
    <div style={{ marginTop: -12, marginBottom: 16 }}>
      <Text type="secondary" style={{ fontSize: 12 }}>{title}：</Text>
      <Space size={[6, 6]} wrap style={{ marginTop: 6 }}>
        {items.map((item) => (
          <Tag
            key={item}
            color="blue"
            style={{ cursor: 'pointer', marginInlineEnd: 0 }}
            onClick={() => onPick(item)}
          >
            {item}
          </Tag>
        ))}
      </Space>
    </div>
  );
}

const attachmentDropStyle = {
  minHeight: 150,
  padding: '24px 16px',
  borderRadius: 8,
};
const compactDescriptionLabelStyle = {
  width: '1%',
  whiteSpace: 'nowrap',
  paddingInline: 12,
} as const;
const compactDescriptionContentStyle = {
  width: 'auto',
} as const;
const REPAIR_RECORD_LABEL_WIDTH = 118;

function AttachmentUploadPreview({
  files,
  onRemove,
}: {
  files: UploadFile<UploadResponse>[];
  onRemove: (uid: string) => void;
}) {
  if (!files.length) return null;
  return (
    <div
      onClick={(event) => event.stopPropagation()}
      style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(132px, 1fr))', gap: 12, marginTop: 14 }}
    >
      {files.map((file) => {
        const url = getUploadFileUrl(file);
        const isVideo = isUploadVideo(file);
        return (
          <div
            key={file.uid}
            style={{
              position: 'relative',
              height: 132,
              border: '1px solid #d9d9d9',
              borderRadius: 8,
              overflow: 'hidden',
              background: '#fafafa',
            }}
          >
            {isVideo ? (
              url ? (
                <video src={url} muted controls style={{ width: '100%', height: '100%', objectFit: 'cover', background: '#000' }} />
              ) : (
                <div style={{ height: '100%', display: 'grid', placeItems: 'center' }}>
                  <VideoCameraOutlined style={{ fontSize: 28, color: '#999' }} />
                </div>
              )
            ) : url ? (
              <Image
                src={url}
                width="100%"
                height="100%"
                style={{ objectFit: 'cover' }}
                preview={{ src: url }}
              />
            ) : (
              <div style={{ height: '100%', display: 'grid', placeItems: 'center' }}>
                <UploadOutlined style={{ fontSize: 28, color: '#999' }} />
              </div>
            )}
            {file.status === 'uploading' && (
              <div style={{
                position: 'absolute',
                inset: 0,
                display: 'grid',
                placeItems: 'center',
                background: 'rgba(255,255,255,.72)',
                fontWeight: 600,
              }}>
                上传中
              </div>
            )}
            {file.status === 'error' && (
              <div style={{
                position: 'absolute',
                inset: 0,
                display: 'grid',
                placeItems: 'center',
                background: 'rgba(255,77,79,.78)',
                color: '#fff',
                fontWeight: 600,
              }}>
                上传失败
              </div>
            )}
            <Button
              danger
              type="primary"
              size="small"
              shape="circle"
              icon={<DeleteOutlined />}
              onClick={(event) => {
                event.stopPropagation();
                onRemove(file.uid);
              }}
              style={{ position: 'absolute', top: 6, right: 6 }}
            />
          </div>
        );
      })}
    </div>
  );
}

function countAttachmentKinds(files: Array<{ type?: string; name?: string; url?: string; response?: UploadResponse }>) {
  return files.reduce(
    (acc, file) => {
      if (isUploadVideo(file)) acc.videos += 1;
      else acc.images += 1;
      return acc;
    },
    { images: 0, videos: 0 },
  );
}

function buildAttachmentUploadProps({
  fileList,
  setFileList,
  message,
  maxImages = MAX_IMAGE_COUNT,
  maxVideos = MAX_VIDEO_COUNT,
}: {
  fileList: UploadFile<UploadResponse>[];
  setFileList: (files: UploadFile<UploadResponse>[]) => void;
  message: { success: (text: string) => void; error: (text: string) => void };
  maxImages?: number;
  maxVideos?: number;
}): UploadProps<UploadResponse> {
  return {
    name: 'file',
    action: `${API_BASE_URL}/upload`,
    headers: auth.getToken() ? { Authorization: `Bearer ${auth.getToken()}` } : undefined,
    accept: 'image/*,video/*',
    multiple: true,
    showUploadList: false,
    fileList,
    beforeUpload: async (file, selectedFiles) => {
      const isImage = isUploadImage(file);
      const isVideo = isUploadVideo(file);
      if (!isImage && !isVideo) {
        message.error('只能上传照片或视频');
        return Upload.LIST_IGNORE;
      }
      if (file.size / 1024 / 1024 > 50) {
        message.error('单个文件不能超过 50MB');
        return Upload.LIST_IGNORE;
      }
      const currentCounts = countAttachmentKinds(fileList);
      const selectedCounts = countAttachmentKinds(selectedFiles);
      if (isImage && currentCounts.images + selectedCounts.images > maxImages) {
        message.error(`照片最多上传 ${maxImages} 张`);
        return Upload.LIST_IGNORE;
      }
      if (isVideo && currentCounts.videos + selectedCounts.videos > maxVideos) {
        message.error(`视频最多上传 ${maxVideos} 个`);
        return Upload.LIST_IGNORE;
      }
      // 视频原样传（浏览器里转码代价太大）；照片压一道再传
      return compressImageFile(file);
    },
    onChange: ({ file, fileList: nextList }) => {
      if (file.status === 'done') {
        message.success(`${file.name} 上传成功`);
      } else if (file.status === 'error') {
        message.error(`${file.name} 上传失败`);
      }
      setFileList(nextList.map((item) => {
        const localPreviewUrl = item.thumbUrl || createLocalPreviewUrl(item);
        const submitUrl = item.response?.publicUrl || item.url;
        return {
          ...item,
          thumbUrl: localPreviewUrl,
          url: submitUrl,
        };
      }));
    },
  };
}

function getUploadFileUrl(file: UploadFile<UploadResponse>) {
  return file.thumbUrl || file.response?.publicUrl || file.url;
}

function createLocalPreviewUrl(file: UploadFile<UploadResponse>) {
  if (file.thumbUrl) return file.thumbUrl;
  const originFile = file.originFileObj;
  if (!originFile) return undefined;
  try {
    return URL.createObjectURL(originFile);
  } catch {
    return undefined;
  }
}

function isUploadVideo(file: { type?: string; name?: string; url?: string; response?: UploadResponse }) {
  const value = `${file.type || ''} ${file.name || ''} ${file.url || ''} ${file.response?.publicUrl || ''}`;
  // 扩展名口径引 shared-types，三端一份；这里只多判一个浏览器给的 MIME
  return /^video\//i.test(file.type || '') || isVideoUrl(value);
}

function isUploadImage(file: { type?: string; name?: string; url?: string; response?: UploadResponse }) {
  const value = `${file.type || ''} ${file.name || ''} ${file.url || ''} ${file.response?.publicUrl || ''}`;
  return /^image\//i.test(file.type || '') || /\.(jpg|jpeg|png|gif|webp|bmp|heic)(\?|#|$|\s)/i.test(value);
}

/** 工单池缩略图：列表只占一格，点击可查看这一单的全部报修图片。 */
function RepairPhotoCell({ photos, total }: { photos: string[]; total: number }) {
  if (!photos.length) return <Text type="secondary" style={{ fontSize: 12 }}>无图片</Text>;
  return (
    <div className="pms-workorder-photo" onClick={(event) => event.stopPropagation()}>
      <Image.PreviewGroup>
        <Image
          src={photos[0]}
          width={58}
          height={58}
          style={{ objectFit: 'cover', borderRadius: 8 }}
          preview={{ src: photos[0] }}
          fallback=""
        />
        {photos.slice(1).map((url) => <Image key={url} src={url} style={{ display: 'none' }} fallback="" />)}
      </Image.PreviewGroup>
      {total > 1 && <span>+{total - 1}</span>}
    </div>
  );
}

function AttachmentPreview({ urls }: { urls: string[] }) {
  if (!urls.length) return <Text type="secondary">未上传</Text>;
  return (
    <Space size={[12, 12]} wrap>
      <Image.PreviewGroup>
        {urls.map((url) => {
          if (isVideoUrl(url)) {
            return (
              <div key={url} style={{ width: 180 }}>
                <video
                  src={url}
                  controls
                  style={{ width: '100%', height: 120, borderRadius: 8, background: '#000' }}
                />
                <Button
                  type="link"
                  size="small"
                  href={url}
                  target="_blank"
                  icon={<VideoCameraOutlined />}
                  style={{ paddingInline: 0 }}
                >
                  打开视频
                </Button>
              </div>
            );
          }
          return (
            <Image
              key={url}
              src={url}
              width={120}
              height={120}
              style={{ objectFit: 'cover', borderRadius: 8 }}
              preview={{ src: url }}
              fallback=""
            />
          );
        })}
      </Image.PreviewGroup>
    </Space>
  );
}

function CompactRepairRecord({ detail }: { detail: WorkOrderDetail }) {
  const wo = detail.workOrder;
  const usedMaterials = wo.usedMaterials?.length
    ? wo.usedMaterials.map((item, index) => (
        <Tag key={`${item.name || item.materialId || index}-${index}`}>
          {item.name || nameOr(null, '材料')} x {item.qty}{item.unit || ''}
        </Tag>
      ))
    : '-';
  const missingMaterials = wo.missingMaterials?.length
    ? wo.missingMaterials.map((item, index) => (
        <Tag color="orange" key={`${item.name}-${index}`}>
          {item.name} x {item.qty}{item.unit || ''}
          {item.materialId ? '' : '（手填）'}
        </Tag>
      ))
    : '-';

  return (
    <div className="pms-workorder-repair-record">
      <CompactRepairRecordRow label="实际故障位置">{wo.faultLocation || '-'}</CompactRepairRecordRow>
      <CompactRepairRecordRow label="故障现象">{wo.faultSymptom || '-'}</CompactRepairRecordRow>
      <CompactRepairRecordRow label="维修内容">{wo.repairContent || wo.actionNote || '-'}</CompactRepairRecordRow>
      <CompactRepairRecordRow label="用料和数量">{usedMaterials}</CompactRepairRecordRow>
      <CompactRepairRecordRow label="等待材料">{missingMaterials}</CompactRepairRecordRow>
      <CompactRepairRecordRow label="维修照片 / 视频">
        <AttachmentPreview urls={wo.resultAttachments || []} />
      </CompactRepairRecordRow>
    </div>
  );
}

function CompactRepairRecordRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div
      className="pms-workorder-repair-row"
      style={{ '--repair-label-width': `${REPAIR_RECORD_LABEL_WIDTH}px` } as CSSProperties}
    >
      <div className="pms-workorder-repair-label">{label}</div>
      <div className="pms-workorder-repair-value">{children}</div>
    </div>
  );
}

function repairSourceText(source?: string | null) {
  return source === 'staff_miniapp'
    ? '员工小程序'
    : source === 'owner_miniapp'
      ? '业主小程序'
      : source === 'office_web'
        ? '网页平台'
        : source || '来源未记录';
}

// ---------------- 工单详情抽屉 ----------------
function WorkOrderDetailDrawer({
  id, staffList, dispatchTechnicians, repairTypeRules, onClose, onChanged,
}: {
  id: number | null;
  staffList: Staff[];
  dispatchTechnicians: TechnicianOption[];
  repairTypeRules: RepairTypeRule[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const { message } = AntdApp.useApp();
  const nav = useNavigate();
  const { access } = useAuth();
  const { canEdit } = usePagePerm('work-orders');
  const isSystemAdmin = !!access?.isTenantAdmin || !!access?.isPlatformAdmin;
  const canFillMaintenance = usePagePerm('maintenance-orders').canEdit;
  const [detail, setDetail] = useState<WorkOrderDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const [completeOpen, setCompleteOpen] = useState(false);
  const [needMaterialOpen, setNeedMaterialOpen] = useState(false);
  const [editMissingOpen, setEditMissingOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [voidOpen, setVoidOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [changeTypeOpen, setChangeTypeOpen] = useState(false);
  const [progressOpen, setProgressOpen] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const [rollbackOpen, setRollbackOpen] = useState(false);

  const load = useCallback(async () => {
    if (!id) { setDetail(null); return; }
    setLoading(true);
    try {
      const r = await request<WorkOrderDetail>({ url: `/work-orders/${id}` });
      setDetail(r);
    } catch (e: any) {
      message.error(e?.message || '加载详情失败');
    } finally {
      setLoading(false);
    }
  }, [id, message]);

  useEffect(() => { load(); }, [load]);

  const refresh = async () => { await load(); onChanged(); };

  const onAccept = async () => {
    try {
      await request({ method: 'POST', url: `/work-orders/${id}/accept` });
      message.success('已接单');
      await refresh();
    } catch (e: any) { message.error(e?.message || '接单失败'); }
  };

  if (!id) return null;

  const wo = detail?.workOrder;
  const status = wo?.status;
  // 「能接单的人」由后端按权限查（角色里勾了「工单池 · 接单」），
  // 不再靠 users.role 过滤员工列表
  const technicians = dispatchTechnicians;
  const assigneeName = wo?.assigneeId
    ? nameOr(wo.assigneeName || staffList.find((staff) => staff.id === wo.assigneeId)?.name, '维修工')
    : '未派单';
  const statusLabel = wo
    ? wo.status === WorkOrderStatus.CREATED
      ? wo.candidateIds?.length ? '待维修工接单' : '等待办公室派单'
      : statusMeta[wo.status].label
    : '';
  const timelineLogs = detail
    ? [...detail.logs].sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime() || b.id - a.id,
      )
    : [];
  const actionBar = status && (canEdit || isSystemAdmin || canFillMaintenance) ? (
    <div className="pms-workorder-detail-actionbar">
      <div className="pms-workorder-detail-secondary-actions">
        {canFillMaintenance && ![WorkOrderStatus.CANCELLED, WorkOrderStatus.VOIDED].includes(status) && (
          <Button icon={<FileTextOutlined />} onClick={() => nav(`/maintenance-orders?workOrderId=${id}`)}>填养护单</Button>
        )}
        {canEdit && [WorkOrderStatus.DISPATCHED, WorkOrderStatus.IN_PROGRESS, WorkOrderStatus.WAITING_MATERIAL].includes(status) && (
          <Button onClick={() => setAssignOpen(true)}>改派维修工</Button>
        )}
        {canEdit && status === WorkOrderStatus.IN_PROGRESS && <Button onClick={() => setNeedMaterialOpen(true)}>标记缺料</Button>}
        {canEdit && [WorkOrderStatus.IN_PROGRESS, WorkOrderStatus.DONE_PENDING_REVIEW, WorkOrderStatus.COMPLETED].includes(status) && (
          <Button icon={<PlusOutlined />} onClick={() => setProgressOpen(true)}>
            {status === WorkOrderStatus.COMPLETED ? '补充维修记录' : '添加进度'}
          </Button>
        )}
        {canEdit && status === WorkOrderStatus.WAITING_MATERIAL && <Button onClick={() => setEditMissingOpen(true)}>修改缺料</Button>}
        {canEdit && [WorkOrderStatus.CREATED, WorkOrderStatus.DISPATCHED, WorkOrderStatus.IN_PROGRESS, WorkOrderStatus.WAITING_MATERIAL].includes(status) && (
          <Button danger onClick={() => setCancelOpen(true)}>撤单</Button>
        )}
        {canEdit && status !== WorkOrderStatus.VOIDED && (
          <Button danger icon={<StopOutlined />} onClick={() => setVoidOpen(true)}>作废工单</Button>
        )}
        {isSystemAdmin && (
          <Button danger icon={<DeleteOutlined />} onClick={() => setDeleteOpen(true)}>永久删除</Button>
        )}
        {canEdit && status === WorkOrderStatus.IN_PROGRESS && (
          <Button danger icon={<UndoOutlined />} onClick={() => setTransferOpen(true)}>转给其他人修</Button>
        )}
        {canEdit && ![WorkOrderStatus.CREATED, WorkOrderStatus.VOIDED].includes(status) && (
          <Button icon={<UndoOutlined />} onClick={() => setRollbackOpen(true)}>撤回上一步</Button>
        )}
      </div>
      <div className="pms-workorder-detail-primary-actions">
        {canEdit && status === WorkOrderStatus.CREATED && (
          <Button type="primary" onClick={() => setAssignOpen(true)}>立即派单</Button>
        )}
        {canEdit && status === WorkOrderStatus.DISPATCHED && (
          <Button type="primary" onClick={onAccept}>代维修工接单</Button>
        )}
        {canEdit && [WorkOrderStatus.IN_PROGRESS, WorkOrderStatus.WAITING_MATERIAL].includes(status) && (
          <Button type="primary" onClick={() => setCompleteOpen(true)}>填写完工结果</Button>
        )}
        {canEdit && status === WorkOrderStatus.DONE_PENDING_REVIEW && (
          <Button type="primary" onClick={() => setReviewOpen(true)}>开始验收</Button>
        )}
      </div>
    </div>
  ) : null;

  return (
    <>
      <Drawer
        className="pms-workorder-detail-drawer"
        open={!!id}
        title={(
          <div className="pms-workorder-detail-drawer-title">
            <strong>工单详情</strong>
            <span>集中查看现场、调度、维修结果与处理进度</span>
          </div>
        )}
        width="min(1040px, 97vw)"
        onClose={onClose}
        loading={loading}
        extra={wo ? (
          <div className="pms-workorder-detail-order-no">
            <span>工单编号</span>
            <Text copyable={{ text: wo.orderNo }}>{wo.orderNo}</Text>
          </div>
        ) : null}
        footer={detail && actionBar ? actionBar : null}
      >
        {!detail ? <Empty /> : (
          <div className="pms-workorder-detail-content">
            <DetailHero
              eyebrow={<span className="pms-workorder-detail-address-label">需要去这里维修</span>}
              title={detail.request.addressText || '地址待补充'}
              description={detail.request.content || '未填写问题描述'}
              tags={<>
                <Tag color={statusMeta[detail.workOrder.status].color}>
                  {statusLabel}
                </Tag>
                {detail.request.urgent && <Tag color="error">紧急工单</Tag>}
                <Tag color="blue">{getRepairTypeLabel(detail.request.repairType, repairTypeRules)}</Tag>
              </>}
              meta={<>
                <span><strong>报修人</strong>{detail.request.contactName || '未填写'}{detail.request.reporterRoleLabel ? `（${detail.request.reporterRoleLabel}代报）` : ''}</span>
                <span><strong>联系电话</strong>{detail.request.contactPhone || '未填写'}</span>
                <span><strong>提交渠道</strong>{repairSourceText(detail.request.source)}</span>
                <span><strong>报修时间</strong>{formatDateTimeCn(detail.workOrder.createdAt) || '未记录'}</span>
              </>}
              visual={<AttachmentPreview urls={(detail.request.attachments || []).slice(0, 3)} />}
            />
            <DetailMetrics items={[
              { label: '当前处理节点', value: statusLabel, tone: detail.request.urgent ? 'danger' : 'normal' },
              { label: '当前负责人', value: assigneeName },
              { label: '从报修至今', value: `${stayDaysOf(detail.workOrder)} 天`, tone: stayDaysOf(detail.workOrder) >= 3 ? 'warning' : 'normal' },
              { label: '要求完成时间', value: detail.workOrder.slaDueAt ? slaCountdownText(detail.workOrder.slaDueAt) : '未设置', tone: slaDanger(detail.workOrder) ? 'danger' : 'normal' },
            ]} />

            <div className="pms-workorder-detail-columns">
              <div className="pms-workorder-detail-main-column">
                <DetailSection title="报修信息" description="先核对维修地点、问题描述和联系人">
                  <Descriptions
                    className="pms-workorder-report-descriptions"
                    size="middle"
                    column={2}
                    bordered
                    labelStyle={compactDescriptionLabelStyle}
                    contentStyle={compactDescriptionContentStyle}
                    items={[
                      { key: 'addr', label: '报修地址', children: detail.request.addressText || '-', span: 2 },
                      { key: 'content', label: '故障描述', children: detail.request.content, span: 2 },
                      {
                        key: 'name',
                        label: '联系人',
                        children: detail.request.contactName
                          ? detail.request.reporterRoleLabel
                            ? `${detail.request.contactName}（${detail.request.reporterRoleLabel}代报）`
                            : detail.request.contactName
                          : '-',
                      },
                      { key: 'phone', label: '联系电话', children: detail.request.contactPhone || '-' },
                      { key: 'source', label: '提交渠道', children: repairSourceText(detail.request.source) },
                      { key: 'created', label: '报修时间', children: formatDateTimeCn(detail.workOrder.createdAt) || '-' },
                      { key: 'regAddr', label: '报修人登记地址', children: detail.request.reporterAddressText || '-', span: 2 },
                      {
                        key: 'attachments',
                        label: '现场照片 / 视频',
                        children: <AttachmentPreview urls={detail.request.attachments || []} />,
                        span: 2,
                      },
                    ]}
                  />
                </DetailSection>

                <DetailSection title="维修结果" description="维修工实际填写的故障、处理、用料与费用">
                  <CompactRepairRecord detail={detail} />
                  <div className="pms-workorder-fee-summary">
                    <span>本单收费金额</span>
                    <strong>{detail.workOrder.feeCents ? `¥ ${(detail.workOrder.feeCents / 100).toFixed(2)}` : '未收费'}</strong>
                  </div>
                </DetailSection>
              </div>

              <div className="pms-workorder-detail-side-column">
                <DetailSection title="调度信息" description="负责人、工种和完成期限">
                  <div className="pms-workorder-assignee-card">
                    <span className="pms-workorder-assignee-avatar"><UserOutlined /></span>
                    <div><small>当前负责人</small><strong>{assigneeName}</strong></div>
                  </div>
                  <Descriptions
                    className="pms-workorder-side-descriptions"
                    size="middle"
                    column={1}
                    colon={false}
                    items={[
                      {
                        key: 'type',
                        label: '工单类型',
                        children: (() => {
                          const label = getRepairTypeLabel(detail.request.repairType, repairTypeRules);
                          const lockReason = repairTypeAndSlaLockReason(detail.workOrder.status);
                          if (!canEdit) return label;
                          if (lockReason) {
                            return (
                              <Space size={6} wrap>
                                <Text type="secondary">{label}</Text>
                                <Text type="secondary" className="pms-workorder-lock-reason">（{lockReason}）</Text>
                              </Space>
                            );
                          }
                          return (
                            <Space size={6} wrap>
                              {label}
                              <Button type="link" size="small" onClick={() => setChangeTypeOpen(true)}>更正类型</Button>
                            </Space>
                          );
                        })(),
                      },
                      { key: 'skill', label: '维修工种', children: getRepairTypeLabel(detail.workOrder.skill, repairTypeRules) },
                      {
                        key: 'sla',
                        label: '要求完成时间',
                        children: (
                          <Space direction="vertical" size={10}>
                            <SlaDueEditor
                              workOrderId={detail.workOrder.id}
                              value={detail.workOrder.slaDueAt ?? null}
                              status={detail.workOrder.status}
                              canEdit={canEdit}
                              onChanged={refresh}
                            />
                            <UrgeRepairButton
                              workOrderId={detail.workOrder.id}
                              status={detail.workOrder.status}
                              canEdit={canEdit}
                              onDone={refresh}
                            />
                          </Space>
                        ),
                      },
                    ]}
                  />
                </DetailSection>

                <DetailSection title="处理进度" description="从报修到当前节点的完整轨迹">
                  <Timeline
                    className="pms-detail-timeline"
                    items={timelineLogs.map((log, index) => ({
                      color: log.toStatus === WorkOrderStatus.COMPLETED ? 'green' : log.toStatus === WorkOrderStatus.VOIDED ? 'gray' : 'blue',
                      children: (
                        <div className="pms-workorder-timeline-entry">
                          <div className="pms-workorder-timeline-title">
                            <strong>{actionLabel(log.action)}</strong>
                            <Text type="secondary">{formatDateTimeCn(log.createdAt)}</Text>
                            {(() => {
                              const newer = timelineLogs[index - 1];
                              const finished =
                                detail.workOrder.status === WorkOrderStatus.COMPLETED ||
                                detail.workOrder.status === WorkOrderStatus.CANCELLED ||
                                detail.workOrder.status === WorkOrderStatus.VOIDED;
                              const stay = newer
                                ? formatDuration(log.createdAt, newer.createdAt)
                                : finished
                                  ? ''
                                  : formatDuration(log.createdAt, null);
                              return stay ? <Text type="secondary" className="pms-workorder-timeline-stay">停留 {stay}</Text> : null;
                            })()}
                          </div>
                          <div className="pms-workorder-timeline-note">
                            <Text type="secondary">操作人：{log.operatorName || (log.operatorId ? '未知操作人' : '系统')}</Text>
                            {log.fromStatus && (
                              <Text type="secondary">
                                {statusMeta[log.fromStatus].label} → {statusMeta[log.toStatus].label}
                              </Text>
                            )}
                            {log.note && <div>{log.note}</div>}
                            {!!log.attachments?.length && (
                              <div className="pms-workorder-timeline-photos">
                                <AttachmentPreview urls={log.attachments} />
                              </div>
                            )}
                          </div>
                        </div>
                      ),
                    }))}
                  />
                </DetailSection>
              </div>
            </div>
          </div>
        )}
      </Drawer>

      <AssignModal
        open={assignOpen}
        workOrderId={id}
        communityId={detail?.workOrder.communityId}
        technicians={technicians}
        repairTypeRules={repairTypeRules}
        currentSkill={detail?.workOrder.skill ?? undefined}
        onClose={() => setAssignOpen(false)}
        onDone={async () => { setAssignOpen(false); await refresh(); }}
      />
      <CompleteModal
        open={completeOpen}
        workOrderId={id}
        detail={detail}
        onClose={() => setCompleteOpen(false)}
        onDone={async () => { setCompleteOpen(false); await refresh(); }}
      />
      <NeedMaterialModal
        open={needMaterialOpen}
        workOrderId={id}
        onClose={() => setNeedMaterialOpen(false)}
        onDone={async () => { setNeedMaterialOpen(false); await refresh(); }}
      />
      <EditMissingMaterialsModal
        open={editMissingOpen}
        workOrderId={id}
        rows={detail?.workOrder.missingMaterials || []}
        onClose={() => setEditMissingOpen(false)}
        onDone={async () => { setEditMissingOpen(false); await refresh(); }}
      />
      <CancelModal
        open={cancelOpen}
        workOrderId={id}
        onClose={() => setCancelOpen(false)}
        onDone={async () => { setCancelOpen(false); await refresh(); }}
      />
      <VoidWorkOrderModal
        open={voidOpen}
        workOrder={detail?.workOrder ?? null}
        materialLines={detail?.materialUsages?.length ?? 0}
        onClose={() => setVoidOpen(false)}
        onDone={() => {
          setVoidOpen(false);
          refresh();
        }}
      />
      <DeleteWorkOrderModal
        open={deleteOpen}
        workOrder={detail?.workOrder ?? null}
        materialLines={detail?.materialUsages?.length ?? 0}
        onClose={() => setDeleteOpen(false)}
        onDone={() => {
          setDeleteOpen(false);
          onClose();
          onChanged();
        }}
      />
      <ReviewModal
        open={reviewOpen}
        workOrderId={id}
        onClose={() => setReviewOpen(false)}
        onDone={async () => { setReviewOpen(false); await refresh(); }}
      />
      <ChangeTypeModal
        open={changeTypeOpen}
        workOrderId={id}
        currentType={detail?.request.repairType ?? null}
        content={detail?.request.content ?? ''}
        rules={repairTypeRules}
        onClose={() => setChangeTypeOpen(false)}
        onDone={async () => { setChangeTypeOpen(false); await refresh(); }}
      />
      <ProgressModal
        open={progressOpen}
        workOrderId={id}
        onClose={() => setProgressOpen(false)}
        onDone={async () => { setProgressOpen(false); await refresh(); }}
      />
      <TransferWorkOrderModal
        open={transferOpen}
        workOrderId={id}
        onClose={() => setTransferOpen(false)}
        onDone={async () => { setTransferOpen(false); await refresh(); }}
      />
      <RollbackWorkOrderModal
        open={rollbackOpen}
        workOrderId={id}
        onClose={() => setRollbackOpen(false)}
        onDone={async () => { setRollbackOpen(false); await refresh(); }}
      />
    </>
  );
}

function actionLabel(a: string) {
  const m: Record<string, string> = {
    create: '工单创建',
    create_auto_assign: '创建并自动派单',
    assign: '派单',
    accept: '维修工接单',
    complete: '维修完工',
    need_material: '标记缺料',
    review: '业主验收',
    auto_review_complete: '超时自动完成',
    change_type: '类型更正',
    set_sla: '设定完成截止',
    urge_repair: '办公室催单',
    cancel: '撤单',
    urge_office: '业主催单（提醒办公室）',
    urge_manager: '业主催单（升级经理）',
    progress: '维修进度更新',
    transfer_request: '申请转给其他人维修',
    rollback: '撤回处理节点',
    void: '作废工单',
  };
  return m[a] || a;
}

/**
 * 「发送催单通知」：办公室催维修工在截止日期前修完，微信 + 站内信各一条。
 *
 * 和系统那条「超时没人接单」的自动催办不是一回事 —— 那个催的是接单、到点自动发、
 * 还受催办时段限制；这个是人看着情况主动点的，不受时段和开关影响。
 * 服务端 5 分钟内只发一条（连点会烧光维修工的微信订阅额度），这里只管把话说清楚。
 */
function UrgeRepairButton({
  workOrderId, status, canEdit, onDone,
}: {
  workOrderId: number;
  status: WorkOrderStatus;
  canEdit: boolean;
  onDone: () => void;
}) {
  const { message } = AntdApp.useApp();
  const [sending, setSending] = useState(false);
  const closed = [WorkOrderStatus.COMPLETED, WorkOrderStatus.CANCELLED, WorkOrderStatus.VOIDED].includes(status);
  if (!canEdit || closed) return null;

  const send = async () => {
    setSending(true);
    try {
      const res = await request<{ ok: true; notified: number }>({
        method: 'POST',
        url: `/work-orders/${workOrderId}/urge-repair`,
        data: {},
      });
      // 一个人都没催到要说清楚为什么，不然办公室以为发出去了，一直等
      if (res.notified > 0) {
        message.success(`已催单，通知了 ${res.notified} 人`);
      } else {
        message.warning('这单还没人可催：既没派单，报修类型也没配默认维修工');
      }
      onDone();
    } catch (e: any) {
      message.error(e?.message || '催单失败');
    } finally {
      setSending(false);
    }
  };

  return (
    <Popconfirm
      title="给维修工发一条催单通知？"
      description="微信 + 站内信各一条，5 分钟内只能发一次。"
      okText="发送"
      cancelText="取消"
      onConfirm={send}
    >
      <Button size="small" icon={<BellOutlined />} loading={sending}>
        发送催单通知
      </Button>
    </Popconfirm>
  );
}

/**
 * 要求完成截止日期：默认不勾 = 没有截止；勾上选时间即生效，取消勾选即清除。
 * 距截止不足 4 小时或已超时的未完结单，工单池整行标红（见 slaDanger / styles.css）。
 */
function SlaDueEditor({
  workOrderId, value, status, canEdit, onChanged,
}: {
  workOrderId: number;
  value: string | null;
  status: WorkOrderStatus;
  canEdit: boolean;
  onChanged: () => void;
}) {
  const { message } = AntdApp.useApp();
  const [saving, setSaving] = useState(false);
  /** 勾了但还没选时间的中间态 */
  const [picking, setPicking] = useState(false);
  const closed = [WorkOrderStatus.COMPLETED, WorkOrderStatus.CANCELLED, WorkOrderStatus.VOIDED].includes(status);
  // 开工后置灰：截止时间是排班依据，中途改等于把排好的班打乱（服务端同样拦）
  const lockReason = repairTypeAndSlaLockReason(status);
  const danger = !!value && !closed && new Date(value).getTime() - Date.now() <= SLA_WARN_MS;

  const save = async (next: string | null) => {
    setSaving(true);
    try {
      await request({
        method: 'PATCH',
        url: `/work-orders/${workOrderId}/sla-due`,
        data: next ? { slaDueAt: next } : {},
      });
      message.success(next ? '已设定截止时间' : '已取消截止时间');
      setPicking(false);
      onChanged();
    } catch (e: any) {
      message.error(e?.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  if (!canEdit || lockReason) {
    return (
      <Space size={6} wrap>
        <Text type="secondary" style={danger ? { color: '#cf1322' } : undefined}>
          {value ? formatDateTimeCn(value) : '未设置'}
          {danger && value ? `（${slaCountdownText(value)}）` : ''}
        </Text>
        {canEdit && lockReason && (
          <Text type="secondary" style={{ fontSize: 12 }}>（{lockReason}）</Text>
        )}
      </Space>
    );
  }

  return (
    <Space size={8} wrap>
      <Checkbox
        checked={!!value || picking}
        disabled={saving}
        onChange={(e) => {
          if (e.target.checked) {
            setPicking(true);
          } else if (value) {
            save(null);
          } else {
            setPicking(false);
          }
        }}
      />
      {value || picking ? (
        <DatePicker
          showTime={{ format: 'HH:mm', minuteStep: SLA_MINUTE_STEP }}
          format="YYYY-MM-DD HH:mm"
          value={value ? dayjs(value) : null}
          disabled={saving}
          placeholder="选择日期时间"
          onChange={(d) => { if (d) save(d.toISOString()); }}
        />
      ) : (
        <Text type="secondary">未设置</Text>
      )}
      {danger && value && <Text style={{ color: '#cf1322' }}>{slaCountdownText(value)}</Text>}
    </Space>
  );
}

/**
 * 更正工单类型 + 半自动学习。
 *
 * 自动判定判错时（「24号大门关不上」被判成家里门锁），管理员在这里改成对的类型，
 * 并可勾选描述里的词（「大门」）学进新类型的判定关键词 —— 词会写进
 * 「报修类型配置」的关键词列表（原类型里的同名词同时摘掉），下次同样的描述就判对了。
 * 学了哪些词随时可以在类型配置页里删，不是黑盒。
 */
function ChangeTypeModal({
  open, workOrderId, currentType, content, rules, onClose, onDone,
}: {
  open: boolean;
  workOrderId: number | null;
  currentType: string | null;
  content: string;
  rules: RepairTypeRule[];
  onClose: () => void;
  onDone: () => void;
}) {
  const { message } = AntdApp.useApp();
  const [repairType, setRepairType] = useState<string | undefined>(undefined);
  const [keywords, setKeywords] = useState<string[]>([]);
  const [candidates, setCandidates] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open || !workOrderId) return;
    setRepairType(undefined);
    setKeywords([]);
    setCandidates([]);
    // 候选词由服务端从这单描述里挑（和判定用同一套关键词逻辑），失败就只留手动输入
    request<{ candidates: string[] }>({ url: `/work-orders/${workOrderId}/repair-type-hints` })
      .then((r) => setCandidates(r.candidates || []))
      .catch(() => setCandidates([]));
  }, [open, workOrderId]);

  const typeOptions = rules
    .filter((rule) => rule.enabled)
    .map((rule) => ({
      value: rule.repairType,
      label: rule.repairType === currentType ? `${rule.label}（当前）` : rule.label,
      disabled: rule.repairType === currentType,
    }));

  const submit = async () => {
    if (!repairType) {
      message.warning('先选择更正后的类型');
      return;
    }
    setSubmitting(true);
    try {
      await request({
        method: 'PATCH',
        url: `/work-orders/${workOrderId}/repair-type`,
        data: { repairType, learnKeywords: keywords.length ? keywords : undefined },
      });
      const label = rules.find((rule) => rule.repairType === repairType)?.label || repairType;
      message.success(
        keywords.length
          ? `已更正为「${label}」，并记住关键词：${keywords.join('、')}`
          : `已更正为「${label}」`,
      );
      onDone();
    } catch (e: any) {
      message.error(e?.message || '更正失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      title="更正工单类型"
      okText="确认更正"
      okButtonProps={{ loading: submitting }}
      onOk={submit}
      onCancel={onClose}
      destroyOnClose
    >
      {content && (
        <div style={{ marginBottom: 12, padding: '8px 12px', background: 'rgba(0,0,0,0.03)', borderRadius: 6 }}>
          <Text type="secondary">报修描述：</Text>{content}
        </div>
      )}
      <div style={{ marginBottom: 8 }}>更正为</div>
      <Select
        {...searchableWideSelectProps}
        style={{ width: '100%' }}
        placeholder="选择正确的类型"
        options={withOptionTitles(typeOptions)}
        value={repairType}
        onChange={(v) => setRepairType(v)}
      />
      <div style={{ margin: '16px 0 8px' }}>
        同时记住关键词
        <Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>
          选填。下次描述里出现这些词就自动判成新类型
        </Text>
      </div>
      <Select
        mode="tags"
        style={{ width: '100%' }}
        placeholder="从候选里选，或直接输入（如：大门）"
        options={candidates.map((word) => ({ value: word, label: word }))}
        value={keywords}
        onChange={(v) => setKeywords((v as string[]).map((w) => w.trim()).filter((w) => w.length >= 2))}
      />
      <div style={{ marginTop: 8 }}>
        <Text type="secondary" style={{ fontSize: 12 }}>
          学到的词会写进「报修类型配置」的关键词列表（原类型里的同名词会摘掉），随时可以去那里删改。
        </Text>
      </div>
    </Modal>
  );
}

/** 作废保留整张工单，和系统管理员的永久删除严格分开。 */
function VoidWorkOrderModal({
  open, workOrder, materialLines, onClose, onDone,
}: {
  open: boolean;
  workOrder: WorkOrderRow | null;
  materialLines: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const { message } = AntdApp.useApp();
  const [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setReason('');
    setConfirmed(false);
  }, [open, workOrder?.id]);

  const submit = async () => {
    const value = reason.trim();
    if (value.length < 2) {
      message.warning('请填写至少 2 个字的作废原因');
      return;
    }
    if (!confirmed) {
      message.warning('请先确认退料和统计处理方式');
      return;
    }
    setSubmitting(true);
    try {
      const result = await request<{
        returnedMaterialLines: number;
        returnedQty: number;
        excludedFeeCents: number;
        detachedPurchaseRequests: number;
      }>({
        method: 'POST',
        url: `/work-orders/${workOrder?.id}/void`,
        data: { reason: value, confirmReversal: true },
      });
      const notes = ['工单已作废'];
      if (result.returnedMaterialLines) notes.push(`已退回 ${result.returnedMaterialLines} 条用料`);
      if (result.excludedFeeCents) notes.push(`¥${(result.excludedFeeCents / 100).toFixed(2)} 已从报表排除`);
      if (result.detachedPurchaseRequests) notes.push(`已解除 ${result.detachedPurchaseRequests} 张采购申请关联`);
      message.success(notes.join('，'));
      onDone();
    } catch (e: any) {
      message.error(e?.message || '作废工单失败');
    } finally {
      setSubmitting(false);
    }
  };

  const feeCents = workOrder?.feeCents ?? 0;
  return (
    <Modal
      open={open}
      title={<Space><StopOutlined style={{ color: '#d46b08' }} />作废工单</Space>}
      okText="确认作废"
      okButtonProps={{ danger: true, loading: submitting, disabled: !confirmed || reason.trim().length < 2 }}
      cancelButtonProps={{ disabled: submitting }}
      onOk={submit}
      onCancel={onClose}
      closable={!submitting}
      maskClosable={!submitting}
      destroyOnHidden
    >
      <Alert
        type="warning"
        showIcon
        message={`工单 ${workOrder?.orderNo || ''} 将停止流转，但记录不会删除`}
        description="作废后可在调度台“已作废”中筛选和查看；原始报修、金额、用料及操作原因完整保留，但不参与正常工单和经营统计。"
        style={{ marginBottom: 16 }}
      />
      <Descriptions
        size="small"
        bordered
        column={1}
        style={{ marginBottom: 16 }}
        items={[
          {
            key: 'material',
            label: '库存用料',
            children: materialLines
              ? `${materialLines} 条将按原仓库、原批次退回，并生成退料流水`
              : '没有库存领料，无需退库',
          },
          {
            key: 'fee',
            label: '收费金额',
            children: feeCents
              ? `¥${(feeCents / 100).toFixed(2)} 将从工单经营报表排除，原金额保留在审计快照`
              : '没有登记收费',
          },
          {
            key: 'learning',
            label: '数据学习',
            children: '该报修不再进入常用报修词、AI 学习样本和工单统计',
          },
        ]}
      />
      <div style={{ marginBottom: 8 }}><Text strong>作废原因</Text></div>
      <TextArea
        rows={3}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        placeholder="必填，例如：重复录入、地址填错、测试工单"
        maxLength={500}
        showCount
        disabled={submitting}
      />
      <Checkbox
        checked={confirmed}
        onChange={(event) => setConfirmed(event.target.checked)}
        disabled={submitting}
        style={{ marginTop: 14 }}
      >
        我已确认：已领用材料退回库存，收费从报表排除，工单不再参与统计和 AI 学习
      </Checkbox>
    </Modal>
  );
}

/** 系统管理员专用的不可逆永久删除。 */
function DeleteWorkOrderModal({
  open, workOrder, materialLines, onClose, onDone,
}: {
  open: boolean;
  workOrder: WorkOrderRow | null;
  materialLines: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const { message } = AntdApp.useApp();
  const [reason, setReason] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setReason('');
    setConfirmation('');
  }, [open, workOrder?.id]);

  const submit = async () => {
    const value = reason.trim();
    if (value.length < 2) {
      message.warning('请填写至少 2 个字的永久删除原因');
      return;
    }
    if (confirmation.trim() !== '永久删除') {
      message.warning('请输入“永久删除”完成确认');
      return;
    }
    setSubmitting(true);
    try {
      await request({
        method: 'DELETE',
        url: `/work-orders/${workOrder?.id}`,
        data: { reason: value, confirmation: '永久删除' },
      });
      message.success('工单已永久删除');
      onDone();
    } catch (e: any) {
      message.error(e?.message || '永久删除工单失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      title={<Space><WarningOutlined style={{ color: '#cf1322' }} />永久删除工单</Space>}
      okText="永久删除"
      okButtonProps={{
        danger: true,
        loading: submitting,
        disabled: reason.trim().length < 2 || confirmation.trim() !== '永久删除',
      }}
      cancelButtonProps={{ disabled: submitting }}
      onOk={submit}
      onCancel={onClose}
      closable={!submitting}
      maskClosable={!submitting}
      destroyOnHidden
    >
      <Alert
        type="error"
        showIcon
        message={`工单 ${workOrder?.orderNo || ''} 删除后不可恢复`}
        description="工单、报修信息、进度、验收和关联养护单会永久移除。未退用料会先退回库存；采购申请只解除关联，库存流水继续保留，避免库存账失真。"
        style={{ marginBottom: 16 }}
      />
      <Descriptions
        size="small"
        bordered
        column={1}
        style={{ marginBottom: 16 }}
        items={[
          {
            key: 'material',
            label: '库存用料',
            children: materialLines ? `${materialLines} 条未退用料会先按原批次退库` : '没有待退库存用料',
          },
          { key: 'scope', label: '权限范围', children: '只有系统管理员可以执行' },
        ]}
      />
      <div style={{ marginBottom: 8 }}><Text strong>删除原因</Text></div>
      <TextArea
        rows={3}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        placeholder="必填，例如：测试数据、重复误建且确认不需留档"
        maxLength={500}
        showCount
        disabled={submitting}
      />
      <div style={{ margin: '14px 0 8px' }}><Text strong>输入“永久删除”确认</Text></div>
      <Input
        value={confirmation}
        onChange={(event) => setConfirmation(event.target.value)}
        placeholder="永久删除"
        disabled={submitting}
      />
    </Modal>
  );
}

const CANCEL_REASON_OPTIONS = [
  { value: 'wrong_info', label: '填错了' },
  { value: 'duplicate', label: '重复提交' },
  { value: 'self_resolved', label: '已自行解决' },
  { value: 'owner_cancel', label: '业主取消' },
  { value: 'other', label: '其他' },
];

function CancelModal({
  open, workOrderId, onClose, onDone,
}: {
  open: boolean;
  workOrderId: number | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const { message } = AntdApp.useApp();
  const [reasonCode, setReasonCode] = useState('wrong_info');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (reasonCode === 'other' && !note.trim()) {
      message.warning('选择“其他”时请填写具体原因');
      return;
    }
    setSubmitting(true);
    try {
      await request({
        method: 'POST',
        url: `/work-orders/${workOrderId}/cancel`,
        data: { reasonCode, note: note.trim() || undefined },
      });
      message.success('已撤单');
      setReasonCode('wrong_info');
      setNote('');
      onDone();
    } catch (e: any) {
      message.error(e?.message || '撤单失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      title="撤销工单"
      okText="确认撤单"
      okButtonProps={{ danger: true, loading: submitting }}
      onOk={submit}
      onCancel={onClose}
      destroyOnClose
    >
      <div style={{ marginBottom: 12, color: 'rgba(0,0,0,0.55)' }}>
        撤单后工单不可恢复，请选择撤单原因：
      </div>
      <Space size={[8, 8]} wrap style={{ marginBottom: 16 }}>
        {CANCEL_REASON_OPTIONS.map((opt) => (
          <Tag.CheckableTag
            key={opt.value}
            checked={reasonCode === opt.value}
            onChange={() => setReasonCode(opt.value)}
            style={{ fontSize: 14, padding: '4px 14px', border: '1px solid #d9d9d9' }}
          >
            {opt.label}
          </Tag.CheckableTag>
        ))}
      </Space>
      <Input.TextArea
        rows={3}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder={reasonCode === 'other' ? '请填写具体原因（必填）' : '补充说明（选填）'}
        maxLength={200}
        showCount
      />
    </Modal>
  );
}

/**
 * 报修类型配置：按管理处分套（2026-08-27）。
 * 顶部一排 Tab：「公司默认（模板）」+ 每个管理处。管理处那页第一次打开由后端从模板复制一份，
 * 之后各改各的。默认维修工的候选按范围过滤：模板页只列全公司范围的人，管理处页列
 * 全公司的 + 范围覆盖该管理处的（「总公司维修工 / XX 管理处维修工」就是两个范围不同的角色）。
 * 领料仓库不再在这里配：维修工选料时按工单所在小区 / 管理处自动匹配仓库。
 */
function RepairTypeRuleModal({
  open, technicians: allTechnicians, suggestions, onClose, onDone,
}: {
  open: boolean;
  /** 全公司能接单的人，只用来把 assigneeId 翻成名字（当前页的候选另外按范围拉） */
  technicians: TechnicianOption[];
  suggestions: RepairSuggestions;
  onClose: () => void;
  onDone: () => void;
}) {
  const { message } = AntdApp.useApp();
  const { canDelete, canEdit } = usePagePerm('work-orders');
  const { access } = useAuth();
  const canUseCompanyScope =
    !!access?.scopeAll || !!access?.isTenantAdmin || !!access?.isPlatformAdmin;
  // 管理处列表现取现用：登录时拿的 access.offices 不含刚新建的管理处，拿不到就退回它
  // （退回来的那份没有「猜你想输」口径开关，按默认值补上，等接口回来再覆盖）
  const [offices, setOffices] = useState<RuleOffice[]>(
    (access?.offices ?? []).map((office) => ({
      ...office,
      suggestionScope: 'office_first' as SuggestionScope,
      suggestionFeedback: true,
    })),
  );
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<RepairTypeRule | null>(null);
  /** 当前在配哪一套：'company' = 公司默认模板，数字 = 管理处 id */
  const [tab, setTab] = useState<'company' | number>(() =>
    canUseCompanyScope ? 'company' : access?.offices?.[0]?.id ?? 'company',
  );
  const officeId = tab === 'company' ? null : tab;
  const officeName = officeId ? nameOr(offices.find((o) => o.id === officeId)?.name, '管理处') : '';
  const [localRules, setLocalRules] = useState<RepairTypeRule[]>([]);
  const [rulesLoading, setRulesLoading] = useState(false);
  /** 本页可选的默认维修工（已按范围过滤） */
  const [tabTechnicians, setTabTechnicians] = useState<TechnicianOption[]>([]);
  const [draggingRuleId, setDraggingRuleId] = useState<number | null>(null);
  /** 正在编辑的这条：本处增补（总公司那一页就是模板词本身） */
  const [keywords, setKeywords] = useState<string[]>([]);
  /** 正在编辑的这条：继承自公司模板的词（含已停用的），只读 */
  const [templateWords, setTemplateWords] = useState<string[]>([]);
  /** 正在编辑的这条：本处停用掉的模板词 */
  const [mutedWords, setMutedWords] = useState<string[]>([]);
  const [keywordDraft, setKeywordDraft] = useState('');
  /**
   * 「猜你想输」的次数按当前 Tab 的管理处口径重拉：本处口径下配出来的顺序，
   * 才是这个小区的人真正常说的顺序。页面级那份（全公司）留给录入表单兜底。
   */
  const [tabSuggestions, setTabSuggestions] = useState<RepairSuggestions>(suggestions);
  const [savingOfficeSettings, setSavingOfficeSettings] = useState(false);

  const technicianName = (id: number | null) => {
    if (!id) return null;
    const hit = tabTechnicians.find((t) => t.id === id) || allTechnicians.find((t) => t.id === id);
    return nameOr(hit?.name, '维修工');
  };

  const loadTab = useCallback(async (which: 'company' | number) => {
    setRulesLoading(true);
    try {
      const oid = which === 'company' ? null : which;
      const [rules, techs, tabSugg] = await Promise.all([
        request<RepairTypeRule[]>({ url: '/repair-type-rules', query: oid ? { officeId: oid } : {} }),
        request<TechnicianOption[]>({
          url: '/work-orders/technicians',
          query: oid ? { officeId: oid } : { scope: 'company' },
        }).catch(() => [] as TechnicianOption[]),
        // 次数按这个管理处的口径重算（口径开关在这一页顶部）
        request<RepairSuggestions>({
          url: '/repair-suggestions',
          query: oid ? { officeId: oid } : {},
        }).catch(() => null),
      ]);
      setLocalRules(rules);
      setTabTechnicians(techs);
      if (tabSugg) setTabSuggestions(tabSugg);
    } catch (e: any) {
      message.error(e?.message || '加载报修类型失败');
    } finally {
      setRulesLoading(false);
    }
  }, [message]);

  /** 当前编辑类型下，每个关键词被真实用了多少次（本处口径 / 全公司各一份） */
  const keywordUsage = editing
    ? tabSuggestions.keywordUsageByType?.[editing.repairType] || {}
    : {};
  const companyKeywordUsage = editing
    ? tabSuggestions.companyKeywordUsageByType?.[editing.repairType] || {}
    : {};
  /** 历史里归纳出来、还没配进关键词的高频短语 */
  const learnedExtras = editing
    ? (tabSuggestions.contentsByType?.[editing.repairType] || []).filter(
        (item) => !keywords.includes(item.text) && !templateWords.includes(item.text),
      )
    : [];

  /**
   * 关键词撞车：同一套里这个词被别的类型占了没有。
   *
   * 判定用的是每条规则的**生效关键词**（已经含继承来的模板词），
   * 所以本处加一个和别人模板词一样的词也会被挡下 —— 那种撞法一样会让判定按排序瞎猜。
   */
  const conflictOf = useCallback(
    (word: string): string | null => {
      const value = word.trim();
      if (!value) return null;
      for (const rule of localRules) {
        if (editing && rule.id === editing.id) continue;
        if (!editing && rule.repairType === form.getFieldValue('repairType')) continue;
        if ((rule.contentSuggestions || []).includes(value)) return rule.label;
      }
      return null;
    },
    [localRules, editing, form],
  );

  /** 包含关系的近似词：不拦，只提醒 —— 真实词库里「漏水」和「厨房漏水」这种交叉到处都是 */
  const similarOf = useCallback(
    (word: string): { word: string; label: string } | null => {
      const value = word.trim();
      if (value.length < 2) return null;
      for (const rule of localRules) {
        if (editing && rule.id === editing.id) continue;
        for (const other of rule.contentSuggestions || []) {
          if (other === value) continue;
          if (other.includes(value) || value.includes(other)) {
            return { word: other, label: rule.label };
          }
        }
      }
      return null;
    },
    [localRules, editing],
  );

  /**
   * 这一套里现存的撞车（别人早就配重了的）。
   * 不能等人一条条保存才发现 —— 那样得挨个点开每个类型才知道哪里出了问题。
   */
  const existingConflicts = useMemo(() => {
    const owner = new Map<string, string>();
    const out: Array<{ word: string; labels: string[] }> = [];
    for (const rule of localRules) {
      for (const word of rule.contentSuggestions || []) {
        const holder = owner.get(word);
        if (holder && holder !== rule.label) {
          const hit = out.find((item) => item.word === word);
          if (hit) { if (!hit.labels.includes(rule.label)) hit.labels.push(rule.label); }
          else out.push({ word, labels: [holder, rule.label] });
        } else if (!holder) {
          owner.set(word, rule.label);
        }
      }
    }
    return out;
  }, [localRules]);

  const startEdit = (rule: RepairTypeRule) => {
    setEditing(rule);
    // 本处增补和模板词分开编辑：模板词只能停用/恢复，删不掉（删了公司层就不知道谁不认它）
    setKeywords(rule.officeId ? rule.extraSuggestions || [] : rule.contentSuggestions || []);
    setTemplateWords(rule.officeId ? rule.templateSuggestions || [] : []);
    setMutedWords(rule.officeId ? rule.mutedSuggestions || [] : []);
    setKeywordDraft('');
    form.setFieldsValue({
      repairType: rule.repairType,
      label: rule.label,
      assigneeIds: rule.assigneeIds?.length ? rule.assigneeIds : rule.assigneeId ? [rule.assigneeId] : [],
      slaHours: rule.slaHours ?? 24,
      enabled: rule.enabled,
    });
  };

  const startCreate = () => {
    setEditing(null);
    setKeywords([]);
    setTemplateWords([]);
    setMutedWords([]);
    setKeywordDraft('');
    form.resetFields();
    form.setFieldsValue({ enabled: true, slaHours: 24 });
  };

  const switchTab = (next: 'company' | number) => {
    setTab(next);
    startCreate();
    loadTab(next);
  };

  /** 本页重新拉一遍，同时让页面里的公司默认（录入表单在用）也刷新 */
  const refresh = () => {
    loadTab(tab);
    onDone();
  };

  const moveKeyword = (index: number, delta: number) => {
    const next = [...keywords];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setKeywords(next);
  };

  const addKeyword = (text: string) => {
    const value = text.trim();
    if (!value) return;
    if (keywords.includes(value)) {
      message.warning('该关键词已存在');
      return;
    }
    // 模板里已经有了：本处不用再加一遍（加了也只是同一个词，白占位置）；
    // 之前把它停用过的话，这一下就是要它回来
    if (templateWords.includes(value)) {
      if (mutedWords.includes(value)) {
        setMutedWords(mutedWords.filter((word) => word !== value));
        setKeywordDraft('');
        message.success(`「${value}」是公司模板词，已在本处恢复启用`);
      } else {
        message.warning(`「${value}」已经在公司模板里，本处不用重复加`);
      }
      return;
    }
    const taken = conflictOf(value);
    if (taken) {
      message.error(
        `「${value}」已经是「${taken}」的关键词。同一个词只能属于一个报修类型 —— ` +
          `两边都留着，系统只会按排序挑一个，判得准不准全看运气。` +
          `请先去「${taken}」里删掉它，或者在这里换个说法。`,
      );
      return;
    }
    if (keywords.length >= MAX_KEYWORDS_PER_TYPE) {
      message.warning(`最多 ${MAX_KEYWORDS_PER_TYPE} 个关键词`);
      return;
    }
    setKeywords([...keywords, value]);
    setKeywordDraft('');
  };

  /** 本处停用 / 恢复一个模板词。停用只影响这个管理处，别处照旧 */
  const toggleMute = (word: string) => {
    setMutedWords(
      mutedWords.includes(word)
        ? mutedWords.filter((item) => item !== word)
        : [...mutedWords, word],
    );
  };

  const sortKeywordsByUsage = () => {
    setKeywords(
      [...keywords].sort((a, b) => (keywordUsage[b] || 0) - (keywordUsage[a] || 0)),
    );
    message.success('已按使用次数从高到低排序，记得点保存');
  };

  /** 改这个管理处的「猜你想输」口径开关，立刻生效并重拉次数 */
  const saveOfficeSettings = async (patch: Partial<Pick<RuleOffice, 'suggestionScope' | 'suggestionFeedback'>>) => {
    if (!officeId) return;
    setSavingOfficeSettings(true);
    try {
      const saved = await request<RuleOffice>({
        method: 'PATCH',
        url: `/repair-type-rules/offices/${officeId}/suggestion-settings`,
        data: patch,
      });
      setOffices((list) => list.map((office) => (office.id === officeId ? { ...office, ...saved } : office)));
      message.success('已保存');
      loadTab(officeId);
    } catch (e: any) {
      message.error(e?.message || '保存失败');
    } finally {
      setSavingOfficeSettings(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    request<RuleOffice[]>({ url: '/repair-type-rules/offices' })
      .then((list) => {
        const next = Array.isArray(list) ? list : [];
        setOffices(next);
        const firstTab: 'company' | number = canUseCompanyScope
          ? 'company'
          : next[0]?.id ?? access?.offices?.[0]?.id ?? 'company';
        setTab(firstTab);
        startCreate();
        loadTab(firstTab);
      })
      .catch(() => {
        const firstTab: 'company' | number = canUseCompanyScope
          ? 'company'
          : access?.offices?.[0]?.id ?? 'company';
        setTab(firstTab);
        startCreate();
        loadTab(firstTab);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const onSave = async () => {
    const v = await form.validateFields();
    setSaving(true);
    try {
      await request({
        method: editing ? 'PATCH' : 'POST',
        url: editing ? `/repair-type-rules/${editing.id}` : '/repair-type-rules',
        data: {
          officeId,
          repairType: v.repairType,
          label: v.label,
          assigneeIds: v.assigneeIds ?? [],
          slaHours: v.slaHours ?? null,
          enabled: v.enabled ?? true,
          // 总公司那一页改的就是模板本身；管理处那一页只提交本处增补和本处停用的模板词，
          // 模板词绝不回传 —— 回传一次就等于把当时的模板抄死在这个管理处
          ...(officeId
            ? { extraSuggestions: keywords, mutedSuggestions: mutedWords }
            : { contentSuggestions: keywords }),
        },
      });
      message.success('报修类型配置已保存');
      refresh();
      startCreate();
    } catch (e: any) {
      message.error(e?.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const onDeleteRule = async (rule: RepairTypeRule) => {
    try {
      await request({ method: 'DELETE', url: `/repair-type-rules/${rule.id}` });
      message.success(`已删除「${rule.label}」`);
      if (editing?.id === rule.id) startCreate();
      refresh();
    } catch (e: any) {
      message.error(e?.message || '删除失败');
    }
  };

  const onDropRule = async (targetId: number) => {
    if (!draggingRuleId || draggingRuleId === targetId) {
      setDraggingRuleId(null);
      return;
    }
    const fromIndex = localRules.findIndex((rule) => rule.id === draggingRuleId);
    const toIndex = localRules.findIndex((rule) => rule.id === targetId);
    if (fromIndex < 0 || toIndex < 0) {
      setDraggingRuleId(null);
      return;
    }
    const before = localRules;
    const next = [...localRules];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);
    setLocalRules(next);
    setDraggingRuleId(null);
    try {
      await request({
        method: 'POST',
        url: '/repair-type-rules/reorder',
        data: { ids: next.map((rule) => rule.id) },
      });
      message.success('显示顺序已保存');
      onDone();
    } catch (e: any) {
      setLocalRules(before);
      message.error(e?.message || '保存顺序失败');
    }
  };

  const DraggableRow = (props: any) => {
    const rowKey = Number(props['data-row-key']);
    return (
      <tr
        {...props}
        draggable
        onDragStart={(event) => {
          setDraggingRuleId(rowKey);
          event.dataTransfer.effectAllowed = 'move';
        }}
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
        }}
        onDrop={(event) => {
          event.preventDefault();
          onDropRule(rowKey);
        }}
        style={{
          ...props.style,
          cursor: 'move',
          opacity: draggingRuleId === rowKey ? 0.55 : 1,
        }}
      />
    );
  };

  const scopeSuffix = (t: TechnicianOption) =>
    t.scope === 'all' ? ' · 全公司' : t.scope === 'office' ? ` · ${officeName || '本管理处'}专属` : '';

  return (
    <Modal
      title={
        <div>
          <div>报修类型与自动分流</div>
          <Text type="secondary" style={{ fontSize: 13, fontWeight: 400 }}>
            先按管理处匹配类型，再决定通知哪些维修工；没有匹配结果的工单进入派单台
          </Text>
        </div>
      }
      open={open}
      onCancel={onClose}
      footer={null}
      width={1380}
      destroyOnHidden
    >
      <Tabs
        activeKey={String(tab)}
        onChange={(key) => switchTab(key === 'company' ? 'company' : Number(key))}
        items={[
          ...(canUseCompanyScope ? [{ key: 'company', label: '总公司' }] : []),
          ...offices.map((o) => ({ key: String(o.id), label: o.name })),
        ]}
        className="pms-repair-rule-tabs"
      />
      <Alert
        type={officeId ? 'info' : 'warning'}
        showIcon
        style={{ marginBottom: 12 }}
        message={officeId ? `当前配置：${officeName}` : '当前配置：总公司初始化模板'}
        description={officeId
          ? '这里保存本管理处实际生效的类型、默认维修工和时限。默认维修工只能选择业务范围覆盖本管理处且有接单权限的人。'
          : '这套配置用于新建管理处时初始化。管理处专属维修工请切换到对应管理处设置；“猜你想输”模板词会持续下发到各管理处。'}
      />

      <div
        style={{
          display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 10,
          marginBottom: 12,
        }}
      >
        {[
          ['1', '识别管理处与类型', '优先使用本处“猜你想输”生效关键词，AI 使用同一份词表辅助判断'],
          ['2', '进入待接或待派', '有默认维修工则通知多人并进工单池；没有则只进派单台'],
          ['3', '接单后才在手', '多人抢单或办公室定向派单，都要维修工确认接单后才进入在手工单'],
        ].map(([step, title, desc]) => (
          <div key={step} style={{ padding: '12px 14px', border: '1px solid #e6edf7', borderRadius: 10, background: '#f7faff' }}>
            <Space align="start" size={10}>
              <Tag color="blue" style={{ marginInlineEnd: 0, borderRadius: 12 }}>{step}</Tag>
              <div>
                <Text strong>{title}</Text>
                <Text type="secondary" style={{ display: 'block', marginTop: 2, fontSize: 12 }}>{desc}</Text>
              </div>
            </Space>
          </div>
        ))}
      </div>

      {officeId && (
        <Collapse
          size="small"
          style={{ marginBottom: 12, background: '#fafafa' }}
          items={[{
            key: 'suggestion-settings',
            label: '识别词库高级设置',
            children: (
              <Space size={24} wrap>
                <Space size={8} wrap>
                  <Text>常用词排序</Text>
                  <Segmented
                    size="small"
                    disabled={!canEdit || savingOfficeSettings}
                    value={offices.find((o) => o.id === officeId)?.suggestionScope ?? 'office_first'}
                    onChange={(value) => saveOfficeSettings({ suggestionScope: value as SuggestionScope })}
                    options={[
                      { label: '本处优先', value: 'office_first' },
                      { label: '全公司', value: 'company' },
                    ]}
                  />
                  <Text type="secondary" style={{ fontSize: 12 }}>本处不足时自动用全公司数据补齐</Text>
                </Space>
                <Space size={8} wrap>
                  <Text>本处高频词进入公司候选池</Text>
                  <Switch
                    size="small"
                    disabled={!canEdit || savingOfficeSettings}
                    checked={offices.find((o) => o.id === officeId)?.suggestionFeedback ?? true}
                    onChange={(checked) => saveOfficeSettings({ suggestionFeedback: checked })}
                  />
                </Space>
              </Space>
            ),
          }]}
        />
      )}

      {existingConflicts.length > 0 && (
        <div
          style={{
            padding: '10px 14px', marginBottom: 12,
            background: '#fffbe6', border: '1px solid #ffe58f', borderRadius: 8,
          }}
        >
          <Text type="warning" style={{ display: 'block' }}>
            <WarningOutlined /> 这一套里有 {existingConflicts.length} 个词被多个类型同时占用，
            判定时只会按显示顺序挑一个 —— 请在其中一个类型里删掉它：
          </Text>
          <Space size={[6, 6]} wrap style={{ marginTop: 6 }}>
            {existingConflicts.map((item) => (
              <Tag key={item.word} color="warning" style={{ marginInlineEnd: 0 }}>
                {item.word}：{item.labels.join(' / ')}
              </Tag>
            ))}
          </Space>
        </div>
      )}
      <Row gutter={20}>
        <Col xs={24} lg={15}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <div>
              <Title level={5} style={{ margin: 0 }}>类型列表</Title>
              <Text type="secondary">拖动行可调整录入页面的显示顺序</Text>
            </div>
            <Button type="primary" icon={<PlusOutlined />} disabled={!canEdit} onClick={startCreate}>
              新增类型
            </Button>
          </div>
          <Table
            rowKey="id"
            size="middle"
            style={{ marginTop: 10 }}
            loading={rulesLoading}
            dataSource={localRules}
            pagination={false}
            components={{ body: { row: DraggableRow } }}
            locale={{ emptyText: officeId ? '这个管理处还没有报修类型（总公司那一套也是空的）' : '还没有报修类型，点右侧「新增」' }}
            columns={[
              {
                title: '',
                width: 42,
                render: () => <HolderOutlined style={{ color: '#999', fontSize: 18 }} />,
              },
              {
                // 编码不单独占一列，跟名称叠在一起，右侧关键词编辑器才有足够宽度
                title: '报修类型',
                dataIndex: 'label',
                width: 200,
                render: (label: string, rule) => (
                  <div>
                    <div>{label}</div>
                    <Text type="secondary" style={{ fontSize: 12 }}>{rule.repairType}</Text>
                  </div>
                ),
              },
              {
                title: '默认维修工',
                dataIndex: 'assigneeIds',
                width: 210,
                render: (_: unknown, rule) => {
                  const ids = rule.assigneeIds?.length ? rule.assigneeIds : rule.assigneeId ? [rule.assigneeId] : [];
                  return ids.length
                    ? ids.map((id) => technicianName(id)).join('、')
                    : <Tag color="orange">未设置 · 进入派单台</Tag>;
                },
              },
              {
                title: '识别词',
                width: 90,
                render: (_, rule) => (
                  <Text>{(rule.contentSuggestions || []).length} 个</Text>
                ),
              },
              { title: '完成时限', dataIndex: 'slaHours', width: 100, render: (v) => v ? `${v}小时` : '-' },
              { title: '状态', dataIndex: 'enabled', width: 80, render: (v) => v ? <Tag color="green">启用</Tag> : <Tag>停用</Tag> },
              {
                title: '操作',
                width: 140,
                render: (_, rule) => (
                  <Space size={0}>
                    <Button type="link" disabled={!canEdit} onClick={() => startEdit(rule)}>编辑</Button>
                    {canDelete && (
                      <Popconfirm
                        title="删除该报修类型？"
                        description="删除后新报修不再显示该类型，历史工单不受影响。"
                        okText="删除"
                        okButtonProps={{ danger: true }}
                        cancelText="取消"
                        onConfirm={() => onDeleteRule(rule)}
                      >
                        <Button type="link" danger icon={<DeleteOutlined />}>删除</Button>
                      </Popconfirm>
                    )}
                  </Space>
                ),
              },
            ]}
          />
        </Col>
        <Col xs={24} lg={9}>
          <Card
            title={editing ? `编辑：${editing.label}` : '新增报修类型'}
            extra={<Tag color={editing ? 'blue' : 'green'}>{officeId ? officeName : '总公司模板'}</Tag>}
          >
            <Form form={form} layout="vertical" size="large" disabled={!canEdit}>
              <Title level={5} style={{ marginTop: 0 }}>基本信息</Title>
              <Row gutter={12}>
                <Col span={14}>
                  <Form.Item name="label" label="显示名称" rules={[{ required: true }]}>
                    <Input placeholder="如：智能化相关" />
                  </Form.Item>
                </Col>
                <Col span={10}>
                  <Form.Item
                    name="repairType"
                    label="类型编码"
                    rules={[
                      { required: true },
                      { pattern: /^[a-zA-Z0-9_-]+$/, message: '仅支持字母、数字、下划线、短横线' },
                    ]}
                  >
                    <Input placeholder="如：smart" />
                  </Form.Item>
                </Col>
              </Row>

              <Divider style={{ margin: '2px 0 16px' }} />
              <Title level={5} style={{ marginTop: 0 }}>工单分流</Title>
              <Form.Item
                name="assigneeIds"
                label="默认维修工（可多选）"
                extra={officeId
                  ? '只列范围覆盖本管理处的人；想让某位维修工出现在这里，去「业务角色」把他的角色范围勾上本管理处'
                  : '只列全公司范围的人；管理处专属维修工请到对应管理处那一页去设'}
              >
                <Select
                  mode="multiple"
                  allowClear
                  placeholder="不选则只进待派单，由办公室派"
                  notFoundContent={<Text type="secondary">没有符合范围的维修工</Text>}
                  options={withOptionTitles(tabTechnicians.map((t) => ({
                    value: t.id,
                    label: `${t.name || '(未命名)'}${t.phone ? ` · ${t.phone}` : ''}${t.skills?.length ? ' · ' + formatSkillList(t.skills, localRules) : ''}${scopeSuffix(t)}`,
                  })))}
                  {...searchableWideSelectProps}
                />
              </Form.Item>
              <Row gutter={12}>
                <Col span={16}>
                  <Form.Item name="slaHours" label="要求完成时限（小时）">
                    <InputNumber min={1} max={168} placeholder="不填则不限制" style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
                <Col span={8}>
                  <Form.Item name="enabled" label="启用类型" valuePropName="checked">
                    <Switch checkedChildren="启用" unCheckedChildren="停用" />
                  </Form.Item>
                </Col>
              </Row>

              <Divider style={{ margin: '2px 0 16px' }} />
              <Title level={5} style={{ marginTop: 0, marginBottom: 8 }}>识别关键词</Title>
              <Alert
                type="info"
                showIcon
                style={{ marginBottom: 14 }}
                message="这不是只用于快捷输入"
                description="系统会先用这里的生效关键词判断报修类型，再把同一份词表交给 AI；明确命中时以这里的配置为准。"
              />

              <Form.Item
                label={
                  <Space size={8}>
                    <span>猜你想输 关键词</span>
                    <Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>
                      {officeId
                        ? `本处 ${keywords.length}/${MAX_KEYWORDS_PER_TYPE} · 模板 ${templateWords.length - mutedWords.length}`
                        : `${keywords.length}/${MAX_KEYWORDS_PER_TYPE}`}
                    </Text>
                  </Space>
                }
                extra="本处增补词优先于公司模板词；同一个词只能属于一个类型。"
              >
                <KeywordEditor
                  keywords={keywords}
                  template={templateWords}
                  muted={mutedWords}
                  usage={keywordUsage}
                  companyUsage={companyKeywordUsage}
                  scoped={Boolean(officeId) && Boolean(tabSuggestions.officeScoped)}
                  isTemplateTab={!officeId}
                  draft={keywordDraft}
                  learned={learnedExtras}
                  conflictOf={conflictOf}
                  similarOf={similarOf}
                  onDraftChange={setKeywordDraft}
                  onAdd={addKeyword}
                  onRemove={(index) => setKeywords(keywords.filter((_, i) => i !== index))}
                  onMove={moveKeyword}
                  onSortByUsage={sortKeywordsByUsage}
                  onToggleMute={toggleMute}
                />
              </Form.Item>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                {editing && <Button onClick={startCreate}>取消编辑</Button>}
                <Button type="primary" loading={saving} onClick={onSave}>
                  {editing ? '保存修改' : '创建类型'}
                </Button>
              </div>
            </Form>
          </Card>
        </Col>
      </Row>
    </Modal>
  );
}

// ---------------- 撤回 / 维修进度 / 转单 Modal ----------------
/**
 * 撤回弹窗。打开时先问后端「这一次撤回会发生什么」，把退料明细、会驳回的采购申请、
 * 会作废的养护单原样列出来，办公室点确认前就知道后果，不再是一句笼统的「撤回上一步」。
 */
function RollbackWorkOrderModal({
  open, workOrderId, onClose, onDone,
}: {
  open: boolean;
  workOrderId: number | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const { message } = AntdApp.useApp();
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<RollbackPreview | null>(null);

  useEffect(() => {
    if (!open || !workOrderId) return;
    setReason('');
    setPreview(null);
    setLoading(true);
    request<RollbackPreview>({ url: `/work-orders/${workOrderId}/rollback-preview` })
      .then((data) => setPreview(data))
      .catch((e: any) => message.error(e?.message || '撤回预览加载失败'))
      .finally(() => setLoading(false));
  }, [open, workOrderId, message]);

  const submit = async () => {
    if (reason.trim().length < 2) {
      message.warning('请填写撤回原因，至少 2 个字');
      return;
    }
    setSaving(true);
    try {
      const result = await request<{
        rollback?: { targetStatusLabel?: string; returnedQty?: number; returnedMaterials?: unknown[] };
      }>({
        method: 'POST',
        url: `/work-orders/${workOrderId}/rollback`,
        data: { reason: reason.trim() },
      });
      const lines = result?.rollback?.returnedMaterials?.length ?? 0;
      message.success(
        `已撤回到${result?.rollback?.targetStatusLabel ?? preview?.targetStatusLabel ?? '上一节点'}` +
          (lines ? `，${lines} 项材料已退回库存` : ''),
      );
      onDone();
    } catch (e: any) {
      message.error(e?.message || '撤回失败');
    } finally {
      setSaving(false);
    }
  };

  const blocked = !!preview && !preview.allowed;

  return (
    <Modal
      title="撤回上一步"
      open={open}
      onCancel={onClose}
      onOk={submit}
      okText="确认撤回"
      okButtonProps={{ disabled: loading || blocked }}
      confirmLoading={saving}
      destroyOnHidden
      // 退料清单一长，弹窗就比 768 高的屏还高，「确认撤回」被挤到视口外面点不到
      // （1366×768 实测，按钮底边 773 > 768）。居中 + 内容区自己滚，按钮条永远在屏幕里。
      centered
      styles={{ body: { maxHeight: 'calc(100vh - 240px)', overflowY: 'auto' } }}
    >
      <Spin spinning={loading}>
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          {blocked ? (
            <Alert
              type="error"
              showIcon
              message="这张工单现在不能撤回"
              description={preview?.blockedReason || '请联系管理员核对工单轨迹'}
            />
          ) : (
            <Alert
              type="warning"
              showIcon
              message={
                preview
                  ? `将撤回「${preview.actionLabel ?? '上一步'}」，工单恢复到「${preview.targetStatusLabel ?? ''}」`
                  : '正在读取撤回影响…'
              }
              description={
                <Space direction="vertical" size={4} style={{ width: '100%' }}>
                  {preview?.restoreAssigneeName ? (
                    <Text>维修工将恢复为：{preview.restoreAssigneeName}</Text>
                  ) : null}
                  {preview?.willReturnMaterials ? (
                    <>
                      <Text>
                        本次完工扣除的 {preview.materialLines.length} 项材料（共 {preview.materialTotalQty} 件）
                        将退回原仓库，并生成撤回还料流水。
                      </Text>
                      <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                        {preview.materialLines.map((line) => (
                          <li key={line.usageId}>
                            {line.name} ×{line.qty}（{line.warehouseName}）
                          </li>
                        ))}
                      </ul>
                      <Text type="secondary">原完工内容会保留为草稿，重新提交完工时才会再次扣库。</Text>
                    </>
                  ) : null}
                  {preview?.purchaseRequests?.filter((item) => item.willReject).length ? (
                    <Text>
                      采购申请 {preview.purchaseRequests.filter((item) => item.willReject).map((item) => item.requestNo).join('、')} 将同步驳回。
                    </Text>
                  ) : null}
                  {preview?.maintenanceOrder?.willVoid ? <Text>关联的草稿养护单将同步作废。</Text> : null}
                  {preview?.reviewWillReverse ? (
                    <Text>原验收评价将失效（不再计入评分统计），历史记录仍可查看。</Text>
                  ) : null}
                  {preview && !preview.usedSnapshot ? (
                    <Text type="warning">
                      这一步是本次改造前记录的，只能恢复状态；撤回后请核对负责人与时限。
                    </Text>
                  ) : null}
                  <Text type="secondary">
                    原操作不会消失；操作人、撤回前后状态和本次原因都会如实保留在工单进度中。
                  </Text>
                </Space>
              }
            />
          )}
          {blocked ? null : (
            <div>
              <Text strong>撤回原因</Text>
              <Text type="secondary" style={{ display: 'block', margin: '4px 0 8px' }}>
                例如：误点完工，现场还有一项需要处理
              </Text>
              <TextArea
                value={reason}
                maxLength={500}
                showCount
                rows={4}
                autoFocus
                placeholder="请说明为什么撤回，方便后续人员查看"
                onChange={(event) => setReason(event.target.value)}
              />
            </div>
          )}
        </Space>
      </Spin>
    </Modal>
  );
}

function ProgressModal({
  open, workOrderId, onClose, onDone,
}: {
  open: boolean;
  workOrderId: number | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const { message } = AntdApp.useApp();
  const [note, setNote] = useState('');
  const [fileList, setFileList] = useState<UploadFile<UploadResponse>[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setNote('');
      setFileList([]);
    }
  }, [open]);

  const uploadProps = buildAttachmentUploadProps({
    fileList,
    setFileList,
    message,
    maxImages: 6,
    maxVideos: 0,
  });

  const submit = async () => {
    if (fileList.some((file) => file.status === 'uploading')) {
      message.warning('照片还在上传，请稍候');
      return;
    }
    const attachments = fileList
      .map((file) => file.response?.publicUrl || file.url)
      .filter((url): url is string => !!url);
    if (!note.trim() && !attachments.length) {
      message.warning('请填写进度说明或添加现场照片');
      return;
    }
    setSaving(true);
    try {
      await request({
        method: 'POST',
        url: `/work-orders/${workOrderId}/progress`,
        data: { note: note.trim() || undefined, attachments },
      });
      message.success('维修进度已记录');
      onDone();
    } catch (e: any) {
      message.error(e?.message || '保存进度失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title="添加维修进度"
      open={open}
      onCancel={onClose}
      onOk={submit}
      okText="保存进度"
      confirmLoading={saving}
      destroyOnHidden
    >
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Alert type="info" showIcon message="进度会进入工单时间轴，不会改变当前“维修中”状态。" />
        <TextArea
          value={note}
          maxLength={500}
          showCount
          rows={4}
          placeholder="例如：已完成现场排查，确认需更换门口机电源，等待配件送达。"
          onChange={(event) => setNote(event.target.value)}
        />
        <Upload.Dragger {...uploadProps} style={{ ...attachmentDropStyle, minHeight: 112 }}>
          <p className="pms-repair-upload-icon"><UploadOutlined /></p>
          <p>点击或拖入现场照片</p>
          <Text type="secondary">最多 6 张；图片会随这条进度一起保存。</Text>
          <AttachmentUploadPreview
            files={fileList}
            onRemove={(uid) => setFileList((files) => files.filter((file) => file.uid !== uid))}
          />
        </Upload.Dragger>
      </Space>
    </Modal>
  );
}

function TransferWorkOrderModal({
  open, workOrderId, onClose, onDone,
}: {
  open: boolean;
  workOrderId: number | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const { message } = AntdApp.useApp();
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => { if (open) setReason(''); }, [open]);

  const submit = async () => {
    if (reason.trim().length < 2) {
      message.warning('请填写转单原因，方便办公室判断新的工种和人员');
      return;
    }
    setSaving(true);
    try {
      await request({
        method: 'POST',
        url: `/work-orders/${workOrderId}/transfer-request`,
        data: { note: reason.trim() },
      });
      message.success('已退回所属管理处，等待重新分类派单');
      onDone();
    } catch (e: any) {
      message.error(e?.message || '转单失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title="转给其他人维修"
      open={open}
      onCancel={onClose}
      onOk={submit}
      okText="确认退回办公室"
      okButtonProps={{ danger: true }}
      confirmLoading={saving}
      destroyOnHidden
    >
      <Alert
        type="warning"
        showIcon
        message="提交后将清空原工单类型和维修人员"
        description="工单会回到“待派单”，所属管理处办公室收到微信及站内提醒，重新选择类型和该类型的维修工；新维修工收到通知后再到工单池接单。"
        style={{ marginBottom: 16 }}
      />
      <TextArea
        value={reason}
        maxLength={500}
        showCount
        rows={4}
        placeholder="请说明为什么需要转单，例如：现场故障属于弱电门禁，需要智能化维修人员处理。"
        onChange={(event) => setReason(event.target.value)}
      />
    </Modal>
  );
}

// ---------------- 派单 Modal ----------------
function AssignModal({
  open, workOrderId, communityId, technicians, repairTypeRules, currentSkill, onClose, onDone,
}: {
  open: boolean;
  workOrderId: number | null;
  communityId?: number;
  technicians: TechnicianOption[];
  repairTypeRules: RepairTypeRule[];
  currentSkill?: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const [availableTechnicians, setAvailableTechnicians] = useState<TechnicianOption[]>(technicians);
  const selectedSkill = Form.useWatch('skill', form) as string | undefined;
  const selectedAssigneeId = Form.useWatch('assigneeId', form) as number | undefined;
  const selectedRule = repairTypeRules.find((rule) => rule.repairType === selectedSkill);
  const eligibleTechnicians = (selectedSkill
    ? availableTechnicians.filter((technician) =>
        technician.skills?.includes(selectedSkill) || selectedRule?.assigneeIds?.includes(technician.id),
      )
    : availableTechnicians
  ).slice().sort((a, b) => a.openCount - b.openCount || a.id - b.id);
  const selectedTechnician = eligibleTechnicians.find((item) => item.id === selectedAssigneeId);

  useEffect(() => {
    if (!open) return;
    form.resetFields();
    form.setFieldsValue({ skill: currentSkill, slaHours: 24 });
  }, [open, currentSkill, form]);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setAvailableTechnicians(technicians);
    request<TechnicianOption[]>({
      url: '/work-orders/technicians',
      query: communityId ? { communityId } : {},
    })
      .then((items) => { if (!cancelled) setAvailableTechnicians(items); })
      .catch(() => { /* 后端保存时还会再次校验范围；加载失败时保留原列表 */ });
    return () => { cancelled = true; };
  }, [open, communityId, technicians]);

  const onOk = async () => {
    const v = await form.validateFields();
    setSaving(true);
    try {
      await request({
        method: 'POST',
        url: `/work-orders/${workOrderId}/assign`,
        data: { assigneeId: v.assigneeId, skill: v.skill, slaHours: v.slaHours, note: v.note },
      });
      message.success('已派单');
      onDone();
    } catch (e: any) { message.error(e?.message || '派单失败'); } finally { setSaving(false); }
  };

  return (
    <Modal
      className="pms-assign-modal"
      width={720}
      title={(
        <div className="pms-assign-modal__title">
          <strong>指派维修人员</strong>
          <span>先确定工种，系统再筛出该工种可派的人员</span>
        </div>
      )}
      open={open}
      onCancel={onClose}
      onOk={onOk}
      okText={selectedTechnician ? `确认派给${selectedTechnician.name}` : '确认派单'}
      okButtonProps={{ disabled: !selectedSkill || !selectedAssigneeId }}
      confirmLoading={saving}
      destroyOnHidden
    >
      <Form form={form} layout="vertical" className="pms-assign-flow">
        <section className={`pms-assign-step ${selectedSkill ? 'is-complete' : 'is-active'}`}>
          <div className="pms-assign-step__head">
            <span className="pms-assign-step__number">1</span>
            <div>
              <strong>选择维修工种</strong>
              <span>用工种先缩小人员范围</span>
            </div>
            {selectedSkill && <Tag color="success">已选择</Tag>}
          </div>
          <Form.Item
            name="skill"
            rules={[{ required: true, message: '请先选择维修工种' }]}
          >
            <Select
              {...searchableWideSelectProps}
              size="large"
              placeholder="请选择本次应由哪个工种处理"
              options={withOptionTitles(buildRepairTypeSelectOptions(repairTypeRules))}
              onChange={() => form.setFieldValue('assigneeId', undefined)}
            />
          </Form.Item>
        </section>

        <section className={`pms-assign-step ${!selectedSkill ? 'is-locked' : selectedAssigneeId ? 'is-complete' : 'is-active'}`}>
          <div className="pms-assign-step__head">
            <span className="pms-assign-step__number">2</span>
            <div>
              <strong>选择维修人员</strong>
              <span>
                {selectedSkill
                  ? `已筛出 ${eligibleTechnicians.length} 人，在手工单少的优先排列`
                  : '完成第 1 步后才能选人'}
              </span>
            </div>
            {selectedAssigneeId && <Tag color="success">已选择</Tag>}
          </div>
          <Form.Item
            name="assigneeId"
            rules={[{ required: true, message: '请选择维修人员' }]}
          >
            <Select
              size="large"
              placeholder={selectedSkill ? '输入姓名或电话搜索' : '请先选择维修工种'}
              disabled={!selectedSkill}
              notFoundContent={selectedSkill ? '该工种暂未配置可用维修人员' : '请先选择工种'}
              options={withOptionTitles(eligibleTechnicians.map((t) => ({
                value: t.id,
                label: `${t.name || '(未命名)'} · 在手 ${t.openCount} 单${t.phone ? ' · ' + t.phone : ''}${t.skills?.length ? ' · ' + formatSkillList(t.skills, repairTypeRules) : ''}`,
              })))}
              {...searchableWideSelectProps}
            />
          </Form.Item>
          {selectedSkill && !eligibleTechnicians.length && (
            <Alert
              type="warning"
              showIcon
              message="该工种还没有可派人员"
              description="请先在员工资料中配置工种，或在报修类型配置中指定默认维修人员。"
            />
          )}
        </section>

        <section className={`pms-assign-step ${selectedAssigneeId ? 'is-active' : 'is-locked'}`}>
          <div className="pms-assign-step__head">
            <span className="pms-assign-step__number">3</span>
            <div>
              <strong>设置派单要求</strong>
              <span>补充完成时限和现场备注后提交</span>
            </div>
          </div>
          <Row gutter={12}>
            <Col xs={24} md={9}>
              <Form.Item name="slaHours" label="要求完成时限（小时）">
                <InputNumber min={1} max={168} disabled={!selectedAssigneeId} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col xs={24} md={15}>
              <Form.Item name="note" label="派单备注">
                <Input disabled={!selectedAssigneeId} placeholder="如：业主下午在家，优先处理" />
              </Form.Item>
            </Col>
          </Row>
        </section>
      </Form>
    </Modal>
  );
}

// ---------------- 完工 Modal ----------------
function CompleteModal({
  open, workOrderId, detail, onClose, onDone,
}: {
  open: boolean;
  workOrderId: number | null;
  /** 拿来预填故障位置/现象 —— 业主报修时已经说过一遍了 */
  detail: WorkOrderDetail | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const [mode, setMode] = useState<'done' | 'waiting'>('done');
  const [fileList, setFileList] = useState<UploadFile<UploadResponse>[]>([]);
  // 同一次填写复用同一个令牌：连点两下或弱网重试时服务端只认第一次，不会扣两遍库存
  const [idempotencyKey, setIdempotencyKey] = useState('');

  /** 上一次完工被撤回后留下的草稿（材料已退库，重新提交才会再扣） */
  const draft = detail?.completionDraft ?? null;

  useEffect(() => {
    if (!open) return;
    form.resetFields();
    const draftMaterials = (draft?.materials ?? []).filter(
      (item: UsedMaterialLine) => item?.name || item?.materialId,
    );
    form.setFieldsValue({
      // 撤回后原用料清单原样带回来当草稿：让人重填一遍的结果是他随手提交一个空的
      usedMaterials: draftMaterials.length
        ? draftMaterials.map((item: UsedMaterialLine) => ({ ...item }))
        : [{}],
      missingMaterials: [{}],
      // 位置和现象从报修信息带出来，允许改、也允许清空 ——
      // 现场看到的往往和业主说的不一样，但从零开始打字更没人愿意填
      faultLocation:
        draft?.faultLocation ||
        detail?.workOrder.faultLocation ||
        detail?.request?.addressText ||
        undefined,
      faultSymptom:
        draft?.faultSymptom ||
        detail?.workOrder.faultSymptom ||
        detail?.request?.content ||
        undefined,
      repairContent: draft?.repairContent || detail?.workOrder.repairContent || undefined,
      remark: draft?.actionNote || detail?.workOrder.actionNote || undefined,
      feeYuan:
        draft?.feeCents != null
          ? draft.feeCents / 100
          : detail?.workOrder.feeCents
            ? detail.workOrder.feeCents / 100
            : undefined,
    });
    setMode('done');
    // 原完工照片一并带回：不带的话提交时一个空数组就把原来的照片全冲掉了
    const photos = draft?.resultAttachments?.length
      ? draft.resultAttachments
      : detail?.workOrder.resultAttachments ?? [];
    setFileList(
      photos.map((url: string, index: number) => ({
        uid: `kept-${index}`,
        name: url.split('/').pop() || `附件${index + 1}`,
        status: 'done' as const,
        url,
      })),
    );
    setIdempotencyKey(`web-${workOrderId ?? 0}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  }, [open, form, detail, draft, workOrderId]);

  const onOk = async () => {
    const v = await form.validateFields();
    setSaving(true);
    try {
      if (mode === 'waiting') {
        await request({
          method: 'POST',
          url: `/work-orders/${workOrderId}/need-material`,
          data: {
            missingMaterials: (v.missingMaterials || []).filter((item: any) => item?.name && item?.qty),
            note: v.waitingNote,
          },
        });
        message.success('已记录等待材料');
      } else {
        if (fileList.some((file) => file.status === 'uploading')) {
          message.error('还有附件正在上传，请稍后再提交');
          return;
        }
        if (fileList.some((file) => file.status === 'error')) {
          message.error('有附件上传失败，请删除后重传');
          return;
        }
        const resultAttachments = fileList
          .map((file) => file.response?.publicUrl || file.url)
          .filter((url): url is string => !!url);
        await request({
          method: 'POST',
          url: `/work-orders/${workOrderId}/complete`,
          data: {
            faultLocation: v.faultLocation,
            faultSymptom: v.faultSymptom,
            repairContent: v.repairContent,
            actionNote: v.remark,
            feeCents: v.feeYuan != null ? Math.round(v.feeYuan * 100) : undefined,
            resultAttachments,
            materials: (v.usedMaterials || []).filter((item: any) => item?.name && item?.qty),
            idempotencyKey,
          },
        });
        message.success('已完成维修，进入待验收');
      }
      form.resetFields();
      setFileList([]);
      onDone();
    } catch (e: any) { message.error(e?.message || '完工失败'); } finally { setSaving(false); }
  };

  const uploadProps = buildAttachmentUploadProps({ fileList, setFileList, message });

  return (
    <Modal
      className="pms-complete-modal"
      title="维修记录"
      open={open}
      onCancel={onClose}
      onOk={onOk}
      okText={mode === 'done' ? '完成维修' : '记录等待材料'}
      confirmLoading={saving}
      destroyOnHidden
      width={840}
    >
      <Segmented
        block
        value={mode}
        onChange={(value) => setMode(value as 'done' | 'waiting')}
        options={[
          { label: '完成维修', value: 'done' },
          { label: '等待材料', value: 'waiting' },
        ]}
        style={{ marginBottom: 16 }}
      />
      <div className={`pms-form-mode-note is-${mode}`}>
        <strong>{mode === 'done' ? '提交真实维修结果' : '暂时无法完工'}</strong>
        <span>{mode === 'done' ? '重点核对实际位置、故障现象、做了什么、收费和用料。' : '列清缺少的材料，提交后办公室可继续采购和调度。'}</span>
      </div>
      {mode === 'done' && draft ? (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message={draft.notice}
          description={
            draft.reverseReason ? `撤回原因：${draft.reverseReason}` : undefined
          }
        />
      ) : null}
      <Form form={form} layout="vertical" initialValues={{ usedMaterials: [{}], missingMaterials: [{}] }}>
        {mode === 'done' ? (
          <>
            {/* 都不强制必填：现场能写清楚最好，写不出来也不该卡住工单流转。
                位置/现象已按报修信息预填，改一改即可 */}
            <div className="pms-form-section-label"><strong>现场核实</strong><span>以实际到场看到的情况为准</span></div>
            <Row gutter={12}>
              <Col span={12}>
                <Form.Item
                  name="faultLocation"
                  label="实际故障位置"
                  extra="已按报修信息带出，可修改"
                >
                  <Input placeholder="例如：3楼楼梯间灯箱、厨房水槽下方" />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item name="feeYuan" label="收费金额（元）">
                  <InputNumber min={0} step={1} style={{ width: '100%' }} placeholder="不收费就留空" />
                </Form.Item>
              </Col>
            </Row>
            <Form.Item name="faultSymptom" label="故障现象" extra="已按报修信息带出，可修改">
              <TextArea rows={3} placeholder="例如：门禁无法识别，读卡无反应" />
            </Form.Item>
            <Form.Item name="repairContent" label="维修内容（做了什么）">
              <TextArea rows={3} placeholder="例如：更换读卡器接线端子，重新固定并测试通过" />
            </Form.Item>

            <div className="pms-form-section-label"><strong>实际用料</strong><span>用于库存扣减和工单成本统计</span></div>
            <Form.Item label="用料和数量">
              <Form.List name="usedMaterials">
                {(fields, { add, remove }) => (
                  <Space direction="vertical" style={{ width: '100%' }} size={8}>
                    {fields.map((field) => (
                      <Row key={field.key} gutter={8} align="middle">
                        <Col span={12}>
                          <Form.Item name={[field.name, 'name']} noStyle>
                            <Input placeholder="材料名称，例如：门禁读卡器" />
                          </Form.Item>
                        </Col>
                        <Col span={5}>
                          <Form.Item name={[field.name, 'qty']} noStyle>
                            <InputNumber min={0.01} placeholder="数量" style={{ width: '100%' }} />
                          </Form.Item>
                        </Col>
                        <Col span={4}>
                          <Form.Item name={[field.name, 'unit']} noStyle>
                            <Input placeholder="单位" />
                          </Form.Item>
                        </Col>
                        <Col span={3}>
                          <Button danger size="small" onClick={() => remove(field.name)}>删除</Button>
                        </Col>
                      </Row>
                    ))}
                    <Button type="dashed" block onClick={() => add({})}>+ 增加用料</Button>
                  </Space>
                )}
              </Form.List>
            </Form.Item>

            <div className="pms-form-section-label"><strong>完工凭证</strong><span>上传维修后照片并补充需要交代的事项</span></div>
            <Form.Item label="维修照片 / 视频">
              <Upload.Dragger {...uploadProps} style={attachmentDropStyle}>
                <p style={{ marginBottom: 6 }}><UploadOutlined /> 拖拽或点击上传维修照片、视频</p>
                <Text type="secondary">照片最多 {MAX_IMAGE_COUNT} 张，视频最多 {MAX_VIDEO_COUNT} 个；单个不超过 50MB。</Text>
                <AttachmentUploadPreview
                  files={fileList}
                  onRemove={(uid) => setFileList(fileList.filter((file) => file.uid !== uid))}
                />
              </Upload.Dragger>
            </Form.Item>

            <Form.Item name="remark" label="备注">
              <TextArea rows={2} placeholder="可填写业主说明、后续注意事项等" />
            </Form.Item>
          </>
        ) : (
          <>
            <Form.Item label="等待材料明细" required>
              <MissingMaterialsInput />
            </Form.Item>
            <Form.Item name="waitingNote" label="备注">
              <Input placeholder="例如：已确认需采购，预计明天到货" />
            </Form.Item>
            <Text type="secondary">
              提交后工单转「等待材料」并退回工单池，材料到货后重新派单或由维修工自行接回。
            </Text>
          </>
        )}
      </Form>
    </Modal>
  );
}

// ---------------- 缺料 Modal ----------------
function NeedMaterialModal({
  open, workOrderId, onClose, onDone,
}: {
  open: boolean;
  workOrderId: number | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);

  const onOk = async () => {
    const v = await form.validateFields();
    if (!v.missingMaterials?.length) { message.error('请至少填写一项缺料'); return; }
    setSaving(true);
    try {
      await request({
        method: 'POST',
        url: `/work-orders/${workOrderId}/need-material`,
        data: { missingMaterials: v.missingMaterials, note: v.note },
      });
      message.success('已标记缺料，已生成采购申请');
      form.resetFields();
      onDone();
    } catch (e: any) { message.error(e?.message || '操作失败'); } finally { setSaving(false); }
  };

  return (
    <Modal title="标记缺料 / 申请采购" open={open} onCancel={onClose} onOk={onOk} confirmLoading={saving} destroyOnHidden width={720}>
      <Form form={form} layout="vertical" initialValues={{ missingMaterials: [{}] }}>
        <MissingMaterialsInput />
        <Form.Item name="note" label="备注" style={{ marginTop: 12 }}>
          <Input placeholder="如：业主希望明早处理" />
        </Form.Item>
        <Text type="secondary">
          提交后工单转「等待材料」并退回工单池，材料到货后重新派单或由维修工自行接回。
        </Text>
      </Form>
    </Modal>
  );
}

// ---------------- 修改缺料 Modal（办公室补建 SKU 后回来关联） ----------------
function EditMissingMaterialsModal({
  open, workOrderId, rows, onClose, onDone,
}: {
  open: boolean;
  workOrderId: number | null;
  rows: MissingMaterialRow[];
  onClose: () => void;
  onDone: () => void;
}) {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    form.setFieldsValue({
      missingMaterials: rows.length ? rows.map((row) => ({ ...row })) : [{}],
      note: undefined,
    });
  }, [open, rows, form]);

  const onOk = async () => {
    const v = await form.validateFields();
    setSaving(true);
    try {
      await request({
        method: 'POST',
        url: `/work-orders/${workOrderId}/missing-materials`,
        data: { missingMaterials: v.missingMaterials, note: v.note },
      });
      message.success('缺料清单已更新');
      onDone();
    } catch (e: any) { message.error(e?.message || '更新失败'); } finally { setSaving(false); }
  };

  return (
    <Modal
      title="修改缺料清单"
      open={open}
      onCancel={onClose}
      onOk={onOk}
      okText="保存"
      confirmLoading={saving}
      destroyOnHidden
      width={720}
    >
      <Form form={form} layout="vertical">
        <MissingMaterialsInput />
        <Form.Item name="note" label="备注" style={{ marginTop: 12 }}>
          <Input placeholder="如：已在材料库补建 SKU，按 DN50 采购" />
        </Form.Item>
        <Text type="secondary">
          只改工单记录和还没进审批的那张采购申请；已报到经理/采购的申请不会被改动。
        </Text>
      </Form>
    </Modal>
  );
}

// ---------------- 验收 Modal ----------------
function ReviewModal({
  open, workOrderId, onClose, onDone,
}: {
  open: boolean;
  workOrderId: number | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);

  const onOk = async () => {
    const v = await form.validateFields();
    setSaving(true);
    try {
      await request({
        method: 'POST',
        url: `/work-orders/${workOrderId}/review`,
        data: { rating: v.rating, comment: v.comment },
      });
      message.success('已验收');
      form.resetFields();
      onDone();
    } catch (e: any) { message.error(e?.message || '验收失败'); } finally { setSaving(false); }
  };

  return (
    <Modal title="代业主验收" open={open} onCancel={onClose} onOk={onOk} confirmLoading={saving} destroyOnHidden>
      <Form form={form} layout="vertical" initialValues={{ rating: 5 }}>
        <Form.Item name="rating" label="评分" rules={[{ required: true }]}>
          <Rate />
        </Form.Item>
        <Form.Item name="comment" label="留言">
          <TextArea rows={3} placeholder="业主反馈，如：师傅很专业，问题已解决" />
        </Form.Item>
      </Form>
    </Modal>
  );
}
