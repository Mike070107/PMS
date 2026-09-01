import {
  App as AntdApp,
  Button,
  Card,
  Checkbox,
  DatePicker,
  Divider,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd';
import { LoginOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ADMIN_PAGES, ALWAYS_ENABLED_PAGES } from '@pms/shared-types';
import { request } from '../lib/api';
import { handleGone } from '../lib/gone';
import { auth } from '../lib/auth';

const { Title, Text } = Typography;

interface TenantAdmin {
  id: number;
  name: string | null;
  loginAccount: string | null;
  status: string;
}

interface TenantRow {
  id: number;
  name: string;
  contactName: string | null;
  contactPhone: string | null;
  enabled: boolean;
  enabledPages: string[] | null;
  /** 服务有效期至（YYYY-MM-DD，含当天）。null = 永久 */
  expiresAt: string | null;
  userCount: number;
  communityCount: number;
  admins: TenantAdmin[];
  createdAt: string;
}

/** 有效期展示：永久 / 到期日 + 已到期（红）/ 30 天内到期（橙）提示 */
function ExpiryCell({ expiresAt }: { expiresAt: string | null }) {
  if (!expiresAt) return <Text type="secondary">永久</Text>;
  const date = String(expiresAt).slice(0, 10);
  const daysLeft = dayjs(date).diff(dayjs().startOf('day'), 'day');
  if (daysLeft < 0) {
    return (
      <Space size={6}>
        <span>{date}</span>
        <Tag color="red">已到期</Tag>
      </Space>
    );
  }
  if (daysLeft <= 30) {
    return (
      <Space size={6}>
        <span>{date}</span>
        <Tag color="orange">剩 {daysLeft} 天</Tag>
      </Space>
    );
  }
  return <span>{date}</span>;
}

export default function PlatformTenantsPage() {
  const { message } = AntdApp.useApp();
  const nav = useNavigate();
  const [rows, setRows] = useState<TenantRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<TenantRow | null>(null);
  const [resetting, setResetting] = useState<TenantRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await request<TenantRow[]>({ url: '/platform/tenants' }));
    } catch (e: any) {
      message.error(e?.message || '加载失败');
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => { load(); }, [load]);

  const enterTenant = async (t: TenantRow) => {
    try {
      const info = await request<{ id: number; name: string }>({
        method: 'POST',
        url: `/platform/tenants/${t.id}/enter`,
      });
      auth.setActingTenant({ id: info.id, name: info.name });
      message.success(`已进入「${info.name}」公司视角`);
      nav('/dashboard');
    } catch (e: any) {
      message.error(e?.message || '进入失败');
    }
  };

  return (
    <div>
      <Title level={4} style={{ marginTop: 0 }}>物业公司</Title>
      <Card
        title="平台租户：创建公司与企业超管账号、分配可用页面、进入公司视角代操作（导入数据、改设置）"
        extra={
          <Space>
            <Button icon={<ReloadOutlined />} onClick={load}>刷新</Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>
              新建物业公司
            </Button>
          </Space>
        }
      >
        <Table
          rowKey="id"
          size="middle"
          loading={loading}
          dataSource={rows}
          pagination={false}
          columns={[
            { title: 'ID', dataIndex: 'id', width: 60 },
            {
              title: '公司', dataIndex: 'name', width: 200,
              render: (v: string, r) => (
                <Space size={6}>
                  <span style={{ fontWeight: 600 }}>{v}</span>
                  {!r.enabled && <Tag color="red">已停用</Tag>}
                </Space>
              ),
            },
            {
              title: '联系人', key: 'contact', width: 160,
              render: (_, r) =>
                r.contactName || r.contactPhone
                  ? `${r.contactName ?? ''} ${r.contactPhone ?? ''}`.trim()
                  : '-',
            },
            {
              title: '企业超管账号', dataIndex: 'admins', width: 200,
              render: (admins: TenantAdmin[]) =>
                admins.length
                  ? admins.map((a) => (
                      <Tag key={a.id} color={a.status === 'active' ? 'processing' : 'default'}>
                        {a.loginAccount || a.name || '未填账号'}
                      </Tag>
                    ))
                  : <Text type="secondary">未开通</Text>,
            },
            { title: '用户数', dataIndex: 'userCount', width: 80 },
            { title: '小区数', dataIndex: 'communityCount', width: 80 },
            {
              title: '有效期', dataIndex: 'expiresAt', width: 150,
              render: (v: string | null) => <ExpiryCell expiresAt={v} />,
            },
            {
              title: '可用页面', dataIndex: 'enabledPages', width: 110,
              render: (v: string[] | null) =>
                v ? `${v.length} / ${ADMIN_PAGES.length} 个` : '全部',
            },
            {
              title: '操作', key: 'op', width: 240,
              render: (_, r) => (
                <Space size={0} wrap>
                  <Button
                    type="link"
                    size="small"
                    icon={<LoginOutlined />}
                    disabled={!r.enabled}
                    onClick={() => enterTenant(r)}
                  >
                    进入公司
                  </Button>
                  <Button type="link" size="small" onClick={() => setEditing(r)}>编辑</Button>
                  <Button type="link" size="small" onClick={() => setResetting(r)}>重置超管密码</Button>
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <TenantCreateModal
        open={creating}
        onClose={() => setCreating(false)}
        onDone={() => { setCreating(false); load(); }}
      />
      <TenantEditModal
        target={editing}
        onClose={() => setEditing(null)}
        onDone={() => { setEditing(null); load(); }}
      />
      <ResetAdminModal
        target={resetting}
        onClose={() => setResetting(null)}
        onDone={() => setResetting(null)}
      />
    </div>
  );
}

function PagePicker({ value, onChange }: { value?: string[] | null; onChange?: (v: string[] | null) => void }) {
  const all = value == null;
  return (
    <div>
      <Checkbox
        checked={all}
        onChange={(e) => onChange?.(e.target.checked ? null : ADMIN_PAGES.map((p) => p.key))}
      >
        全部页面
      </Checkbox>
      {!all && (
        <>
          <Divider style={{ margin: '8px 0' }} />
          <Checkbox.Group
            value={value ?? []}
            onChange={(v) => onChange?.(v as string[])}
            // 「系统设置」是公司自己的配置项，不受这里的勾选控制：没勾也永远能进，
            // 所以画成锁定态，别让平台运营以为不勾就关掉了
            options={ADMIN_PAGES.map((p) =>
              ALWAYS_ENABLED_PAGES.includes(p.key)
                ? { value: p.key, label: `${p.label}（始终可用）`, disabled: true }
                : { value: p.key, label: p.label },
            )}
          />
        </>
      )}
    </div>
  );
}

function TenantCreateModal({
  open, onClose, onDone,
}: { open: boolean; onClose: () => void; onDone: () => void }) {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      form.resetFields();
      form.setFieldsValue({ enabledPages: null });
    }
  }, [open, form]);

  const onOk = async () => {
    const v = await form.validateFields();
    setSaving(true);
    try {
      await request({
        method: 'POST',
        url: '/platform/tenants',
        data: {
          name: v.name,
          contactName: v.contactName || undefined,
          contactPhone: v.contactPhone || undefined,
          enabledPages: v.enabledPages ?? undefined,
          expiresAt: v.expiresAt ? dayjs(v.expiresAt).format('YYYY-MM-DD') : undefined,
          admin: {
            name: v.adminName,
            account: v.adminAccount,
            password: v.adminPassword,
            phone: v.adminPhone || undefined,
          },
        },
      });
      message.success('公司已创建，请把超管账号密码交给对方并提醒尽快修改');
      onDone();
    } catch (e: any) {
      message.error(e?.message || '创建失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title="新建物业公司"
      open={open}
      onCancel={onClose}
      onOk={onOk}
      confirmLoading={saving}
      destroyOnHidden
      width={560}
    >
      <Form form={form} layout="vertical">
        <Form.Item name="name" label="公司名称" rules={[{ required: true, message: '请填写公司名称' }]}>
          <Input placeholder="如：XX 物业管理有限公司" />
        </Form.Item>
        <Space.Compact block>
          <Form.Item name="contactName" label="联系人（选填）" style={{ flex: 1, marginRight: 12 }}>
            <Input />
          </Form.Item>
          <Form.Item name="contactPhone" label="联系电话（选填）" style={{ flex: 1 }}>
            <Input />
          </Form.Item>
        </Space.Compact>
        <Form.Item name="enabledPages" label="可用页面">
          <PagePicker />
        </Form.Item>
        <Form.Item
          name="expiresAt"
          label="服务有效期至（选填）"
          extra="留空 = 永久有效。到期次日起该公司全员（含小程序）无法使用。"
        >
          <DatePicker style={{ width: '100%' }} placeholder="选择到期日（含当天）" />
        </Form.Item>
        <Divider style={{ margin: '8px 0 16px' }}>首个企业超级管理员</Divider>
        <Space.Compact block>
          <Form.Item name="adminName" label="姓名" rules={[{ required: true, message: '请填写姓名' }]} style={{ flex: 1, marginRight: 12 }}>
            <Input />
          </Form.Item>
          <Form.Item name="adminPhone" label="手机号（选填）" style={{ flex: 1 }}>
            <Input />
          </Form.Item>
        </Space.Compact>
        <Space.Compact block>
          <Form.Item
            name="adminAccount"
            label="登录账号"
            rules={[{ required: true, min: 3, message: '至少 3 个字符' }]}
            style={{ flex: 1, marginRight: 12 }}
          >
            <Input autoComplete="off" />
          </Form.Item>
          <Form.Item
            name="adminPassword"
            label="初始密码"
            rules={[{ required: true, min: 8, message: '至少 8 位' }]}
            style={{ flex: 1 }}
          >
            <Input.Password autoComplete="new-password" />
          </Form.Item>
        </Space.Compact>
      </Form>
    </Modal>
  );
}

function TenantEditModal({
  target, onClose, onDone,
}: { target: TenantRow | null; onClose: () => void; onDone: () => void }) {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!target) return;
    form.setFieldsValue({
      name: target.name,
      contactName: target.contactName ?? undefined,
      contactPhone: target.contactPhone ?? undefined,
      enabledPages: target.enabledPages,
      expiresAt: target.expiresAt ? dayjs(String(target.expiresAt).slice(0, 10)) : null,
      enabled: target.enabled,
    });
  }, [target, form]);

  const onOk = async () => {
    if (!target) return;
    const v = await form.validateFields();
    setSaving(true);
    try {
      await request({
        method: 'PATCH',
        url: `/platform/tenants/${target.id}`,
        data: {
          name: v.name,
          contactName: v.contactName ?? null,
          contactPhone: v.contactPhone ?? null,
          enabledPages: v.enabledPages,
          expiresAt: v.expiresAt ? dayjs(v.expiresAt).format('YYYY-MM-DD') : null,
          enabled: v.enabled,
        },
      });
      message.success('已保存');
      onDone();
    } catch (e: any) {
      if (handleGone(e, message, '这家公司', onDone)) return;
      message.error(e?.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={target ? `编辑「${target.name}」` : ''}
      open={!!target}
      onCancel={onClose}
      onOk={onOk}
      confirmLoading={saving}
      destroyOnHidden
      width={560}
    >
      <Form form={form} layout="vertical">
        <Form.Item name="name" label="公司名称" rules={[{ required: true }]}>
          <Input />
        </Form.Item>
        <Space.Compact block>
          <Form.Item name="contactName" label="联系人" style={{ flex: 1, marginRight: 12 }}>
            <Input />
          </Form.Item>
          <Form.Item name="contactPhone" label="联系电话" style={{ flex: 1 }}>
            <Input />
          </Form.Item>
        </Space.Compact>
        <Form.Item name="enabledPages" label="可用页面" extra="公司内角色只能在这些页面范围内分配权限；取消勾选立即对该公司全员生效。">
          <PagePicker />
        </Form.Item>
        <Form.Item
          name="expiresAt"
          label="服务有效期至"
          extra="清空 = 永久有效。到期次日起该公司全员（含小程序）无法使用，续期后自动恢复。"
        >
          <DatePicker style={{ width: '100%' }} placeholder="选择到期日（含当天）" allowClear />
        </Form.Item>
        <Form.Item name="enabled" label="启用" valuePropName="checked" extra="停用后该公司所有账号无法登录。">
          <Switch />
        </Form.Item>
      </Form>
    </Modal>
  );
}

function ResetAdminModal({
  target, onClose, onDone,
}: { target: TenantRow | null; onClose: () => void; onDone: () => void }) {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (target) form.resetFields();
  }, [target, form]);

  const onOk = async () => {
    if (!target) return;
    const v = await form.validateFields();
    setSaving(true);
    try {
      await request({
        method: 'POST',
        url: `/platform/tenants/${target.id}/reset-admin-password`,
        data: { userId: v.userId, password: v.password },
      });
      message.success('已重置，请把新密码交给对方并提醒尽快修改');
      onDone();
    } catch (e: any) {
      if (handleGone(e, message, '这家公司或该账号', onDone)) return;
      message.error(e?.message || '重置失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={target ? `重置「${target.name}」超管密码` : ''}
      open={!!target}
      onCancel={onClose}
      onOk={onOk}
      confirmLoading={saving}
      destroyOnHidden
      width={420}
    >
      <Form form={form} layout="vertical">
        <Form.Item name="userId" label="超管账号" rules={[{ required: true, message: '请选择账号' }]}>
          <Select
            options={(target?.admins ?? []).map((a) => ({
              value: a.id,
              label: `${a.loginAccount || a.name || '未填账号'}${a.status !== 'active' ? '（停用）' : ''}`,
            }))}
            placeholder="选择要重置的账号"
          />
        </Form.Item>
        <Form.Item name="password" label="新密码" rules={[{ required: true, min: 8, message: '至少 8 位' }]}>
          <Input.Password autoComplete="new-password" />
        </Form.Item>
      </Form>
    </Modal>
  );
}
