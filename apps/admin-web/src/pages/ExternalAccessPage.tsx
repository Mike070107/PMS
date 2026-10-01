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
  CopyOutlined,
  CloudServerOutlined,
  CloudSyncOutlined,
  EditOutlined,
  ExclamationCircleFilled,
  ExportOutlined,
  GlobalOutlined,
  LaptopOutlined,
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
  agentId?: number | null;
  gatewayPort?: number | null;
  publishStatus?: 'draft' | 'waiting_agent' | 'publishing' | 'online' | 'error' | 'disabled';
  desiredRevision?: number;
  appliedRevision?: number;
  originCheckedAt?: string | null;
  agentName?: string | null;
  agentStatus?: GatewayAgent['status'] | null;
  userIds: number[];
  lastSyncedAt?: string | null;
  lastSyncError?: string | null;
}

interface GatewayAgent {
  id: number;
  name: string;
  deviceKey: string;
  status: 'pending' | 'online' | 'offline' | 'degraded' | 'disabled';
  version?: string | null;
  computerName?: string | null;
  desiredRevision: number;
  appliedRevision: number;
  lastSeenAt?: string | null;
  lastError?: string | null;
  enabled: boolean;
  enrolled: boolean;
  appCount: number;
}

interface UserOption {
  id: number;
  name?: string | null;
  phone?: string | null;
  status: 'active' | 'disabled';
  wxBound: boolean;
}

interface GatewayConfig {
  provider: 'domestic' | 'cloudflare';
  providerLabel: string;
}

const previewGateway: GatewayConfig = {
  provider: 'domestic',
  providerLabel: '腾讯云 WSS 网关',
};

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
    sessionDuration: '1h',
    enabled: true,
    agentId: 1,
    publishStatus: 'online',
    desiredRevision: 3,
    appliedRevision: 3,
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
    agentId: 2,
    publishStatus: 'waiting_agent',
    desiredRevision: 1,
    appliedRevision: 0,
    userIds: [101],
    lastSyncError: '局域网代理尚未在线，请在目标局域网启动 PMS 内网代理。',
  },
];

const previewAgents: GatewayAgent[] = [
  { id: 1, name: '财务室代理', deviceKey: 'lan-a13f8c2d', status: 'online', version: '1.1.0', computerName: 'SQLServer', desiredRevision: 3, appliedRevision: 3, enabled: true, enrolled: true, appCount: 1, lastSeenAt: new Date().toISOString() },
  { id: 2, name: '仓库代理', deviceKey: 'lan-b492ed11', status: 'pending', desiredRevision: 1, appliedRevision: 0, enabled: true, enrolled: false, appCount: 1 },
];

const previewUsers: UserOption[] = [
  { id: 101, name: '王会计', phone: '13800138001', status: 'active', wxBound: true },
  { id: 102, name: '李出纳', phone: '13800138002', status: 'active', wxBound: true },
  { id: 103, name: '陈经理', phone: '13800138003', status: 'active', wxBound: false },
];

type AppState = 'disabled' | 'error' | 'synced' | 'pending';

const getAppState = (app: ExternalApp): AppState => {
  if (!app.enabled) return 'disabled';
  if (app.agentStatus === 'offline' || app.agentStatus === 'degraded' || app.agentStatus === 'disabled') return 'error';
  if (app.publishStatus === 'error' || app.lastSyncError) return 'error';
  if (app.publishStatus === 'online') return 'synced';
  return 'pending';
};

const stateMeta: Record<AppState, { label: string; icon: React.ReactNode }> = {
  disabled: { label: '已停用', icon: <PauseCircleFilled /> },
  error: { label: '需处理', icon: <ExclamationCircleFilled /> },
  synced: { label: '在线', icon: <CheckCircleFilled /> },
  pending: { label: '发布中', icon: <ClockCircleOutlined /> },
};

