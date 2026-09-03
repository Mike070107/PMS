import { Badge, Button, Drawer, Empty, List, Tag, Typography } from 'antd';
import { BellOutlined, CheckOutlined } from '@ant-design/icons';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  classifyNotification,
  type NotificationCategory,
} from '@pms/shared-types';
import { request } from '../lib/api';

const { Text } = Typography;

interface NotificationRow {
  id: number;
  eventKey: string;
  title: string;
  payload: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
}

// 点击后的网页落点与分类是两件事：分类由 shared-types 三端统一，这里只管路由。
const EVENT_ROUTES: Record<string, string> = {
  order_urged: '/work-orders',
  order_urged_escalated: '/work-orders',
  order_pool_unassigned: '/work-orders',
  order_pool_new: '/work-orders',
  order_transfer_requested: '/work-orders',
  order_assigned: '/work-orders',
  order_urge_repair: '/work-orders',
  order_accept_overdue: '/work-orders',
  order_accept_overdue_office: '/work-orders',
  transfer_pending_review: '/inventory',
  transfer_approved: '/inventory',
  transfer_rejected: '/inventory',
  transfer_received: '/inventory',
  transfer_received_variance: '/inventory',
  receipt_qty_variance: '/inventory',
  purchase_pending_office: '/inventory',
  purchase_pending_manager: '/inventory',
  purchase_pending_purchaser: '/inventory',
  system_alert: '/logs',
  user_feedback: '/logs?mode=feedback',
};

type FilterKey = 'all' | 'important' | NotificationCategory;

const CATEGORY_FILTERS: Array<{ key: NotificationCategory; label: string }> = [
  { key: 'work_order', label: '工单' },
  { key: 'approval', label: '审批' },
  { key: 'inventory', label: '库存' },
  { key: 'system', label: '系统' },
  { key: 'other', label: '其他' },
];

const CATEGORY_COLORS = {
  blue: 'blue',
  purple: 'purple',
  cyan: 'cyan',
  red: 'red',
  gray: 'default',
} as const;

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  return `${day} 天前`;
}

export default function NotificationBell() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [rows, setRows] = useState<NotificationRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeFilter, setActiveFilter] = useState<FilterKey>('all');

  const decoratedRows = useMemo(
    () => rows.map((row) => ({ ...row, presentation: classifyNotification(row.eventKey) })),
    [rows],
  );
  const filters = useMemo(() => {
    const result: Array<{ key: FilterKey; label: string; count: number }> = [
      { key: 'all', label: '全部', count: decoratedRows.length },
      { key: 'important', label: '重要', count: decoratedRows.filter((row) => row.presentation.important).length },
    ];
    CATEGORY_FILTERS.forEach((item) => {
      const count = decoratedRows.filter((row) => row.presentation.category === item.key).length;
      if (count) result.push({ ...item, count });
    });
    return result;
  }, [decoratedRows]);
  const visibleRows = useMemo(() => decoratedRows.filter((row) => {
    if (activeFilter === 'all') return true;
    if (activeFilter === 'important') return row.presentation.important;
    return row.presentation.category === activeFilter;
  }), [activeFilter, decoratedRows]);

  const loadUnread = useCallback(async () => {
    try {
      const r = await request<{ count: number }>({ url: '/notifications/unread-count' });
      setUnread(r.count);
    } catch {
      // 静默：通知不影响主流程
    }
  }, []);

  const loadList = useCallback(async () => {
    setLoading(true);
    try {
      const r = await request<NotificationRow[]>({ url: '/notifications' });
      setRows(r);
    } catch {
      // 静默
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadUnread();
    const timer = setInterval(loadUnread, 60000);
    return () => clearInterval(timer);
  }, [loadUnread]);

  const openDrawer = () => {
    setOpen(true);
    loadList();
  };

  const onItemClick = async (row: NotificationRow) => {
    if (!row.readAt) {
      try {
        await request({ method: 'POST', url: `/notifications/${row.id}/read` });
        setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, readAt: new Date().toISOString() } : r)));
        setUnread((c) => Math.max(0, c - 1));
      } catch {
        // 静默
      }
    }
    const to = EVENT_ROUTES[row.eventKey];
    if (to) {
      setOpen(false);
      navigate(to);
    }
  };

  const markAllRead = async () => {
    try {
      await request({ method: 'POST', url: '/notifications/read-all' });
      setRows((prev) => prev.map((r) => ({ ...r, readAt: r.readAt || new Date().toISOString() })));
      setUnread(0);
    } catch {
      // 静默
    }
  };

  return (
    <>
      <Badge count={unread} size="small" offset={[-2, 2]}>
        <Button
          type="text"
          shape="circle"
          icon={<BellOutlined style={{ fontSize: 18 }} />}
          onClick={openDrawer}
          aria-label="通知"
        />
      </Badge>
      <Drawer
        title="通知中心"
        placement="right"
        width="min(420px, 100vw)"
        open={open}
        onClose={() => setOpen(false)}
        extra={
          <Button size="small" icon={<CheckOutlined />} onClick={markAllRead} disabled={!unread}>
            全部已读
          </Button>
        }
      >
        {!!rows.length && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 18 }}>
            {filters.map((filter) => (
              <Tag.CheckableTag
                key={filter.key}
                checked={activeFilter === filter.key}
                onChange={() => setActiveFilter(filter.key)}
                style={{ margin: 0, padding: '4px 10px', fontSize: 14, border: '1px solid #d9e2ec' }}
              >
                {filter.label} {filter.count}
              </Tag.CheckableTag>
            ))}
          </div>
        )}
        {!rows.length && !loading ? (
          <Empty description="暂无通知" style={{ marginTop: 60 }} />
        ) : !visibleRows.length && !loading ? (
          <Empty description="这个分类暂时没有通知" style={{ marginTop: 60 }} />
        ) : (
          <List
            loading={loading}
            dataSource={visibleRows}
            renderItem={(row) => {
              const meta = row.presentation;
              return (
                <List.Item
                  onClick={() => onItemClick(row)}
                  style={{
                    cursor: 'pointer',
                    background: row.readAt ? undefined : 'rgba(49,85,138,0.06)',
                    borderRadius: 8,
                    padding: '12px 12px',
                    marginBottom: 4,
                  }}
                >
                  <List.Item.Meta
                    title={
                      <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
                        {!row.readAt && <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#31558a', flex: 'none' }} />}
                        <Tag color={CATEGORY_COLORS[meta.categoryTone]} style={{ margin: 0 }}>{meta.categoryLabel}</Tag>
                        <Tag
                          color={meta.priority === 'action' ? 'red' : meta.priority === 'important' ? 'orange' : undefined}
                          style={{ margin: 0 }}
                        >
                          {meta.priorityLabel}
                        </Tag>
                      </div>
                    }
                    description={
                      <div>
                        <div style={{ color: 'rgba(0,0,0,0.82)', marginBottom: 2 }}>{row.title}</div>
                        <Text type="secondary" style={{ fontSize: 12 }}>{timeAgo(row.createdAt)}</Text>
                      </div>
                    }
                  />
                </List.Item>
              );
            }}
          />
        )}
      </Drawer>
    </>
  );
}
