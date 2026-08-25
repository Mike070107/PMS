import {
  App as AntdApp,
  Button,
  Card,
  Checkbox,
  Col,
  DatePicker,
  Descriptions,
  Drawer,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Rate,
  Row,
  Segmented,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Timeline,
  Typography,
  Upload,
  Image,
  App as _AntdApp,
} from 'antd';
import type { UploadFile, UploadProps } from 'antd/es/upload/interface';
import {
  ClockCircleOutlined,
  SettingOutlined,
  PhoneOutlined,
  PlusOutlined,
  ReloadOutlined,
  ToolOutlined,
  UploadOutlined,
  VideoCameraOutlined,
  HolderOutlined,
  ArrowUpOutlined,
  ArrowDownOutlined,
  DeleteOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import type { ReactNode } from 'react';
import { request } from '../lib/api';
import { auth, useAuth, usePagePerm } from '../lib/auth';
import { searchableWideSelectProps, withOptionTitles } from '../lib/selectProps';
import type {
  AddressCommunity,
  RepairTypeWarehouseOptions,
  RepairTypeWarehouseView,
  WarehouseView,
} from '@pms/shared-types';
import HouseAddressPicker, {
  UNKNOWN_HOUSE_VALUE,
  type PickedAddress,
} from '../components/HouseAddressPicker';
import MissingMaterialsInput, {
  type MissingMaterialRow,
} from '../components/MissingMaterialsInput';
import {
  DEFAULT_CONTENT_SUGGESTIONS,
  DEFAULT_LOCATION_SUGGESTIONS,
  formatDateTimeCn,
  formatDuration,
  stayDays,
  stayTone,
  UserRole,
  WorkOrderStatus,
} from '@pms/shared-types';

const { Title, Text } = Typography;
const { TextArea } = Input;

interface Community { id: number; name: string }
/** 领料仓库下拉用（只用到 id/名称/启用），沿用库存模块的返回结构 */
type Warehouse = WarehouseView;
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
  repairType?: string | null;
  summaryAddress?: string | null;
  summaryContent?: string | null;
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
  attachments: string[];
}
interface WorkOrderLog {
  id: number;
  fromStatus: WorkOrderStatus | null;
  toStatus: WorkOrderStatus;
  action: string;
  operatorId: number | null;
  note: string | null;
  createdAt: string;
}
interface WorkOrderDetail {
  workOrder: WorkOrderRow;
  request: RepairRequestDetail;
  logs: WorkOrderLog[];
}
interface RepairTypeRule {
  id: number;
  repairType: string;
  label: string;
  assigneeId: number | null;
  slaHours: number | null;
  sortOrder: number;
  enabled: boolean;
  /** 「猜你想输」常用词，按数组顺序展示，后台可编辑/调序 */
  contentSuggestions: string[];
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
  /** 已配置关键词的真实使用次数：repairType -> 关键词 -> 次数 */
  keywordUsageByType: Record<string, Record<string, number>>;
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
  created: { label: '待派单', color: 'default' },
  dispatched: { label: '已派单', color: 'processing' },
  in_progress: { label: '维修中', color: 'blue' },
  waiting_material: { label: '等待材料', color: 'orange' },
  done_pending_review: { label: '待业主验收', color: 'purple' },
  completed: { label: '已完成', color: 'success' },
  cancelled: { label: '已撤单', color: 'error' },
};

/** 距要求完成截止不足这个数就标红（含已超时） */
const SLA_WARN_MS = 4 * 60 * 60 * 1000;

/**
 * 要不要把这单标红：设了截止时间、还没完结，且距截止不足 4 小时或已超时。
 * 已完结的单不标 —— 完结了再喊「超时」只会把整个列表染红。
 */
