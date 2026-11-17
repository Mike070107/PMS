import { useEffect, useState } from 'react';
import { accessCardIssuance, localIntegrations } from '@pms/api-client';
import type { AccessCardReadiness } from '@pms/api-client/src/endpoints/access-card-issuance';
import type { LocalIntegration, Operation } from '@pms/api-client/src/endpoints/local-integrations';
import { auth, useSession } from '@/lib/auth';
import { can } from '@/lib/perm';
import { Loading, ErrorNote, toast } from '@/components/ui';

type LegacyKind = 'issuer' | 'legacy_sync' | 'access_gateway' | 'parking_gateway';
const KINDS: Array<[LegacyKind | 'standard', string]> = [
  ['issuer', '写卡工作站（Windows / ACR122U）'], ['legacy_sync', '现场旧库同步服务（兼容旧协议）'],
  ['access_gateway', '现场门禁网关服务（兼容旧协议）'], ['parking_gateway', '现场停车网关服务（兼容旧协议）'],
  ['standard', '标准适配服务（协议 1.0 / 新厂商接入）'],
];
const OPS: Array<[Operation, string]> = [['card.inspect', '读取实卡 UID'], ['card.write', '按已分配卡号写卡并回读'], ['access.query', '查询门禁'], ['access.grant', '授权门禁'], ['access.revoke', '撤销门禁'],
  ['access.controller.apply', '下发控制器'], ['parking.query', '查询停车'], ['parking.vehicle.upsert', '登记车辆'], ['parking.vehicle.renew', '车辆续期']];

