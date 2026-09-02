import {
  AlertOutlined, ApiOutlined, BugOutlined, ClockCircleOutlined, EyeOutlined,
  PaperClipOutlined, ReloadOutlined, SafetyCertificateOutlined, UserOutlined, WarningOutlined,
} from '@ant-design/icons';
import {
  App as AntdApp, Button, Card, Col, Collapse, DatePicker, Descriptions, Drawer,
  Empty, Image, Input, Modal, Progress, Row, Segmented, Select, Space, Statistic, Table, Tag,
  Typography,
} from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { request } from '../lib/api';
import { pagePerm, useAuth } from '../lib/auth';

const { Text, Title } = Typography;
const { RangePicker } = DatePicker;
type PageMode = 'overview' | 'operations' | 'feedback' | 'logs';

interface Overview {
  periodHours: number;
  summary: { requests: number; errors: number; slowRequests: number; avgDurationMs: number; maxDurationMs: number; activeUsers: number };
  sources: Array<{ source: string; requests: number; errors: number; avgDurationMs: number }>;
  routes: Array<{ path: string; requests: number; avgDurationMs: number }>;
  pages: Array<{ path: string; views: number; users: number }>;
  hours: Array<{ hour: string; requests: number; errors: number; avgDurationMs: number }>;
  operations: Array<{ action: string; label: string; area: string; uses: number; users: number; failures: number }>;
  logCounts: Record<string, number>;
  runtime: { status: 'healthy' | 'unhealthy'; dbStatus: 'up' | 'down'; dbLatencyMs: number; uptimeSeconds: number; processRssMb: number; processHeapMb: number; serverFreeMemoryMb: number; serverTotalMemoryMb: number; loadAverage: number[]; cpuCount: number };
}

interface LogRow {
  id: number; category: string; level: string; source: string; action: string;
  success: boolean; actorName: string; ipAddress?: string | null;
  userAgent?: string | null; requestMethod?: string | null; requestPath?: string | null;
  statusCode?: number | null; durationMs?: number | null; message: string;
  detail?: Record<string, any> | null; createdAt: string;
}
interface LogList { list: LogRow[]; total: number; page: number; pageSize: number }

const categoryMeta: Record<string, { label: string; color: string }> = {
  login: { label: '登录日志', color: 'blue' }, operation: { label: '业务操作', color: 'geekblue' },
  feedback: { label: '异常反馈', color: 'purple' }, error: { label: '自动异常', color: 'red' },
  alert: { label: '系统告警', color: 'volcano' }, usage: { label: '页面访问', color: 'cyan' },
};
const sourceLabels: Record<string, string> = {
  'admin-web': '管理后台', 'miniapp-staff': '员工端小程序',
  'miniapp-owner': '业主端小程序', miniapp: '微信小程序',
};
const feedbackTypeMeta: Record<string, { label: string; color: string }> = {
  error: { label: '页面报错', color: 'red' }, hard_to_use: { label: '不好用', color: 'orange' },
  data_issue: { label: '数据不对', color: 'volcano' }, suggestion: { label: '改进建议', color: 'blue' },
  other: { label: '其他', color: 'default' },
};
const feedbackStatusMeta: Record<string, { label: string; color: string }> = {
  new: { label: '待处理', color: 'red' }, processing: { label: '处理中', color: 'processing' },
  resolved: { label: '已解决', color: 'success' }, ignored: { label: '已忽略', color: 'default' },
};
const pageLabels: Record<string, string> = {
  '/dashboard': '工作台', '/work-orders': '工单管理', '/inventory': '库存与采购',
  '/stocktakes': '库存盘点', '/materials': '材料 SKU 库', '/reports': '报表查询',
  '/staff': '用户管理', '/roles': '业务角色', '/owners': '业主用户',
  '/settings': '系统设置', '/logs': '日志管理',
  '/pages/quick-repair/quick-repair': 'AI 随手拍报修',
  '/pages/repair-create/repair-create': '报修表单', '/pages/pool/pool': '工单池/派单台',
  '/pages/order-detail/order-detail': '工单详情',
};

