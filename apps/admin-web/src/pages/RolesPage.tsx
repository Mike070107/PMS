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
  ALWAYS_ENABLED_PAGES,
  DEFAULT_ROLE_TEMPLATES,
  ROLE_DATA_SCOPE_LABELS,
  RoleDataScope,
  STAFF_APP_PAGES,
  WAREHOUSE_TYPE_LABELS,
  WarehouseType,
  isStaffAppPageKey,
} from '@pms/shared-types';
import { request } from '../lib/api';
import { handleGone } from '../lib/gone';
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
  /** 生效中的页面权限：跟随模板的角色，这里返回的是模板那一份 */
  permissions: RolePermRow[];
  /** 跟随的权限模板；null = 自定义（权限存在角色自己身上） */
  templateId: number | null;
  templateName: string | null;
  officeIds: number[];
  communityIds: number[];
  /** 额外可见的仓库（数据范围之外点名给的，主要是总仓） */
  warehouseIds: number[];
}

interface TemplateRow {
  id: number;
  name: string;
  remark: string | null;
  permissions: RolePermRow[];
  /** 正在跟随这个模板的角色，改模板前的影响面 */
  roles: { id: number; name: string }[];
}

interface ScopeOptions {
  offices: { id: number; name: string; enabled: boolean }[];
  communities: { id: number; name: string; officeId: number | null }[];
  warehouses: { id: number; name: string; type: string; officeName: string | null }[];
}

