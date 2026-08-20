import {
  App as AntdApp,
  Button,
  Card,
  Col,
  Form,
  Input,
  Modal,
  Row,
  Select,
  Popconfirm,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { PlusOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import { useCallback, useEffect, useState } from 'react';
import { request } from '../lib/api';
import { usePagePerm } from '../lib/auth';
import { searchableWideSelectProps, withOptionTitles } from '../lib/selectProps';
import { UserRole } from '@pms/shared-types';

const { Title } = Typography;

interface BoundRole {
  id: number;
  name: string;
  builtIn: boolean;
}

interface Staff {
  id: number;
  name?: string | null;
  phone?: string | null;
  role: UserRole;
  loginAccount?: string | null;
  status: 'active' | 'disabled';
  wxBound?: boolean;
  skills?: string[];
  zones?: string[];
  /** 保安/居委会/业委会：不进后台，用业主端小程序代报 */
  isReporter?: boolean;
  reportCommunityIds?: number[];
  /** 绑定的后台角色（决定网站权限） */
  roles?: BoundRole[];
  roleIds?: number[];
}

interface AssignableRole {
  id: number;
  name: string;
  builtIn: boolean;
  dataScope: string;
}

interface CommunityOption {
  id: number;
  name: string;
  isGroup?: boolean;
}

const roleLabel: Record<string, string> = {
  technician: '维修工',
  office: '物业办公室',
  manager: '物业经理',
  purchaser: '采购经理',
  admin: '物业管理员',
  guard: '保安',
  neighborhood: '居委会',
  owner_committee: '业委会',
};

const roleColor: Record<string, string> = {
  technician: 'blue',
  office: 'cyan',
  manager: 'gold',
  purchaser: 'magenta',
  admin: 'red',
  guard: 'geekblue',
  neighborhood: 'green',
  owner_committee: 'purple',
};

/** 代报角色：登记后由本人在小程序用微信手机号认领，不发后台账号 */
const REPORTER_ROLE_SET = new Set<string>([
  UserRole.GUARD,
  UserRole.NEIGHBORHOOD,
  UserRole.OWNER_COMMITTEE,
]);

const skillOptions = [
  { value: 'water', label: '水相关' },
  { value: 'electric', label: '电相关' },
  { value: 'door_window', label: '家里门锁/门窗相关' },
  { value: 'appliance', label: '家电/设备相关' },
  { value: 'elevator', label: '电梯相关' },
  { value: 'smart', label: '智能化相关' },
  { value: 'public', label: '公共设施相关' },
  { value: 'other', label: '其它' },
];

export default function StaffPage() {
  const { message } = AntdApp.useApp();
  const { canEdit } = usePagePerm('users');
  const [rows, setRows] = useState<Staff[]>([]);
  const [loading, setLoading] = useState(false);
  const [role, setRole] = useState<UserRole | undefined>();
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<Staff | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await request<Staff[]>({
        url: '/staff',
        query: { role, q: q || undefined },
      });
      setRows(list);
    } catch (e: any) {
      message.error(e?.message || '加载失败');
    } finally {
      setLoading(false);
    }
  }, [role, q, message]);

  useEffect(() => { load(); }, [load]);

  const toggleStatus = async (s: Staff) => {
    try {
      await request({
        method: 'PATCH',
        url: `/staff/${s.id}`,
        data: { status: s.status === 'active' ? 'disabled' : 'active' },
      });
      message.success('已更新');
      load();
    } catch (e: any) { message.error(e?.message || '操作失败'); }
  };

  const unbindWx = async (s: Staff) => {
    try {
      await request({ method: 'POST', url: `/staff/${s.id}/unbind-wx` });
      message.success(`已解绑 ${s.name || `#${s.id}`} 的员工端微信`);
      load();
    } catch (e: any) { message.error(e?.message || '解绑失败'); }
  };

  return (
    <div>
      <Title level={4} style={{ marginTop: 0 }}>用户管理</Title>
      <Card
        title="员工与后台账号：业务身份决定小程序端能力，后台角色决定网站权限"
        extra={
          <Space>
            <Select
              allowClear
              placeholder="按角色筛选"
              style={{ width: 160 }}
              value={role}
              onChange={(v) => setRole(v)}
              options={Object.entries(roleLabel).map(([value, label]) => ({ value, label }))}
            />
            <Input
              placeholder="搜索姓名/电话/账号"
              prefix={<SearchOutlined />}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onPressEnter={load}
              style={{ width: 220 }}
              allowClear
            />
            <Button icon={<ReloadOutlined />} onClick={load}>刷新</Button>
            {canEdit && (
              <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>新增用户</Button>
            )}
          </Space>
        }
      >
        <Table
          rowKey="id"
          size="middle"
          loading={loading}
          dataSource={rows}
          pagination={{ pageSize: 20 }}
          columns={[
            { title: 'ID', dataIndex: 'id', width: 70 },
            { title: '姓名', dataIndex: 'name', render: (v) => v || '-' },
            { title: '电话', dataIndex: 'phone', render: (v) => v || '-' },
            {
              title: '业务身份', dataIndex: 'role', width: 110,
              render: (r: UserRole) => <Tag color={roleColor[r]}>{roleLabel[r] || r}</Tag>,
            },
            {
              title: '后台角色', dataIndex: 'roles', width: 180,
              render: (roles: BoundRole[] | undefined, row) => {
                if (roles?.length) {
                  return roles.map((r) => (
                    <Tag key={r.id} color={r.builtIn ? 'red' : 'processing'}>{r.name}</Tag>
                  ));
                }
                // 业务身份 admin 天然是企业超管，不需要绑角色
                if (row.role === UserRole.ADMIN) {
                  return <Tag color="red">企业超管（身份即全权限）</Tag>;
                }
                return <Tag>无（不能登录网站）</Tag>;
              },
            },
            {
              title: '工种', dataIndex: 'skills', width: 200,
              render: (s: string[]) => s?.length ? s.map((x) => <Tag key={x}>{skillOptions.find((o) => o.value === x)?.label || x}</Tag>) : '-',
            },
            { title: '登录账号', dataIndex: 'loginAccount', render: (v) => v || '-' },
            {
              title: '员工端微信', dataIndex: 'wxBound', width: 110,
              render: (bound: boolean) =>
                bound
                  ? <Tag color="green">已绑定</Tag>
                  : (
                    <Tooltip title="员工在「邻修管理」小程序用本人手机号登录后自动绑定">
                      <Tag>未绑定</Tag>
                    </Tooltip>
                  ),
            },
            {
              title: '在岗', dataIndex: 'status', width: 80,
              render: (s, r) => (
                <Switch
                  checked={s === 'active'}
                  onChange={() => toggleStatus(r)}
                  size="small"
                  disabled={!canEdit}
                />
              ),
            },
            {
              title: '操作', key: 'op', width: 150,
              render: (_, r) => (
                <Space size={0}>
                  {canEdit && (
                    <Button type="link" size="small" onClick={() => setEditing(r)}>编辑</Button>
                  )}
                  {canEdit && r.wxBound && (
                    <Popconfirm
                      title="解绑员工端微信"
                      description="解绑后该员工需重新用手机号登录绑定，常用于换手机或人员变动。"
                      okText="确认解绑"
                      cancelText="取消"
                      onConfirm={() => unbindWx(r)}
                    >
                      <Button type="link" size="small" danger>解绑微信</Button>
                    </Popconfirm>
                  )}
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <StaffFormModal
        open={creating}
        onClose={() => setCreating(false)}
        onDone={() => { setCreating(false); load(); }}
      />
      <StaffFormModal
        open={!!editing}
        target={editing}
        onClose={() => setEditing(null)}
        onDone={() => { setEditing(null); load(); }}
      />
    </div>
  );
}

function StaffFormModal({
  open, target, onClose, onDone,
}: {
  open: boolean;
  target?: Staff | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const [role, setRole] = useState<UserRole>(UserRole.TECHNICIAN);
  const [communities, setCommunities] = useState<CommunityOption[]>([]);
  const [assignableRoles, setAssignableRoles] = useState<AssignableRole[]>([]);

  useEffect(() => {
    if (!open) return;
    if (target) {
      form.setFieldsValue({
        name: target.name,
        phone: target.phone,
        role: target.role,
        loginAccount: target.loginAccount,
        skills: target.skills || [],
        reportCommunityIds: target.reportCommunityIds || [],
        roleIds: target.roleIds || [],
      });
      setRole(target.role);
    } else {
      form.resetFields();
      form.setFieldsValue({ role: UserRole.TECHNICIAN });
      setRole(UserRole.TECHNICIAN);
    }
  }, [open, target, form]);

  // 代报要勾授权小区，小区列表进弹窗时拉一次就够；后台角色下拉同理
  useEffect(() => {
    if (!open) return;
    request<CommunityOption[]>({ url: '/communities' })
      .then((list) => setCommunities(list.filter((c) => !c.isGroup)))
      .catch(() => setCommunities([]));
    request<AssignableRole[]>({ url: '/roles/assignable' })
      .then(setAssignableRoles)
      .catch(() => setAssignableRoles([]));
  }, [open]);

  const isReporterRole = REPORTER_ROLE_SET.has(role);

  const onOk = async () => {
    const v = await form.validateFields();
    setSaving(true);
    try {
      if (target) {
        await request({
          method: 'PATCH',
          url: `/staff/${target.id}`,
          data: {
            name: v.name,
            phone: v.phone,
            role: v.role,
            skills: v.skills,
            loginAccount: v.loginAccount || undefined,
            password: v.password || undefined,
            reportCommunityIds: isReporterRole ? v.reportCommunityIds || [] : undefined,
            roleIds: v.roleIds ?? [],
          },
        });
        message.success('已保存');
      } else {
        await request({
          method: 'POST',
          url: '/staff',
          data: {
            name: v.name,
            phone: v.phone,
            role: v.role,
            loginAccount: v.loginAccount || undefined,
            password: v.password || undefined,
            skills: v.skills,
            reportCommunityIds: isReporterRole ? v.reportCommunityIds || [] : undefined,
            roleIds: v.roleIds?.length ? v.roleIds : undefined,
          },
        });
        message.success(
          isReporterRole
            ? '已登记，请本人在小程序「我的」里用微信手机号认领身份'
            : '员工已创建',
        );
      }
      onDone();
    } catch (e: any) {
      message.error(e?.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  // 维修工建档时不强制账号密码（走员工端微信手机号登录），
  // 但账号密码字段始终可填，作为手机号登录不可用时的兜底
  const needsLogin = role !== UserRole.TECHNICIAN && !isReporterRole;

  return (
    <Modal
      title={target ? `编辑员工 #${target.id}` : '新增员工'}
      open={open}
      onCancel={onClose}
      onOk={onOk}
      confirmLoading={saving}
      destroyOnHidden
      width={520}
    >
      <Form form={form} layout="vertical">
        <Row gutter={12}>
          <Col span={12}>
            <Form.Item name="name" label="姓名" rules={[{ required: true }]}>
              <Input />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item
              name="phone"
              label="手机号"
              rules={[
                { required: true, message: '请填写手机号' },
                { pattern: /^1[3-9]\d{9}$/, message: '请填写正确的手机号' },
              ]}
            >
              <Input />
            </Form.Item>
          </Col>
        </Row>
        <Form.Item name="role" label="角色" rules={[{ required: true }]}>
          <Select
            options={Object.entries(roleLabel).map(([value, label]) => ({ value, label }))}
            onChange={(v) => setRole(v as UserRole)}
          />
        </Form.Item>
        {isReporterRole ? (
          <Form.Item
            name="reportCommunityIds"
            label="可代报的小区"
            rules={[{ required: true, message: '至少选一个小区，否则他在小程序里看不到代报入口' }]}
            extra="只能替这些小区里的住户报修。登记后由本人在小程序「我的」用微信手机号认领，不需要账号密码。"
          >
            <Select
              mode="multiple"
              options={withOptionTitles(
                communities.map((c) => ({ value: c.id, label: c.name })),
              )}
              placeholder="可多选"
              {...searchableWideSelectProps}
            />
          </Form.Item>
        ) : (
          <Form.Item name="skills" label="工种（维修工）">
            <Select mode="multiple" options={withOptionTitles(skillOptions)} placeholder="可多选" {...searchableWideSelectProps} />
          </Form.Item>
        )}
        {!isReporterRole && (
          <Form.Item
            name="roleIds"
            label="后台角色（网站权限）"
            extra="决定登录网站后能看到哪些页面、能否编辑/删除；不绑角色则无法登录网站。角色在「角色管理」里配置。"
          >
            <Select
              mode="multiple"
              placeholder="可多选；留空 = 不开网站权限"
              options={withOptionTitles(
                assignableRoles.map((r) => ({
                  value: r.id,
                  label: r.builtIn ? `${r.name}（内置）` : r.name,
                })),
              )}
              {...searchableWideSelectProps}
            />
          </Form.Item>
        )}
        <Row gutter={12} style={{ display: isReporterRole ? 'none' : undefined }}>
          <Col span={12}>
            <Form.Item
              name="loginAccount"
              label={needsLogin ? '登录账号' : '登录账号（选填）'}
              rules={[{ required: needsLogin && !target, message: '该角色必须登录后台' }]}
              extra={needsLogin ? undefined : '维修工填了账号密码后，员工端可用账号密码登录'}
            >
              <Input placeholder="用于后台 / 员工端登录" />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item
              name="password"
              label={target ? '重置密码（留空不改）' : '初始密码'}
              rules={
                needsLogin && !target
                  ? [{ required: true, min: 6, message: '至少 6 位' }]
                  : [{ min: 6, message: '至少 6 位' }]
              }
            >
              <Input.Password autoComplete="new-password" />
            </Form.Item>
          </Col>
        </Row>
      </Form>
    </Modal>
  );
}
