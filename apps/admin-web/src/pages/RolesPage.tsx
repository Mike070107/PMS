import {
  App as AntdApp,
  Alert,
  Button,
  Card,
  Checkbox,
  Form,
  Input,
  Modal,
  Popconfirm,
  Radio,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd';
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ADMIN_PAGES,
  ROLE_DATA_SCOPE_LABELS,
  RoleDataScope,
} from '@pms/shared-types';
import { request } from '../lib/api';
import { usePagePerm, useAuth } from '../lib/auth';
import { searchableWideSelectProps, withOptionTitles } from '../lib/selectProps';

const { Title, Text } = Typography;

interface RolePermRow {
  pageKey: string;
  canView: boolean;
  canEdit: boolean;
  canDelete: boolean;
}

interface RoleRow {
  id: number;
  name: string;
  remark: string | null;
  dataScope: string;
  builtIn: boolean;
  enabled: boolean;
  userCount: number;
  permissions: RolePermRow[];
  officeIds: number[];
  communityIds: number[];
}

interface ScopeOptions {
  offices: { id: number; name: string; enabled: boolean }[];
  communities: { id: number; name: string; officeId: number | null }[];
}

export default function RolesPage() {
  const { message } = AntdApp.useApp();
  const { canEdit, canDelete } = usePagePerm('roles');
  const { access } = useAuth();
  const isTenantAdmin = !access || access.isTenantAdmin || access.isPlatformAdmin;
  const [rows, setRows] = useState<RoleRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<RoleRow | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await request<RoleRow[]>({ url: '/roles' }));
    } catch (e: any) {
      message.error(e?.message || '加载失败');
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => { load(); }, [load]);

  const remove = async (r: RoleRow) => {
    try {
      await request({ method: 'DELETE', url: `/roles/${r.id}` });
      message.success('已删除');
      load();
    } catch (e: any) {
      message.error(e?.message || '删除失败');
    }
  };

  const mayWrite = canEdit && isTenantAdmin;

  return (
    <div>
      <Title level={4} style={{ marginTop: 0 }}>角色管理</Title>
      {!isTenantAdmin && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="只有企业超级管理员可以新建或修改角色；你可以查看现有角色的配置。"
        />
      )}
      <Card
        title="角色 = 页面权限（查看/编辑/删除）+ 数据范围（全公司/指定管理处/指定小区）"
        extra={
          <Space>
            <Button icon={<ReloadOutlined />} onClick={load}>刷新</Button>
            {mayWrite && (
              <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>
                新建角色
              </Button>
            )}
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
            {
              title: '角色', dataIndex: 'name', width: 200,
              render: (v: string, r) => (
                <Space size={6}>
                  <span style={{ fontWeight: 600 }}>{v}</span>
                  {r.builtIn && <Tag color="red">内置</Tag>}
                  {!r.enabled && <Tag>已停用</Tag>}
                </Space>
              ),
            },
            {
              title: '数据范围', dataIndex: 'dataScope', width: 130,
              render: (v: string) => ROLE_DATA_SCOPE_LABELS[v] ?? v,
            },
            {
              title: '页面权限', dataIndex: 'permissions',
              render: (perms: RolePermRow[], r) =>
                r.builtIn ? (
                  <Text type="secondary">全部页面 · 全部权限</Text>
                ) : perms.length ? (
                  perms.filter((p) => p.canView).map((p) => {
                    const page = ADMIN_PAGES.find((x) => x.key === p.pageKey);
                    const marks = [p.canEdit && '改', p.canDelete && '删'].filter(Boolean).join('');
                    return (
                      <Tag key={p.pageKey}>
                        {page?.label ?? p.pageKey}
                        {marks ? `·${marks}` : ''}
                      </Tag>
                    );
                  })
                ) : (
                  <Text type="secondary">未配置</Text>
                ),
            },
            { title: '绑定用户', dataIndex: 'userCount', width: 90 },
            { title: '备注', dataIndex: 'remark', width: 180, render: (v) => v || '-' },
            {
              title: '操作', key: 'op', width: 140,
              render: (_, r) => (
                <Space size={0}>
                  {mayWrite && !r.builtIn && (
                    <Button type="link" size="small" onClick={() => setEditing(r)}>编辑</Button>
                  )}
                  {canDelete && isTenantAdmin && !r.builtIn && (
                    <Popconfirm
                      title="删除该角色？"
                      description="需先在用户管理里解绑所有用户。"
                      okText="删除"
                      okButtonProps={{ danger: true }}
                      cancelText="取消"
                      onConfirm={() => remove(r)}
                    >
                      <Button type="link" size="small" danger>删除</Button>
                    </Popconfirm>
                  )}
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <RoleFormModal
        open={creating || !!editing}
        target={editing}
        onClose={() => { setCreating(false); setEditing(null); }}
        onDone={() => { setCreating(false); setEditing(null); load(); }}
      />
    </div>
  );
}

function RoleFormModal({
  open, target, onClose, onDone,
}: {
  open: boolean;
  target?: RoleRow | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const { message } = AntdApp.useApp();
  const { access } = useAuth();
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const [dataScope, setDataScope] = useState<string>(RoleDataScope.ALL);
  const [scopeOptions, setScopeOptions] = useState<ScopeOptions>({ offices: [], communities: [] });
  const [perms, setPerms] = useState<Record<string, RolePermRow>>({});

  // 公司没开通的页面不出现在矩阵里
  const pages = useMemo(
    () =>
      ADMIN_PAGES.filter(
        (p) => !access?.enabledPages || access.enabledPages.includes(p.key),
      ),
    [access?.enabledPages],
  );

  useEffect(() => {
    if (!open) return;
    request<ScopeOptions>({ url: '/roles/scope-options' })
      .then(setScopeOptions)
      .catch(() => setScopeOptions({ offices: [], communities: [] }));
    if (target) {
      form.setFieldsValue({
        name: target.name,
        remark: target.remark ?? undefined,
        dataScope: target.dataScope,
        officeIds: target.officeIds,
        communityIds: target.communityIds,
        enabled: target.enabled,
      });
      setDataScope(target.dataScope);
      setPerms(Object.fromEntries(target.permissions.map((p) => [p.pageKey, { ...p }])));
    } else {
      form.resetFields();
      form.setFieldsValue({ dataScope: RoleDataScope.ALL, enabled: true });
      setDataScope(RoleDataScope.ALL);
      setPerms({});
    }
  }, [open, target, form]);

  const setPerm = (pageKey: string, patch: Partial<RolePermRow>) => {
    setPerms((prev) => {
      const cur = prev[pageKey] ?? { pageKey, canView: false, canEdit: false, canDelete: false };
      const next = { ...cur, ...patch };
      // 勾了编辑/删除自动补查看；取消查看则整行清空
      if (patch.canEdit || patch.canDelete) next.canView = true;
      if (patch.canView === false) {
        next.canEdit = false;
        next.canDelete = false;
      }
      return { ...prev, [pageKey]: next };
    });
  };

  const onOk = async () => {
    const v = await form.validateFields();
    const permissions = Object.values(perms).filter((p) => p.canView);
    if (!permissions.length) {
      message.warning('至少给该角色勾选一个可见页面');
      return;
    }
    setSaving(true);
    try {
      const data = {
        name: v.name,
        remark: v.remark || undefined,
        dataScope: v.dataScope,
        officeIds: v.dataScope === RoleDataScope.OFFICES ? v.officeIds : undefined,
        communityIds: v.dataScope === RoleDataScope.COMMUNITIES ? v.communityIds : undefined,
        enabled: v.enabled,
        permissions,
      };
      if (target) {
        await request({ method: 'PATCH', url: `/roles/${target.id}`, data });
      } else {
        await request({ method: 'POST', url: '/roles', data });
      }
      message.success('已保存');
      onDone();
    } catch (e: any) {
      message.error(e?.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={target ? `编辑角色「${target.name}」` : '新建角色'}
      open={open}
      onCancel={onClose}
      onOk={onOk}
      confirmLoading={saving}
      destroyOnHidden
      width={680}
    >
      <Form form={form} layout="vertical">
        <Space.Compact block>
          <Form.Item name="name" label="角色名称" rules={[{ required: true, message: '请填写角色名称' }]} style={{ flex: 1, marginRight: 12 }}>
            <Input placeholder="如：枫桦景苑管理处主任、客服专员" />
          </Form.Item>
          <Form.Item name="enabled" label="启用" valuePropName="checked" style={{ width: 80 }}>
            <Switch />
          </Form.Item>
        </Space.Compact>
        <Form.Item name="remark" label="备注（选填）">
          <Input placeholder="给同事看的说明" maxLength={100} />
        </Form.Item>

        <Form.Item name="dataScope" label="数据范围" rules={[{ required: true }]}>
          <Radio.Group
            onChange={(e) => setDataScope(e.target.value)}
            options={Object.entries(ROLE_DATA_SCOPE_LABELS).map(([value, label]) => ({ value, label }))}
          />
        </Form.Item>
        {dataScope === RoleDataScope.OFFICES && (
          <Form.Item
            name="officeIds"
            label="可见管理处"
            rules={[{ required: true, message: '请选择管理处' }]}
            extra="选中管理处即包含其下全部小区（之后新划入的小区自动生效）。"
          >
            <Select
              mode="multiple"
              placeholder="可多选"
              options={withOptionTitles(
                scopeOptions.offices.map((o) => ({ value: o.id, label: o.name })),
              )}
              {...searchableWideSelectProps}
            />
          </Form.Item>
        )}
        {dataScope === RoleDataScope.COMMUNITIES && (
          <Form.Item
            name="communityIds"
            label="可见小区"
            rules={[{ required: true, message: '请选择小区' }]}
            extra="选顶层小区即可，分期会自动包含。"
          >
            <Select
              mode="multiple"
              placeholder="可多选"
              options={withOptionTitles(
                scopeOptions.communities.map((c) => ({ value: c.id, label: c.name })),
              )}
              {...searchableWideSelectProps}
            />
          </Form.Item>
        )}

        <Form.Item label="页面权限" required>
          <Table
            rowKey="key"
            size="small"
            pagination={false}
            dataSource={pages}
            columns={[
              { title: '页面', dataIndex: 'label', width: 160,
                render: (v: string, p) => (
                  <span>
                    <Text type="secondary" style={{ fontSize: 12, marginRight: 6 }}>{p.group}</Text>
                    {v}
                  </span>
                ),
              },
              {
                title: '查看', key: 'view', width: 80,
                render: (_, p) => (
                  <Checkbox
                    checked={!!perms[p.key]?.canView}
                    onChange={(e) => setPerm(p.key, { canView: e.target.checked })}
                  />
                ),
              },
              {
                title: '编辑（含新增）', key: 'edit', width: 120,
                render: (_, p) => (
                  <Checkbox
                    checked={!!perms[p.key]?.canEdit}
                    onChange={(e) => setPerm(p.key, { canEdit: e.target.checked })}
                  />
                ),
              },
              {
                title: '删除', key: 'delete', width: 80,
                render: (_, p) => (
                  <Checkbox
                    checked={!!perms[p.key]?.canDelete}
                    onChange={(e) => setPerm(p.key, { canDelete: e.target.checked })}
                  />
                ),
              },
            ]}
          />
        </Form.Item>
      </Form>
    </Modal>
  );
}