function num(value: unknown) { const n = Number(value || 0); return Number.isFinite(n) ? n : 0 }
function operationLabel(row: LogRow) { return String(row.detail?.operationLabel || row.message || row.action) }
function businessArea(row: LogRow) { return String(row.detail?.businessArea || '其他') }
function feedbackStatus(row: LogRow) { return String(row.detail?.feedbackStatus || 'new') }
function pageName(path?: string | null) {
  if (!path) return '—';
  const key = Object.keys(pageLabels).find((item) => path === item || path.startsWith(item));
  return key ? pageLabels[key] : path;
}
function formatUptime(seconds: number) {
  const days = Math.floor(seconds / 86400); const hours = Math.floor((seconds % 86400) / 3600);
  return days ? `${days}天 ${hours}小时` : `${hours}小时 ${Math.floor((seconds % 3600) / 60)}分钟`;
}

export default function LogsPage() {
  const { message } = AntdApp.useApp();
  const { access } = useAuth();
  const canManageFeedback = pagePerm(access, 'logs').canEdit;
  const [mode, setMode] = useState<PageMode>(() => {
    const requested = new URLSearchParams(window.location.search).get('mode');
    return requested === 'feedback' || requested === 'operations' || requested === 'logs' ? requested : 'overview';
  });
  const [overview, setOverview] = useState<Overview | null>(null);
  const [logs, setLogs] = useState<LogList>({ list: [], total: 0, page: 1, pageSize: 30 });
  const [loading, setLoading] = useState(false);
  const [category, setCategory] = useState<string>();
  const [source, setSource] = useState<string>();
  const [success, setSuccess] = useState<string>();
  const [feedbackState, setFeedbackState] = useState<string>();
  const [keyword, setKeyword] = useState('');
  const [dates, setDates] = useState<[Dayjs | null, Dayjs | null] | null>(null);
  const [detailRow, setDetailRow] = useState<LogRow | null>(null);
  const [feedbackAction, setFeedbackAction] = useState<{ row: LogRow; status: string } | null>(null);
  const [handlingNote, setHandlingNote] = useState('');
  const [updatingFeedback, setUpdatingFeedback] = useState(false);

  const loadOverview = useCallback(async () => {
    setLoading(true);
    try { setOverview(await request<Overview>({ url: '/observability/overview' })); }
    catch (e: any) { message.error(e?.message || '运行概况加载失败'); }
    finally { setLoading(false); }
  }, [message]);

  const loadLogs = useCallback(async (page = 1, pageSize = logs.pageSize) => {
    setLoading(true);
    try {
      setLogs(await request<LogList>({ url: '/observability/logs', query: {
        page, pageSize, category: mode === 'operations' ? 'operation' : mode === 'feedback' ? 'feedback' : category,
        source, success: mode === 'feedback' ? undefined : success,
        feedbackStatus: mode === 'feedback' ? feedbackState : undefined,
        keyword: keyword.trim() || undefined, from: dates?.[0]?.startOf('day').toISOString(),
        to: dates?.[1]?.endOf('day').toISOString(),
      } }));
    } catch (e: any) { message.error(e?.message || '日志加载失败'); }
    finally { setLoading(false); }
  }, [category, dates, feedbackState, keyword, logs.pageSize, message, mode, source, success]);

  useEffect(() => { if (mode === 'overview') void loadOverview(); else void loadLogs(1); }, [mode]);

  const updateFeedback = async (row: LogRow, status: string) => {
    setFeedbackAction({ row, status });
    setHandlingNote(
      status === 'processing'
        ? '你的反馈我们已收到，正在安排处理。'
        : status === 'resolved'
          ? '该问题已处理完成，请重新进入小程序查看。如仍有问题，可以再次反馈。'
          : '你的反馈已记录，感谢你的建议。',
    );
  };

  const submitFeedbackStatus = async () => {
    if (!feedbackAction) return;
    const note = handlingNote.trim();
    if (!note) return message.warning('请填写给用户的处理回复');
    setUpdatingFeedback(true);
    try {
      await request({
        method: 'PATCH',
        url: `/observability/feedback/${feedbackAction.row.id}/status`,
        data: { status: feedbackAction.status, note },
      });
      message.success(`已标记为「${feedbackStatusMeta[feedbackAction.status]?.label}」，并通知反馈人`);
      setFeedbackAction(null);
      setDetailRow(null);
      void loadLogs(logs.page);
    } catch (e: any) { message.error(e?.message || '状态更新失败'); }
    finally { setUpdatingFeedback(false); }
  };

  const operationColumns = useMemo(() => [
    { title: '时间', dataIndex: 'createdAt', width: 154, render: (v: string) => dayjs(v).format('MM-DD HH:mm:ss') },
    { title: '业务', width: 92, render: (_: unknown, r: LogRow) => <Tag color="blue">{businessArea(r)}</Tag> },
    { title: '操作类型', width: 190, render: (_: unknown, r: LogRow) => <Text strong>{operationLabel(r)}</Text> },
    { title: '业务对象', width: 150, render: (_: unknown, r: LogRow) => r.detail?.businessNo || (r.detail?.objectId ? `#${r.detail.objectId}` : '—') },
    { title: '操作人', dataIndex: 'actorName', width: 130, ellipsis: true },
    { title: '来源', dataIndex: 'source', width: 130, render: (v: string) => sourceLabels[v] || v },
    { title: '结果', dataIndex: 'success', width: 86, render: (v: boolean) => <Tag color={v ? 'success' : 'error'}>{v ? '成功' : '失败'}</Tag> },
    { title: '查看', width: 78, fixed: 'right' as const, render: (_: unknown, r: LogRow) => <Button type="link" icon={<EyeOutlined />} onClick={() => setDetailRow(r)}>详情</Button> },
  ], []);
  const feedbackColumns = useMemo(() => [
    { title: '时间', dataIndex: 'createdAt', width: 154, render: (v: string) => dayjs(v).format('MM-DD HH:mm:ss') },
    { title: '状态', width: 96, render: (_: unknown, r: LogRow) => { const m = feedbackStatusMeta[feedbackStatus(r)]; return <Tag color={m?.color}>{m?.label}</Tag>; } },
    { title: '类型', width: 108, render: (_: unknown, r: LogRow) => { const m = feedbackTypeMeta[String(r.detail?.feedbackType || 'other')]; return <Tag color={m?.color}>{m?.label}</Tag>; } },
    { title: '反馈内容', dataIndex: 'message', width: 360, ellipsis: { showTitle: false }, render: (v: string, r: LogRow) => <div className="pms-log-message"><Text ellipsis={{ tooltip: v }}>{v}</Text>{Array.isArray(r.detail?.attachments) && r.detail.attachments.length > 0 && <Text type="secondary"><PaperClipOutlined /> {r.detail.attachments.length} 个附件</Text>}</div> },
    { title: '出错页面', dataIndex: 'requestPath', width: 180, ellipsis: true, render: (v: string) => pageName(v) },
    { title: '反馈人', dataIndex: 'actorName', width: 120, ellipsis: true },
    { title: '来源', dataIndex: 'source', width: 120, render: (v: string) => sourceLabels[v] || v },
    { title: '处理', width: canManageFeedback ? 232 : 76, fixed: 'right' as const, render: (_: unknown, r: LogRow) => <Space size={2}>
      <Button type="link" onClick={() => setDetailRow(r)}>查看</Button>
      {canManageFeedback && feedbackStatus(r) !== 'processing' && <Button type="link" onClick={() => void updateFeedback(r, 'processing')}>处理中</Button>}
      {canManageFeedback && feedbackStatus(r) !== 'resolved' && <Button type="link" onClick={() => void updateFeedback(r, 'resolved')}>已解决</Button>}
    </Space> },
  ], [canManageFeedback, logs.page]);
  const logColumns = useMemo(() => [
    { title: '时间', dataIndex: 'createdAt', width: 154, render: (v: string) => dayjs(v).format('MM-DD HH:mm:ss') },
    { title: '类型', dataIndex: 'category', width: 110, render: (v: string) => <Tag color={categoryMeta[v]?.color}>{categoryMeta[v]?.label || v}</Tag> },
    { title: '来源', dataIndex: 'source', width: 126, render: (v: string) => sourceLabels[v] || v },
    { title: '操作人', dataIndex: 'actorName', width: 126, ellipsis: true },
    { title: '结果', dataIndex: 'success', width: 86, render: (v: boolean) => <Tag color={v ? 'success' : 'error'}>{v ? '成功' : '异常'}</Tag> },
    { title: '事件与说明', dataIndex: 'message', width: 400, ellipsis: { showTitle: false }, render: (v: string) => <Text ellipsis={{ tooltip: v }}>{v}</Text> },
    { title: '查看', width: 78, fixed: 'right' as const, render: (_: unknown, r: LogRow) => <Button type="link" onClick={() => setDetailRow(r)}>详情</Button> },
  ], []);

  const errorRate = overview?.summary.requests ? (overview.summary.errors / overview.summary.requests) * 100 : 0;
  const memoryPercent = overview?.runtime.serverTotalMemoryMb ? ((overview.runtime.serverTotalMemoryMb - overview.runtime.serverFreeMemoryMb) / overview.runtime.serverTotalMemoryMb) * 100 : 0;
  const maxHourlyRequests = Math.max(1, ...(overview?.hours || []).map((row) => num(row.requests)));

  return <div className="pms-observability-page">
    <div className="pms-page-toolbar">
      <Segmented value={mode} onChange={(v) => setMode(v as PageMode)} options={[
        { label: '运行与使用概况', value: 'overview', icon: <ApiOutlined /> },
        { label: '重要业务操作', value: 'operations', icon: <SafetyCertificateOutlined /> },
        { label: '异常反馈', value: 'feedback', icon: <BugOutlined /> },
        { label: '全部日志', value: 'logs', icon: <AlertOutlined /> },
      ]} />
      <Button icon={<ReloadOutlined />} loading={loading} onClick={() => mode === 'overview' ? void loadOverview() : void loadLogs(logs.page)}>刷新</Button>
    </div>

    {mode === 'overview' ? <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {!!overview && overview.runtime.status !== 'healthy' && <div className="pms-health-alert"><AlertOutlined /> 数据库连接异常，请立即联系技术人员</div>}
      <Row gutter={[16, 16]}>
        <Col xs={24} sm={12} xl={6}><Metric title="24小时请求量" value={overview?.summary.requests || 0} icon={<ApiOutlined />} note="网站和两个小程序合计" /></Col>
        <Col xs={24} sm={12} xl={6}><Metric title="服务异常率" value={errorRate} suffix="%" precision={2} icon={<WarningOutlined />} note={`${overview?.summary.errors || 0} 次服务端异常`} danger={errorRate >= 5} /></Col>
        <Col xs={24} sm={12} xl={6}><Metric title="平均响应" value={overview?.summary.avgDurationMs || 0} suffix="ms" icon={<ClockCircleOutlined />} note={`最慢 ${overview?.summary.maxDurationMs || 0} ms`} /></Col>
        <Col xs={24} sm={12} xl={6}><Metric title="活跃用户" value={overview?.summary.activeUsers || 0} icon={<UserOutlined />} note="24小时内有访问的账号" /></Col>
      </Row>
      <Row gutter={[16, 16]}>
        <Col xs={24} xl={15}><Card title="24小时访问与异常趋势" className="pms-panel-card">
          {overview?.hours?.length ? <div className="pms-hourly-chart">{overview.hours.map((row) => <div className="pms-hourly-column" key={row.hour} title={`${row.requests}次 / ${row.errors}异常`}><div className="pms-hourly-bars"><span style={{ height: `${Math.max(6, num(row.requests) / maxHourlyRequests * 100)}%` }} /><i style={{ height: `${row.errors ? Math.max(8, num(row.errors) / maxHourlyRequests * 100) : 0}%` }} /></div><small>{dayjs(row.hour).format('HH')}</small></div>)}</div> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无访问数据" />}
          <div className="pms-chart-legend"><span><i className="is-request" />请求量</span><span><i className="is-error" />异常</span></div>
        </Card></Col>
        <Col xs={24} xl={9}><Card title="服务运行状态" className="pms-panel-card"><Descriptions column={1} size="small">
          <Descriptions.Item label="数据库">{overview?.runtime.dbStatus === 'up' ? <Tag color="success">正常 · {overview.runtime.dbLatencyMs}ms</Tag> : <Tag color="error">不可用</Tag>}</Descriptions.Item>
          <Descriptions.Item label="连续运行">{formatUptime(overview?.runtime.uptimeSeconds || 0)}</Descriptions.Item>
          <Descriptions.Item label="进程内存">{overview?.runtime.processRssMb || 0} MB（堆 {overview?.runtime.processHeapMb || 0} MB）</Descriptions.Item>
          <Descriptions.Item label="CPU 负载">{overview?.runtime.loadAverage?.join(' / ') || '—'}（{overview?.runtime.cpuCount || 0}核）</Descriptions.Item>
        </Descriptions><div className="pms-memory-row"><Text type="secondary">服务器内存使用</Text><Progress percent={Math.round(memoryPercent)} status={memoryPercent >= 90 ? 'exception' : 'normal'} /></div></Card></Col>
      </Row>
      <Row gutter={[16, 16]}>
        <Col xs={24} xl={14}><Card title="功能使用排行（近30天）" className="pms-panel-card" extra={<Text type="secondary">用量 · 人数 · 失败</Text>}><Table size="small" rowKey="action" pagination={false} dataSource={overview?.operations || []} columns={[
          { title: '业务', dataIndex: 'area', width: 88, render: (v) => <Tag color="blue">{v}</Tag> }, { title: '功能', dataIndex: 'label', ellipsis: true },
          { title: '用量', dataIndex: 'uses', align: 'right', width: 66 }, { title: '人数', dataIndex: 'users', align: 'right', width: 66 },
          { title: '失败', dataIndex: 'failures', align: 'right', width: 66, render: (v) => <span className={v ? 'pms-log-slow' : ''}>{v}</span> },
        ]} /></Card></Col>
        <Col xs={24} xl={10}><Card title="访问最多的页面（近7天）" className="pms-panel-card"><Table size="small" rowKey="path" pagination={false} dataSource={overview?.pages || []} columns={[
          { title: '页面', dataIndex: 'path', ellipsis: true, render: (v) => pageName(v) }, { title: '访问', dataIndex: 'views', align: 'right', width: 70 }, { title: '人数', dataIndex: 'users', align: 'right', width: 70 },
        ]} /></Card></Col>
      </Row>
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}><Card title="各端使用与性能" className="pms-panel-card"><Table size="small" rowKey="source" pagination={false} dataSource={overview?.sources || []} columns={[{ title: '终端', dataIndex: 'source', render: (v) => sourceLabels[v] || v }, { title: '请求', dataIndex: 'requests', align: 'right' }, { title: '异常', dataIndex: 'errors', align: 'right', render: (v) => <span className={v ? 'pms-log-slow' : ''}>{v}</span> }, { title: '平均', dataIndex: 'avgDurationMs', align: 'right', render: (v) => `${v}ms` }]} /></Card></Col>
        <Col xs={24} lg={12}><Card title="调用最多的接口（技术排障）" className="pms-panel-card"><Table size="small" rowKey="path" pagination={false} dataSource={overview?.routes || []} columns={[{ title: '接口', dataIndex: 'path', ellipsis: true }, { title: '次数', dataIndex: 'requests', align: 'right' }, { title: '平均', dataIndex: 'avgDurationMs', align: 'right', render: (v) => `${v}ms` }]} /></Card></Col>
      </Row>
    </Space> : <Card className="pms-panel-card pms-log-card">
      <div className="pms-log-table-head"><div><Title level={4}>{mode === 'operations' ? '重要业务操作' : mode === 'feedback' ? '用户异常反馈' : '全部日志'}</Title><Text type="secondary">{mode === 'operations' ? '按业务语义记录，详情默认隐藏' : mode === 'feedback' ? '自动附带出错页面、版本和最近错误' : '用于登录、告警和技术排障'}</Text></div></div>
      <div className="pms-filter-bar">
        {mode === 'logs' && <Select allowClear placeholder="日志类型" value={category} onChange={setCategory} style={{ width: 136 }} options={Object.entries(categoryMeta).map(([value, meta]) => ({ value, label: meta.label }))} />}
        {mode === 'feedback' && <Select allowClear placeholder="处理状态" value={feedbackState} onChange={setFeedbackState} style={{ width: 132 }} options={Object.entries(feedbackStatusMeta).map(([value, meta]) => ({ value, label: meta.label }))} />}
        <Select allowClear placeholder="来源终端" value={source} onChange={setSource} style={{ width: 150 }} options={Object.entries(sourceLabels).filter(([k]) => k !== 'miniapp').map(([value, label]) => ({ value, label }))} />
        {mode !== 'feedback' && <Select allowClear placeholder="执行结果" value={success} onChange={setSuccess} style={{ width: 120 }} options={[{ value: 'true', label: '成功' }, { value: 'false', label: '失败/异常' }]} />}
        <RangePicker value={dates} onChange={setDates} />
        <Input.Search allowClear placeholder="搜索操作、说明、页面或单号" value={keyword} onChange={(e) => setKeyword(e.target.value)} onSearch={() => void loadLogs(1)} style={{ minWidth: 230, flex: 1 }} />
        <Button type="primary" onClick={() => void loadLogs(1)}>查询</Button>
      </div>
      <Table<LogRow> rowKey="id" loading={loading} dataSource={logs.list} columns={mode === 'operations' ? operationColumns : mode === 'feedback' ? feedbackColumns : logColumns} scroll={{ x: mode === 'feedback' ? 1320 : 1100 }} pagination={{ current: logs.page, pageSize: logs.pageSize, total: logs.total, showSizeChanger: true, showTotal: (total) => `共 ${total} 条`, onChange: (page, pageSize) => void loadLogs(page, pageSize) }} />
    </Card>}
    <LogDetailDrawer row={detailRow} onClose={() => setDetailRow(null)} canManageFeedback={canManageFeedback} onStatus={updateFeedback} />
    <Modal
      title={`标记为「${feedbackStatusMeta[feedbackAction?.status || 'new']?.label}」并回复用户`}
      open={!!feedbackAction}
      confirmLoading={updatingFeedback}
      okText="确认并通知用户"
      cancelText="取消"
      onOk={() => void submitFeedbackStatus()}
      onCancel={() => !updatingFeedback && setFeedbackAction(null)}
    >
      <Text type="secondary">这段回复会显示在用户小程序的“我的反馈”中，并发送一条站内消息。</Text>
      <Input.TextArea
        value={handlingNote}
        onChange={(event) => setHandlingNote(event.target.value)}
        maxLength={500}
        showCount
        rows={5}
        style={{ marginTop: 14 }}
        placeholder="说明正在怎么处理，或已经解决了什么"
      />
    </Modal>
  </div>;
}

