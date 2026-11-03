import { useEffect, useState } from 'react';
import { request } from '@pms/api-client';
import { toast } from '@/components/ui';
import { ResultNote, Row, Section, Toggle, errMsg } from './parts';

/** 与服务端 GET/PATCH /settings 同形。两个密钥读回来是脱敏串，原样交回 = 不改 */
export interface TenantSettings {
  ownerPhoneAutoMatch: { enabled: boolean };
  wxSubscribeTemplates: Record<TemplateKey, string>;
  autoReview: { hours: number };
  purchaseApproval?: PurchaseFlow;
  dispatchEscalation: { enabled: boolean; acceptMinutes: number; startAt: string; endAt: string };
  wxServiceAccount: { appId: string; appSecret: string; templateOrderAssigned: string; enabled: boolean };
  aiAssist: {
    enabled: boolean; baseUrl: string; model: string; apiKey: string; timeoutMs: number; cacheDays: number;
    priceInputMissPerM: number; priceInputHitPerM: number; priceOutputPerM: number;
  };
}
export type TemplateKey = 'orderDispatched' | 'orderReview' | 'orderAssigned' | 'orderOverdue' | 'orderUrge';
export interface PurchaseFlow { office: 'summary' | 'approve' | 'off'; manager: boolean; purchaser: boolean; skipManagerBelowYuan: number; skipPurchaserBelowYuan: number }
export type SaveSettings = (patch: Partial<TenantSettings>, ok: string) => Promise<TenantSettings | null>;
interface SectionProps { settings: TenantSettings; save: SaveSettings; canEdit: boolean }

