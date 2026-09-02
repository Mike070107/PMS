import {
  AlertOutlined,
  ApiOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  DatabaseOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  UserOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import {
  App as AntdApp,
  Button,
  Card,
  Col,
  DatePicker,
  Descriptions,
  Empty,
  Input,
  Progress,
  Row,
  Segmented,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
} from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { request } from '../lib/api';

const { Text } = Typography;
const { RangePicker } = DatePicker;

interface Overview {
  periodHours: number;
  summary: {
    requests: number;
    errors: number;
    slowRequests: number;
    avgDurationMs: number;
    maxDurationMs: number;
    activeUsers: number;
  };
  sources: Array<{ source: string; requests: number; errors: number; avgDurationMs: number }>;
  routes: Array<{ path: string; requests: number; avgDurationMs: number }>;
  pages: Array<{ path: string; views: number; users: number }>;
  hours: Array<{ hour: string; requests: number; errors: number; avgDurationMs: number }>;
  logCounts: Record<string, number>;
  runtime: {
    status: 'healthy' | 'unhealthy';
    dbStatus: 'up' | 'down';
    dbLatencyMs: number;
    uptimeSeconds: number;
    processRssMb: number;
    processHeapMb: number;
    serverFreeMemoryMb: number;
    serverTotalMemoryMb: number;
    loadAverage: number[];
    cpuCount: number;
  };
}

interface LogRow {
  id: number;
  category: string;
  level: string;
  source: string;
  action: string;
  success: boolean;
  actorName: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  requestMethod?: string | null;
  requestPath?: string | null;
  statusCode?: number | null;
  durationMs?: number | null;
  message: string;
  detail?: Record<string, unknown> | null;
  createdAt: string;
}

interface LogList {
  list: LogRow[];
  total: number;
  page: number;
  pageSize: number;
}

const categoryMeta: Record<string, { label: string; color: string }> = {
  login: { label: '登录日志', color: 'blue' },
  operation: { label: '重要操作', color: 'geekblue' },
  error: { label: '异常', color: 'red' },
  alert: { label: '系统告警', color: 'volcano' },
  usage: { label: '页面访问', color: 'cyan' },
};

const sourceLabels: Record<string, string> = {
  'admin-web': '管理后台',
  'miniapp-staff': '员工端小程序',
  'miniapp-owner': '业主端小程序',
  miniapp: '微信小程序',
};

function number(value: unknown) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

function formatUptime(seconds: number) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  if (days) return `${days}天 ${hours}小时`;
  return `${hours}小时 ${Math.floor((seconds % 3600) / 60)}分钟`;
}

