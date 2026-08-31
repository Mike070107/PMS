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
  Segmented,
  Select,
  Space,
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

const STATUS_COLOR: Record<MaintenanceStatus, string> = {
  draft: 'processing',
  inspected: 'success',
  void: 'default',
};

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
  const [status, setStatus] = useState<'all' | MaintenanceStatus>('all');
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
      setRows(
        await request<MaintenanceListRow[]>({
          url: '/maintenance-orders',
          query: { status: status === 'all' ? undefined : status, q: searchQ || undefined },
        }),
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
      width: 100,
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
  ];

  if (!canView) return null;

  return (
    <div className="pms-content pms-fadein">
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
        <div>
          <Title level={3} style={{ margin: 0 }}>
            养护单
          </Title>
          <Text type="secondary">《房屋修理养护任务单》：按工单开单、手写签名、查验后打印</Text>
        </div>
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
            <Segmented
              value={status}
              onChange={(v) => setStatus(v as typeof status)}
              options={[
                { label: '全部', value: 'all' },
                { label: '待查验', value: 'draft' },
                { label: '已查验', value: 'inspected' },
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
          scroll={{ x: 1120 }}
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
  const [phoneSlot, setPhoneSlot] = useState<SignSlot | null>(null);
  const [printJob, setPrintJob] = useState<null | 'normal' | 'overlay'>(null);
  const printRef = useRef<HTMLDivElement | null>(null);

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

  // 已查验/已作废的单只读：经理签的是他当时看到的那一份，改了签名就不作数了
  const editable = canEdit && draft?.status === 'draft';

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

  const save = async (extra?: Partial<MaintenanceOrder>) => {
    if (!draft) return;
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
    } catch (e: any) {
      message.error(e?.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  /** 手机上签完了：服务端已经落库，这里把最新的单子换上来，不要标成「未保存」 */
  const onPhoneSigned = (fresh: MaintenanceOrder) => {
    setPhoneSlot(null);
    setDraft((prev) => (prev ? { ...prev, ...fresh } : fresh));
    setDirty(false);
    onChanged();
    message.success('手机上的签名已收到');
  };

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
    printMaintenanceSheets(
      printRef.current.innerHTML,
      `养护单 ${draft.paperNo || draft.orderNo}`,
    )
      .catch((e: any) => message.error(e?.message || '打印失败'))
      .finally(() => {
        if (alive) setPrintJob(null);
      });
    return () => {
      alive = false;
    };
  }, [printJob, draft, message]);

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
            <Space size={12} wrap>
              <span>养护单 {draft.paperNo || draft.orderNo}</span>
              <Tag color={STATUS_COLOR[draft.status]}>{MAINTENANCE_STATUS_LABELS[draft.status]}</Tag>
              {pages > 1 && <Tag>共 {pages} 张</Tag>}
              {dirty && <Tag color="warning">未保存</Tag>}
            </Space>
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
              <Popconfirm title="作废这张养护单？" description="作废后这张工单可以重新开单。" onConfirm={voidOrder}>
                <Button danger icon={<DeleteOutlined />}>
                  作废
                </Button>
              </Popconfirm>
            )}
            <Tooltip title="纸是空白纸时用这个：表格线和预印字一起打">
              <Button icon={<PrinterOutlined />} onClick={() => setPrintJob('normal')} disabled={!draft}>
                打印整单
              </Button>
            </Tooltip>
            <Tooltip title="纸是预印好的联单时用这个：只把填的内容打上去">
              <Button icon={<PrinterOutlined />} onClick={() => setPrintJob('overlay')} disabled={!draft}>
                套打（只打内容）
              </Button>
            </Tooltip>
            {canInspect && draft?.status === 'draft' && (
              <Button type="primary" ghost onClick={() => setSignSlot('inspector')}>
                查验并签名
              </Button>
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
                {draft.status === 'inspected'
                  ? '已经查验签字的单不能再改 —— 经理签的是他当时看到的那一份。要改请先作废，再从工单重新开单。'
                  : '你的角色只有查看权限，可以打印，不能修改。'}
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
                  quotaListId="mo-quota-codes"
                  onPatch={patch}
                  onItemPatch={patchItem}
                  onMaterialPatch={patchMaterial}
                  onSign={editable ? (slot) => setSignSlot(slot) : undefined}
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
          setPhoneSlot(signSlot);
          setSignSlot(null);
        }}
        title={signSlot ? `${SIGN_SLOT_LABELS[signSlot]}手写签名` : '手写签名'}
        hint={
          signSlot === 'inspector'
            ? '签名即代表已查验。签完这张单就锁定，不能再改内容。'
            : '在下面的框里手写姓名。用平板或触摸屏可以直接用手指/触控笔签。'
        }
        confirmText={signSlot === 'inspector' ? '查验并签名' : '确认签名'}
        onCancel={() => setSignSlot(null)}
        onDone={onSigned}
      />

      <PhoneSignModal
        open={!!phoneSlot}
        orderId={draft?.id ?? null}
        slot={phoneSlot}
        onClose={() => setPhoneSlot(null)}
        onSigned={onPhoneSigned}
      />

      {/* 打印实体挂在 body 下：Modal 里套着 overflow:auto 的滚动容器，会把超出一屏的页裁掉 */}
      {printJob &&
        draft &&
        createPortal(
          <div ref={printRef} className="mo-print-offscreen">
            <MaintenanceSheets order={draft} editable={false} overlay={printJob === 'overlay'} />
          </div>,
          document.body,
        )}
    </>
  );
}