function slaDanger(r: { slaDueAt?: string | null; status: WorkOrderStatus }): boolean {
  if (!r.slaDueAt) return false;
  if (r.status === WorkOrderStatus.COMPLETED || r.status === WorkOrderStatus.CANCELLED) return false;
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
const WORK_ORDER_SPLIT_WIDTH_KEY = 'pms.workOrders.submitPanelWidth';
const DEFAULT_SUBMIT_PANEL_WIDTH = 560;
const MIN_SUBMIT_PANEL_WIDTH = 420;
const WORK_ORDER_TABLE_WIDTH = 1040;
const MIN_ORDER_POOL_WIDTH = WORK_ORDER_TABLE_WIDTH;

const FILTER_TABS: Array<{ label: string; value: 'all' | WorkOrderStatus }> = [
  { label: '全部', value: 'all' },
  { label: '待派单', value: WorkOrderStatus.CREATED },
  { label: '已派单', value: WorkOrderStatus.DISPATCHED },
  { label: '维修中', value: WorkOrderStatus.IN_PROGRESS },
  { label: '等待材料', value: WorkOrderStatus.WAITING_MATERIAL },
  { label: '待验收', value: WorkOrderStatus.DONE_PENDING_REVIEW },
  { label: '已完成', value: WorkOrderStatus.COMPLETED },
];

/** 从业主提交那一刻算起的自然日跨天数，和两个小程序同一套口径 */
function stayDaysOf(row: { createdAt?: string; completedAt?: string | null }) {
  if (!row.createdAt) return 0;
  const end = row.completedAt ? new Date(row.completedAt) : new Date();
  return stayDays(row.createdAt, Number.isNaN(end.getTime()) ? new Date() : end);
}

/**
 * 状态看板：每个环节积压多少，点一下就筛。
 * 取代原来的七格分段控件 —— 那个控件把「筛选器」和「统计」挤在同一行小字里，
 * 结果两件事都看不清。
 */
function StatusBoard({
  value,
  counts,
  onChange,
}: {
  value: 'all' | WorkOrderStatus;
  counts: WorkOrderStats;
  onChange: (next: 'all' | WorkOrderStatus) => void;
}) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${FILTER_TABS.length}, minmax(0, 1fr))`,
        gap: 8,
        marginBottom: 16,
      }}
    >
      {FILTER_TABS.map((tab) => {
        const active = value === tab.value;
        const count = tab.value === 'all'
          ? counts.total
          : counts.byStatus[tab.value as WorkOrderStatus] || 0;
        // 需要人动手的环节（待派单/等待材料）有积压时标红，扫一眼就知道该先处理哪一堆
        const urgent =
          !active &&
          count > 0 &&
          (tab.value === WorkOrderStatus.CREATED || tab.value === WorkOrderStatus.WAITING_MATERIAL);
        return (
          <div
            key={tab.value}
            role="button"
            tabIndex={0}
            onClick={() => onChange(tab.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onChange(tab.value); }}
            style={{
              cursor: 'pointer',
              padding: '12px 14px',
              borderRadius: 8,
              border: `1px solid ${active ? '#1677ff' : '#f0f0f0'}`,
              background: active ? '#e6f0ff' : '#fafafa',
              transition: 'background 200ms ease, border-color 200ms ease',
            }}
          >
            <div style={{ fontSize: 13, color: active ? '#1677ff' : 'rgba(0,0,0,.65)' }}>{tab.label}</div>
            <div
              style={{
                fontSize: 24,
                fontWeight: 600,
                lineHeight: 1.2,
                fontVariantNumeric: 'tabular-nums',
                color: active ? '#1677ff' : urgent ? '#ff4d4f' : 'rgba(0,0,0,.88)',
              }}
            >
              {count}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function splitWidthStorageKey(userId?: string | number | null) {
  return userId ? `${WORK_ORDER_SPLIT_WIDTH_KEY}.${userId}` : WORK_ORDER_SPLIT_WIDTH_KEY;
}

function readSavedSubmitPanelWidth(userId?: string | number | null) {
  const raw = localStorage.getItem(splitWidthStorageKey(userId));
  const parsed = raw ? Number(raw) : DEFAULT_SUBMIT_PANEL_WIDTH;
  return Number.isFinite(parsed)
    ? clamp(parsed, MIN_SUBMIT_PANEL_WIDTH, 1200)
    : DEFAULT_SUBMIT_PANEL_WIDTH;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
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

function formatSkillList(skills: string[] | undefined, rules: RepairTypeRule[] = []) {
  return skills?.length
    ? skills.map((item) => getRepairTypeLabel(item, rules)).join('、')
    : '';
}

export default function WorkOrdersPage() {
  const { message } = AntdApp.useApp();
  const { user } = useAuth();
  const { canEdit } = usePagePerm('work-orders');
  const [communities, setCommunities] = useState<Community[]>([]);
  const [addressTree, setAddressTree] = useState<AddressCommunity[]>([]);
  const [addressLoading, setAddressLoading] = useState(false);
  const [staffList, setStaffList] = useState<Staff[]>([]);
  const [repairTypeRules, setRepairTypeRules] = useState<RepairTypeRule[]>([]);
  const [repairSuggestions, setRepairSuggestions] = useState<RepairSuggestions>({ locations: [], contents: [], contentsByType: {}, keywordUsageByType: {} });
  const [rows, setRows] = useState<WorkOrderRow[]>([]);
  const [statusCounts, setStatusCounts] = useState<WorkOrderStats>({ total: 0, byStatus: {} });
  const [historyRows, setHistoryRows] = useState<RepairHistoryRow[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyTitle, setHistoryTitle] = useState('');
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<'all' | WorkOrderStatus>('all');
  const [filterCommunity, setFilterCommunity] = useState<number | undefined>();
  const [detailId, setDetailId] = useState<number | null>(null);
  const [ruleOpen, setRuleOpen] = useState(false);
  const [submitPanelWidth, setSubmitPanelWidth] = useState(() => readSavedSubmitPanelWidth(user?.id));
  const skipNextWidthSaveRef = useRef(false);
  const isAdmin = user?.role === UserRole.ADMIN || user?.role === UserRole.SUPERADMIN;

  const staffById = useMemo(() => {
    const m = new Map<number, Staff>();
    staffList.forEach((s) => m.set(s.id, s));
    return m;
  }, [staffList]);

  const loadCommunities = useCallback(async () => {
    try {
      const list = await request<Community[]>({ url: '/communities' });
      setCommunities(list);
    } catch (e: any) {
      message.error(e?.message || '加载小区失败');
    }
  }, [message]);

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
      const list = await request<Staff[]>({ url: '/staff' });
      setStaffList(list);
    } catch (e: any) {
      // 静默：可能此账号无权访问，工单仍可看
      console.warn(e);
    }
  }, []);

  const loadRepairTypeRules = useCallback(async () => {
    try {
      setRepairTypeRules(await request<RepairTypeRule[]>({ url: '/repair-type-rules' }));
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
      if (filterCommunity) query.communityId = filterCommunity;
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
  }, [filter, filterCommunity, message]);

  const loadOrderStats = useCallback(async () => {
    try {
      const query: any = {};
      if (filterCommunity) query.communityId = filterCommunity;
      setStatusCounts(await request<WorkOrderStats>({ url: '/work-orders/stats', query }));
    } catch (e: any) {
      message.error(e?.message || '加载工单统计失败');
    }
  }, [filterCommunity, message]);

  const loadBuildingHistory = useCallback(async (buildingId?: number, title?: string) => {
    if (!buildingId) {
      setHistoryRows([]);
      setHistoryTitle('');
      return;
    }
    setHistoryTitle(title || '同楼栋历史报修');
    setHistoryLoading(true);
    try {
      setHistoryRows(await request<RepairHistoryRow[]>({
        url: '/repair-history',
        query: { buildingId },
      }));
    } catch (e: any) {
      message.error(e?.message || '加载历史报修失败');
    } finally {
      setHistoryLoading(false);
    }
  }, [message]);

  useEffect(() => {
    loadCommunities();
    loadAddressTree();
    loadStaff();
    loadRepairTypeRules();
    loadRepairSuggestions();
  }, [loadAddressTree, loadCommunities, loadRepairSuggestions, loadRepairTypeRules, loadStaff]);
  useEffect(() => { loadOrders(); }, [loadOrders]);
  useEffect(() => { loadOrderStats(); }, [loadOrderStats]);
  useEffect(() => {
    skipNextWidthSaveRef.current = true;
    setSubmitPanelWidth(readSavedSubmitPanelWidth(user?.id));
  }, [user?.id]);
  useEffect(() => {
    if (skipNextWidthSaveRef.current) {
      skipNextWidthSaveRef.current = false;
      return;
    }
    localStorage.setItem(splitWidthStorageKey(user?.id), String(Math.round(submitPanelWidth)));
  }, [submitPanelWidth, user?.id]);

  const startResize = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = submitPanelWidth;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMove = (moveEvent: MouseEvent) => {
      const availableWidth = Math.max(960, window.innerWidth - 280);
      const maxWidth = Math.max(MIN_SUBMIT_PANEL_WIDTH, availableWidth - MIN_ORDER_POOL_WIDTH);
      const nextWidth = clamp(startWidth + moveEvent.clientX - startX, MIN_SUBMIT_PANEL_WIDTH, maxWidth);
      setSubmitPanelWidth(nextWidth);
    };

    const onUp = (upEvent: MouseEvent) => {
      const availableWidth = Math.max(960, window.innerWidth - 280);
      const maxWidth = Math.max(MIN_SUBMIT_PANEL_WIDTH, availableWidth - MIN_ORDER_POOL_WIDTH);
      const nextWidth = clamp(startWidth + upEvent.clientX - startX, MIN_SUBMIT_PANEL_WIDTH, maxWidth);
      setSubmitPanelWidth(nextWidth);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  return (
    <div style={{ fontSize: 16 }}>
      <Title level={3} style={{ marginTop: 0, marginBottom: 20 }}>报修与工单</Title>
      <div
        className="pms-workorder-layout"
        style={{
          display: 'grid',
          gridTemplateColumns: `${submitPanelWidth}px 12px minmax(${MIN_ORDER_POOL_WIDTH}px, 1fr)`,
          gap: 0,
          alignItems: 'start',
          overflowX: 'auto',
          paddingBottom: 4,
        }}
      >
        <div className="pms-workorder-submit" style={{ minWidth: 0 }}>
          <RepairSubmitCard
            addressTree={addressTree}
            addressLoading={addressLoading}
            repairTypeRules={repairTypeRules}
            suggestions={repairSuggestions}
            canManageRepairTypes={isAdmin && canEdit}
            onManageRepairTypes={() => setRuleOpen(true)}
            onLocationPicked={loadBuildingHistory}
            onSubmitted={() => { loadOrders(); loadOrderStats(); loadRepairSuggestions(); }}
          />
        </div>
        <div
          className="pms-workorder-resizer"
          role="separator"
          aria-label="拖动调整报修录入和工单池宽度"
          onMouseDown={startResize}
          title="拖动调整左右宽度"
          style={{
            width: 12,
            minHeight: 520,
            cursor: 'col-resize',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <div
            style={{
              width: 4,
              height: 72,
              borderRadius: 999,
              background: '#d9d9d9',
              boxShadow: 'inset 0 0 0 1px rgba(0,0,0,.04)',
            }}
          />
        </div>
        <div className="pms-workorder-pool" style={{ minWidth: MIN_ORDER_POOL_WIDTH }}>
          <RepairHistoryCard
            title={historyTitle}
            rows={historyRows}
            loading={historyLoading}
            repairTypeRules={repairTypeRules}
            onOpenWorkOrder={(id) => setDetailId(id)}
          />
          <Card
            className="pms-workorder-pool-card"
            title={<span><ToolOutlined /> 工单池</span>}
            style={{ minWidth: WORK_ORDER_TABLE_WIDTH }}
            extra={
              <Space>
                <Select
                  size="large"
                  allowClear
                  placeholder="按小区筛选"
                  style={{ width: 220 }}
                  value={filterCommunity}
                  onChange={(v) => setFilterCommunity(v)}
                  options={withOptionTitles(communities.map((c) => ({ value: c.id, label: c.name })))}
                  {...searchableWideSelectProps}
                />
                <Button size="large" icon={<ReloadOutlined />} onClick={() => { loadOrders(); loadOrderStats(); }}>刷新</Button>
              </Space>
            }
            styles={{ body: { paddingTop: 16 } }}
          >
            {/* 状态看板兼筛选器：积压在哪一环，进页面第一眼就该看见，
                而不是先读一条七格的分段控件再去数角标 */}
            <StatusBoard
              value={filter}
              counts={statusCounts}
              onChange={(next) => setFilter(next)}
            />
            <Table
              rowKey="id"
              size="large"
              loading={loading}
              dataSource={rows}
              tableLayout="fixed"
              // 不设 scroll.x：列宽合计小于容器时 antd 也会挂一条横向滚动条出来，
              // 表格底下永远飘着一根没用的灰条，看着就是「乱」
              pagination={{ pageSize: 10, showSizeChanger: false }}
              // 距要求完成截止不足 4 小时（含已超时）的未完结单整行标红，样式在 styles.css
              rowClassName={(r) => (slaDanger(r) ? 'pms-row-sla-danger' : '')}
              onRow={(r) => ({ onClick: () => setDetailId(r.id), style: { cursor: 'pointer' } })}
              columns={[
                {
                  // 一格一件事，但列数要跟容器宽度量力而行 —— 这块表格在右侧分栏里只有
                  // 八百来像素，硬拆成七八列会被 tableLayout:fixed 压成每列一百出头，
                  // 每格都换行，比原来更乱。所以：
                  //   · 单号是定长标识，独立成列（原来它挤在第一格当第三行小字）
                  //   · 第一格只留两级字号：类型 · 房号（主）/ 业主原话（次），不再有第三、第四种
                  title: '报修内容',
                  key: 'summary',
                  render: (_, r) => (
                    <div>
                      <div style={{ fontWeight: 600, fontSize: 15, lineHeight: 1.5 }}>
                        {getRepairTypeLabel(r.repairType || r.skill, repairTypeRules)}
                        <Text type="secondary" style={{ fontWeight: 400, marginLeft: 8 }}>
                          {r.summaryAddress || '未填写房号'}
                        </Text>
                      </div>
                      <Text
                        type="secondary"
                        style={{ display: 'block', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
                        title={r.summaryContent || undefined}
                      >
                        {r.summaryContent || '-'}
                      </Text>
                      {/* 标红光有底色不够，得让人知道红在哪：把截止时间和倒计时写出来 */}
                      {slaDanger(r) && r.slaDueAt && (
                        <div style={{ color: '#cf1322', fontSize: 12, marginTop: 2 }}>
                          <ClockCircleOutlined style={{ marginRight: 4 }} />
                          要求 {formatDateTimeCn(r.slaDueAt)} 前完成 · {slaCountdownText(r.slaDueAt)}
                        </div>
                      )}
                    </div>
                  ),
                },
                {
                  title: '工单编号', dataIndex: 'orderNo', width: 180,
                  render: (v: string) => (
                    <Text type="secondary" style={{ fontVariantNumeric: 'tabular-nums' }}>{v}</Text>
                  ),
                },
                {
                  title: '状态', dataIndex: 'status', width: 100,
                  render: (s: WorkOrderStatus) => (
                    <Tag color={statusMeta[s].color}>{statusMeta[s].label}</Tag>
                  ),
                },
                {
                  // 已停留是催办的唯一依据，必须常驻列表，而不是点进详情才看得到
                  title: '已停留',
                  key: 'stay',
                  width: 90,
                  sorter: (a, b) => stayDaysOf(a) - stayDaysOf(b),
                  render: (_, r) => {
                    const days = stayDaysOf(r);
                    const tone = stayTone(days);
                    return (
                      <Tag color={tone === 'danger' ? 'error' : tone === 'warn' ? 'warning' : 'default'}>
                        {days} 天
                      </Tag>
                    );
                  },
                },
                {
                  title: '维修工', dataIndex: 'assigneeId', width: 100,
                  render: (id: number | null) => id ? (staffById.get(id)?.name || `#${id}`) : <Text type="secondary">未派单</Text>,
                },
                {
                  title: '报修时间', dataIndex: 'createdAt', width: 170,
                  // 和进度时间轴、两个小程序统一：2026/8/9 17:07 周日
                  render: (v: string) => formatDateTimeCn(v) || '-',
                },
              ]}
            />
          </Card>
        </div>
      </div>

      <WorkOrderDetailDrawer
        id={detailId}
        staffList={staffList}
        repairTypeRules={repairTypeRules}
        onClose={() => setDetailId(null)}
        onChanged={() => { loadOrders(); loadOrderStats(); }}
      />
      <RepairTypeRuleModal
        open={ruleOpen}
        rules={repairTypeRules}
        technicians={staffList.filter((s) => s.role === UserRole.TECHNICIAN)}
        suggestions={repairSuggestions}
        communities={communities}
        onClose={() => setRuleOpen(false)}
        onDone={() => { loadRepairTypeRules(); loadRepairSuggestions(); loadOrders(); loadOrderStats(); }}
      />
    </div>
  );
}