export default function LogsPage() {
  const { message } = AntdApp.useApp();
  const [mode, setMode] = useState<'overview' | 'logs'>('overview');
  const [overview, setOverview] = useState<Overview | null>(null);
  const [logs, setLogs] = useState<LogList>({ list: [], total: 0, page: 1, pageSize: 30 });
  const [loading, setLoading] = useState(false);
  const [category, setCategory] = useState<string>();
  const [source, setSource] = useState<string>();
  const [success, setSuccess] = useState<string>();
  const [keyword, setKeyword] = useState('');
  const [dates, setDates] = useState<[Dayjs | null, Dayjs | null] | null>(null);

  const loadOverview = useCallback(async () => {
    setLoading(true);
    try {
      setOverview(await request<Overview>({ url: '/observability/overview' }));
    } catch (e: any) {
      message.error(e?.message || '运行概况加载失败');
    } finally {
      setLoading(false);
    }
  }, [message]);

  const loadLogs = useCallback(async (page = 1, pageSize = logs.pageSize) => {
    setLoading(true);
    try {
      setLogs(await request<LogList>({
        url: '/observability/logs',
        query: {
          page,
          pageSize,
          category,
          source,
          success,
          keyword: keyword.trim() || undefined,
          from: dates?.[0]?.startOf('day').toISOString(),
          to: dates?.[1]?.endOf('day').toISOString(),
        },
      }));
    } catch (e: any) {
      message.error(e?.message || '日志加载失败');
    } finally {
      setLoading(false);
    }
  }, [category, dates, keyword, logs.pageSize, message, source, success]);

  useEffect(() => {
    if (mode === 'overview') void loadOverview();
    else void loadLogs(1);
  }, [mode]);

  const errorRate = overview?.summary.requests
    ? (overview.summary.errors / overview.summary.requests) * 100
    : 0;
  const memoryPercent = overview?.runtime.serverTotalMemoryMb
    ? ((overview.runtime.serverTotalMemoryMb - overview.runtime.serverFreeMemoryMb) / overview.runtime.serverTotalMemoryMb) * 100
    : 0;
  const maxHourlyRequests = Math.max(1, ...(overview?.hours || []).map((row) => number(row.requests)));

  const logColumns = useMemo(() => [
    {
      title: '时间', dataIndex: 'createdAt', width: 166,
      render: (value: string) => <span className="pms-log-time">{dayjs(value).format('MM-DD HH:mm:ss')}</span>,
    },
    {
      title: '类型', dataIndex: 'category', width: 108,
      render: (value: string) => <Tag color={categoryMeta[value]?.color}>{categoryMeta[value]?.label || value}</Tag>,
    },
    {
      title: '来源', dataIndex: 'source', width: 128,
      render: (value: string) => sourceLabels[value] || value,
    },
    { title: '操作人', dataIndex: 'actorName', width: 130, ellipsis: true },
    {
      title: '结果', dataIndex: 'success', width: 88,
      render: (value: boolean, row: LogRow) => value
        ? <Tag icon={<CheckCircleOutlined />} color="success">成功</Tag>
        : <Tag icon={<WarningOutlined />} color="error">{row.statusCode || '异常'}</Tag>,
    },
    {
      title: '事件与说明', dataIndex: 'message', width: 380,
      render: (value: string, row: LogRow) => (
        <div className="pms-log-message">
          <Text strong={row.category === 'alert' || row.category === 'error'}>{value}</Text>
          <Text type="secondary" ellipsis>{row.action}{row.requestPath ? ` · ${row.requestPath}` : ''}</Text>
        </div>
      ),
    },
    {
      title: '耗时', dataIndex: 'durationMs', width: 92, align: 'right' as const,
      render: (value?: number | null) => value == null ? '—' : <span className={value >= 2000 ? 'pms-log-slow' : ''}>{value} ms</span>,
    },
  ], []);

  return (
    <div className="pms-observability-page">
      <div className="pms-page-toolbar">
        <Segmented
          value={mode}
          onChange={(value) => setMode(value as 'overview' | 'logs')}
          options={[
            { label: '运行与使用概况', value: 'overview', icon: <ApiOutlined /> },
            { label: '日志查询', value: 'logs', icon: <SafetyCertificateOutlined /> },
          ]}
        />
        <Button
          icon={<ReloadOutlined />}
          loading={loading}
          onClick={() => mode === 'overview' ? void loadOverview() : void loadLogs(logs.page)}
        >刷新</Button>
      </div>

      {mode === 'overview' ? (
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          {!!overview && overview.runtime.status !== 'healthy' && (
            <div className="pms-health-alert"><AlertOutlined /> 数据库连接异常，请立即联系技术人员</div>
          )}
          <Row gutter={[16, 16]}>
            <Col xs={24} sm={12} xl={6}><Card className="pms-metric-card"><Statistic title="24小时请求量" value={overview?.summary.requests || 0} prefix={<ApiOutlined />} /><Text type="secondary">网站和两个小程序合计</Text></Card></Col>
            <Col xs={24} sm={12} xl={6}><Card className={`pms-metric-card ${errorRate >= 5 ? 'is-danger' : ''}`}><Statistic title="服务异常率" value={errorRate} precision={2} suffix="%" prefix={<WarningOutlined />} valueStyle={{ color: errorRate >= 5 ? '#cf1322' : undefined }} /><Text type="secondary">{overview?.summary.errors || 0} 次服务端异常</Text></Card></Col>
            <Col xs={24} sm={12} xl={6}><Card className="pms-metric-card"><Statistic title="平均响应" value={overview?.summary.avgDurationMs || 0} suffix="ms" prefix={<ClockCircleOutlined />} /><Text type="secondary">最慢 {overview?.summary.maxDurationMs || 0} ms</Text></Card></Col>
            <Col xs={24} sm={12} xl={6}><Card className="pms-metric-card"><Statistic title="活跃用户" value={overview?.summary.activeUsers || 0} prefix={<UserOutlined />} /><Text type="secondary">24小时内有访问的账号</Text></Card></Col>
          </Row>

          <Row gutter={[16, 16]}>
            <Col xs={24} xl={15}>
              <Card title="24小时访问与异常趋势" className="pms-panel-card">
                {overview?.hours?.length ? (
                  <div className="pms-hourly-chart">
                    {overview.hours.map((row) => {
                      const requestHeight = Math.max(6, (number(row.requests) / maxHourlyRequests) * 100);
                      const errorHeight = row.errors ? Math.max(8, (number(row.errors) / maxHourlyRequests) * 100) : 0;
                      return (
                        <div className="pms-hourly-column" key={row.hour} title={`${dayjs(row.hour).format('HH:mm')} · ${row.requests} 次 · ${row.errors} 异常 · 平均 ${row.avgDurationMs}ms`}>
                          <div className="pms-hourly-bars"><span style={{ height: `${requestHeight}%` }} /><i style={{ height: `${errorHeight}%` }} /></div>
                          <small>{dayjs(row.hour).format('HH')}</small>
                        </div>
                      );
                    })}
                  </div>
                ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无访问数据" />}
                <div className="pms-chart-legend"><span><i className="is-request" />请求量</span><span><i className="is-error" />异常</span></div>
              </Card>
            </Col>
            <Col xs={24} xl={9}>
              <Card title="服务运行状态" className="pms-panel-card">
                <Descriptions column={1} size="small">
                  <Descriptions.Item label="数据库">{overview?.runtime.dbStatus === 'up' ? <Tag color="success">正常 · {overview.runtime.dbLatencyMs}ms</Tag> : <Tag color="error">不可用</Tag>}</Descriptions.Item>
                  <Descriptions.Item label="连续运行">{formatUptime(overview?.runtime.uptimeSeconds || 0)}</Descriptions.Item>
                  <Descriptions.Item label="进程内存">{overview?.runtime.processRssMb || 0} MB（堆 {overview?.runtime.processHeapMb || 0} MB）</Descriptions.Item>
                  <Descriptions.Item label="CPU 负载">{overview?.runtime.loadAverage?.join(' / ') || '—'}（{overview?.runtime.cpuCount || 0} 核）</Descriptions.Item>
                </Descriptions>
                <div className="pms-memory-row">
                  <Text type="secondary">服务器内存使用</Text>
                  <Progress percent={Math.round(memoryPercent)} status={memoryPercent >= 90 ? 'exception' : 'normal'} />
                </div>
              </Card>
            </Col>
          </Row>

          <Row gutter={[16, 16]}>
            <Col xs={24} lg={8}><Card title="各端使用与性能" className="pms-panel-card"><Table size="small" rowKey="source" pagination={false} dataSource={overview?.sources || []} columns={[{ title: '终端', dataIndex: 'source', render: (v) => sourceLabels[v] || v }, { title: '请求', dataIndex: 'requests', align: 'right' }, { title: '异常', dataIndex: 'errors', align: 'right', render: (v) => <span className={v ? 'pms-log-slow' : ''}>{v}</span> }, { title: '平均', dataIndex: 'avgDurationMs', align: 'right', render: (v) => `${v}ms` }]} /></Card></Col>
            <Col xs={24} lg={8}><Card title="访问最多的功能" className="pms-panel-card"><Table size="small" rowKey="path" pagination={false} dataSource={overview?.pages || []} columns={[{ title: '页面', dataIndex: 'path', ellipsis: true }, { title: '访问', dataIndex: 'views', align: 'right' }, { title: '人数', dataIndex: 'users', align: 'right' }]} /></Card></Col>
            <Col xs={24} lg={8}><Card title="调用最多的接口" className="pms-panel-card"><Table size="small" rowKey="path" pagination={false} dataSource={overview?.routes || []} columns={[{ title: '接口', dataIndex: 'path', ellipsis: true }, { title: '次数', dataIndex: 'requests', align: 'right' }, { title: '平均', dataIndex: 'avgDurationMs', align: 'right', render: (v) => `${v}ms` }]} /></Card></Col>
          </Row>
        </Space>
      ) : (
        <Card className="pms-panel-card pms-log-card">
          <div className="pms-filter-bar">
            <Select allowClear placeholder="日志类型" value={category} onChange={setCategory} style={{ width: 136 }} options={Object.entries(categoryMeta).map(([value, meta]) => ({ value, label: meta.label }))} />
            <Select allowClear placeholder="来源终端" value={source} onChange={setSource} style={{ width: 150 }} options={Object.entries(sourceLabels).filter(([key]) => key !== 'miniapp').map(([value, label]) => ({ value, label }))} />
            <Select allowClear placeholder="执行结果" value={success} onChange={setSuccess} style={{ width: 120 }} options={[{ value: 'true', label: '成功' }, { value: 'false', label: '失败/异常' }]} />
            <RangePicker value={dates} onChange={setDates} />
            <Input.Search allowClear placeholder="搜索说明、操作或地址" value={keyword} onChange={(e) => setKeyword(e.target.value)} onSearch={() => void loadLogs(1)} style={{ minWidth: 220, flex: 1 }} />
            <Button type="primary" onClick={() => void loadLogs(1)}>查询</Button>
          </div>
          <Table<LogRow>
            rowKey="id"
            loading={loading}
            dataSource={logs.list}
            columns={logColumns}
            scroll={{ x: 1100 }}
            pagination={{ current: logs.page, pageSize: logs.pageSize, total: logs.total, showSizeChanger: true, showTotal: (total) => `共 ${total} 条`, onChange: (page, pageSize) => void loadLogs(page, pageSize) }}
            expandable={{ expandedRowRender: (row) => <Descriptions bordered size="small" column={{ xs: 1, md: 2 }}><Descriptions.Item label="IP 地址">{row.ipAddress || '—'}</Descriptions.Item><Descriptions.Item label="状态/耗时">{row.statusCode || '—'} / {row.durationMs == null ? '—' : `${row.durationMs}ms`}</Descriptions.Item><Descriptions.Item label="请求地址" span={2}>{[row.requestMethod, row.requestPath].filter(Boolean).join(' ') || '—'}</Descriptions.Item><Descriptions.Item label="浏览器/设备" span={2}>{row.userAgent || '—'}</Descriptions.Item>{row.detail && <Descriptions.Item label="附加信息" span={2}><pre className="pms-log-detail">{JSON.stringify(row.detail, null, 2)}</pre></Descriptions.Item>}</Descriptions> }}
          />
        </Card>
      )}
    </div>
  );
}
