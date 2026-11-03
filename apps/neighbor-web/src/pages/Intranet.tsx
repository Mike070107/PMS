import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import { request } from '@pms/api-client';
import Icon, { type IconName } from '@/components/Icon';
import { ConfirmModal, toast } from '@/components/ui';
import { dayjs } from '@/lib/format';
import { can } from '@/lib/perm';
import '@/styles/intranet.css';
import ToneIcon from '@/components/ToneIcon';

/* 与旧后台「内网应用发布」同一套接口与卡片布局；客户端区做了配对向导和节点状态 */

interface ExternalApp {
  id: number; name: string; slug: string; publicHostname: string; originUrl: string; entryPath: string;
  sessionDuration: string; enabled: boolean; agentId?: number | null; gatewayPort?: number | null;
  publishStatus?: 'draft' | 'waiting_agent' | 'publishing' | 'online' | 'error' | 'disabled';
  desiredRevision?: number; appliedRevision?: number; originCheckedAt?: string | null;
  agentName?: string | null; agentStatus?: Agent['status'] | null; roleIds: number[];
  lastSyncedAt?: string | null; lastSyncError?: string | null;
}
interface Agent {
  id: number; name: string; deviceKey: string; status: 'pending' | 'online' | 'offline' | 'degraded' | 'disabled';
  version?: string | null; computerName?: string | null; desiredRevision: number; appliedRevision: number;
  lastSeenAt?: string | null; lastError?: string | null; enabled: boolean; enrolled: boolean; appCount: number;
}
interface GatewayConfig { provider: 'domestic' | 'cloudflare'; providerLabel: string }
interface Role { id: number; name: string }

type AppState = 'disabled' | 'error' | 'synced' | 'pending';
const getAppState = (app: ExternalApp): AppState => {
  if (!app.enabled) return 'disabled';
  if (app.agentStatus === 'offline' || app.agentStatus === 'degraded' || app.agentStatus === 'disabled') return 'error';
  if (app.publishStatus === 'error' || app.lastSyncError) return 'error';
  if (app.publishStatus === 'online') return 'synced';
  return 'pending';
};
const STATE: Record<AppState, { label: string; icon: IconName }> = {
  disabled: { label: '已停用', icon: 'pause-fill' }, error: { label: '需处理', icon: 'warn-fill' },
  synced: { label: '在线', icon: 'ok-fill' }, pending: { label: '发布中', icon: 'clock' },
};
const AGENT_LABEL: Record<Agent['status'], string> = { pending: '待配对', online: '在线', offline: '离线', degraded: '异常', disabled: '已停用' };
const DURATION: Record<string, string> = { '4h': '4 小时', '8h': '8 小时', '12h': '12 小时' };
const appErrorMessage = (app: ExternalApp) => {
  if (app.lastSyncError) return app.lastSyncError;
  if (app.agentStatus === 'offline') return '客户端电脑已离线，请在那台电脑启动「PMS 内网应用连接助手」并检查网络。';
  if (app.agentStatus === 'degraded') return '客户端运行异常，请在客户端电脑打开连接助手查看具体原因。';
  if (app.agentStatus === 'disabled') return '客户端已停用，请重新启用或换一台客户端。';
  return null;
};
const launchUrl = (app: Pick<ExternalApp, 'publicHostname' | 'entryPath'>) => `https://${app.publicHostname}${app.entryPath || '/'}`;
const originEntryUrl = (app: Pick<ExternalApp, 'originUrl' | 'entryPath'>) => `${app.originUrl}${app.entryPath === '/' ? '' : app.entryPath || ''}`;
const ago = (s?: string | null) => (s ? dayjs(s).fromNow() : '从未');
/** 心跳 2 分钟内算新鲜 */
const fresh = (s?: string | null) => !!s && dayjs().diff(dayjs(s), 'second') < 120;

