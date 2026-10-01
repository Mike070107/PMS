import {
  Alert,
  App as AntdApp,
  Button,
  Form,
  Input,
  Modal,
  Select,
  Skeleton,
  Switch,
  Tooltip,
} from 'antd';
import {
  ApiOutlined,
  AppstoreOutlined,
  BankOutlined,
  CheckCircleFilled,
  ClockCircleOutlined,
  CloudServerOutlined,
  CloudSyncOutlined,
  EditOutlined,
  ExclamationCircleFilled,
  ExportOutlined,
  GlobalOutlined,
  LinkOutlined,
  LockOutlined,
  PauseCircleFilled,
  PlusOutlined,
  ReloadOutlined,
  SafetyCertificateFilled,
  TeamOutlined,
} from '@ant-design/icons';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { request } from '../lib/api';
import { usePagePerm } from '../lib/auth';
import './ExternalAccessPage.css';

interface ExternalApp {
  id: number;
  name: string;
  slug: string;
  publicHostname: string;
  originUrl: string;
  entryPath: string;
  sessionDuration: string;
  enabled: boolean;
  userIds: number[];
  lastSyncedAt?: string | null;
  lastSyncError?: string | null;
}

interface UserOption {
  id: number;
  name?: string | null;
  phone?: string | null;
  status: 'active' | 'disabled';
  wxBound: boolean;
}

const maskPhone = (phone?: string | null) =>
  phone && phone.length >= 7 ? `${phone.slice(0, 3)}****${phone.slice(-4)}` : phone || '未登记手机号';

const previewApps: ExternalApp[] = [
  {
    id: 1,
    name: '用友财务系统',
    slug: 'caiwu',
    publicHostname: 'caiwu.prsznh.cn',
    originUrl: 'http://192.168.10.20:8080',
    entryPath: '/tplus/view/login.html',
    sessionDuration: '8h',
    enabled: true,
    userIds: [101, 102, 103],
    lastSyncedAt: new Date().toISOString(),
  },
  {
    id: 2,
    name: '仓库报表',
    slug: 'warehouse-report',
    publicHostname: 'warehouse.prsznh.cn',
    originUrl: 'http://192.168.20.15:3000',
    entryPath: '/',
    sessionDuration: '4h',
    enabled: true,
    userIds: [101],
    lastSyncError: 'Cloudflare Tunnel 当前没有在线连接器，请在目标局域网启动 cloudflared 后再同步。',
  },
];

const previewUsers: UserOption[] = [
  { id: 101, name: '王会计', phone: '13800138001', status: 'active', wxBound: true },
  { id: 102, name: '李出纳', phone: '13800138002', status: 'active', wxBound: true },
  { id: 103, name: '陈经理', phone: '13800138003', status: 'active', wxBound: false },
];

type AppState = 'disabled' | 'error' | 'synced' | 'pending';

const getAppState = (app: ExternalApp): AppState => {
  if (!app.enabled) return 'disabled';
  if (app.lastSyncError) return 'error';
  if (app.lastSyncedAt) return 'synced';
  return 'pending';
};

const stateMeta: Record<AppState, { label: string; icon: React.ReactNode }> = {
  disabled: { label: '已停用', icon: <PauseCircleFilled /> },
  error: { label: '需处理', icon: <ExclamationCircleFilled /> },
  synced: { label: '已同步', icon: <CheckCircleFilled /> },
  pending: { label: '待同步', icon: <ClockCircleOutlined /> },
};

const launchUrl = (app: Pick<ExternalApp, 'publicHostname' | 'entryPath'>) =>
  `https://${app.publicHostname}${app.entryPath || '/'}`;

const originEntryUrl = (app: Pick<ExternalApp, 'originUrl' | 'entryPath'>) =>
  `${app.originUrl}${app.entryPath === '/' ? '' : app.entryPath || ''}`;

