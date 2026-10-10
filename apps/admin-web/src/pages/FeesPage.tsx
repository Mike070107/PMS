import {
  App as AntdApp,
  Alert,
  Button,
  Card,
  Col,
  DatePicker,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Progress,
  Row,
  Segmented,
  Select,
  Space,
  Statistic,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import {
  BarChartOutlined,
  CreditCardOutlined,
  DownloadOutlined,
  EditOutlined,
  FileTextOutlined,
  PlusOutlined,
  ReloadOutlined,
  SearchOutlined,
  ThunderboltOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  FEE_BILL_SOURCE_LABELS,
  FEE_BILL_STATUS_LABELS,
  FEE_ITEMS,
  FEE_PAYMENT_METHODS,
  FEE_PAYMENT_METHOD_LABELS,
  FeeBillStatus,
  FeeStandardStatus,
  formatFeeMoney,
  formatFeePeriod,
  formatAddressLine,
} from '@pms/shared-types';
import { request } from '../lib/api';
import { centsToYuan, exportXlsx } from '../lib/exportXlsx';
import { handleGone } from '../lib/gone';
import { usePagePerm } from '../lib/auth';
import { searchableWideSelectProps, withOptionTitles } from '../lib/selectProps';
import ApartmentCashierPage from './ApartmentCashierPage';

const { Title, Text } = Typography;

interface Paged<T> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
}

interface CommunityOption {
  id: number;
  name: string;
}

interface BillRow {
  id: number;
  houseId: number;
  communityId: number;
  communityName: string;
  lane: string | null;
  buildingNo: string;
  roomNo: string;
  propertyType: string;
  ownerId: number | null;
  ownerName: string | null;
  feeCode: string;
  feeName: string;
  period: string;
  amountCents: number;
  quantity: number | null;
  unit: string | null;
  unitPriceCents: number | null;
  serviceFrom: string | null;
  serviceTo: string | null;
  vehiclePlate: string | null;
  status: FeeBillStatus;
  paidAt: string | null;
  paymentMethod: string | null;
  receiptNo: string | null;
  invoiceNo: string | null;
  cashier: string | null;
  remark: string | null;
  source: string;
}

interface ArrearRow {
  houseId: number;
  communityId: number;
  communityName: string;
  lane: string | null;
  buildingNo: string;
  roomNo: string;
  propertyType: string;
  ownerName: string | null;
  ownerPhone: string | null;
  billCount: number;
  unpaidCents: number;
  earliestPeriod: string;
  latestPeriod: string;
}

interface StandardRow {
  id: number;
  houseId: number;
  communityId: number;
  communityName: string;
  lane: string | null;
  buildingNo: string;
  roomNo: string;
  propertyType: string;
  areaSqm: string | null;
  ownerName: string | null;
  ownerPhone: string | null;
  feeCode: string;
  feeName: string;
  amountCents: number;
  standardCents: number | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  status: FeeStandardStatus;
  docNo: string | null;
  remark: string | null;
}

interface BillSummary {
  billCount: number;
  dueCents: number;
  paidCents: number;
  unpaidCents: number;
  unpaidCount: number;
}

type Granularity = 'day' | 'week' | 'month';

interface FeeReportTotals {
  /** 实收 = 收款小计 − 红冲冲减 */
  netCents: number;
  chargedCents: number;
  refundedCents: number;
  receiptCount: number;
  houseCount: number;
  itemCount: number;
}

interface FeeReportSlice {
  amountCents: number;
  count: number;
  share: number | null;
}

interface FeeReport {
  range: { from: string; to: string; granularity: Granularity };
  previousRange: { from: string; to: string };
  totals: FeeReportTotals;
  previous: FeeReportTotals;
  growth: { netCents: number | null; receiptCount: number | null; houseCount: number | null };
  trend: Array<{ bucket: string; amountCents: number; count: number }>;
  byMethod: Array<FeeReportSlice & { method: string | null }>;
  byFee: Array<FeeReportSlice & { feeCode: string; feeName: string }>;
  byCommunity: Array<FeeReportSlice & { communityId: number | null; communityName: string | null }>;
  byCashier: Array<FeeReportSlice & { cashier: string | null }>;
}

interface HouseDetail {
  house: {
    id: number;
    roomNo: string;
    propertyType: string;
    areaSqm: string | null;
    fullAddress: string | null;
    lane: string | null;
    buildingNo: string;
    communityId: number;
    communityName: string;
    owner: { id: number; name: string | null; phone: string | null } | null;
  };
  unpaidCents: number;
  bills: BillRow[];
  standards: StandardRow[];
}

const FEE_OPTIONS = FEE_ITEMS.map((item) => ({ value: item.code, label: item.name }));

const STATUS_COLOR: Record<string, string> = {
  [FeeBillStatus.UNPAID]: 'orange',
  [FeeBillStatus.PAID]: 'green',
  [FeeBillStatus.REFUNDED]: 'purple',
  [FeeBillStatus.CANCELLED]: 'default',
};

/**
 * 导出走分页累加，和后端 MAX_PAGE_SIZE 对齐；
 * 上限与报表明细一致（5000 条），超了让人缩小筛选范围，不无声截断。
 */
const EXPORT_PAGE_SIZE = 500;
const EXPORT_ROW_LIMIT = 5000;

/** 房租这类按期收的费用要能看出收的是哪段时间 */
function serviceText(r: { serviceFrom: string | null; serviceTo: string | null }) {
  if (!r.serviceFrom && !r.serviceTo) return '';
  const day = (v: string | null) => (v ? dayjs(v).format('YYYY-MM-DD') : '?');
  return `${day(r.serviceFrom)} ~ ${day(r.serviceTo)}`;
}

/** 枫桦景苑一期 · 198弄2号 101 —— 列表、弹窗共用一套写法 */
function placeText(r: {
  communityName: string;
  lane: string | null;
  buildingNo: string;
  roomNo: string;
}) {
  return formatAddressLine({ name: r.communityName }, { ...r, roadName: null }, r.roomNo);
}

export default function FeesPage() {
  const [tab, setTab] = useState('cashier');
  const [detailHouseId, setDetailHouseId] = useState<number | null>(null);

  return (
    <div>
      <Space align="start" style={{ width: '100%', justifyContent: 'space-between', marginBottom: 16 }}>
        <Text className="pms-page-note" type="secondary">
            按户记账：登记收款、查欠费、维护每户的收费标准。目前只做账目管理，不接在线支付与发票。
        </Text>
      </Space>
      <Tabs
        activeKey={tab}
        onChange={setTab}
        items={[
          {
            key: 'cashier',
            label: <span><CreditCardOutlined /> 收费工作台</span>,
            children: <ApartmentCashierPage />,
          },
          {
            key: 'bills',
            label: <span><FileTextOutlined /> 账单</span>,
            children: <BillsTab onOpenHouse={setDetailHouseId} />,
          },
          {
            key: 'reports',
            label: <span><BarChartOutlined /> 收费报表</span>,
            children: <ReportTab />,
          },
          {
            key: 'arrears',
            label: <span><WarningOutlined /> 欠费催缴</span>,
            children: <ArrearsTab onOpenHouse={setDetailHouseId} />,
          },
        ]}
      />
      <HouseDetailModal
        houseId={detailHouseId}
        onClose={() => setDetailHouseId(null)}
      />
    </div>
  );
}

export function FeeStandardsPanel() {
  const [detailHouseId, setDetailHouseId] = useState<number | null>(null);
  return (
    <>
      <StandardsTab onOpenHouse={setDetailHouseId} />
      <HouseDetailModal houseId={detailHouseId} onClose={() => setDetailHouseId(null)} />
    </>
  );
}

/** 小区下拉：后端已按角色数据范围过滤，直接用 */
function useCommunities() {
  const [communities, setCommunities] = useState<CommunityOption[]>([]);
  useEffect(() => {
    request<CommunityOption[]>({ url: '/communities' })
      .then(setCommunities)
      .catch(() => undefined);
  }, []);
  return communities;
}

