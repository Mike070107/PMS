import { useCallback, useEffect, useMemo, useState } from 'react';
import { request } from '@pms/api-client';
import { money } from '@/lib/format';
import { can } from '@/lib/perm';
import Icon from '@/components/Icon';
import { ConfirmModal, Loading, toast } from '@/components/ui';
import { FormModal, ResultNote, Toggle } from '@/components/settings/parts';
import { DEFAULT_GROUP, STANDARD_MONTHS, type ParkingRuleConfig, type PriceTier } from '@/lib/parking-pricing';
import ToneIcon from '@/components/ToneIcon';

interface Rule {
  id: number; serviceType: 'parking_monthly' | 'access_card'; name: string;
  communityId: number | null; billingUnit: 'month' | 'card'; unitPriceCents: number; enabled: boolean;
  config?: (ParkingRuleConfig & Record<string, unknown>) | null; createdAt?: string; updatedAt?: string;
}
interface Target { key: string; label: string; short?: string; system: 'deliyun' | 'local'; communities: string[]; billing: 'vehicle' | 'space' }
interface Community { id: number; name: string }
interface PlateTag { id: number; plate: string; vehicleClass: string; houseId: number | null; updatedAt: string }

const yuan = (cents: number) => (cents / 100).toFixed(2).replace(/\.00$/, '');
const toCents = (s: string) => { const n = Number(s); return s.trim() !== '' && Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : NaN; };
const normPlate = (s: string) => s.toUpperCase().replace(/[\s·.．・-]/g, '');
const PLATE = /^[\u4e00-\u9fa5][A-Z][A-Z0-9]{5,6}$/;
const err = (e: unknown, f: string) => (e instanceof Error && e.message ? e.message : f);

type Draft = { id?: number; name: string; communityId: number | null; targets: string[]; isDefault: boolean; enabled: boolean; rows: Array<{ months: string; amount: string }> };

/**
 * 收费标准 = 车辆类别（住户车/亲情车/租户车 等）。
 * 先建分组（如「默认分组」「小车内场180」「大车500」），分组下按缴费月数各定一个金额；
 * 再把车牌归到分组。收银台续期时，车牌在哪个分组就按哪张价格表收，只能选表里有的月数。
 */
