import { Badge, Button, Drawer, Empty, List, Tag, Typography } from 'antd';
import { BellOutlined, CheckOutlined } from '@ant-design/icons';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
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

// 事件 → 跳转目标 + 标签色
const EVENT_META: Record<string, { label: string; color: string; to?: string }> = {
  order_urged: { label: '工单催办', color: 'orange', to: '/work-orders' },
  order_urged_escalated: { label: '催办升级', color: 'red', to: '/work-orders' },
  transfer_pending_review: { label: '调拨待审批', color: 'gold', to: '/inventory' },
  transfer_approved: { label: '调拨待接收', color: 'blue', to: '/inventory' },
  transfer_rejected: { label: '调拨被驳回', color: 'red', to: '/inventory' },
  transfer_received: { label: '调拨已接收', color: 'green', to: '/inventory' },
  transfer_received_variance: { label: '调拨实收差异', color: 'volcano', to: '/inventory' },
  receipt_qty_variance: { label: '入库数量差异', color: 'volcano', to: '/inventory' },
  purchase_pending_office: { label: '采购待汇总', color: 'gold', to: '/inventory' },
  purchase_pending_manager: { label: '采购待经理审批', color: 'gold', to: '/inventory' },
  purchase_pending_purchaser: { label: '采购待采购审批', color: 'blue', to: '/inventory' },
  user_feedback: { label: '异常反馈', color: 'purple', to: '/logs?mode=feedback' },
};

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
    const to = EVENT_META[row.eventKey]?.to;
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
        width={400}
        open={open}
        onClose={() => setOpen(false)}
        extra={
          <Button size="small" icon={<CheckOutlined />} onClick={markAllRead} disabled={!unread}>
            全部已读
          </Button>
        }
      >
        {!rows.length && !loading ? (
          <Empty description="暂无通知" style={{ marginTop: 60 }} />
        ) : (
          <List
            loading={loading}
            dataSource={rows}
            renderItem={(row) => {
              const meta = EVENT_META[row.eventKey];
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
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        {!row.readAt && <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#31558a', flex: 'none' }} />}
                        {meta && <Tag color={meta.color} style={{ margin: 0 }}>{meta.label}</Tag>}
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
