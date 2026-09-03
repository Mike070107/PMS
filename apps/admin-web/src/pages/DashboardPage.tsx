import {
  ApartmentOutlined,
  AuditOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  FileDoneOutlined,
  HomeOutlined,
  IdcardOutlined,
  QrcodeOutlined,
  ReloadOutlined,
  RightOutlined,
  ShoppingOutlined,
  TeamOutlined,
  ToolOutlined,
} from '@ant-design/icons';
import {
  App as AntdApp,
  Button,
  Card,
  Col,
  Empty,
  Row,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AuditStatus,
  DashboardMetrics,
  PurchaseRequestStatus,
  WorkOrderStatus,
} from '@pms/shared-types';
import { request } from '../lib/api';
import { useAuth } from '../lib/auth';
import { nameOr } from '../lib/displayName';

const { Text } = Typography;

interface WorkOrderRow {
  id: number;
  orderNo: string;
  status: WorkOrderStatus;
  assigneeId?: number | null;
  /**
   * 工种的**中文名**，由 /work-orders 一并给出。
   * 别拿 skill 直接显示 —— 那是编码（menjing、water），而且租户自建的类型
   * 前端根本没有对照表，只能显示成一串拼音（2026-09-01 用户在工作台看到的就是这个）。
   */
  repairTypeLabel?: string | null;
  skill?: string | null;
  /** 维修工姓名，同样由接口给 —— 前端没有 id→姓名 的表，硬拼只能拼出「员工 #2」 */
  assigneeName?: string | null;
  createdAt?: string;
}

interface AuditRow {
  id: number;
  status: AuditStatus;
}

interface PurchaseRequestRow {
  id: number;
  status: PurchaseRequestStatus;
}

const statusLabel: Record<WorkOrderStatus, string> = {
  created: '待派单',
  dispatched: '已派单',
  in_progress: '维修中',
  waiting_material: '等待材料',
  done_pending_review: '待验收',
  completed: '已完成',
  cancelled: '已撤单',
  voided: '已作废',
};

const statusColor: Record<WorkOrderStatus, string> = {
  created: 'gold',
  dispatched: 'blue',
  in_progress: 'processing',
  waiting_material: 'orange',
  done_pending_review: 'purple',
  completed: 'green',
  cancelled: 'default',
  voided: 'default',
};

function getGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 6) return '夜深了';
  if (hour < 9) return '早上好';
  if (hour < 12) return '上午好';
  if (hour < 14) return '中午好';
  if (hour < 18) return '下午好';
  return '晚上好';
}

function formatDate(value?: string) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