export default function ExternalAccessPage({ preview = false }: { preview?: boolean }) {
  const { message } = AntdApp.useApp();
  const { canEdit } = usePagePerm('settings');
  const [apps, setApps] = useState<ExternalApp[]>(preview ? previewApps : []);
  const [users, setUsers] = useState<UserOption[]>(preview ? previewUsers : []);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<ExternalApp | null>(null);
  const [creating, setCreating] = useState(false);
  const [syncingId, setSyncingId] = useState<number | null>(null);

  const load = useCallback(async () => {
    if (preview) return;
    setLoading(true);
    try {
      const [appRows, userRows] = await Promise.all([
        request<ExternalApp[]>({ url: '/external-access/apps' }),
        request<UserOption[]>({ url: '/external-access/users' }),
      ]);
      setApps(appRows);
      setUsers(userRows);
    } catch (error: any) {
      message.error(error?.message || '加载内网应用失败');
    } finally {
      setLoading(false);
    }
  }, [message, preview]);

  useEffect(() => { load(); }, [load]);

  const summary = useMemo(() => {
    const authorizedUsers = new Set(apps.flatMap((app) => app.userIds));
    return {
      total: apps.length,
      synced: apps.filter((app) => getAppState(app) === 'synced').length,
      users: authorizedUsers.size,
      attention: apps.filter((app) => getAppState(app) === 'error').length,
    };
  }, [apps]);

  const sync = async (app: ExternalApp) => {
    if (preview) {
      message.info('视觉预览不会修改 Cloudflare 配置');
      return;
    }
    setSyncingId(app.id);
    try {
      await request({ method: 'POST', url: `/external-access/apps/${app.id}/sync` });
      message.success(`「${app.name}」已同步到 Cloudflare`);
      load();
    } catch (error: any) {
      message.error(error?.message || '同步失败');
      load();
    } finally {
      setSyncingId(null);
    }
  };

  return (
    <main className="external-access-page">
      {preview && (
        <Alert
          className="external-access-preview"
          type="info"
          showIcon
          message="视觉预览 · 演示数据"
          description="页面不会连接 PMS API，也不会修改 Cloudflare。"
        />
      )}

      <section className="external-access-hero" aria-labelledby="external-access-title">
        <div className="external-access-hero__copy">
          <span className="external-access-eyebrow">
            <SafetyCertificateFilled aria-hidden="true" /> ZERO TRUST GATEWAY
          </span>
          <h1 id="external-access-title">内网应用发布</h1>
          <p>一次配置，微信授权后直达业务系统。</p>
          <div className="external-access-hero__actions">
            {canEdit && (
              <Button type="primary" size="large" icon={<PlusOutlined />} onClick={() => setCreating(true)}>
                新增应用
              </Button>
            )}
            <Tooltip title="刷新应用状态">
              <Button
                className="external-access-icon-button external-access-hero__refresh"
                size="large"
                icon={<ReloadOutlined />}
                loading={loading}
                onClick={load}
                aria-label="刷新应用状态"
              />
            </Tooltip>
          </div>
        </div>

        <div className="external-access-flow" aria-label="安全访问链路：公网访问、微信授权、内网应用">
          <div className="external-access-flow__node external-access-flow__node--public"><GlobalOutlined aria-hidden="true" /><span>公网</span></div>
          <span className="external-access-flow__line" aria-hidden="true" />
          <div className="external-access-flow__node external-access-flow__node--access"><LockOutlined aria-hidden="true" /><span>授权</span></div>
          <span className="external-access-flow__line" aria-hidden="true" />
          <div className="external-access-flow__node external-access-flow__node--origin"><CloudServerOutlined aria-hidden="true" /><span>内网</span></div>
        </div>

        <div className="external-access-metrics" aria-label="发布概览">
          <Metric icon={<AppstoreOutlined />} value={summary.total} label="应用" tone="blue" />
          <Metric icon={<CheckCircleFilled />} value={summary.synced} label="在线" tone="green" />
          <Metric icon={<TeamOutlined />} value={summary.users} label="授权" tone="violet" />
          <Metric icon={<ExclamationCircleFilled />} value={summary.attention} label="待处理" tone="amber" />
        </div>
      </section>

      <section className="external-access-section" aria-labelledby="external-access-apps-title">
        <div className="external-access-section__head">
          <div>
            <span className="external-access-section__icon"><ApiOutlined aria-hidden="true" /></span>
            <div><h2 id="external-access-apps-title">发布清单</h2><p>Cloudflare Access · Tunnel · DNS</p></div>
          </div>
          <span className="external-access-section__count">{apps.length}</span>
        </div>

        {loading && apps.length === 0 ? (
          <div className="external-access-grid" aria-label="正在加载应用"><SkeletonCard /><SkeletonCard /></div>
        ) : apps.length === 0 ? (
          <div className="external-access-empty">
            <span><CloudServerOutlined aria-hidden="true" /></span>
            <h3>还没有内网应用</h3>
            <p>添加第一条发布配置，即可从外网安全访问。</p>
            {canEdit && <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>新增应用</Button>}
          </div>
        ) : (
          <div className="external-access-grid">
            {apps.map((app, index) => (
              <ExternalAppCard
                key={app.id}
                app={app}
                index={index}
                canEdit={canEdit}
                syncing={syncingId === app.id}
                onEdit={() => setEditing(app)}
                onSync={() => sync(app)}
              />
            ))}
          </div>
        )}
      </section>

      <ExternalAppModal open={creating} users={users} preview={preview} onClose={() => setCreating(false)} onDone={() => { setCreating(false); load(); }} />
      <ExternalAppModal open={!!editing} target={editing} users={users} preview={preview} onClose={() => setEditing(null)} onDone={() => { setEditing(null); load(); }} />
    </main>
  );
}

