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
import { useCallback, useEffect, useMemo, useState } from 'react';
import { request } from '../lib/api';
import {
  identityHint,
  roleColor,
  roleLabel,
  roleOptionLabel,
  REPORTER_ROLE_SET,
} from '../lib/roleLabels';
import { usePagePerm } from '../lib/auth';
import { searchableWideSelectProps, withOptionTitles } from '../lib/selectProps';
import { ASSIGNABLE_STAFF_ROLES, UserRole } from '@pms/shared-types';
import { Link } from 'react-router-dom';

const { Title, Paragraph, Text } = Typography;

interface BoundRole {
  id: number;
  name: string;
  builtIn: boolean;
  businessRole?: string | null;
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
  /** 保安/居委会/业委会/物业工作人员：不进后台，用员工端小程序报修 */
  isReporter?: boolean;
  reportCommunityIds?: number[];
  /** 绑定的业务角色（同时决定小程序入口和网站权限） */
  roles?: BoundRole[];
  roleIds?: number[];
}

interface AssignableRole {
  id: number;
  name: string;
  builtIn: boolean;
  dataScope: string;
  /** 角色自带的业务身份；null = 纯后台角色，选它不改变这个人干哪一行 */
  businessRole?: string | null;
  /** 已停用或超出当前操作者范围：只为回显，不该被主动选中 */
  unavailable?: boolean;
}

interface CommunityOption {
  id: number;
  name: string;
  isGroup?: boolean;
}


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
  const [assignableRoles, setAssignableRoles] = useState<AssignableRole[]>([]);
  // 默认只看在职的。停用的档案（离职、并档后作废的那条）留在列表里，
  // 一眼看过去还是「怎么有两个叶双」—— 这正是这次要消掉的观感。
  const [statusFilter, setStatusFilter] = useState<'active' | 'disabled' | undefined>('active');
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<Staff | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await request<Staff[]>({
        url: '/staff',
        query: { role, status: statusFilter, q: q || undefined },
      });
      setRows(list);
    } catch (e: any) {
      message.error(e?.message || '加载失败');
    } finally {
      setLoading(false);
    }
  }, [role, statusFilter, q, message]);

  useEffect(() => { load(); }, [load]);

  // 角色列表页面级拉一次：筛选下拉和新增/编辑弹窗共用同一份，
  // 保证「用户管理里能选的」和「角色管理里配的」永远是同一批
  useEffect(() => {
    request<AssignableRole[]>({ url: '/roles/assignable' })
      .then(setAssignableRoles)
      .catch(() => setAssignableRoles([]));
  }, []);

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
      <Paragraph type="secondary" style={{ marginTop: -8 }}>
        这里管<strong>员工端小程序</strong>和<strong>网站后台</strong>的用户：维修工、办公室、经理、
        采购、管理员，以及保安/居委会/业委会/物业工作人员。给他分配的<strong>业务角色</strong>
        一并决定他在小程序里看到哪几格、在网站上能进哪些页面，配置在 <Link to="/roles">「业务角色」</Link> 页。
        业主是业主端小程序的用户，在 <Link to="/owners">「业主用户」</Link> 页。
      </Paragraph>
      <Card
        title="员工与账号"
        extra={
          <Space>
            <Select
              allowClear
              placeholder="按业务角色筛选"
              style={{ width: 180 }}
              value={role}
              onChange={(v) => setRole(v)}
              // 选项按「角色管理」里的角色名显示，但**身份要列全** ——
              // 只列有角色的身份，会让停用角色后那批在职员工从筛选里整个消失，
              // 受限操作员那里下拉更短，会以为系统里根本没有这些人
              options={ASSIGNABLE_STAFF_ROLES.map((identity) => {
                const named = assignableRoles.find((r) => r.businessRole === identity);
                return {
                  value: identity as UserRole,
                  label: named
                    ? roleOptionLabel(named.name, identity)
                    : roleLabel[identity] ?? identity,
                };
              })}
              {...searchableWideSelectProps}
            />
            <Select
              value={statusFilter}
              onChange={(v) => setStatusFilter(v)}
              style={{ width: 110 }}
              options={[
                { value: 'active', label: '在职' },
                { value: 'disabled', label: '已停用' },
                { value: undefined as any, label: '全部' },
              ]}
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
              // 合并后只剩这一列：角色名打头，底下小字写清它属于哪一类工作流 ——
              // 「张三 = 枫桦管理处主任（物业经理）」比只看到一个角色名有用得多
              title: '业务角色', dataIndex: 'roles', width: 200,
              render: (roles: BoundRole[] | undefined, row) => {
                if (roles?.length) {
                  return roles.map((r) => (
                    <div key={r.id} style={{ marginBottom: 2 }}>
                      <Tag color={r.businessRole ? roleColor[r.businessRole] : 'default'}>
                        {r.name}
                      </Tag>
                      {/* 角色名常常就叫「维修工」，再跟一个「维修工」纯属噪音，
                          只有名字和类型不一样时才有必要点出它属于哪一类 */}
                      {r.businessRole && r.name !== roleLabel[r.businessRole] && (
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          {roleLabel[r.businessRole] || r.businessRole}
                        </Text>
                      )}
                    </div>
                  ));
                }
                // 业务身份 admin 天然是企业超管，不需要绑角色
                if (row.role === UserRole.ADMIN) {
                  return <Tag color="red">企业超管（身份即全权限）</Tag>;
                }
                return <Tag>未分配角色</Tag>;
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
        assignableRoles={assignableRoles}
        onClose={() => setCreating(false)}
        onDone={() => { setCreating(false); load(); }}
      />
      <StaffFormModal
        open={!!editing}
        target={editing}
        assignableRoles={assignableRoles}
        onClose={() => setEditing(null)}
        onDone={() => { setEditing(null); load(); }}
      />
    </div>
  );
}