export default function Intranet() {
  const canEdit = can('settings', 'edit');
  const nav = useNavigate();
  const [apps, setApps] = useState<ExternalApp[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [gateway, setGateway] = useState<GatewayConfig>({ provider: 'domestic', providerLabel: '腾讯云 WSS 网关' });
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<{ target: ExternalApp | null; agentId?: number } | null>(null);
  const [wizard, setWizard] = useState<{ agent?: Agent } | null>(null);
  const [removing, setRemoving] = useState<ExternalApp | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const [a, g, c] = await Promise.all([
        request<ExternalApp[]>({ url: '/external-access/apps' }),
        request<Agent[]>({ url: '/external-access/agents' }),
        request<GatewayConfig>({ url: '/external-access/config' }),
      ]);
      setApps(a); setAgents(g); setGateway(c);
    } catch (e) { if (!silent) toast(e instanceof Error ? e.message : '加载内网应用失败'); }
    finally { if (!silent) setLoading(false); }
  }, []);
  useEffect(() => { void load(); request<Role[]>({ url: '/roles' }).then(setRoles).catch(() => setRoles([])); }, [load]);
  // 发布中 / 待配对时每 3 秒静默刷新；平时 30 秒刷新一次心跳
  const pending = apps.some((a) => a.publishStatus === 'waiting_agent' || a.publishStatus === 'publishing') || agents.some((a) => a.status === 'pending');
  useEffect(() => { const t = window.setInterval(() => { void load(true); }, pending ? 3000 : 30000); return () => window.clearInterval(t); }, [pending, load]);

  const summary = useMemo(() => ({
    total: apps.length,
    synced: apps.filter((a) => getAppState(a) === 'synced').length,
    roles: new Set(apps.flatMap((a) => a.roleIds)).size,
    attention: apps.filter((a) => getAppState(a) === 'error').length + agents.filter((a) => a.enabled && ['offline', 'degraded'].includes(a.status)).length,
  }), [apps, agents]);
  const roleName = (id: number) => roles.find((r) => r.id === id)?.name || `角色 #${id}`;

  const remove = async () => {
    if (!removing) return;
    setBusy(true);
    try { await request({ method: 'DELETE', url: `/external-access/apps/${removing.id}` }); toast(`「${removing.name}」已删除`); setRemoving(null); void load(); }
    catch (e) { toast(e instanceof Error ? e.message : '删除失败'); }
    finally { setBusy(false); }
  };
  const sync = async (app: ExternalApp) => {
    try { await request({ method: 'POST', url: `/external-access/apps/${app.id}/sync` }); toast(`「${app.name}」已同步`); }
    catch (e) { toast(e instanceof Error ? e.message : '同步失败'); }
    void load(true);
  };

  return (
    <main className="external-access-page">
      <section className="external-access-hero">
        <div className="external-access-hero__copy">
          <span className="external-access-eyebrow"><Icon name="safe-fill" /> 零信任网关</span>
          <div className="h1row"><ToneIcon kind="intranet" /><h1>内网应用发布</h1></div>
          <p>一次配置，员工微信扫码授权后，在外网直达公司内网的业务系统。</p>
          <div className="external-access-hero__actions">
            {canEdit ? <button className="btn lg p ea-btn-primary" onClick={() => setForm({ target: null })}><Icon name="plus" />新增应用</button> : null}
            {canEdit && gateway.provider === 'domestic' ? <button className="btn lg" onClick={() => setWizard({})}><Icon name="laptop" />新增内网客户端</button> : null}
            <button className="ea-icon-btn" title="刷新状态" onClick={() => { void load(); }}><Icon name="refresh" /></button>
          </div>
        </div>
        <div className="external-access-flow" aria-label="访问链路：公网、授权、内网">
          <div className="external-access-flow__node external-access-flow__node--public"><Icon name="globe" /><span>公网</span></div>
          <span className="external-access-flow__line" />
          <div className="external-access-flow__node external-access-flow__node--access"><Icon name="lock" /><span>授权</span></div>
          <span className="external-access-flow__line" />
          <div className="external-access-flow__node external-access-flow__node--origin"><Icon name="server" /><span>内网</span></div>
        </div>
        <div className="external-access-metrics">
          <Metric icon="apps" value={summary.total} label="应用" tone="blue" />
          <Metric icon="ok-fill" value={summary.synced} label="在线" tone="green" />
          <Metric icon="users" value={summary.roles} label="授权角色" tone="violet" />
          <Metric icon="warn-fill" value={summary.attention} label="待处理" tone="amber" />
        </div>
      </section>

      {gateway.provider === 'domestic' ? (
        <section className="external-access-section">
          <div className="external-access-section__head">
            <div><span className="external-access-section__icon"><Icon name="laptop" /></span>
              <div><h2>内网客户端</h2><p>装在公司内网电脑上的「连接助手」，负责把内网网站接到网关</p></div></div>
            <span className="external-access-section__count">{agents.length}</span>
          </div>
          {agents.length ? (
            <div className="external-access-agent-grid">
              {agents.map((a) => <AgentCard key={a.id} agent={a} apps={apps.filter((x) => x.agentId === a.id)} canEdit={canEdit} onChanged={() => load(true)} onPair={() => setWizard({ agent: a })} />)}
            </div>
          ) : (
            <div className="external-access-empty external-access-empty--compact">
              <span><Icon name="laptop" /></span><h3>还没有内网客户端</h3><p>先在内网电脑上装好连接助手并配对，再把内网应用发布到这台电脑。</p>
              {canEdit ? <button className="btn p" onClick={() => setWizard({})}><Icon name="plus" />新增内网客户端</button> : null}
            </div>
          )}
        </section>
      ) : null}

      <section className="external-access-section">
        <div className="external-access-section__head">
          <div><span className="external-access-section__icon"><Icon name="api" /></span>
            <div><h2>发布清单</h2><p>{gateway.providerLabel} · PMS 授权 · 加密隧道</p></div></div>
          <span className="external-access-section__count">{apps.length}</span>
        </div>
        {loading && !apps.length ? (
          <div className="external-access-empty"><p>加载中…</p></div>
        ) : !apps.length ? (
          <div className="external-access-empty">
            <span><Icon name="server" /></span><h3>还没有内网应用</h3><p>添加第一条发布配置，即可从外网安全访问。</p>
            {canEdit ? <button className="btn p" onClick={() => setForm({ target: null })}><Icon name="plus" />新增应用</button> : null}
          </div>
        ) : (
          <div className="external-access-grid">
            {apps.map((app, i) => (
              <AppCard key={app.id} app={app} index={i} canEdit={canEdit} provider={gateway.provider} roleNames={app.roleIds.map(roleName)}
                onEdit={() => setForm({ target: app })} onRemove={() => setRemoving(app)} onSync={() => sync(app)} />
            ))}
          </div>
        )}
      </section>

      {form ? <AppForm target={form.target} presetAgentId={form.agentId} agents={agents} provider={gateway.provider}
        onClose={() => setForm(null)} onDone={() => { setForm(null); void load(); }} onRoles={() => nav('/staff')} /> : null}
      {wizard ? <PairWizard agent={wizard.agent} onClose={() => { setWizard(null); void load(true); }}
        onPublish={(agentId) => { setWizard(null); void load(true); setForm({ target: null, agentId }); }} /> : null}
      <ConfirmModal open={!!removing} onClose={() => setRemoving(null)} title={`删除「${removing?.name ?? ''}」？`} confirmText="确认删除" danger busy={busy} onConfirm={() => void remove()}>
        删除后立即收回 {removing?.publicHostname} 的公网入口、隧道通道和全部角色授权，不能恢复。内网里的业务系统本身不受影响。
        {removing?.enabled ? <div className="ea-note warn" style={{ marginTop: 10 }}>这个应用还在开放访问，正在用的员工会马上断开。只想临时关闭的话，请用「编辑 → 停用」。</div> : null}
      </ConfirmModal>
    </main>
  );
}