function RepairHistoryCard({
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
  if (!title) return null;
  return (
    <Card
      size="small"
      title={<span>同楼栋历史报修 <Text type="secondary" style={{ fontSize: 13 }}>{title}</Text></span>}
      style={{ marginBottom: 12 }}
      styles={{ body: { paddingTop: 10 } }}
    >
      <Table
        rowKey={(r) => String(r.workOrderId || r.requestId)}
        size="small"
        loading={loading}
        dataSource={rows}
        pagination={false}
        tableLayout="fixed"
        locale={{ emptyText: '此楼栋暂无历史报修' }}
        columns={[
          {
            title: '报修摘要',
            key: 'summary',
            width: 260,
            render: (_, r) => (
              <div style={{ maxWidth: 260 }}>
                <div
                  title={r.summaryAddress || undefined}
                  style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
                >
                  {r.summaryAddress || '-'}
                </div>
                <Text
                  type="secondary"
                  title={r.summaryContent || undefined}
                  style={{ display: 'block', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
                >
                  {r.summaryContent || '-'}
                </Text>
              </div>
            ),
          },
          {
            title: '类型',
            dataIndex: 'repairType',
            width: 190,
            render: (v: string | null) => getRepairTypeLabel(v, repairTypeRules),
          },
          {
            title: '状态',
            dataIndex: 'status',
            width: 100,
            render: (s: WorkOrderStatus | null) => s ? <Tag color={statusMeta[s].color}>{statusMeta[s].label}</Tag> : '-',
          },
          {
            title: '时间',
            dataIndex: 'createdAt',
            width: 190,
            render: (v: string) => formatDateTimeCn(v) || '-',
          },
          {
            title: '操作',
            key: 'op',
            width: 70,
            render: (_, r) => r.workOrderId ? (
              <Button type="link" size="small" onClick={() => onOpenWorkOrder(r.workOrderId!)}>
                查看
              </Button>
            ) : '-',
          },
        ]}
      />
    </Card>
  );
}

// ---------------- 报修录入卡片 ----------------
function RepairSubmitCard({
  addressTree, addressLoading, repairTypeRules, suggestions, canManageRepairTypes,
  onManageRepairTypes, onLocationPicked, onSubmitted,
}: {
  addressTree: AddressCommunity[];
  addressLoading: boolean;
  repairTypeRules: RepairTypeRule[];
  suggestions: RepairSuggestions;
  canManageRepairTypes: boolean;
  onManageRepairTypes: () => void;
  onLocationPicked: (buildingId?: number, title?: string) => void;
  onSubmitted: () => void;
}) {
  const { message } = AntdApp.useApp();
  const { canEdit } = usePagePerm('work-orders');
  const [form] = Form.useForm();
  const [fileList, setFileList] = useState<UploadFile<UploadResponse>[]>([]);
  const [saving, setSaving] = useState(false);
  // 「猜你想输」要跟着当前选中的报修类型变，所以得订阅这个字段
  const pickedRepairType: string | undefined = Form.useWatch('repairType', form);
  const pickedRepairTypeLabel = pickedRepairType
    ? getRepairTypeLabel(pickedRepairType, repairTypeRules)
    : '';

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
          addressText: v.spotText,
          attachments,
          // 勾了「要求完成截止日期」才带；没勾走类型规则里的默认时限
          slaDueAt: v.slaEnabled && v.slaDueAt ? v.slaDueAt.toISOString() : undefined,
        },
      });
      message.success('报修已提交，工单已建档');
      form.resetFields();
      setFileList([]);
      onSubmitted();
    } catch (e: any) {
      message.error(e?.message || '提交失败');
    } finally {
      setSaving(false);
    }
  };

  const onAddressPicked = (picked: PickedAddress | null) => {
    if (!picked?.buildingId) {
      onLocationPicked(undefined);
      return;
    }
    onLocationPicked(picked.buildingId, picked.fullText);
    if (picked.ownerName || picked.ownerPhone) {
      form.setFieldsValue({
        contactName: picked.ownerName || undefined,
        contactPhone: picked.ownerPhone || undefined,
      });
    }
  };
  const repairTypeSelectOptions = buildRepairTypeSelectOptions(repairTypeRules);
  const locationSuggestions = mergeSuggestionTexts(
    suggestions.locations.map((item) => item.text),
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
        (suggestions.contentsByType?.[pickedRepairType] || []).map((item) => item.text),
      )
    : mergeSuggestionTexts(
        suggestions.contents.map((item) => item.text),
        DEFAULT_CONTENT_SUGGESTIONS,
      );
  const contentSuggestionTitle = pickedRepairTypeLabel
    ? `${pickedRepairTypeLabel}·猜你想输`
    : '猜你想输';
  const uploadProps = buildAttachmentUploadProps({ fileList, setFileList, message });

  return (
    <Card className="pms-repair-submit-card" title={<span><PhoneOutlined /> 办公室录入报修</span>} styles={{ body: { padding: 24 } }}>
      {/* autoComplete=off + 非地址类字段名，避免 Chrome 把这些框认成地址栏弹出自动填充遮挡下拉 */}
      <Form form={form} layout="vertical" requiredMark="optional" size="large" autoComplete="off">
        <Form.Item
          name="houseRef"
          label="报修人房号"
          rules={[{ required: true, message: '请选择小区/楼栋/室号' }]}
          extra="可直接敲 228/4/201，逐段联想；也可以点开一级级选"
        >
          <HouseAddressPicker communities={addressTree} loading={addressLoading} onPicked={onAddressPicked} />
        </Form.Item>
        <Form.Item name="spotText" label="具体位置">
          <Input placeholder="例如：大门，4楼电梯口，3楼楼梯" autoComplete="off" />
        </Form.Item>
        <SuggestionTags
          items={locationSuggestions}
          onPick={(text) => form.setFieldsValue({ spotText: text })}
        />
        <Row gutter={12}>
          <Col span={12}>
            <Form.Item name="contactName" label="联系人">
              <Input placeholder="业主姓名" autoComplete="off" />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item
              name="contactPhone"
              label="联系电话"
              rules={[
                { pattern: /^1[3-9]\d{9}$/, message: '请填写正确的手机号' },
              ]}
            >
              <Input placeholder="手机号" autoComplete="off" />
            </Form.Item>
          </Col>
        </Row>
        <Form.Item
          name="repairType"
          label={
            <Space size={8}>
              <span>报修类型</span>
              {canManageRepairTypes && (
                <Button type="link" size="small" icon={<SettingOutlined />} onClick={onManageRepairTypes}>
                  配置
                </Button>
              )}
            </Space>
          }
        >
          <Select {...searchableWideSelectProps} placeholder="选择类型" options={withOptionTitles(repairTypeSelectOptions)} allowClear />
        </Form.Item>
        <Form.Item
          label="要求完成截止日期"
          extra="不勾按报修类型的默认时限；距截止不足 4 小时或已超时的工单会在工单池整行标红"
        >
          <Space align="center">
            <Form.Item name="slaEnabled" valuePropName="checked" noStyle>
              <Checkbox>设定</Checkbox>
            </Form.Item>
            <Form.Item noStyle shouldUpdate={(prev, cur) => prev.slaEnabled !== cur.slaEnabled}>
              {({ getFieldValue }) =>
                getFieldValue('slaEnabled') ? (
                  <Form.Item
                    name="slaDueAt"
                    noStyle
                    rules={[{ required: true, message: '请选择截止时间' }]}
                  >
                    <DatePicker
                      showTime={{ format: 'HH:mm' }}
                      format="YYYY-MM-DD HH:mm"
                      placeholder="选择日期时间"
                    />
                  </Form.Item>
                ) : null
              }
            </Form.Item>
          </Space>
        </Form.Item>
        <Form.Item
          name="content"
          label="报修内容"
          rules={[{ required: true, message: '请填写故障描述' }]}
        >
          <TextArea rows={4} placeholder="故障描述，越详细越好" />
        </Form.Item>
        <SuggestionTags
          title={contentSuggestionTitle}
          items={contentSuggestions}
          onPick={(text) => form.setFieldsValue({ content: text })}
        />
        <Form.Item label="上传照片 / 视频">
          <Upload.Dragger {...uploadProps} style={attachmentDropStyle}>
            <p style={{ margin: 0, fontSize: 30, color: '#1677ff' }}><UploadOutlined /></p>
            <p style={{ margin: '10px 0 4px', fontSize: 16 }}>点击上传，或把照片 / 视频拖到这里</p>
            <Text type="secondary">照片最多 {MAX_IMAGE_COUNT} 张，视频最多 {MAX_VIDEO_COUNT} 个；单个不超过 50MB。</Text>
            <AttachmentUploadPreview
              files={fileList}
              onRemove={(uid) => setFileList((list) => list.filter((file) => file.uid !== uid))}
            />
          </Upload.Dragger>
        </Form.Item>
        {canEdit && (
          <Button type="primary" size="large" loading={saving} onClick={onSubmit} block icon={<PlusOutlined />}>
            提交报修
          </Button>
        )}
      </Form>
    </Card>
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

/** 报修类型配置里的「猜你想输」关键词编辑器：增删、上下调序、按使用次数排序 */
function KeywordEditor({
  keywords, usage, draft, learned, onDraftChange, onAdd, onRemove, onMove, onSortByUsage,
}: {
  keywords: string[];
  usage: Record<string, number>;
  draft: string;
  learned: RepairSuggestion[];
  onDraftChange: (value: string) => void;
  onAdd: (text: string) => void;
  onRemove: (index: number) => void;
  onMove: (index: number, delta: number) => void;
  onSortByUsage: () => void;
}) {
  return (
    <div>
      <Space.Compact style={{ width: '100%' }}>
        <Input
          value={draft}
          placeholder="添加关键词，如：水管漏水"
          maxLength={30}
          onChange={(e) => onDraftChange(e.target.value)}
          onPressEnter={(e) => { e.preventDefault(); onAdd(draft); }}
        />
        <Button type="primary" icon={<PlusOutlined />} onClick={() => onAdd(draft)}>添加</Button>
      </Space.Compact>

      <Space size={8} style={{ marginTop: 8 }}>
        <Button size="small" onClick={onSortByUsage} disabled={keywords.length < 2}>
          按使用次数排序
        </Button>
        <Text type="secondary" style={{ fontSize: 12 }}>次数来自历史报修内容归纳</Text>
      </Space>

      {keywords.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="还没有关键词"
          style={{ margin: '12px 0' }}
        />
      ) : (
        <div style={{ marginTop: 12, border: '1px solid #f0f0f0', borderRadius: 8 }}>
          {keywords.map((keyword, index) => (
            <div
              key={keyword}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                minHeight: 44,
                padding: '4px 8px 4px 12px',
                borderBottom: index === keywords.length - 1 ? 'none' : '1px solid #f5f5f5',
              }}
            >
              <Text style={{ flex: 1, minWidth: 0 }} ellipsis={{ tooltip: keyword }}>{keyword}</Text>
              <Text
                type="secondary"
                title={`历史里用过 ${usage[keyword] || 0} 次`}
                style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}
              >
                {usage[keyword] || 0} 次
              </Text>
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

      {learned.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            历史里常被输入、还没加进来的（点一下加入）：
          </Text>
          <Space size={[6, 6]} wrap style={{ marginTop: 6 }}>
            {learned.map((item) => (
              <Tag
                key={item.text}
                color="blue"
                style={{ cursor: 'pointer', marginInlineEnd: 0 }}
                onClick={() => onAdd(item.text)}
              >
                {item.text} · {item.count}
              </Tag>
            ))}
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
    beforeUpload: (file, selectedFiles) => {
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
      return true;
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
  return /^video\//i.test(file.type || '') || /\.(mp4|mov|m4v|webm|avi|mkv)(\?|#|$|\s)/i.test(value);
}

function isUploadImage(file: { type?: string; name?: string; url?: string; response?: UploadResponse }) {
  const value = `${file.type || ''} ${file.name || ''} ${file.url || ''} ${file.response?.publicUrl || ''}`;
  return /^image\//i.test(file.type || '') || /\.(jpg|jpeg|png|gif|webp|bmp|heic)(\?|#|$|\s)/i.test(value);
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

function isVideoUrl(url: string) {
  return /\.(mp4|mov|m4v|webm|avi|mkv)(\?|#|$)/i.test(url);
}

function CompactRepairRecord({ detail }: { detail: WorkOrderDetail }) {
  const wo = detail.workOrder;
  const usedMaterials = wo.usedMaterials?.length
    ? wo.usedMaterials.map((item, index) => (
        <Tag key={`${item.name || item.materialId || index}-${index}`}>
          {item.name || `#${item.materialId}`} x {item.qty}{item.unit || ''}
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
    <div style={{ border: '1px solid #f0f0f0', borderRadius: 6, overflow: 'hidden' }}>
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
      style={{
        display: 'grid',
        gridTemplateColumns: `${REPAIR_RECORD_LABEL_WIDTH}px minmax(0, 1fr)`,
        borderBottom: '1px solid #f0f0f0',
      }}
    >
      <div
        style={{
          background: '#fafafa',
          color: 'rgba(0,0,0,.88)',
          fontWeight: 500,
          padding: '12px 14px',
          whiteSpace: 'nowrap',
          borderRight: '1px solid #f0f0f0',
        }}
      >
        {label}
      </div>
      <div style={{ padding: '12px 14px', minWidth: 0 }}>
        {children}
      </div>
    </div>
  );
}

// ---------------- 工单详情抽屉 ----------------
function WorkOrderDetailDrawer({
  id, staffList, repairTypeRules, onClose, onChanged,
}: {
  id: number | null;
  staffList: Staff[];
  repairTypeRules: RepairTypeRule[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const { message } = AntdApp.useApp();
  const { canEdit } = usePagePerm('work-orders');
  const [detail, setDetail] = useState<WorkOrderDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const [completeOpen, setCompleteOpen] = useState(false);
  const [needMaterialOpen, setNeedMaterialOpen] = useState(false);
  const [editMissingOpen, setEditMissingOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [changeTypeOpen, setChangeTypeOpen] = useState(false);

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
  const technicians = staffList.filter((s) => s.role === UserRole.TECHNICIAN);

  return (
    <>
      <Drawer
        open={!!id}
        title={wo ? `工单 ${wo.orderNo}` : '工单详情'}
        width={760}
        onClose={onClose}
        loading={loading}
        extra={
          status && canEdit && (
            <Space>
              {[WorkOrderStatus.CREATED, WorkOrderStatus.DISPATCHED, WorkOrderStatus.IN_PROGRESS, WorkOrderStatus.WAITING_MATERIAL].includes(status) && (
                <Button type="primary" onClick={() => setAssignOpen(true)}>
                  {status === WorkOrderStatus.CREATED ? '派单' : '改派'}
                </Button>
              )}
              {status === WorkOrderStatus.DISPATCHED && (
                <Button onClick={onAccept}>代接单</Button>
              )}
              {status === WorkOrderStatus.IN_PROGRESS && (
                <Button onClick={() => setNeedMaterialOpen(true)}>标记缺料</Button>
              )}
              {/* 补建 SKU 后回来把维修工手填的那几行关联上，改的是同一张采购申请 */}
              {status === WorkOrderStatus.WAITING_MATERIAL && (
                <Button onClick={() => setEditMissingOpen(true)}>修改缺料</Button>
              )}
              {[WorkOrderStatus.IN_PROGRESS, WorkOrderStatus.WAITING_MATERIAL].includes(status) && (
                <Button type="primary" onClick={() => setCompleteOpen(true)}>完工</Button>
              )}
              {status === WorkOrderStatus.DONE_PENDING_REVIEW && (
                <Button type="primary" onClick={() => setReviewOpen(true)}>验收</Button>
              )}
              {[WorkOrderStatus.CREATED, WorkOrderStatus.DISPATCHED, WorkOrderStatus.IN_PROGRESS, WorkOrderStatus.WAITING_MATERIAL].includes(status) && (
                <Button danger onClick={() => setCancelOpen(true)}>撤单</Button>
              )}
            </Space>
          )
        }
      >
        {!detail ? <Empty /> : (
          <>
            <Descriptions
              size="middle"
              column={2}
              bordered
              labelStyle={compactDescriptionLabelStyle}
              contentStyle={compactDescriptionContentStyle}
              items={[
                { key: 'status', label: '当前状态', children: <Tag color={statusMeta[detail.workOrder.status].color}>{statusMeta[detail.workOrder.status].label}</Tag>, span: 2 },
                {
                  key: 'stay',
                  label: '已停留',
                  // 从业主提交那一刻算起，按自然日跨天数，当天 0 天；
                  // 与有没有接单无关 —— 业主感知到的等待就是从他提交开始的
                  children: (() => {
                    const end = detail.workOrder.completedAt
                      ? new Date(detail.workOrder.completedAt)
                      : new Date();
                    const days = stayDays(detail.workOrder.createdAt, end);
                    const tone = stayTone(days);
                    return (
                      <Tag color={tone === 'danger' ? 'red' : tone === 'warn' ? 'orange' : 'default'}>
                        {days} 天{detail.workOrder.completedAt ? '（已完结）' : ''}
                      </Tag>
                    );
                  })(),
                  span: 2,
                },
                { key: 'phone', label: '联系电话', children: detail.request.contactPhone || '-' },
                {
                  key: 'name',
                  label: '联系人',
                  // 代报时把身份标出来：办公室要知道电话那头不是住户本人，
                  // 需要住户配合（开门、确认损坏情况）时得另找业主
                  children: detail.request.contactName
                    ? detail.request.reporterRoleLabel
                      ? `${detail.request.contactName}（${detail.request.reporterRoleLabel}代报）`
                      : detail.request.contactName
                    : '-',
                },
                {
                  key: 'type',
                  label: '工单类型',
                  children: (
                    <Space size={4}>
                      {getRepairTypeLabel(detail.request.repairType, repairTypeRules)}
                      {/* 判错了在这里更正，还能顺手把关键词学进新类型，下次自动判对 */}
                      {canEdit && (
                        <Button type="link" size="small" style={{ padding: 0 }} onClick={() => setChangeTypeOpen(true)}>
                          更正
                        </Button>
                      )}
                    </Space>
                  ),
                },
                { key: 'skill', label: '工种', children: getRepairTypeLabel(detail.workOrder.skill, repairTypeRules) },
                { key: 'assignee', label: '当前维修工', children: detail.workOrder.assigneeId ? (staffList.find((s) => s.id === detail.workOrder.assigneeId)?.name || `#${detail.workOrder.assigneeId}`) : '未派单' },
                {
                  key: 'sla',
                  label: '要求完成截止日期',
                  children: (
                    <SlaDueEditor
                      workOrderId={detail.workOrder.id}
                      value={detail.workOrder.slaDueAt ?? null}
                      status={detail.workOrder.status}
                      canEdit={canEdit}
                      onChanged={refresh}
                    />
                  ),
                },
                { key: 'fee', label: '费用', children: detail.workOrder.feeCents ? `¥ ${(detail.workOrder.feeCents / 100).toFixed(2)}` : '-' },
                { key: 'content', label: '报修内容', children: detail.request.content, span: 2 },
                // 两个地址分开给：报修地址可能是公区或别人家，
                // 办公室要一眼分清「他家在哪」和「要去修哪」
                { key: 'regAddr', label: '报修人登记地址', children: detail.request.reporterAddressText || '-', span: 2 },
                { key: 'addr', label: '报修地址', children: detail.request.addressText || '-', span: 2 },
                {
                  key: 'attachments',
                  label: '照片 / 视频',
                  children: <AttachmentPreview urls={detail.request.attachments || []} />,
                  span: 2,
                },
              ]}
            />

            <Title level={5} style={{ marginTop: 24 }}>维修记录</Title>
            <CompactRepairRecord detail={detail} />

            <Title level={5} style={{ marginTop: 24 }}>处理进度</Title>
            <Timeline
              items={detail.logs.map((log, index) => ({
                color: log.toStatus === WorkOrderStatus.COMPLETED ? 'green' : 'blue',
                children: (
                  <div>
                    <div>
                      <strong>{actionLabel(log.action)}</strong>
                      <Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>
                        {/* 三端同一个格式：2026/8/9 17:07 周日 */}
                        {formatDateTimeCn(log.createdAt)}
                      </Text>
                      {/* 这一步停了多久：卡在哪个环节、卡了多久，比绝对时间更好用。
                          最后一个节点在工单没完结时算到此刻。 */}
                      {(() => {
                        const next = detail.logs[index + 1];
                        const finished =
                          detail.workOrder.status === WorkOrderStatus.COMPLETED ||
                          detail.workOrder.status === WorkOrderStatus.CANCELLED;
                        const stay = next
                          ? formatDuration(log.createdAt, next.createdAt)
                          : finished
                            ? ''
                            : formatDuration(log.createdAt, null);
                        return stay ? (
                          <Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>
                            · 停留 {stay}
                          </Text>
                        ) : null;
                      })()}
                    </div>
                    <div style={{ fontSize: 12 }}>
                      {log.fromStatus && (
                        <Text type="secondary">
                          {statusMeta[log.fromStatus].label} → {statusMeta[log.toStatus].label}
                        </Text>
                      )}
                      {log.note && <div style={{ marginTop: 4 }}>{log.note}</div>}
                    </div>
                  </div>
                ),
              }))}
            />
          </>
        )}
      </Drawer>

      <AssignModal
        open={assignOpen}
        workOrderId={id}
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
    cancel: '撤单',
    urge_office: '业主催单（提醒办公室）',
    urge_manager: '业主催单（升级经理）',
  };
  return m[a] || a;
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
  const closed = status === WorkOrderStatus.COMPLETED || status === WorkOrderStatus.CANCELLED;
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

  if (!canEdit || closed) {
    return value ? (
      <span style={danger ? { color: '#cf1322' } : undefined}>
        {formatDateTimeCn(value)}
        {danger ? `（${slaCountdownText(value)}）` : ''}
      </span>
    ) : (
      <Text type="secondary">未设置</Text>
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
          showTime={{ format: 'HH:mm' }}
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

function RepairTypeRuleModal({
  open, rules, technicians, suggestions, communities, onClose, onDone,
}: {
  open: boolean;
  rules: RepairTypeRule[];
  technicians: Staff[];
  suggestions: RepairSuggestions;
  communities: Community[];
  onClose: () => void;
  onDone: () => void;
}) {
  const { message } = AntdApp.useApp();
  const { canDelete, canEdit } = usePagePerm('work-orders');
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<RepairTypeRule | null>(null);
  const [localRules, setLocalRules] = useState<RepairTypeRule[]>([]);
  const [draggingRuleId, setDraggingRuleId] = useState<number | null>(null);
  const [keywords, setKeywords] = useState<string[]>([]);
  const [keywordDraft, setKeywordDraft] = useState('');
  /** 领料仓库是按小区配的，所以这一栏得先选小区再看 */
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [typeWarehouses, setTypeWarehouses] = useState<RepairTypeWarehouseView[]>([]);
  const [communityId, setCommunityId] = useState<number | undefined>();
  const [savingWarehouse, setSavingWarehouse] = useState<string | null>(null);

  /** 当前小区下 类型编码 -> 仓库 id */
  const warehouseByType = new Map(
    typeWarehouses
      .filter((row) => row.communityId === communityId)
      .map((row) => [row.repairType, row.warehouseId]),
  );

  const loadWarehouseConfig = async () => {
    try {
      // 仓库列表随对照表一起返回：这个页面不该因为没有库存模块权限就配不了
      const resp = await request<RepairTypeWarehouseOptions>({ url: '/repair-type-warehouses' });
      setWarehouses(resp.warehouses);
      setTypeWarehouses(resp.items);
    } catch (e: any) {
      message.error(e?.message || '加载领料仓库配置失败');
    }
  };

  /**
   * 改一格存一格。整页「记得点保存」在这种矩阵式配置里最容易漏——
   * 9 个类型 × N 个小区，漏存一格维修工那边就是「没配领料仓库」。
   */
  const onPickWarehouse = async (repairType: string, warehouseId: number | null) => {
    if (!communityId) return;
    setSavingWarehouse(repairType);
    try {
      await request({
        method: 'PUT',
        url: '/repair-type-warehouses',
        data: { communityId, repairType, warehouseId: warehouseId ?? null },
      });
      setTypeWarehouses((prev) => {
        const rest = prev.filter(
          (row) => !(row.communityId === communityId && row.repairType === repairType),
        );
        return warehouseId ? [...rest, { communityId, repairType, warehouseId }] : rest;
      });
      message.success(warehouseId ? '领料仓库已保存' : '已清空该类型的领料仓库');
    } catch (e: any) {
      message.error(e?.message || '保存失败');
    } finally {
      setSavingWarehouse(null);
    }
  };

  /** 当前编辑类型下，每个关键词被真实用了多少次 */
  const keywordUsage = editing
    ? suggestions.keywordUsageByType?.[editing.repairType] || {}
    : {};
  /** 历史里归纳出来、还没配进关键词的高频短语 */
  const learnedExtras = editing
    ? (suggestions.contentsByType?.[editing.repairType] || []).filter(
        (item) => !keywords.includes(item.text),
      )
    : [];

  const startEdit = (rule: RepairTypeRule) => {
    setEditing(rule);
    setKeywords(rule.contentSuggestions || []);
    setKeywordDraft('');
    form.setFieldsValue({
      repairType: rule.repairType,
      label: rule.label,
      assigneeId: rule.assigneeId ?? undefined,
      slaHours: rule.slaHours ?? 24,
      enabled: rule.enabled,
    });
  };

  const startCreate = () => {
    setEditing(null);
    setKeywords([]);
    setKeywordDraft('');
    form.resetFields();
    form.setFieldsValue({ enabled: true, slaHours: 24 });
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
    if (keywords.length >= MAX_KEYWORDS_PER_TYPE) {
      message.warning(`最多 ${MAX_KEYWORDS_PER_TYPE} 个关键词`);
      return;
    }
    setKeywords([...keywords, value]);
    setKeywordDraft('');
  };

  const sortKeywordsByUsage = () => {
    setKeywords(
      [...keywords].sort((a, b) => (keywordUsage[b] || 0) - (keywordUsage[a] || 0)),
    );
    message.success('已按使用次数从高到低排序，记得点保存');
  };

  useEffect(() => {
    if (open && !editing) startCreate();
    if (open) loadWarehouseConfig();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (open && communityId === undefined && communities.length) setCommunityId(communities[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, communities]);

  useEffect(() => {
    setLocalRules(rules);
  }, [rules]);

  const onSave = async () => {
    const v = await form.validateFields();
    setSaving(true);
    try {
      await request({
        method: editing ? 'PATCH' : 'POST',
        url: editing ? `/repair-type-rules/${editing.id}` : '/repair-type-rules',
        data: {
          repairType: v.repairType,
          label: v.label,
          assigneeId: v.assigneeId ?? null,
          slaHours: v.slaHours ?? null,
          enabled: v.enabled ?? true,
          contentSuggestions: keywords,
        },
      });
      message.success('报修类型配置已保存');
      onDone();
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
      onDone();
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
      setLocalRules(rules);
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

  return (
    <Modal
      title="报修类型配置"
      open={open}
      onCancel={onClose}
      footer={null}
      width={1360}
      destroyOnHidden
    >
      <Row gutter={20}>
        <Col xs={24} lg={14}>
          <Space wrap style={{ marginBottom: 8 }}>
            <Text type="secondary">领料仓库按小区分别配，先选小区：</Text>
            <Select
              value={communityId}
              onChange={(v) => setCommunityId(v)}
              style={{ minWidth: 220 }}
              placeholder="选择小区"
              options={withOptionTitles(communities.map((c) => ({ value: c.id, label: c.name })))}
              {...searchableWideSelectProps}
            />
          </Space>
          <Text type="secondary" style={{ display: 'block' }}>
            拖动左侧手柄或整行可调整显示顺序。「领料仓库」改一格存一格，不用另外点保存。
          </Text>
          <Table
            rowKey="id"
            size="middle"
            style={{ marginTop: 8 }}
            dataSource={localRules}
            pagination={false}
            scroll={{ x: 882 }}
            components={{ body: { row: DraggableRow } }}
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
                width: 180,
                render: (label: string, rule) => (
                  <div>
                    <div>{label}</div>
                    <Text type="secondary" style={{ fontSize: 12 }}>{rule.repairType}</Text>
                  </div>
                ),
              },
              {
                // 维修工在工单里点「从库存选」，取的就是这一格配的仓
                title: `领料仓库（${communities.find((c) => c.id === communityId)?.name || '未选小区'}）`,
                dataIndex: 'repairType',
                width: 210,
                render: (repairType: string) => (
                  <Select
                    size="small"
                    allowClear
                    disabled={!canEdit || !communityId}
                    loading={savingWarehouse === repairType}
                    style={{ width: '100%' }}
                    placeholder={communityId ? '未配置' : '先选小区'}
                    value={warehouseByType.get(repairType)}
                    onChange={(v) => onPickWarehouse(repairType, v ?? null)}
                    options={withOptionTitles(warehouses.map((w) => ({
                      value: w.id,
                      label: w.name,
                    })))}
                    {...searchableWideSelectProps}
                  />
                ),
              },
              {
                title: '默认维修工',
                dataIndex: 'assigneeId',
                width: 130,
                render: (id: number | null) =>
                  id ? (technicians.find((t) => t.id === id)?.name || `#${id}`) : <Text type="secondary">未设置</Text>,
              },
              { title: '完成时限', dataIndex: 'slaHours', width: 100, render: (v) => v ? `${v}小时` : '-' },
              { title: '状态', dataIndex: 'enabled', width: 80, render: (v) => v ? <Tag color="green">启用</Tag> : <Tag>停用</Tag> },
              {
                title: '操作',
                width: 140,
                // 多了「领料仓库」一列后表格要横滚，编辑/删除不能跟着滚出视野
                fixed: 'right',
                render: (_, rule) => (
                  <Space size={0}>
                    <Button type="link" onClick={() => startEdit(rule)}>编辑</Button>
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
        <Col xs={24} lg={10}>
          <Card title={editing ? `编辑：${editing.label}` : '新增报修类型'}>
            <Form form={form} layout="vertical" size="large">
              <Form.Item name="label" label="显示名称" rules={[{ required: true }]}>
                <Input placeholder="如：水管 / 漏水" />
              </Form.Item>
              <Form.Item
                name="repairType"
                label="类型编码"
                rules={[
                  { required: true },
                  { pattern: /^[a-zA-Z0-9_-]+$/, message: '仅支持字母、数字、下划线、短横线' },
                ]}
              >
                <Input placeholder="如：plumbing" />
              </Form.Item>
              <Form.Item name="assigneeId" label="默认维修工">
                <Select
                  allowClear
                  placeholder="不选则进入待派单"
                  options={withOptionTitles(technicians.map((t) => ({
                    value: t.id,
                    label: `${t.name || '(未命名)'} · ${t.phone || ''}${t.skills?.length ? ' · ' + t.skills.join(',') : ''}`,
                    disabled: t.status !== 'active',
                  })))}
                  {...searchableWideSelectProps}
                />
              </Form.Item>
              <Form.Item name="slaHours" label="要求完成时限（小时）">
                <InputNumber min={1} max={168} style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item name="enabled" label="启用" valuePropName="checked">
                <Switch />
              </Form.Item>

              <Form.Item
                label={
                  <Space size={8}>
                    <span>猜你想输 关键词</span>
                    <Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>
                      {keywords.length}/{MAX_KEYWORDS_PER_TYPE}
                    </Text>
                  </Space>
                }
              >
                <KeywordEditor
                  keywords={keywords}
                  usage={keywordUsage}
                  draft={keywordDraft}
                  learned={learnedExtras}
                  onDraftChange={setKeywordDraft}
                  onAdd={addKeyword}
                  onRemove={(index) => setKeywords(keywords.filter((_, i) => i !== index))}
                  onMove={moveKeyword}
                  onSortByUsage={sortKeywordsByUsage}
                />
              </Form.Item>

              <Space>
                <Button type="primary" loading={saving} onClick={onSave}>保存</Button>
                <Button onClick={startCreate}>新增</Button>
              </Space>
            </Form>
          </Card>
          <Text type="secondary" style={{ display: 'block', marginTop: 12 }}>
            设置默认维修工后，办公室或业主提交该类型报修时，工单会自动进入“已派单”；未设置则进入“待派单”。
            关键词按这里的先后顺序显示在录入页的「猜你想输」。
            「领料仓库」决定维修工在这个小区报这类故障时从哪个仓领料、完工时扣哪个仓的库存；
            没配的类型维修工会看到「未配领料仓库」，只能自己手动挑仓库。
          </Text>
        </Col>
      </Row>
    </Modal>
  );
}

// ---------------- 派单 Modal ----------------
function AssignModal({
  open, workOrderId, technicians, repairTypeRules, currentSkill, onClose, onDone,
}: {
  open: boolean;
  workOrderId: number | null;
  technicians: Staff[];
  repairTypeRules: RepairTypeRule[];
  currentSkill?: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);

  useEffect(() => { if (open) form.setFieldsValue({ skill: currentSkill, slaHours: 24 }); }, [open, currentSkill, form]);

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
    <Modal title="指派维修工" open={open} onCancel={onClose} onOk={onOk} confirmLoading={saving} destroyOnHidden>
      <Form form={form} layout="vertical">
        <Form.Item name="assigneeId" label="维修工" rules={[{ required: true }]}>
          <Select
            placeholder="选择维修工"
            options={withOptionTitles(technicians.map((t) => ({
              value: t.id,
              label: `${t.name || '(未命名)'} · ${t.phone || ''}${t.skills?.length ? ' · ' + formatSkillList(t.skills, repairTypeRules) : ''}`,
              disabled: t.status !== 'active',
            })))}
            {...searchableWideSelectProps}
          />
        </Form.Item>
        <Row gutter={12}>
          <Col span={12}>
            <Form.Item name="skill" label="工种">
              <Select {...searchableWideSelectProps} allowClear options={withOptionTitles(buildRepairTypeSelectOptions(repairTypeRules))} />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="slaHours" label="要求完成时限（小时）">
              <InputNumber min={1} max={168} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
        </Row>
        <Form.Item name="note" label="备注">
          <Input placeholder="如：业主下午在家，优先处理" />
        </Form.Item>
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

  useEffect(() => {
    if (!open) return;
    form.resetFields();
    form.setFieldsValue({
      usedMaterials: [{}],
      missingMaterials: [{}],
      // 位置和现象从报修信息带出来，允许改、也允许清空 ——
      // 现场看到的往往和业主说的不一样，但从零开始打字更没人愿意填
      faultLocation: detail?.workOrder.faultLocation || detail?.request?.addressText || undefined,
      faultSymptom: detail?.workOrder.faultSymptom || detail?.request?.content || undefined,
      repairContent: detail?.workOrder.repairContent || undefined,
      feeYuan: detail?.workOrder.feeCents ? detail.workOrder.feeCents / 100 : undefined,
    });
    setMode('done');
    setFileList([]);
  }, [open, form, detail]);

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
        value={mode}
        onChange={(value) => setMode(value as 'done' | 'waiting')}
        options={[
          { label: '完成维修', value: 'done' },
          { label: '等待材料', value: 'waiting' },
        ]}
        style={{ marginBottom: 16 }}
      />
      <Form form={form} layout="vertical" initialValues={{ usedMaterials: [{}], missingMaterials: [{}] }}>
        {mode === 'done' ? (
          <>
            {/* 都不强制必填：现场能写清楚最好，写不出来也不该卡住工单流转。
                位置/现象已按报修信息预填，改一改即可 */}
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
            <Form.Item name="repairContent" label="维修内容">
              <TextArea rows={3} placeholder="例如：更换读卡器接线端子，重新固定并测试通过" />
            </Form.Item>

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
