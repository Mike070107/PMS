import {
  DownloadOutlined,
  InfoCircleOutlined,
  ReloadOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Col,
  DatePicker,
  Input,
  Row,
  Segmented,
  Select,
  Space,
  Statistic,
  Switch,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs, { type Dayjs } from 'dayjs';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { WAREHOUSE_TYPE_LABELS, formatFeeMoney } from '@pms/shared-types';
import { request } from '../lib/api';
import { centsToYuan, exportXlsx, type ExportColumn } from '../lib/exportXlsx';
import { searchableWideSelectProps, withOptionTitles } from '../lib/selectProps';

const { Text } = Typography;

/**
 * 报表查询：工单统计 / 人员统计 / 库存清单 / 材料使用明细。
 * 口径说明写在每个页签的顶部提示里，和后端 reports.service.ts 头注释保持一致。
 * 所有数字由后端 SQL 聚合给出，页面只负责展示与导出，别在这里二次计算口径。
 */

// ---------------------------------------------------------------- 类型

interface ReportOptions {
  communities: Array<{ id: number; name: string; parentId: number | null; officeId: number | null; enabled: boolean }>;
  offices: Array<{ id: number; name: string; enabled: boolean }>;
  warehouses: Array<{ id: number; name: string; type: string; officeId: number | null; communityId: number | null; enabled: boolean }>;
  staff: Array<{ id: number; name: string; status: string; canTakeOrders: boolean }>;
  materials: Array<{ id: number; code: string; name: string; spec: string | null; unit: string; category: string | null; enabled: boolean }>;
  categories: string[];
  today: string;
}

interface AggMetrics {
  total: number;
  completed: number;
  pendingReview: number;
  cancelled: number;
  active: number;
  overdue: number;
  avgHours: number | null;
  feeCents: number;
  materialCostCents: number;
  avgRating: number | null;
  ratingCount: number;
}

interface WorkOrderReportRow extends AggMetrics {
  key: string;
  label: string;
}

interface WorkOrderReport {
  range: { from: string; to: string };
  groupBy: WorkOrderGroupBy;
  summary: AggMetrics;
  rows: WorkOrderReportRow[];
}

interface StaffReportRow extends AggMetrics {
  userId: number;
  name: string;
  phone: string | null;
  accountStatus: string;
  onDuty: boolean;
  skills: string[];
  /** 工种中文（后端按字典翻译好） */
  skillLabels: string[];
  canTakeOrders: boolean;
  completedInRange: number;
  activeNow: number;
}

interface StaffReport {
  range: { from: string; to: string };
  summary: AggMetrics;
  staffCount: number;
  completedInRange: number;
  activeNow: number;
  rows: StaffReportRow[];
}

interface StockReportRow {
  stockId: number;
  warehouseId: number;
  warehouseName: string;
  warehouseType: string;
  materialId: number;
  code: string;
  name: string;
  spec: string | null;
  category: string | null;
  unit: string;
  enabled: boolean;
  qty: number;
  safetyQty: number;
  low: boolean;
  unitCostCents: number;
  costSource: 'lot' | 'default';
  amountCents: number;
}

interface StockReport {
  summary: { skuCount: number; warehouseCount: number; lowCount: number; totalQtyRows: number; totalAmountCents: number };
  byWarehouse: Array<{ warehouseId: number; warehouseName: string; skuCount: number; lowCount: number; amountCents: number }>;
  rows: StockReportRow[];
}

interface MaterialUsageDetailRow {
  id: number;
  usedAt: string;
  workOrderId: number;
  orderNo: string;
  status: string;
  statusLabel: string;
  assigneeId: number | null;
  assigneeName: string;
  communityId: number | null;
  communityName: string;
  materialId: number;
  code: string;
  name: string;
  spec: string | null;
  category: string | null;
  unit: string;
  warehouseId: number | null;
  warehouseName: string;
  qty: number;
  unitCostCents: number;
  amountCents: number;
}

interface MaterialUsageGroupRow {
  key: string;
  label: string;
  lines: number;
  orders: number;
  qty: number | null;
  unit: string | null;
  code: string | null;
  spec: string | null;
  category: string | null;
  amountCents: number;
}

interface MaterialUsageReport {
  range: { from: string; to: string };
  groupBy: MaterialUsageGroupBy;
  summary: { lines: number; orders: number; qty: number; amountCents: number };
  rows: MaterialUsageDetailRow[] | MaterialUsageGroupRow[];
  truncated: boolean;
}

type WorkOrderGroupBy = 'day' | 'assignee' | 'community' | 'repairType' | 'status';
type MaterialUsageGroupBy = 'detail' | 'day' | 'assignee' | 'material' | 'warehouse' | 'community';
type TabKey = 'work-orders' | 'staff' | 'stock' | 'material-usage';

const TAB_KEYS: TabKey[] = ['work-orders', 'staff', 'stock', 'material-usage'];

const WORK_ORDER_GROUP_LABELS: Record<WorkOrderGroupBy, string> = {
  day: '按天',
  assignee: '按维修工',
  community: '按小区',
  repairType: '按报修类型',
  status: '按状态',
};

const MATERIAL_GROUP_LABELS: Record<MaterialUsageGroupBy, string> = {
  detail: '明细',
  day: '按天',
  assignee: '按维修工',
  material: '按材料',
  warehouse: '按仓库',
  community: '按小区',
};

// ---------------------------------------------------------------- 工具

type RangeValue = [Dayjs, Dayjs];

const RANGE_PRESETS: Array<{ label: string; range: () => RangeValue }> = [
  { label: '今天', range: () => [dayjs(), dayjs()] },
  { label: '近 7 天', range: () => [dayjs().subtract(6, 'day'), dayjs()] },
  { label: '本月', range: () => [dayjs().startOf('month'), dayjs()] },
  { label: '上月', range: () => [dayjs().subtract(1, 'month').startOf('month'), dayjs().subtract(1, 'month').endOf('month')] },
  { label: '近 30 天', range: () => [dayjs().subtract(29, 'day'), dayjs()] },
  { label: '近 90 天', range: () => [dayjs().subtract(89, 'day'), dayjs()] },
];

function fmtDate(d: Dayjs): string {
  return d.format('YYYY-MM-DD');
}

function fmtQty(value: number | null | undefined): string {
  if (value === null || value === undefined) return '-';
  const n = Number(value);
  if (!Number.isFinite(n)) return '-';
  return n.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}

function fmtHours(hours: number | null | undefined): string {
  if (hours === null || hours === undefined || !Number.isFinite(hours)) return '-';
  if (hours < 1) return `${Math.round(hours * 60)} 分钟`;
  if (hours < 48) return `${hours.toFixed(1)} 小时`;
  const days = Math.floor(hours / 24);
  const rest = Math.round(hours - days * 24);
  return rest ? `${days} 天 ${rest} 小时` : `${days} 天`;
}

function fmtRating(rating: number | null | undefined, count?: number): string {
  if (rating === null || rating === undefined || !Number.isFinite(rating)) return '-';
  return count ? `${rating.toFixed(1)}（${count} 条）` : rating.toFixed(1);
}

function fmtPct(part: number, total: number): string {
  if (!total) return '-';
  return `${((part / total) * 100).toFixed(1)}%`;
}

function fmtDateTime(iso: string): string {
  const d = dayjs(iso);
  return d.isValid() ? d.format('YYYY-MM-DD HH:mm') : iso;
}

function cellEllipsis(text: string | null | undefined, max = 220) {
  const value = text || '-';
  return (
    <span title={value} style={{ display: 'inline-block', maxWidth: max, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'bottom' }}>
      {value}
    </span>
  );
}

/** 表格里的占比条：用在分组汇总视图，让人一眼看到哪一组占大头 */
function ShareBar({ part, total }: { part: number; total: number }) {
  const pct = total > 0 ? Math.min(100, (part / total) * 100) : 0;
  return (
    <div className="pms-report-share">
      <div className="pms-report-share-track">
        <span style={{ width: `${pct}%` }} />
      </div>
      <span className="pms-report-share-text">{fmtPct(part, total)}</span>
    </div>
  );
}

function MetricTile({ title, value, hint, tone }: { title: string; value: string | number; hint?: string; tone?: 'good' | 'warn' | 'bad' }) {
  const color = tone === 'good' ? '#2f8f5b' : tone === 'warn' ? '#b7791f' : tone === 'bad' ? '#c0392b' : undefined;
  return (
    <Card size="small" className="pms-report-tile">
      <Statistic title={title} value={value} valueStyle={color ? { color } : undefined} />
      {hint && <div className="pms-report-tile-hint">{hint}</div>}
    </Card>
  );
}

function CaliberNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="pms-report-note">
      <InfoCircleOutlined />
      <span>{children}</span>
    </div>
  );
}