function Metric({ icon, value, label, tone }: { icon: IconName; value: number; label: string; tone: 'blue' | 'green' | 'violet' | 'amber' }) {
  return <div className={`external-access-metric external-access-metric--${tone}`}><span className="external-access-metric__icon"><Icon name={icon} /></span><strong>{value}</strong><small>{label}</small></div>;
}

function AppCard({ app, index, canEdit, provider, roleNames, onEdit, onRemove, onSync }: {
  app: ExternalApp; index: number; canEdit: boolean; provider: GatewayConfig['provider']; roleNames: string[];
  onEdit: () => void; onRemove: () => void; onSync: () => void;
}) {
  const state = getAppState(app);
  const status = STATE[state];
  const finance = /财务|用友|会计|资金/.test(app.name);
  const tone = ['teal', 'blue', 'violet', 'amber'][index % 4];
  const applied = !!app.desiredRevision && app.appliedRevision === app.desiredRevision;
  const agentOnline = app.agentStatus === 'online' || provider === 'cloudflare';
  const stages = [
    { label: '下发', done: !!app.desiredRevision || provider === 'cloudflare' },
    { label: '内网', done: !!app.originCheckedAt || state === 'synced' },
    { label: '隧道', done: (applied && agentOnline) || state === 'synced' },
    { label: 'HTTPS', done: state === 'synced' },
    { label: '授权', done: state === 'synced' && app.roleIds.length > 0 },
  ];
  const current = stages.findIndex((s) => !s.done);
  const err = appErrorMessage(app);
  return (
    <article className={`external-app-card external-app-card--${tone}`} style={{ '--card-index': index } as CSSProperties}>
      <div className="external-app-card__topline" />
      <header className="external-app-card__head">
        <span className="external-app-card__logo"><Icon name={finance ? 'bank' : 'apps'} /></span>
        <div className="external-app-card__title">
          <h3>{app.name}</h3>
          <a href={launchUrl(app)} target="_blank" rel="noreferrer"><span>{app.publicHostname}</span><Icon name="export" /></a>
        </div>
        <span className={`external-app-status external-app-status--${state}`}><Icon name={status.icon} /><span>{status.label}</span></span>
      </header>
      <div className="external-app-route">
        <span className="external-app-route__icon"><Icon name="server" /></span>
        <div><small>内网地址</small><code>{originEntryUrl(app)}</code></div>
        <span className="external-app-route__pulse" />
      </div>
      {provider === 'domestic' && app.enabled ? (
        <ol className="external-app-progress" aria-label="发布进度">
          {stages.map((s, i) => <li key={s.label} className={s.done ? 'is-done' : i === current ? 'is-current' : ''}><span>{s.done ? <Icon name="check" /> : i + 1}</span><small>{s.label}</small></li>)}
        </ol>
      ) : null}
      {err ? <div className="external-app-error"><Icon name="warn-fill" /><span>{err}</span></div> : null}
      <div className="ea-role-chips">
        {roleNames.length ? roleNames.map((n) => <span key={n}>{n}</span>) : <span className="none">还没有授权角色，员工看不到这个应用</span>}
      </div>
      <footer className="external-app-card__foot">
        <div className="external-app-facts">
          <span><Icon name="laptop" /><strong>{app.agentName || '—'}</strong></span>
          <span><Icon name="clock" /><strong>{DURATION[app.sessionDuration] || app.sessionDuration}</strong></span>
        </div>
        <div className="external-app-actions">
          <a className="ea-icon-btn" title={state === 'synced' ? `打开 ${app.name}` : '发布完成后可打开'} href={state === 'synced' ? launchUrl(app) : undefined} target="_blank" rel="noreferrer" aria-disabled={state !== 'synced'} style={state === 'synced' ? undefined : { opacity: 0.35, pointerEvents: 'none' }}><Icon name="export" /></a>
          {canEdit ? <button className="ea-icon-btn" title="编辑配置" onClick={onEdit}><Icon name="edit" /></button> : null}
          {canEdit ? <button className="ea-icon-btn danger" title="删除应用" onClick={onRemove}><Icon name="trash" /></button> : null}
          {canEdit && provider === 'cloudflare' ? <button className="ea-icon-btn" title="同步" onClick={onSync}><Icon name="sync" /></button> : null}
        </div>
      </footer>
    </article>
  );
}