function StaffFormModal({
  open, target, assignableRoles, onClose, onDone,
}: {
  open: boolean;
  target?: Staff | null;
  assignableRoles: AssignableRole[];
  onClose: () => void;
  onDone: () => void;
}) {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const [communities, setCommunities] = useState<CommunityOption[]>([]);
  // 选中的角色 → 业务身份。2026-08-26 合并后这里不再单独选身份：
  // 身份跟着角色走，否则「后台显示维修工、小程序还按办公室渲染」的老毛病还会回来
  const [roleIds, setRoleIds] = useState<number[]>([]);

  useEffect(() => {
    if (!open) return;
    if (target) {
      form.setFieldsValue({
        name: target.name,
        phone: target.phone,
        loginAccount: target.loginAccount,
        skills: target.skills || [],
        reportCommunityIds: target.reportCommunityIds || [],
        roleIds: target.roleIds || [],
      });
      setRoleIds(target.roleIds || []);
    } else {
      form.resetFields();
      setRoleIds([]);
    }
  }, [open, target, form]);

  // 代报要勾授权小区，小区列表进弹窗时拉一次就够（角色列表由页面传进来）
  useEffect(() => {
    if (!open) return;
    request<CommunityOption[]>({ url: '/communities' })
      .then((list) => setCommunities(list.filter((c) => !c.isGroup)))
      .catch(() => setCommunities([]));
  }, [open]);

  // 身份 = 所选角色里那个带 businessRole 的；编辑存量时角色还没加载完就先用他现有的身份
  /**
   * 下拉选项 = 可分配的角色 ∪ 这个人已经绑着的角色。
   *
   * 只用 /roles/assignable 的话，角色一被停用（或超出当前操作者的数据范围），
   * 绑着它的人在编辑弹窗里就只剩一个裸的角色 id，改个手机号都会被
   * 「请选一个业务角色」挡住，这个人从此改不动。
   */
  const roleOptions = useMemo(() => {
    const byId = new Map(assignableRoles.map((r) => [r.id, r]));
    (target?.roles ?? []).forEach((r) => {
      if (!byId.has(r.id)) {
        byId.set(r.id, {
          id: r.id,
          name: r.name,
          builtIn: r.builtIn,
          dataScope: '',
          businessRole: r.businessRole ?? null,
          unavailable: true,
        });
      }
    });
    return [...byId.values()];
  }, [assignableRoles, target]);

  const identityRole = roleOptions.find(
    (r) => roleIds.includes(r.id) && r.businessRole,
  );
  const role = (identityRole?.businessRole ?? target?.role ?? '') as UserRole;
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
            loginAccount: v.loginAccount || undefined,
            password: v.password || undefined,
            skills: v.skills,
            reportCommunityIds: isReporterRole ? v.reportCommunityIds || [] : undefined,
            roleIds: v.roleIds?.length ? v.roleIds : undefined,
          },
        });
        message.success(
          isReporterRole
            ? '已登记。他在小程序注册过就已直接转为该身份；还没注册的，等他验证微信手机号时自动认领'
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
        <Form.Item
          name="roleIds"
          label="业务角色"
          rules={[
            {
              validator: (_, value: number[] | undefined) => {
                const picked = roleOptions.filter((r) => (value ?? []).includes(r.id));
                const identities = picked.filter((r) => r.businessRole);
                if (!identities.length) {
                  return Promise.reject(
                    new Error('请选一个业务角色（决定他在小程序里能看到什么、能干什么）'),
                  );
                }
                if (identities.length > 1) {
                  return Promise.reject(
                    new Error(
                      `一个人只能有一个业务角色，这里选了${identities
                        .map((r) => r.name)
                        .join('、')}`,
                    ),
                  );
                }
                return Promise.resolve();
              },
            },
          ]}
          extra={
            role === UserRole.ADMIN
              ? '企业超级管理员直通全公司所有页面和数据，数据范围对其不生效。管理处负责人请选「物业经理」或「物业办公室」类角色，其数据范围限定到对应管理处。'
              : identityRole
                ? `${roleLabel[role] || role}。${identityHint[role] ?? ''}他在小程序里看到哪几格、在网站上能进哪些页面，都在「业务角色」页改这一个角色即可。`
                : '业务角色决定三件事：他在小程序里看到哪几格、能不能动手，以及登录网站后能看哪些页面。'
          }
        >
          <Select
            mode="multiple"
            placeholder="选一个业务角色；需要额外网站权限时可再叠加纯后台角色"
            onChange={(v: number[]) => setRoleIds(v)}
            options={withOptionTitles(
              roleOptions.map((r) => ({
                value: r.id,
                label: roleOptionLabel(r.name, r.businessRole, {
                  unavailable: r.unavailable,
                }),
              })),
            )}
            {...searchableWideSelectProps}
          />
        </Form.Item>
        {isReporterRole ? (
          <Form.Item
            name="reportCommunityIds"
            label="可代报的小区"
            rules={[{ required: true, message: '至少选一个小区，否则他在小程序里看不到代报入口' }]}
            extra="只能替这些小区里的住户报修。填他微信注册小程序用的手机号：已注册过的账号会直接转为该身份；还没注册的，等他在小程序里验证手机号时自动认领 —— 都不会产生重复档案。"
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
        <Row gutter={12}>
          <Col span={12}>
            <Form.Item
              name="loginAccount"
              label={needsLogin ? '登录账号' : '登录账号（选填）'}
              rules={[{ required: needsLogin && !target, message: '该角色必须登录后台' }]}
              extra={needsLogin
                ? undefined
                : isReporterRole
                  ? '配合上面的业务角色使用：角色里勾了网站页面、这里又有账号密码，才能登录网页后台'
                  : '维修工填了账号密码后，员工端可用账号密码登录'}
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