function useRangeQuery(range: RangeValue) {
  return useMemo(() => ({ from: fmtDate(range[0]), to: fmtDate(range[1]) }), [range]);
}

// ---------------------------------------------------------------- 页面

export default function ReportsPage() {
  const { message } = AntdApp.useApp();
  const [params, setParams] = useSearchParams();
  const tabParam = params.get('tab') as TabKey | null;
  const tab: TabKey = tabParam && TAB_KEYS.includes(tabParam) ? tabParam : 'work-orders';
  const [options, setOptions] = useState<ReportOptions | null>(null);
  const [range, setRange] = useState<RangeValue>(() => RANGE_PRESETS[4].range());
  const [communityId, setCommunityId] = useState<number | undefined>();

  useEffect(() => {
    request<ReportOptions>({ url: '/reports/options' })
      .then(setOptions)
      .catch((e: any) => message.error(e?.message || '加载筛选项失败'));
  }, [message]);

  const communityOptions = useMemo(
    () =>
      withOptionTitles(
        (options?.communities ?? [])
          .filter((c) => c.enabled)
          .map((c) => ({ value: c.id, label: c.name })),
      ),
    [options],
  );

  const setTab = (next: string) => {
    const nextParams = new URLSearchParams(params);
    nextParams.set('tab', next);
    setParams(nextParams, { replace: true });
  };

  const rangeBar = (extra?: React.ReactNode) => (
    <Space wrap size={[8, 8]} className="pms-report-filters">
      <DatePicker.RangePicker
        allowClear={false}
        value={range}
        onChange={(v) => {
          if (v && v[0] && v[1]) setRange([v[0], v[1]]);
        }}
        disabledDate={(d) => d.isAfter(dayjs().endOf('day'))}
        style={{ width: 250 }}
      />
      <Space size={4} wrap>
        {RANGE_PRESETS.map((p) => {
          const r = p.range();
          const active = fmtDate(r[0]) === fmtDate(range[0]) && fmtDate(r[1]) === fmtDate(range[1]);
          return (
            <Button key={p.label} size="small" type={active ? 'primary' : 'default'} ghost={active} onClick={() => setRange(r)}>
              {p.label}
            </Button>
          );
        })}
      </Space>
      <Select
        allowClear
        placeholder="全部小区"
        style={{ width: 170 }}
        value={communityId}
        onChange={setCommunityId}
        options={communityOptions}
        {...searchableWideSelectProps}
      />
      {extra}
    </Space>
  );

  return (
    <div className="pms-reports">
      <Tabs
        activeKey={tab}
        onChange={setTab}
        destroyInactiveTabPane
        items={[
          {
            key: 'work-orders',
            label: '工单统计',
            children: <WorkOrdersReport range={range} communityId={communityId} options={options} rangeBar={rangeBar} />,
          },
          {
            key: 'staff',
            label: '人员统计',
            children: <StaffReportView range={range} communityId={communityId} rangeBar={rangeBar} />,
          },
          {
            key: 'stock',
            label: '库存清单',
            children: <StockReportView options={options} />,
          },
          {
            key: 'material-usage',
            label: '材料使用明细',
            children: <MaterialUsageReport range={range} communityId={communityId} options={options} rangeBar={rangeBar} />,
          },
        ]}
      />
    </div>
  );
}

// ---------------------------------------------------------------- 工单统计

