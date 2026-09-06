import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams } from 'react-router-dom';
import {
  App as AntdApp,
  Button,
  Card,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Popover,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import {
  DeleteOutlined,
  FileAddOutlined,
  PrinterOutlined,
  ReloadOutlined,
  SaveOutlined,
  SettingOutlined,
} from '@ant-design/icons';
import { formatDateTimeCn, WorkOrderStatus } from '@pms/shared-types';
import { request } from '../lib/api';
import { usePagePerm } from '../lib/auth';
import { printMaintenanceSheets } from '../lib/printSheet';
import { SignaturePad } from '../components/SignaturePad';
import { MaintenanceSheets, sheetCount } from './maintenance/MaintenanceSheet';
import {
  ensureFontLoaded,
  filledText,
  findFont,
  HANDWRITING_FONTS,
  missingForOrder,
  readFontId,
  rememberFontId,
} from './maintenance/handwriting';
import {
  isZeroOffset,
  printOffsetCss,
  readPrintOffset,
  savePrintOffset,
  ZERO_OFFSET,
  type PrintOffset,
} from './maintenance/print-offset';
import {
  FEE_CATEGORY_OPTIONS,
  MAINTENANCE_STATUS_LABELS,
  SHARE_METHOD_OPTIONS,
  centsToYuan,
  materialTotalCents,
  optionText,
  quotaLabor,
  totalFeeCents,
  type MaintenanceItem,
  type MaintenanceListRow,
  type MaintenanceMaterial,
  type MaintenanceOrder,
  type MaintenanceStatus,
  type QuotaItemRow,
  type QuotaParams,
  type SignSlot,
} from './maintenance/types';

const { Title, Text, Paragraph } = Typography;

/** 打印按钮的悬浮说明：按单子走到哪一步说清打出来是什么、会不会归档 */
function printHint(status: MaintenanceStatus | undefined, verb: '打印' | '套打'): string {
  if (!status) return '';
  if (status === 'void') return '已作废的单不能打印';
  if (status === 'pending_print') return `${verb}后确认已打好，自动标记已完成`;
  if (status === 'completed') return `已完成的单再${verb}一份，不改状态`;
  return `签字还没齐：${verb}当前内容，签名栏留空可手签；不会标记完成，手机签完后仍可再${verb}`;
}

const STATUS_COLOR: Record<MaintenanceStatus, string> = {
  filling: 'processing',
  waiting_filler: 'gold',
  waiting_repairer: 'cyan',
  waiting_inspector: 'purple',
  pending_print: 'orange',
  completed: 'success',
  void: 'default',
};

/**
 * 「发到手机签」这一轮的进度。六个状态，界面上一一对应，不让人猜：
 * loading 生成二维码 → waiting 等扫码 → opened 手机已打开 → signed 已签好
 * （expired 过期、error 生成失败各自有出路）
 */
interface PhoneSign {
  slot: SignSlot;
  status: 'loading' | 'waiting' | 'opened' | 'signed' | 'expired' | 'error';
  token?: string;
  /** 可以直接发到微信的一次性签字页地址（与二维码内容相同） */
  linkUrl?: string;
  qrDataUrl?: string;
  /** 毫秒时间戳 */
  expiresAt?: number;
  /** 开二维码之前这一格就有签名 → 提示「重签会覆盖」 */
  hadSignature?: boolean;
  signUrl?: string | null;
  error?: string;
}

/** 签名位 → 单据上的字段名（轮询时看这一格有没有值） */
const SIGN_FIELDS: Record<SignSlot, keyof MaintenanceOrder> = {
  filler: 'fillerSignUrl',
  repairer: 'repairerSignUrl',
  inspector: 'inspectorSignUrl',
  owner: 'ownerSignUrl',
};

const SIGN_SLOT_LABELS: Record<SignSlot, string> = {
  filler: '填单人',
  repairer: '修理人',
  inspector: '查验员',
  owner: '报修人（户）',
};

const DEFAULT_PARAMS: QuotaParams = { laborRateCents: 1750, coefficient: 1.0341 };

/**
 * 上一次填的实体联单号，存在本机 —— 服务端还没有任何单用过号时（第一次用）拿它兜底，
 * 省得每次翻本子看撕到第几张了。服务端一旦有号，以服务端的为准（多台机器共用同一本联单）。
 */
const LAST_PAPER_NO_KEY = 'pms.maintenance.lastPaperNo';

function nextPaperNoFromLocal(): string {
  try {
    const raw = localStorage.getItem(LAST_PAPER_NO_KEY) || '';
    if (!/^\d+$/.test(raw)) return '';
    return String(Number(raw) + 1).padStart(raw.length, '0');
  } catch {
    return '';
  }
}

function rememberPaperNo(value: string | null | undefined) {
  try {
    if (value && /^\d+$/.test(value)) localStorage.setItem(LAST_PAPER_NO_KEY, value);
  } catch {
    // 隐私模式下写不了，无所谓：服务端那份建议才是主力
  }
}

const emptyItem = (): MaintenanceItem => ({
  part: '',
  name: '',
  surveyQty: null,
  actualQty: null,
  actualHours: null,
  measureQty: null,
  quotaCode: '',
  quotaHours: null,
  laborFeeCents: null,
  materialFeeCents: null,
  quality: '',
  note: '',
});

const emptyMaterial = (): MaintenanceMaterial => ({
  name: '',
  spec: '',
  unit: '',
  estQty: null,
  pickQty: null,
  usedQty: null,
  returnQty: null,
  amountCents: null,
  note: '',
});

const isEmptyItem = (item: MaintenanceItem) =>
  !item.part &&
  !item.name &&
  !item.quotaCode &&
  !item.quality &&
  !item.note &&
  [item.surveyQty, item.actualQty, item.actualHours, item.measureQty, item.quotaHours, item.laborFeeCents, item.materialFeeCents].every(
    (v) => v === null || v === undefined,
  );

/**
 * 保存时要不要带上签名字段。
 *
 * **只有刚签完的那一次才带**：签名是各自的接口写的（手机扫码签、查验签名），
 * 电脑上的草稿未必知道最新状态 —— 二维码关掉之后师傅才在手机上签完，
 * 这边草稿里那一格还是空的，普通保存要是把它一起发上去，服务端就把人家刚签的字抹了。
 * 服务端对没传的字段是「保持不变」，所以不带最安全。
 */
function signaturePatch(extra?: Partial<MaintenanceOrder>): Record<string, string> {
  const keys = ['fillerSignUrl', 'repairerSignUrl', 'ownerSignUrl'] as const;
  const patch: Record<string, string> = {};
  for (const key of keys) {
    if (extra && key in extra) patch[key] = (extra[key] as string | null) ?? '';
  }
  return patch;
}

const isEmptyMaterial = (row: MaintenanceMaterial) =>
  !row.name &&
  !row.spec &&
  !row.unit &&
  !row.note &&
  [row.estQty, row.pickQty, row.usedQty, row.returnQty, row.amountCents].every(
    (v) => v === null || v === undefined,
  );

/**
 * 养护单列表页。
 *
 * 入口有两个，都指向同一张单：
 * · 这一页的「从工单开单」
 * · 工单详情里的「填养护单」（带 ?workOrderId= 跳过来，直接开单并打开）
 * 填单人 = 点开单那个人，不给选 —— 纸上那一格签的就是他。
 */
export default function MaintenanceOrdersPage() {
  const { message } = AntdApp.useApp();
  const { canView, canEdit, canDelete } = usePagePerm('maintenance-orders');
  // 查验是单独一格权限（物业经理），和填单分开
  const canInspect = usePagePerm('maintenance-inspect').canView;
  const [params, setParams] = useSearchParams();

  const [rows, setRows] = useState<MaintenanceListRow[]>([]);
  const [loading, setLoading] = useState(false);
  // 默认「进行中」：填单中 + 三方签字中 + 待打印都在。以前默认「填单中」，办公室点了「推送签名」
  // 单子进了待填单人，回到列表就不见了 —— Mike 2026-09-06「手机上能看到，电脑上看不到」
  const [status, setStatus] = useState<'all' | 'active' | MaintenanceStatus>('active');
  const [searchInput, setSearchInput] = useState('');
  const [searchQ, setSearchQ] = useState('');
  const [openId, setOpenId] = useState<number | null>(null);
  const [pickOpen, setPickOpen] = useState(false);
  const [quotaOpen, setQuotaOpen] = useState(false);
  const [quotaItems, setQuotaItems] = useState<QuotaItemRow[]>([]);
  const [quotaParams, setQuotaParams] = useState<QuotaParams>(DEFAULT_PARAMS);

  useEffect(() => {
    const timer = window.setTimeout(() => setSearchQ(searchInput.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await request<MaintenanceListRow[]>({
        url: '/maintenance-orders',
        query: { status: status === 'all' || status === 'active' ? undefined : status, q: searchQ || undefined },
      });
      // “全部”表示全部有效养护单；已删除/作废有独立入口，不应继续混在日常列表中。
      // “进行中”再去掉已完成：日常要盯的就是还没走完的单。
      setRows(
        status === 'all'
          ? list.filter((row) => row.status !== 'void')
          : status === 'active'
            ? list.filter((row) => row.status !== 'void' && row.status !== 'completed')
            : list,
      );
    } catch (e: any) {
      message.error(e?.message || '加载养护单失败');
    } finally {
      setLoading(false);
    }
  }, [message, status, searchQ]);

  const loadQuota = useCallback(async () => {
    try {
      const [items, quota] = await Promise.all([
        request<QuotaItemRow[]>({ url: '/quota-items' }),
        request<QuotaParams>({ url: '/quota-params' }),
      ]);
      setQuotaItems(items);
      setQuotaParams(quota || DEFAULT_PARAMS);
    } catch {
      // 定额配置读不到不影响看单，填单时会提示
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    loadQuota();
  }, [loadQuota]);

  /** 从工单开单：已经开过就直接打开原来那张 */
  const createFromWorkOrder = useCallback(
    async (workOrderId: number) => {
      try {
        const created = await request<MaintenanceOrder>({
          method: 'POST',
          url: '/maintenance-orders',
          data: { workOrderId },
        });
        setPickOpen(false);
        setOpenId(created.id);
        load();
      } catch (e: any) {
        message.error(e?.message || '开单失败');
      }
    },
    [load, message],
  );

  const voidMaintenanceOrder = useCallback(
    async (row: MaintenanceListRow) => {
      try {
        await request({ method: 'DELETE', url: `/maintenance-orders/${row.id}` });
        message.success(`养护单 ${row.paperNo || row.orderNo} 已删除并作废`);
        if (openId === row.id) setOpenId(null);
        await load();
      } catch (e: any) {
        message.error(e?.message || '删除养护单失败');
      }
    },
    [load, message, openId],
  );

  // 工单页点「填养护单」跳过来：?workOrderId=123
  const handledParam = useRef<string | null>(null);
  useEffect(() => {
    const workOrderId = params.get('workOrderId');
    if (!workOrderId || handledParam.current === workOrderId) return;
    handledParam.current = workOrderId;
    const next = new URLSearchParams(params);
    next.delete('workOrderId');
    setParams(next, { replace: true });
    if (!canEdit) {
      message.error('你的角色没有「养护单 · 编辑」权限，开不了单');
      return;
    }
    createFromWorkOrder(Number(workOrderId));
  }, [params, setParams, canEdit, createFromWorkOrder, message]);

  const columns = [
    {
      // 只显示实体联单号 —— 系统号（YH-…）是内部标识，纸上没有，摆在这儿只会和纸对不上
      title: '养护单号',
      key: 'orderNo',
      width: 140,
      render: (_: unknown, r: MaintenanceListRow) =>
        r.paperNo ? (
          <span style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums', fontSize: 16 }}>
            {r.paperNo}
          </span>
        ) : (
          <Text type="secondary">未填单号</Text>
        ),
    },
    {
      title: '报修地址 / 项目',
      key: 'address',
      width: 280,
      render: (_: unknown, r: MaintenanceListRow) => (
        <div>
          <div style={{ fontWeight: 600 }}>{r.addressText || '—'}</div>
          <Text type="secondary">
            {[r.reporterName, r.repairItem].filter(Boolean).join(' · ') || '—'}
          </Text>
        </div>
      ),
    },
    {
      title: '工单编号',
      dataIndex: 'workOrderNo',
      key: 'workOrderNo',
      width: 170,
      render: (v: string | null) => (
        <Text type="secondary" style={{ fontVariantNumeric: 'tabular-nums' }}>
          {v || '—'}
        </Text>
      ),
    },
    {
      title: '填单 / 修理 / 查验',
      key: 'people',
      width: 200,
      render: (_: unknown, r: MaintenanceListRow) => (
        <Text style={{ whiteSpace: 'nowrap' }}>
          {[r.fillerName || '—', r.repairerName || '—', r.inspectorName || '未查验'].join(' / ')}
        </Text>
      ),
    },
    {
      title: '定额工料费',
      dataIndex: 'totalCents',
      key: 'totalCents',
      width: 120,
      align: 'right' as const,
      render: (v: number) => (
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>{centsToYuan(v) || '0.00'}</span>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      // 「待修理人签字」六个字，100 不够；列宽之和要和下面 scroll.x 对上，否则被右侧固定列盖住只剩一个字
      width: 130,
      render: (s: MaintenanceStatus) => (
        <Tag color={STATUS_COLOR[s]}>{MAINTENANCE_STATUS_LABELS[s]}</Tag>
      ),
    },
    {
      title: '开单时间',
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 190,
      render: (v: string) => <span style={{ whiteSpace: 'nowrap' }}>{formatDateTimeCn(v) || '—'}</span>,
    },
    {
      title: '操作',
      key: 'actions',
      width: 170,
      fixed: 'right' as const,
      render: (_: unknown, r: MaintenanceListRow) => (
        <Space size={0} onClick={(event) => event.stopPropagation()}>
          <Button type="link" onClick={() => setOpenId(r.id)}>详情</Button>
          <Tooltip
            title={
              r.status === 'void'
                ? '这张养护单已经作废'
                : canDelete
                  ? '删除后按作废记录保留，可重新从原工单开单'
                  : '请在「业务角色」中授权：养护单 · 删除/作废养护单'
            }
          >
            <span>
              <Popconfirm
                title="删除这张养护单？"
                description="删除后按作废记录保留，原工单可以重新开养护单。"
                okText="确认删除"
                okButtonProps={{ danger: true }}
                disabled={!canDelete || r.status === 'void'}
                onConfirm={() => voidMaintenanceOrder(r)}
              >
                <Button
                  type="link"
                  danger
                  icon={<DeleteOutlined />}
                  disabled={!canDelete || r.status === 'void'}
                >
                  删除
                </Button>
              </Popconfirm>
            </span>
          </Tooltip>
        </Space>
      ),
    },
  ];

  if (!canView) return null;

  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 12,
          marginBottom: 8,
        }}
      >
        <Text className="pms-page-note" type="secondary">《房屋修理养护任务单》：按工单开单、手写签名、查验后打印</Text>
        <Space wrap>
          <Button size="large" icon={<SettingOutlined />} onClick={() => setQuotaOpen(true)}>
            预算定额配置
          </Button>
          <Button size="large" icon={<ReloadOutlined />} onClick={load}>
            刷新
          </Button>
          <Button
            size="large"
            type="primary"
            icon={<FileAddOutlined />}
            disabled={!canEdit}
            onClick={() => setPickOpen(true)}
          >
            从工单开单
          </Button>
        </Space>
      </div>

      <Card
        styles={{ body: { paddingTop: 16 } }}
        title={
          <Space size={16} wrap>
            <Select
              value={status}
              onChange={(v) => setStatus(v as typeof status)}
              size="large"
              style={{ width: 190 }}
              options={[
                { label: '进行中（未完成）', value: 'active' },
                { label: '全部有效', value: 'all' },
                { label: '填单中', value: 'filling' },
                { label: '待填单人', value: 'waiting_filler' },
                { label: '待修理人', value: 'waiting_repairer' },
                { label: '待查验员', value: 'waiting_inspector' },
                { label: '待打印', value: 'pending_print' },
                { label: '已完成', value: 'completed' },
                { label: '已作废', value: 'void' },
              ]}
            />
            <Input.Search
              allowClear
              size="large"
              style={{ width: 320 }}
              placeholder="单号 / 工单号 / 地址 / 报修人"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
            />
          </Space>
        }
      >
        <Table<MaintenanceListRow>
          rowKey="id"
          size="large"
          loading={loading}
          dataSource={rows}
          columns={columns}
          tableLayout="fixed"
          // 列宽合计约 1180：窗口比它窄就横向滚，不让列被压到一个字宽、
          // 把「养护单号」挤成竖排（2026-08-31 反馈）
          // = 各列 width 之和（140+280+170+200+120+130+190+170）；小于它时状态列会被右侧固定的操作列盖住
          scroll={{ x: 1400 }}
          pagination={{ pageSize: 10, showSizeChanger: false }}
          onRow={(r) => ({ onClick: () => setOpenId(r.id), style: { cursor: 'pointer' } })}
          locale={{
            emptyText: (
              <Empty
                description={
                  searchQ ? `没有匹配「${searchQ}」的养护单` : '还没有养护单，点右上角「从工单开单」'
                }
              />
            ),
          }}
        />
      </Card>

      <WorkOrderPicker
        open={pickOpen}
        onClose={() => setPickOpen(false)}
        onPick={(id) => createFromWorkOrder(id)}
      />

      <MaintenanceEditor
        id={openId}
        quotaItems={quotaItems}
        quotaParams={quotaParams}
        canEdit={canEdit}
        canDelete={canDelete}
        canInspect={canInspect}
        onClose={() => setOpenId(null)}
        onChanged={load}
      />

      <QuotaConfigModal
        open={quotaOpen}
        canEdit={canEdit}
        canDelete={canDelete}
        items={quotaItems}
        params={quotaParams}
        onClose={() => setQuotaOpen(false)}
        onChanged={loadQuota}
      />
    </div>
  );
}

// ---------------- 填单 / 打印 ----------------

interface WorkOrderPickRow {
  id: number;
  orderNo: string;
  status: WorkOrderStatus;
  summaryAddress?: string | null;
  summaryContent?: string | null;
  completedAt?: string | null;
  createdAt?: string;
  usedMaterials?: Array<{ name?: string; qty?: number; unit?: string }>;
}

function WorkOrderPicker({
  open,
  onClose,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (workOrderId: number) => void;
}) {
  const { message } = AntdApp.useApp();
  const [rows, setRows] = useState<WorkOrderPickRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [q, setQ] = useState('');

  useEffect(() => {
    const timer = window.setTimeout(() => setQ(keyword.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [keyword]);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    request<WorkOrderPickRow[]>({ url: '/work-orders', query: { scope: 'all', q: q || undefined } })
      .then(setRows)
      .catch((e: any) => message.error(e?.message || '加载工单失败'))
      .finally(() => setLoading(false));
  }, [open, q, message]);

  return (
    <Modal open={open} title="选一张工单开养护单" width={860} onCancel={onClose} footer={null} destroyOnHidden>
      <Input.Search
        allowClear
        size="large"
        placeholder="工单号 / 地址 / 故障描述"
        value={keyword}
        onChange={(e) => setKeyword(e.target.value)}
        style={{ marginBottom: 12 }}
      />
      <Text type="secondary" style={{ display: 'block', marginBottom: 12, lineHeight: 1.6 }}>
        一张工单只开一张养护单；已经开过的会直接打开原来那张，不会重复开单。
      </Text>
      <Table<WorkOrderPickRow>
        rowKey="id"
        size="middle"
        loading={loading}
        dataSource={rows}
        scroll={{ x: 720 }}
        pagination={{ pageSize: 8, showSizeChanger: false }}
        onRow={(r) => ({ onClick: () => onPick(r.id), style: { cursor: 'pointer' } })}
        columns={[
          { title: '工单编号', dataIndex: 'orderNo', width: 170 },
          {
            title: '报修地址',
            dataIndex: 'summaryAddress',
            width: 160,
            render: (v: string | null) => v || '—',
          },
          {
            title: '报修内容',
            dataIndex: 'summaryContent',
            ellipsis: true,
            render: (v: string | null) => v || '—',
          },
          {
            title: '工单用料',
            key: 'materials',
            width: 220,
            render: (_: unknown, row: WorkOrderPickRow) =>
              row.usedMaterials?.length
                ? row.usedMaterials.map((item) => `${item.name || '未命名'} ×${item.qty ?? 0}${item.unit || ''}`).join('、')
                : <Text type="secondary">未登记用料</Text>,
          },
          {
            title: '完工时间',
            dataIndex: 'completedAt',
            width: 180,
            render: (v: string | null) => (v ? formatDateTimeCn(v) : '未完工'),
          },
        ]}
      />
    </Modal>
  );
}

/**
 * 标题栏右边那个「打印偏移」：抵掉打印机进纸误差用的。
 *
 * 为什么不是每张单一个值：偏移是**打印机**的属性，不是单据的 ——
 * 同一张单换台机器打就该是另一个数。所以存在这台电脑的浏览器里，
 * 下次同一个浏览器打开还是这组数（print-offset.ts）。
 *
 * 正反面分开填：双面打印时反面是另一次走纸，套准误差跟正面对不上，
 * 只给一个值补不齐 —— 这也是反面不再画骑缝线的同一个原因。
 */
function PrintOffsetButton({
  value,
  onChange,
}: {
  value: PrintOffset;
  onChange: (next: PrintOffset) => void;
}) {
  const set = (patch: Partial<PrintOffset>) => {
    const next = { ...value, ...patch };
    onChange(next);
    savePrintOffset(next);
  };
  const dirty = !isZeroOffset(value);

  const field = (label: string, key: keyof PrintOffset) => (
    <Space size={6}>
      <span style={{ fontSize: 12, color: '#5d6b69', width: 28, display: 'inline-block' }}>
        {label}
      </span>
      <InputNumber
        size="small"
        style={{ width: 104 }}
        step={0.5}
        min={-15}
        max={15}
        precision={1}
        addonAfter="mm"
        value={value[key]}
        onChange={(next) => set({ [key]: Number(next) || 0 })}
      />
    </Space>
  );

  return (
    <Popover
      trigger="click"
      placement="bottomRight"
      title="打印偏移"
      content={
        <div style={{ width: 300 }}>
          <Text type="secondary" style={{ fontSize: 12, display: 'block', lineHeight: 1.6 }}>
            套打时内容没落进纸上的格子，用这里整体挪一挪。
            <br />
            正数往右 / 往下，负数反向。<b>只影响打印</b>，屏幕预览不动。
          </Text>
          <div style={{ marginTop: 12, fontSize: 13, fontWeight: 600 }}>正面</div>
          <Space direction="vertical" size={6} style={{ marginTop: 6 }}>
            {field('左右', 'fx')}
            {field('上下', 'fy')}
          </Space>
          <div style={{ marginTop: 12, fontSize: 13, fontWeight: 600 }}>反面</div>
          <Space direction="vertical" size={6} style={{ marginTop: 6 }}>
            {field('左右', 'bx')}
            {field('上下', 'by')}
          </Space>
          <Space size={8} style={{ marginTop: 14 }}>
            <Button size="small" onClick={() => set({ bx: value.fx, by: value.fy })}>
              反面同正面
            </Button>
            <Button size="small" disabled={!dirty} onClick={() => set(ZERO_OFFSET)}>
              全部归零
            </Button>
          </Space>
          <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 10 }}>
            这组数存在这台电脑上，换台电脑要重新设。
          </Text>
        </div>
      }
    >
      <Button
        size="small"
        type={dirty ? 'link' : 'text'}
        icon={<SettingOutlined />}
        // 主题把 controlHeight 调到了 40，small 跟着变成 30px，会把 24px 的标题行顶高 6px。
        // 写死 24 让它和标题一样高 —— 用户要的是「并排，不增加高度」
        style={{ height: 24, paddingInline: 8, fontSize: 13 }}
      >
        打印偏移{dirty ? '·已设' : ''}
      </Button>
    </Popover>
  );
}

