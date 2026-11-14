import DateInput from '@/components/DateInput';
import { useEffect, useMemo, useRef, useState } from 'react';
import { request } from '@pms/api-client';
import { FEE_ITEMS, formatFeeMoney } from '@pms/shared-types';
import { ConfirmModal, toast } from '@/components/ui';
import { dayjs } from '@/lib/format';
import { FormModal, ResultNote, Section, errMsg } from './parts';

/* 与旧后台 FeeTemplateSettings 同一套接口：/fees/templates/* */
type Kind = 'apartment' | 'residential';
type Item = { feeCode: string; unitPriceCents: number; unit: string; calculation: 'fixed' | 'quantity' | 'area'; cycle: 'month' | 'once'; originalStandardCents?: number | null };
type Version = { id: number; version: number; effective_from: string; items: Item[] };
type Template = { id: number; name: string; enabled: boolean; revision: number; assigned_count: number; versions: Version[] };
type Community = { id: number; name: string; kind: Kind };
type Building = { id: number; building_no: string; lane: string | null };
type House = { id: number; room_no: string; building_no: string; lane: string | null; owner_name: string | null; template_id: number | null; template_name: string | null; overrides: Record<string, number> | null; effective_from: string | null; has_legacy_standard: boolean };
type LegacyPreview = { fingerprint: string; houses: number; groups: Array<{ items: Item[]; houseIds: number[] }> };
type DraftItem = { feeCode: string; priceYuan: string; unit: string; calculation: Item['calculation']; cycle: Item['cycle']; originalStandardCents?: number | null };