const appErrorMessage = (app: ExternalApp) => {
  if (app.lastSyncError) return app.lastSyncError;
  if (app.agentStatus === 'offline') return '代理电脑已离线，请启动 PMS 内网发布助手并检查网络。';
  if (app.agentStatus === 'degraded') return '代理运行异常，请在代理电脑打开发布助手查看具体原因。';
  if (app.agentStatus === 'disabled') return '代理设备已停用，请在 PMS 重新启用或更换代理。';
  return null;
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
  const [agents, setAgents] = useState<GatewayAgent[]>(preview ? previewAgents : []);
  const [gateway, setGateway] = useState<GatewayConfig>(previewGateway);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<ExternalApp | null>(null);
  const [creating, setCreating] = useState(false);
  const [creatingAgent, setCreatingAgent] = useState(false);
  const [syncingId, setSyncingId] = useState<number | null>(null);

  const load = useCallback(async () => {
    if (preview) return;
    setLoading(true);
    try {
      const [appRows, userRows, agentRows, gatewayConfig] = await Promise.all([
        request<ExternalApp[]>({ url: '/external-access/apps' }),
        request<UserOption[]>({ url: '/external-access/users' }),
        request<GatewayAgent[]>({ url: '/external-access/agents' }),
        request<GatewayConfig>({ url: '/external-access/config' }),
      ]);
      setApps(appRows);
      setUsers(userRows);
      setAgents(agentRows);
      setGateway(gatewayConfig);
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
      message.info('视觉预览不会修改网关配置');
      return;
    }
    setSyncingId(app.id);
    try {
      await request({ method: 'POST', url: `/external-access/apps/${app.id}/sync` });
      message.success(`「${app.name}」已同步到 ${gateway.providerLabel}`);
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
          description="页面不会连接 PMS API，也不会修改生产网关。"
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
            {canEdit && gateway.provider === 'domestic' && (
              <Button size="large" icon={<LaptopOutlined />} onClick={() => setCreatingAgent(true)}>添加代理</Button>
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

      {gateway.provider === 'domestic' && (
        <section className="external-access-section" aria-labelledby="external-access-agents-title">
          <div className="external-access-section__head">
            <div>
              <span className="external-access-section__icon"><LaptopOutlined aria-hidden="true" /></span>
              <div><h2 id="external-access-agents-title">代理设备</h2><p>新电脑只需输入一次性安装码</p></div>
            </div>
            <span className="external-access-section__count">{agents.length}</span>
          </div>
          {agents.length ? (
            <div className="external-access-agent-grid">
              {agents.map((agent) => <GatewayAgentCard key={agent.id} agent={agent} preview={preview} canEdit={canEdit} onChanged={load} />)}
            </div>
          ) : (
            <div className="external-access-empty external-access-empty--compact">
              <span><LaptopOutlined aria-hidden="true" /></span><h3>还没有代理设备</h3><p>先添加代理，再把内网应用发布到该电脑。</p>
              {canEdit && <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreatingAgent(true)}>添加代理</Button>}
            </div>
          )}
        </section>
      )}

      <section className="external-access-section" aria-labelledby="external-access-apps-title">
        <div className="external-access-section__head">
          <div>
            <span className="external-access-section__icon"><ApiOutlined aria-hidden="true" /></span>
            <div><h2 id="external-access-apps-title">发布清单</h2><p>{gateway.providerLabel} · PMS 授权 · 加密隧道</p></div>
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
                provider={gateway.provider}
                syncing={syncingId === app.id}
                onEdit={() => setEditing(app)}
                onSync={() => sync(app)}
              />
            ))}
          </div>
        )}
      </section>

      <ExternalAppModal open={creating} users={users} agents={agents} preview={preview} provider={gateway.provider} onClose={() => setCreating(false)} onDone={() => { setCreating(false); load(); }} />
      <ExternalAppModal open={!!editing} target={editing} users={users} agents={agents} preview={preview} provider={gateway.provider} onClose={() => setEditing(null)} onDone={() => { setEditing(null); load(); }} />
      <GatewayAgentModal open={creatingAgent} preview={preview} onClose={() => setCreatingAgent(false)} onDone={() => { setCreatingAgent(false); load(); }} />
    </main>
  );
}

function Metric({ icon, value, label, tone }: { icon: React.ReactNode; value: number; label: string; tone: 'blue' | 'green' | 'violet' | 'amber' }) {
  return <div className={`external-access-metric external-access-metric--${tone}`}><span className="external-access-metric__icon" aria-hidden="true">{icon}</span><strong>{value}</strong><small>{label}</small></div>;
}