function Metric({ icon, value, label, tone }: { icon: React.ReactNode; value: number; label: string; tone: 'blue' | 'green' | 'violet' | 'amber' }) {
  return <div className={`external-access-metric external-access-metric--${tone}`}><span className="external-access-metric__icon" aria-hidden="true">{icon}</span><strong>{value}</strong><small>{label}</small></div>;
}

function ExternalAppCard({ app, index, canEdit, syncing, onEdit, onSync }: { app: ExternalApp; index: number; canEdit: boolean; syncing: boolean; onEdit: () => void; onSync: () => void }) {
  const state = getAppState(app);
  const status = stateMeta[state];
  const isFinanceApp = /财务|用友|会计|资金/.test(app.name);
  const tone = ['teal', 'blue', 'violet', 'amber'][index % 4];

  return (
    <article className={`external-app-card external-app-card--${tone}`} style={{ '--card-index': index } as React.CSSProperties}>
      <div className="external-app-card__topline" aria-hidden="true" />
      <header className="external-app-card__head">
        <span className="external-app-card__logo" aria-hidden="true">{isFinanceApp ? <BankOutlined /> : <AppstoreOutlined />}</span>
        <div className="external-app-card__title">
          <h3>{app.name}</h3>
          <a href={launchUrl(app)} target="_blank" rel="noreferrer"><span>{app.publicHostname}</span><ExportOutlined aria-hidden="true" /></a>
        </div>
        <span className={`external-app-status external-app-status--${state}`}>{status.icon}<span>{status.label}</span></span>
      </header>

      <div className="external-app-route" aria-label={`内网目标 ${originEntryUrl(app)}`}>
        <span className="external-app-route__icon"><CloudServerOutlined aria-hidden="true" /></span>
        <div><small>ORIGIN</small><code>{originEntryUrl(app)}</code></div>
        <span className="external-app-route__pulse" aria-hidden="true" />
      </div>

      {app.lastSyncError && <div className="external-app-error" role="status"><ExclamationCircleFilled aria-hidden="true" /><span>{app.lastSyncError}</span></div>}

      <footer className="external-app-card__foot">
        <div className="external-app-facts">
          <span><TeamOutlined aria-hidden="true" /><strong>{app.userIds.length}</strong> 人</span>
          <span><ClockCircleOutlined aria-hidden="true" /><strong>{app.sessionDuration}</strong></span>
        </div>
        <div className="external-app-actions">
          <Tooltip title={`打开 ${app.name}`}><Button type="text" shape="circle" icon={<ExportOutlined />} href={launchUrl(app)} target="_blank" disabled={!app.enabled} aria-label={`打开 ${app.name}`} /></Tooltip>
          {canEdit && <Tooltip title="编辑配置"><Button type="text" shape="circle" icon={<EditOutlined />} onClick={onEdit} aria-label={`编辑 ${app.name}`} /></Tooltip>}
          {canEdit && <Tooltip title="同步 Cloudflare"><Button className="external-app-actions__sync" type="primary" shape="circle" icon={<CloudSyncOutlined />} loading={syncing} onClick={onSync} aria-label={`同步 ${app.name} 到 Cloudflare`} /></Tooltip>}
        </div>
      </footer>
    </article>
  );
}

function SkeletonCard() {
  return <div className="external-app-card external-app-card--skeleton"><Skeleton active avatar paragraph={{ rows: 3 }} /></div>;
}