export default function Standards() {
  const canEdit = can('business', 'edit');
  const [tab, setTab] = useState<'groups' | 'plates' | 'card'>('groups');
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [targets, setTargets] = useState<Target[]>([]);
  const [communities, setCommunities] = useState<Community[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [cid, setCid] = useState<number | 0>(0);

  const load = useCallback(async () => {
    try { setRules(await request<Rule[]>({ url: '/business/rules' })); } catch (e) { toast(err(e, '读取收费标准失败')); setRules([]); }
    request<{ counts: Record<string, number> }>({ url: '/business/plate-tags/list', query: { q: '#none#' } }).then((r) => setCounts(r?.counts ?? {})).catch(() => undefined);
  }, []);
  useEffect(() => {
    void load();
    request<Target[]>({ url: '/business/parking-targets' }).then(setTargets).catch(() => setTargets([]));
    request<Community[]>({ url: '/communities' }).then(setCommunities).catch(() => setCommunities([]));
  }, [load]);

  const groups = useMemo(() => (rules ?? []).filter((r) => r.serviceType === 'parking_monthly' && (!cid || r.communityId === cid || r.communityId == null)), [rules, cid]);
  const groupNames = useMemo(() => [...new Set((rules ?? []).filter((r) => r.serviceType === 'parking_monthly' && r.enabled).map((r) => r.config?.vehicleClass || DEFAULT_GROUP))], [rules]);
  const cardRules = (rules ?? []).filter((r) => r.serviceType === 'access_card');

  if (rules === null) return <Loading />;
  return (
    <>
      <div className="ph" style={{ marginBottom: 14 }}>
        <div><div className="h1row"><ToneIcon kind="standards" /><h1 style={{ fontSize: 22 }}>收费标准</h1></div><p>按车辆类别（住户车/亲情车/租户车）定价、定好每个月数的金额，再把车牌归到类别；收银台按车牌所属类别收费</p></div>
      </div>
      <div className="tabs" style={{ display: 'flex', gap: 22, borderBottom: '1px solid var(--line)', marginBottom: 14 }}>
        {([['groups', '车辆类别'], ['plates', '车牌归属类别'], ['card', '门禁卡']] as const).map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      {tab === 'groups' ? <GroupsTab groups={groups} all={rules} targets={targets} communities={communities} cid={cid} setCid={setCid} counts={counts} canEdit={canEdit} reload={load} /> : null}
      {tab === 'plates' ? <PlatesTab groupNames={groupNames} canEdit={canEdit} onChanged={load} /> : null}
      {tab === 'card' ? <CardTab rules={cardRules} communities={communities} canEdit={canEdit} reload={load} /> : null}
    </>
  );
}

/* ───────── 车辆类别 ───────── */
function GroupsTab({ groups, all, targets, communities, cid, setCid, counts, canEdit, reload }: {
  groups: Rule[]; all: Rule[]; targets: Target[]; communities: Community[]; cid: number; setCid: (v: number) => void; counts: Record<string, number>; canEdit: boolean; reload: () => Promise<void>;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<Rule | null>(null);
  const [fill, setFill] = useState('');
  const cname = (id: number | null) => (id == null ? '全部小区（通用）' : communities.find((c) => c.id === id)?.name || `小区 #${id}`);
  const tLabel = (k: string) => { const t = targets.find((x) => x.key === k); return t?.short || t?.label || k; };
  const targetsOf = (id: number | null) => { const n = communities.find((c) => c.id === id)?.name; return n ? targets.filter((t) => t.communities.includes(n)) : []; };
  const tiersOf = (r: Rule) => [...(r.config?.tiers ?? [])].sort((a, b) => a.months - b.months);

  const open = (r?: Rule) => setDraft(r ? {
    id: r.id, name: r.config?.vehicleClass || r.name, communityId: r.communityId, targets: r.config?.parkingTargets ?? (r.config?.parkingTarget ? [r.config.parkingTarget] : []),
    isDefault: !!r.config?.isDefault, enabled: r.enabled, rows: tiersOf(r).map((t) => ({ months: String(t.months), amount: yuan(t.amountCents) })),
  } : { name: '', communityId: cid || communities[0]?.id || null, targets: [], isDefault: false, enabled: true, rows: STANDARD_MONTHS.map((m) => ({ months: String(m), amount: '' })) });

  /** 车辆类别配色：住户车绿、亲情车蓝、租户车琥珀（和收银台停车缴费同色） */
  const classTone = (name?: string | null) => {
    const n = name || '';
    if (n.includes('亲情')) return 'acc';
    if (n.includes('租')) return 'warn';
    return 'ok';
  };
  const PRESET_CLASSES = ['住户车', '亲情车', '租户车'];
  const quickCreate = (name: string) => {
    if (!canEdit) return;
    setDraft({ name, communityId: cid || communities[0]?.id || null, targets: [], isDefault: false, enabled: true, rows: STANDARD_MONTHS.map((m) => ({ months: String(m), amount: '' })) });
  };

  const check = (d: Draft): string => {
    if (!d.name.trim()) return '请填写车辆类别名称';
    if (d.name.trim().length > 20) return '车辆类别名称最多 20 个字';
    if (!d.rows.length) return '价格表至少要有一行';
    const seen = new Set<number>();
    for (const r of d.rows) {
      const m = Number(r.months);
      if (!Number.isInteger(m) || m < 1 || m > 60) return '缴费月数要填 1~60 的整数';
      if (seen.has(m)) return `${m} 个月重复了`;
      seen.add(m);
      if (Number.isNaN(toCents(r.amount))) return `请填写 ${m} 个月的金额`;
    }
    return '';
  };
  const save = async () => {
    if (!draft) return;
    const problem = check(draft);
    if (problem) return toast(problem);
    const tiers: PriceTier[] = draft.rows.map((r) => ({ months: Number(r.months), amountCents: toCents(r.amount) })).sort((a, b) => a.months - b.months);
    const prev = draft.id ? all.find((r) => r.id === draft.id) : null;
    setBusy(true);
    try {
      await request({ method: draft.id ? 'PATCH' : 'POST', url: draft.id ? `/business/rules/${draft.id}` : '/business/rules', data: {
        serviceType: 'parking_monthly', name: draft.name.trim(), communityId: draft.communityId, billingUnit: 'month', unitPriceCents: tiers[0].amountCents, enabled: draft.enabled,
        config: { ...(prev?.config ?? {}), vehicleClass: draft.name.trim(), tiers, parkingTargets: draft.targets, isDefault: draft.isDefault, priceMode: 'table' },
      } });
      toast('分组已保存'); setDraft(null); await reload();
    } catch (e) { toast(err(e, '保存失败，填写内容已保留')); }
    finally { setBusy(false); }
  };
  const toggle = async (r: Rule) => {
    try {
      await request({ method: 'PATCH', url: `/business/rules/${r.id}`, data: { serviceType: r.serviceType, name: r.name, communityId: r.communityId, billingUnit: r.billingUnit, unitPriceCents: r.unitPriceCents, config: r.config ?? {}, enabled: !r.enabled } });
      toast(r.enabled ? '已停用' : '已启用'); await reload();
    } catch (e) { toast(err(e, '操作失败')); }
  };
  const setRow = (i: number, p: Partial<Draft['rows'][number]>) => draft && setDraft({ ...draft, rows: draft.rows.map((x, j) => (j === i ? { ...x, ...p } : x)) });
  const problem = draft ? check(draft) : '';
  const avail = draft ? targetsOf(draft.communityId) : [];

  return (
    <>
      <div className="set-inline" style={{ marginBottom: 12 }}>
        <span style={{ fontWeight: 600 }}>小区</span>
        <select className="in" style={{ width: 220 }} value={cid} onChange={(e) => setCid(Number(e.target.value))}>
          <option value={0}>全部小区</option>{communities.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        {canEdit ? (
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="muted" style={{ fontSize: 13 }}>系统三类：</span>
            {PRESET_CLASSES.map((n) => (
              <button key={n} className={`btn sm`} onClick={() => quickCreate(n)} title={`新增「${n}」车辆类别`}>
                <span className={`tag ${classTone(n)}`} style={{ marginRight: 6 }}>{n}</span>添加
              </button>
            ))}
            <button className="btn p" onClick={() => open()}><Icon name="plus" size={16} />新增车辆类别</button>
          </div>
        ) : null}
      </div>
      <div className="card t-scroll">
        <table className="t" style={{ minWidth: 960 }}>
          <thead><tr><th style={{ width: 54 }}>序号</th><th>车辆类别</th><th>适用小区 / 车库</th><th>价格表（缴费月数 → 金额）</th><th style={{ width: 80, textAlign: 'right' }}>车牌数</th><th style={{ width: 90 }}>启用</th>{canEdit ? <th style={{ width: 130 }}>操作</th> : null}</tr></thead>
          <tbody>
            {groups.map((r, i) => {
              const ts = r.config?.parkingTargets ?? (r.config?.parkingTarget ? [r.config.parkingTarget] : []);
              const g = r.config?.vehicleClass || r.name;
              return (
                <tr key={r.id} style={r.enabled ? undefined : { opacity: 0.55 }}>
                  <td className="nw muted">{i + 1}</td>
                  <td className="nw"><span className={`tag ${classTone(g)}`}><b style={{ fontWeight: 600 }}>{g}</b></span>{r.config?.isDefault ? <span className="tag mute" style={{ marginLeft: 6 }}>默认</span> : null}</td>
                  <td>{cname(r.communityId)}<div className="sub2">{ts.length ? ts.map(tLabel).join('、') : '全部车库'}</div></td>
                  <td style={{ minWidth: 380 }}><div className="set-tags">{tiersOf(r).map((t) => <span key={t.months} className="acc">{t.months} 个月 <b>{money(t.amountCents / 100)}</b></span>)}{!tiersOf(r).length ? <span className="warn">未设价格</span> : null}</div></td>
                  <td className="nw" style={{ textAlign: 'right' }}>{counts?.[g] ?? 0}</td>
                  <td><Toggle on={r.enabled} disabled={!canEdit} onChange={() => void toggle(r)} /></td>
                  {canEdit ? <td className="nw"><button className="btn g sm" onClick={() => open(r)}><Icon name="edit" size={15} />编辑</button><button className="btn g sm" style={{ color: 'var(--dang)' }} onClick={() => setRemoving(r)}><Icon name="trash" size={15} /></button></td> : null}
                </tr>
              );
            })}
            {!groups.length ? <tr><td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 28 }}>还没有车辆类别，点「新增车辆类别」或直接添加系统三类</td></tr> : null}
          </tbody>
        </table>
      </div>
      <div className="note2" style={{ marginTop: 12 }}><Icon name="alert" />没归到分组的车按本小区（对应车库）的「默认分组」收费；改价只影响之后的收款，已收的款保存当时的价格。</div>

      <FormModal open={!!draft} width={640} title={draft?.id ? `编辑车辆类别 · ${draft.name}` : '新增车辆类别'} onClose={() => setDraft(null)} onOk={() => void save()} busy={busy}>
        {draft ? <>
          <label>车辆类别名称<input className="in" maxLength={20} value={draft.name} placeholder="如：业主车、租客车、大车、小车内场180" onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            <span className="hint">车牌按分组名匹配；改名后分组里的车牌自动跟着改。</span></label>
          <label>适用小区<select className="in" value={draft.communityId ?? ''} onChange={(e) => setDraft({ ...draft, communityId: e.target.value ? Number(e.target.value) : null, targets: [] })}>
            {communities.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}<option value="">全部小区（通用）</option></select></label>
          <div className="set-field">适用车库
            <div className="set-inline" style={{ fontWeight: 400 }}>
              {avail.length ? avail.map((t) => (
                <label key={t.key} className="set-inline" style={{ gap: 5 }}><input type="checkbox" checked={draft.targets.includes(t.key)} onChange={(e) => setDraft({ ...draft, targets: e.target.checked ? [...draft.targets, t.key] : draft.targets.filter((k) => k !== t.key) })} />{t.short || t.label}</label>
              )) : <span className="muted">这个小区没有接入的车库</span>}
            </div>
            <span className="hint">都不勾 = 本小区全部车库都用这个分组。</span>
          </div>
          <div className="set-inline" style={{ gap: 18 }}>
            <Toggle on={draft.isDefault} onChange={(isDefault) => setDraft({ ...draft, isDefault })} label={['默认分组', '不是默认分组']} />
            <Toggle on={draft.enabled} onChange={(enabled) => setDraft({ ...draft, enabled })} label={['启用', '停用']} />
          </div>
          <div className="set-field">价格表
            <span className="hint">每个可选的缴费月数一行；收银台只能选这里列出的月数，金额就是这一格。</span>
          </div>
          <table className="t">
            <thead><tr><th style={{ width: 150 }}>缴费月数</th><th>金额（元）</th><th style={{ width: 110 }}>折合每月</th><th style={{ width: 50 }} /></tr></thead>
            <tbody>{draft.rows.map((r, i) => {
              const m = Number(r.months); const c = toCents(r.amount);
              return (
                <tr key={i}>
                  <td><span className="set-inline"><input className="in" style={{ width: 70 }} inputMode="numeric" value={r.months} onChange={(e) => setRow(i, { months: e.target.value.replace(/\D/g, '') })} />个月</span></td>
                  <td><input className="in" style={{ width: 140 }} inputMode="decimal" value={r.amount} placeholder="0" onChange={(e) => setRow(i, { amount: e.target.value })} /></td>
                  <td className="nw muted">{m > 0 && !Number.isNaN(c) ? `${money(c / 100 / m)}/月` : '—'}</td>
                  <td><button className="btn g sm" title="删除这一行" onClick={() => setDraft({ ...draft, rows: draft.rows.filter((_, j) => j !== i) })}>✕</button></td>
                </tr>
              );
            })}</tbody>
          </table>
          <div className="set-inline">
            <button className="btn sm" onClick={() => setDraft({ ...draft, rows: [...draft.rows, { months: '', amount: '' }] })}><Icon name="plus" size={14} />加一行</button>
            <span className="muted" style={{ marginLeft: 8 }}>按月单价一键填：</span>
            <input className="in" style={{ width: 90 }} inputMode="decimal" placeholder="元/月" value={fill} onChange={(e) => setFill(e.target.value)} />
            <button className="btn sm" disabled={Number.isNaN(toCents(fill))} onClick={() => setDraft({ ...draft, rows: draft.rows.map((r) => (Number(r.months) > 0 ? { ...r, amount: yuan(toCents(fill) * Number(r.months)) } : r)) })}>填入</button>
            <button className="btn sm" disabled={Number.isNaN(toCents(fill))} title="12 个月按 10 个月收" onClick={() => { const u = toCents(fill); const rows = draft.rows.some((r) => r.months === '12') ? draft.rows : [...draft.rows, { months: '12', amount: '' }]; setDraft({ ...draft, rows: rows.map((r) => (r.months === '12' ? { ...r, amount: yuan(u * 10) } : r)) }); }}>交 12 个月优惠 2 个月</button>
          </div>
          {problem ? <ResultNote ok={false}>{problem}</ResultNote> : null}
        </> : null}
      </FormModal>
      <ConfirmModal open={!!removing} onClose={() => setRemoving(null)} title={`删除分组「${removing?.config?.vehicleClass || removing?.name || ''}」？`} danger confirmText="删除"
        onConfirm={async () => { const r = removing!; setRemoving(null); try { await request({ method: 'DELETE', url: `/business/rules/${r.id}` }); toast('分组已删除'); await reload(); } catch (e) { toast(err(e, '删除失败')); } }}>
        分组里的车牌会移出分组（之后按默认分组收）。已经收过款的分组不能删，只能停用。
      </ConfirmModal>
    </>
  );
}

/* ───────── 车牌分组 ───────── */
function PlatesTab({ groupNames, canEdit, onChanged }: { groupNames: string[]; canEdit: boolean; onChanged: () => Promise<void> }) {
  const [group, setGroup] = useState('');
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<PlateTag[] | null>(null);
  const [adding, setAdding] = useState<{ plates: string; group: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const load = useCallback(() => {
    request<{ rows: PlateTag[] }>({ url: '/business/plate-tags/list', query: { ...(group ? { group } : {}), ...(q.trim() ? { q: q.trim() } : {}) } }).then((r) => setRows(r.rows)).catch((e) => { toast(err(e, '读取失败')); setRows([]); });
  }, [group, q]);
  useEffect(() => { load(); }, [group]); // eslint-disable-line react-hooks/exhaustive-deps
  const setTag = async (plate: string, g: string) => {
    try { await request({ method: 'POST', url: '/business/plate-tags', data: { plate, vehicleClass: g } }); toast(g ? `${plate} 已归入「${g}」` : `${plate} 已移出分组`); load(); await onChanged(); }
    catch (e) { toast(err(e, '操作失败')); }
  };
  const bulk = async () => {
    if (!adding) return;
    const plates = [...new Set(adding.plates.split(/[\s,，、;；]+/).map(normPlate).filter(Boolean))];
    const bad = plates.filter((p) => !PLATE.test(p));
    if (!plates.length) return toast('请输入车牌');
    if (!adding.group) return toast('请选择分组');
    setBusy(true); setResult(null);
    let ok = 0; const fail: string[] = [...bad.map((p) => `${p}（格式不对）`)];
    for (const p of plates.filter((x) => PLATE.test(x))) {
      try { await request({ method: 'POST', url: '/business/plate-tags', data: { plate: p, vehicleClass: adding.group } }); ok++; }
      catch (e) { fail.push(`${p}（${err(e, '失败')}）`); }
    }
    setBusy(false);
    setResult({ ok: !fail.length, text: `已归入「${adding.group}」${ok} 辆${fail.length ? `；没成功 ${fail.length} 辆：${fail.join('、')}` : ''}` });
    if (!fail.length) setAdding(null);
    load(); await onChanged();
  };
  return (
    <>
      <div className="set-inline" style={{ marginBottom: 12 }}>
        <span style={{ fontWeight: 600 }}>车辆类别</span>
        <select className="in" style={{ width: 200 }} value={group} onChange={(e) => setGroup(e.target.value)}><option value="">全部分组</option>{groupNames.map((g) => <option key={g}>{g}</option>)}</select>
        <input className="in" style={{ width: 200 }} placeholder="车牌，如 沪A123" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') load(); }} />
        <button className="btn" onClick={load}><Icon name="search" size={16} />查询</button>
        <button className="btn" onClick={() => { setQ(''); setGroup(''); setTimeout(load); }}>清除</button>
        {canEdit ? <button className="btn p" style={{ marginLeft: 'auto' }} onClick={() => { setResult(null); setAdding({ plates: '', group: group || groupNames[0] || '' }); }}><Icon name="plus" size={16} />车牌归入分组</button> : null}
      </div>
      {result ? <ResultNote ok={result.ok}>{result.text}</ResultNote> : null}
      {rows === null ? <Loading /> : (
        <div className="card t-scroll">
          <table className="t" style={{ minWidth: 640 }}>
            <thead><tr><th style={{ width: 54 }}>序号</th><th>车牌</th><th>所属分组</th><th>最后修改时间</th>{canEdit ? <th style={{ width: 260 }}>改分组</th> : null}</tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.id}>
                  <td className="nw muted">{i + 1}</td>
                  <td className="nw"><b className="plate">{r.plate}</b></td>
                  <td className="nw">{r.vehicleClass}{groupNames.includes(r.vehicleClass) ? null : <span className="tag warn" style={{ marginLeft: 6 }}>分组已停用</span>}</td>
                  <td className="nw muted">{(r.updatedAt || '').slice(0, 16).replace('T', ' ')}</td>
                  {canEdit ? <td className="nw"><span className="set-inline">
                    <select className="in" style={{ width: 150 }} value={r.vehicleClass} onChange={(e) => void setTag(r.plate, e.target.value)}>
                      {[...new Set([r.vehicleClass, ...groupNames])].map((g) => <option key={g}>{g}</option>)}</select>
                    <button className="btn g sm" onClick={() => void setTag(r.plate, '')}>移出</button></span></td> : null}
                </tr>
              ))}
              {!rows.length ? <tr><td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 28 }}>没有车牌。收银台续期时选了分组的车会自动出现在这里，也可以点「车牌归入分组」批量加。</td></tr> : null}
            </tbody>
          </table>
        </div>
      )}
      <FormModal open={!!adding} title="车牌归入分组" okText="归入" onClose={() => setAdding(null)} onOk={() => void bulk()} busy={busy}>
        {adding ? <>
          <label>分组<select className="in" value={adding.group} onChange={(e) => setAdding({ ...adding, group: e.target.value })}>{groupNames.map((g) => <option key={g}>{g}</option>)}</select></label>
          <label>车牌<textarea className="in" rows={6} value={adding.plates} placeholder={'一行一个，或用逗号、空格隔开\n沪A12345\n沪BD12345'} onChange={(e) => setAdding({ ...adding, plates: e.target.value })} />
            <span className="hint">已在别的分组里的车牌会改到这个分组。</span></label>
        </> : null}
      </FormModal>
    </>
  );
}