function ExternalAppCard({ app, index, canEdit, provider, syncing, onEdit, onSync }: { app: ExternalApp; index: number; canEdit: boolean; provider: GatewayConfig['provider']; syncing: boolean; onEdit: () => void; onSync: () => void }) {
  const state = getAppState(app);
  const status = stateMeta[state];
  const isFinanceApp = /财务|用友|会计|资金/.test(app.name);
  const tone = ['teal', 'blue', 'violet', 'amber'][index % 4];
  const revisionApplied = !!app.desiredRevision && app.appliedRevision === app.desiredRevision;
  const agentOnline = app.agentStatus === 'online' || provider === 'cloudflare';
  const stages = [
    { label: '下发', done: !!app.desiredRevision || provider === 'cloudflare' },
    { label: '内网', done: !!app.originCheckedAt || state === 'synced' },
    { label: '隧道', done: revisionApplied && agentOnline || state === 'synced' },
    { label: 'HTTPS', done: state === 'synced' },
    { label: '授权', done: state === 'synced' && app.userIds.length > 0 },
  ];
  const errorMessage = appErrorMessage(app);

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

      {provider === 'domestic' && app.enabled && (
        <ol className="external-app-progress" aria-label="发布进度">
          {stages.map((stage, stageIndex) => <li key={stage.label} className={stage.done ? 'is-done' : stageIndex === stages.findIndex((item) => !item.done) ? 'is-current' : ''}><span aria-hidden="true">{stage.done ? <CheckCircleFilled /> : stageIndex + 1}</span><small>{stage.label}</small></li>)}
        </ol>
      )}

      {errorMessage && <div className="external-app-error" role="status"><ExclamationCircleFilled aria-hidden="true" /><span>{errorMessage}</span></div>}

      <footer className="external-app-card__foot">
        <div className="external-app-facts">
          <span><TeamOutlined aria-hidden="true" /><strong>{app.userIds.length}</strong> 人</span>
          <span><ClockCircleOutlined aria-hidden="true" /><strong>{app.sessionDuration}</strong></span>
        </div>
        <div className="external-app-actions">
          <Tooltip title={state === 'synced' ? `打开 ${app.name}` : '发布完成后可打开'}><Button type="text" shape="circle" icon={<ExportOutlined />} href={state === 'synced' ? launchUrl(app) : undefined} target="_blank" disabled={state !== 'synced'} aria-label={`打开 ${app.name}`} /></Tooltip>
          {canEdit && <Tooltip title="编辑配置"><Button type="text" shape="circle" icon={<EditOutlined />} onClick={onEdit} aria-label={`编辑 ${app.name}`} /></Tooltip>}
          {canEdit && provider === 'cloudflare' && <Tooltip title="同步 Cloudflare"><Button className="external-app-actions__sync" type="primary" shape="circle" icon={<CloudSyncOutlined />} loading={syncing} onClick={onSync} aria-label={`同步 ${app.name} 到 Cloudflare`} /></Tooltip>}
        </div>
      </footer>
    </article>
  );
}

function SkeletonCard() {
  return <div className="external-app-card external-app-card--skeleton"><Skeleton active avatar paragraph={{ rows: 3 }} /></div>;
}