export default function DashboardPage() {
  const { message } = AntdApp.useApp();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [workOrders, setWorkOrders] = useState<WorkOrderRow[]>([]);
  const [metrics, setMetrics] = useState<DashboardMetrics>({
    dispatching: 0,
    material: 0,
    review: 0,
    pendingAudits: 0,
    pendingPurchase: 0,
  });
  const [loading, setLoading] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [ordersResult, metricsResult] = await Promise.allSettled([
        request<WorkOrderRow[] | { list: WorkOrderRow[] }>({ url: '/work-orders' }),
        request<DashboardMetrics>({ url: '/dashboard/metrics' }),
      ]);

      let nextWorkOrders: WorkOrderRow[] = [];
      if (ordersResult.status === 'fulfilled') {
        const value = ordersResult.value;
        nextWorkOrders = Array.isArray(value) ? value : value.list || [];
        setWorkOrders(nextWorkOrders);
      }
      if (metricsResult.status === 'fulfilled') {
        setMetrics(metricsResult.value);
      } else {
        const [auditsResult, purchaseResult] = await Promise.allSettled([
          request<AuditRow[]>({ url: '/audits', query: { status: AuditStatus.PENDING } }),
          request<PurchaseRequestRow[]>({ url: '/purchase-requests' }),
        ]);
        setMetrics({
          pendingAudits: auditsResult.status === 'fulfilled' ? auditsResult.value.length : 0,
          dispatching: nextWorkOrders.filter((item) => item.status === WorkOrderStatus.CREATED).length,
          material: nextWorkOrders.filter((item) => item.status === WorkOrderStatus.WAITING_MATERIAL).length,
          review: nextWorkOrders.filter((item) => item.status === WorkOrderStatus.DONE_PENDING_REVIEW).length,
          pendingPurchase: purchaseResult.status === 'fulfilled'
            ? purchaseResult.value.filter((item) =>
                [PurchaseRequestStatus.MANAGER_REVIEW, PurchaseRequestStatus.PURCHASER_REVIEW]
                  .includes(item.status),
              ).length
            : 0,
        });
      }
      setUpdatedAt(new Date());
    } catch (error: any) {
      message.error(error?.message || '加载工作台失败');
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    load();
  }, [load]);

  const totalTodo = Object.values(metrics).reduce((sum, value) => sum + value, 0);
  const activeOrders = metrics.dispatching + metrics.material + metrics.review;
  const pendingApprovals = metrics.pendingAudits + metrics.pendingPurchase;

  const metricItems = [
    {
      key: 'dispatching',
      title: '待派工单',
      value: metrics.dispatching,
      hint: '需要尽快安排维修人员',
      icon: <ToolOutlined />,
      tone: 'slate',
      route: '/work-orders',
    },
    {
      key: 'material',
      title: '缺料工单',
      value: metrics.material,
      hint: '等待采购或库存调拨',
      icon: <ShoppingOutlined />,
      tone: 'amber',
      route: '/inventory',
    },
    {
      key: 'review',
      title: '待业主验收',
      value: metrics.review,
      hint: '维修已完成，等待确认',
      icon: <FileDoneOutlined />,
      tone: 'violet',
      route: '/work-orders',
    },
    {
      key: 'purchase',
      title: '采购待审批',
      value: metrics.pendingPurchase,
      hint: '需要完成审批或下单',
      icon: <AuditOutlined />,
      tone: 'blue',
      route: '/inventory',
    },
    {
      key: 'owner',
      title: '业主待审核',
      value: metrics.pendingAudits,
      hint: '等待核验房屋身份',
      icon: <IdcardOutlined />,
      tone: 'rose',
      route: '/owners',
    },
  ];

  const todoItems = useMemo(
    () => metricItems
      .filter((item) => item.value > 0)
      .sort((a, b) => b.value - a.value),
    [metrics],
  );

  const quickActions = [
    { label: '登记报修', note: '电话或来访报修', icon: <ToolOutlined />, route: '/work-orders' },
    { label: '审核业主', note: '核验房屋绑定', icon: <CheckCircleOutlined />, route: '/owners' },
    { label: '房产档案', note: '查找房屋与业主', icon: <HomeOutlined />, route: '/properties' },
    { label: '库存采购', note: '处理缺料与收货', icon: <ShoppingOutlined />, route: '/inventory' },
    { label: '楼栋报修码', note: '生成和打印二维码', icon: <QrcodeOutlined />, route: '/qr' },
    { label: '员工管理', note: '账号、工种与角色', icon: <TeamOutlined />, route: '/staff' },
  ];

  return (
    <div className="pms-dashboard">
      <section className="pms-dashboard-hero">
        <div className="pms-dashboard-hero-main">
          <div className="pms-eyebrow">运营工作台</div>
          <h1>{getGreeting()}，{user?.name || user?.loginAccount || '管理员'}</h1>
          <p>从最需要处理的事项开始，及时推进报修、采购和业主审核。</p>
        </div>
        <div className="pms-dashboard-hero-actions">
          <span className="pms-sync-state">
            <span className="pms-sync-dot" />
            {updatedAt ? `${formatDate(updatedAt.toISOString())} 已同步` : '正在同步数据'}
          </span>
          <Button icon={<ReloadOutlined />} loading={loading} onClick={load}>
            刷新数据
          </Button>
        </div>
        <div className="pms-dashboard-summary" aria-label="今日运营摘要">
          <div>
            <strong>{totalTodo}</strong>
            <span>全部待办</span>
          </div>
          <div>
            <strong>{activeOrders}</strong>
            <span>进行中工单</span>
          </div>
          <div>
            <strong>{pendingApprovals}</strong>
            <span>待审核事项</span>
          </div>
        </div>
      </section>

      <Row gutter={[16, 16]} className="pms-metric-grid">
        {metricItems.map((item) => (
          <Col xs={24} sm={12} xl={Math.floor(24 / metricItems.length)} key={item.key}>
            <MetricCard {...item} onClick={() => navigate(item.route)} />
          </Col>
        ))}
      </Row>

      <Row gutter={[20, 20]} className="pms-dashboard-main-grid">
        <Col xs={24} xl={15}>
          <Card
            className="pms-dashboard-card"
            title={<SectionTitle title="待办队列" subtitle="按数量和处理紧迫度集中展示" />}
          >
            {todoItems.length ? (
              <div className="pms-todo-list">
                {todoItems.map((item, index) => (
                  <button
                    type="button"
                    className="pms-todo-row"
                    key={item.key}
                    onClick={() => navigate(item.route)}
                  >
                    <span className={`pms-todo-rank pms-tone-${item.tone}`}>{index + 1}</span>
                    <span className={`pms-todo-icon pms-tone-${item.tone}`}>{item.icon}</span>
                    <span className="pms-todo-copy">
                      <strong>{item.title}</strong>
                      <small>{item.hint}</small>
                    </span>
                    <span className="pms-todo-count">{item.value}</span>
                    <RightOutlined className="pms-todo-arrow" />
                  </button>
                ))}
              </div>
            ) : (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="当前没有待处理事项"
              />
            )}
          </Card>
        </Col>
        <Col xs={24} xl={9}>
          <Card
            className="pms-dashboard-card"
            title={<SectionTitle title="快捷入口" subtitle="常用操作一步直达" />}
          >
            <div className="pms-quick-grid">
              {quickActions.map((item) => (
                <button
                  type="button"
                  className="pms-quick-action"
                  key={item.label}
                  onClick={() => navigate(item.route)}
                >
                  <span className="pms-quick-icon">{item.icon}</span>
                  <span>
                    <strong>{item.label}</strong>
                    <small>{item.note}</small>
                  </span>
                </button>
              ))}
            </div>
          </Card>
        </Col>
      </Row>

      <Card
        className="pms-dashboard-card pms-recent-card"
        title={<SectionTitle title="近期工单" subtitle="最近提交和仍在流转中的维修任务" />}
        extra={
          <Button type="link" onClick={() => navigate('/work-orders')}>
            查看全部 <RightOutlined />
          </Button>
        }
      >
        <Table
          rowKey="id"
          loading={loading}
          dataSource={workOrders.slice(0, 8)}
          pagination={false}
          scroll={{ x: 720 }}
          locale={{ emptyText: '暂无工单数据' }}
          columns={[
            {
              title: '工单编号',
              dataIndex: 'orderNo',
              render: (value: string) => <span className="pms-order-no">{value}</span>,
            },
            {
              title: '状态',
              dataIndex: 'status',
              width: 120,
              render: (value: WorkOrderStatus) => (
                <Tag color={statusColor[value]}>{statusLabel[value]}</Tag>
              ),
            },
            {
              title: '工种',
              dataIndex: 'repairTypeLabel',
              width: 130,
              // 接口给的中文名优先；老数据没有 label 时退回编码，也比空着强
              render: (value: string | null | undefined, row: WorkOrderRow) =>
                value || row.skill || <Text type="secondary">待判断</Text>,
            },
            {
              title: '维修人员',
              dataIndex: 'assigneeName',
              width: 130,
              render: (value: string | null | undefined, row: WorkOrderRow) =>
                value || (row.assigneeId ? nameOr(null, '维修工') : <Text type="secondary">尚未派单</Text>),
            },
            {
              title: '提交时间',
              dataIndex: 'createdAt',
              width: 150,
              render: (value?: string) => (
                <Space size={6}>
                  <ClockCircleOutlined className="pms-table-time-icon" />
                  {formatDate(value)}
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <div className="pms-dashboard-footnote">
        <ApartmentOutlined />
        当前数据按你的角色和管理处范围过滤，跨小区数据不会在此工作台展示。
      </div>
    </div>
  );
}

function MetricCard({
  title,
  value,
  hint,
  icon,
  tone,
  onClick,
}: {
  title: string;
  value: number;
  hint: string;
  icon: React.ReactNode;
  tone: string;
  onClick: () => void;
}) {
  return (
    <button type="button" className="pms-metric-card" onClick={onClick}>
      <span className={`pms-metric-icon pms-tone-${tone}`}>{icon}</span>
      <span className="pms-metric-copy">
        <small>{title}</small>
        <strong>{value}</strong>
        <span>{hint}</span>
      </span>
      <RightOutlined className="pms-metric-arrow" />
    </button>
  );
}

function SectionTitle({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="pms-section-title">
      <strong>{title}</strong>
      <span>{subtitle}</span>
    </div>
  );
}