function WorkOrdersReport({
  range,
  communityId,
  options,
  rangeBar,
}: {
  range: RangeValue;
  communityId?: number;
  options: ReportOptions | null;
  rangeBar: (extra?: React.ReactNode) => React.ReactNode;
}) {
  const { message } = AntdApp.useApp();
  const [groupBy, setGroupBy] = useState<WorkOrderGroupBy>('day');
  const [assigneeId, setAssigneeId] = useState<number | undefined>();
  const [data, setData] = useState<WorkOrderReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const rq = useRangeQuery(range);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await request<WorkOrderReport>({
        url: '/reports/work-orders',
        query: { ...rq, groupBy, communityId, assigneeId },
      });
      setData(res);
    } catch (e: any) {
      message.error(e?.message || '加载工单统计失败');
    } finally {
      setLoading(false);
    }
  }, [rq, groupBy, communityId, assigneeId, message]);

  useEffect(() => { load(); }, [load]);

  const summary = data?.summary;
  const rows = data?.rows ?? [];
  const staffOptions = withOptionTitles((options?.staff ?? []).map((s) => ({ value: s.id, label: s.name })));

  const columns: ColumnsType<WorkOrderReportRow> = [
    { title: WORK_ORDER_GROUP_LABELS[groupBy].replace('按', ''), dataIndex: 'label', key: 'label', width: 170, fixed: 'left', render: (v: string) => cellEllipsis(v, 150) },
    { title: '新增工单', dataIndex: 'total', key: 'total', width: 100, align: 'right' },
    { title: '占比', key: 'share', width: 150, render: (_, r) => <ShareBar part={r.total} total={summary?.total ?? 0} /> },
    { title: '已完成', dataIndex: 'completed', key: 'completed', width: 90, align: 'right' },
    { title: '完成率', key: 'rate', width: 90, align: 'right', render: (_, r) => fmtPct(r.completed, r.total) },
    { title: '待验收', dataIndex: 'pendingReview', key: 'pendingReview', width: 90, align: 'right' },
    { title: '进行中', dataIndex: 'active', key: 'active', width: 90, align: 'right' },
    { title: '已撤单', dataIndex: 'cancelled', key: 'cancelled', width: 90, align: 'right' },
    { title: '超时', dataIndex: 'overdue', key: 'overdue', width: 80, align: 'right', render: (v: number) => (v ? <Text type="danger">{v}</Text> : 0) },
    { title: '平均完成时长', dataIndex: 'avgHours', key: 'avgHours', width: 130, align: 'right', render: (v: number | null) => fmtHours(v) },
    { title: '收费金额', dataIndex: 'feeCents', key: 'feeCents', width: 120, align: 'right', render: (v: number) => formatFeeMoney(v) },
    { title: '材料成本', dataIndex: 'materialCostCents', key: 'materialCostCents', width: 120, align: 'right', render: (v: number) => formatFeeMoney(v) },
    { title: '评分', key: 'rating', width: 110, align: 'right', render: (_, r) => fmtRating(r.avgRating, r.ratingCount) },
  ];

  const onExport = async () => {
    if (!data) return;
    setExporting(true);
    try {
      const metricCols: ExportColumn<WorkOrderReportRow>[] = [
        { title: WORK_ORDER_GROUP_LABELS[groupBy].replace('按', ''), key: 'label' },
        { title: '新增工单', key: 'total' },
        { title: '已完成', key: 'completed' },
        { title: '完成率', key: 'rate', render: (r) => fmtPct(r.completed, r.total) },
        { title: '待验收', key: 'pendingReview' },
        { title: '进行中', key: 'active' },
        { title: '已撤单', key: 'cancelled' },
        { title: '超时', key: 'overdue' },
        { title: '平均完成时长(小时)', key: 'avgHours', render: (r) => (r.avgHours === null ? null : Number(r.avgHours.toFixed(2))) },
        { title: '收费金额(元)', key: 'fee', render: (r) => centsToYuan(r.feeCents) },
        { title: '材料成本(元)', key: 'cost', render: (r) => centsToYuan(r.materialCostCents) },
        { title: '平均评分', key: 'avgRating', render: (r) => (r.avgRating === null ? null : Number(r.avgRating.toFixed(2))) },
        { title: '评价数', key: 'ratingCount' },
      ];
      const summaryRow: WorkOrderReportRow = { key: 'all', label: '合计', ...data.summary };
      await exportXlsx(`工单统计_${rq.from}_${rq.to}_${WORK_ORDER_GROUP_LABELS[groupBy]}`, [
        { name: WORK_ORDER_GROUP_LABELS[groupBy], columns: metricCols, rows: [...rows, summaryRow] },
      ]);
    } catch (e: any) {
      message.error(e?.message || '导出失败');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="pms-report-pane">
      <CaliberNote>
        按工单<b>创建时间</b>落在区间内统计。「已完成」= 业主验收或到期自动验收；「超时」= 完成时刻（未完成的按现在）晚于要求完成时刻；
        材料成本只含从库存领用的材料（维修工手填、未走库存的不计成本）。
      </CaliberNote>
      <Card size="small" className="pms-report-toolbar">
        {rangeBar(
          <>
            <Select
              allowClear
              placeholder="全部维修工"
              style={{ width: 150 }}
              value={assigneeId}
              onChange={setAssigneeId}
              options={staffOptions}
              {...searchableWideSelectProps}
            />
            <Button icon={<ReloadOutlined />} loading={loading} onClick={load}>刷新</Button>
            <Button icon={<DownloadOutlined />} loading={exporting} disabled={!rows.length} onClick={onExport}>导出 Excel</Button>
          </>,
        )}
      </Card>

      <Row gutter={[12, 12]} className="pms-report-tiles">
        <Col xs={12} md={8} xl={4}><MetricTile title="新增工单" value={summary?.total ?? 0} /></Col>
        <Col xs={12} md={8} xl={4}><MetricTile title="已完成" value={summary?.completed ?? 0} hint={summary ? `完成率 ${fmtPct(summary.completed, summary.total)}` : undefined} tone="good" /></Col>
        <Col xs={12} md={8} xl={4}><MetricTile title="进行中 / 待验收" value={`${summary?.active ?? 0} / ${summary?.pendingReview ?? 0}`} hint={`已撤单 ${summary?.cancelled ?? 0}`} /></Col>
        <Col xs={12} md={8} xl={4}><MetricTile title="超时工单" value={summary?.overdue ?? 0} tone={summary?.overdue ? 'bad' : undefined} hint={summary ? `平均完成 ${fmtHours(summary.avgHours)}` : undefined} /></Col>
        <Col xs={12} md={8} xl={4}><MetricTile title="收费金额" value={formatFeeMoney(summary?.feeCents)} /></Col>
        <Col xs={12} md={8} xl={4}><MetricTile title="材料成本" value={formatFeeMoney(summary?.materialCostCents)} hint={summary ? `平均评分 ${fmtRating(summary.avgRating, summary.ratingCount)}` : undefined} /></Col>
      </Row>

      <Card
        size="small"
        title={
          <Space size={8} wrap>
            <span>分组明细</span>
            <Text type="secondary" style={{ fontSize: 12 }}>{data ? `${data.range.from} ~ ${data.range.to}，共 ${rows.length} 组` : ''}</Text>
          </Space>
        }
        extra={
          <Segmented
            value={groupBy}
            onChange={(v) => setGroupBy(v as WorkOrderGroupBy)}
            options={(Object.keys(WORK_ORDER_GROUP_LABELS) as WorkOrderGroupBy[]).map((k) => ({ value: k, label: WORK_ORDER_GROUP_LABELS[k] }))}
          />
        }
      >
        <Table<WorkOrderReportRow>
          rowKey="key"
          size="middle"
          loading={loading}
          dataSource={rows}
          columns={columns}
          tableLayout="fixed"
          scroll={{ x: 1440 }}
          pagination={rows.length > 50 ? { pageSize: 50, showSizeChanger: false, showTotal: (t) => `共 ${t} 组` } : false}
          locale={{ emptyText: '这段时间没有工单' }}
          summary={() =>
            summary && rows.length ? (
              <Table.Summary fixed>
                <Table.Summary.Row className="pms-report-summary-row">
                  <Table.Summary.Cell index={0}>合计</Table.Summary.Cell>
                  <Table.Summary.Cell index={1} align="right">{summary.total}</Table.Summary.Cell>
                  <Table.Summary.Cell index={2} />
                  <Table.Summary.Cell index={3} align="right">{summary.completed}</Table.Summary.Cell>
                  <Table.Summary.Cell index={4} align="right">{fmtPct(summary.completed, summary.total)}</Table.Summary.Cell>
                  <Table.Summary.Cell index={5} align="right">{summary.pendingReview}</Table.Summary.Cell>
                  <Table.Summary.Cell index={6} align="right">{summary.active}</Table.Summary.Cell>
                  <Table.Summary.Cell index={7} align="right">{summary.cancelled}</Table.Summary.Cell>
                  <Table.Summary.Cell index={8} align="right">{summary.overdue}</Table.Summary.Cell>
                  <Table.Summary.Cell index={9} align="right">{fmtHours(summary.avgHours)}</Table.Summary.Cell>
                  <Table.Summary.Cell index={10} align="right">{formatFeeMoney(summary.feeCents)}</Table.Summary.Cell>
                  <Table.Summary.Cell index={11} align="right">{formatFeeMoney(summary.materialCostCents)}</Table.Summary.Cell>
                  <Table.Summary.Cell index={12} align="right">{fmtRating(summary.avgRating, summary.ratingCount)}</Table.Summary.Cell>
                </Table.Summary.Row>
              </Table.Summary>
            ) : null
          }
        />
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------- 人员统计

function StaffReportView({
  range,
  communityId,
  rangeBar,
}: {
  range: RangeValue;
  communityId?: number;
  rangeBar: (extra?: React.ReactNode) => React.ReactNode;
}) {
  const { message } = AntdApp.useApp();
  const [data, setData] = useState<StaffReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [onlyTechnicians, setOnlyTechnicians] = useState(false);
  const rq = useRangeQuery(range);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await request<StaffReport>({ url: '/reports/staff', query: { ...rq, communityId } }));
    } catch (e: any) {
      message.error(e?.message || '加载人员统计失败');
    } finally {
      setLoading(false);
    }
  }, [rq, communityId, message]);

  useEffect(() => { load(); }, [load]);

  const rows = useMemo(
    () => (data?.rows ?? []).filter((r) => !onlyTechnicians || r.canTakeOrders),
    [data, onlyTechnicians],
  );
  const summary = data?.summary;

  const columns: ColumnsType<StaffReportRow> = [
    {
      title: '维修工', dataIndex: 'name', key: 'name', width: 150, fixed: 'left',
      render: (v: string, r) => (
        <Space size={4}>
          {cellEllipsis(v, 90)}
          {r.accountStatus === 'disabled' && <Tag color="default">已停用</Tag>}
          {!r.onDuty && r.accountStatus !== 'disabled' && <Tag color="orange">离岗</Tag>}
        </Space>
      ),
    },
    { title: '工种', dataIndex: 'skillLabels', key: 'skills', width: 160, render: (v: string[], r) => cellEllipsis((v?.length ? v : r.skills)?.join(' / ') || '', 140) },
    { title: '处理工单', dataIndex: 'total', key: 'total', width: 100, align: 'right' },
    { title: '完工数', dataIndex: 'completedInRange', key: 'completedInRange', width: 90, align: 'right' },
    { title: '已验收', dataIndex: 'completed', key: 'completed', width: 90, align: 'right' },
    { title: '待验收', dataIndex: 'pendingReview', key: 'pendingReview', width: 90, align: 'right' },
    { title: '现在在手', dataIndex: 'activeNow', key: 'activeNow', width: 100, align: 'right', render: (v: number) => (v ? <Text strong>{v}</Text> : 0) },
    { title: '超时', dataIndex: 'overdue', key: 'overdue', width: 80, align: 'right', render: (v: number) => (v ? <Text type="danger">{v}</Text> : 0) },
    { title: '平均完成时长', dataIndex: 'avgHours', key: 'avgHours', width: 130, align: 'right', render: (v: number | null) => fmtHours(v) },
    { title: '收费金额', dataIndex: 'feeCents', key: 'feeCents', width: 120, align: 'right', render: (v: number) => formatFeeMoney(v) },
    { title: '材料成本', dataIndex: 'materialCostCents', key: 'materialCostCents', width: 120, align: 'right', render: (v: number) => formatFeeMoney(v) },
    { title: '评分', key: 'rating', width: 110, align: 'right', render: (_, r) => fmtRating(r.avgRating, r.ratingCount) },
  ];

  const onExport = async () => {
    if (!data) return;
    setExporting(true);
    try {
      await exportXlsx(`人员统计_${rq.from}_${rq.to}`, [
        {
          name: '人员统计',
          columns: [
            { title: '维修工', key: 'name' },
            { title: '账号状态', key: 'accountStatus', render: (r) => (r.accountStatus === 'disabled' ? '已停用' : '正常') },
            { title: '在岗', key: 'onDuty', render: (r) => (r.onDuty ? '在岗' : '离岗') },
            { title: '工种', key: 'skills', render: (r) => (r.skillLabels?.length ? r.skillLabels : r.skills).join(' / ') },
            { title: '处理工单', key: 'total' },
            { title: '完工数', key: 'completedInRange' },
            { title: '已验收', key: 'completed' },
            { title: '待验收', key: 'pendingReview' },
            { title: '现在在手', key: 'activeNow' },
            { title: '超时', key: 'overdue' },
            { title: '平均完成时长(小时)', key: 'avgHours', render: (r) => (r.avgHours === null ? null : Number(r.avgHours.toFixed(2))) },
            { title: '收费金额(元)', key: 'fee', render: (r) => centsToYuan(r.feeCents) },
            { title: '材料成本(元)', key: 'cost', render: (r) => centsToYuan(r.materialCostCents) },
            { title: '平均评分', key: 'avgRating', render: (r) => (r.avgRating === null ? null : Number(r.avgRating.toFixed(2))) },
            { title: '评价数', key: 'ratingCount' },
          ] satisfies ExportColumn<StaffReportRow>[],
          rows,
        },
      ]);
    } catch (e: any) {
      message.error(e?.message || '导出失败');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="pms-report-pane">
      <CaliberNote>
        「处理工单」按工单<b>创建时间</b>在区间内、且当前派给此人的单算；「完工数」按<b>完工时间</b>在区间内算，两者口径不同，不必相等。
        「现在在手」不看区间，是此刻已派单 / 维修中的单。能接单的人即使没有工单也会列出，方便看谁有空。
      </CaliberNote>
      <Card size="small" className="pms-report-toolbar">
        {rangeBar(
          <>
            <Space size={6}>
              <Switch size="small" checked={onlyTechnicians} onChange={setOnlyTechnicians} />
              <span>只看能接单的人</span>
            </Space>
            <Button icon={<ReloadOutlined />} loading={loading} onClick={load}>刷新</Button>
            <Button icon={<DownloadOutlined />} loading={exporting} disabled={!rows.length} onClick={onExport}>导出 Excel</Button>
          </>,
        )}
      </Card>

      <Row gutter={[12, 12]} className="pms-report-tiles">
        <Col xs={12} md={8} xl={4}><MetricTile title="人员数" value={rows.length} hint={data ? `其中能接单 ${rows.filter((r) => r.canTakeOrders).length} 人` : undefined} /></Col>
        <Col xs={12} md={8} xl={4}><MetricTile title="区间处理工单" value={summary?.total ?? 0} hint={summary ? `已验收 ${summary.completed}，待验收 ${summary.pendingReview}` : undefined} /></Col>
        <Col xs={12} md={8} xl={4}><MetricTile title="区间完工" value={data?.completedInRange ?? 0} tone="good" /></Col>
        <Col xs={12} md={8} xl={4}><MetricTile title="现在在手" value={data?.activeNow ?? 0} hint="已派单 + 维修中" /></Col>
        <Col xs={12} md={8} xl={4}><MetricTile title="超时工单" value={summary?.overdue ?? 0} tone={summary?.overdue ? 'bad' : undefined} hint={summary ? `平均完成 ${fmtHours(summary.avgHours)}` : undefined} /></Col>
        <Col xs={12} md={8} xl={4}><MetricTile title="收费 / 材料成本" value={`${formatFeeMoney(summary?.feeCents)} / ${formatFeeMoney(summary?.materialCostCents)}`} /></Col>
      </Row>

      <Card size="small" title={<Space size={8}><span>按人员</span><Text type="secondary" style={{ fontSize: 12 }}>{data ? `${data.range.from} ~ ${data.range.to}` : ''}</Text></Space>}>
        <Table<StaffReportRow>
          rowKey="userId"
          size="middle"
          loading={loading}
          dataSource={rows}
          columns={columns}
          tableLayout="fixed"
          scroll={{ x: 1320 }}
          pagination={rows.length > 50 ? { pageSize: 50, showSizeChanger: false, showTotal: (t) => `共 ${t} 人` } : false}
          locale={{ emptyText: '没有可统计的人员：还没有人绑定能接单的角色，区间内也没有派过单' }}
          summary={() =>
            summary && rows.length ? (
              <Table.Summary fixed>
                <Table.Summary.Row className="pms-report-summary-row">
                  <Table.Summary.Cell index={0}>合计</Table.Summary.Cell>
                  <Table.Summary.Cell index={1} />
                  <Table.Summary.Cell index={2} align="right">{rows.reduce((s, r) => s + r.total, 0)}</Table.Summary.Cell>
                  <Table.Summary.Cell index={3} align="right">{rows.reduce((s, r) => s + r.completedInRange, 0)}</Table.Summary.Cell>
                  <Table.Summary.Cell index={4} align="right">{rows.reduce((s, r) => s + r.completed, 0)}</Table.Summary.Cell>
                  <Table.Summary.Cell index={5} align="right">{rows.reduce((s, r) => s + r.pendingReview, 0)}</Table.Summary.Cell>
                  <Table.Summary.Cell index={6} align="right">{rows.reduce((s, r) => s + r.activeNow, 0)}</Table.Summary.Cell>
                  <Table.Summary.Cell index={7} align="right">{rows.reduce((s, r) => s + r.overdue, 0)}</Table.Summary.Cell>
                  <Table.Summary.Cell index={8} />
                  <Table.Summary.Cell index={9} align="right">{formatFeeMoney(rows.reduce((s, r) => s + r.feeCents, 0))}</Table.Summary.Cell>
                  <Table.Summary.Cell index={10} align="right">{formatFeeMoney(rows.reduce((s, r) => s + r.materialCostCents, 0))}</Table.Summary.Cell>
                  <Table.Summary.Cell index={11} />
                </Table.Summary.Row>
              </Table.Summary>
            ) : null
          }
        />
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------- 库存清单

function StockReportView({ options }: { options: ReportOptions | null }) {
  const { message } = AntdApp.useApp();
  const [data, setData] = useState<StockReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [warehouseId, setWarehouseId] = useState<number | undefined>();
  const [category, setCategory] = useState<string | undefined>();
  const [q, setQ] = useState('');
  const [onlyLow, setOnlyLow] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(
        await request<StockReport>({
          url: '/reports/stock',
          query: { warehouseId, category, q: q.trim() || undefined, onlyLow: onlyLow ? '1' : undefined },
        }),
      );
    } catch (e: any) {
      message.error(e?.message || '加载库存清单失败');
    } finally {
      setLoading(false);
    }
  }, [warehouseId, category, q, onlyLow, message]);

  // 关键字回车才查，其它筛选改了即查
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [warehouseId, category, onlyLow]);

  const rows = data?.rows ?? [];
  const summary = data?.summary;
  const warehouseOptions = withOptionTitles(
    (options?.warehouses ?? []).map((w) => ({
      value: w.id,
      label: `${w.name} · ${WAREHOUSE_TYPE_LABELS[w.type] || w.type}`,
    })),
  );
  const categoryOptions = (options?.categories ?? []).map((c) => ({ value: c, label: c }));

  const columns: ColumnsType<StockReportRow> = [
    { title: '仓库', dataIndex: 'warehouseName', key: 'warehouseName', width: 150, fixed: 'left', render: (v: string) => cellEllipsis(v, 130) },
    { title: '编码', dataIndex: 'code', key: 'code', width: 120, render: (v: string) => <span className="pms-order-no">{v}</span> },
    { title: '材料', dataIndex: 'name', key: 'name', width: 180, render: (v: string, r) => (
      <Space size={4}>
        {cellEllipsis(v, 130)}
        {!r.enabled && <Tag>已停用</Tag>}
      </Space>
    ) },
    { title: '规格', dataIndex: 'spec', key: 'spec', width: 140, render: (v: string | null) => cellEllipsis(v, 120) },
    { title: '分类', dataIndex: 'category', key: 'category', width: 100, render: (v: string | null) => v || '-' },
    { title: '数量', dataIndex: 'qty', key: 'qty', width: 110, align: 'right', render: (v: number, r) => (
      <span>
        {r.low ? <Text type="danger">{fmtQty(v)}</Text> : fmtQty(v)} <Text type="secondary">{r.unit}</Text>
      </span>
    ) },
    { title: '安全库存', dataIndex: 'safetyQty', key: 'safetyQty', width: 100, align: 'right', render: (v: number) => fmtQty(v) },
    { title: '状态', key: 'low', width: 130, render: (_, r) => (r.low ? <Tag color="red">达到/低于安全库存</Tag> : <Tag color="green">正常</Tag>) },
    { title: '单位成本', dataIndex: 'unitCostCents', key: 'unitCostCents', width: 130, align: 'right', render: (v: number, r) => (
      <Tooltip title={r.costSource === 'lot' ? '按剩余批次加权成本' : '没有入库批次记录，按 SKU 默认成本'}>
        <span>{formatFeeMoney(v)}{r.costSource === 'default' && <Text type="secondary"> *</Text>}</span>
      </Tooltip>
    ) },
    { title: '库存金额', dataIndex: 'amountCents', key: 'amountCents', width: 130, align: 'right', render: (v: number) => <Text strong>{formatFeeMoney(v)}</Text> },
  ];

  const onExport = async () => {
    if (!data) return;
    setExporting(true);
    try {
      await exportXlsx(`库存清单_${dayjs().format('YYYY-MM-DD')}`, [
        {
          name: '库存清单',
          columns: [
            { title: '仓库', key: 'warehouseName' },
            { title: '编码', key: 'code' },
            { title: '材料', key: 'name' },
            { title: '规格', key: 'spec' },
            { title: '分类', key: 'category' },
            { title: '单位', key: 'unit' },
            { title: '数量', key: 'qty' },
            { title: '安全库存', key: 'safetyQty' },
            { title: '达到/低于安全库存', key: 'low', render: (r) => (r.low ? '是' : '否') },
            { title: '单位成本(元)', key: 'unitCost', render: (r) => centsToYuan(r.unitCostCents) },
            { title: '成本来源', key: 'costSource', render: (r) => (r.costSource === 'lot' ? '批次加权' : 'SKU 默认成本') },
            { title: '库存金额(元)', key: 'amount', render: (r) => centsToYuan(r.amountCents) },
            { title: 'SKU 状态', key: 'enabled', render: (r) => (r.enabled ? '启用' : '停用') },
          ] satisfies ExportColumn<StockReportRow>[],
          rows,
        },
        {
          name: '按仓库汇总',
          columns: [
            { title: '仓库', key: 'warehouseName' },
            { title: 'SKU 数', key: 'skuCount' },
            { title: '库存预警', key: 'lowCount' },
            { title: '库存金额(元)', key: 'amount', render: (r) => centsToYuan(r.amountCents) },
          ] satisfies ExportColumn<StockReport['byWarehouse'][number]>[],
          rows: data.byWarehouse,
        },
      ]);
    } catch (e: any) {
      message.error(e?.message || '导出失败');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="pms-report-pane">
      <CaliberNote>
        当前时点的库存，按「仓库 × 材料」一行。单位成本按该仓该材料剩余入库批次加权；没有批次记录的老库存按 SKU 默认成本（带 * 号）。
        “库存预警”与“库存与采购”页同一口径：安全库存大于 0，且当前数量 ≤ 安全库存。
      </CaliberNote>
      <Card size="small" className="pms-report-toolbar">
        <Space wrap size={[8, 8]} className="pms-report-filters">
          <Select allowClear placeholder="全部仓库" style={{ width: 200 }} value={warehouseId} onChange={setWarehouseId} options={warehouseOptions} {...searchableWideSelectProps} />
          <Select allowClear placeholder="全部分类" style={{ width: 130 }} value={category} onChange={setCategory} options={categoryOptions} />
          <Input
            allowClear
            placeholder="材料名称 / 编码 / 规格"
            prefix={<SearchOutlined />}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onPressEnter={load}
            style={{ width: 220 }}
          />
          <Space size={6}>
            <Switch size="small" checked={onlyLow} onChange={setOnlyLow} />
            <span>只看库存预警</span>
          </Space>
          <Button icon={<ReloadOutlined />} loading={loading} onClick={load}>查询</Button>
          <Button icon={<DownloadOutlined />} loading={exporting} disabled={!rows.length} onClick={onExport}>导出 Excel</Button>
        </Space>
      </Card>

      <Row gutter={[12, 12]} className="pms-report-tiles">
        <Col xs={12} md={6}><MetricTile title="库存金额" value={formatFeeMoney(summary?.totalAmountCents)} /></Col>
        <Col xs={12} md={6}><MetricTile title="材料行数" value={summary?.skuCount ?? 0} hint={summary ? `有库存 ${summary.totalQtyRows} 行` : undefined} /></Col>
        <Col xs={12} md={6}><MetricTile title="仓库数" value={summary?.warehouseCount ?? 0} /></Col>
        <Col xs={12} md={6}><MetricTile title="库存预警" value={summary?.lowCount ?? 0} tone={summary?.lowCount ? 'warn' : undefined} /></Col>
      </Row>

      {!!data?.byWarehouse.length && data.byWarehouse.length > 1 && (
        <Card size="small" title="按仓库汇总" className="pms-report-subcard">
          <div className="pms-report-warehouse-grid">
            {data.byWarehouse.map((w) => (
              <button
                type="button"
                key={w.warehouseId}
                className={`pms-report-warehouse${warehouseId === w.warehouseId ? ' is-active' : ''}`}
                onClick={() => setWarehouseId(warehouseId === w.warehouseId ? undefined : w.warehouseId)}
              >
                <strong title={w.warehouseName}>{w.warehouseName}</strong>
                <span>{formatFeeMoney(w.amountCents)}</span>
                <small>{w.skuCount} 种材料{w.lowCount ? ` · ${w.lowCount} 种偏低` : ''}</small>
              </button>
            ))}
          </div>
        </Card>
      )}

      <Card size="small" title={<Space size={8}><span>库存明细</span><Text type="secondary" style={{ fontSize: 12 }}>共 {rows.length} 行</Text></Space>}>
        <Table<StockReportRow>
          rowKey="stockId"
          size="middle"
          loading={loading}
          dataSource={rows}
          columns={columns}
          tableLayout="fixed"
          scroll={{ x: 1270 }}
          pagination={{ pageSize: 50, showSizeChanger: true, pageSizeOptions: [50, 100, 200], showTotal: (t) => `共 ${t} 行` }}
          locale={{ emptyText: onlyLow ? '没有达到预警线的材料' : '没有库存记录' }}
          summary={() =>
            summary && rows.length ? (
              <Table.Summary fixed>
                <Table.Summary.Row className="pms-report-summary-row">
                  <Table.Summary.Cell index={0}>合计</Table.Summary.Cell>
                  <Table.Summary.Cell index={1} colSpan={6}>{rows.length} 行，{summary.lowCount} 行库存预警</Table.Summary.Cell>
                  <Table.Summary.Cell index={7} colSpan={2} />
                  <Table.Summary.Cell index={9} align="right">{formatFeeMoney(summary.totalAmountCents)}</Table.Summary.Cell>
                </Table.Summary.Row>
              </Table.Summary>
            ) : null
          }
        />
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------- 材料使用明细

function MaterialUsageReport({
  range,
  communityId,
  options,
  rangeBar,
}: {
  range: RangeValue;
  communityId?: number;
  options: ReportOptions | null;
  rangeBar: (extra?: React.ReactNode) => React.ReactNode;
}) {
  const { message } = AntdApp.useApp();
  const [groupBy, setGroupBy] = useState<MaterialUsageGroupBy>('detail');
  const [assigneeId, setAssigneeId] = useState<number | undefined>();
  const [materialId, setMaterialId] = useState<number | undefined>();
  const [warehouseId, setWarehouseId] = useState<number | undefined>();
  const [data, setData] = useState<MaterialUsageReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const rq = useRangeQuery(range);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(
        await request<MaterialUsageReport>({
          url: '/reports/material-usage',
          query: { ...rq, groupBy, communityId, assigneeId, materialId, warehouseId },
        }),
      );
    } catch (e: any) {
      message.error(e?.message || '加载材料使用明细失败');
    } finally {
      setLoading(false);
    }
  }, [rq, groupBy, communityId, assigneeId, materialId, warehouseId, message]);

  useEffect(() => { load(); }, [load]);

  const summary = data?.summary;
  const isDetail = (data?.groupBy ?? groupBy) === 'detail';
  const detailRows = (isDetail ? (data?.rows as MaterialUsageDetailRow[] | undefined) : undefined) ?? [];
  const groupRows = (!isDetail ? (data?.rows as MaterialUsageGroupRow[] | undefined) : undefined) ?? [];
  const rowCount = isDetail ? detailRows.length : groupRows.length;

  const staffOptions = withOptionTitles((options?.staff ?? []).map((s) => ({ value: s.id, label: s.name })));
  const materialOptions = withOptionTitles(
    (options?.materials ?? []).map((m) => ({ value: m.id, label: `${m.code} · ${m.name}${m.spec ? ` ${m.spec}` : ''}` })),
  );
  const warehouseOptions = withOptionTitles((options?.warehouses ?? []).map((w) => ({ value: w.id, label: w.name })));

  const detailColumns: ColumnsType<MaterialUsageDetailRow> = [
    { title: '领用时间', dataIndex: 'usedAt', key: 'usedAt', width: 150, fixed: 'left', render: (v: string) => fmtDateTime(v) },
    { title: '工单号', dataIndex: 'orderNo', key: 'orderNo', width: 170, render: (v: string, r) => (
      <Space size={4}>
        <span className="pms-order-no">{v}</span>
        <Text type="secondary" style={{ fontSize: 12 }}>{r.statusLabel}</Text>
      </Space>
    ) },
    { title: '维修工', dataIndex: 'assigneeName', key: 'assigneeName', width: 110, render: (v: string) => cellEllipsis(v, 90) },
    { title: '小区', dataIndex: 'communityName', key: 'communityName', width: 140, render: (v: string) => cellEllipsis(v, 120) },
    { title: '材料', dataIndex: 'name', key: 'name', width: 190, render: (v: string, r) => cellEllipsis(`${v}${r.spec ? ` ${r.spec}` : ''}`, 170) },
    { title: '编码', dataIndex: 'code', key: 'code', width: 110, render: (v: string) => <span className="pms-order-no">{v}</span> },
    { title: '仓库', dataIndex: 'warehouseName', key: 'warehouseName', width: 130, render: (v: string) => cellEllipsis(v, 110) },
    { title: '数量', dataIndex: 'qty', key: 'qty', width: 100, align: 'right', render: (v: number, r) => <span>{fmtQty(v)} <Text type="secondary">{r.unit}</Text></span> },
    { title: '单价', dataIndex: 'unitCostCents', key: 'unitCostCents', width: 110, align: 'right', render: (v: number) => formatFeeMoney(v) },
    { title: '金额', dataIndex: 'amountCents', key: 'amountCents', width: 120, align: 'right', render: (v: number) => <Text strong>{formatFeeMoney(v)}</Text> },
  ];

  const groupTitle = MATERIAL_GROUP_LABELS[groupBy].replace('按', '');
  const groupColumns: ColumnsType<MaterialUsageGroupRow> = [
    { title: groupTitle, dataIndex: 'label', key: 'label', width: 200, fixed: 'left', render: (v: string, r) => (
      groupBy === 'material'
        ? <Space size={4}>{cellEllipsis(v, 150)}<Text type="secondary" style={{ fontSize: 12 }}>{r.code}</Text></Space>
        : cellEllipsis(v, 180)
    ) },
    ...(groupBy === 'material'
      ? [{ title: '分类', dataIndex: 'category', key: 'category', width: 100, render: (v: string | null) => v || '-' } as ColumnsType<MaterialUsageGroupRow>[number]]
      : []),
    { title: '领料条数', dataIndex: 'lines', key: 'lines', width: 100, align: 'right' },
    { title: '涉及工单', dataIndex: 'orders', key: 'orders', width: 100, align: 'right' },
    ...(groupBy === 'material'
      ? [{ title: '数量', dataIndex: 'qty', key: 'qty', width: 120, align: 'right' as const, render: (v: number | null, r: MaterialUsageGroupRow) => <span>{fmtQty(v)} <Text type="secondary">{r.unit}</Text></span> }]
      : []),
    { title: '金额', dataIndex: 'amountCents', key: 'amountCents', width: 130, align: 'right', render: (v: number) => <Text strong>{formatFeeMoney(v)}</Text> },
    { title: '占比', key: 'share', width: 160, render: (_, r) => <ShareBar part={r.amountCents} total={summary?.amountCents ?? 0} /> },
  ];

  const onExport = async () => {
    if (!data) return;
    setExporting(true);
    try {
      const fileName = `材料使用_${rq.from}_${rq.to}_${MATERIAL_GROUP_LABELS[groupBy]}`;
      if (isDetail) {
        await exportXlsx(fileName, [
          {
            name: '明细',
            columns: [
              { title: '领用时间', key: 'usedAt', render: (r) => fmtDateTime(r.usedAt) },
              { title: '工单号', key: 'orderNo' },
              { title: '工单状态', key: 'statusLabel' },
              { title: '维修工', key: 'assigneeName' },
              { title: '小区', key: 'communityName' },
              { title: '材料编码', key: 'code' },
              { title: '材料', key: 'name' },
              { title: '规格', key: 'spec' },
              { title: '分类', key: 'category' },
              { title: '仓库', key: 'warehouseName' },
              { title: '数量', key: 'qty' },
              { title: '单位', key: 'unit' },
              { title: '单价(元)', key: 'unitCost', render: (r) => centsToYuan(r.unitCostCents) },
              { title: '金额(元)', key: 'amount', render: (r) => centsToYuan(r.amountCents) },
            ] satisfies ExportColumn<MaterialUsageDetailRow>[],
            rows: detailRows,
          },
        ]);
      } else {
        await exportXlsx(fileName, [
          {
            name: MATERIAL_GROUP_LABELS[groupBy],
            columns: [
              { title: groupTitle, key: 'label' },
              ...(groupBy === 'material'
                ? ([
                    { title: '材料编码', key: 'code' },
                    { title: '规格', key: 'spec' },
                    { title: '分类', key: 'category' },
                    { title: '数量', key: 'qty' },
                    { title: '单位', key: 'unit' },
                  ] satisfies ExportColumn<MaterialUsageGroupRow>[])
                : []),
              { title: '领料条数', key: 'lines' },
              { title: '涉及工单', key: 'orders' },
              { title: '金额(元)', key: 'amount', render: (r) => centsToYuan(r.amountCents) },
              { title: '占比', key: 'share', render: (r) => fmtPct(r.amountCents, data.summary.amountCents) },
            ] satisfies ExportColumn<MaterialUsageGroupRow>[],
            rows: groupRows,
          },
        ]);
      }
    } catch (e: any) {
      message.error(e?.message || '导出失败');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="pms-report-pane">
      <CaliberNote>
        按维修工完工时从库存<b>领用</b>的材料记录统计，时间取出库时刻，金额为 FIFO 批次成本。维修工手填、未走库存的材料不在此列。
      </CaliberNote>
      <Card size="small" className="pms-report-toolbar">
        {rangeBar(
          <>
            <Select allowClear placeholder="全部维修工" style={{ width: 140 }} value={assigneeId} onChange={setAssigneeId} options={staffOptions} {...searchableWideSelectProps} />
            <Select allowClear placeholder="全部材料" style={{ width: 200 }} value={materialId} onChange={setMaterialId} options={materialOptions} {...searchableWideSelectProps} />
            <Select allowClear placeholder="全部仓库" style={{ width: 150 }} value={warehouseId} onChange={setWarehouseId} options={warehouseOptions} {...searchableWideSelectProps} />
            <Button icon={<ReloadOutlined />} loading={loading} onClick={load}>刷新</Button>
            <Button icon={<DownloadOutlined />} loading={exporting} disabled={!rowCount} onClick={onExport}>导出 Excel</Button>
          </>,
        )}
      </Card>

      <Row gutter={[12, 12]} className="pms-report-tiles">
        <Col xs={12} md={8}><MetricTile title="材料金额" value={formatFeeMoney(summary?.amountCents)} /></Col>
        <Col xs={12} md={8}><MetricTile title="领料条数" value={summary?.lines ?? 0} /></Col>
        <Col xs={12} md={8}><MetricTile title="涉及工单" value={summary?.orders ?? 0} hint={summary?.orders ? `平均每单 ${formatFeeMoney(Math.round(summary.amountCents / summary.orders))}` : undefined} /></Col>
      </Row>

      {data?.truncated && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="明细超过 5000 条，只显示最近 5000 条；缩小日期区间或加筛选条件后再导出，汇总数字不受影响。"
        />
      )}

      <Card
        size="small"
        title={<Space size={8}><span>{isDetail ? '领料明细' : '分组汇总'}</span><Text type="secondary" style={{ fontSize: 12 }}>{data ? `${data.range.from} ~ ${data.range.to}，共 ${rowCount} ${isDetail ? '条' : '组'}` : ''}</Text></Space>}
        extra={
          <Segmented
            value={groupBy}
            onChange={(v) => setGroupBy(v as MaterialUsageGroupBy)}
            options={(Object.keys(MATERIAL_GROUP_LABELS) as MaterialUsageGroupBy[]).map((k) => ({ value: k, label: MATERIAL_GROUP_LABELS[k] }))}
          />
        }
      >
        {isDetail ? (
          <Table<MaterialUsageDetailRow>
            rowKey="id"
            size="middle"
            loading={loading}
            dataSource={detailRows}
            columns={detailColumns}
            tableLayout="fixed"
            scroll={{ x: 1330 }}
            pagination={{ pageSize: 50, showSizeChanger: true, pageSizeOptions: [50, 100, 200], showTotal: (t) => `共 ${t} 条` }}
            locale={{ emptyText: '这段时间没有从库存领用材料的记录' }}
            summary={() =>
              summary && detailRows.length ? (
                <Table.Summary fixed>
                  <Table.Summary.Row className="pms-report-summary-row">
                    <Table.Summary.Cell index={0}>合计</Table.Summary.Cell>
                    <Table.Summary.Cell index={1} colSpan={6}>{summary.lines} 条，涉及 {summary.orders} 张工单</Table.Summary.Cell>
                    <Table.Summary.Cell index={7} colSpan={2} />
                    <Table.Summary.Cell index={9} align="right">{formatFeeMoney(summary.amountCents)}</Table.Summary.Cell>
                  </Table.Summary.Row>
                </Table.Summary>
              ) : null
            }
          />
        ) : (
          <Table<MaterialUsageGroupRow>
            rowKey="key"
            size="middle"
            loading={loading}
            dataSource={groupRows}
            columns={groupColumns}
            tableLayout="fixed"
            scroll={{ x: groupBy === 'material' ? 910 : 690 }}
            pagination={groupRows.length > 50 ? { pageSize: 50, showSizeChanger: false, showTotal: (t) => `共 ${t} 组` } : false}
            locale={{ emptyText: '这段时间没有从库存领用材料的记录' }}
            summary={() =>
              summary && groupRows.length ? (
                <Table.Summary fixed>
                  <Table.Summary.Row className="pms-report-summary-row">
                    <Table.Summary.Cell index={0}>合计</Table.Summary.Cell>
                    {groupBy === 'material' && <Table.Summary.Cell index={1} />}
                    <Table.Summary.Cell index={2} align="right">{summary.lines}</Table.Summary.Cell>
                    <Table.Summary.Cell index={3} align="right">{summary.orders}</Table.Summary.Cell>
                    {groupBy === 'material' && <Table.Summary.Cell index={4} />}
                    <Table.Summary.Cell index={5} align="right">{formatFeeMoney(summary.amountCents)}</Table.Summary.Cell>
                    <Table.Summary.Cell index={6} />
                  </Table.Summary.Row>
                </Table.Summary>
              ) : null
            }
          />
        )}
      </Card>
    </div>
  );
}