function GatewayAgentCard({ agent, preview, canEdit, onChanged }: { agent: GatewayAgent; preview: boolean; canEdit: boolean; onChanged: () => void }) {
  const { message, modal } = AntdApp.useApp();
  const [issuing, setIssuing] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [installCode, setInstallCode] = useState<string | null>(null);
  const statusLabel = { pending: '待安装', online: '在线', offline: '离线', degraded: '异常', disabled: '已停用' }[agent.status];
  const issueCode = async () => {
    if (preview) { setInstallCode('ABCDE-23456'); return; }
    setIssuing(true);
    try {
      const result = await request<{ installCode: string }>({ method: 'POST', url: `/external-access/agents/${agent.id}/install-code` });
      setInstallCode(result.installCode);
    } catch (error: any) { message.error(error?.message || '生成安装码失败'); }
    finally { setIssuing(false); }
  };
  const copyCode = async () => {
    if (!installCode) return;
    await navigator.clipboard.writeText(installCode);
    message.success('安装码已复制');
  };
  const setEnabled = async (enabled: boolean) => {
    if (!enabled) {
      const confirmed = await new Promise<boolean>((resolve) => modal.confirm({ title: `停用「${agent.name}」？`, content: '这台代理承载的内网应用会立即停止访问。重新启用后需等待代理恢复心跳。', okText: '确认停用', cancelText: '取消', okButtonProps: { danger: true }, onOk: () => resolve(true), onCancel: () => resolve(false) }));
      if (!confirmed) return;
    }
    if (preview) { message.info(enabled ? '预览：代理将重新启用' : '预览：代理将停用'); return; }
    setToggling(true);
    try {
      await request({ method: 'PATCH', url: `/external-access/agents/${agent.id}`, data: { enabled } });
      message.success(enabled ? '代理已启用' : '代理已停用');
      onChanged();
    } catch (error: any) { message.error(error?.message || '更新代理状态失败'); }
    finally { setToggling(false); }
  };
  return <article className="external-access-agent-card">
    <div className="external-access-agent-card__icon"><LaptopOutlined aria-hidden="true" /></div>
    <div className="external-access-agent-card__body">
      <div className="external-access-agent-card__title"><h3>{agent.name}</h3><span className={`external-access-agent-status external-access-agent-status--${agent.status}`}>{statusLabel}</span></div>
      <p>{agent.computerName || '尚未绑定电脑'}{agent.version ? ` · v${agent.version}` : ''}</p>
      <div className="external-access-agent-card__facts"><span>{agent.appCount} 个应用</span><span>修订 {agent.appliedRevision}/{agent.desiredRevision}</span></div>
      {agent.lastError && <div className="external-app-error"><ExclamationCircleFilled aria-hidden="true" /><span>{agent.lastError}</span></div>}
      {installCode && <button type="button" className="external-access-install-code" onClick={copyCode} aria-label="复制安装码"><code>{installCode}</code><CopyOutlined aria-hidden="true" /></button>}
    </div>
    {canEdit && <div className="external-access-agent-card__actions"><Switch checked={agent.enabled} loading={toggling} checkedChildren="启用" unCheckedChildren="停用" onChange={setEnabled} aria-label={`${agent.enabled ? '停用' : '启用'} ${agent.name}`} /><Button loading={issuing} onClick={issueCode}>{agent.enrolled ? '重新绑定' : '获取安装码'}</Button></div>}
  </article>;
}

function GatewayAgentModal({ open, preview, onClose, onDone }: { open: boolean; preview: boolean; onClose: () => void; onDone: () => void }) {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ installCode: string; installCodeExpiresAt?: string } | null>(null);
  useEffect(() => { if (open) { form.resetFields(); setResult(null); } }, [open, form]);
  const save = async ({ name }: { name: string }) => {
    if (preview) { setResult({ installCode: 'ABCDE-23456' }); return; }
    setSaving(true);
    try { setResult(await request({ method: 'POST', url: '/external-access/agents', data: { name } })); }
    catch (error: any) { message.error(error?.message || '创建代理失败'); }
    finally { setSaving(false); }
  };
  return <Modal title="添加内网代理" open={open} onCancel={onClose} destroyOnHidden footer={result ? <Button type="primary" onClick={onDone}>完成</Button> : [<Button key="cancel" onClick={onClose}>取消</Button>, <Button key="create" type="primary" loading={saving} onClick={() => form.submit()}>生成安装码</Button>]}>
    {result ? <div className="external-access-enroll-result"><CheckCircleFilled aria-hidden="true" /><h3>代理已创建</h3><p>在目标电脑打开「PMS 内网发布助手」，输入下面的安装码。安装码 10 分钟内有效且只能使用一次。</p><button type="button" className="external-access-install-code" onClick={() => navigator.clipboard.writeText(result.installCode)}><code>{result.installCode}</code><CopyOutlined aria-hidden="true" /></button></div> : <Form form={form} layout="vertical" onFinish={save}><Form.Item name="name" label="代理名称" extra="使用安装位置或用途，便于后续选择。" rules={[{ required: true, message: '请填写代理名称' }]}><Input prefix={<LaptopOutlined />} placeholder="例如：财务室代理" autoFocus /></Form.Item></Form>}
  </Modal>;
}