function ExternalAppModal({ open, target, users, preview, onClose, onDone }: { open: boolean; target?: ExternalApp | null; users: UserOption[]; preview: boolean; onClose: () => void; onDone: () => void }) {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (target) form.setFieldsValue({ ...target, originUrl: originEntryUrl(target) });
    else {
      form.resetFields();
      form.setFieldsValue({ enabled: true, sessionDuration: '8h', userIds: [] });
    }
  }, [open, target, form]);

  const save = async (values: Record<string, unknown>) => {
    if (preview) {
      message.info('视觉预览已校验表单，未发送配置');
      onDone();
      return;
    }
    setSaving(true);
    try {
      const saved = await request<ExternalApp>({ method: target ? 'PATCH' : 'POST', url: target ? `/external-access/apps/${target.id}` : '/external-access/apps', data: values });
      if (saved.lastSyncError) message.warning(`配置已保存，但 Cloudflare 同步失败：${saved.lastSyncError}`);
      else message.success(target ? '应用配置和授权已更新' : '内网应用已发布');
      onDone();
    } catch (error: any) {
      message.error(error?.message || '保存失败，填写内容已保留');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      className="external-access-modal"
      rootClassName="external-access-modal-root"
      title={<div className="external-access-modal__title"><span><CloudSyncOutlined aria-hidden="true" /></span><div><strong>{target ? '编辑发布配置' : '发布内网应用'}</strong><small>{target ? target.name : '安全连接公网与局域网'}</small></div></div>}
      open={open}
      onCancel={onClose}
      destroyOnHidden
      width={680}
      footer={[
        <Button key="cancel" onClick={onClose}>取消</Button>,
        <Button key="submit" type="primary" icon={<CloudSyncOutlined />} loading={saving} onClick={() => form.submit()}>{target ? '保存并同步' : '发布并同步'}</Button>,
      ]}
    >
      {target?.lastSyncError && <Alert className="external-access-modal__alert" type="error" showIcon message="上次同步失败" description={target.lastSyncError} />}
      <Form form={form} layout="vertical" requiredMark="optional" onFinish={save}>
        <section className="external-access-form-section" aria-labelledby="external-app-connection-title">
          <div className="external-access-form-section__head"><span><LinkOutlined aria-hidden="true" /></span><div><h3 id="external-app-connection-title">连接</h3><p>定义用户看到的入口与真实内网目标</p></div></div>
          <Form.Item name="name" label="应用名称" rules={[{ required: true, message: '请填写用户能看懂的应用名称' }]}><Input prefix={<AppstoreOutlined aria-hidden="true" />} placeholder="例如：用友财务系统" /></Form.Item>
          <div className="external-access-form-grid">
            <Form.Item name="publicHostname" label="外网域名" extra="使用 prsznh.cn 的一级子域名" rules={[{ required: true, message: '请填写外网域名' }, { pattern: /^[a-z0-9][a-z0-9-]*\.prsznh\.cn$/i, message: '例如 caiwu.prsznh.cn' }]}>
              <Input prefix={<GlobalOutlined aria-hidden="true" />} placeholder="caiwu.prsznh.cn" />
            </Form.Item>
            <Form.Item name="originUrl" label="内网网站地址" extra="cloudflared 所在电脑必须能访问" rules={[{ required: true, message: '请填写内网网站地址' }, { type: 'url', message: '例如 http://192.168.1.20:8080' }]}>
              <Input prefix={<CloudServerOutlined aria-hidden="true" />} placeholder="http://192.168.1.20:8080" />
            </Form.Item>
          </div>
        </section>

        <section className="external-access-form-section" aria-labelledby="external-app-access-title">
          <div className="external-access-form-section__head"><span><SafetyCertificateFilled aria-hidden="true" /></span><div><h3 id="external-app-access-title">权限</h3><p>预先授权，员工扫码确认后直接进入</p></div></div>
          <Form.Item name="userIds" label="授权用户" extra="取消授权后，已有会话会在有效期结束时失效。" rules={[{ required: true, type: 'array', min: 1, message: '至少选择一个授权用户' }]}>
            <Select mode="multiple" showSearch optionFilterProp="label" maxTagCount="responsive" placeholder="按姓名或手机号选择" options={users.map((user) => ({ value: user.id, label: `${user.name || '未命名用户'} · ${maskPhone(user.phone)}${user.wxBound ? ' · 微信已绑定' : ' · 尚未绑定微信'}`, disabled: user.status !== 'active' }))} />
          </Form.Item>
          <div className="external-access-form-grid external-access-form-grid--settings">
            <Form.Item name="sessionDuration" label="登录有效期"><Select suffixIcon={<ClockCircleOutlined aria-hidden="true" />} options={[{ value: '1h', label: '1 小时' }, { value: '4h', label: '4 小时' }, { value: '8h', label: '8 小时' }, { value: '12h', label: '12 小时' }, { value: '24h', label: '24 小时' }]} /></Form.Item>
            <Form.Item className="external-access-switch-field" name="enabled" label="访问状态" valuePropName="checked" extra="关闭后立即停止新访问"><Switch checkedChildren="开放" unCheckedChildren="停用" /></Form.Item>
          </div>
        </section>
      </Form>
    </Modal>
  );
}