/** 客户端卡：三个节点（配对 / 心跳 / 配置同步）绿色打勾，下挂它承载的应用 */
function AgentCard({ agent, apps, canEdit, onChanged, onPair }: { agent: Agent; apps: ExternalApp[]; canEdit: boolean; onChanged: () => void; onPair: () => void }) {
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const beat = fresh(agent.lastSeenAt);
  const synced = agent.enrolled && agent.appliedRevision === agent.desiredRevision;
  const nodes = [
    { label: '配对', ok: agent.enrolled, note: agent.enrolled ? (agent.computerName || '已配对') : '还没配对' },
    { label: '心跳', ok: agent.enabled && agent.status === 'online' && beat, bad: agent.enrolled && (!beat || ['offline', 'degraded'].includes(agent.status)), note: ago(agent.lastSeenAt) },
    { label: '配置同步', ok: synced, bad: agent.enrolled && !synced, note: `第 ${agent.appliedRevision}/${agent.desiredRevision} 版` },
  ];
  const patch = async (data: Record<string, unknown>, ok: string) => {
    setBusy(true);
    try { await request({ method: 'PATCH', url: `/external-access/agents/${agent.id}`, data }); toast(ok); onChanged(); }
    catch (e) { toast(e instanceof Error ? e.message : '操作失败'); }
    finally { setBusy(false); }
  };
  return (
    <article className="external-access-agent-card">
      <div className="external-access-agent-card__icon"><Icon name="laptop" /></div>
      <div className="external-access-agent-card__body">
        <div className="external-access-agent-card__title">
          {renaming !== null ? (
            <span style={{ display: 'flex', gap: 6 }}>
              <input className="in" style={{ height: 36 }} autoFocus maxLength={120} value={renaming} onChange={(e) => setRenaming(e.target.value)} />
              <button className="btn sm p" disabled={busy || !renaming.trim()} onClick={() => { void patch({ name: renaming.trim() }, '名称已更新').then(() => setRenaming(null)); }}>保存</button>
              <button className="btn sm" onClick={() => setRenaming(null)}>取消</button>
            </span>
          ) : <h3>{agent.name}</h3>}
          <span className={`external-access-agent-status external-access-agent-status--${agent.status}`}>{AGENT_LABEL[agent.status]}</span>
        </div>
        <p>{agent.computerName ? `电脑 ${agent.computerName}` : '尚未绑定电脑'}{agent.version ? ` · 助手 v${agent.version}` : ''}</p>
        <ul className="ea-agent-nodes">
          {nodes.map((n) => <li key={n.label} className={n.ok ? 'ok' : n.bad ? 'bad' : ''}><Icon name={n.ok ? 'ok-fill' : n.bad ? 'warn-fill' : 'clock'} /><span>{n.label}<small>{n.note}</small></span></li>)}
        </ul>
        {apps.length ? <div className="ea-agent-apps">{apps.map((a) => <span key={a.id}>{a.name}</span>)}</div> : <p>还没有应用发布到这台客户端</p>}
        {agent.lastError ? <div className="external-app-error"><Icon name="warn-fill" /><span>{agent.lastError}</span></div> : null}
        {canEdit ? (
          <div className="ea-agent-actions">
            <button className="btn sm" disabled={busy} onClick={onPair}><Icon name="key" />{agent.enrolled ? '重新配对' : '配对'}</button>
            <button className="btn sm" disabled={busy} onClick={() => setRenaming(agent.name)}><Icon name="edit" />改名</button>
            {agent.enabled
              ? <button className="btn sm" disabled={busy} onClick={() => setStopping(true)}><Icon name="pause" />停用</button>
              : <button className="btn sm p" disabled={busy} onClick={() => patch({ enabled: true }, '客户端已启用')}>启用</button>}
            <button className="ea-icon-btn danger" style={{ marginLeft: 'auto' }} disabled={busy || apps.length > 0}
              title={apps.length ? `还承载 ${apps.length} 个应用，先删除这些应用或改到其他客户端` : '删除客户端'} onClick={() => setDeleting(true)}><Icon name="trash" /></button>
          </div>
        ) : null}
      </div>
      <ConfirmModal open={stopping} onClose={() => setStopping(false)} title={`停用「${agent.name}」？`} confirmText="确认停用" danger busy={busy}
        onConfirm={() => { void patch({ enabled: false }, '客户端已停用').then(() => setStopping(false)); }}>
        这台客户端承载的 {apps.length} 个内网应用会立即停止访问。重新启用后要等客户端恢复心跳。
      </ConfirmModal>
      <ConfirmModal open={deleting} onClose={() => setDeleting(false)} title={`删除客户端「${agent.name}」？`} confirmText="确认删除" danger busy={busy}
        onConfirm={() => {
          setBusy(true);
          request({ method: 'DELETE', url: `/external-access/agents/${agent.id}` })
            .then(() => { toast('客户端已删除，那台电脑上的连接助手会在几秒内自动断开并清除配对'); setDeleting(false); onChanged(); })
            .catch((e) => toast(e instanceof Error ? e.message : '删除失败'))
            .finally(() => setBusy(false));
        }}>
        删除后不能恢复。{agent.computerName ? `电脑 ${agent.computerName} 上` : '那台电脑上'}的连接助手会自动停止转发、清除配对，回到「待配对」；以后要再用，重新新增客户端配对即可。
      </ConfirmModal>
    </article>
  );
}