function ExternalAppModal({ open, target, users, agents, preview, provider, onClose, onDone }: { open: boolean; target?: ExternalApp | null; users: UserOption[]; agents: GatewayAgent[]; preview: boolean; provider: GatewayConfig['provider']; onClose: () => void; onDone: () => void }) {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (target) form.setFieldsValue({ ...target, originUrl: originEntryUrl(target) });
    else {
      form.resetFields();
      form.setFieldsValue({ enabled: true, sessionDuration: '1h', userIds: [], agentId: agents.length === 1 ? agents[0].id : undefined });
    }
  }, [open, target, form, agents]);

  const save = async (values: Record<string, unknown>) => {
    if (preview) {
      message.info('视觉预览已校验表单，未发送配置');
      onDone();
      return;
    }
    setSaving(true);
    try {
      const saved = await request<ExternalApp>({ method: target ? 'PATCH' : 'POST', url: target ? `/external-access/apps/${target.id}` : '/external-access/apps', data: values });
      if (saved.lastSyncError) message.warning(`配置已保存，但网关同步失败：${saved.lastSyncError}`);
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
        <Button key="submit" type="primary" icon={<CloudSyncOutlined />} loading={saving} onClick={() => form.submit()}>{provider === 'domestic' ? (target ? '保存配置' : '发布应用') : (target ? '保存并同步' : '发布并同步')}</Button>,
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
            <Form.Item name="originUrl" label="内网网站地址" extra="内网代理所在电脑必须能访问" rules={[{ required: true, message: '请填写内网网站地址' }, { type: 'url', message: '例如 http://192.168.1.20:8080' }]}>
              <Input prefix={<CloudServerOutlined aria-hidden="true" />} placeholder="http://192.168.1.20:8080" />
            </Form.Item>
          </div>
          {provider === 'domestic' && <Form.Item name="agentId" label="内网代理" extra="配置会自动下发到这台电脑，无需再编辑本地路由。" rules={[{ required: true, message: '请选择能访问该内网网站的代理电脑' }]}><Select placeholder="选择代理设备" options={agents.filter((agent) => agent.enabled).map((agent) => ({ value: agent.id, label: `${agent.name} · ${{ online: '在线', pending: '待安装', offline: '离线', degraded: '异常', disabled: '已停用' }[agent.status]}` }))} /></Form.Item>}
        </section>

        <section className="external-access-form-section" aria-labelledby="external-app-access-title">
          <div className="external-access-form-section__head"><span><SafetyCertificateFilled aria-hidden="true" /></span><div><h3 id="external-app-access-title">权限</h3><p>预先授权，员工扫码确认后直接进入</p></div></div>
          <Form.Item name="userIds" label="授权用户" extra="取消授权后立即停止该用户访问；已打开页面的下一次请求也会被拦截。" rules={[{ required: true, type: 'array', min: 1, message: '至少选择一个授权用户' }]}>
            <Select mode="multiple" showSearch optionFilterProp="label" maxTagCount="responsive" placeholder="按姓名或手机号选择" options={users.map((user) => ({ value: user.id, label: `${user.name || '未命名用户'} · ${maskPhone(user.phone)}${user.wxBound ? ' · 微信已绑定' : ' · 尚未绑定微信'}`, disabled: user.status !== 'active' }))} />
          </Form.Item>
          <div className="external-access-form-grid external-access-form-grid--settings">
            <Form.Item name="sessionDuration" label="登录有效期"><Select suffixIcon={<ClockCircleOutlined aria-hidden="true" />} options={[{ value: '30m', label: '30 分钟（财务推荐）' }, { value: '1h', label: '1 小时' }, { value: '4h', label: '4 小时（最长）' }]} /></Form.Item>
            <Form.Item className="external-access-switch-field" name="enabled" label="访问状态" valuePropName="checked" extra="关闭后立即停止新访问"><Switch checkedChildren="开放" unCheckedChildren="停用" /></Form.Item>
          </div>
        </section>
      </Form>
    </Modal>
  );
}
