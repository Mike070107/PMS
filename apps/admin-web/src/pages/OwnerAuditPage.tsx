import {
  App as AntdApp,
  Badge,
  Button,
  Card,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import {
  AuditOutlined,
  EditOutlined,
  PlusOutlined,
  ReloadOutlined,
  SearchOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import { useCallback, useEffect, useState } from 'react';
import { request } from '../lib/api';
import { usePagePerm } from '../lib/auth';
import { searchableWideSelectProps, withOptionTitles } from '../lib/selectProps';
import { AuditStatus, OWNER_SOURCE_LABELS, OwnerSource } from '@pms/shared-types';
import OwnerFormModal, { OwnerRow, formatOwnerLocation } from './OwnerFormModal';

const { Title, Text } = Typography;

// 这一页管的是「业主端小程序」的用户：入驻审核 + 业主档案 + 启停。
// 保安/居委会/业委会/物业工作人员走员工端小程序，一律在「用户管理」维护，
// 不要再往这页加 —— 一个页面只对应一个端，是这次拆分的全部意义。

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

interface Community {
  id: number;
  name: string;
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
  // 标准 ISO 直接交给 Date，别先做 replace(/-/g,'/')：那会把 2026-08-09T10:30:00Z
  // 变成 2026/08/09T10:30:00，V8 和 iOS 都判 Invalid Date，时间列整列变空
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '-';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function OwnerAuditPage() {
  const [tab, setTab] = useState('owners');
  const [pendingCount, setPendingCount] = useState(0);

  return (
    <div>
      <Tabs
        activeKey={tab}
        onChange={setTab}
        items={[
          {
            key: 'owners',
            label: <span><TeamOutlined /> 业主档案</span>,
            children: <OwnersTab />,
          },
          {
            key: 'audits',
            label: (
              <span>
                <AuditOutlined /> 入驻审核
                {pendingCount > 0 && (
                  <Badge count={pendingCount} style={{ marginLeft: 8 }} />
                )}
              </span>
            ),
            children: <AuditTab onPendingChange={setPendingCount} />,
          },
        ]}
      />
    </div>
  );
}

// ====================================================================
// 业主档案（2026-08-24 从「房产与业主」页搬来）
// ====================================================================
function OwnersTab() {
  const { message, modal } = AntdApp.useApp();
  const { canEdit, canDelete } = usePagePerm('owners');
  const [rows, setRows] = useState<OwnerRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState('');
  const [communityId, setCommunityId] = useState<number | undefined>();
  const [statusFilter, setStatusFilter] = useState<'active' | 'disabled' | undefined>('active');
  const [communities, setCommunities] = useState<Community[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<OwnerRow | null>(null);

  const loadCommunities = useCallback(async () => {
    try {
      setCommunities(await request<Community[]>({ url: '/communities' }));
    } catch (e: any) { message.error(e?.message || '加载小区失败'); }
  }, [message]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await request<OwnerRow[]>({
        url: '/owners-mgmt',
        query: {
          q: q || undefined,
          communityId,
          status: statusFilter,
        },
      });
      setRows(list);
    } catch (e: any) {
      message.error(e?.message || '加载失败');
    } finally { setLoading(false); }
  }, [q, communityId, statusFilter, message]);

  useEffect(() => { loadCommunities(); }, [loadCommunities]);
  useEffect(() => { load(); }, [load]);

  const onDisable = (r: OwnerRow) => {
    modal.confirm({
      title: `确认停用业主「${r.name || r.phone}」?`,
      content: '停用后本人无法登录业主端小程序、不能再报修，历史工单保留。',
      okType: 'danger',
      onOk: async () => {
        try {
          await request({ method: 'DELETE', url: `/owners-mgmt/${r.id}` });
          message.success('已停用');
          load();
        } catch (e: any) { message.error(e?.message || '操作失败'); }
      },
    });
  };

  const onActivate = async (r: OwnerRow) => {
    try {
      await request({
        method: 'PATCH',
        url: `/owners-mgmt/${r.id}`,
        data: { status: 'active' },
      });
      message.success('已启用');
      load();
    } catch (e: any) { message.error(e?.message || '操作失败'); }
  };

  return (
    <Card
      title={<span>业主档案 <Text type="secondary" style={{ fontSize: 12 }}>共 {rows.length} 人</Text></span>}
      extra={
        <Space>
          <Select
            allowClear
            placeholder="按小区筛选"
            style={{ width: 160 }}
            value={communityId}
            onChange={(v) => setCommunityId(v)}
            options={withOptionTitles(communities.map((c) => ({ value: c.id, label: c.name })))}
            {...searchableWideSelectProps}
          />
          <Select
            value={statusFilter}
            onChange={(v) => setStatusFilter(v)}
            style={{ width: 110 }}
            options={[
              { value: 'active', label: '已启用' },
              { value: 'disabled', label: '已停用' },
              { value: undefined as any, label: '全部' },
            ]}
          />
          <Input
            placeholder="搜索 姓名/电话/房号"
            prefix={<SearchOutlined />}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onPressEnter={load}
            allowClear
            style={{ width: 220 }}
          />
          <Button icon={<ReloadOutlined />} onClick={load}>刷新</Button>
          {canEdit && (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>新增业主</Button>
          )}
        </Space>
      }
    >
      <Table
        rowKey="id"
        size="middle"
        loading={loading}
        dataSource={rows}
        pagination={{ pageSize: 20, showSizeChanger: true }}
        columns={[
          { title: '姓名', dataIndex: 'name', width: 120, render: (v) => v || <Text type="secondary">-</Text> },
          {
            // 老系统导入的档案很多只有固话，手机号那格是空的。直接显示「-」会被当成没资料，
            // 实际上备注里有号码可以打 —— 这里退回显示备注并标出来。
            title: '电话', dataIndex: 'phone', width: 150,
            render: (v: string | null, r) =>
              v || (r.contactNote
                ? <Text type="secondary" title={r.contactNote}>{r.contactNote}<Text type="secondary" style={{ fontSize: 11 }}>（非手机）</Text></Text>
                : <Text type="secondary">无号码</Text>),
          },
          {
            title: '绑定房产', key: 'house',
            render: (_, r) => r.house
              ? formatOwnerLocation({
                  communityName: r.house.communityName || '-',
                  lane: r.house.lane,
                  buildingNo: r.house.buildingNo,
                  roomNo: r.house.roomNo,
                })
              : <Text type="secondary">未绑定</Text>,
          },
          {
            // 报修登记来的档案是系统顺手记的、没人核实过，必须和业主自己认证的分开，
            // 否则谁也不知道这条资料能不能直接用来联系
            title: '来源', dataIndex: 'source', width: 110,
            render: (v?: string | null) =>
              v === OwnerSource.REPAIR_INTAKE
                ? <Tag color="orange">报修登记</Tag>
                : <Text type="secondary">{OWNER_SOURCE_LABELS[v || ''] || '后台建档'}</Text>,
          },
          {
            title: '小程序', dataIndex: 'status', width: 110,
            render: (s) => s === 'active'
              ? <Tag color="green">可登录报修</Tag>
              : <Tag>已停用</Tag>,
          },
          {
            title: '操作', key: 'op', width: 150, fixed: 'right',
            render: (_, r) => (
              <Space size="small">
                {canEdit && (
                  <Button type="link" size="small" icon={<EditOutlined />} onClick={() => setEditing(r)}>编辑</Button>
                )}
                {r.status === 'active'
                  ? canDelete && <Button type="link" size="small" danger onClick={() => onDisable(r)}>停用</Button>
                  : canEdit && <Button type="link" size="small" onClick={() => onActivate(r)}>启用</Button>}
              </Space>
            ),
          },
        ]}
      />

      <OwnerFormModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onDone={() => { setCreateOpen(false); load(); }}
      />
      <OwnerFormModal
        open={!!editing}
        target={editing || undefined}
        onClose={() => setEditing(null)}
        onDone={() => { setEditing(null); load(); }}
      />
    </Card>
  );
}

// ====================================================================
// 入驻审核
// ====================================================================
function AuditTab({ onPendingChange }: { onPendingChange: (n: number) => void }) {
  const { message } = AntdApp.useApp();
  const { canEdit } = usePagePerm('owners');
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await request<AuditRow[]>({ url: '/audits' });
      setRows(r);
      // 角标和列表同一份数据，不另开一个 count 接口，免得两处口径对不上
      onPendingChange(r.filter((item) => item.status === AuditStatus.PENDING).length);
    } catch (e: any) {
      message.error(e?.message || '加载失败');
    } finally {
      setLoading(false);
    }
  }, [message, onPendingChange]);
  useEffect(() => { load(); }, [load]);

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

  // 点错了「通过/驳回」能收回：退回待审核；通过的会把本次绑上的房屋解开
  const revert = async (id: number) => {
    try {
      await request({ method: 'POST', url: `/audits/${id}/revert` });
      message.success('已撤销，申请退回待审核');
      load();
    } catch (e: any) {
      message.error(e?.message || '撤销失败');
    }
  };

  return (
    <Card extra={<Button icon={<ReloadOutlined />} onClick={load}>刷新</Button>}>
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
            render: (_: any, r: AuditRow) => {
              if (!canEdit) return <span style={{ color: '#999' }}>-</span>;
              if (r.status === AuditStatus.PENDING) {
                return (
                  <Space>
                    <Button size="small" type="primary" onClick={() => approve(r)}>通过</Button>
                    <Button size="small" danger onClick={() => reject(r.id)}>驳回</Button>
                  </Space>
                );
              }
              return (
                <Popconfirm
                  title="撤销这条审核？"
                  description={r.status === AuditStatus.APPROVED
                    ? '申请退回待审核，并解除本次通过时绑定的房屋；业主小程序里会变回「审核中」。'
                    : '申请退回待审核，驳回原因清除；业主小程序里会变回「审核中」。'}
                  okText="撤销"
                  okButtonProps={{ danger: true }}
                  onConfirm={() => revert(r.id)}
                >
                  <Button size="small">撤销审核</Button>
                </Popconfirm>
              );
            },
          },
        ]}
      />
    </Card>
  );
}