const HOURS = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, '0')}:00`);

/* ───────── 工单：自动验收 ───────── */
export function AutoReviewSection({ settings, save, canEdit }: SectionProps) {
  const [hours, setHours] = useState(settings.autoReview?.hours ?? 48);
  const [busy, setBusy] = useState(false);
  useEffect(() => setHours(settings.autoReview?.hours ?? 48), [settings.autoReview?.hours]);
  const ok = Number.isInteger(hours) && hours >= 1 && hours <= 720;
  return (
    <Section title="工单自动验收" desc={<>维修工提交完工后，业主在设定时间内没有验收，系统自动完成工单并记录「系统自动验收」。建议 48～72 小时。</>}>
      <div className="set-inline">
        <span>业主</span>
        <input className="in" type="number" min={1} max={720} style={{ width: 110 }} value={hours} disabled={!canEdit} onChange={(e) => setHours(Math.round(Number(e.target.value)))} />
        <span>小时不验收，就由系统自动验收</span>
        {canEdit ? <button className="btn p" disabled={busy || !ok || hours === settings.autoReview?.hours}
          onClick={async () => { setBusy(true); await save({ autoReview: { hours } }, '已保存，现有待验收工单也按新时限执行'); setBusy(false); }}>{busy ? '保存中…' : '保存'}</button> : null}
      </div>
      {!ok ? <ResultNote ok={false}>请填 1～720 之间的整数</ResultNote> : null}
      <p className="muted" style={{ fontSize: 14, margin: '12px 0 0' }}>修改后立即生效，已经处于待验收的工单也使用新时限。</p>
    </Section>
  );
}

/* ───────── 工单：超时催办 ───────── */
export function EscalationSection({ settings, save, canEdit }: SectionProps) {
  const [v, setV] = useState(settings.dispatchEscalation);
  const [busy, setBusy] = useState(false);
  useEffect(() => setV(settings.dispatchEscalation), [settings.dispatchEscalation]);
  const dirty = JSON.stringify(v) !== JSON.stringify(settings.dispatchEscalation);
  const ok = v.acceptMinutes >= 5 && v.acceptMinutes <= 1440;
  return (
    <Section title="超时没人接单，自动催办"
      desc="工单进了池子或派出去后迟迟没人接单，系统再提醒该接的人一次，同时通知所有能派单的人「这单还没人接」，进度里留一条记录。每张单只催一次。"
      extra={<Toggle on={v.enabled} disabled={!canEdit} onChange={(enabled) => setV({ ...v, enabled })} label={['已开启', '已关闭']} />}>
      <div className="set-inline">
        <span>超过</span>
        <input className="in" type="number" min={5} max={1440} style={{ width: 100 }} value={v.acceptMinutes} disabled={!canEdit || !v.enabled} onChange={(e) => setV({ ...v, acceptMinutes: Math.round(Number(e.target.value)) })} />
        <span>分钟没人接就催，只在</span>
        <select className="in" style={{ width: 100 }} value={v.startAt} disabled={!canEdit || !v.enabled} onChange={(e) => setV({ ...v, startAt: e.target.value })}>{HOURS.map((h) => <option key={h}>{h}</option>)}</select>
        <span>～</span>
        <select className="in" style={{ width: 100 }} value={v.endAt} disabled={!canEdit || !v.enabled} onChange={(e) => setV({ ...v, endAt: e.target.value })}>{HOURS.map((h) => <option key={h}>{h}</option>)}</select>
        <span>之间催</span>
      </div>
      {!ok ? <ResultNote ok={false}>时限请填 5～1440 分钟</ResultNote> : null}
      {canEdit ? <div className="set-actions"><button className="btn p" disabled={busy || !dirty || !ok}
        onClick={async () => { setBusy(true); const n = await save({ dispatchEscalation: v }, v.enabled ? `已保存，${v.startAt}～${v.endAt} 之间才会催` : '已关闭催办提醒'); if (n) setV(n.dispatchEscalation); setBusy(false); }}>{busy ? '保存中…' : '保存'}</button></div> : null}
      <p className="muted" style={{ fontSize: 14, margin: '12px 0 0', lineHeight: 1.7 }}>
        建议 30～60 分钟。时段外一条都不发，到点的单等第二天窗口一开照样催；起止选同一个点表示全天都催。
        催办用「通知」里「超时没人接单」那个模板，没填就退回用新工单模板。
      </p>
    </Section>
  );
}

/* ───────── 物资：采购审批链 ───────── */
const DEFAULT_FLOW: PurchaseFlow = { office: 'summary', manager: true, purchaser: true, skipManagerBelowYuan: 0, skipPurchaserBelowYuan: 0 };
function flowSummary(f: PurchaseFlow) {
  const parts: string[] = [];
  if (f.office === 'approve') parts.push('办公室审批'); else if (f.office === 'summary') parts.push('办公室汇总');
  if (f.manager) parts.push(f.skipManagerBelowYuan > 0 ? `物业经理（低于 ¥${f.skipManagerBelowYuan} 跳过）` : '物业经理');
  if (f.purchaser) parts.push(f.skipPurchaserBelowYuan > 0 ? `采购部（低于 ¥${f.skipPurchaserBelowYuan} 跳过）` : '采购部');
  return parts.length ? `${parts.join(' → ')} → 通过下单` : '没有任何审批环节，缺料一提就可下单';
}
export function PurchaseChainSection({ settings, save, canEdit }: SectionProps) {
  const base = { ...DEFAULT_FLOW, ...(settings.purchaseApproval || {}) };
  const [f, setF] = useState<PurchaseFlow>(base);
  const [busy, setBusy] = useState(false);
  useEffect(() => setF({ ...DEFAULT_FLOW, ...(settings.purchaseApproval || {}) }), [settings.purchaseApproval]);
  const dirty = JSON.stringify(f) !== JSON.stringify(base);
  const none = !f.manager && !f.purchaser && f.office !== 'approve';
  const money = (k: 'skipManagerBelowYuan' | 'skipPurchaserBelowYuan', on: boolean) => (
    <span className="set-inline"><span>预估金额低于 ¥</span>
      <input className="in" type="number" min={0} step="0.01" style={{ width: 120 }} value={f[k]} disabled={!canEdit || !on} onChange={(e) => setF({ ...f, [k]: Math.max(0, Number(e.target.value) || 0) })} />
      <span>元时跳过（0 = 不跳）</span></span>
  );
  return (
    <Section title="采购审批链" desc={<>缺料申请固定按 <b>办公室 → 物业经理 → 采购部 → 通过下单</b> 流转，每一环可以关掉，经理和采购部还能按预估金额跳过。</>}>
      <div className="set-note">当前：{flowSummary(f)}</div>
      <Row label="办公室">
        <div className="set-inline">
          {([['summary', '只汇总合并，不算审批'], ['approve', '汇总并审批（记审批人）'], ['off', '不经过办公室']] as const).map(([k, l]) =>
            <button key={k} className={`chip ${f.office === k ? 'on' : ''}`} disabled={!canEdit} onClick={() => setF({ ...f, office: k })}>{l}</button>)}
        </div>
      </Row>
      <Row label="物业经理"><div className="set-inline"><Toggle on={f.manager} disabled={!canEdit} onChange={(manager) => setF({ ...f, manager })} label={['审批', '跳过']} />{money('skipManagerBelowYuan', f.manager)}</div></Row>
      <Row label="采购部"><div className="set-inline"><Toggle on={f.purchaser} disabled={!canEdit} onChange={(purchaser) => setF({ ...f, purchaser })} label={['审批', '跳过']} />{money('skipPurchaserBelowYuan', f.purchaser)}</div></Row>
      {none ? <ResultNote ok={false}>现在没有任何审批环节：缺料一提就直接通过、可下单。确认这是你要的再保存。</ResultNote> : null}
      {canEdit ? <div className="set-actions"><button className="btn p" disabled={busy || !dirty}
        onClick={async () => { setBusy(true); await save({ purchaseApproval: f }, '审批链已保存'); setBusy(false); }}>{busy ? '保存中…' : '保存审批链'}</button></div> : null}
      <p className="muted" style={{ fontSize: 14, margin: '12px 0 0' }}>立即生效：流转中的申请下一步按新配置走；派单、撤回、作废、审批各自在「员工与权限」的角色里授权。</p>
    </Section>
  );
}

/* ───────── 通知：小程序订阅消息 ───────── */
const TEMPLATES: Array<{ key: TemplateKey; label: string; app: string }> = [
  { key: 'orderDispatched', label: '已派单通知业主', app: '业主端' },
  { key: 'orderReview', label: '待验收通知业主', app: '业主端' },
  { key: 'orderAssigned', label: '新工单派给维修工', app: '员工端' },
  { key: 'orderOverdue', label: '超时没人接单，催办维修工', app: '员工端' },
  { key: 'orderUrge', label: '办公室催修（工单详情里手动发）', app: '员工端' },
];
const FIELD_FROM: Record<string, string> = { orderNo: '工单编号', type: '报修类型', status: '工单状态', content: '报修内容', assignee: '维修工', address: '报修地址', reporter: '报修人', time: '提醒时间', reportedAt: '报修时间', dueAt: '要求完成截止' };
interface TplResult { ok: boolean; error?: string; fields?: Array<{ key: string; label: string; from: string; value: string }>; remaining?: number; kind: 'check' | 'test' }

export function SubscribeSection({ settings, save, canEdit }: SectionProps) {
  const [tpl, setTpl] = useState<Record<TemplateKey, string>>({ ...settings.wxSubscribeTemplates });
  const [result, setResult] = useState<Partial<Record<TemplateKey, TplResult>>>({});
  const [busy, setBusy] = useState('');
  useEffect(() => setTpl({ ...settings.wxSubscribeTemplates }), [settings.wxSubscribeTemplates]);
  const saved = (k: TemplateKey) => (settings.wxSubscribeTemplates?.[k] || '').trim();
  const dirty = TEMPLATES.some((t) => (tpl[t.key] || '').trim() !== saved(t.key));
  const run = async (k: TemplateKey, kind: 'check' | 'test') => {
    setBusy(`${kind}:${k}`);
    try {
      const r = await request<Omit<TplResult, 'kind'>>({ method: 'POST', url: `/notifications/templates/${kind}`, data: kind === 'check' ? { template: k, templateId: (tpl[k] || '').trim() || undefined } : { template: k } });
      setResult((p) => ({ ...p, [k]: { ...r, kind } }));
      if (kind === 'test' && r.ok) toast('已发出，看看微信有没有收到');
    } catch (e) { setResult((p) => ({ ...p, [k]: { ok: false, error: errMsg(e, kind === 'check' ? '校验失败' : '发送失败'), kind } })); }
    finally { setBusy(''); }
  };
  return (
    <Section title="小程序订阅消息" desc={<>填了模板 ID，业主能在微信里收到「已派单」「修好了待验收」，维修工能收到「有新工单」；留空只写站内消息。</>}>
      <div className="set-note">
        模板在 <b>微信公众平台 → 订阅消息 → 我的模板</b> 里申请或从公共模板库选用。关键词随便选，系统按关键词意思自动填内容，点「校验」能看到每个关键词会填成什么。
        <br /><b>模板不能跨小程序用</b>：业主端的在「邻修管家」里申请，员工端的在「邻修管理」里申请。
      </div>
      {TEMPLATES.map((t) => {
        const v = tpl[t.key] || '';
        const r = result[t.key];
        return (
          <Row key={t.key} label={t.label} hint={`${t.app}小程序的模板`}>
            <div className="set-inline">
              <input className="in" style={{ flex: 1, minWidth: 220 }} value={v} disabled={!canEdit} placeholder="从公众平台复制模板 ID" onChange={(e) => setTpl({ ...tpl, [t.key]: e.target.value })} />
              <button className="btn" disabled={!v.trim() || !!busy} onClick={() => void run(t.key, 'check')}>{busy === `check:${t.key}` ? '校验中…' : '校验'}</button>
              {canEdit ? <button className="btn" disabled={!v.trim() || v.trim() !== saved(t.key) || !!busy} title={v.trim() !== saved(t.key) ? '先保存再测' : undefined}
                onClick={() => void run(t.key, 'test')}>{busy === `test:${t.key}` ? '发送中…' : '发我一条测试'}</button> : null}
            </div>
            {r ? (
              <ResultNote ok={r.ok}>
                {r.ok ? (r.kind === 'test' ? `已发出（这个模板你还剩 ${r.remaining ?? 0} 条额度）` : '模板可用，发送时会这样填：') : r.error}
                {r.fields?.length ? <div style={{ marginTop: 4 }}>{r.fields.map((f) => <div key={f.key}><b>{f.label || f.key}</b> ← {FIELD_FROM[f.from] || f.from}：{f.value}</div>)}</div> : null}
              </ResultNote>
            ) : null}
          </Row>
        );
      })}
      {canEdit ? <div className="set-actions"><button className="btn p" disabled={!dirty || busy === 'save'}
        onClick={async () => { setBusy('save'); await save({ wxSubscribeTemplates: Object.fromEntries(TEMPLATES.map((t) => [t.key, (tpl[t.key] || '').trim()])) as Record<TemplateKey, string> }, '已保存，下一条通知立即生效'); setBusy(''); }}>
        {busy === 'save' ? '保存中…' : '保存模板 ID'}</button></div> : null}
    </Section>
  );
}

/* ───────── 通知：服务号 ───────── */
export function ServiceAccountSection({ settings, save, canEdit }: SectionProps) {
  const [mp, setMp] = useState(settings.wxServiceAccount);
  const [busy, setBusy] = useState('');
  const [res, setRes] = useState<{ ok: boolean; message: string } | null>(null);
  useEffect(() => setMp(settings.wxServiceAccount), [settings.wxServiceAccount]);
  const dirty = JSON.stringify(mp) !== JSON.stringify(settings.wxServiceAccount);
  const action = async (kind: 'sync-followers' | 'test') => {
    setBusy(kind); setRes(null);
    try { const r = await request<{ ok: boolean; message: string }>({ method: 'POST', url: `/notifications/service-account/${kind}`, data: {} }); setRes({ ok: !!r.ok, message: r.message }); }
    catch (e) { setRes({ ok: false, message: errMsg(e, '请求失败') }); }
    finally { setBusy(''); }
  };
  return (
    <Section title="服务号通知维修工（推荐）"
      desc="小程序订阅消息「同意一次只能推一条」，额度用完就哑火。服务号模板消息只要维修工关注着就能一直推，点开直接跳到那张工单。"
      extra={<Toggle on={mp.enabled} disabled={!canEdit} onChange={(enabled) => setMp({ ...mp, enabled })} label={['已开启', '已关闭']} />}>
      <div className="set-note">
        开通前先确认三件事：
        <ol>
          <li>有一个<b>已认证的服务号</b>（企业主体）。未认证的订阅号发不了模板消息。</li>
          <li>服务号和员工端小程序绑在<b>同一个微信开放平台账号</b>下，系统才能把维修工和粉丝对上。</li>
          <li>维修工用<b>同一个微信号</b>关注服务号，并登录过员工端小程序。</li>
        </ol>
      </div>
      <Row label="服务号 AppID" hint="wx 开头，在服务号后台「设置与开发 → 基本配置」里">
        <input className="in" value={mp.appId} disabled={!canEdit} onChange={(e) => setMp({ ...mp, appId: e.target.value })} />
      </Row>
      <Row label="AppSecret" hint="保存后只回显后 4 位；不动它就是不改，换了 AppID 要重新填">
        <input className="in" type="password" autoComplete="new-password" value={mp.appSecret} placeholder="留空 = 保持原有密钥不变" disabled={!canEdit} onChange={(e) => setMp({ ...mp, appSecret: e.target.value })} />
      </Row>
      <Row label="「新工单」模板 ID" hint="选字段为 first / keyword1~4 / remark 的通用模板即可，按「单号 / 类型 / 地址 / 时间」依次填">
        <input className="in" value={mp.templateOrderAssigned} disabled={!canEdit} placeholder="服务号后台「广告与服务 → 模板消息」里复制" onChange={(e) => setMp({ ...mp, templateOrderAssigned: e.target.value })} />
      </Row>
      {canEdit ? (
        <div className="set-actions">
          <button className="btn p" disabled={!dirty || !!busy} onClick={async () => { setBusy('save'); setRes(null); const n = await save({ wxServiceAccount: mp }, '已保存'); if (n) setMp(n.wxServiceAccount); setBusy(''); }}>{busy === 'save' ? '保存中…' : '保存'}</button>
          <button className="btn" disabled={!!busy || dirty} title={dirty ? '先保存' : undefined} onClick={() => void action('sync-followers')}>{busy === 'sync-followers' ? '同步中…' : '同步关注者'}</button>
          <button className="btn" disabled={!!busy || dirty} title={dirty ? '先保存' : undefined} onClick={() => void action('test')}>{busy === 'test' ? '发送中…' : '给我发一条测试'}</button>
        </div>
      ) : null}
      {res ? <ResultNote ok={res.ok}>{res.message}</ResultNote> : null}
      <p className="muted" style={{ fontSize: 14, margin: '12px 0 0', lineHeight: 1.7 }}>
        维修工新关注服务号之后，点一次「同步关注者」系统才知道他是谁。开着服务号时派单通知优先走它；没关注的人自动退回小程序订阅消息，两条都不通时仍写进小程序里的「消息」。
      </p>
    </Section>
  );
}

/* ───────── 业主：手机号快速识别 ───────── */
export function PhoneMatchSection({ settings, save, canEdit }: SectionProps) {
  const [busy, setBusy] = useState(false);
  const [stat, setStat] = useState<{ ownersWithPhoneAndHouse: number; housesTotal: number } | null>(null);
  useEffect(() => { request<{ ownersWithPhoneAndHouse: number; housesTotal: number }>({ url: '/settings/phone-match-stat' }).then(setStat).catch(() => setStat(null)); }, []);
  const on = !!settings.ownerPhoneAutoMatch?.enabled;
  return (
    <Section title="业主手机号快速识别"
      desc="开启后，业主在小程序授权微信手机号，系统去房产档案里找同号业主，直接把地址带进报修单，不用扫码也不用填房号。"
      extra={<Toggle on={on} disabled={!canEdit || busy} onChange={async (enabled) => { setBusy(true); await save({ ownerPhoneAutoMatch: { enabled } }, enabled ? '已开启手机号快速识别' : '已关闭'); setBusy(false); }} label={['已开启', '已关闭']} />}>
      <p className="muted" style={{ fontSize: 14, margin: 0, lineHeight: 1.7 }}>
        匹配<b>不会自动建立绑定关系</b>——档案里的电话可能是上一任业主留的。正式绑定仍走「认证房屋 + 物业审核」；匹配不到时，业主回落到扫码带出的楼栋，只需填室号。
      </p>
      {stat ? (stat.ownersWithPhoneAndHouse === 0
        ? <ResultNote ok={false}>现在开启也匹配不到任何人：房产档案里有 {stat.housesTotal} 套房，但没有一条同时登记了业主手机号和房产。先在「业主」里补齐手机号，这个开关才有意义。</ResultNote>
        : <ResultNote ok>当前有 {stat.ownersWithPhoneAndHouse} 位业主登记了手机号并绑定了房产，可被匹配</ResultNote>) : null}
    </Section>
  );
}