// ====================================================================
// 账单
// ====================================================================
function BillsTab({ onOpenHouse }: { onOpenHouse: (houseId: number) => void }) {
  const { message, modal } = AntdApp.useApp();
  const { canEdit, canDelete } = usePagePerm('fees');
  const communities = useCommunities();

  const [rows, setRows] = useState<BillRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [summary, setSummary] = useState<BillSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<BillRow[]>([]);

  const [q, setQ] = useState('');
  const [communityId, setCommunityId] = useState<number | undefined>();
  const [feeCode, setFeeCode] = useState<string | undefined>();
  const [status, setStatus] = useState<FeeBillStatus | undefined>(FeeBillStatus.UNPAID);
  const [periodRange, setPeriodRange] = useState<[dayjs.Dayjs | null, dayjs.Dayjs | null] | null>(null);
  const [paidRange, setPaidRange] = useState<[dayjs.Dayjs | null, dayjs.Dayjs | null] | null>(null);
  const [paymentMethod, setPaymentMethod] = useState<string | undefined>();
  const [exporting, setExporting] = useState(false);

  const [payOpen, setPayOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<BillRow | null>(null);
  const [generateOpen, setGenerateOpen] = useState(false);

  const query = useMemo(
    () => ({
      q: q || undefined,
      communityId,
      feeCode,
      status,
      periodFrom: periodRange?.[0] ? periodRange[0].format('YYYYMM') : undefined,
      periodTo: periodRange?.[1] ? periodRange[1].format('YYYYMM') : undefined,
      paidFrom: paidRange?.[0] ? paidRange[0].format('YYYY-MM-DD') : undefined,
      paidTo: paidRange?.[1] ? paidRange[1].format('YYYY-MM-DD') : undefined,
      paymentMethod,
    }),
    [q, communityId, feeCode, status, periodRange, paidRange, paymentMethod],
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [data, sum] = await Promise.all([
        request<Paged<BillRow>>({ url: '/fees/bills', query: { ...query, page, pageSize } }),
        request<BillSummary>({ url: '/fees/bills/summary', query }),
      ]);
      setRows(data.rows);
      setTotal(data.total);
      setSummary(sum);
      setSelected([]);
    } catch (e: any) {
      message.error(e?.message || '加载失败');
    } finally {
      setLoading(false);
    }
  }, [message, query, page, pageSize]);

  useEffect(() => { load(); }, [load]);
  // 换了筛选条件要回到第一页，否则第 8 页筛出 3 条会显示空白表格
  useEffect(() => { setPage(1); }, [query]);

  const bulk = async (url: string, what: string, reason?: string) => {
    try {
      const res = await request<any>({
        method: 'POST',
        url,
        data: { ids: selected.map((r) => r.id), reason },
      });
      message.success(`${what}成功：${res.count ?? res.paidCount ?? 0} 条`);
      load();
    } catch (e: any) {
      message.error(e?.message || `${what}失败`);
    }
  };

  // 导出按当前筛选条件重新向后端取全量，不是导出屏幕上这一页
  const exportBills = async () => {
    setExporting(true);
    try {
      const all: BillRow[] = [];
      let got = 0;
      for (let p = 1; all.length < EXPORT_ROW_LIMIT; p += 1) {
        const data = await request<Paged<BillRow>>({
          url: '/fees/bills',
          query: { ...query, page: p, pageSize: EXPORT_PAGE_SIZE },
        });
        all.push(...data.rows);
        got = data.total;
        if (data.rows.length < EXPORT_PAGE_SIZE || all.length >= got) break;
      }
      if (!all.length) {
        message.warning('当前筛选条件下没有账单可导出');
        return;
      }
      await exportXlsx(`收费明细_${dayjs().format('YYYYMMDD')}`, [
        {
          name: '账单明细',
          columns: [
            { title: '收据号', key: 'receiptNo', render: (r: BillRow) => r.receiptNo || '' },
            { title: '小区', key: 'communityName' },
            { title: '房号', key: 'place', render: (r: BillRow) => placeText(r) },
            { title: '房屋性质', key: 'propertyType' },
            { title: '业主/住户', key: 'ownerName', render: (r: BillRow) => r.ownerName || '' },
            { title: '费用项目', key: 'feeName' },
            { title: '账期', key: 'period', render: (r: BillRow) => formatFeePeriod(r.period) },
            { title: '数量', key: 'quantity', render: (r: BillRow) => r.quantity ?? '' },
            { title: '单位', key: 'unit', render: (r: BillRow) => r.unit || '' },
            { title: '单价(元)', key: 'unitPrice', render: (r: BillRow) => (r.unitPriceCents === null ? '' : centsToYuan(r.unitPriceCents)) },
            { title: '金额(元)', key: 'amount', render: (r: BillRow) => centsToYuan(r.amountCents) },
            { title: '服务期间', key: 'service', render: (r: BillRow) => serviceText(r) },
            { title: '车牌', key: 'vehiclePlate', render: (r: BillRow) => r.vehiclePlate || '' },
            { title: '状态', key: 'statusLabel', render: (r: BillRow) => FEE_BILL_STATUS_LABELS[r.status] || r.status },
            { title: '收款日期', key: 'paidAt', render: (r: BillRow) => (r.paidAt ? dayjs(r.paidAt).format('YYYY-MM-DD') : '') },
            { title: '收款方式', key: 'paymentMethodLabel', render: (r: BillRow) => (r.paymentMethod ? FEE_PAYMENT_METHOD_LABELS[r.paymentMethod] || r.paymentMethod : '') },
            { title: '收费员', key: 'cashier', render: (r: BillRow) => r.cashier || '' },
            { title: '发票号', key: 'invoiceNo', render: (r: BillRow) => r.invoiceNo || '' },
            { title: '来源', key: 'sourceLabel', render: (r: BillRow) => FEE_BILL_SOURCE_LABELS[r.source] || r.source },
            { title: '备注', key: 'remark', render: (r: BillRow) => r.remark || '' },
          ],
          rows: all,
        },
      ]);
      if (got > all.length) {
        message.warning(`共 ${got} 条，本次只导出前 ${all.length} 条；请缩小筛选范围后分批导出`);
      } else {
        message.success(`已导出 ${all.length} 条`);
      }
    } catch (e: any) {
      message.error(e?.message || '导出失败');
    } finally {
      setExporting(false);
    }
  };

  const removeBill = async (r: BillRow) => {
    try {
      await request({ method: 'DELETE', url: `/fees/bills/${r.id}` });
      message.success('已删除');
      load();
    } catch (e: any) {
      if (handleGone(e, message, '这条账单', load)) return;
      message.error(e?.message || '删除失败');
    }
  };

  const selectedUnpaid = selected.filter((r) => r.status === FeeBillStatus.UNPAID);
  const selectedAmount = selectedUnpaid.reduce((sum, r) => sum + r.amountCents, 0);

  return (
    <div>
      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col xs={12} md={6}>
          <Card size="small"><Statistic title="账单数" value={summary?.billCount ?? 0} /></Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small"><Statistic title="应收" value={formatFeeMoney(summary?.dueCents)} /></Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic title="实收" value={formatFeeMoney(summary?.paidCents)} valueStyle={{ color: '#3f8600' }} />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic
              title={`欠费（${summary?.unpaidCount ?? 0} 条）`}
              value={formatFeeMoney(summary?.unpaidCents)}
              valueStyle={{ color: '#cf1322' }}
            />
          </Card>
        </Col>
      </Row>

      <Card
        title={
          <Space size={6} wrap>
            <span>账单明细</span>
            <Text type="secondary" style={{ fontSize: 12 }}>
              共 {total} 条{selected.length > 0 ? `，已选 ${selected.length} 条` : ''}
            </Text>
          </Space>
        }
        extra={
          <Space wrap>
            <Select
              allowClear
              placeholder="小区"
              style={{ width: 150 }}
              value={communityId}
              onChange={setCommunityId}
              options={withOptionTitles(communities.map((c) => ({ value: c.id, label: c.name })))}
              {...searchableWideSelectProps}
            />
            <Select
              allowClear
              placeholder="费用项目"
              style={{ width: 130 }}
              value={feeCode}
              onChange={setFeeCode}
              options={FEE_OPTIONS}
            />
            <Select
              allowClear
              placeholder="状态"
              style={{ width: 110 }}
              value={status}
              onChange={setStatus}
              options={Object.entries(FEE_BILL_STATUS_LABELS).map(([value, label]) => ({ value, label }))}
            />
            <DatePicker.RangePicker
              picker="month"
              placeholder={['起始账期', '截止账期']}
              value={periodRange as any}
              onChange={(v) => setPeriodRange(v as any)}
              style={{ width: 240 }}
            />
            {/* 账期是这笔钱属于哪个月，收费时间是实际收到钱的那天，12 月的账可能 1 月才收 */}
            <DatePicker.RangePicker
              placeholder={['起始收费日', '截止收费日']}
              value={paidRange as any}
              onChange={(v) => setPaidRange(v as any)}
              style={{ width: 260 }}
            />
            <Select
              allowClear
              placeholder="收款方式"
              style={{ width: 120 }}
              value={paymentMethod}
              onChange={setPaymentMethod}
              options={FEE_PAYMENT_METHODS.map((item) => ({ value: item.value, label: item.label }))}
            />
            <Input
              placeholder="房号 / 业主 / 收据号"
              prefix={<SearchOutlined />}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onPressEnter={load}
              allowClear
              style={{ width: 200 }}
            />
            <Button icon={<ReloadOutlined />} onClick={load}>刷新</Button>
            <Button icon={<DownloadOutlined />} loading={exporting} onClick={exportBills}>
              导出 Excel
            </Button>
            {canEdit && (
              <>
                <Button icon={<ThunderboltOutlined />} onClick={() => setGenerateOpen(true)}>
                  按标准生成
                </Button>
                <Button icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>新增账单</Button>
                <Button
                  type="primary"
                  disabled={!selectedUnpaid.length}
                  onClick={() => setPayOpen(true)}
                >
                  登记收款{selectedUnpaid.length ? `（${formatFeeMoney(selectedAmount)}）` : ''}
                </Button>
              </>
            )}
          </Space>
        }
      >
        {canEdit && selected.length > 0 && (
          <Space style={{ marginBottom: 12 }} wrap>
            <Popconfirm
              title="撤销这些账单的收款？"
              description="账单会回到「未缴」，收据号与收款方式清空。收错款、退款时用。"
              okText="撤销收款"
              okButtonProps={{ danger: true }}
              onConfirm={() => bulk('/fees/bills/unpay', '撤销收款')}
            >
              <Button size="small" danger>撤销收款</Button>
            </Popconfirm>
            <Button
              size="small"
              onClick={() =>
                modal.confirm({
                  title: `作废选中的 ${selected.length} 条账单？`,
                  content: '作废的账单不计入应收与欠费统计，记录保留、可恢复。用于免收或误生成。',
                  okText: '作废',
                  okButtonProps: { danger: true },
                  onOk: () => bulk('/fees/bills/cancel', '作废'),
                })
              }
            >
              作废
            </Button>
            <Button size="small" onClick={() => bulk('/fees/bills/restore', '恢复')}>恢复作废</Button>
          </Space>
        )}

        <Table<BillRow>
          rowKey="id"
          size="middle"
          loading={loading}
          dataSource={rows}
          tableLayout="fixed"
          scroll={{ x: 1830 }}
          rowSelection={{
            selectedRowKeys: selected.map((r) => r.id),
            onChange: (_keys, sel) => setSelected(sel),
            preserveSelectedRowKeys: false,
          }}
          pagination={{
            current: page,
            pageSize,
            total,
            showSizeChanger: true,
            pageSizeOptions: [20, 50, 100, 200],
            showTotal: (t) => `共 ${t} 条`,
            onChange: (p, ps) => { setPage(p); setPageSize(ps); },
          }}
          columns={[
            {
              title: '房号', key: 'place', width: 240, fixed: 'left',
              render: (_, r) => (
                <Button type="link" size="small" style={{ padding: 0 }} onClick={() => onOpenHouse(r.houseId)}>
                  <span title={placeText(r)} style={{ display: 'inline-block', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {placeText(r)}
                  </span>
                </Button>
              ),
            },
            {
              title: '业主', dataIndex: 'ownerName', width: 100, ellipsis: true,
              render: (v) => v || <Text type="secondary">-</Text>,
            },
            {
              title: '项目', dataIndex: 'feeName', width: 120, ellipsis: true,
              render: (v: string, r) => (
                <span title={r.vehiclePlate ? `${v}（${r.vehiclePlate}）` : v}>
                  {v}
                  {r.vehiclePlate && (
                    <>
                      <br />
                      <Text type="secondary" style={{ fontSize: 12 }}>{r.vehiclePlate}</Text>
                    </>
                  )}
                </span>
              ),
            },
            {
              // 账期和服务期间是同一件事的粗细两档，并一列既省 170px，也省得对着两列猜区别
              title: '账期', dataIndex: 'period', width: 160,
              render: (v: string, r) => (
                <span>
                  {formatFeePeriod(v)}
                  {serviceText(r) && (
                    <>
                      <br />
                      <Text type="secondary" style={{ fontSize: 12 }}>{serviceText(r)}</Text>
                    </>
                  )}
                </span>
              ),
            },
            {
              title: '数量 / 单价', key: 'qty', width: 120, align: 'right',
              render: (_, r) =>
                r.quantity === null && r.unitPriceCents === null ? (
                  <Text type="secondary">-</Text>
                ) : (
                  <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                    {r.quantity ?? '-'}
                    {r.unit || ''}
                    <br />
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {r.unitPriceCents === null ? '-' : formatFeeMoney(r.unitPriceCents)}
                    </Text>
                  </span>
                ),
            },
            {
              title: '金额', dataIndex: 'amountCents', width: 110, align: 'right',
              render: (v: number) => <span style={{ fontVariantNumeric: 'tabular-nums' }}>{formatFeeMoney(v)}</span>,
            },
            {
              title: '状态', dataIndex: 'status', width: 90,
              render: (v: FeeBillStatus) => <Tag color={STATUS_COLOR[v]}>{FEE_BILL_STATUS_LABELS[v]}</Tag>,
            },
            {
              title: '收款日期', dataIndex: 'paidAt', width: 110,
              render: (v: string | null) => (v ? dayjs(v).format('YYYY-MM-DD') : '-'),
            },
            {
              title: '收款方式', dataIndex: 'paymentMethod', width: 110,
              render: (v: string | null) => (v ? FEE_PAYMENT_METHOD_LABELS[v] || v : '-'),
            },
            { title: '收据号', dataIndex: 'receiptNo', width: 140, ellipsis: true, render: (v) => v || '-' },
            {
              title: '收费员', dataIndex: 'cashier', width: 90, ellipsis: true,
              render: (v: string | null) => v || <Text type="secondary">-</Text>,
            },
            {
              title: '来源', dataIndex: 'source', width: 110,
              render: (v: string) => <Text type="secondary">{FEE_BILL_SOURCE_LABELS[v] || v}</Text>,
            },
            {
              title: '备注', dataIndex: 'remark', width: 160, ellipsis: true,
              render: (v: string | null) => (v ? <span title={v}>{v}</span> : '-'),
            },
            {
              title: '操作', key: 'op', width: 120, fixed: 'right',
              render: (_, r) => (
                <Space size={0}>
                  {canEdit && (
                    <Button type="link" size="small" icon={<EditOutlined />} onClick={() => setEditing(r)}>
                      编辑
                    </Button>
                  )}
                  {canDelete && r.status !== FeeBillStatus.PAID && (
                    <Popconfirm title="删除这条账单？" okText="删除" okButtonProps={{ danger: true }} onConfirm={() => removeBill(r)}>
                      <Button type="link" size="small" danger>删除</Button>
                    </Popconfirm>
                  )}
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <PayModal
        open={payOpen}
        bills={selectedUnpaid}
        onClose={() => setPayOpen(false)}
        onDone={() => { setPayOpen(false); load(); }}
      />
      <BillFormModal
        open={createOpen || !!editing}
        target={editing}
        onClose={() => { setCreateOpen(false); setEditing(null); }}
        onDone={() => { setCreateOpen(false); setEditing(null); load(); }}
      />
      <GenerateModal
        open={generateOpen}
        communities={communities}
        onClose={() => setGenerateOpen(false)}
        onDone={() => { setGenerateOpen(false); load(); }}
      />
    </div>
  );
}

// ====================================================================
// 收费报表
// ====================================================================

/** 趋势桶的横轴文字：按周显示「某日那周」，按月只显示年月 */
function bucketText(bucket: string, granularity: Granularity) {
  if (granularity === 'month') return dayjs(bucket).format('YYYY年MM月');
  if (granularity === 'week') return `${dayjs(bucket).format('MM-DD')} 起那周`;
  return bucket;
}

/** 环比：上期为 0 时后端给 null，这里如实说「上期无收款」而不是写 0% */
function GrowthText({ value }: { value: number | null }) {
  if (value === null) return <Text type="secondary" style={{ fontSize: 12 }}>上期无收款</Text>;
  const up = value >= 0;
  return (
    <Text style={{ fontSize: 12, color: up ? '#3f8600' : '#cf1322' }}>
      环比 {up ? '↑' : '↓'} {Math.abs(value)}%
    </Text>
  );
}

/** 分布表：收款方式 / 费用项目 / 小区 / 收费员四块共用一套列 */
function BreakdownCard({
  title, rows, nameTitle, loading,
}: {
  title: string;
  nameTitle: string;
  loading: boolean;
  rows: Array<{ key: string; name: string; amountCents: number; count: number; share: number | null }>;
}) {
  const peak = Math.max(1, ...rows.map((r) => Math.abs(r.amountCents)));
  return (
    <Card size="small" title={title}>
      <Table
        rowKey="key"
        size="small"
        loading={loading}
        dataSource={rows}
        pagination={false}
        scroll={{ y: 260 }}
        columns={[
          { title: nameTitle, dataIndex: 'name', ellipsis: true },
          {
            title: '实收',
            dataIndex: 'amountCents',
            align: 'right' as const,
            width: 110,
            render: (v: number) => formatFeeMoney(v),
          },
          { title: '笔数', dataIndex: 'count', align: 'right' as const, width: 70 },
          {
            title: '占比',
            key: 'share',
            width: 120,
            render: (_: unknown, r: { amountCents: number; share: number | null }) => (
              <Space size={4}>
                {/* 负数（红冲）不画条，免得出现一根反向的进度条 */}
                <Progress
                  percent={r.amountCents > 0 ? Math.round((r.amountCents / peak) * 100) : 0}
                  showInfo={false}
                  size="small"
                  style={{ width: 54, marginBottom: 0 }}
                />
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {r.share === null ? '—' : `${r.share}%`}
                </Text>
              </Space>
            ),
          },
        ]}
      />
    </Card>
  );
}

function ReportTab() {
  const { message } = AntdApp.useApp();
  const communities = useCommunities();

  const [range, setRange] = useState<[dayjs.Dayjs, dayjs.Dayjs]>(
    () => [dayjs().startOf('month'), dayjs()],
  );
  const [communityId, setCommunityId] = useState<number | undefined>();
  const [feeCode, setFeeCode] = useState<string | undefined>();
  const [paymentMethod, setPaymentMethod] = useState<string | undefined>();
  const [granularity, setGranularity] = useState<Granularity>('day');
  const [data, setData] = useState<FeeReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);

  const query = useMemo(
    () => ({
      from: range[0].format('YYYY-MM-DD'),
      to: range[1].format('YYYY-MM-DD'),
      communityId,
      feeCode,
      paymentMethod,
      granularity,
    }),
    [range, communityId, feeCode, paymentMethod, granularity],
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await request<FeeReport>({ url: '/fees/reports/summary', query }));
    } catch (e: any) {
      message.error(e?.message || '加载失败');
    } finally {
      setLoading(false);
    }
  }, [message, query]);

  useEffect(() => { load(); }, [load]);

  const totals = data?.totals;
  const methodRows = (data?.byMethod ?? []).map((r) => ({
    key: r.method ?? 'unknown',
    name: r.method ? FEE_PAYMENT_METHOD_LABELS[r.method] || r.method : '未记录',
    amountCents: r.amountCents,
    count: r.count,
    share: r.share,
  }));
  const feeRows = (data?.byFee ?? []).map((r) => ({
    key: r.feeCode,
    name: r.feeName || r.feeCode,
    amountCents: r.amountCents,
    count: r.count,
    share: r.share,
  }));
  const communityRows = (data?.byCommunity ?? []).map((r) => ({
    key: String(r.communityId ?? 'unknown'),
    name: r.communityName || '未知小区',
    amountCents: r.amountCents,
    count: r.count,
    share: r.share,
  }));
  const cashierRows = (data?.byCashier ?? []).map((r) => ({
    key: r.cashier ?? 'unknown',
    name: r.cashier || '未记录',
    amountCents: r.amountCents,
    count: r.count,
    share: r.share,
  }));

  const exportReport = async () => {
    if (!data) return;
    setExporting(true);
    try {
      const slice = (name: string, nameTitle: string, rows: typeof methodRows) => ({
        name,
        columns: [
          { title: nameTitle, key: 'name' },
          { title: '实收(元)', key: 'amount', render: (r: typeof rows[number]) => centsToYuan(r.amountCents) },
          { title: '笔数', key: 'count' },
          { title: '占比(%)', key: 'share', render: (r: typeof rows[number]) => r.share ?? '' },
        ],
        rows,
      });
      await exportXlsx(`收费报表_${query.from}_${query.to}`, [
        {
          name: '总览',
          columns: [{ title: '指标', key: 'k' }, { title: '本期', key: 'v' }, { title: '上期', key: 'p' }],
          rows: [
            { k: '统计区间', v: `${data.range.from} ~ ${data.range.to}`, p: `${data.previousRange.from} ~ ${data.previousRange.to}` },
            { k: '实收合计(元)', v: centsToYuan(data.totals.netCents), p: centsToYuan(data.previous.netCents) },
            { k: '收款小计(元)', v: centsToYuan(data.totals.chargedCents), p: centsToYuan(data.previous.chargedCents) },
            { k: '红冲冲减(元)', v: centsToYuan(data.totals.refundedCents), p: centsToYuan(data.previous.refundedCents) },
            { k: '收款笔数', v: data.totals.receiptCount, p: data.previous.receiptCount },
            { k: '收费户数', v: data.totals.houseCount, p: data.previous.houseCount },
            { k: '收费明细条数', v: data.totals.itemCount, p: data.previous.itemCount },
          ],
        },
        {
          name: '趋势',
          columns: [
            { title: granularity === 'month' ? '月份' : granularity === 'week' ? '周起始日' : '日期', key: 'bucket' },
            { title: '实收(元)', key: 'amount', render: (r: FeeReport['trend'][number]) => centsToYuan(r.amountCents) },
            { title: '笔数', key: 'count' },
          ],
          rows: data.trend,
        },
        slice('收款方式', '收款方式', methodRows),
        slice('费用项目', '费用项目', feeRows),
        slice('小区', '小区', communityRows),
        slice('收费员', '收费员', cashierRows),
      ]);
      message.success('已导出收费报表');
    } catch (e: any) {
      message.error(e?.message || '导出失败');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div>
      <Card size="small" style={{ marginBottom: 16 }}>
        <Space wrap>
          {/* 报表按「钱哪天收到」统计，和账期无关 */}
          <DatePicker.RangePicker
            allowClear={false}
            value={range}
            onChange={(v) => { if (v?.[0] && v?.[1]) setRange([v[0], v[1]]); }}
            presets={[
              { label: '本月', value: [dayjs().startOf('month'), dayjs()] },
              { label: '上月', value: [dayjs().subtract(1, 'month').startOf('month'), dayjs().subtract(1, 'month').endOf('month')] },
              { label: '近 30 天', value: [dayjs().subtract(29, 'day'), dayjs()] },
              { label: '本年', value: [dayjs().startOf('year'), dayjs()] },
            ]}
            style={{ width: 260 }}
          />
          <Select
            allowClear
            placeholder="小区"
            style={{ width: 150 }}
            value={communityId}
            onChange={setCommunityId}
            options={withOptionTitles(communities.map((c) => ({ value: c.id, label: c.name })))}
            {...searchableWideSelectProps}
          />
          <Select
            allowClear
            placeholder="费用项目"
            style={{ width: 130 }}
            value={feeCode}
            onChange={setFeeCode}
            options={FEE_OPTIONS}
          />
          <Select
            allowClear
            placeholder="收款方式"
            style={{ width: 120 }}
            value={paymentMethod}
            onChange={setPaymentMethod}
            options={FEE_PAYMENT_METHODS.map((item) => ({ value: item.value, label: item.label }))}
          />
          <Segmented
            value={granularity}
            onChange={(v) => setGranularity(v as Granularity)}
            options={[
              { value: 'day', label: '按日' },
              { value: 'week', label: '按周' },
              { value: 'month', label: '按月' },
            ]}
          />
          <Button icon={<ReloadOutlined />} onClick={load}>刷新</Button>
          <Button icon={<DownloadOutlined />} loading={exporting} disabled={!data} onClick={exportReport}>
            导出 Excel
          </Button>
        </Space>
      </Card>

      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col xs={12} md={6}>
          <Card size="small" loading={loading}>
            <Statistic
              title="实收合计"
              value={formatFeeMoney(totals?.netCents)}
              valueStyle={{ color: '#3f8600' }}
            />
            <GrowthText value={data?.growth.netCents ?? null} />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small" loading={loading}>
            <Statistic title="收款笔数" value={totals?.receiptCount ?? 0} />
            <GrowthText value={data?.growth.receiptCount ?? null} />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small" loading={loading}>
            <Statistic title="收费户数" value={totals?.houseCount ?? 0} />
            <GrowthText value={data?.growth.houseCount ?? null} />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small" loading={loading}>
            <Statistic
              title="红冲冲减"
              value={formatFeeMoney(totals?.refundedCents)}
              valueStyle={{ color: totals?.refundedCents ? '#cf1322' : undefined }}
            />
            {/* 实收 = 收款小计 − 红冲冲减，三个数摆在一起才看得懂为什么合计少了 */}
            <Text type="secondary" style={{ fontSize: 12 }}>
              收款小计 {formatFeeMoney(totals?.chargedCents)}
            </Text>
          </Card>
        </Col>
      </Row>

      <Card
        size="small"
        title="实收趋势"
        extra={
          <Text type="secondary" style={{ fontSize: 12 }}>
            按收款日期统计（{data?.range.from} ~ {data?.range.to}），上期 {data?.previousRange.from} ~ {data?.previousRange.to}
          </Text>
        }
        style={{ marginBottom: 16 }}
      >
        <Table<FeeReport['trend'][number]>
          rowKey="bucket"
          size="small"
          loading={loading}
          dataSource={data?.trend ?? []}
          pagination={{ pageSize: 31, showSizeChanger: false, hideOnSinglePage: true }}
          columns={[
            {
              title: granularity === 'month' ? '月份' : granularity === 'week' ? '周' : '日期',
              dataIndex: 'bucket',
              width: 160,
              render: (v: string) => bucketText(v, granularity),
            },
            {
              title: '实收',
              dataIndex: 'amountCents',
              width: 130,
              align: 'right' as const,
              render: (v: number) => (
                <span style={{ color: v < 0 ? '#cf1322' : undefined }}>{formatFeeMoney(v)}</span>
              ),
            },
            { title: '笔数', dataIndex: 'count', width: 80, align: 'right' as const },
            {
              title: '',
              key: 'bar',
              render: (_: unknown, r) => {
                const peak = Math.max(1, ...(data?.trend ?? []).map((t) => Math.abs(t.amountCents)));
                return (
                  <Progress
                    percent={r.amountCents > 0 ? Math.round((r.amountCents / peak) * 100) : 0}
                    showInfo={false}
                    size="small"
                    strokeColor={r.amountCents < 0 ? '#cf1322' : undefined}
                    style={{ marginBottom: 0 }}
                  />
                );
              },
            },
          ]}
        />
      </Card>

      <Row gutter={[16, 16]}>
        {/* 两列并排时名字列只剩两百来像素，「微信」会被省略成「微…」，
            所以 1200px 以下一行只放一块 */}
        <Col xs={24} xl={12}>
          <BreakdownCard title="按收款方式" nameTitle="收款方式" rows={methodRows} loading={loading} />
        </Col>
        <Col xs={24} xl={12}>
          <BreakdownCard title="按费用项目" nameTitle="费用项目" rows={feeRows} loading={loading} />
        </Col>
        <Col xs={24} xl={12}>
          <BreakdownCard title="按小区" nameTitle="小区" rows={communityRows} loading={loading} />
        </Col>
        <Col xs={24} xl={12}>
          <BreakdownCard title="按收费员" nameTitle="收费员" rows={cashierRows} loading={loading} />
        </Col>
      </Row>
    </div>
  );
}

// ====================================================================
// 欠费催缴
// ====================================================================
function ArrearsTab({ onOpenHouse }: { onOpenHouse: (houseId: number) => void }) {
  const { message } = AntdApp.useApp();
  const communities = useCommunities();
  const [rows, setRows] = useState<ArrearRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState('');
  const [communityId, setCommunityId] = useState<number | undefined>();
  const [feeCode, setFeeCode] = useState<string | undefined>();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await request<Paged<ArrearRow>>({
        url: '/fees/arrears',
        query: { q: q || undefined, communityId, feeCode, page, pageSize },
      });
      setRows(data.rows);
      setTotal(data.total);
    } catch (e: any) {
      message.error(e?.message || '加载失败');
    } finally {
      setLoading(false);
    }
  }, [message, q, communityId, feeCode, page, pageSize]);

  useEffect(() => { load(); }, [load]);

  const totalUnpaid = rows.reduce((sum, r) => sum + r.unpaidCents, 0);

  return (
    <Card
      title={
        <Space size={6} wrap>
          <span>欠费户</span>
          <Text type="secondary" style={{ fontSize: 12 }}>
            共 {total} 户，本页合计 {formatFeeMoney(totalUnpaid)}
          </Text>
        </Space>
      }
      extra={
        <Space wrap>
          <Select
            allowClear
            placeholder="小区"
            style={{ width: 150 }}
            value={communityId}
            onChange={(v) => { setCommunityId(v); setPage(1); }}
            options={withOptionTitles(communities.map((c) => ({ value: c.id, label: c.name })))}
            {...searchableWideSelectProps}
          />
          <Select
            allowClear
            placeholder="费用项目"
            style={{ width: 130 }}
            value={feeCode}
            onChange={(v) => { setFeeCode(v); setPage(1); }}
            options={FEE_OPTIONS}
          />
          <Input
            placeholder="房号 / 业主 / 电话"
            prefix={<SearchOutlined />}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onPressEnter={() => { setPage(1); load(); }}
            allowClear
            style={{ width: 200 }}
          />
          <Button icon={<ReloadOutlined />} onClick={load}>刷新</Button>
        </Space>
      }
    >
      <Table<ArrearRow>
        rowKey="houseId"
        size="middle"
        loading={loading}
        dataSource={rows}
        tableLayout="fixed"
        scroll={{ x: 1100 }}
        pagination={{
          current: page,
          pageSize,
          total,
          showSizeChanger: true,
          pageSizeOptions: [20, 50, 100, 200],
          showTotal: (t) => `共 ${t} 户`,
          onChange: (p, ps) => { setPage(p); setPageSize(ps); },
        }}
        columns={[
          {
            title: '房号', key: 'place', width: 260, fixed: 'left',
            render: (_, r) => (
              <span title={placeText(r)} style={{ display: 'inline-block', maxWidth: 250, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {placeText(r)}
              </span>
            ),
          },
          { title: '业主', dataIndex: 'ownerName', width: 110, ellipsis: true, render: (v) => v || <Text type="secondary">未建档</Text> },
          {
            // 催缴要打电话，没号码就直接说明「去业主档案补」，别让人对着空格发呆
            title: '电话', dataIndex: 'ownerPhone', width: 130,
            render: (v: string | null) => v || <Text type="secondary">无号码</Text>,
          },
          { title: '欠费笔数', dataIndex: 'billCount', width: 100, align: 'right' },
          {
            title: '欠费金额', dataIndex: 'unpaidCents', width: 130, align: 'right',
            render: (v: number) => (
              <span style={{ fontVariantNumeric: 'tabular-nums', color: '#cf1322', fontWeight: 600 }}>
                {formatFeeMoney(v)}
              </span>
            ),
          },
          {
            title: '欠费区间', key: 'range', width: 180,
            render: (_, r) => `${formatFeePeriod(r.earliestPeriod)} 至 ${formatFeePeriod(r.latestPeriod)}`,
          },
          {
            title: '操作', key: 'op', width: 100, fixed: 'right',
            render: (_, r) => (
              <Button type="link" size="small" onClick={() => onOpenHouse(r.houseId)}>查看明细</Button>
            ),
          },
        ]}
      />
    </Card>
  );
}

// ====================================================================
// 收费标准
// ====================================================================
function StandardsTab({ onOpenHouse }: { onOpenHouse: (houseId: number) => void }) {
  const { message } = AntdApp.useApp();
  const { canEdit, canDelete } = usePagePerm('fees');
  const communities = useCommunities();
  const [rows, setRows] = useState<StandardRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState('');
  const [communityId, setCommunityId] = useState<number | undefined>();
  const [feeCode, setFeeCode] = useState<string | undefined>();
  const [status, setStatus] = useState<FeeStandardStatus>(FeeStandardStatus.ACTIVE);
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<StandardRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await request<Paged<StandardRow>>({
        url: '/fees/standards',
        query: { q: q || undefined, communityId, feeCode, status, page, pageSize },
      });
      setRows(data.rows);
      setTotal(data.total);
    } catch (e: any) {
      message.error(e?.message || '加载失败');
    } finally {
      setLoading(false);
    }
  }, [message, q, communityId, feeCode, status, page, pageSize]);

  useEffect(() => { load(); }, [load]);

  const remove = async (r: StandardRow) => {
    try {
      await request({ method: 'DELETE', url: `/fees/standards/${r.id}` });
      message.success('已删除');
      load();
    } catch (e: any) {
      if (handleGone(e, message, '这条收费标准', load)) return;
      message.error(e?.message || '删除失败');
    }
  };

  return (
    <Card
      title={
        <Space size={6} wrap>
          <span>每户收费标准</span>
          <Text type="secondary" style={{ fontSize: 12 }}>共 {total} 条</Text>
        </Space>
      }
      extra={
        <Space wrap>
          <Select
            allowClear
            placeholder="小区"
            style={{ width: 150 }}
            value={communityId}
            onChange={(v) => { setCommunityId(v); setPage(1); }}
            options={withOptionTitles(communities.map((c) => ({ value: c.id, label: c.name })))}
            {...searchableWideSelectProps}
          />
          <Select
            allowClear
            placeholder="费用项目"
            style={{ width: 130 }}
            value={feeCode}
            onChange={(v) => { setFeeCode(v); setPage(1); }}
            options={FEE_OPTIONS}
          />
          <Select
            value={status}
            style={{ width: 120 }}
            onChange={(v) => { setStatus(v); setPage(1); }}
            options={[
              { value: FeeStandardStatus.ACTIVE, label: '当前生效' },
              { value: FeeStandardStatus.HISTORY, label: '历史标准' },
            ]}
          />
          <Input
            placeholder="房号 / 业主"
            prefix={<SearchOutlined />}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onPressEnter={() => { setPage(1); load(); }}
            allowClear
            style={{ width: 180 }}
          />
          <Button icon={<ReloadOutlined />} onClick={load}>刷新</Button>
          {canEdit && (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
              新增标准
            </Button>
          )}
        </Space>
      }
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="标准按户登记：同一小区里商品房、售后公房、商铺、有减免的各不相同，所以不设小区统一单价。"
        description="给同一户同一项目新增标准时，原来那条会自动转为「历史标准」并封上失效日期，不会两条同时生效。"
      />
      <Table<StandardRow>
        rowKey="id"
        size="middle"
        loading={loading}
        dataSource={rows}
        tableLayout="fixed"
        scroll={{ x: 1400 }}
        pagination={{
          current: page,
          pageSize,
          total,
          showSizeChanger: true,
          pageSizeOptions: [20, 50, 100, 200],
          showTotal: (t) => `共 ${t} 条`,
          onChange: (p, ps) => { setPage(p); setPageSize(ps); },
        }}
        columns={[
          {
            title: '房号', key: 'place', width: 250, fixed: 'left',
            render: (_, r) => (
              <Button type="link" size="small" style={{ padding: 0 }} onClick={() => onOpenHouse(r.houseId)}>
                <span title={placeText(r)} style={{ display: 'inline-block', maxWidth: 230, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {placeText(r)}
                </span>
              </Button>
            ),
          },
          { title: '业主', dataIndex: 'ownerName', width: 100, ellipsis: true, render: (v) => v || <Text type="secondary">-</Text> },
          { title: '面积(m²)', dataIndex: 'areaSqm', width: 90, align: 'right', render: (v) => v || '-' },
          { title: '项目', dataIndex: 'feeName', width: 110, ellipsis: true },
          {
            title: '月标准', dataIndex: 'amountCents', width: 110, align: 'right',
            render: (v: number) => <span style={{ fontVariantNumeric: 'tabular-nums' }}>{formatFeeMoney(v)}</span>,
          },
          {
            // 有签报减免的户，实收低于原标准；两个数并排才看得出这户为什么少收
            title: '原标准', dataIndex: 'standardCents', width: 110, align: 'right',
            render: (v: number | null, r) =>
              v == null || v === r.amountCents
                ? <Text type="secondary">-</Text>
                : <span style={{ fontVariantNumeric: 'tabular-nums' }} title="签报调整前的标准">{formatFeeMoney(v)}</span>,
          },
          { title: '生效日期', dataIndex: 'effectiveFrom', width: 110 },
          { title: '失效日期', dataIndex: 'effectiveTo', width: 110, render: (v) => v || '-' },
          { title: '依据文号', dataIndex: 'docNo', width: 140, ellipsis: true, render: (v) => v || '-' },
          {
            title: '操作', key: 'op', width: 120, fixed: 'right',
            render: (_, r) => (
              <Space size={0}>
                {canEdit && (
                  <Button type="link" size="small" icon={<EditOutlined />} onClick={() => setEditing(r)}>编辑</Button>
                )}
                {canDelete && (
                  <Popconfirm title="删除这条收费标准？" okText="删除" okButtonProps={{ danger: true }} onConfirm={() => remove(r)}>
                    <Button type="link" size="small" danger>删除</Button>
                  </Popconfirm>
                )}
              </Space>
            ),
          },
        ]}
      />

      <StandardFormModal
        open={createOpen || !!editing}
        target={editing}
        onClose={() => { setCreateOpen(false); setEditing(null); }}
        onDone={() => { setCreateOpen(false); setEditing(null); load(); }}
      />
    </Card>
  );
}

// ====================================================================
// 房号搜索（新增账单 / 新增标准共用）
// ====================================================================
interface HouseOption {
  id: number;
  roomNo: string;
  lane: string | null;
  buildingNo: string;
  communityName: string;
  owner: { id: number; name: string | null; phone: string | null } | null;
}

function useHouseSearch() {
  const [options, setOptions] = useState<HouseOption[]>([]);
  const [searching, setSearching] = useState(false);
  const search = useMemo(() => {
    let timer: any = null;
    return (kw: string) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(async () => {
        const value = kw.trim();
        if (!value) return;
        setSearching(true);
        try {
          setOptions(await request<HouseOption[]>({ url: '/houses', query: { q: value } }));
        } catch {
          /* 搜不到就保持原列表，不打断输入 */
        } finally {
          setSearching(false);
        }
      }, 250);
    };
  }, []);
  return { options, searching, search, setOptions };
}