export default function IntegrationRegistration({ agents, legacyKnown, onChanged }: { agents: AccessCardReadiness['agents']; legacyKnown: boolean; onChanged: () => void }) {
  const session = useSession();
  const editable = can('business', 'edit');
  const fullScope = session.access?.scopeAll === true;
  const [kind, setKind] = useState<LegacyKind | 'standard'>('issuer');
  const [name, setName] = useState('');
  const [resourceId, setResourceId] = useState('site.main');
  const [operations, setOperations] = useState<Operation[]>(['access.query']);
  const [rows, setRows] = useState<LocalIntegration[] | null>(null);
  const [listError, setListError] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState<{ name: string; token: string; identity: ReturnType<typeof auth.captureIdentity> } | null>(null);
  const [listIdentity, setListIdentity] = useState<ReturnType<typeof auth.captureIdentity> | null>(null);
  const currentList = listIdentity !== null && auth.isCurrent(listIdentity);
  const visibleRows = currentList ? rows : null;
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let current = true;
    setRows(null); setListError(''); setListIdentity(auth.captureIdentity());
    if (fullScope) localIntegrations.list().then(r => { if (current) setRows(r); }).catch(e => { if (current) setListError(e instanceof Error ? e.message : '标准连接读取失败'); });
    return () => { current = false; };
  }, [session.generation, session.token, fullScope, revision]);
  useEffect(() => { setSecret(null); setError(''); setBusy(false); }, [session.generation, session.token]);
  async function run(action: () => Promise<{ name: string; token?: string } | void>) {
    const identity = auth.captureIdentity();
    if (busy || !editable) return;
    setBusy(true); setError(''); setSecret(null);
    try {
      const result = await action();
      if (!auth.isCurrent(identity)) return;
      setRevision(v => v + 1); onChanged();
      // Avoid logging, persistence or a toast containing credentials.
      if (result?.token) setSecret({ name: result.name, token: result.token, identity });
    } catch (e) { if (auth.isCurrent(identity)) setError(e instanceof Error ? e.message : '操作失败；请检查连接状态后重试'); }
    finally { if (auth.isCurrent(identity)) setBusy(false); }
  }
  function register() {
    if (!name.trim()) { setError('请填写电脑或服务名称'); return; }
    if (kind === 'standard') {
      if (!operations.length) { setError('至少选择一项本地适配器已经实现的能力'); return; }
      if (operations.some(o => o.startsWith('card.')) && !['card.inspect', 'card.write'].every(o => operations.includes(o as Operation))) { setError('标准写卡资源必须同时支持读取实卡 UID 和写卡回读'); return; }
      void run(() => localIntegrations.enroll({ name: name.trim(), kind: operations.includes('card.write') ? 'workstation' : 'service', resources: [{ id: resourceId.trim(), label: name.trim(), capabilities: operations.map(operation => ({ operation, revision: 1 })) }] }));
      return;
    }
    if (!legacyKnown) { setError('请先成功读取现有连接，避免误轮换现场密钥'); return; }
    const existing = agents.find(a => a.kind === kind && (kind !== 'issuer' || a.name === name.trim()));
    if (existing && !window.confirm(`该${kind === 'issuer' ? '工作站名称' : '固定服务类型'}已有连接「${existing.name}」。继续会轮换密钥，旧客户端立即失效；必须重新配置该电脑。确定继续？`)) return;
    void run(() => accessCardIssuance.enrollAgent({ kind, name: name.trim() }));
  }
  return <section aria-label="接入注册与管理" className="card" style={{ padding: 20, marginBottom: 16 }}>
    <h2 style={{ fontSize: 17, marginTop: 0 }}>添加写卡工作站 / 现场助手与服务</h2>
    <p className="muted">写卡电脑只需连接读卡器，不需要数据库密码。既有服务继续使用兼容协议；新厂商通过标准协议接入，数据库和字段映射仅保存在现场适配器。</p>
    {editable ? <form onSubmit={e => { e.preventDefault(); register(); }}>
      <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))', gap: 16 }}>
          <label>接入类型<select className="input" value={kind} onChange={e => setKind(e.target.value as typeof kind)} style={{ width: '100%', minHeight: 44 }}>{KINDS.map(([id, label]) => <option key={id} value={id} disabled={id === 'standard' && !fullScope}>{label}</option>)}</select></label>
          <label>电脑 / 服务名称<input className="input" required maxLength={100} value={name} onChange={e => setName(e.target.value)} style={{ width: '100%', minHeight: 44 }} /></label>
        </div>
        {kind === 'standard' ? <>
          <label style={{ display: 'block', marginTop: 16 }}>逻辑资源 ID<input className="input" required pattern={'[a-zA-Z0-9][a-zA-Z0-9._:\\-]*'} maxLength={80} value={resourceId} onChange={e => setResourceId(e.target.value)} style={{ width: '100%', minHeight: 44 }} /></label>
          <p className="muted">资源 ID 是稳定业务标识，不是数据库地址、表名或 SQL。写卡资源还对应本地卡片模板；读写两项都就绪后，才会出现在门禁发卡的工作站选择中。仅勾选现场适配器已实现的能力。</p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 20px' }}>{OPS.map(([operation, label]) => <label key={operation} style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 44 }}><input type="checkbox" checked={operations.includes(operation)} onChange={e => setOperations(v => e.target.checked ? [...v, operation] : v.filter(o => o !== operation))} />{label}</label>)}</div>
        </> : <p className="muted">{kind === 'issuer' ? '每台写卡电脑使用不同名称；同名重新注册会使原连接密钥失效。' : '兼容协议每类固定服务复用一个身份；重新注册会使原连接密钥失效，不会创建并行副本。'}</p>}
        {kind !== 'standard' && !legacyKnown ? <p className="muted">需要先读取现有连接，才能安全注册兼容服务；避免误轮换现场密钥。</p> : null}
        <button className="btn p" type="submit" disabled={busy || (kind !== 'standard' && !legacyKnown)}>{busy ? '正在处理…' : '注册并生成一次性密钥'}</button>
      </fieldset>
    </form> : <p className="muted">需要业务编辑权限才能注册或变更连接。</p>}
    {error ? <div role="alert" style={{ marginTop: 12 }}><ErrorNote>{error}</ErrorNote></div> : null}
    {secret && auth.isCurrent(secret.identity) ? <div role="status" style={{ marginTop: 16 }}>
      <b>「{secret.name}」连接密钥（仅本次显示）</b>
      <p>请粘贴到对应电脑的助手中；关闭后无法再次查看。注册成功不代表硬件、数据库或控制器已经就绪。</p>
      <textarea aria-label="一次性连接密钥" readOnly value={secret.token} rows={3} style={{ width: '100%', overflowWrap: 'anywhere' }} />
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}><button className="btn" onClick={() => { void navigator.clipboard.writeText(secret.token).then(() => toast('连接密钥已复制')).catch(() => toast('复制失败，请手动选中密钥复制')); }}>复制密钥</button><button className="btn" onClick={() => setSecret(null)}>已保存，隐藏密钥</button></div>
    </div> : null}
    <h3 style={{ fontSize: 15, marginTop: 24 }}>标准适配服务 · 协议 1.0</h3>
    {!fullScope ? <p className="muted">标准连接管理需要企业全部小区数据范围。</p> : currentList && listError ? <><ErrorNote>{listError}</ErrorNote><button className="btn" onClick={() => setRevision(v => v + 1)}>重新读取</button></> : visibleRows === null ? <Loading text="读取标准连接…" /> : !visibleRows.length ? <p className="muted">暂无标准连接。既有现场助手不需要迁移或重新注册。</p> : visibleRows.map(row => <div key={row.key} style={{ borderTop: '1px solid var(--line, #e2e8f0)', padding: '16px 0' }}>
      <b>{row.name}</b> <span className={`tag ${row.status === 'online' ? 'ok' : 'mute'}`}>{!row.enabled ? '已停用' : row.status === 'online' ? '心跳在线' : '离线'}</span>
      <p className="muted" style={{ overflowWrap: 'anywhere' }}>协议 {row.protocolVersion} · 客户端 {row.version} · 就绪资源 {row.ready.length}/{row.resources.length}<br />{row.resources.map(r => `${r.label} (${r.id})：${r.capabilities.map(c => c.operation).join('、')}`).join('；')}</p>
      {editable ? <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <button className="btn" disabled={busy} onClick={() => { if (window.confirm(`${row.enabled ? '停用后，该客户端不能领取或回报任务' : '重新启用后，需要新的心跳确认能力'}。确定？`)) void run(async () => { await localIntegrations.setEnabled(row.key, !row.enabled); }); }}>{row.enabled ? '停用连接' : '重新启用'}</button>
        <button className="btn" disabled={busy} onClick={() => { if (window.confirm(`轮换「${row.name}」密钥后，旧密钥立即失效；正在执行的任务可能需要人工核对。确定？`)) void run(() => localIntegrations.rotateSecret(row.key)); }}>轮换密钥</button>
      </div> : null}
    </div>)}
    <p className="muted">心跳只证明客户端联通；数据库回读、控制器确认和实际刷卡验证是不同层级，不能相互代替。</p>
  </section>;
}
