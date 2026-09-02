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
import { handleGone } from '../lib/gone';
import { usePagePerm } from '../lib/auth';
import { searchableWideSelectProps, withOptionTitles } from '../lib/selectProps';
import { UserRole } from '@pms/shared-types';
import { Link } from 'react-router-dom';

const { Title, Paragraph, Text } = Typography;

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
  /** 勾了网站后台页面 → 这个人需要账号密码才能用上 */
  hasAdminPages?: boolean;
  /** 勾了哪些员工端入口 */
  appPageKeys?: string[];
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
  const [roleId, setRoleId] = useState<number | undefined>();
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
        query: { roleId, status: statusFilter, q: q || undefined },
      });
      setRows(list);
    } catch (e: any) {
      message.error(e?.message || '加载失败');
    } finally {
      setLoading(false);
    }
  }, [roleId, statusFilter, q, message]);

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
    } catch (e: any) {
      if (handleGone(e, message, '这个用户', load)) return;
      message.error(e?.message || '操作失败');
    }
  };

  const unbindWx = async (s: Staff) => {
    try {
      await request({ method: 'POST', url: `/staff/${s.id}/unbind-wx` });
      message.success(`已解绑 ${s.name?.trim() || '该员工'} 的员工端微信`);
      load();
    } catch (e: any) {
      if (handleGone(e, message, '这个用户', load)) return;
      message.error(e?.message || '解绑失败');
    }
  };

  return (
    <div>
      <Paragraph className="pms-page-note" type="secondary">
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
              value={roleId}
              onChange={(v) => setRoleId(v)}
              // 选项就是「业务角色」页里配的角色本身
              options={assignableRoles.map((r) => ({ value: r.id, label: r.name }))}
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
          // 每列都给宽度 + 合计当 scroll.x：不给的话窗口一窄 antd 就把列压到一个字宽，
          // 「赵丽萍」变成竖着排的三行（2026-08-31 在 1024 宽的屏上量到 30px 宽 / 91px 高）
          scroll={{ x: 1180 }}
          columns={[
            { title: 'ID', dataIndex: 'id', width: 70 },
            { title: '姓名', dataIndex: 'name', width: 110, render: (v) => v || '-' },
            { title: '电话', dataIndex: 'phone', width: 130, render: (v) => v || '-' },
            {
              // 合并后只剩这一列：角色名打头，底下小字写清它属于哪一类工作流 ——
              // 「张三 = 枫桦管理处主任（物业经理）」比只看到一个角色名有用得多
              title: '业务角色', dataIndex: 'roles', width: 200,
              render: (roles: BoundRole[] | undefined, row) => {
                if (roles?.length) {
                  return roles.map((r) => (
                    <Tag key={r.id} color={r.builtIn ? 'red' : 'blue'}>
                      {r.name}
                    </Tag>
                  ));
                }
                return <Tag>未分配角色</Tag>;
              },
            },
            {
              title: '工种', dataIndex: 'skills', width: 200,
              render: (s: string[]) => s?.length ? s.map((x) => <Tag key={x}>{skillOptions.find((o) => o.value === x)?.label || x}</Tag>) : '-',
            },
            { title: '登录账号', dataIndex: 'loginAccount', width: 130, render: (v) => v || '-' },
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
          unavailable: true,
        });
      }
    });
    return [...byId.values()];
  }, [assignableRoles, target]);

  const pickedRoles = roleOptions.filter((r) => roleIds.includes(r.id));
  const appKeys = new Set(pickedRoles.flatMap((r) => r.appPageKeys ?? []));
  /**
   * 「只替住户报修的人」：他的角色里既没有工单池也没有派单台。
   * 这类人报修位置受「可代报的小区」限制，所以才需要配那一栏。
   */
  const reporterOnly =
    !!pickedRoles.length && !appKeys.has('app:pool') && !appKeys.has('app:dispatch');

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
            reportCommunityIds: reporterOnly ? v.reportCommunityIds || [] : undefined,
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
            reportCommunityIds: reporterOnly ? v.reportCommunityIds || [] : undefined,
            roleIds: v.roleIds?.length ? v.roleIds : undefined,
          },
        });
        message.success(
          reporterOnly
            ? '已登记。他在小程序注册过就已直接转为该身份；还没注册的，等他验证微信手机号时自动认领'
            : '员工已创建',
        );
      }
      onDone();
    } catch (e: any) {
      if (target && handleGone(e, message, '这个用户', onDone)) return;
      message.error(e?.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  // 只上小程序的角色走微信登录，账号密码留空即可；
  // 角色里勾了网站页面的人必须有账号密码，否则他登不进后台
  const needsLogin = pickedRoles.some((r) => r.hasAdminPages);

  return (
    <Modal
      title={target ? `编辑员工：${target.name?.trim() || '未填姓名'}` : '新增员工'}
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
                if (!(value ?? []).length) {
                  return Promise.reject(
                    new Error('请给他选一个业务角色，他会继承角色里配好的权限'),
                  );
                }
                return Promise.resolve();
              },
            },
          ]}
          extra={
            pickedRoles.length
              ? `他在小程序里看到哪几格、在网站上能进哪些页面，都在「业务角色」页改这些角色即可。${
                  needsLogin ? '这个角色能进网站后台，记得一并设置下面的登录账号和密码。' : ''
                }`
              : '选一个角色，他就继承这个角色勾好的页面权限和数据范围。角色在「业务角色」页配置。'
          }
        >
          <Select
            mode="multiple"
            placeholder="选一个业务角色；需要额外网站权限时可再叠加纯后台角色"
            onChange={(v: number[]) => setRoleIds(v)}
            options={withOptionTitles(
              roleOptions.map((r) => ({
                value: r.id,
                label: `${r.name}${r.builtIn ? '（内置·全权限）' : ''}${
                  r.unavailable ? ' · 已停用' : ''
                }`,
              })),
            )}
            {...searchableWideSelectProps}
          />
        </Form.Item>
        {reporterOnly ? (
          <Form.Item
            name="reportCommunityIds"
            label="可代报的小区"
            rules={[{ required: true, message: '至少选一个小区，否则他在小程序里看不到代报入口' }]}
            extra="这个角色只能报修、看不到工单池，所以要指定他能替哪些小区报。填他微信注册小程序用的手机号：已注册过的账号会直接接上，还没注册的等他验证手机号时自动认领 —— 都不会产生重复档案。"
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
          <Form.Item name="skills" label="工种（选填，派单时按工种匹配）">
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
                : '选填。这个角色只用小程序，他用微信手机号登录即可；填了账号密码则多一种登录方式'}
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