function Metric({ title, value, suffix, precision, icon, note, danger }: { title: string; value: number; suffix?: string; precision?: number; icon: React.ReactNode; note: string; danger?: boolean }) {
  return <Card className={`pms-metric-card ${danger ? 'is-danger' : ''}`}><Statistic title={title} value={value} suffix={suffix} precision={precision} prefix={icon} valueStyle={{ color: danger ? '#cf1322' : undefined }} /><Text type="secondary">{note}</Text></Card>;
}

function LogDetailDrawer({ row, onClose, canManageFeedback, onStatus }: { row: LogRow | null; onClose: () => void; canManageFeedback: boolean; onStatus: (row: LogRow, status: string) => Promise<void> }) {
  if (!row) return null;
  const detail = row.detail || {}; const status = feedbackStatus(row);
  const attachments = Array.isArray(detail.attachments) ? detail.attachments : [];
  const feedbackImages = attachments.filter((item: any) => item?.type === 'image' && item?.url);
  const feedbackVideos = attachments.filter((item: any) => item?.type === 'video' && item?.url);
  const friendly = Object.entries(detail).filter(([key]) => !['history', 'context', 'stack', 'operationLabel', 'businessArea', 'feedbackStatus', 'errorMessage', 'attachments'].includes(key));
  return <Drawer title={row.category === 'feedback' ? '反馈详情' : row.category === 'operation' ? '业务操作详情' : '日志详情'} open width={680} onClose={onClose}>
    <Space direction="vertical" size={18} style={{ width: '100%' }}>
      {row.category === 'feedback' && <div className="pms-feedback-detail-head"><Space><Tag color={feedbackStatusMeta[status]?.color}>{feedbackStatusMeta[status]?.label}</Tag><Tag color={feedbackTypeMeta[String(detail.feedbackType || 'other')]?.color}>{feedbackTypeMeta[String(detail.feedbackType || 'other')]?.label}</Tag></Space>{canManageFeedback && <Space><Button disabled={status === 'processing'} onClick={() => void onStatus(row, 'processing')}>标记处理中</Button><Button type="primary" disabled={status === 'resolved'} onClick={() => void onStatus(row, 'resolved')}>标记已解决</Button></Space>}</div>}
      <Descriptions bordered size="small" column={1}>
        <Descriptions.Item label="时间">{dayjs(row.createdAt).format('YYYY-MM-DD HH:mm:ss')}</Descriptions.Item>
        <Descriptions.Item label={row.category === 'feedback' ? '反馈内容' : '操作类型'}><Text strong>{row.category === 'operation' ? operationLabel(row) : row.message}</Text></Descriptions.Item>
        {row.category === 'operation' && <Descriptions.Item label="业务模块">{businessArea(row)}</Descriptions.Item>}
        <Descriptions.Item label="操作人">{row.actorName}</Descriptions.Item><Descriptions.Item label="来源">{sourceLabels[row.source] || row.source}</Descriptions.Item>
        <Descriptions.Item label="页面/位置">{pageName(row.requestPath)}{row.requestPath && pageName(row.requestPath) !== row.requestPath ? <Text type="secondary"> · {row.requestPath}</Text> : null}</Descriptions.Item>
        {detail.errorMessage && <Descriptions.Item label="自动捕获的错误"><Text type="danger">{String(detail.errorMessage)}</Text></Descriptions.Item>}
        {friendly.map(([key, value]) => value == null ? null : <Descriptions.Item key={key} label={detailLabel(key)}>{typeof value === 'object' ? JSON.stringify(value) : String(value)}</Descriptions.Item>)}
      </Descriptions>
      {!!attachments.length && <div className="pms-feedback-attachments">
        <Text strong>现场附件（{feedbackImages.length} 张图片，{feedbackVideos.length} 个视频）</Text>
        <div className="pms-feedback-media-grid">
          <Image.PreviewGroup>{feedbackImages.map((item: any, index: number) => <Image key={`${item.url}-${index}`} src={item.url} width={112} height={112} style={{ objectFit: 'cover', borderRadius: 8 }} />)}</Image.PreviewGroup>
          {feedbackVideos.map((item: any, index: number) => <video key={`${item.url}-${index}`} src={item.url} controls preload="metadata" className="pms-feedback-video">浏览器不支持播放此视频</video>)}
        </div>
      </div>}
      <Collapse ghost items={[{ key: 'technical', label: '查看技术信息（默认隐藏）', children: <Descriptions bordered size="small" column={1}>
        <Descriptions.Item label="请求">{[row.requestMethod, row.requestPath].filter(Boolean).join(' ') || '—'}</Descriptions.Item><Descriptions.Item label="状态/耗时">{row.statusCode || '—'} / {row.durationMs == null ? '—' : `${row.durationMs}ms`}</Descriptions.Item><Descriptions.Item label="IP">{row.ipAddress || '—'}</Descriptions.Item><Descriptions.Item label="设备">{row.userAgent || '—'}</Descriptions.Item><Descriptions.Item label="原始附加信息"><pre className="pms-log-detail">{JSON.stringify(row.detail, null, 2)}</pre></Descriptions.Item>
      </Descriptions> }]} />
    </Space>
  </Drawer>;
}

function detailLabel(key: string) {
  return ({ objectType: '业务对象', objectId: '对象编号', businessNo: '业务单号', communityId: '小区编号', buildingId: '楼栋编号', houseId: '房屋编号', assigneeId: '维修工编号', warehouseId: '仓库编号', materialId: '材料编号', repairType: '报修类型', entryMode: '报修入口', urgent: '是否紧急', itemCount: '明细数', materialCount: '材料数', pageTitle: '页面名称', version: '端上版本', handlingNote: '处理备注' } as Record<string, string>)[key] || key;
}
