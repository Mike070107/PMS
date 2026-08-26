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
  Tabs,
  Tag,
  Typography,
} from 'antd';
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ADMIN_PAGES,
  ASSIGNABLE_STAFF_ROLES,
  ROLE_DATA_SCOPE_LABELS,
  RoleDataScope,
  DEFAULT_APP_PAGES_BY_IDENTITY,
  STAFF_APP_PAGES,
  STAFF_APP_WORKER_ROLES,
  USER_ROLE_LABELS,
  isStaffAppPageKey,
} from '@pms/shared-types';
import { request } from '../lib/api';
import { usePagePerm, useAuth } from '../lib/auth';
import { identityHint, roleLabel } from '../lib/roleLabels';
import { searchableWideSelectProps, withOptionTitles } from '../lib/selectProps';

const { Title, Text } = Typography;

/** 纯后台角色的哨兵值：Select 不接受 null，用空串代过去再转回 null */
const NO_IDENTITY = '';

const identityOptions = [
  { value: NO_IDENTITY, label: '仅后台（不上小程序）' },
  ...ASSIGNABLE_STAFF_ROLES.map((r) => ({
    value: r as string,
    label: roleLabel[r] ?? USER_ROLE_LABELS[r],
  })),
];


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
  /** 业务身份：决定小程序端能力、审批链、登录哪个端；null = 纯后台角色 */
  businessRole: string | null;
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
      <Title level={4} style={{ marginTop: 0 }}>业务角色</Title>
      {!isTenantAdmin && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="只有企业超级管理员可以新建或修改业务角色；你可以查看现有角色的配置。"
        />
      )}
      <Card
        title="一个角色说清三件事：他在小程序里看到哪几格、在网站后台能进哪些页面、能看哪些小区的数据"
        extra={
          <Space>
            <Button icon={<ReloadOutlined />} onClick={load}>刷新</Button>
            {mayWrite && (
              <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>
                新建业务角色
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
              title: '角色类型', dataIndex: 'businessRole', width: 130,
              render: (v: string | null) =>
                v ? (
                  <Tag color={STAFF_APP_WORKER_ROLES.includes(v as never) ? 'blue' : 'default'}>
                    {USER_ROLE_LABELS[v] ?? v}
                  </Tag>
                ) : (
                  <Text type="secondary">仅后台</Text>
                ),
            },
            {
              title: '数据范围', dataIndex: 'dataScope', width: 130,
              render: (v: string) => ROLE_DATA_SCOPE_LABELS[v] ?? v,
            },
            {
              title: '能看到什么', dataIndex: 'permissions',
              render: (perms: RolePermRow[], r) => {
                if (r.builtIn) return <Text type="secondary">全部页面 · 全部权限</Text>;
                const visible = perms.filter((p) => p.canView);
                const app = visible.filter((p) => isStaffAppPageKey(p.pageKey));
                const admin = visible.filter((p) => !isStaffAppPageKey(p.pageKey));
                if (!visible.length) return <Text type="secondary">未配置</Text>;
                const row = (
                  label: string,
                  list: RolePermRow[],
                  find: (key: string) => string,
                ) =>
                  list.length ? (
                    <div style={{ marginBottom: 2 }}>
                      <Text type="secondary" style={{ fontSize: 12, marginRight: 6 }}>
                        {label}
                      </Text>
                      {list.map((p) => {
                        const marks = [p.canEdit && '改', p.canDelete && '删']
                          .filter(Boolean)
                          .join('');
                        return (
                          <Tag key={p.pageKey}>
                            {find(p.pageKey)}
                            {marks ? `·${marks}` : ''}
                          </Tag>
                        );
                      })}
                    </div>
                  ) : null;
                return (
                  <>
                    {row('小程序', app, (k) =>
                      STAFF_APP_PAGES.find((x) => x.key === k)?.label ?? k)}
                    {row('后台', admin, (k) =>
                      ADMIN_PAGES.find((x) => x.key === k)?.label ?? k)}
                  </>
                );
              },
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
  const [businessRole, setBusinessRole] = useState<string>(NO_IDENTITY);
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
        businessRole: target.businessRole ?? NO_IDENTITY,
        dataScope: target.dataScope,
        officeIds: target.officeIds,
        communityIds: target.communityIds,
        enabled: target.enabled,
      });
      setBusinessRole(target.businessRole ?? NO_IDENTITY);
      setDataScope(target.dataScope);
      setPerms(Object.fromEntries(target.permissions.map((p) => [p.pageKey, { ...p }])));
    } else {
      form.resetFields();
      form.setFieldsValue({
        businessRole: NO_IDENTITY,
        dataScope: RoleDataScope.ALL,
        enabled: true,
      });
      setBusinessRole(NO_IDENTITY);
      setDataScope(RoleDataScope.ALL);
      setPerms({});
    }
  }, [open, target, form]);

  /**
   * 选了角色类型就把这一行常用的员工端入口先勾上（推荐组合与升级种子同一份）。
   *
   * 只在「一格都没勾」或「勾的正好是上一个类型的推荐组合」时覆盖 ——
   * 前者是新建角色的起手，后者是选错了类型改选（先点维修工、再改成保安，
   * 不重算的话这个保安角色会留着工单池还能接单，正是要消灭的越权组合）。
   * 管理员手工调过的勾选不动，那是他的意思。
   */
  const applyIdentityPreset = (identity: string, prevIdentity: string) => {
    setPerms((prev) => {
      const current = Object.values(prev).filter(
        (p) => isStaffAppPageKey(p.pageKey) && p.canView,
      );
      const prevPreset = DEFAULT_APP_PAGES_BY_IDENTITY[prevIdentity];
      const untouched =
        !current.length ||
        (!!prevPreset && matchesPreset(current, prevPreset));
      if (!untouched) return prev;
      const next = Object.fromEntries(
        Object.entries(prev).filter(([key]) => !isStaffAppPageKey(key)),
      );
      Object.entries(DEFAULT_APP_PAGES_BY_IDENTITY[identity] ?? {}).forEach(
        ([pageKey, level]) => {
          next[pageKey] = {
            pageKey,
            canView: true,
            canEdit: level === 'e',
            canDelete: false,
          };
        },
      );
      return next;
    });
  };

  /**
   * 主勾选 = 「这个页面给不给他」。勾上即至少能看，取消则连带清掉改/删 ——
   * 只清 canView 会在库里留下 canEdit=true 的孤儿记录，下次打开又是一片勾。
   */
  const togglePage = (pageKey: string, on: boolean) => {
    setPerms((prev) => {
      if (!on) {
        const next = { ...prev };
        delete next[pageKey];
        return next;
      }
      return {
        ...prev,
        [pageKey]: { pageKey, canView: true, canEdit: false, canDelete: false },
      };
    });
  };

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
    // 只上小程序的角色（维修工、保安…）本来就不该进后台，零页面权限是正常配置；
    // 只上小程序的角色（维修工、保安…）本来就不该进后台，网站页面一个不勾是正常的；
    // 没选类型又一个网站页面都不勾，才是真的配错了
    if (!permissions.length && !v.businessRole) {
      message.warning('纯后台角色至少要勾一个网站页面，或先选一个角色类型');
      return;
    }
    if (v.businessRole && !permissions.some((p) => isStaffAppPageKey(p.pageKey))) {
      message.warning('这个角色在小程序里一格入口都没有，他登进去只有「我的」页');
    }
    setSaving(true);
    try {
      const data = {
        name: v.name,
        remark: v.remark || undefined,
        businessRole: v.businessRole || null,
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
      title={target ? `编辑业务角色「${target.name}」` : '新建业务角色'}
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
            <Input placeholder="如：枫桦景苑维修工、管理处主任、客服专员" />
          </Form.Item>
          <Form.Item name="enabled" label="启用" valuePropName="checked" style={{ width: 80 }}>
            <Switch />
          </Form.Item>
        </Space.Compact>
        <Form.Item name="remark" label="备注（选填）">
          <Input placeholder="给同事看的说明" maxLength={100} />
        </Form.Item>

        <Form.Item
          name="businessRole"
          label="角色类型（决定工作流）"
          extra={
            identityHint[businessRole] ??
            '纯后台角色：不上小程序，只用来给网站页面授权（比如只看报表的财务）。'
          }
        >
          <Select
            options={identityOptions}
            onChange={(v) => {
              applyIdentityPreset(v, businessRole);
              setBusinessRole(v);
            }}
            {...searchableWideSelectProps}
          />
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

        <Form.Item label="页面权限" required style={{ marginBottom: 0 }}>
          <Tabs
            size="small"
            items={[
              {
                key: 'web',
                label: `Web 页面权限${countOf(perms, false) ? `（${countOf(perms, false)}）` : ''}`,
                children: (
                  <PermGroup
                    rows={pages.map((p) => ({
                      key: p.key,
                      label: p.label,
                      hint: p.group,
                      actions: [
                        { field: 'canEdit', label: '编辑（含新增）' },
                        { field: 'canDelete', label: '删除' },
                      ],
                    }))}
                    empty="这家公司没有开通任何后台页面"
                    note="勾中的页面才会出现在他的后台菜单里；展开后可以再细分能不能改、能不能删。只用小程序的角色（维修工、保安…）这里可以一个都不勾。"
                    perms={perms}
                    onToggle={togglePage}
                    onAction={setPerm}
                  />
                ),
              },
              {
                key: 'app',
                label: `邻修小程序页面权限${countOf(perms, true) ? `（${countOf(perms, true)}）` : ''}`,
                children: (
                  <PermGroup
                    rows={STAFF_APP_PAGES.map((p) => ({
                      key: p.key,
                      label: p.label,
                      hint: p.hint,
                      actions: p.editLabel
                        ? [{ field: 'canEdit', label: p.editLabel, hint: p.editHint }]
                        : [],
                    }))}
                    empty=""
                    note="勾中的入口才会出现在他小程序的底部；展开后可以再决定他只能看还是能动手。小程序里没有删除动作，所以这一档只在 Web 页面上有。"
                    perms={perms}
                    onToggle={togglePage}
                    onAction={setPerm}
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

/** 当前勾选是不是原封不动的某份推荐组合（用来判断「管理员有没有手工动过」） */
function matchesPreset(
  current: RolePermRow[],
  preset: Record<string, 'v' | 'e'>,
) {
  const keys = Object.keys(preset);
  if (current.length !== keys.length) return false;
  return current.every((p) => {
    const level = preset[p.pageKey];
    return !!level && p.canEdit === (level === 'e');
  });
}

/** 页签标题上的「已勾几个」计数 */
function countOf(perms: Record<string, RolePermRow>, app: boolean) {
  return Object.values(perms).filter(
    (p) => p.canView && isStaffAppPageKey(p.pageKey) === app,
  ).length;
}

interface PermRowDef {
  key: string;
  label: string;
  hint?: string;
  /** 展开后能再细分的动作；空数组 = 这一页只有「看」 */
  actions: { field: 'canEdit' | 'canDelete'; label: string; hint?: string }[];
}

/**
 * 一组页面的勾选区：一行一个页面，勾中后就地展开它下面的细分权限。
 *
 * 为什么不用表格：整片三列复选框看上去每一格都要决策，实际上绝大多数页面
 * 只需要「给 / 不给」。先给一个是非题，需要再细分的人才往下看一层。
 */
function PermGroup({
  rows, perms, note, empty, onToggle, onAction,
}: {
  rows: PermRowDef[];
  perms: Record<string, RolePermRow>;
  note: string;
  empty: string;
  onToggle: (key: string, on: boolean) => void;
  onAction: (key: string, patch: Partial<RolePermRow>) => void;
}) {
  if (!rows.length) return <Text type="secondary">{empty}</Text>;
  return (
    <div>
      <Text type="secondary" style={{ display: 'block', marginBottom: 12, lineHeight: 1.6 }}>
        {note}
      </Text>
      <div style={{ border: '1px solid #f0f0f0', borderRadius: 8 }}>
        {rows.map((row, i) => {
          const cur = perms[row.key];
          const on = !!cur?.canView;
          return (
            <div
              key={row.key}
              style={{
                padding: '12px 16px',
                borderTop: i ? '1px solid #f5f5f5' : undefined,
                background: on ? '#fafcff' : undefined,
              }}
            >
              <Checkbox
                checked={on}
                onChange={(e) => onToggle(row.key, e.target.checked)}
              >
                <span style={{ fontWeight: on ? 600 : 400 }}>{row.label}</span>
                {row.hint && (
                  <Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
                    {row.hint}
                  </Text>
                )}
              </Checkbox>
              {on && (
                <div style={{ margin: '8px 0 0 24px', display: 'flex', gap: 24, flexWrap: 'wrap' }}>
                  <Checkbox checked disabled>
                    <Text type="secondary">查看（勾中即可见）</Text>
                  </Checkbox>
                  {row.actions.map((a) => (
                    <Checkbox
                      key={a.field}
                      checked={!!cur?.[a.field]}
                      onChange={(e) => onAction(row.key, { [a.field]: e.target.checked })}
                    >
                      {a.label}
                      {a.hint && (
                        <Text type="secondary" style={{ fontSize: 12, marginLeft: 6 }}>
                          {a.hint}
                        </Text>
                      )}
                    </Checkbox>
                  ))}
                  {!row.actions.length && (
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      这一页只有查看，没有可分的操作权
                    </Text>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