function MaintenanceEditor({
  id,
  quotaItems,
  quotaParams,
  canEdit,
  canDelete,
  canInspect,
  onClose,
  onChanged,
}: {
  id: number | null;
  quotaItems: QuotaItemRow[];
  quotaParams: QuotaParams;
  canEdit: boolean;
  canDelete: boolean;
  canInspect: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { message, modal } = AntdApp.useApp();
  const [draft, setDraft] = useState<MaintenanceOrder | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [signSlot, setSignSlot] = useState<SignSlot | null>(null);
  /** 「发到手机签」的二维码弹窗，签哪个位置 */
  /**
   * 「发到手机签」的进度。放在编辑器这一层而不是弹窗里 ——
   * 关掉二维码窗口之后还得继续盯着，不然师傅晚一步签完，这边就得刷新页面才看得到。
   */
  const [phoneSign, setPhoneSign] = useState<PhoneSign | null>(null);
  /** 二维码窗口开着没有（关了也照样在后台盯） */
  const [phoneOpen, setPhoneOpen] = useState(false);
  const [printJob, setPrintJob] = useState<null | 'normal' | 'overlay'>(null);
  const printRef = useRef<HTMLDivElement | null>(null);
  /** 填写内容用哪款手写体。存本机：一个办公室通常固定一款，不必每次选 */
  const [fontId, setFontId] = useState(readFontId);
  /** 网页字体几 MB，下载要一会儿；没下完就打印会印成宋体，所以这个状态要摊给用户看 */
  const [fontReady, setFontReady] = useState(false);
  /** 打印偏移：这台电脑 + 这台打印机的属性，存本机 */
  const [offset, setOffset] = useState<PrintOffset>(readPrintOffset);

  const quotaByCode = useMemo(
    () => new Map(quotaItems.map((item) => [item.code, item])),
    [quotaItems],
  );

  useEffect(() => {
    if (!id) {
      setDraft(null);
      setDirty(false);
      return;
    }
    setLoading(true);
    request<MaintenanceOrder>({ url: `/maintenance-orders/${id}` })
      .then((data) => {
        // 还没填实体单号的草稿：直接把下一个号填上（服务端算的优先，其次本机上次填的）,
        // 让人少翻一次联单本；填错了改一下就行，保存时才落库
        const suggestion = data.suggestedPaperNo || nextPaperNoFromLocal();
        const prefilled = !data.paperNo && suggestion;
        setDraft(prefilled ? { ...data, paperNo: suggestion } : data);
        setDirty(!!prefilled);
      })
      .catch((e: any) => message.error(e?.message || '加载养护单失败'))
      .finally(() => setLoading(false));
  }, [id, message]);

  // 只有「填单中」可改正文；推送后三方签的必须是同一份快照。
  const editable = canEdit && draft?.status === 'filling';

  const font = findFont(fontId);
  const missing = useMemo(() => missingForOrder(fontId, draft), [fontId, draft]);

  // 选中的字体先下下来：预览要用，打印更要用（swap 会让没下完的那一张印成宋体）
  useEffect(() => {
    if (!id) return;
    if (!font.family) {
      setFontReady(true);
      return;
    }
    let alive = true;
    setFontReady(false);
    ensureFontLoaded(fontId, filledText(draft))
      .catch(() => undefined)
      .finally(() => {
        if (alive) setFontReady(true);
      });
    return () => {
      alive = false;
    };
    // draft 只是拿来做「优先加载这几个字」的提示，变了不必重下
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, fontId, font.family]);

  const recompute = (order: MaintenanceOrder): MaintenanceOrder => ({
    ...order,
    totalCents: totalFeeCents(order.items, order.coefficient),
    materialTotalCents: materialTotalCents(order.materials),
  });

  const patch = (p: Partial<MaintenanceOrder>) => {
    setDraft((prev) => {
      if (!prev) return prev;
      const next = { ...prev, ...p };
      // 勾了费用类别 / 分摊方式，括号里的字跟着写上（还能手改）
      if ('feeCategory' in p) {
        next.feeCategoryText = optionText(FEE_CATEGORY_OPTIONS, next.feeCategory);
      }
      if ('shareMethod' in p) {
        next.shareMethodText = optionText(SHARE_METHOD_OPTIONS, next.shareMethod);
      }
      return recompute(next);
    });
    setDirty(true);
  };

  const patchItem = (index: number, p: Partial<MaintenanceItem>) => {
    setDraft((prev) => {
      if (!prev) return prev;
      const items = [...prev.items];
      while (items.length <= index) items.push(emptyItem());
      let next = { ...items[index], ...p };
      // 选了定额编号或改了实做数量 → 工时和人工费自动算，人工费手改后不再被覆盖
      if ('quotaCode' in p || 'actualQty' in p) {
        const quota = quotaByCode.get(next.quotaCode);
        if (quota) {
          const qty = next.actualQty ?? next.surveyQty ?? 1;
          const { hours, laborFeeCents } = quotaLabor(
            Number(quota.hours) || 0,
            qty,
            prev.laborRateCents || 0,
          );
          next.quotaHours = hours;
          next.laborFeeCents = laborFeeCents;
          if (!next.name) next.name = quota.name;
          if (next.materialFeeCents === null && quota.materialFeeCents) {
            next.materialFeeCents = Math.round(quota.materialFeeCents * qty);
          }
        }
      }
      items[index] = next;
      return recompute({ ...prev, items });
    });
    setDirty(true);
  };

  const patchMaterial = (index: number, p: Partial<MaintenanceMaterial>) => {
    setDraft((prev) => {
      if (!prev) return prev;
      const materials = [...prev.materials];
      while (materials.length <= index) materials.push(emptyMaterial());
      materials[index] = { ...materials[index], ...p };
      return recompute({ ...prev, materials });
    });
    setDirty(true);
  };

  const save = async (extra?: Partial<MaintenanceOrder>): Promise<boolean> => {
    if (!draft) return false;
    const merged = recompute({ ...draft, ...extra });
    setSaving(true);
    try {
      const saved = await request<MaintenanceOrder>({
        method: 'PATCH',
        url: `/maintenance-orders/${draft.id}`,
        data: {
          paperNo: merged.paperNo ?? '',
          unitName: merged.unitName ?? '',
          reporterName: merged.reporterName ?? '',
          addrVillage: merged.addrVillage ?? '',
          addrRoad: merged.addrRoad ?? '',
          addrLane: merged.addrLane ?? '',
          addrBuildingNo: merged.addrBuildingNo ?? '',
          addrRoom: merged.addrRoom ?? '',
          reportedOn: merged.reportedOn,
          presentTime: merged.presentTime ?? '',
          faultPart: merged.faultPart ?? '',
          repairItem: merged.repairItem ?? '',
          appointOn: merged.appointOn,
          startOn: merged.startOn,
          finishOn: merged.finishOn,
          partCategory: merged.partCategory ?? '',
          feeCategory: merged.feeCategory ?? '',
          shareMethod: merged.shareMethod ?? '',
          repairDateText: merged.repairDateText ?? '',
          feeCategoryText: merged.feeCategoryText ?? '',
          shareMethodText: merged.shareMethodText ?? '',
          items: merged.items.filter((item) => !isEmptyItem(item)),
          materials: merged.materials.filter((row) => !isEmptyMaterial(row)),
          scrapNote: merged.scrapNote ?? '',
          voucherIssue: merged.voucherIssue ?? '',
          serviceRecord: merged.serviceRecord ?? '',
          followUpRecord: merged.followUpRecord ?? '',
          fillerName: merged.fillerName ?? '',
          repairerName: merged.repairerName ?? '',
          // 签名一律只在「刚签完」那一次随 extra 带上，普通保存不碰它（见下面 signaturePatch）
          ...signaturePatch(extra),
        },
      });
      setDraft(saved);
      setDirty(false);
      rememberPaperNo(saved.paperNo);
      onChanged();
      message.success('已保存');
      return true;
    } catch (e: any) {
      message.error(e?.message || '保存失败');
      return false;
    } finally {
      setSaving(false);
    }
  };

  const publish = async () => {
    if (!draft || saving) return;
    if (dirty && !(await save())) return;
    setSaving(true);
    try {
      const saved = await request<MaintenanceOrder>({
        method: 'POST', url: `/maintenance-orders/${draft.id}/publish`,
      });
      setDraft(saved);
      setDirty(false);
      onChanged();
      message.success('已推送给填单人，小程序内任务不过期');
    } catch (e: any) {
      message.error(e?.message || '推送签名失败');
    } finally {
      setSaving(false);
    }
  };

  /** 二维码窗口关掉之后仍在后台盯着，这时候签名回来要吱一声 */
  const phoneOpenRef = useRef(phoneOpen);
  useEffect(() => {
    phoneOpenRef.current = phoneOpen;
  }, [phoneOpen]);

  /** 发到手机签：拿二维码。查验签名走另一个接口 —— 权限那一格不一样（只有物业经理有） */
  const startPhoneSign = useCallback(
    async (slot: SignSlot) => {
      if (!draft) return;
      setPhoneOpen(true);
      setPhoneSign({ slot, status: 'loading' });
      try {
        const data = await request<{
          token: string;
          url: string;
          qrDataUrl: string;
          expiresInSec: number;
        }>(
          slot === 'inspector'
            ? { method: 'POST', url: `/maintenance-orders/${draft.id}/inspect-token` }
            : { method: 'POST', url: `/maintenance-orders/${draft.id}/sign-token`, data: { slot } },
        );
        setPhoneSign({
          slot,
          status: 'waiting',
          token: data.token,
          linkUrl: data.url,
          qrDataUrl: data.qrDataUrl,
          expiresAt: Date.now() + data.expiresInSec * 1000,
          /** 开二维码之前这一格是不是已经有签名了 —— 有的话要提醒「重签会覆盖」 */
          hadSignature: !!draft[SIGN_FIELDS[slot]],
        });
      } catch (e: any) {
        setPhoneSign({ slot, status: 'error', error: e?.message || '二维码生成失败' });
      }
    },
    [draft],
  );

  /*
   * 盯着这一张二维码走到哪一步了：等待扫码 → 手机已打开 → 已签好。
   *
   * 问的是 /sign/status（按 token 记的进度），**不是**看单据上那一格有没有值 ——
   * 重签的时候那一格本来就有签名，按「有没有值」判会一开窗就当成签好了，
   * 人根本没机会重签（2026-08-31 用户实际遇到）。
   *
   * 依赖只留 token 和 status：把倒计时或回调放进来，effect 每秒重建一次，
   * 定时器永远轮不到（同一天踩过的另一个坑）。
   */
  useEffect(() => {
    const token = phoneSign?.token;
    const status = phoneSign?.status;
    if (!token || !draft || (status !== 'waiting' && status !== 'opened')) return;
    let alive = true;
    const timer = window.setInterval(async () => {
      if (!alive) return;
      if (phoneSign?.expiresAt && Date.now() > phoneSign.expiresAt) {
        setPhoneSign((prev) => (prev && prev.token === token ? { ...prev, status: 'expired' } : prev));
        return;
      }
      try {
        const st = await request<{ opened: boolean; submitted: boolean }>({
          url: '/sign/status',
          query: { token },
        });
        if (!alive) return;
        if (st.submitted) {
          const fresh = await request<MaintenanceOrder>({ url: `/maintenance-orders/${draft.id}` });
          if (!alive) return;
          setDraft((prev) => (prev ? { ...prev, ...fresh } : fresh));
          setDirty(false);
          onChanged();
          setPhoneSign((prev) =>
            prev && prev.token === token
              ? { ...prev, status: 'signed', signUrl: (fresh[SIGN_FIELDS[prev.slot]] as string) || null }
              : prev,
          );
          // 窗口已经关掉的话，得吱一声，不然人不知道签好了
          if (!phoneOpenRef.current) {
            message.success(`${SIGN_SLOT_LABELS[phoneSign!.slot]}的签名已收到`);
          }
        } else if (st.opened && status !== 'opened') {
          setPhoneSign((prev) => (prev && prev.token === token ? { ...prev, status: 'opened' } : prev));
        }
      } catch {
        // 网络抖一下就算了，下一轮再问
      }
    }, 2000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phoneSign?.token, phoneSign?.status, draft?.id]);

  const onSigned = async (url: string) => {
    const slot = signSlot;
    setSignSlot(null);
    if (!slot || !draft) return;
    if (slot === 'inspector') {
      try {
        const saved = await request<MaintenanceOrder>({
          method: 'POST',
          url: `/maintenance-orders/${draft.id}/inspect`,
          data: { signUrl: url },
        });
        setDraft(saved);
        setDirty(false);
        onChanged();
        message.success('已查验并签名');
      } catch (e: any) {
        message.error(e?.message || '查验失败');
      }
      return;
    }
    // 其它三个签名位签完立刻落库：图片已经传上去了，不保存就成了孤儿文件
    const field =
      slot === 'filler' ? 'fillerSignUrl' : slot === 'repairer' ? 'repairerSignUrl' : 'ownerSignUrl';
    setDraft((prev) => (prev ? { ...prev, [field]: url } : prev));
    await save({ [field]: url } as Partial<MaintenanceOrder>);
  };

  useEffect(() => {
    if (!printJob || !printRef.current || !draft) return;
    let alive = true;
    const html = printRef.current.innerHTML;
    // 先把手写体下完再打：font-display 是 swap，字体没到位这一张就印成宋体了，
    // 而联单是一次性的纸，印废一张就少一张
    ensureFontLoaded(fontId, filledText(draft))
      .catch(() => undefined)
      .then(() =>
        printMaintenanceSheets(
          html,
          `养护单 ${draft.paperNo || draft.orderNo}`,
          printOffsetCss(offset),
        ),
      )
      .then(async () => {
        if (draft.status !== 'pending_print') return;
        const confirmed = await new Promise<boolean>((resolve) => {
          modal.confirm({
            title: '这张养护单已成功打印吗？',
            content: '只有纸质单已正常打出时才标记已完成；如果取消打印或打印失败，请选择“还没打好”。',
            okText: '已打印，完成归档',
            cancelText: '还没打好',
            onOk: () => resolve(true),
            onCancel: () => resolve(false),
          });
        });
        if (!confirmed) return;
        const saved = await request<MaintenanceOrder>({
          method: 'POST', url: `/maintenance-orders/${draft.id}/printed`,
        });
        if (!alive) return;
        setDraft(saved);
        onChanged();
        message.success('已标记为完成');
      })
      .catch((e: any) => message.error(e?.message || '打印或归档失败'))
      .finally(() => {
        if (alive) setPrintJob(null);
      });
    return () => {
      alive = false;
    };
  }, [printJob, draft, fontId, offset, message, modal, onChanged]);

  const close = () => {
    if (dirty) {
      modal.confirm({
        title: '有没保存的修改',
        content: '直接关闭会丢掉这次填的内容，要先保存吗？',
        okText: '保存并关闭',
        cancelText: '直接关闭',
        onOk: async () => {
          await save();
          onClose();
        },
        onCancel: onClose,
      });
      return;
    }
    onClose();
  };

  const voidOrder = async () => {
    if (!draft) return;
    try {
      await request({ method: 'DELETE', url: `/maintenance-orders/${draft.id}` });
      message.success('已作废');
      onChanged();
      onClose();
    } catch (e: any) {
      message.error(e?.message || '作废失败');
    }
  };

  const pages = draft ? sheetCount(draft) : 1;

  return (
    <>
      <Modal
        open={!!id}
        title={
          draft ? (
            // 偏移按钮和标题并排、靠右。右边留 28px 是给 Modal 自己的关闭叉，
            // 按钮用 small（24px 高）跟标题一样高，这一行不会因此变高
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
                paddingRight: 28,
              }}
            >
              <Space size={12} wrap>
                <span>养护单 {draft.paperNo || draft.orderNo}</span>
                <Tag color={STATUS_COLOR[draft.status]}>
                  {MAINTENANCE_STATUS_LABELS[draft.status]}
                </Tag>
                {pages > 1 && <Tag>共 {pages} 张</Tag>}
                {dirty && <Tag color="warning">未保存</Tag>}
              </Space>
              <PrintOffsetButton value={offset} onChange={setOffset} />
            </div>
          ) : (
            '养护单'
          )
        }
        width="min(1240px, 96vw)"
        style={{ top: 24 }}
        // 两张纸叠起来快一米高，不限高的话页脚（保存 / 打印 / 查验）会被顶到屏幕外，
        // 要滚到最底下才点得到
        styles={{ body: { maxHeight: 'calc(100vh - 220px)', overflow: 'auto' } }}
        onCancel={close}
        loading={loading}
        destroyOnHidden
        footer={
          <Space wrap>
            {editable && !draft?.paperNo && (
              <Tag color="warning">未填实体单号，纸上那格会是空的</Tag>
            )}
            {editable && (
              <Tooltip title="联单上号码机打的那串数字。多张纸时这里填第一张的号，打印时逐张 +1。">
                <Input
                  addonBefore="实体单号"
                  style={{ width: 230 }}
                  inputMode="numeric"
                  maxLength={12}
                  placeholder="起始编号，如 0119610"
                  value={draft?.paperNo || ''}
                  // 只收数字：连打要按它逐张 +1，混进字母就加不了（服务端也拦一道）
                  onChange={(e) => patch({ paperNo: e.target.value.replace(/\D/g, '') })}
                />
              </Tooltip>
            )}
            <Tooltip title="填上去的内容用哪款手写体。字体是网站发下来的，打印这台电脑不用装任何字体；第一次用会下载几 MB，之后有缓存。">
              <Select
                value={fontId}
                onChange={(value) => {
                  setFontId(value);
                  rememberFontId(value);
                }}
                style={{ width: 210 }}
                popupMatchSelectWidth={280}
                // 每项两行、约 68px，默认 256px 只露得出三项半 ——
                // 被挡住的恰好是「系统自带（不下载）」，网速不好的人最需要的那一档
                listHeight={400}
                options={HANDWRITING_FONTS.map((item) => ({
                  value: item.id,
                  label: item.label,
                  title: item.desc,
                }))}
                optionRender={(option) => {
                  const item = findFont(String(option.value));
                  return (
                    <Space size={4} direction="vertical" style={{ lineHeight: 1.35 }}>
                      <span
                        style={{
                          fontFamily: item.previewFamily
                            ? `'${item.previewFamily}', cursive`
                            : "'STXingkai','KaiTi','楷体',cursive",
                          fontSize: 17,
                          fontWeight: 700,
                        }}
                      >
                        {item.label}
                      </span>
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        {item.desc}
                        {item.sizeMb ? ` · 约 ${item.sizeMb}MB` : ''}
                      </Text>
                    </Space>
                  );
                }}
                labelRender={(option) => (
                  <span>
                    字体：{String(option.label)}
                    {!fontReady && font.family ? '（下载中）' : ''}
                  </span>
                )}
              />
            </Tooltip>
            <Select
              value={zoom}
              onChange={setZoom}
              style={{ width: 110 }}
              options={[
                { value: 0.6, label: '缩放 60%' },
                { value: 0.8, label: '缩放 80%' },
                { value: 1, label: '缩放 100%' },
                { value: 1.2, label: '缩放 120%' },
              ]}
            />
            {canDelete && draft && draft.status !== 'void' && (
              <Popconfirm title="删除这张养护单？" description="删除后按作废记录保留，原工单可以重新开单。" onConfirm={voidOrder}>
                <Button danger icon={<DeleteOutlined />}>
                  删除养护单
                </Button>
              </Popconfirm>
            )}
            {/* 任何没作废的单都能打：签字没齐就打当前内容（签名栏留空、纸上手签），只有待打印那一步打完才问要不要归档。
                以前只有待打印能点，其它单按钮全灰 —— Mike 2026-09-06「打印按钮也是灰色的」 */}
            <Tooltip title={printHint(draft?.status, '打印')}>
              <Button icon={<PrinterOutlined />} onClick={() => setPrintJob('normal')} disabled={!draft || draft.status === 'void'}>
                打印整单
              </Button>
            </Tooltip>
            <Tooltip title={printHint(draft?.status, '套打')}>
              <Button icon={<PrinterOutlined />} onClick={() => setPrintJob('overlay')} disabled={!draft || draft.status === 'void'}>
                套打（只打内容）
              </Button>
            </Tooltip>
            {draft?.status === 'filling' && canEdit && (
              <Button type="primary" loading={saving} onClick={publish}>保存并推送签名</Button>
            )}
            {draft && ['waiting_filler', 'waiting_repairer', 'waiting_inspector'].includes(draft.status) && (
              <Button
                type="primary"
                ghost
                disabled={draft.status === 'waiting_inspector' && !canInspect}
                onClick={() => startPhoneSign(
                  draft.status === 'waiting_filler' ? 'filler'
                    : draft.status === 'waiting_repairer' ? 'repairer' : 'inspector',
                )}
              >生成当前签字链接 / 二维码</Button>
            )}
            {editable && (
              <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={() => save()}>
                保存
              </Button>
            )}
            <Button onClick={close}>关闭</Button>
          </Space>
        }
      >
        {!draft ? (
          <Empty />
        ) : (
          <>
            {!editable && draft.status !== 'void' && (
              <Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>
                {draft.status !== 'filling'
                  ? '已进入顺序签字流程，正文已锁定。需要修改请作废后从原工单重新开单。'
                  : '你的角色只有查看权限，不能修改。'}
              </Text>
            )}
            <div className="mo-stage">
              <div
                className="mo-stage__inner"
                style={{
                  transform: `scale(${zoom})`,
                  width: `${227 * zoom}mm`,
                  height: `${(116 * pages * 2 + 4 * pages * 2) * zoom}mm`,
                }}
              >
                <MaintenanceSheets
                  order={draft}
                  editable={editable}
                  fontId={fontId}
                  quotaListId="mo-quota-codes"
                  onPatch={patch}
                  onItemPatch={patchItem}
                  onMaterialPatch={patchMaterial}
                  // 三方顺序签名一律在「推送签名」后进行，填单阶段不显示可越级点击的签名区。
                  onSign={undefined}
                />
              </div>
            </div>
            <datalist id="mo-quota-codes">
              {quotaItems
                .filter((item) => item.enabled)
                .map((item) => (
                  <option key={item.id} value={item.code} label={`${item.name}（${item.hours} 工时/${item.unit}）`} />
                ))}
            </datalist>
            {missing.length > 0 && (
              <Paragraph style={{ marginTop: 12, marginBottom: 0, lineHeight: 1.7 }}>
                <Text type="warning">
                  「{font.label}」里没有这几个字：<b>{missing.join(' ')}</b> ——
                  纸上它们会用系统宋体顶上，跟旁边的字不是一套。
                  换成「宅在家自动笔」（生僻字最全）可以避免。
                </Text>
              </Paragraph>
            )}
            <Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0, lineHeight: 1.7 }}>
              定额人工单价 {centsToYuan(quotaParams.laborRateCents)} 元/工时 · 取费系数{' '}
              {quotaParams.coefficient} · 合计 =（人工费 + 材料费）× 系数。
              在「编号」格里选定额编号，工时和人工费会自动算出来；算完还能手改。
            </Paragraph>
          </>
        )}
      </Modal>

      <SignaturePad
        open={!!signSlot}
        onSendToPhone={() => {
          const slot = signSlot;
          setSignSlot(null);
          if (slot) startPhoneSign(slot);
        }}
        title={signSlot ? `${SIGN_SLOT_LABELS[signSlot]}手写签名` : '手写签名'}
        hint={
          [
            signSlot === 'inspector'
              ? '签名即代表已查验，签完这张单就锁定、不能再改内容。'
              : '在下面的框里手写姓名；鼠标不好写就点「发到手机签」，微信扫码在手机上签。',
            signSlot && draft?.[SIGN_FIELDS[signSlot]]
              ? '这一格原来就有签名，签完会覆盖掉原来那个。'
              : '',
          ]
            .filter(Boolean)
            .join('')
        }
        confirmText={signSlot === 'inspector' ? '查验并签名' : '确认签名'}
        onCancel={() => setSignSlot(null)}
        onDone={onSigned}
      />

      <PhoneSignModal
        open={phoneOpen}
        state={phoneSign}
        onRetry={() => phoneSign && startPhoneSign(phoneSign.slot)}
        onClose={() => setPhoneOpen(false)}
      />

      {/* 打印实体挂在 body 下：Modal 里套着 overflow:auto 的滚动容器，会把超出一屏的页裁掉 */}
      {printJob &&
        draft &&
        createPortal(
          <div ref={printRef} className="mo-print-offscreen">
            <MaintenanceSheets
              order={draft}
              editable={false}
              fontId={fontId}
              overlay={printJob === 'overlay'}
            />
          </div>,
          document.body,
        )}
    </>
  );
}