function houseOptionLabel(h: HouseOption) {
  const base = placeText(h);
  return h.owner?.name ? `${base} · ${h.owner.name}` : base;
}

// ====================================================================
// 登记收款
// ====================================================================
function PayModal({
  open, bills, onClose, onDone,
}: {
  open: boolean;
  bills: BillRow[];
  onClose: () => void;
  onDone: () => void;
}) {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      form.resetFields();
      form.setFieldsValue({ paymentMethod: 'cash', paidAt: dayjs() });
    }
  }, [open, form]);

  const amount = bills.reduce((sum, b) => sum + b.amountCents, 0);
  const houses = Array.from(new Set(bills.map((b) => b.houseId)));

  const onOk = async () => {
    const v = await form.validateFields();
    setSaving(true);
    try {
      const res = await request<any>({
        method: 'POST',
        url: '/fees/bills/pay',
        data: {
          ids: bills.map((b) => b.id),
          paidAt: v.paidAt ? dayjs(v.paidAt).format('YYYY-MM-DD') : undefined,
          paymentMethod: v.paymentMethod,
          receiptNo: v.receiptNo || undefined,
          invoiceNo: v.invoiceNo || undefined,
          remark: v.remark || undefined,
        },
      });
      message.success(`已登记收款 ${res.paidCount} 条，收据号 ${res.receiptNo}`);
      onDone();
    } catch (e: any) {
      message.error(e?.message || '登记收款失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title="登记收款"
      open={open}
      onCancel={onClose}
      onOk={onOk}
      confirmLoading={saving}
      destroyOnHidden
      width={560}
      okText="确认收款"
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message={`共 ${bills.length} 条账单、${houses.length} 户，合计 ${formatFeeMoney(amount)}`}
        description={
          houses.length > 1
            ? '选中的账单跨了多户，会共用同一个收据号。通常一张收据只对一户，确认这是你要的。'
            : '这一批账单共用一个收据号，收据号留空则自动生成。'
        }
      />
      <Form form={form} layout="vertical">
        <Row gutter={12}>
          <Col span={12}>
            <Form.Item name="paidAt" label="收款日期" rules={[{ required: true, message: '请选择收款日期' }]}>
              <DatePicker style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="paymentMethod" label="收款方式" rules={[{ required: true, message: '请选择收款方式' }]}>
              <Select options={FEE_PAYMENT_METHODS.map((m) => ({ value: m.value, label: m.label }))} />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="receiptNo" label="收据号（留空自动生成）">
              <Input maxLength={60} placeholder="如 SJ202608260001" />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="invoiceNo" label="发票号（选填）">
              <Input maxLength={60} />
            </Form.Item>
          </Col>
          <Col span={24}>
            <Form.Item name="remark" label="备注（选填）">
              <Input.TextArea rows={2} maxLength={255} />
            </Form.Item>
          </Col>
        </Row>
      </Form>
    </Modal>
  );
}

// ====================================================================
// 新增 / 编辑账单
// ====================================================================
function BillFormModal({
  open, target, onClose, onDone,
}: {
  open: boolean;
  target?: BillRow | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const { options, searching, search, setOptions } = useHouseSearch();

  useEffect(() => {
    if (!open) return;
    if (target) {
      form.setFieldsValue({
        houseId: target.houseId,
        feeCode: target.feeCode,
        period: dayjs(`${target.period.slice(0, 4)}-${target.period.slice(4)}-01`),
        amountYuan: target.amountCents / 100,
        remark: target.remark ?? undefined,
      });
      setOptions([{
        id: target.houseId,
        roomNo: target.roomNo,
        lane: target.lane,
        buildingNo: target.buildingNo,
        communityName: target.communityName,
        owner: target.ownerName ? { id: target.ownerId ?? 0, name: target.ownerName, phone: null } : null,
      }]);
    } else {
      form.resetFields();
      form.setFieldsValue({ feeCode: 'management', period: dayjs() });
      setOptions([]);
    }
  }, [open, target, form, setOptions]);

  const onOk = async () => {
    const v = await form.validateFields();
    setSaving(true);
    try {
      const payload = {
        houseId: v.houseId,
        feeCode: v.feeCode,
        period: dayjs(v.period).format('YYYYMM'),
        amountCents: Math.round(Number(v.amountYuan) * 100),
        remark: v.remark || undefined,
      };
      if (target) {
        await request({ method: 'PATCH', url: `/fees/bills/${target.id}`, data: payload });
        message.success('已保存');
      } else {
        await request({ method: 'POST', url: '/fees/bills', data: payload });
        message.success('账单已新增');
      }
      onDone();
    } catch (e: any) {
      if (target && handleGone(e, message, '这条账单', onDone)) return;
      message.error(e?.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={target ? `编辑账单：${placeText(target)} · ${target.feeName} ${target.period}` : '新增账单'}
      open={open}
      onCancel={onClose}
      onOk={onOk}
      confirmLoading={saving}
      destroyOnHidden
      width={520}
    >
      <Form form={form} layout="vertical">
        <Form.Item
          name="houseId"
          label="房号"
          rules={[{ required: true, message: '请选择房号' }]}
          extra="可输入小区名、完整地址，或用 198/2/101 格式搜索"
        >
          <Select
            {...searchableWideSelectProps}
            placeholder="如：198/2/101"
            filterOption={false}
            loading={searching}
            disabled={!!target}
            onSearch={search}
            options={withOptionTitles(options.map((h) => ({ value: h.id, label: houseOptionLabel(h) })))}
          />
        </Form.Item>
        <Row gutter={12}>
          <Col span={12}>
            <Form.Item name="feeCode" label="费用项目" rules={[{ required: true }]}>
              <Select options={FEE_OPTIONS} />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="period" label="账期" rules={[{ required: true, message: '请选择账期' }]}>
              <DatePicker picker="month" style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="amountYuan" label="金额（元）" rules={[{ required: true, message: '请填写金额' }]}>
              <InputNumber min={0} precision={2} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col span={24}>
            <Form.Item name="remark" label="备注（选填）">
              <Input.TextArea rows={2} maxLength={255} />
            </Form.Item>
          </Col>
        </Row>
      </Form>
    </Modal>
  );
}

// ====================================================================
// 新增 / 编辑收费标准
// ====================================================================
function StandardFormModal({
  open, target, onClose, onDone,
}: {
  open: boolean;
  target?: StandardRow | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const { options, searching, search, setOptions } = useHouseSearch();

  useEffect(() => {
    if (!open) return;
    if (target) {
      form.setFieldsValue({
        houseId: target.houseId,
        feeCode: target.feeCode,
        amountYuan: target.amountCents / 100,
        standardYuan: target.standardCents == null ? undefined : target.standardCents / 100,
        effectiveFrom: dayjs(target.effectiveFrom),
        docNo: target.docNo ?? undefined,
        remark: target.remark ?? undefined,
      });
      setOptions([{
        id: target.houseId,
        roomNo: target.roomNo,
        lane: target.lane,
        buildingNo: target.buildingNo,
        communityName: target.communityName,
        owner: target.ownerName ? { id: 0, name: target.ownerName, phone: null } : null,
      }]);
    } else {
      form.resetFields();
      form.setFieldsValue({ feeCode: 'management', effectiveFrom: dayjs().startOf('month') });
      setOptions([]);
    }
  }, [open, target, form, setOptions]);

  const onOk = async () => {
    const v = await form.validateFields();
    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
        amountCents: Math.round(Number(v.amountYuan) * 100),
        standardCents: v.standardYuan == null ? null : Math.round(Number(v.standardYuan) * 100),
        effectiveFrom: dayjs(v.effectiveFrom).format('YYYY-MM-DD'),
        docNo: v.docNo || null,
        remark: v.remark || null,
      };
      if (target) {
        await request({ method: 'PATCH', url: `/fees/standards/${target.id}`, data: payload });
        message.success('已保存');
      } else {
        await request({
          method: 'POST',
          url: '/fees/standards',
          data: { ...payload, houseId: v.houseId, feeCode: v.feeCode },
        });
        message.success('收费标准已新增，同户同项目的原标准已转为历史');
      }
      onDone();
    } catch (e: any) {
      if (target && handleGone(e, message, '这条收费标准', onDone)) return;
      message.error(e?.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={target ? `编辑收费标准：${placeText(target)} · ${target.feeName}` : '新增收费标准'}
      open={open}
      onCancel={onClose}
      onOk={onOk}
      confirmLoading={saving}
      destroyOnHidden
      width={520}
    >
      <Form form={form} layout="vertical">
        <Form.Item
          name="houseId"
          label="房号"
          rules={[{ required: true, message: '请选择房号' }]}
          extra="可输入小区名、完整地址，或用 198/2/101 格式搜索"
        >
          <Select
            {...searchableWideSelectProps}
            placeholder="如：198/2/101"
            filterOption={false}
            loading={searching}
            disabled={!!target}
            onSearch={search}
            options={withOptionTitles(options.map((h) => ({ value: h.id, label: houseOptionLabel(h) })))}
          />
        </Form.Item>
        <Row gutter={12}>
          <Col span={12}>
            <Form.Item name="feeCode" label="费用项目" rules={[{ required: true }]}>
              <Select options={FEE_OPTIONS} disabled={!!target} />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="effectiveFrom" label="生效日期" rules={[{ required: true, message: '请选择生效日期' }]}>
              <DatePicker style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="amountYuan" label="每月实收（元）" rules={[{ required: true, message: '请填写金额' }]}>
              <InputNumber min={0} precision={2} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="standardYuan" label="原标准（元，选填）" extra="有减免时填调整前的金额">
              <InputNumber min={0} precision={2} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col span={24}>
            <Form.Item name="docNo" label="依据文号（选填）">
              <Input maxLength={60} placeholder="如 WJWY-2019-0513" />
            </Form.Item>
          </Col>
          <Col span={24}>
            <Form.Item name="remark" label="备注（选填）">
              <Input.TextArea rows={2} maxLength={255} />
            </Form.Item>
          </Col>
        </Row>
      </Form>
    </Modal>
  );
}

// ====================================================================
// 按标准生成账单
// ====================================================================
function GenerateModal({
  open, communities, onClose, onDone,
}: {
  open: boolean;
  communities: CommunityOption[];
  onClose: () => void;
  onDone: () => void;
}) {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      form.resetFields();
      form.setFieldsValue({ period: dayjs() });
    }
  }, [open, form]);

  const onOk = async () => {
    const v = await form.validateFields();
    setSaving(true);
    try {
      const res = await request<any>({
        method: 'POST',
        url: '/fees/bills/generate',
        data: {
          communityId: v.communityId,
          period: dayjs(v.period).format('YYYYMM'),
          feeCode: v.feeCode || undefined,
        },
      });
      if (res.created === 0) {
        message.warning(res.message || `没有新增账单（已存在 ${res.skipped} 条，不会重复生成）`);
      } else {
        message.success(
          `已生成 ${res.created} 条账单，合计 ${formatFeeMoney(res.amountCents)}${
            res.skipped ? `；跳过已存在的 ${res.skipped} 条` : ''
          }`,
        );
      }
      onDone();
    } catch (e: any) {
      message.error(e?.message || '生成失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title="按收费标准生成账单"
      open={open}
      onCancel={onClose}
      onOk={onOk}
      confirmLoading={saving}
      destroyOnHidden
      width={520}
      okText="生成"
    >
      <Alert
        type="warning"
        showIcon
        style={{ marginBottom: 16 }}
        message="按每户「当前生效」的收费标准，为选定小区和账期铺一遍账单。"
        description="同户同项目同账期已有账单的会自动跳过，重复点不会覆盖已收款的账单。"
      />
      <Form form={form} layout="vertical">
        <Form.Item name="communityId" label="小区" rules={[{ required: true, message: '请选择小区' }]}>
          <Select
            placeholder="选择小区"
            options={withOptionTitles(communities.map((c) => ({ value: c.id, label: c.name })))}
            {...searchableWideSelectProps}
          />
        </Form.Item>
        <Form.Item name="period" label="账期" rules={[{ required: true, message: '请选择账期' }]}>
          <DatePicker picker="month" style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item name="feeCode" label="费用项目（留空 = 全部）">
          <Select allowClear placeholder="全部项目" options={FEE_OPTIONS} />
        </Form.Item>
      </Form>
    </Modal>
  );
}

// ====================================================================
// 一户的缴费明细
// ====================================================================

/** 明细弹窗顶部的「标签 + 值」。刻意不用 Statistic —— 见下面电话那一行的注释 */
function DetailField({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div>
      <div style={{ color: 'rgba(0,0,0,.45)', fontSize: 13, marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 16, color, fontVariantNumeric: 'tabular-nums' }} title={value}>
        {value}
      </div>
    </div>
  );
}

function HouseDetailModal({ houseId, onClose }: { houseId: number | null; onClose: () => void }) {
  const { message } = AntdApp.useApp();
  const [data, setData] = useState<HouseDetail | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!houseId) { setData(null); return; }
    setLoading(true);
    request<HouseDetail>({ url: `/fees/houses/${houseId}` })
      .then(setData)
      .catch((e: any) => message.error(e?.message || '加载失败'))
      .finally(() => setLoading(false));
  }, [houseId, message]);

  const house = data?.house;

  return (
    <Modal
      title={house ? `${placeText(house)} 的缴费明细` : '缴费明细'}
      open={!!houseId}
      onCancel={onClose}
      footer={null}
      width={900}
      destroyOnHidden
    >
      {house && (
        <Row gutter={[16, 8]} style={{ marginBottom: 16 }}>
          <Col xs={12} md={6}><DetailField label="业主" value={house.owner?.name || '未建档'} /></Col>
          {/* 电话不能用 Statistic：它会把纯数字串当数值加千分位，13916517940 显示成
              13,916,517,940，看着像坏数据，照着念还打不通（2026-08-27 截图核对时发现） */}
          <Col xs={12} md={6}><DetailField label="电话" value={house.owner?.phone || '无号码'} /></Col>
          <Col xs={12} md={6}><DetailField label="面积" value={house.areaSqm ? `${house.areaSqm} m²` : '-'} /></Col>
          <Col xs={12} md={6}>
            <DetailField
              label="欠费合计"
              value={formatFeeMoney(data?.unpaidCents)}
              color={(data?.unpaidCents || 0) > 0 ? '#cf1322' : undefined}
            />
          </Col>
        </Row>
      )}
      <Tabs
        items={[
          {
            key: 'bills',
            label: `账单（${data?.bills.length ?? 0}）`,
            children: (
              <Table<BillRow>
                rowKey="id"
                size="small"
                loading={loading}
                dataSource={data?.bills ?? []}
                tableLayout="fixed"
                scroll={{ x: 720, y: 380 }}
                pagination={{ pageSize: 24, showSizeChanger: false }}
                columns={[
                  { title: '账期', dataIndex: 'period', width: 90, render: formatFeePeriod },
                  { title: '项目', dataIndex: 'feeName', width: 110, ellipsis: true },
                  {
                    title: '金额', dataIndex: 'amountCents', width: 100, align: 'right',
                    render: (v: number) => <span style={{ fontVariantNumeric: 'tabular-nums' }}>{formatFeeMoney(v)}</span>,
                  },
                  {
                    title: '状态', dataIndex: 'status', width: 90,
                    render: (v: FeeBillStatus) => <Tag color={STATUS_COLOR[v]}>{FEE_BILL_STATUS_LABELS[v]}</Tag>,
                  },
                  {
                    title: '收款日期', dataIndex: 'paidAt', width: 110,
                    render: (v: string | null) => (v ? dayjs(v).format('YYYY-MM-DD') : '-'),
                  },
                  { title: '收据号', dataIndex: 'receiptNo', width: 140, ellipsis: true, render: (v) => v || '-' },
                ]}
              />
            ),
          },
          {
            key: 'standards',
            label: `收费标准（${data?.standards.length ?? 0}）`,
            children: (
              <Table<StandardRow>
                rowKey="id"
                size="small"
                loading={loading}
                dataSource={data?.standards ?? []}
                tableLayout="fixed"
                scroll={{ x: 640 }}
                pagination={false}
                columns={[
                  { title: '项目', dataIndex: 'feeName', width: 110, ellipsis: true },
                  {
                    title: '月标准', dataIndex: 'amountCents', width: 100, align: 'right',
                    render: (v: number) => <span style={{ fontVariantNumeric: 'tabular-nums' }}>{formatFeeMoney(v)}</span>,
                  },
                  { title: '生效', dataIndex: 'effectiveFrom', width: 110 },
                  { title: '失效', dataIndex: 'effectiveTo', width: 110, render: (v) => v || '-' },
                  {
                    title: '状态', dataIndex: 'status', width: 100,
                    render: (v: FeeStandardStatus) =>
                      v === FeeStandardStatus.ACTIVE
                        ? <Tag color="green">当前生效</Tag>
                        : <Tag>历史</Tag>,
                  },
                  { title: '依据文号', dataIndex: 'docNo', width: 140, ellipsis: true, render: (v) => v || '-' },
                ]}
              />
            ),
          },
        ]}
      />
    </Modal>
  );
}