/**
 * 「发到手机签」：显示一个 5 分钟有效的二维码，微信扫了直接进签名页。
 *
 * 这边一边显示倒计时，一边每 3 秒问一次服务端「那个签名位有没有回来」——
 * 手机上签完页面自己关掉，人不会再回电脑上点什么，只能这边自己发现。
 */
function PhoneSignModal({
  open,
  orderId,
  slot,
  onClose,
  onSigned,
}: {
  open: boolean;
  orderId: number | null;
  slot: SignSlot | null;
  onClose: () => void;
  onSigned: (order: MaintenanceOrder) => void;
}) {
  const { message } = AntdApp.useApp();
  const [qr, setQr] = useState<{ qrDataUrl: string; url: string; expiresInSec: number } | null>(null);
  const [left, setLeft] = useState(0);
  const [loading, setLoading] = useState(false);
  // 轮询里要调最新的回调，但它不能进 effect 依赖（父组件每次渲染都是新函数）
  const onSignedRef = useRef(onSigned);
  useEffect(() => {
    onSignedRef.current = onSigned;
  }, [onSigned]);

  const load = useCallback(async () => {
    if (!orderId || !slot) return;
    setLoading(true);
    setQr(null);
    try {
      // 查验签名走另一个接口 —— 权限那一格不一样（只有物业经理有）
      const data = await request<{ qrDataUrl: string; url: string; expiresInSec: number }>(
        slot === 'inspector'
          ? { method: 'POST', url: `/maintenance-orders/${orderId}/inspect-token` }
          : { method: 'POST', url: `/maintenance-orders/${orderId}/sign-token`, data: { slot } },
      );
      setQr(data);
      setLeft(data.expiresInSec);
    } catch (e: any) {
      message.error(e?.message || '二维码生成失败');
      onClose();
    } finally {
      setLoading(false);
    }
  }, [orderId, slot, message, onClose]);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  // 倒计时
  useEffect(() => {
    if (!open || !qr || left <= 0) return;
    const timer = window.setTimeout(() => setLeft((v) => v - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [open, qr, left]);

  /*
   * 轮询：手机上签完了，这边自己发现。
   *
   * 依赖里**不能**放 left（倒计时每秒变一次）或 onSigned（父组件每次渲染都是新函数）——
   * 放了的话这个 effect 每秒重建一次，3 秒的定时器还没轮到就被清掉了，
   * 结果是手机上签完、电脑这边一直停在二维码那一屏（2026-08-31 用户实际遇到）。
   * 回调走 ref，依赖只留真正决定「要不要轮询」的三个值。
   */
  useEffect(() => {
    if (!open || !orderId || !slot) return;
    const field = SIGN_FIELDS[slot];
    let alive = true;
    const timer = window.setInterval(async () => {
      try {
        const fresh = await request<MaintenanceOrder>({ url: `/maintenance-orders/${orderId}` });
        if (alive && fresh[field]) {
          window.clearInterval(timer);
          onSignedRef.current(fresh);
        }
      } catch {
        // 网络抖一下就算了，下一轮再问
      }
    }, 3000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [open, orderId, slot]);

  /** 关窗时再问一次：轮询正好卡在两拍之间、或者网络慢了一拍，也不至于白签 */
  const closeAndRefresh = async () => {
    onClose();
    if (!orderId || !slot) return;
    try {
      const fresh = await request<MaintenanceOrder>({ url: `/maintenance-orders/${orderId}` });
      if (fresh[SIGN_FIELDS[slot]]) onSignedRef.current(fresh);
    } catch {
      // 关都关了，问不到就算了
    }
  };

  const expired = !!qr && left <= 0;

  return (
    <Modal
      open={open}
      title={slot ? `${SIGN_SLOT_LABELS[slot]}：用手机扫码签名` : '手机签名'}
      width={460}
      onCancel={closeAndRefresh}
      destroyOnHidden
      footer={
        <Space>
          <Button onClick={load} loading={loading}>
            重新生成
          </Button>
          <Button onClick={closeAndRefresh}>关闭</Button>
        </Space>
      }
    >
      <div className="pms-signqr">
        {qr && !expired ? (
          <>
            <img className="pms-signqr__img" src={qr.qrDataUrl} alt="签名二维码" />
            <div className="pms-signqr__tip">
              让签字的人用<b>微信扫一扫</b>，手机横过来写；写完点提交，页面会自己关掉。
              <br />
              二维码 <b>{Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}</b> 后失效，
              签好这边会自动收到。
            </div>
          </>
        ) : (
          <div className="pms-signqr__tip">
            {loading ? '正在生成二维码…' : expired ? '二维码已失效，点「重新生成」再来一张' : ''}
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