/* ───────── 门禁卡 ───────── */
function CardTab({ rules, communities, canEdit, reload }: { rules: Rule[]; communities: Community[]; canEdit: boolean; reload: () => Promise<void> }) {
  const [edit, setEdit] = useState<{ r: Rule; price: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const cname = (id: number | null) => (id == null ? '全部小区' : communities.find((c) => c.id === id)?.name || `小区 #${id}`);
  const save = async () => {
    if (!edit) return;
    const cents = toCents(edit.price);
    if (Number.isNaN(cents)) return toast('请输入正确的金额');
    setBusy(true);
    try { const r = edit.r; await request({ method: 'PATCH', url: `/business/rules/${r.id}`, data: { serviceType: 'access_card', name: r.name, communityId: r.communityId, billingUnit: 'card', unitPriceCents: cents, enabled: r.enabled, config: r.config ?? {} } }); toast('已保存'); setEdit(null); await reload(); }
    catch (e) { toast(err(e, '保存失败')); } finally { setBusy(false); }
  };
  return (
    <div className="card t-scroll">
      <table className="t">
        <thead><tr><th>名称</th><th>适用小区</th><th style={{ textAlign: 'right' }}>单价</th><th>状态</th>{canEdit ? <th style={{ width: 100 }} /> : null}</tr></thead>
        <tbody>
          {rules.map((r) => (
            <tr key={r.id}><td className="nw"><b>{r.name}</b></td><td className="nw">{cname(r.communityId)}</td><td className="nw" style={{ textAlign: 'right' }}>{money(r.unitPriceCents / 100)} / 张</td>
              <td className="nw">{r.enabled ? <span className="tag ok">启用</span> : <span className="tag mute">停用</span>}</td>
              {canEdit ? <td className="nw"><button className="btn g sm" onClick={() => setEdit({ r, price: yuan(r.unitPriceCents) })}><Icon name="edit" size={15} />改价</button></td> : null}</tr>
          ))}
          {!rules.length ? <tr><td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 24 }}>还没有门禁卡规则</td></tr> : null}
        </tbody>
      </table>
      <FormModal open={!!edit} title={`改价 · ${edit?.r.name ?? ''}`} onClose={() => setEdit(null)} onOk={() => void save()} busy={busy}>
        {edit ? <label>每张（元）<input className="in" inputMode="decimal" autoFocus value={edit.price} onChange={(e) => setEdit({ ...edit, price: e.target.value })} /></label> : null}
      </FormModal>
    </div>
  );
}
