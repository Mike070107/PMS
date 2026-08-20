import { Button, Card, Space, Table, Tag, Typography, App as AntdApp, Modal, Input } from 'antd';
import { useEffect, useState } from 'react';
import { request } from '../lib/api';
import { usePagePerm } from '../lib/auth';
import { AuditStatus } from '@pms/shared-types';

const { Title, Text } = Typography;

interface AuditRow {
  id: number;
  name?: string;
  phone?: string;
  address?: string;
  communityName?: string;
  buildingText?: string;
  roomNo?: string;
  status: AuditStatus;
  rejectReason?: string | null;
  createdAt?: string;
}

const tagColor: Record<AuditStatus, string> = {
  pending: 'gold',
  approved: 'green',
  rejected: 'red',
};

const statusText: Record<AuditStatus, string> = {
  pending: '待审核',
  approved: '已通过',
  rejected: '已驳回',
};

function formatTime(value?: string) {
  if (!value) return '-';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '-';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function OwnerAuditPage() {
  const { message } = AntdApp.useApp();
  const { canEdit } = usePagePerm('owners');
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const r = await request<AuditRow[]>({ url: '/audits' });
      setRows(r);
    } catch (e: any) {
      message.error(e?.message || '加载失败');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  const submitApprove = async (id: number, roomNo?: string) => {
    try {
      await request({
        method: 'POST',
        url: `/audits/${id}/approve`,
        data: roomNo ? { roomNo } : {},
      });
      message.success('已通过');
      load();
    } catch (e: any) {
      // 失败原因（缺楼栋、缺房号、房号对不上）必须原样告诉审核的人，否则只能干瞪眼
      message.error(e?.message || '通过失败');
    }
  };

  const approve = (row: AuditRow) => {
    // 业主没填房号时当场补一个，别让审核卡死在这里
    if (row.roomNo) return submitApprove(row.id);
    let roomNo = '';
    Modal.confirm({
      title: '补填房号',
      content: (
        <div>
          <Text type="secondary">{row.address || '该申请没有房号'}</Text>
          <Input
            style={{ marginTop: 12 }}
            placeholder="如 101"
            onChange={(e) => { roomNo = e.target.value; }}
          />
        </div>
      ),
      okText: '通过',
      onOk: async () => {
        if (!roomNo.trim()) {
          message.error('请填写房号');
          return Promise.reject(new Error('roomNo required'));
        }
        await submitApprove(row.id, roomNo.trim());
      },
    });
  };

  const reject = (id: number) => {
    let reason = '';
    Modal.confirm({
      title: '驳回审核',
      content: <Input placeholder="驳回原因（会展示给业主）" onChange={(e) => { reason = e.target.value; }} />,
      onOk: async () => {
        if (!reason.trim()) {
          message.error('请填写驳回原因');
          return Promise.reject(new Error('reason required'));
        }
        try {
          await request({ method: 'POST', url: `/audits/${id}/reject`, data: { reason: reason.trim() } });
          message.success('已驳回');
          load();
        } catch (e: any) {
          message.error(e?.message || '驳回失败');
          throw e;
        }
      },
    });
  };

  return (
    <div>
      <Title level={4} style={{ marginTop: 0 }}>业主入驻审核</Title>
      <Card extra={<a onClick={load}>刷新</a>}>
        <Table
          rowKey="id"
          size="middle"
          loading={loading}
          dataSource={rows}
          pagination={{ pageSize: 20 }}
          columns={[
            { title: 'ID', dataIndex: 'id', width: 80 },
            {
              title: '姓名',
              dataIndex: 'name',
              width: 120,
              render: (v?: string) => v || <Text type="secondary">未填写</Text>,
            },
            {
              title: '电话',
              dataIndex: 'phone',
              width: 140,
              render: (v?: string) => v || <Text type="secondary">未填写</Text>,
            },
            {
              title: '申请地址',
              dataIndex: 'address',
              render: (v?: string) => v || <Text type="secondary">未填写</Text>,
            },
            { title: '提交时间', dataIndex: 'createdAt', width: 160, render: formatTime },
            {
              title: '状态',
              dataIndex: 'status',
              width: 140,
              render: (s: AuditStatus, r: AuditRow) => (
                <Space direction="vertical" size={2}>
                  <Tag color={tagColor[s]}>{statusText[s] || s}</Tag>
                  {s === AuditStatus.REJECTED && r.rejectReason ? (
                    <Text type="secondary" style={{ fontSize: 12 }}>{r.rejectReason}</Text>
                  ) : null}
                </Space>
              ),
            },
            {
              title: '操作', key: 'op', width: 180,
              render: (_: any, r: AuditRow) => r.status === AuditStatus.PENDING && canEdit ? (
                <Space>
                  <Button size="small" type="primary" onClick={() => approve(r)}>通过</Button>
                  <Button size="small" danger onClick={() => reject(r.id)}>驳回</Button>
                </Space>
              ) : <span style={{ color: '#999' }}>-</span>,
            },
          ]}
        />
      </Card>
    </div>
  );
}