export default function RolesPage() {
  const { message } = AntdApp.useApp();
  const { canEdit, canDelete } = usePagePerm('roles');
  const { access } = useAuth();
  const isTenantAdmin = !access || access.isTenantAdmin || access.isPlatformAdmin;
  const [rows, setRows] = useState<RoleRow[]>([]);
  const [templates, setTemplates] = useState<TemplateRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<RoleRow | null>(null);
  const [creating, setCreating] = useState(false);
  const [savingAsTemplate, setSavingAsTemplate] = useState<RoleRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [roleRows, tplRows] = await Promise.all([
        request<RoleRow[]>({ url: '/roles' }),
        request<TemplateRow[]>({ url: '/roles/templates' }),
      ]);
      setRows(roleRows);
      setTemplates(tplRows);
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
      if (handleGone(e, message, '这个角色', load)) return;
      message.error(e?.message || '删除失败');
    }
  };

  const mayWrite = canEdit && isTenantAdmin;

  const rolesCard = (
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
                        {r.templateName && (
                          <div style={{ marginBottom: 4 }}>
                            <Tag color="blue">跟随模板 · {r.templateName}</Tag>
                          </div>
                        )}
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
                  title: '操作', key: 'op', width: 200,
                  render: (_, r) => (
                    <Space size={0} wrap>
                      {mayWrite && !r.builtIn && (
                        <Button type="link" size="small" onClick={() => setEditing(r)}>编辑</Button>
                      )}
                      {/* 已经配好的角色一键变模板：其它同类角色勾一下就跟上，不用重勾一遍 */}
                      {mayWrite && !r.builtIn && !r.templateId && (
                        <Button
                          type="link"
                          size="small"
                          onClick={() => setSavingAsTemplate(r)}
                        >
                          存为模板
                        </Button>
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
  );

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
      <Tabs
        defaultActiveKey="roles"
        items={[
          { key: 'roles', label: `业务角色（${rows.length}）`, children: rolesCard },
          {
            key: 'templates',
            label: `权限模板（${templates.length}）`,
            children: (
              <TemplatesTab
                templates={templates}
                loading={loading}
                mayWrite={mayWrite}
                mayDelete={canDelete && isTenantAdmin}
                onChanged={load}
              />
            ),
          },
        ]}
      />

      <RoleFormModal
        open={creating || !!editing}
        target={editing}
        templates={templates}
        onClose={() => { setCreating(false); setEditing(null); }}
        onDone={() => { setCreating(false); setEditing(null); load(); }}
      />
      <SaveAsTemplateModal
        role={savingAsTemplate}
        onClose={() => setSavingAsTemplate(null)}
        onDone={() => { setSavingAsTemplate(null); load(); }}
      />
    </div>
  );
}

/**
 * 把一个配好的角色另存为模板，并让它改成跟随。
 * 权限一模一样，所以这个角色本身不会有任何变化 —— 变的是从此以后改模板它会跟着变，
 * 别的同类角色也能一勾跟上。这是从「一个个重勾」过渡到模板的最短路径。
 */
function SaveAsTemplateModal({
  role, onClose, onDone,
}: {
  role: RoleRow | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!role) return;
    // 「枫桦景苑物业办公室」→ 默认模板名「物业办公室」：模板是跨小区共用的，
    // 名字里带小区名会让人以为它只能给那个小区用
    const guess = role.name.replace(/^.*?(物业|社区|小区)?(办公室|经理|维修工|保安|客服|主管)$/, '$1$2');
    form.setFieldsValue({ name: guess || role.name, remark: role.remark ?? undefined });
  }, [role, form]);

  const onOk = async () => {
    const v = await form.validateFields();
    if (!role) return;
    setSaving(true);
    try {
      await request({
        method: 'POST',
        url: `/roles/${role.id}/save-as-template`,
        data: { name: v.name, remark: v.remark || undefined },
      });
      message.success('已存为模板，这个角色改成跟随它了（权限没有变化）');
      onDone();
    } catch (e: any) {
      message.error(e?.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={role ? `把「${role.name}」的权限存成模板` : ''}
      open={!!role}
      onCancel={onClose}
      onOk={onOk}
      confirmLoading={saving}
      destroyOnHidden
      okText="存为模板"
      width={520}
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="这个角色的权限一格都不会变"
        description="变的只是权限从此以后由模板统一管：改模板，所有跟随它的角色一起变。其它同类角色在编辑里把「页面权限来源」选成这个模板即可，不用再重勾一遍。"
      />
      <Form form={form} layout="vertical">
        <Form.Item
          name="name"
          label="模板名称"
          rules={[{ required: true, message: '请填写模板名称' }]}
          extra="建议不带小区名 —— 模板是几个小区共用的，数据范围仍然由各角色自己配"
        >
          <Input placeholder="如：物业办公室" maxLength={60} />
        </Form.Item>
        <Form.Item name="remark" label="备注（选填）">
          <Input placeholder="给同事看的说明" maxLength={100} />
        </Form.Item>
      </Form>
    </Modal>
  );
}

function RoleFormModal({
  open, target, templates, onClose, onDone,
}: {
  open: boolean;
  target?: RoleRow | null;
  templates: TemplateRow[];
  onClose: () => void;
  onDone: () => void;
}) {
  const { message } = AntdApp.useApp();
  const { access } = useAuth();
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const [dataScope, setDataScope] = useState<string>(RoleDataScope.ALL);
  const [scopeOptions, setScopeOptions] = useState<ScopeOptions>({ offices: [], communities: [], warehouses: [] });
  const [perms, setPerms] = useState<Record<string, RolePermRow>>({});
  /** 跟随的权限模板 id；undefined = 自定义（勾选存在这个角色自己身上） */
  const [templateId, setTemplateId] = useState<number | undefined>(undefined);
  const followed = templates.find((t) => t.id === templateId) ?? null;
  /** 跟随模板时矩阵展示模板那份勾选（只读），自定义时展示自己的 */
  const shownPerms = followed
    ? Object.fromEntries(followed.permissions.map((p) => [p.pageKey, { ...p }]))
    : perms;

  // 公司没开通的页面不出现在矩阵里
  const pages = useMemo(
    () =>
      ADMIN_PAGES.filter(
        (p) =>
          !access?.enabledPages ||
          access.enabledPages.includes(p.key) ||
          ALWAYS_ENABLED_PAGES.includes(p.key),
      ),
    [access?.enabledPages],
  );

  useEffect(() => {
    if (!open) return;
    request<ScopeOptions>({ url: '/roles/scope-options' })
      .then(setScopeOptions)
      .catch(() => setScopeOptions({ offices: [], communities: [], warehouses: [] }));
    if (target) {
      form.setFieldsValue({
        name: target.name,
        remark: target.remark ?? undefined,
        dataScope: target.dataScope,
        officeIds: target.officeIds,
        communityIds: target.communityIds,
        warehouseIds: target.warehouseIds ?? [],
        enabled: target.enabled,
      });
      setDataScope(target.dataScope);
      setTemplateId(target.templateId ?? undefined);
      // 跟随模板的角色，这里存的是模板那份 —— 解绑成「自定义」时正好当起点，
      // 不会一解绑就变成一格都没有
      setPerms(Object.fromEntries(target.permissions.map((p) => [p.pageKey, { ...p }])));
    } else {
      form.resetFields();
      form.setFieldsValue({ dataScope: RoleDataScope.ALL, enabled: true });
      setDataScope(RoleDataScope.ALL);
      setTemplateId(undefined);
      setPerms({});
    }
  }, [open, target, form]);

  /**
   * 新建角色时按名字套一份现成的勾选（输入「维修工」就把维修工那套先勾上）。
   *
   * 只在一格都没勾的时候套，套完随便改 —— 纯粹是省得从零一个个点。
   * 建完角色发现小程序空空如也，是这套东西最容易踩的坑。
   */
  const applyTemplateByName = (name: string) => {
    const tpl = DEFAULT_ROLE_TEMPLATES.find((t) => t.name === name.trim());
    if (!tpl) return;
    setPerms((prev) => {
      if (Object.values(prev).some((p) => p.canView)) return prev;
      const next: Record<string, RolePermRow> = {};
      Object.entries({ ...tpl.appPages, ...(tpl.adminPages ?? {}) }).forEach(
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
    // 跟随模板时权限由模板给，这个角色不送也不存勾选
    const permissions = followed ? [] : Object.values(perms).filter((p) => p.canView);
    if (!followed) {
    // 只上小程序的角色（维修工、保安…）本来就不该进后台，零页面权限是正常配置；
    // 只上小程序的角色（维修工、保安…）本来就不该进后台，网站页面一个不勾是正常的；
    // 没选类型又一个网站页面都不勾，才是真的配错了
      if (!permissions.length) {
        message.warning('至少勾一个页面 —— 一格都不勾，绑这个角色的人什么也打不开');
        return;
      }
      if (!permissions.some((p) => isStaffAppPageKey(p.pageKey))) {
        message.warning('这个角色在小程序里一格入口都没有，绑它的人登进去只有「我的」页');
      }
    }
    setSaving(true);
    try {
      const data = {
        name: v.name,
        remark: v.remark || undefined,
        dataScope: v.dataScope,
        officeIds: v.dataScope === RoleDataScope.OFFICES ? v.officeIds : undefined,
        communityIds: v.dataScope === RoleDataScope.COMMUNITIES ? v.communityIds : undefined,
        warehouseIds: v.warehouseIds ?? [],
        enabled: v.enabled,
        templateId: templateId ?? null,
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
      if (target && handleGone(e, message, '这个角色', onDone)) return;
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
            <Input
              placeholder="如：枫桦景苑维修工、枫桦景苑物业经理、客服专员"
              onBlur={(e) => applyTemplateByName(e.target.value)}
            />
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
        {dataScope !== RoleDataScope.ALL && (
          <Form.Item
            name="warehouseIds"
            label="额外可见的仓库"
            extra="数据范围只圈得到管理处和小区，总仓不挂任何管理处。要让这个角色用某个总仓（看库存、领料、调拨），在这里点名。留空 = 只看数据范围内的仓。"
          >
            <Select
              mode="multiple"
              allowClear
              placeholder="留空即可，需要用总仓时才选"
              options={withOptionTitles(
                scopeOptions.warehouses.map((w) => ({
                  value: w.id,
                  label: `${w.name} · ${WAREHOUSE_TYPE_LABELS[w.type as WarehouseType] || w.type}${w.officeName ? ' · ' + w.officeName : ''}`,
                })),
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

        <Form.Item label="页面权限来源" style={{ marginBottom: 12 }}>
          <Select
            value={templateId ?? 0}
            onChange={(v) => setTemplateId(v || undefined)}
            style={{ width: '100%' }}
            options={withOptionTitles([
              { value: 0, label: '自定义（这个角色自己勾）' },
              ...templates.map((t) => ({
                value: t.id,
                label: `跟随模板：${t.name}${t.remark ? ` · ${t.remark}` : ''}`,
              })),
            ])}
            {...searchableWideSelectProps}
          />
          {followed ? (
            <Alert
              type="info"
              showIcon
              style={{ marginTop: 8 }}
              message={`权限跟着模板「${followed.name}」走，这里只能看`}
              description="以后改那个模板，所有跟随它的角色一起变；这个角色只需要配上面的数据范围。要单独调整就先改回「自定义」（当前这份勾选会原样留下）。"
            />
          ) : (
            !!templates.length && (
              <Text type="secondary" style={{ display: 'block', marginTop: 6, fontSize: 12, lineHeight: 1.6 }}>
                几个管理处的同一类角色，选同一个模板：以后改权限只改模板一处，不会漏掉谁。
              </Text>
            )
          )}
        </Form.Item>

        <Form.Item label="页面权限" required style={{ marginBottom: 0 }}>
          <Tabs
            size="small"
            items={[
              {
                key: 'web',
                label: `Web 页面权限${countOf(shownPerms, false) ? `（${countOf(shownPerms, false)}）` : ''}`,
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
                    perms={shownPerms}
                    readOnly={!!followed}
                    onToggle={togglePage}
                    onAction={setPerm}
                  />
                ),
              },
              {
                key: 'app',
                label: `邻修小程序页面权限${countOf(shownPerms, true) ? `（${countOf(shownPerms, true)}）` : ''}`,
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
                    perms={shownPerms}
                    readOnly={!!followed}
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
  rows, perms, note, empty, readOnly, onToggle, onAction,
}: {
  rows: PermRowDef[];
  perms: Record<string, RolePermRow>;
  note: string;
  empty: string;
  /** 跟随模板时整片只读：勾选在模板那边改，这里改了也存不下去 */
  readOnly?: boolean;
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
                disabled={readOnly}
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
                      disabled={readOnly}
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

// ============= 权限模板 =============

/**
 * 权限模板列表。
 *
 * 为什么要有它：几个管理处的「物业办公室」权限完全一样，只是数据范围不同。
 * 没有模板时每建一个都要把整片勾选重来一遍（会漏），之后要改一格权限得进
 * 每个角色改一遍（更会漏）。模板只管权限，数据范围仍由各角色自己配。
 */
function TemplatesTab({
  templates, loading, mayWrite, mayDelete, onChanged,
}: {
  templates: TemplateRow[];
  loading: boolean;
  mayWrite: boolean;
  mayDelete: boolean;
  onChanged: () => void;
}) {
  const { message } = AntdApp.useApp();
  const [editing, setEditing] = useState<TemplateRow | null>(null);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);

  const importBuiltIn = async () => {
    setImporting(true);
    try {
      const r = await request<{ created: string[]; skipped: number }>({
        method: 'POST',
        url: '/roles/templates/import-built-in',
      });
      message.success(
        r.created.length
          ? `已导入 ${r.created.length} 个：${r.created.join('、')}`
          : '这几个开箱模板都已经有了，没有重复导入',
      );
      onChanged();
    } catch (e: any) {
      message.error(e?.message || '导入失败');
    } finally {
      setImporting(false);
    }
  };

  const remove = async (t: TemplateRow) => {
    try {
      await request({ method: 'DELETE', url: `/roles/templates/${t.id}` });
      message.success('已删除');
      onChanged();
    } catch (e: any) {
      if (handleGone(e, message, '这个模板', onChanged)) return;
      message.error(e?.message || '删除失败');
    }
  };

  return (
    <>
      <Card
        title="模板只管「能进哪些页面」；数据范围留给每个角色自己配 —— 改一次模板，所有跟随它的角色一起变"
        extra={
          mayWrite && (
            <Space>
              <Button loading={importing} onClick={importBuiltIn}>
                导入开箱模板
              </Button>
              <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>
                新建模板
              </Button>
            </Space>
          )
        }
      >
        <Table<TemplateRow>
          rowKey="id"
          size="middle"
          loading={loading}
          dataSource={templates}
          pagination={false}
          locale={{
            emptyText:
              '还没有权限模板。可以点右上角「导入开箱模板」，或者在「业务角色」里把一个配好的角色「存为模板」',
          }}
          columns={[
            {
              title: '模板', dataIndex: 'name', width: 180,
              render: (v: string) => <span style={{ fontWeight: 600 }}>{v}</span>,
            },
            {
              title: '包含的权限', dataIndex: 'permissions',
              render: (perms: RolePermRow[]) => {
                const visible = perms.filter((p) => p.canView);
                if (!visible.length) return <Text type="secondary">未配置</Text>;
                const app = visible.filter((p) => isStaffAppPageKey(p.pageKey));
                const admin = visible.filter((p) => !isStaffAppPageKey(p.pageKey));
                const row = (label: string, list: RolePermRow[], find: (k: string) => string) =>
                  list.length ? (
                    <div style={{ marginBottom: 2 }}>
                      <Text type="secondary" style={{ fontSize: 12, marginRight: 6 }}>{label}</Text>
                      {list.map((p) => {
                        const marks = [p.canEdit && '改', p.canDelete && '删'].filter(Boolean).join('');
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
                    {row('小程序', app, (k) => STAFF_APP_PAGES.find((x) => x.key === k)?.label ?? k)}
                    {row('后台', admin, (k) => ADMIN_PAGES.find((x) => x.key === k)?.label ?? k)}
                  </>
                );
              },
            },
            {
              title: '跟随的角色', dataIndex: 'roles', width: 240,
              render: (roles: TemplateRow['roles']) =>
                roles.length ? (
                  <Space size={4} wrap>
                    {roles.map((r) => <Tag key={r.id} color="blue">{r.name}</Tag>)}
                  </Space>
                ) : (
                  <Text type="secondary">还没有角色跟随</Text>
                ),
            },
            { title: '备注', dataIndex: 'remark', width: 160, render: (v) => v || '-' },
            {
              title: '操作', key: 'op', width: 120,
              render: (_, t) => (
                <Space size={0}>
                  {mayWrite && (
                    <Button type="link" size="small" onClick={() => setEditing(t)}>编辑</Button>
                  )}
                  {mayDelete && (
                    <Popconfirm
                      title="删除这个模板？"
                      description={
                        t.roles.length
                          ? `还有 ${t.roles.length} 个角色在跟随，需先改成自定义或换模板。`
                          : '删除后不影响任何角色。'
                      }
                      okText="删除"
                      okButtonProps={{ danger: true }}
                      cancelText="取消"
                      onConfirm={() => remove(t)}
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

      <TemplateFormModal
        open={creating || !!editing}
        target={editing}
        onClose={() => { setCreating(false); setEditing(null); }}
        onDone={() => { setCreating(false); setEditing(null); onChanged(); }}
      />
    </>
  );
}

function TemplateFormModal({
  open, target, onClose, onDone,
}: {
  open: boolean;
  target?: TemplateRow | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const { message } = AntdApp.useApp();
  const { access } = useAuth();
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const [perms, setPerms] = useState<Record<string, RolePermRow>>({});

  const pages = useMemo(
    () =>
      ADMIN_PAGES.filter(
        (p) =>
          !access?.enabledPages ||
          access.enabledPages.includes(p.key) ||
          ALWAYS_ENABLED_PAGES.includes(p.key),
      ),
    [access?.enabledPages],
  );

  useEffect(() => {
    if (!open) return;
    if (target) {
      form.setFieldsValue({ name: target.name, remark: target.remark ?? undefined });
      setPerms(Object.fromEntries(target.permissions.map((p) => [p.pageKey, { ...p }])));
    } else {
      form.resetFields();
      setPerms({});
    }
  }, [open, target, form]);

  const togglePage = (pageKey: string, on: boolean) => {
    setPerms((prev) => {
      if (!on) {
        const next = { ...prev };
        delete next[pageKey];
        return next;
      }
      return { ...prev, [pageKey]: { pageKey, canView: true, canEdit: false, canDelete: false } };
    });
  };

  const setPerm = (pageKey: string, patch: Partial<RolePermRow>) => {
    setPerms((prev) => {
      const cur = prev[pageKey] ?? { pageKey, canView: false, canEdit: false, canDelete: false };
      const next = { ...cur, ...patch };
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
      message.warning('至少勾一个页面 —— 空模板套上去的角色什么也打不开');
      return;
    }
    setSaving(true);
    try {
      const data = { name: v.name, remark: v.remark || undefined, permissions };
      if (target) {
        await request({ method: 'PATCH', url: `/roles/templates/${target.id}`, data });
      } else {
        await request({ method: 'POST', url: '/roles/templates', data });
      }
      message.success(
        target?.roles.length
          ? `已保存，${target.roles.length} 个跟随它的角色立即生效`
          : '已保存',
      );
      onDone();
    } catch (e: any) {
      if (target && handleGone(e, message, '这个模板', onDone)) return;
      message.error(e?.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={target ? `编辑权限模板「${target.name}」` : '新建权限模板'}
      open={open}
      onCancel={onClose}
      onOk={onOk}
      confirmLoading={saving}
      destroyOnHidden
      width={680}
    >
      {!!target?.roles.length && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message={`保存后这 ${target.roles.length} 个角色的权限会立刻跟着变`}
          description={target.roles.map((r) => r.name).join('、')}
        />
      )}
      <Form form={form} layout="vertical">
        <Form.Item
          name="name"
          label="模板名称"
          rules={[{ required: true, message: '请填写模板名称' }]}
          extra="建议不带小区名 —— 模板是几个小区共用的，数据范围由各角色自己配"
        >
          <Input placeholder="如：物业办公室" maxLength={60} />
        </Form.Item>
        <Form.Item name="remark" label="备注（选填）">
          <Input placeholder="给同事看的说明" maxLength={100} />
        </Form.Item>
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
                    note="勾中的页面才会出现在跟随这个模板的人的后台菜单里。"
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
                    note="勾中的入口才会出现在他们小程序的底部。小程序里没有删除动作，所以这一档只在 Web 页面上有。"
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