/**
 * 「发到手机签」：显示一个 30 分钟有效、提交一次即失效的二维码。
 *
 * 这边一边显示倒计时，一边每 3 秒问一次服务端「那个签名位有没有回来」——
 * 手机上签完页面自己关掉，人不会再回电脑上点什么，只能这边自己发现。
 */
/**
 * 「发到手机签」的二维码窗口 —— 纯展示，进度由编辑器那边盯着（关掉窗口也不会断）。
 *
 * 六个状态各有各的说法和出路：等待扫码 / 手机已打开 / 已签好 / 已过期 / 生成失败 / 生成中。
 * 特别是**签好之后不自动关窗**：直接把签名亮出来，人才知道到底成没成 ——
 * 窗口自己消失最让人心里没底（用户原话：「签完后签字窗口没有自动更新」）。
 */
function PhoneSignModal({
  open,
  state,
  onRetry,
  onClose,
}: {
  open: boolean;
  state: PhoneSign | null;
  onRetry: () => void;
  onClose: () => void;
}) {
  const { message } = AntdApp.useApp();
  const [now, setNow] = useState(() => Date.now());
  const status = state?.status;
  const counting = status === 'waiting' || status === 'opened';

  useEffect(() => {
    if (!open || !counting) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [open, counting]);

  const leftSec = Math.max(0, Math.ceil(((state?.expiresAt ?? 0) - now) / 1000));
  const leftText = `${Math.floor(leftSec / 60)}:${String(leftSec % 60).padStart(2, '0')}`;
  const slotLabel = state ? SIGN_SLOT_LABELS[state.slot] : '';

  const copySignLink = async () => {
    if (!state?.linkUrl) return;
    try {
      await navigator.clipboard.writeText(state.linkUrl);
      message.success('一次性签字链接已复制，可以直接发到微信');
    } catch {
      message.error('复制失败，请使用二维码扫码');
    }
  };

  const footer =
    status === 'signed' ? (
      <Space>
        <Button onClick={onRetry}>重新签一次</Button>
        <Button type="primary" onClick={onClose}>
          完成
        </Button>
      </Space>
    ) : status === 'expired' || status === 'error' ? (
      <Space>
        <Button type="primary" onClick={onRetry}>
          {status === 'expired' ? '重新生成二维码' : '重试'}
        </Button>
        <Button onClick={onClose}>关闭</Button>
      </Space>
    ) : (
      <Space>
        <Button onClick={onRetry} disabled={status === 'loading'}>
          换一张二维码
        </Button>
        <Button onClick={onClose}>关闭</Button>
      </Space>
    );

  return (
    <Modal
      open={open}
      title={`${slotLabel}：用手机扫码签名`}
      width={460}
      onCancel={onClose}
      destroyOnHidden
      footer={footer}
    >
      <div className="pms-signqr">
        {status === 'loading' && (
          <div className="pms-signqr__state">
            <Spin />
            <div className="pms-signqr__tip">正在生成二维码…</div>
          </div>
        )}

        {(status === 'waiting' || status === 'opened') && (
          <>
            <img className="pms-signqr__img" src={state?.qrDataUrl} alt="签名二维码" />
            <Button onClick={copySignLink} disabled={!state?.linkUrl}>
              复制一次性签字链接
            </Button>
            <div
              className={`pms-signqr__status ${status === 'opened' ? 'is-opened' : ''}`}
              role="status"
            >
              <span className="pms-signqr__dot" />
              {status === 'opened' ? '手机已打开签名页，等他写完' : '等待手机扫码…'}
            </div>
            <div className="pms-signqr__tip">
              让签字的人用<b>微信扫一扫</b>，手机横过来写，写完点提交。
              <br />
              二维码 <b>{leftText}</b> 后失效；<b>这个窗口关掉也没关系</b>，签好了会自动贴到单子上。
            </div>
            {state?.hadSignature && (
              <div className="pms-signqr__warn">这一格原来就有签名，签完会覆盖掉原来那个</div>
            )}
          </>
        )}

        {status === 'signed' && (
          <div className="pms-signqr__state">
            <div className="pms-signqr__ok">✓</div>
            <div className="pms-signqr__oktext">{slotLabel}的签名已收到</div>
            {state?.signUrl && (
              <img className="pms-signqr__preview" src={state.signUrl} alt={`${slotLabel}签名`} />
            )}
            <div className="pms-signqr__tip">
              已经存进这张养护单了，不用再点保存。写歪了可以「重新签一次」，会覆盖这个。
            </div>
          </div>
        )}

        {status === 'expired' && (
          <div className="pms-signqr__state">
            <div className="pms-signqr__expired">⏱</div>
            <div className="pms-signqr__oktext">二维码已过期</div>
            <div className="pms-signqr__tip">
              30 分钟内没人签。手机上那个链接现在也打不开了，重新生成一张就行。
            </div>
          </div>
        )}

        {status === 'error' && (
          <div className="pms-signqr__state">
            <div className="pms-signqr__tip pms-signqr__warn">{state?.error}</div>
          </div>
        )}
      </div>
    </Modal>
  );
}

// ---------------- 预算定额配置 ----------------

function QuotaConfigModal({
  open,
  canEdit,
  canDelete,
  items,
  params,
  onClose,
  onChanged,
}: {
  open: boolean;
  canEdit: boolean;
  canDelete: boolean;
  items: QuotaItemRow[];
  params: QuotaParams;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { message } = AntdApp.useApp();
  const [paramForm] = Form.useForm();
  const [itemForm] = Form.useForm();
  const [editingId, setEditingId] = useState<number | null>(null);
  const [savingParams, setSavingParams] = useState(false);
  const [savingItem, setSavingItem] = useState(false);

  useEffect(() => {
    if (!open) return;
    paramForm.setFieldsValue({
      laborRateYuan: params.laborRateCents / 100,
      coefficient: params.coefficient,
    });
    itemForm.resetFields();
    setEditingId(null);
  }, [open, params, paramForm, itemForm]);

  const saveParams = async () => {
    const values = await paramForm.validateFields();
    setSavingParams(true);
    try {
      await request({
        method: 'PUT',
        url: '/quota-params',
        data: {
          laborRateCents: Math.round(Number(values.laborRateYuan) * 100),
          coefficient: Number(values.coefficient),
        },
      });
      message.success('定额取费参数已保存，之后新算的合计立刻按新参数走');
      onChanged();
    } catch (e: any) {
      message.error(e?.message || '保存失败');
    } finally {
      setSavingParams(false);
    }
  };

  const submitItem = async () => {
    const values = await itemForm.validateFields();
    setSavingItem(true);
    try {
      const data = {
        code: values.code,
        name: values.name,
        unit: values.unit || '项',
        hours: Number(values.hours || 0),
        materialFeeCents: Math.round(Number(values.materialFeeYuan || 0) * 100),
        remark: values.remark || '',
      };
      if (editingId) {
        await request({ method: 'PATCH', url: `/quota-items/${editingId}`, data });
      } else {
        await request({ method: 'POST', url: '/quota-items', data });
      }
      message.success(editingId ? '已保存' : '已新增');
      itemForm.resetFields();
      setEditingId(null);
      onChanged();
    } catch (e: any) {
      message.error(e?.message || '保存失败');
    } finally {
      setSavingItem(false);
    }
  };

  const removeItem = async (row: QuotaItemRow) => {
    try {
      await request({ method: 'DELETE', url: `/quota-items/${row.id}` });
      message.success('已删除');
      onChanged();
    } catch (e: any) {
      message.error(e?.message || '删除失败');
    }
  };

  return (
    <Modal open={open} title="预算定额配置" width={900} onCancel={onClose} footer={null} destroyOnHidden>
      <Paragraph type="secondary" style={{ lineHeight: 1.7 }}>
        养护单上「预算定额」三格就是从这里来的：填单时选一个<b>编号</b>，工时 = 定额工时 × 实做数量，
        人工费 = 工时 × 人工单价；纸下方的<b>定额工料费合计</b> =（人工费 + 材料费）× 取费系数。
        样单口径：0.34 工时 × 17.50 元 = 5.95 元；（5.95 + 6.00）× 1.0341 = 12.36 元。
      </Paragraph>

      <Card size="small" title="取费参数" style={{ marginBottom: 16 }}>
        <Form form={paramForm} layout="inline" disabled={!canEdit}>
          <Form.Item
            name="laborRateYuan"
            label="人工单价（元/工时）"
            rules={[{ required: true, message: '填一个单价' }]}
          >
            <InputNumber min={0} step={0.5} precision={2} style={{ width: 140 }} />
          </Form.Item>
          <Form.Item
            name="coefficient"
            label="取费系数"
            rules={[{ required: true, message: '填一个系数' }]}
          >
            <InputNumber min={0} step={0.0001} precision={4} style={{ width: 140 }} />
          </Form.Item>
          <Form.Item>
            <Button type="primary" loading={savingParams} onClick={saveParams} disabled={!canEdit}>
              保存参数
            </Button>
          </Form.Item>
        </Form>
      </Card>

      <Table<QuotaItemRow>
        rowKey="id"
        size="middle"
        dataSource={items}
        scroll={{ x: 760 }}
        pagination={{ pageSize: 6, showSizeChanger: false }}
        locale={{ emptyText: '还没有定额条目，在下面加一条' }}
        columns={[
          { title: '编号', dataIndex: 'code', width: 120 },
          { title: '项目名称', dataIndex: 'name', width: 200 },
          { title: '单位', dataIndex: 'unit', width: 70 },
          {
            title: '工时定额',
            dataIndex: 'hours',
            width: 100,
            align: 'right',
            render: (v: string) => <span style={{ fontVariantNumeric: 'tabular-nums' }}>{v}</span>,
          },
          {
            title: '参考材料费',
            dataIndex: 'materialFeeCents',
            width: 110,
            align: 'right',
            render: (v: number) => (v ? centsToYuan(v) : '—'),
          },
          {
            title: '操作',
            key: 'ops',
            width: 140,
            render: (_: unknown, row: QuotaItemRow) => (
              <Space>
                <Button
                  type="link"
                  disabled={!canEdit}
                  onClick={() => {
                    setEditingId(row.id);
                    itemForm.setFieldsValue({
                      code: row.code,
                      name: row.name,
                      unit: row.unit,
                      hours: Number(row.hours),
                      materialFeeYuan: row.materialFeeCents / 100,
                      remark: row.remark || '',
                    });
                  }}
                >
                  编辑
                </Button>
                <Popconfirm title="删除这条定额？" onConfirm={() => removeItem(row)}>
                  <Button type="link" danger disabled={!canDelete}>
                    删除
                  </Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />

      <Card size="small" title={editingId ? '修改定额条目' : '新增定额条目'} style={{ marginTop: 16 }}>
        <Form form={itemForm} layout="inline" disabled={!canEdit}>
          <Form.Item name="code" label="编号" rules={[{ required: true, message: '填编号' }]}>
            <Input placeholder="15-4-17" style={{ width: 120 }} />
          </Form.Item>
          <Form.Item name="name" label="名称" rules={[{ required: true, message: '填名称' }]}>
            <Input placeholder="修换声控灯" style={{ width: 180 }} />
          </Form.Item>
          <Form.Item name="unit" label="单位">
            <Input placeholder="只" style={{ width: 80 }} />
          </Form.Item>
          <Form.Item name="hours" label="工时定额">
            <InputNumber min={0} step={0.01} precision={3} style={{ width: 110 }} />
          </Form.Item>
          <Form.Item name="materialFeeYuan" label="参考材料费">
            <InputNumber min={0} step={0.5} precision={2} style={{ width: 110 }} />
          </Form.Item>
          <Form.Item name="remark" label="备注">
            <Input style={{ width: 160 }} />
          </Form.Item>
          <Form.Item>
            <Space>
              <Button type="primary" loading={savingItem} onClick={submitItem} disabled={!canEdit}>
                {editingId ? '保存' : '新增'}
              </Button>
              {editingId && (
                <Button
                  onClick={() => {
                    setEditingId(null);
                    itemForm.resetFields();
                  }}
                >
                  取消
                </Button>
              )}
            </Space>
          </Form.Item>
        </Form>
      </Card>
    </Modal>
  );
}