/**
 * 新增 / 重新配对客户端向导：① 起名 → ② 一次性密钥（10 分钟倒计时）→ ③ 等客户端连上（实时检测）
 * 连上后可直接「发布应用到这台客户端」。
 */
function PairWizard({ agent, onClose, onPublish }: { agent?: Agent; onClose: () => void; onPublish: (agentId: number) => void }) {
  const [step, setStep] = useState<1 | 2 | 3>(agent ? 2 : 1);
  const [name, setName] = useState(() => `内网客户端-${Math.random().toString(36).slice(2, 6).toUpperCase()}`);
  const [agentId, setAgentId] = useState<number | null>(agent?.id ?? null);
  const [code, setCode] = useState<{ installCode: string; expiresAt: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [live, setLive] = useState<Agent | null>(null);
  const [, tick] = useState(0);
  const issued = (installCode: string, expires?: string) => setCode({ installCode, expiresAt: expires ? dayjs(expires).valueOf() : Date.now() + 10 * 60_000 });

  // 重新配对：直接签发新密钥
  useEffect(() => {
    if (!agent) return;
    setBusy(true);
    request<{ installCode: string; installCodeExpiresAt?: string }>({ method: 'POST', url: `/external-access/agents/${agent.id}/install-code` })
      .then((r) => issued(r.installCode, r.installCodeExpiresAt)).catch((e) => setErr(e instanceof Error ? e.message : '生成配对密钥失败')).finally(() => setBusy(false));
  }, [agent]);
  // 有密钥后：每 3 秒查这台客户端是否已配对上线
  useEffect(() => {
    if (!code || !agentId) return;
    const startedSeen = agent?.lastSeenAt ?? null;
    const t = window.setInterval(() => {
      tick((n) => n + 1);
      request<Agent[]>({ url: '/external-access/agents' }).then((list) => {
        const a = list.find((x) => x.id === agentId);
        if (!a) return;
        setLive(a);
        if (a.enrolled && a.status === 'online' && a.lastSeenAt !== startedSeen) setStep(3);
      }).catch(() => undefined);
    }, 3000);
    return () => window.clearInterval(t);
  }, [code, agentId]); // eslint-disable-line react-hooks/exhaustive-deps

  const create = async () => {
    setBusy(true); setErr('');
    try {
      const r = await request<{ id?: number; agent?: { id: number }; installCode: string; installCodeExpiresAt?: string }>({ method: 'POST', url: '/external-access/agents', data: { name: name.trim() } });
      setAgentId(r.agent?.id ?? r.id ?? null);
      issued(r.installCode, r.installCodeExpiresAt);
      setStep(2);
    } catch (e) { setErr(e instanceof Error ? e.message : '创建失败'); }
    finally { setBusy(false); }
  };
  const left = code ? Math.max(0, Math.round((code.expiresAt - Date.now()) / 1000)) : 0;
  const done = step === 3;

  return (
    <div className="ea-modal-root" onClick={onClose}>
      <div className="ea-modal ea-modal--narrow" onClick={(e) => e.stopPropagation()}>
        <div className="ea-modal__head"><span><Icon name="laptop" /></span><div><strong>{agent ? `重新配对「${agent.name}」` : '新增内网客户端'}</strong><small>三步完成：起名 → 输入密钥 → 自动检测连上</small></div>
          <button className="btn g sm x" onClick={onClose}>✕</button></div>
        <div className="ea-modal__body">
          <ol className="ea-wizard-steps">
            {['起名', '输入密钥', '连上'].map((l, i) => <li key={l} className={step > i + 1 || done ? 'done' : step === i + 1 ? 'on' : ''}>{step > i + 1 || done ? <Icon name="ok-fill" /> : <b>{i + 1}</b>}{l}</li>)}
          </ol>
          {step === 1 ? (
            <label className="ea-field"><b>客户端名称</b>
              <input className="in" value={name} maxLength={120} autoFocus onChange={(e) => setName(e.target.value)} />
              <span className="hint">建议写安装位置或用途，例如「财务室电脑」。同一公司内名称不能重复。</span></label>
          ) : null}
          {step === 2 ? (
            <>
              <div className="ea-note">在要接入内网的那台电脑上打开「PMS 内网应用连接助手」，输入下面的配对密钥。密钥只能用一次。</div>
              {code ? <>
                <code className="ea-secret">{code.installCode}</code>
                <div className="ea-countdown">{left > 0 ? `${Math.floor(left / 60)} 分 ${String(left % 60).padStart(2, '0')} 秒内有效` : '密钥已过期，请重新生成'}</div>
                <div className="ea-wait"><span className="spin" style={{ width: 22, height: 22 }} />{live?.enrolled ? '已配对，等待客户端第一次心跳…' : '正在等待客户端用这个密钥连上…'}</div>
              </> : <div className="ea-wait">{busy ? '正在生成密钥…' : null}</div>}
            </>
          ) : null}
          {done ? (
            <div className="ea-wait ok">
              <span className="big"><Icon name="ok-fill" /></span>
              <b style={{ fontSize: 17 }}>「{live?.name || agent?.name || name}」已连上</b>
              <span>电脑 {live?.computerName || '—'}{live?.version ? ` · 助手 v${live.version}` : ''}</span>
            </div>
          ) : null}
          {err ? <div className="ea-note warn">{err}</div> : null}
        </div>
        <div className="ea-modal__foot">
          {step === 1 ? <><button className="btn" onClick={onClose}>取消</button><button className="btn p" disabled={busy || !name.trim()} onClick={() => void create()}>{busy ? '创建中…' : '下一步：生成配对密钥'}</button></> : null}
          {step === 2 ? <>
            <button className="btn" onClick={onClose}>稍后再配</button>
            {code && left > 0 ? <button className="btn p" onClick={() => { void navigator.clipboard?.writeText(code.installCode); toast('配对密钥已复制'); }}><Icon name="copy" />复制密钥</button> : null}
            {code && left <= 0 && agentId ? <button className="btn p" disabled={busy} onClick={() => { setBusy(true); request<{ installCode: string; installCodeExpiresAt?: string }>({ method: 'POST', url: `/external-access/agents/${agentId}/install-code` }).then((r) => issued(r.installCode, r.installCodeExpiresAt)).catch((e) => setErr(e instanceof Error ? e.message : '生成失败')).finally(() => setBusy(false)); }}>重新生成密钥</button> : null}
          </> : null}
          {done ? <><button className="btn" onClick={onClose}>完成</button>{agentId ? <button className="btn p" onClick={() => onPublish(agentId)}><Icon name="plus" />发布应用到这台客户端</button> : null}</> : null}
        </div>
      </div>
    </div>
  );
}

/** 新增 / 编辑应用：连接（名称、域名、内网地址、客户端）+ 权限（登录有效期、开放 / 停用） */
function AppForm({ target, presetAgentId, agents, provider, onClose, onDone, onRoles }: {
  target: ExternalApp | null; presetAgentId?: number; agents: Agent[]; provider: GatewayConfig['provider'];
  onClose: () => void; onDone: () => void; onRoles: () => void;
}) {
  const usable = agents.filter((a) => a.enabled && a.enrolled);
  const [v, setV] = useState(() => ({
    name: target?.name ?? '', publicHostname: target?.publicHostname ?? '', originUrl: target ? originEntryUrl(target) : '',
    agentId: target?.agentId ?? presetAgentId ?? (usable.length === 1 ? usable[0].id : undefined) as number | undefined,
    sessionDuration: target && DURATION[target.sessionDuration] ? target.sessionDuration : '8h', enabled: target?.enabled ?? true,
  }));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const hostOk = /^[a-z0-9][a-z0-9-]*\.prsznh\.cn$/i.test(v.publicHostname.trim());
  const urlOk = /^https?:\/\/[^\s/]+/i.test(v.originUrl.trim());
  const ok = v.name.trim() && hostOk && urlOk && (provider !== 'domestic' || !!v.agentId);
  const save = async () => {
    if (!ok) return;
    setBusy(true); setErr('');
    try {
      const saved = await request<ExternalApp>({ method: target ? 'PATCH' : 'POST', url: target ? `/external-access/apps/${target.id}` : '/external-access/apps',
        data: { ...v, name: v.name.trim(), publicHostname: v.publicHostname.trim().toLowerCase(), originUrl: v.originUrl.trim() } });
      toast(saved.lastSyncError ? `已保存，但网关同步失败：${saved.lastSyncError}` : target ? '已更新' : '已发布，客户端会自动测试并回传结果');
      onDone();
    } catch (e) { setErr(e instanceof Error ? e.message : '保存失败，填写内容已保留'); }
    finally { setBusy(false); }
  };
  const set = (k: keyof typeof v, val: unknown) => setV((x) => ({ ...x, [k]: val }));
  return (
    <div className="ea-modal-root" onClick={onClose}>
      <div className="ea-modal" onClick={(e) => e.stopPropagation()}>
        <div className="ea-modal__head"><span><Icon name="sync" /></span><div><strong>{target ? '编辑发布配置' : '发布内网应用'}</strong><small>{target ? target.name : '安全连接公网与内网'}</small></div>
          <button className="btn g sm x" onClick={onClose}>✕</button></div>
        <div className="ea-modal__body">
          {target?.lastSyncError ? <div className="ea-note warn">上次同步失败：{target.lastSyncError}</div> : null}
          <section className="external-access-form-section">
            <div className="external-access-form-section__head"><span><Icon name="link" /></span><div><h3>连接</h3><p>员工看到的入口，和真实的内网目标</p></div></div>
            <label className="ea-field"><b>应用名称</b><input className="in" value={v.name} placeholder="例如：用友财务系统" onChange={(e) => set('name', e.target.value)} /></label>
            <div className="external-access-form-grid">
              <label className="ea-field"><b>外网域名</b><input className="in" value={v.publicHostname} placeholder="caiwu.prsznh.cn" onChange={(e) => set('publicHostname', e.target.value)} />
                {v.publicHostname && !hostOk ? <span className="err">用 prsznh.cn 的一级子域名，例如 caiwu.prsznh.cn</span> : <span className="hint">prsznh.cn 的一级子域名</span>}</label>
              <label className="ea-field"><b>内网网站地址</b><input className="in" value={v.originUrl} placeholder="http://192.168.1.20:8080" onChange={(e) => set('originUrl', e.target.value)} />
                {v.originUrl && !urlOk ? <span className="err">例如 http://192.168.1.20:8080</span> : <span className="hint">客户端所在电脑必须能打开这个地址</span>}</label>
            </div>
            {provider === 'domestic' ? (
              <label className="ea-field"><b>内网客户端</b>
                <select className="in" value={v.agentId ?? ''} onChange={(e) => set('agentId', e.target.value ? Number(e.target.value) : undefined)}>
                  <option value="">选择已配对的客户端</option>
                  {usable.map((a) => <option key={a.id} value={a.id}>{a.name} · {AGENT_LABEL[a.status]}</option>)}
                </select>
                <span className="hint">选能访问这个内网地址的客户端；保存后它会自动测试并回传结果。{!usable.length ? '还没有已配对的客户端，请先新增内网客户端。' : ''}</span></label>
            ) : null}
          </section>
          <section className="external-access-form-section">
            <div className="external-access-form-section__head"><span><Icon name="safe-fill" /></span><div><h3>权限</h3><p>谁能访问，由「员工与权限」里的角色决定</p></div></div>
            <div className="ea-note">在「员工与权限 → 角色」里勾选这个应用，再把角色分给员工。<a style={{ marginLeft: 6, cursor: 'pointer', textDecoration: 'underline' }} onClick={onRoles}>去配置角色</a></div>
            <div className="external-access-form-grid external-access-form-grid--settings">
              <div className="ea-field"><b>登录有效期</b>
                <div className="ea-seg">{Object.entries(DURATION).map(([k, l]) => <button key={k} type="button" className={`chip ${v.sessionDuration === k ? 'on' : ''}`} onClick={() => set('sessionDuration', k)}>{l}{k === '8h' ? '（默认）' : ''}</button>)}</div>
                <span className="hint">到期后要重新扫码</span></div>
              <div className="ea-field"><b>访问状态</b>
                <div className="ea-seg">
                  <button type="button" className={`chip ${v.enabled ? 'on' : ''}`} onClick={() => set('enabled', true)}>开放</button>
                  <button type="button" className={`chip ${!v.enabled ? 'on' : ''}`} onClick={() => set('enabled', false)}>停用</button>
                </div>
                <span className="hint">停用后立即停止新访问，配置保留</span></div>
            </div>
          </section>
          {err ? <div className="ea-note warn" style={{ marginTop: 12 }}>{err}</div> : null}
        </div>
        <div className="ea-modal__foot">
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn p" disabled={busy || !ok} onClick={() => void save()}><Icon name="sync" />{busy ? '保存中…' : target ? '保存配置' : '发布应用'}</button>
        </div>
      </div>
    </div>
  );
}