const LABELS: Record<string, string> = Object.fromEntries(FEE_ITEMS.map((i) => [i.code, i.name]));
const CALC: Record<Item['calculation'], string> = { fixed: '固定金额', quantity: '按用量', area: '按建筑面积' };
const today = () => dayjs().format('YYYY-MM-DD');
const owns = (o: Record<string, number>, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const activeVersion = (t: Template, date: string) => t.versions.filter((v) => v.effective_from <= date).sort((a, b) => b.effective_from.localeCompare(a.effective_from) || b.version - a.version)[0];
const bLabel = (b: { lane: string | null; building_no: string }) => `${b.lane ? `${b.lane}弄` : ''}${b.building_no}号`;

export function FeeTemplatesSection({ canEdit, initialKind='residential', onlyKind=false }: { canEdit: boolean; initialKind?:Kind; onlyKind?:boolean }) {
  const [kind, setKind] = useState<Kind>(initialKind);
  const [communities, setCommunities] = useState<Community[]>([]);
  const [communityId, setCommunityId] = useState<number>();
  const [templates, setTemplates] = useState<Template[]>([]);
  const [buildings, setBuildings] = useState<Building[]>([]);
  const [selected, setSelected] = useState<number>();
  const [versionNo, setVersionNo] = useState<number>();
  const [rows, setRows] = useState<House[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [buildingId, setBuildingId] = useState<number>();
  const [filter, setFilter] = useState('all');
  const [picked, setPicked] = useState<number[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const seq = useRef(0);
  const [editor, setEditor] = useState<{ id?: number; name: string; effectiveFrom: string; items: DraftItem[] } | null>(null);
  const [saving, setSaving] = useState(false);
  const [assignment, setAssignment] = useState<{ all: boolean; ids: number[]; count: number; date: string; preserve: boolean } | null>(null);
  const [exception, setException] = useState<House | null>(null);
  const [excDate, setExcDate] = useState(today());
  const [overrides, setOverrides] = useState<Record<string, number>>({});
  const [legacy, setLegacy] = useState<LegacyPreview | null>(null);
  const [legacyDate, setLegacyDate] = useState(today());
  const [archived, setArchived] = useState(false);
  const [archiveAction, setArchiveAction] = useState<{id:number;name:string;restore:boolean;scope:{communityId:number|undefined;kind:Kind}} | null>(null);
  const archiveBusy = useRef(false);
  const archiveScope = useRef(0);
  const [archiving, setArchiving] = useState(false);
  const visibleTemplates = templates.filter((t) => t.enabled !== archived);
  const template = visibleTemplates.find((t) => t.id === selected);
  const version = template?.versions.find((v) => v.version === versionNo) ?? template?.versions[0];
  const scope = useMemo(() => ({ communityId, kind }), [communityId, kind]);
  const reload = () => setRefresh((v) => v + 1);
  const pageCount = Math.max(1, Math.ceil(total / 50));

  useEffect(() => { request<Community[]>({ url: '/fees/templates/communities' }).then(setCommunities).catch((e) => setError(errMsg(e, '小区列表读取失败'))); }, [refresh]);
  useEffect(() => {
    const run = ++seq.current;
    setPicked([]);
    if (!communityId) { setTemplates([]); setRows([]); setBuildings([]); setTotal(0); setLoading(false); return; }
    setLoading(true); setError('');
    Promise.all([
      request<{ templates: Template[]; buildings: Building[] }>({ url: '/fees/templates', query: scope }),
      request<{ rows: House[]; total: number }>({ url: '/fees/templates/houses', query: { ...scope, page, q, buildingId, filter } }),
    ]).then(([cat, houses]) => {
      if (run !== seq.current) return;
      setTemplates(cat.templates); setBuildings(cat.buildings); setRows(houses.rows); setTotal(houses.total);
      setSelected((cur) => (cat.templates.some((t) => t.id === cur) ? cur : cat.templates[0]?.id));
    }).catch((e) => { if (run === seq.current) { setError(errMsg(e, '收费模板读取失败')); setTemplates([]); setRows([]); setTotal(0); } })
      .finally(() => { if (run === seq.current) setLoading(false); });
    return () => { seq.current++; };
  }, [scope, communityId, page, q, buildingId, filter, refresh]);
  useEffect(() => setVersionNo(undefined), [selected, communityId]);
  useEffect(() => { setSelected((cur) => visibleTemplates.some((t) => t.id === cur) ? cur : visibleTemplates[0]?.id); }, [templates, archived]);

  const changeScope = (id: number | undefined, nextKind = kind) => {
    seq.current++; archiveScope.current++; setArchived(false); setArchiveAction(null); setSaving(false); setCommunityId(id); setKind(nextKind); setPage(1); setQ(''); setBuildingId(undefined); setFilter('all');
    setTemplates([]); setRows([]); setSelected(undefined); setPicked([]); setEditor(null); setAssignment(null); setException(null); setLegacy(null);
  };
  const openEditor = (edit: boolean, copy = false) => {
    const src = edit ? template?.versions[0] : copy ? version : undefined;
    setEditor({
      id: edit ? template?.id : undefined,
      name: edit ? template?.name ?? '' : copy ? `${template?.name} 副本` : '',
      effectiveFrom: src?.effective_from && src.effective_from > today() ? src.effective_from : today(),
      items: src?.items.map((i) => ({ ...i, priceYuan: String(i.unitPriceCents / 100) })) ?? [{ feeCode: kind === 'apartment' ? 'rent' : 'management', priceYuan: '', unit: '月', calculation: 'fixed', cycle: 'month' }],
    });
  };
  const editorErr = editor ? (!editor.name.trim() ? '请输入模板名称' : !editor.items.length ? '至少添加一个项目'
    : editor.items.some((i) => !i.feeCode || !i.unit.trim() || i.priceYuan === '' || !(Number(i.priceYuan) >= 0)) ? '每个项目都要选收费项目、填单价（可为 0）和单位'
      : new Set(editor.items.map((i) => i.feeCode)).size !== editor.items.length ? '同一个收费项目不能重复' : editor.effectiveFrom < today() ? '生效日期不能早于今天' : '') : '';
  const saveTemplate = async () => {
    if (!editor || editorErr) { if (editorErr) toast(editorErr); return; }
    setSaving(true);
    try {
      await request({ method: editor.id ? 'PATCH' : 'POST', url: editor.id ? `/fees/templates/${editor.id}` : '/fees/templates', data: {
        ...scope, name: editor.name.trim(), effectiveFrom: editor.effectiveFrom, expectedRevision: editor.id ? template?.revision : undefined,
        items: editor.items.map((i) => ({ feeCode: i.feeCode, unitPriceCents: Math.round(Number(i.priceYuan) * 100), unit: i.unit.trim(), calculation: i.calculation, cycle: i.cycle, ...(i.originalStandardCents !== undefined ? { originalStandardCents: i.originalStandardCents } : {}) })),
      } });
      toast('模板已保存，按生效日期供住户套用；历史账单不变'); setEditor(null); reload();
    } catch (e) { toast(errMsg(e, '模板没有保存，输入已保留')); }
    finally { setSaving(false); }
  };
  const openAssignment = async (all: boolean) => {
    if (!template?.enabled) return toast('请先选择生效中的模板');
    if (!all) return setAssignment({ all: false, ids: picked, count: picked.length, date: today(), preserve: true });
    const run = seq.current;
    setLoading(true);
    try { const r = await request<{ total: number }>({ url: '/fees/templates/houses', query: { ...scope, buildingId, page: 1, filter: 'all' } }); if (run === seq.current) setAssignment({ all: true, ids: [], count: r.total, date: today(), preserve: true }); }
    catch (e) { toast(errMsg(e, '读取户数失败')); } finally { setLoading(false); }
  };
  const assign = async () => {
    if (!assignment || !template) return;
    setSaving(true);
    try {
      const r = await request<{ changed: number }>({ method: 'POST', url: '/fees/templates/assign', data: { ...scope, templateId: template.id, expectedRevision: template.revision, expectedCount: assignment.count, all: assignment.all,
        houseIds: assignment.all ? undefined : assignment.ids, buildingId: assignment.all ? buildingId : undefined, effectiveFrom: assignment.date, preserveOverrides: assignment.preserve } });
      toast(`已保存 ${r.changed} 户的套用配置`); setAssignment(null); setPicked([]); reload();
    } catch (e) { toast(errMsg(e, '套用失败，未修改')); } finally { setSaving(false); }
  };
  const excTemplate = templates.find((t) => t.id === exception?.template_id);
  const excItems = excTemplate ? activeVersion(excTemplate, excDate)?.items ?? [] : [];
  const saveException = async () => {
    if (!exception || !excTemplate) return;
    setSaving(true);
    try { await request({ method: 'POST', url: '/fees/templates/assign', data: { ...scope, templateId: excTemplate.id, expectedRevision: excTemplate.revision, expectedCount: 1, houseIds: [exception.id], effectiveFrom: excDate, overrides } }); toast('个别调整已保存，其余项目继续跟随模板'); setException(null); reload(); }
    catch (e) { toast(errMsg(e, '没有保存，输入已保留')); } finally { setSaving(false); }
  };
  const previewLegacy = async () => {
    const run = seq.current;
    setLoading(true);
    try { const d = await request<LegacyPreview>({ url: '/fees/templates/legacy-preview', query: scope }); if (run === seq.current) { setLegacyDate(today()); setLegacy(d); } }
    catch (e) { toast(errMsg(e, '原标准预览失败')); } finally { setLoading(false); }
  };
  const migrate = async () => {
    if (!legacy) return;
    setSaving(true);
    try { const r = await request<{ houses: number; templates: number }>({ method: 'POST', url: '/fees/templates/legacy-import', data: { ...scope, fingerprint: legacy.fingerprint, effectiveFrom: legacyDate } }); toast(`已归并 ${r.templates} 个模板并套用 ${r.houses} 户，原标准历史保留`); setLegacy(null); reload(); }
    catch (e) { toast(errMsg(e, '归并失败，请重新预览')); } finally { setSaving(false); }
  };
  const setItem = (i: number, patch: Partial<DraftItem>) => editor && setEditor({ ...editor, items: editor.items.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
  const allPicked = rows.length > 0 && rows.every((r) => picked.includes(r.id));

  return (
    <Section title={onlyKind && kind==='apartment'?'公寓收费标准':'物业费收费标准'} desc="公寓门店与小区分开配置。住户关联模板、不复制标准：改模板保存为新版本并选生效日，已生成的账单和历史收款保持原价。">
      <div className="set-inline" style={{ marginBottom: 12 }}>
        {!onlyKind ? <div className="seg">
          <button className={kind === 'residential' ? 'on' : ''} onClick={() => changeScope(undefined, 'residential')}>小区收费标准</button>
          <button className={kind === 'apartment' ? 'on' : ''} onClick={() => changeScope(undefined, 'apartment')}>公寓收费标准</button>
        </div> : null}
        <select className="in" style={{ width: 240 }} value={communityId ?? ''} onChange={(e) => changeScope(e.target.value ? Number(e.target.value) : undefined)}>
          <option value="">选择{kind === 'apartment' ? '公寓门店' : '小区'}</option>
          {communities.filter((c) => c.kind === kind).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <button className="btn" disabled={!communityId} onClick={reload}>刷新</button>
        {canEdit ? <button className="btn" disabled={!communityId} onClick={() => void previewLegacy()}>归并原逐户标准</button> : null}
        {canEdit ? <button className="btn p" disabled={!communityId} onClick={() => openEditor(false)}>＋ 新建模板</button> : null}
      </div>
      {error ? <ResultNote ok={false}>{error} <a style={{ cursor: 'pointer', textDecoration: 'underline' }} onClick={reload}>重试</a></ResultNote> : null}
      {!communityId ? <div className="empty">先选{kind === 'apartment' ? '公寓门店' : '小区'}，不会混入其他房产</div> : (
        <div style={{ opacity: loading ? 0.6 : 1 }}>
          <div className="ft-cols">
            <div>
              <div className="set-sub" style={{ marginTop: 0 }}>收费模板 <span className="muted" style={{ fontWeight: 400 }}>{visibleTemplates.length}</span></div>
              <div className="seg" style={{marginBottom:8}}><button className={!archived ? 'on' : ''} onClick={() => setArchived(false)}>在用</button><button className={archived ? 'on' : ''} onClick={() => setArchived(true)}>已归档</button></div>
              {visibleTemplates.length ? <div className="ft-list">{visibleTemplates.map((t) => (
                <button key={t.id} className={t.id === selected ? 'on' : ''} onClick={() => setSelected(t.id)}>
                  <b>{t.name}</b><small>{t.assigned_count} 户套用 · V{t.revision}{!t.enabled ? ' · 已归档' : ''}</small>
                </button>))}</div> : <div className="empty">{archived ? '暂无已归档模板' : '暂无模板，可新建或归并原标准'}</div>}
            </div>
            <div style={{ minWidth: 0 }}>
              {template && version ? <>
                <div className="set-inline" style={{ marginBottom: 8 }}>
                  <h3 style={{ margin: 0, fontSize: 17 }}>{template.name}</h3>
                  <select className="in" style={{ width: 220 }} value={version.version} onChange={(e) => setVersionNo(Number(e.target.value))}>
                    {template.versions.map((v) => <option key={v.version} value={v.version}>V{v.version} · {v.effective_from} 生效</option>)}
                  </select>
                  <span className={`tag ${version.effective_from > today() ? 'warn' : 'mute'}`}>{version.effective_from > today() ? '待生效' : '版本快照'}</span>
                </div>
                <div className="t-scroll" tabIndex={0} role="region" aria-label="收费模板版本项目"><table className="t" style={{minWidth:480}}>
                  <thead><tr><th>收费项目</th><th style={{ textAlign: 'right' }}>单价</th><th>单位</th><th>计费方式</th><th>周期</th></tr></thead>
                  <tbody>{version.items.map((i) => <tr key={i.feeCode}><td className="nw"><b>{LABELS[i.feeCode] ?? i.feeCode}</b></td><td className="nw" style={{ textAlign: 'right' }}>{formatFeeMoney(i.unitPriceCents)}</td><td className="nw">{i.unit}</td><td className="nw">{CALC[i.calculation]}</td><td className="nw">{i.cycle === 'month' ? '每月' : '按次 / 用量'}</td></tr>)}</tbody>
                </table></div>
                {canEdit ? <div className="set-actions">
                  <button className="btn" disabled={!template.enabled} onClick={() => openEditor(true)}>修改模板 · 影响 {template.assigned_count} 户</button>
                  <button className="btn" disabled={!template.enabled || saving || loading} onClick={() => openEditor(false, true)}>复制为新模板</button>
                  <button className={template.enabled ? 'btn d' : 'btn'} disabled={archiving || saving || loading} onClick={() => setArchiveAction({id:template.id,name:template.name,restore:!template.enabled,scope:{...scope}})}>{template.enabled ? '归档' : '恢复'}</button>
                </div> : null}
              </> : <div className="empty">选择左侧模板查看收费项目</div>}
            </div>
          </div>

          <div className="set-sub">住户套用清单 <span className="muted" style={{ fontWeight: 400 }}>筛选结果 {total} 户</span></div>
          <div className="set-inline" style={{ marginBottom: 10 }}>
            <select className="in" style={{ width: 170 }} value={buildingId ?? ''} onChange={(e) => { setBuildingId(e.target.value ? Number(e.target.value) : undefined); setPage(1); }}>
              <option value="">全部楼栋</option>{buildings.map((b) => <option key={b.id} value={b.id}>{bLabel(b)}</option>)}
            </select>
            <input className="in" style={{ width: 200 }} placeholder="房号 / 住户姓名" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
            <select className="in" style={{ width: 150 }} value={filter} onChange={(e) => { setFilter(e.target.value); setPage(1); }}>
              <option value="all">全部住户</option><option value="unassigned">未套用模板</option><option value="override">有个别调整</option>
            </select>
            {canEdit ? <>
              <button className="btn" disabled={!picked.length || !template?.enabled} onClick={() => void openAssignment(false)}>套用选中 {picked.length} 户</button>
              <button className="btn" disabled={!template?.enabled} onClick={() => void openAssignment(true)}>{buildingId ? '套用整栋' : `套用整个${kind === 'apartment' ? '门店' : '小区'}`}</button>
            </> : null}
          </div>
          {!rows.length ? <div className="empty">{loading ? '加载中…' : '没有符合条件的住户'}</div> : (
            <div className="t-scroll"><table className="t" style={{ minWidth: 860 }}>
              <thead><tr>
                {canEdit ? <th style={{ width: 40 }}><input type="checkbox" checked={allPicked} onChange={(e) => setPicked(e.target.checked ? Array.from(new Set([...picked, ...rows.map((r) => r.id)])) : picked.filter((id) => !rows.some((r) => r.id === id)))} /></th> : null}
                <th>楼栋</th><th>房号</th><th>住户</th><th>当前 / 已安排模板</th><th>个别调整</th><th>生效日期</th>{canEdit ? <th /> : null}
              </tr></thead>
              <tbody>{rows.map((r) => {
                const ov = Object.entries(r.overrides ?? {});
                return (
                  <tr key={r.id}>
                    {canEdit ? <td><input type="checkbox" checked={picked.includes(r.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, r.id] : picked.filter((x) => x !== r.id))} /></td> : null}
                    <td className="nw">{bLabel(r)}</td><td className="nw"><b>{r.room_no}</b></td><td className="nw">{r.owner_name || '—'}</td>
                    <td style={{ minWidth: 140 }}>{r.template_name ? <><b>{r.template_name}</b>{r.effective_from && r.effective_from > today() ? <span className="tag warn" style={{ marginLeft: 6 }}>待生效</span> : null}</>
                      : <span className="tag mute">{r.has_legacy_standard ? '未套用 · 使用原标准' : '未配置标准'}</span>}</td>
                    <td className="sub" style={{ minWidth: 150 }}>{ov.length ? ov.map(([c, p]) => `${LABELS[c] ?? c} ${formatFeeMoney(p)}`).join('；') : '全部跟随模板'}</td>
                    <td className="muted nw">{r.effective_from || '—'}</td>
                    {canEdit ? <td className="nw"><button className="btn g sm" disabled={!r.template_id} onClick={() => { setException(r); setOverrides({ ...(r.overrides ?? {}) }); setExcDate(today()); }}>个别调整</button></td> : null}
                  </tr>
                );
              })}</tbody>
            </table></div>
          )}
          {pageCount > 1 ? <div className="set-inline" style={{ justifyContent: 'flex-end', marginTop: 10 }}>
            <button className="btn sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</button><span>{page} / {pageCount}</span><button className="btn sm" disabled={page >= pageCount} onClick={() => setPage(page + 1)}>下一页</button>
          </div> : null}
        </div>
      )}

      <FormModal open={!!editor} width={900} title={editor?.id ? `修改模板 · ${template?.assigned_count ?? 0} 户跟随` : '新建收费模板'} onClose={() => setEditor(null)} onOk={() => void saveTemplate()} busy={saving}>
        {editor ? <>
          <div className="set-note" style={{ margin: 0 }}>保存为新版本，不修改已生成账单；住户的个别调整继续优先于模板。</div>
          <div className="set-inline">
            <label className="set-field" style={{ flex: 1, minWidth: 220 }}>模板名称<input className="in" maxLength={80} value={editor.name} onChange={(e) => setEditor({ ...editor, name: e.target.value })} /></label>
            <label className="set-field">生效日期<DateInput className="in" type="date" min={today()} value={editor.effectiveFrom} onChange={(e) => setEditor({ ...editor, effectiveFrom: e.target.value })} /></label>
          </div>
          <div className="set-field">收费项目 / 单价（元） / 单位 / 计费方式 / 周期</div>
          {editor.items.map((it, i) => (
            <div className="ft-item" key={i}>
              <select className="in" value={it.feeCode} onChange={(e) => setItem(i, { feeCode: e.target.value })}>{FEE_ITEMS.map((f) => <option key={f.code} value={f.code}>{f.name}</option>)}</select>
              <input className="in" type="number" min={0} step="0.01" value={it.priceYuan} onChange={(e) => setItem(i, { priceYuan: e.target.value })} />
              <input className="in" maxLength={12} value={it.unit} onChange={(e) => setItem(i, { unit: e.target.value })} />
              <select className="in" value={it.calculation} onChange={(e) => setItem(i, { calculation: e.target.value as Item['calculation'] })}>{Object.entries(CALC).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
              <select className="in" value={it.cycle} onChange={(e) => setItem(i, { cycle: e.target.value as Item['cycle'] })}><option value="month">每月</option><option value="once">按次 / 用量</option></select>
              <button className="btn d sm" onClick={() => setEditor({ ...editor, items: editor.items.filter((_, j) => j !== i) })}>移除</button>
            </div>
          ))}
          <div><button className="btn" disabled={editor.items.length >= 20} onClick={() => setEditor({ ...editor, items: [...editor.items, { feeCode: FEE_ITEMS.find((f) => !editor.items.some((x) => x.feeCode === f.code))?.code ?? FEE_ITEMS[0].code, priceYuan: '', unit: '月', calculation: 'fixed', cycle: 'month' }] })}>＋ 添加收费项目</button></div>
          {editorErr ? <ResultNote ok={false}>{editorErr}</ResultNote> : null}
        </> : null}
      </FormModal>

      <FormModal open={!!assignment} title="批量套用模板" okText="确认套用" onClose={() => setAssignment(null)} onOk={() => void assign()} busy={saving}>
        {assignment ? <>
          <p style={{ margin: 0 }}><b>{assignment.count} 户</b>将套用「{template?.name}」。{assignment.all ? '作用于所选整栋或整个门店 / 小区，不受搜索条件和分页限制。' : ''}</p>
          <label>生效日期<DateInput className="in" type="date" min={today()} value={assignment.date} onChange={(e) => setAssignment({ ...assignment, date: e.target.value })} /></label>
          <label className="set-inline" style={{ fontWeight: 400 }}><input type="checkbox" checked={assignment.preserve} onChange={(e) => setAssignment({ ...assignment, preserve: e.target.checked })} />保留住户已有的个别单价调整</label>
          {!assignment.preserve ? <ResultNote ok={false}>本次将清除选中住户的个别调整，全部使用模板价格</ResultNote> : null}
        </> : null}
      </FormModal>

      <FormModal open={!!exception} title={`个别调整 · ${exception ? `${bLabel(exception)}${exception.room_no}室` : ''}`} onClose={() => setException(null)} onOk={() => void saveException()} busy={saving}>
        {exception ? <>
          <p style={{ margin: 0 }}>只勾选需要例外设置的项目，未勾选的继续跟随模板。</p>
          <label>生效日期<DateInput className="in" type="date" min={today()} value={excDate} onChange={(e) => setExcDate(e.target.value)} /></label>
          {!excItems.length ? <ResultNote ok={false}>该模板在所选日期还没生效，请调整日期</ResultNote> : null}
          {excItems.map((it) => (
            <div key={it.feeCode} className="set-inline">
              <label className="set-inline" style={{ fontWeight: 400, flex: 1, minWidth: 220 }}>
                <input type="checkbox" checked={owns(overrides, it.feeCode)} onChange={(e) => setOverrides((o) => { const n = { ...o }; if (e.target.checked) n[it.feeCode] = it.unitPriceCents; else delete n[it.feeCode]; return n; })} />
                {LABELS[it.feeCode]}（模板 {formatFeeMoney(it.unitPriceCents)}/{it.unit}）
              </label>
              <input className="in" type="number" min={0} step="0.01" style={{ width: 130 }} disabled={!owns(overrides, it.feeCode)} value={owns(overrides, it.feeCode) ? overrides[it.feeCode] / 100 : ''}
                onChange={(e) => e.target.value !== '' && setOverrides((o) => ({ ...o, [it.feeCode]: Math.round(Number(e.target.value) * 100) }))} />
            </div>
          ))}
          <div><button className="btn sm" onClick={() => setOverrides({})}>全部恢复跟随模板</button></div>
        </> : null}
      </FormModal>

      <FormModal open={!!legacy} width={800} title="原逐户标准归并预览" okText="确认归并" onClose={() => setLegacy(null)} onOk={() => { if (legacy?.houses) void migrate(); }} busy={saving}>
        {legacy ? <>
          <div className="set-note" style={{ margin: 0 }}><b>{legacy.houses} 户可归并为 {legacy.groups.length} 个模板。</b>只处理还没套用模板的住户，按全部收费项目、金额和原始签报标准精确分组；已有模板不覆盖，原标准与账单历史不删除。</div>
          <label>生效日期<DateInput className="in" type="date" min={today()} value={legacyDate} onChange={(e) => setLegacyDate(e.target.value)} /></label>
          {legacy.groups.length ? <table className="t"><thead><tr><th>分组</th><th style={{ textAlign: 'right' }}>户数</th><th>收费项目与单价</th></tr></thead>
            <tbody>{legacy.groups.map((g, i) => <tr key={i}><td className="nw">原标准模板 {i + 1}</td><td className="nw" style={{ textAlign: 'right' }}>{g.houseIds.length}</td><td className="sub">{g.items.map((it) => `${LABELS[it.feeCode]} ${formatFeeMoney(it.unitPriceCents)}/${it.unit}`).join('；')}</td></tr>)}</tbody></table>
            : <div className="empty">没有需要归并的住户</div>}
        </> : null}
      </FormModal>

      <ConfirmModal open={!!archiveAction} onClose={() => setArchiveAction(null)} title={`${archiveAction?.restore ? '恢复' : '归档'}模板「${archiveAction?.name ?? ''}」？`} danger={!archiveAction?.restore} confirmText={archiveAction?.restore ? '恢复' : '归档'} busy={archiving}
        onConfirm={async () => {
          const action=archiveAction, run=archiveScope.current;
          if(!action || !canEdit || archiveBusy.current) return;
          archiveBusy.current=true; setArchiving(true);
          try {
            await request({method:'POST',url:`/fees/templates/${action.id}/${action.restore ? 'restore' : 'disable'}`,data:action.scope});
            if(run===archiveScope.current) { toast(action.restore ? '模板已恢复，未自动套用住户' : '模板已归档，历史标准和账单保留'); setArchiveAction(null); reload(); }
          } catch(e) { if(run===archiveScope.current) toast(errMsg(e,action.restore ? '恢复失败' : '归档失败')); }
          finally { archiveBusy.current=false; setArchiving(false); }
        }}>
        {archiveAction?.restore ? '恢复后可重新使用，原版本和历史记录保留，不会自动给住户套用。' : '归档后从在用清单移除，可在已归档中恢复；仍有当前或未来计划使用时，须先更换模板。'}
      </ConfirmModal>
    </Section>
  );
}
