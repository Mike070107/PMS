import {
  App as AntdApp,
  Alert,
  Button,
  Card,
  Descriptions,
  Drawer,
  Form,
  Image,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Progress,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import {
  AuditOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  DiffOutlined,
  EditOutlined,
  FileTextOutlined,
  PlusOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import { useEffect, useMemo, useState } from 'react';
import { stocktakes } from '@pms/api-client';
import { MaterialPhotoCell, MaterialPhotosUpload, imageSrc } from './MaterialPhotos';
import './StocktakePanel.css';
import {
  STOCKTAKE_REASON_OPTIONS,
  STOCKTAKE_STATUS_LABELS,
  formatDateTimeCn,
  type StocktakeDetailView,
  type StocktakeItemView,
  type StocktakeStatus,
  type StocktakeTaskView,
} from '@pms/shared-types';

const { Text } = Typography;

interface WarehouseOption {
  id: number;
  name: string;
  enabled: boolean;
  officeName?: string | null;
}

interface Props {
  warehouses: WarehouseOption[];
  canEdit: boolean;
}

type StatusFilter = 'all' | StocktakeStatus;

const statusMeta: Record<StocktakeStatus, { color: string; label: string }> = {
  counting: { color: 'processing', label: STOCKTAKE_STATUS_LABELS.counting },
  submitted: { color: 'gold', label: STOCKTAKE_STATUS_LABELS.submitted },
  approved: { color: 'green', label: STOCKTAKE_STATUS_LABELS.approved },
  rejected: { color: 'red', label: STOCKTAKE_STATUS_LABELS.rejected },
  cancelled: { color: 'default', label: STOCKTAKE_STATUS_LABELS.cancelled },
};

const reasonByCode = new Map(STOCKTAKE_REASON_OPTIONS.map((item) => [item.value, item.label]));

function formatDateTime(value?: string | null) {
  return formatDateTimeCn(value) || '-';
}

function quantity(value?: number | null) {
  if (value == null) return '-';
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function precisionForUnit(unit?: string | null) {
  return ['米', '公斤', '升', '平方米', '立方米'].includes(unit || '') ? 2 : 0;
}

function escapeCsv(value: unknown) {
  const text = value == null ? '' : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

export default function StocktakePanel({ warehouses, canEdit }: Props) {
  const { message } = AntdApp.useApp();
  const [tasks, setTasks] = useState<StocktakeTaskView[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [warehouseId, setWarehouseId] = useState<number | 'all'>('all');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [keyword, setKeyword] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detail, setDetail] = useState<StocktakeDetailView | null>(null);
  const [itemKeyword, setItemKeyword] = useState('');
  const [onlyDifference, setOnlyDifference] = useState(false);
  const [countingItem, setCountingItem] = useState<StocktakeItemView | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [countUploading, setCountUploading] = useState(false);
  const [createForm] = Form.useForm<{ warehouseId: number; title?: string }>();
  const [countForm] = Form.useForm<{
    actualQty: number;
    reasonCode?: string;
    note?: string;
    attachments?: string[];
  }>();
  const [reviewForm] = Form.useForm<{ note?: string }>();
  const watchedActualQty = Form.useWatch('actualQty', countForm);

  const loadTasks = async () => {
    setLoading(true);
    try {
      setTasks(await stocktakes.list());
    } catch (e: any) {
      message.error(e?.message || '加载盘点任务失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadTasks();
  }, []);

  const loadDetail = async (id: number, open = true) => {
    setDetailLoading(true);
    try {
      const next = await stocktakes.detail(id);
      setDetail(next);
      if (open) {
        setItemKeyword('');
        setOnlyDifference(false);
        setDetailOpen(true);
      }
      return next;
    } catch (e: any) {
      message.error(e?.message || '加载盘点明细失败');
      return null;
    } finally {
      setDetailLoading(false);
    }
  };

  const visibleTasks = useMemo(() => {
    const q = keyword.trim().toLowerCase();
    return tasks.filter((task) => {
      if (warehouseId !== 'all' && task.warehouseId !== warehouseId) return false;
      if (status !== 'all' && task.status !== status) return false;
      if (!q) return true;
      return `${task.taskNo} ${task.title} ${task.warehouseName}`.toLowerCase().includes(q);
    });
  }, [tasks, warehouseId, status, keyword]);

  const summary = useMemo(() => ({
    active: tasks.filter((item) => ['counting', 'rejected'].includes(item.status)).length,
    pending: tasks.filter((item) => item.status === 'submitted').length,
    approved: tasks.filter((item) => item.status === 'approved').length,
    differences: tasks
      .filter((item) => item.status === 'approved')
      .reduce((sum, item) => sum + item.differenceCount, 0),
  }), [tasks]);

  const visibleItems = useMemo(() => {
    if (!detail) return [];
    const q = itemKeyword.trim().toLowerCase();
    return detail.items.filter((item) => {
      if (onlyDifference && Number(item.differenceQty || 0) === 0) return false;
      if (!q) return true;
      return [
        item.material.code,
        item.material.name,
        item.material.spec,
        item.material.category,
        item.locationLabel,
        item.note,
      ].filter(Boolean).join(' ').toLowerCase().includes(q);
    });
  }, [detail, itemKeyword, onlyDifference]);

  const createTask = async () => {
    let values: { warehouseId: number; title?: string };
    try {
      values = await createForm.validateFields();
    } catch {
      return;
    }
    setSaving(true);
    try {
      const created = await stocktakes.create({
        warehouseId: values.warehouseId,
        title: values.title?.trim() || undefined,
      });
      message.success('盘点任务已创建');
      setCreateOpen(false);
      createForm.resetFields();
      await loadTasks();
      setDetail(created);
      setDetailOpen(true);
    } catch (e: any) {
      message.error(e?.message || '创建盘点任务失败');
    } finally {
      setSaving(false);
    }
  };

  const openCount = (item: StocktakeItemView) => {
    setCountingItem(item);
    countForm.setFieldsValue({
      actualQty: item.actualQty == null ? Number(item.bookQty) : Number(item.actualQty),
      reasonCode: item.reasonCode || undefined,
      note: item.note || undefined,
      attachments: item.attachments || [],
    });
  };

  const saveCount = async () => {
    if (!detail || !countingItem) return;
    let values: { actualQty: number; reasonCode?: string; note?: string; attachments?: string[] };
    try {
      values = await countForm.validateFields();
    } catch {
      return;
    }
    const difference = Number((Number(values.actualQty) - Number(countingItem.bookQty)).toFixed(2));
    if (difference !== 0 && !values.reasonCode) {
      countForm.setFields([{ name: 'reasonCode', errors: ['有盘盈或盘亏时请选择差异原因'] }]);
      return;
    }
    setSaving(true);
    try {
      await stocktakes.countItem(detail.id, countingItem.id, {
        actualQty: Number(values.actualQty),
        reasonCode: difference === 0 ? undefined : values.reasonCode,
        note: values.note?.trim() || undefined,
        attachments: values.attachments || [],
      });
      message.success('实盘数量已保存');
      setCountingItem(null);
      await Promise.all([loadDetail(detail.id, false), loadTasks()]);
    } catch (e: any) {
      message.error(e?.message || '保存盘点结果失败');
    } finally {
      setSaving(false);
    }
  };

  const submitTask = async () => {
    if (!detail) return;
    setSaving(true);
    try {
      const next = await stocktakes.submit(detail.id);
      setDetail(next);
      await loadTasks();
      message.success('已提交办公室复核');
    } catch (e: any) {
      message.error(e?.message || '提交复核失败');
    } finally {
      setSaving(false);
    }
  };

  const reviewTask = async (approved: boolean) => {
    if (!detail) return;
    const note = reviewForm.getFieldValue('note')?.trim();
    if (!approved && !note) {
      reviewForm.setFields([{ name: 'note', errors: ['退回时请填写原因'] }]);
      return;
    }
    setSaving(true);
    try {
      const next = await stocktakes.review(detail.id, { approved, note: note || undefined });
      setDetail(next);
      setReviewOpen(false);
      reviewForm.resetFields();
      await loadTasks();
      message.success(approved ? '复核通过，库存已按差异过账' : '已退回盘点人重新核对');
    } catch (e: any) {
      const errorMessage = e?.message || '盘点复核失败';
      if (errorMessage.includes('已自动刷新账面数')) {
        setReviewOpen(false);
        setOnlyDifference(false);
        await Promise.all([loadDetail(detail.id, false), loadTasks()]);
        message.warning(errorMessage, 8);
      } else {
        message.error(errorMessage);
      }
    } finally {
      setSaving(false);
    }
  };

  const exportReport = () => {
    if (!detail) return;
    const header = [
      '盘点单号', '仓库', 'SKU编码', '材料名称', '规格', '库位', '单位',
      '账面数量', '实盘数量', '差异', '差异原因', '备注', '盘点时间',
    ];
    const rows = detail.items.map((item) => [
      detail.taskNo,
      detail.warehouseName,
      item.material.code,
      item.material.name,
      item.material.spec || '',
      item.locationLabel || '',
      item.material.unit,
      quantity(item.bookQty),
      quantity(item.actualQty),
      quantity(item.differenceQty),
      reasonByCode.get(item.reasonCode as any) || '',
      item.note || '',
      formatDateTime(item.countedAt),
    ]);
    const csv = `\uFEFF${[header, ...rows].map((row) => row.map(escapeCsv).join(',')).join('\r\n')}`;
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `盘点报告-${detail.taskNo}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const countDifference = countingItem && watchedActualQty != null
    ? Number((Number(watchedActualQty) - Number(countingItem.bookQty)).toFixed(2))
    : 0;
  const editableDetail = !!detail && ['counting', 'rejected'].includes(detail.status);
  const allCounted = !!detail && detail.totalCount > 0 && detail.countedCount === detail.totalCount;

  return (
    <div className="stocktake-workspace">
      <section className="stocktake-overview">
        <div className="stocktake-overview__copy">
          <span className="stocktake-overview__eyebrow">库存核对工作台</span>
          <h2>先盘清，再过账</h2>
          <p>盘点数据提交后由办公室统一复核，确认通过才会调整库存并生成可追溯报告。</p>
        </div>
        <Space wrap className="stocktake-overview__actions">
          <Button icon={<ReloadOutlined />} onClick={loadTasks} loading={loading}>刷新数据</Button>
          {canEdit && <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>新建盘点</Button>}
        </Space>
      </section>

      <div className="stocktake-metrics">
        <div className="stocktake-metric stocktake-metric--blue">
          <span className="stocktake-metric__icon"><AuditOutlined /></span>
          <div><span>正在盘点</span><strong>{summary.active}</strong><small>含退回后重新核对</small></div>
        </div>
        <div className={`stocktake-metric stocktake-metric--amber${summary.pending ? ' stocktake-metric--attention' : ''}`}>
          <span className="stocktake-metric__icon"><ClockCircleOutlined /></span>
          <div><span>等待办公室复核</span><strong>{summary.pending}</strong><small>{summary.pending ? '建议优先处理' : '当前没有待复核任务'}</small></div>
        </div>
        <div className="stocktake-metric stocktake-metric--green">
          <span className="stocktake-metric__icon"><CheckCircleOutlined /></span>
          <div><span>已完成报告</span><strong>{summary.approved}</strong><small>已复核并完成过账</small></div>
        </div>
        <div className="stocktake-metric stocktake-metric--rose">
          <span className="stocktake-metric__icon"><DiffOutlined /></span>
          <div><span>历史差异项</span><strong>{summary.differences}</strong><small>累计盘盈与盘亏项目</small></div>
        </div>
      </div>

      {summary.pending > 0 && (
        <Alert
          className="stocktake-review-alert"
          type="warning"
          showIcon
          message={`有 ${summary.pending} 张盘点单等待办公室复核`}
          description="复核通过后才会把盘盈、盘亏写入库存和出入库流水。"
          action={<Button size="small" onClick={() => setStatus('submitted')}>只看待复核</Button>}
        />
      )}

      <Card
        className="stocktake-task-card"
        title={<div className="stocktake-section-title"><strong>盘点任务与报告</strong><span>统一查看盘点进度、办公室复核与历史报告</span></div>}
      >
        <div className="stocktake-toolbar">
          <Space wrap>
            <Select
              value={warehouseId}
              onChange={setWarehouseId}
              className="stocktake-filter--warehouse"
              options={[
                { value: 'all', label: '全部可见仓库' },
                ...warehouses.map((item) => ({
                  value: item.id,
                  label: `${item.name}${item.officeName ? ` · ${item.officeName}` : ''}`,
                })),
              ]}
            />
            <Select
              value={status}
              onChange={setStatus}
              className="stocktake-filter--status"
              options={[
                { value: 'all', label: '全部状态' },
                ...Object.entries(STOCKTAKE_STATUS_LABELS).map(([value, label]) => ({ value, label })),
              ]}
            />
            <Input.Search
              allowClear
              placeholder="搜索单号、任务名或仓库"
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              className="stocktake-filter--search"
            />
          </Space>
          <Text type="secondary">共 {visibleTasks.length} 张盘点单</Text>
        </div>
        <Table
          className="stocktake-task-table"
          rowKey="id"
          loading={loading}
          dataSource={visibleTasks}
          scroll={{ x: 1180 }}
          pagination={{ defaultPageSize: 20, showSizeChanger: true, pageSizeOptions: ['20', '50', '100'] }}
          rowClassName={(row) => row.status === 'submitted' ? 'stocktake-task-row--pending' : ''}
          columns={[
            {
              title: '盘点任务', key: 'task', width: 280,
              render: (_: unknown, row: StocktakeTaskView) => (
                <div className="stocktake-task-name">
                  <Text strong ellipsis={{ tooltip: row.title }}>{row.title}</Text>
                  <Text type="secondary" copyable={{ text: row.taskNo }}>{row.taskNo}</Text>
                </div>
              ),
            },
            { title: '盘点仓库', dataIndex: 'warehouseName', width: 180, ellipsis: true },
            {
              title: '状态', dataIndex: 'status', width: 100,
              render: (value: StocktakeStatus) => <Tag color={statusMeta[value]?.color}>{statusMeta[value]?.label || value}</Tag>,
            },
            {
              title: '盘点进度', key: 'progress', width: 220,
              render: (_: unknown, row: StocktakeTaskView) => (
                <Space style={{ width: '100%' }}>
                  <Progress
                    percent={row.totalCount ? Math.round((row.countedCount / row.totalCount) * 100) : 0}
                    size="small"
                    style={{ width: 120 }}
                  />
                  <Text type="secondary">{row.countedCount}/{row.totalCount}</Text>
                </Space>
              ),
            },
            {
              title: '差异', dataIndex: 'differenceCount', width: 100,
              render: (value: number) => value ? <Tag color="volcano">{value} 项</Tag> : <Tag color="green">无差异</Tag>,
            },
            { title: '发起时间', dataIndex: 'createdAt', width: 180, render: formatDateTime },
            {
              title: '操作', key: 'operation', fixed: 'right' as const, width: 130,
              render: (_: unknown, row: StocktakeTaskView) => (
                <Button className="stocktake-open-button" type={row.status === 'submitted' && canEdit ? 'primary' : 'default'} size="small" onClick={() => loadDetail(row.id)}>
                  {row.status === 'submitted' && canEdit
                    ? '办公室复核'
                    : row.status === 'approved'
                      ? '查看报告'
                      : canEdit && (row.status === 'counting' || row.status === 'rejected')
                        ? '录入盘点'
                        : '查看'}
                </Button>
              ),
            },
          ]}
        />
      </Card>

      <Modal
        title="新建盘点任务"
        open={createOpen}
        onCancel={() => { setCreateOpen(false); createForm.resetFields(); }}
        onOk={createTask}
        confirmLoading={saving}
        destroyOnHidden
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="创建时会记录该仓库的账面库存快照"
          description="同一仓库同时只能有一张未结束的盘点单。"
        />
        <Form form={createForm} layout="vertical">
          <Form.Item name="warehouseId" label="盘点仓库" rules={[{ required: true, message: '请选择仓库' }]}>
            <Select
              showSearch
              optionFilterProp="label"
              options={warehouses.filter((item) => item.enabled).map((item) => ({
                value: item.id,
                label: `${item.name}${item.officeName ? ` · ${item.officeName}` : ''}`,
              }))}
            />
          </Form.Item>
          <Form.Item name="title" label="任务名称" extra="不填则自动使用本月月度盘点">
            <Input maxLength={120} placeholder="如：9月月度盘点" />
          </Form.Item>
        </Form>
      </Modal>

      <Drawer
        className="stocktake-detail-drawer"
        title={detail ? (
          <div className="stocktake-drawer-title">
            <span>{detail.status === 'approved' ? '盘点报告' : '盘点任务'}</span>
            <strong>{detail.taskNo}</strong>
          </div>
        ) : '盘点明细'}
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
        width="min(1180px, 94vw)"
        loading={detailLoading}
        extra={detail && (
          <Space>
            {detail.status === 'approved' && <Button icon={<FileTextOutlined />} onClick={exportReport}>导出报告</Button>}
            {canEdit && editableDetail && (
              <Popconfirm
                title="提交办公室复核？"
                description={allCounted ? '提交后将不能再修改实盘数量。' : `还有 ${detail.totalCount - detail.countedCount} 项未盘点。`}
                disabled={!allCounted}
                onConfirm={submitTask}
              >
                <Button type="primary" disabled={!allCounted} loading={saving}>提交复核</Button>
              </Popconfirm>
            )}
            {canEdit && detail.status === 'submitted' && (
              <Button type="primary" icon={<AuditOutlined />} onClick={() => { reviewForm.resetFields(); setReviewOpen(true); }}>办公室复核</Button>
            )}
          </Space>
        )}
      >
        {detail && (
          <>
            {detail.status === 'rejected' && (
              <Alert type="error" showIcon style={{ marginBottom: 16 }} message="盘点单已退回" description={detail.reviewNote || '未填写退回原因'} />
            )}
            {detail.status === 'submitted' && (
              <Alert type="warning" showIcon style={{ marginBottom: 16 }} message="待办公室复核" description="请重点核对盘盈、盘亏项及原因。通过后差异会立即过账。" />
            )}
            <Descriptions className="stocktake-detail-meta" bordered size="small" column={{ xs: 1, sm: 2, lg: 4 }}>
              <Descriptions.Item label="任务名称">{detail.title}</Descriptions.Item>
              <Descriptions.Item label="仓库">{detail.warehouseName}</Descriptions.Item>
              <Descriptions.Item label="状态"><Tag color={statusMeta[detail.status].color}>{statusMeta[detail.status].label}</Tag></Descriptions.Item>
              <Descriptions.Item label="盘点进度">{detail.countedCount}/{detail.totalCount}</Descriptions.Item>
              <Descriptions.Item label="账面快照时间">{formatDateTime(detail.snapshotAt)}</Descriptions.Item>
              <Descriptions.Item label="提交复核时间">{formatDateTime(detail.submittedAt)}</Descriptions.Item>
              <Descriptions.Item label="复核时间">{formatDateTime(detail.reviewedAt)}</Descriptions.Item>
              <Descriptions.Item label="差异项">{detail.differenceCount} 项</Descriptions.Item>
              {detail.reviewNote && <Descriptions.Item label="复核意见" span={4}>{detail.reviewNote}</Descriptions.Item>}
            </Descriptions>

            <div className="stocktake-detail-metrics">
              <div><span>SKU 项数</span><strong>{detail.totalCount}</strong></div>
              <div><span>已盘</span><strong>{detail.countedCount}</strong></div>
              <div><span>账实一致</span><strong>{detail.items.filter((item) => item.actualQty != null && Number(item.differenceQty) === 0).length}</strong></div>
              <div className={detail.differenceCount ? 'is-difference' : ''}><span>存在差异</span><strong>{detail.differenceCount}</strong></div>
            </div>

            <section className="stocktake-detail-section">
              <div className="stocktake-detail-toolbar">
                <div className="stocktake-section-title"><strong>材料盘点明细</strong><span>核对材料图片、账面数量、实盘结果与现场凭证</span></div>
                <Space wrap>
                  <Input.Search allowClear placeholder="搜编码 / 材料 / 规格 / 库位" value={itemKeyword} onChange={(event) => setItemKeyword(event.target.value)} className="stocktake-detail-search" />
                  <Button type={onlyDifference ? 'primary' : 'default'} icon={<DiffOutlined />} onClick={() => setOnlyDifference((value) => !value)}>
                    只看差异 {detail.differenceCount ? `(${detail.differenceCount})` : ''}
                  </Button>
                </Space>
              </div>
              <Table
              className="stocktake-detail-table"
              rowKey="id"
              size="small"
              dataSource={visibleItems}
              scroll={{ x: 1560 }}
              pagination={{ defaultPageSize: 30, showSizeChanger: true, pageSizeOptions: ['30', '50', '100'] }}
              rowClassName={(item) => Number(item.differenceQty || 0) !== 0 ? 'stocktake-row--difference' : ''}
              columns={[
                { title: 'SKU编码', dataIndex: ['material', 'code'], width: 130, ellipsis: true },
                {
                  title: '材料图片', key: 'materialPhoto', width: 90,
                  render: (_: unknown, item: StocktakeItemView) => <MaterialPhotoCell item={item.material} size={48} />,
                },
                {
                  title: '材料', key: 'material', width: 220, ellipsis: true,
                  render: (_: unknown, item: StocktakeItemView) => [item.material.name, item.material.spec].filter(Boolean).join(' · '),
                },
                { title: '库位', dataIndex: 'locationLabel', width: 150, render: (value: string | null) => value || '-' },
                { title: '账面', dataIndex: 'bookQty', width: 100, align: 'right' as const, render: (value: number, item: StocktakeItemView) => `${quantity(value)}${item.material.unit}` },
                { title: '实盘', dataIndex: 'actualQty', width: 100, align: 'right' as const, render: (value: number | null, item: StocktakeItemView) => value == null ? <Text type="secondary">未盘</Text> : `${quantity(value)}${item.material.unit}` },
                {
                  title: '差异', dataIndex: 'differenceQty', width: 110, align: 'right' as const,
                  render: (value: number | null, item: StocktakeItemView) => value == null
                    ? '-'
                    : Number(value) === 0
                      ? <Tag color="green">一致</Tag>
                      : <Tag color={Number(value) > 0 ? 'blue' : 'volcano'}>{Number(value) > 0 ? '+' : ''}{quantity(Number(value))}{item.material.unit}</Tag>,
                },
                { title: '差异原因', dataIndex: 'reasonCode', width: 130, render: (value: string | null) => reasonByCode.get(value as any) || '-' },
                { title: '备注', dataIndex: 'note', width: 200, ellipsis: true, render: (value: string | null) => value || '-' },
                {
                  title: '现场照片', dataIndex: 'attachments', width: 150,
                  render: (urls: string[]) => urls?.length ? (
                    <Image.PreviewGroup>
                      <Space size={4}>{urls.slice(0, 3).map((url) => <Image key={url} src={imageSrc(url)} width={36} height={36} style={{ objectFit: 'cover', borderRadius: 4 }} />)}</Space>
                    </Image.PreviewGroup>
                  ) : '-',
                },
                { title: '盘点时间', dataIndex: 'countedAt', width: 170, render: formatDateTime },
                ...(canEdit && editableDetail ? [{
                  title: '操作', key: 'operation', fixed: 'right' as const, width: 90,
                  render: (_: unknown, item: StocktakeItemView) => <Button size="small" type="link" icon={<EditOutlined />} onClick={() => openCount(item)}>{item.actualQty == null ? '录入' : '修改'}</Button>,
                }] : []),
              ]}
              />
            </section>
          </>
        )}
      </Drawer>

      <Modal
        title={countingItem ? `录入实盘 · ${countingItem.material.code} ${countingItem.material.name}` : '录入实盘'}
        open={!!countingItem}
        onCancel={() => setCountingItem(null)}
        onOk={saveCount}
        confirmLoading={saving}
        okButtonProps={{ disabled: countUploading }}
        destroyOnHidden
      >
        {countingItem && (
          <>
            <Descriptions size="small" bordered column={2} style={{ marginBottom: 16 }}>
              <Descriptions.Item label="库位">{countingItem.locationLabel || '-'}</Descriptions.Item>
              <Descriptions.Item label="账面数量">{quantity(countingItem.bookQty)}{countingItem.material.unit}</Descriptions.Item>
            </Descriptions>
            <Form form={countForm} layout="vertical">
              <Form.Item name="actualQty" label="实盘数量" rules={[{ required: true, message: '请填写实盘数量' }]}>
                <InputNumber min={0} max={999999999} precision={precisionForUnit(countingItem.material.unit)} style={{ width: '100%' }} addonAfter={countingItem.material.unit} />
              </Form.Item>
              <Alert
                type={countDifference === 0 ? 'success' : countDifference > 0 ? 'info' : 'warning'}
                showIcon
                style={{ marginBottom: 16 }}
                message={countDifference === 0 ? '与账面一致' : `${countDifference > 0 ? '盘盈' : '盘亏'} ${quantity(Math.abs(countDifference))}${countingItem.material.unit}`}
              />
              <Form.Item name="reasonCode" label="差异原因" required={countDifference !== 0}>
                <Select allowClear disabled={countDifference === 0} options={STOCKTAKE_REASON_OPTIONS.map((item) => ({ value: item.value, label: item.label }))} />
              </Form.Item>
              <Form.Item name="note" label="核对备注">
                <Input.TextArea rows={3} maxLength={500} placeholder="如：破损2个，已拍照留档" />
              </Form.Item>
              <Form.Item name="attachments" label="现场凭证" extra="选填，最多 6 张；办公室复核时可直接查看">
                <MaterialPhotosUpload max={6} onUploadingChange={setCountUploading} />
              </Form.Item>
            </Form>
          </>
        )}
      </Modal>

      <Modal
        title={`办公室复核${detail ? ` · ${detail.taskNo}` : ''}`}
        open={reviewOpen}
        onCancel={() => setReviewOpen(false)}
        footer={(
          <Space>
            <Button onClick={() => setReviewOpen(false)}>取消</Button>
            <Button danger loading={saving} onClick={() => reviewTask(false)}>退回重盘</Button>
            <Popconfirm
              title="确认复核通过？"
              description="正常盘盈、盘亏会立即过账；若实盘后又有出入库，系统只退回受影响材料重盘。"
              onConfirm={() => reviewTask(true)}
            >
              <Button type="primary" icon={<CheckCircleOutlined />} loading={saving}>复核通过并过账</Button>
            </Popconfirm>
          </Space>
        )}
      >
        {detail && (
          <Alert
            type={detail.differenceCount ? 'warning' : 'success'}
            showIcon
            style={{ marginBottom: 16 }}
            message={detail.differenceCount ? `本次共 ${detail.differenceCount} 项差异` : '本次盘点账实一致'}
            description={detail.differenceCount ? '请在明细中核对差异数量、原因和现场照片后再通过。' : '通过后不会产生库存调整流水。'}
          />
        )}
        <Form form={reviewForm} layout="vertical">
          <Form.Item name="note" label="复核意见" extra="退回重盘时必填，复核通过时选填">
            <Input.TextArea rows={4} maxLength={500} placeholder="写明已核对的事项，或需要重新盘点的原因" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
