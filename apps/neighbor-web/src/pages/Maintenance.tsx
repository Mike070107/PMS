import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { maintenance, request } from '@pms/api-client';
import type { MaintenanceListItem } from '@pms/api-client/src/endpoints/maintenance';
import type { QuotaItemRow, QuotaParams } from '@legacy/pages/maintenance/types';
import AddressSearch from '@/components/AddressSearch';
import { addressMatcher } from '@/lib/address-match';
import MaintEditor from '@/components/maint/MaintEditor';
import Icon from '@/components/Icon';
import { useAddressTree } from '@/lib/address-tree';
import { can } from '@/lib/perm';
import { Btn, Card, ErrorNote, Field, Loading, Sheet, toast } from '@/components/ui';
import { dayjs, money } from '@/lib/format';
import ToneIcon from '@/components/ToneIcon';

type MStatus = MaintenanceListItem['status'];
const STATUS: Record<MStatus, { text: string; cls: string }> = {
  filling: { text: '填单中', cls: 's-wait' },
  waiting_filler: { text: '待填单人签', cls: 's-pend' },
  waiting_repairer: { text: '待修理人签', cls: 's-pend' },
  waiting_inspector: { text: '待查验员签', cls: 's-acc' },
  pending_print: { text: '待打印', cls: 's-work' },
  completed: { text: '已完成', cls: 's-done' },
  void: { text: '已作废', cls: 's-off' },
};
const STEP_OF: Record<MStatus, number> = { filling: 1, waiting_filler: 1, waiting_repairer: 2, waiting_inspector: 3, pending_print: 4, completed: 4, void: 0 };
const STEPS = ['填单', '修理人签', '查验员签', '打印归档'];
const FILTERS: Array<{ key: string; label: string; match: (s: MStatus) => boolean }> = [
  { key: 'active', label: '进行中', match: (s) => s !== 'completed' && s !== 'void' },
  { key: 'filling', label: '填单中', match: (s) => s === 'filling' || s === 'waiting_filler' },
  { key: 'signing', label: '签字中', match: (s) => s === 'waiting_repairer' || s === 'waiting_inspector' },
  { key: 'print', label: '待打印', match: (s) => s === 'pending_print' },
  { key: 'completed', label: '已完成', match: (s) => s === 'completed' },
  { key: 'void', label: '已作废', match: (s) => s === 'void' },
  { key: 'all', label: '全部', match: (s) => s !== 'void' },
];
const DEFAULT_PARAMS: QuotaParams = { laborRateCents: 1750, coefficient: 1.0341 };

/**
 * 养护单：房屋修理养护任务单。列表 → 点开就是那张纸（直接在格子里填）→ 推送签名 → 手机签 → 打印归档。
 * 从工单开单：这一页「从工单开单」，或工单详情「填养护单」带 ?workOrderId= 过来。
 */
export default function Maintenance() {
  const [rows, setRows] = useState<MaintenanceListItem[] | null>(null);
  const [filter, setFilter] = useState('active');
  const [q, setQ] = useState('');
  const { communities } = useAddressTree();
  const [err, setErr] = useState('');
  const [openId, setOpenId] = useState<number | null>(null);
  const [pickOpen, setPickOpen] = useState(false);
  const [quotaOpen, setQuotaOpen] = useState(false);
  const [quotaItems, setQuotaItems] = useState<QuotaItemRow[]>([]);
  const [quotaParams, setQuotaParams] = useState<QuotaParams>(DEFAULT_PARAMS);
  const [params, setParams] = useSearchParams();
  const canEdit = can('maintenance-orders', 'edit');
  const canDelete = can('maintenance-orders', 'delete');
  const canInspect = can('maintenance-inspect', 'view') || can('maintenance-inspect', 'edit');

  const load = useCallback(async () => {
    try { setRows(await maintenance.list({ status: 'all' })); setErr(''); }
    catch (e) { setErr(e instanceof Error ? e.message : '养护单加载失败'); }
  }, []);
  const loadQuota = useCallback(async () => {
    try {
      const [items, p] = await Promise.all([
        request<QuotaItemRow[]>({ url: '/quota-items' }),
        request<QuotaParams>({ url: '/quota-params' }),
      ]);
      setQuotaItems(items || []); setQuotaParams(p || DEFAULT_PARAMS);
    } catch { /* 定额没取到不影响看单，只是不自动算工时 */ }
  }, []);
  useEffect(() => { void load(); void loadQuota(); }, [load, loadQuota]);

  /** 从工单开单：已经开过就直接打开原来那张 */
  const createFromWorkOrder = useCallback(async (workOrderId: number) => {
    try {
      const created = await request<{ id: number }>({ method: 'POST', url: '/maintenance-orders', data: { workOrderId } });
      setPickOpen(false); setOpenId(created.id); void load();
    } catch (e) { toast(e instanceof Error ? e.message : '开单失败'); }
  }, [load]);

  useEffect(() => {
    const wo = params.get('workOrderId');
    const open = params.get('open');
    if (!wo && !open) return;
    const next = new URLSearchParams(params); next.delete('workOrderId'); next.delete('open');
    setParams(next, { replace: true });
    if (wo) void createFromWorkOrder(Number(wo));
    else if (open) setOpenId(Number(open));
  }, [params, setParams, createFromWorkOrder]);

  const visible = useMemo(() => {
    const f = FILTERS.find((i) => i.key === filter) || FILTERS[0];
    const kw = q.trim();
    const addr = kw ? addressMatcher(kw, communities) : null;
    return (rows ?? []).filter((r) => f.match(r.status))
      .filter((r) => (!kw ? true : addr ? addr(r.addressText) : `${r.orderNo}${r.paperNo || ''}${r.workOrderNo || ''}${r.addressText}${r.repairItem || ''}${r.repairerName || ''}`.includes(kw)))
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  }, [rows, filter, q, communities]);
  const countOf = (key: string) => { const f = FILTERS.find((i) => i.key === key); return f ? (rows ?? []).filter((r) => f.match(r.status)).length : 0; };

  if (rows === null && !err) return <Loading />;

  return (
    <>
      <div className="ph">
        <div><div className="h1row"><ToneIcon kind="maintenance" /><h1>养护单</h1></div><p>房屋修理养护任务单：开单填写 → 推送签名 → 三方手机签字 → 打印归档</p></div>
        <div className="act">
          <button className="btn" onClick={() => setQuotaOpen(true)}><Icon name="book" size={17} />定额库</button>
          {canEdit ? <button className="btn p" onClick={() => setPickOpen(true)}><Icon name="plus" size={18} />从工单开单</button> : null}
        </div>
      </div>
      {err ? <ErrorNote>{err}</ErrorNote> : null}

      <div className="wo-bar">
        <div className="chips">
          {FILTERS.map((i) => <button key={i.key} className={`chip ${filter === i.key ? 'on' : ''}`} onClick={() => setFilter(i.key)}>{i.label}<span className="c">{countOf(i.key)}</span></button>)}
        </div>
        <div style={{ marginLeft: 'auto' }}>
          <AddressSearch communities={communities} value={q} onChange={setQ} placeholder="198/20、一期20号601、单号、修理人" />
        </div>
      </div>

      <Card style={{ overflow: 'hidden' }}>
        <table className="t">
          <thead><tr><th>养护单号</th><th>地址</th><th>报修项目</th><th>报修人 / 修理人</th><th style={{ textAlign: 'right' }}>工料费</th><th style={{ width: 260 }}>签字进度</th><th>状态</th><th /></tr></thead>
          <tbody>
            {visible.length ? visible.map((row) => {
              const step = STEP_OF[row.status] ?? 0;
              return (
                <tr key={row.id} className="row" onClick={() => setOpenId(row.id)}>
                  <td><b>{row.paperNo || row.orderNo}</b>{row.workOrderNo ? <div className="muted" style={{ fontSize: 13.5 }}>工单 {row.workOrderNo}</div> : null}</td>
                  <td className="sub">{row.addressText}</td>
                  <td className="sub" style={{ maxWidth: 240 }}>{row.repairItem || '—'}</td>
                  <td className="sub">{row.reporterName || '—'}<div className="muted" style={{ fontSize: 13.5 }}>{row.repairerName || '未指派修理人'}</div></td>
                  <td style={{ textAlign: 'right', fontWeight: 600 }}>{money((row.totalCents || 0) / 100)}</td>
                  <td>
                    <div style={{ display: 'flex', gap: 4 }}>
                      {STEPS.map((label, i) => {
                        const done = i < step; const cur = i === step - 1 && row.status !== 'completed';
                        return <span key={label} style={{ flex: 1, textAlign: 'center', fontSize: 12, paddingTop: 6, borderTop: `4px solid ${done ? 'var(--acc)' : 'var(--line)'}`, color: cur ? 'var(--ink)' : 'var(--ink3)', fontWeight: cur ? 650 : 400, whiteSpace: 'nowrap' }}>{label}</span>;
                      })}
                    </div>
                  </td>
                  <td><span className={`pill ${STATUS[row.status]?.cls || 's-off'}`}>{STATUS[row.status]?.text || row.status}</span></td>
                  <td style={{ textAlign: 'right' }} className="muted">{row.createdAt ? dayjs(row.createdAt).format('MM-DD') : ''}</td>
                </tr>
              );
            }) : <tr><td colSpan={8} className="empty">没有符合条件的养护单</td></tr>}
          </tbody>
        </table>
      </Card>

      {openId ? (
        <MaintEditor id={openId} quotaItems={quotaItems} quotaParams={quotaParams}
          canEdit={canEdit} canDelete={canDelete} canInspect={canInspect}
          onClose={() => setOpenId(null)} onChanged={() => void load()} />
      ) : null}
      {pickOpen ? <WorkOrderPick onClose={() => setPickOpen(false)} onPick={(id) => void createFromWorkOrder(id)} /> : null}
      {quotaOpen ? <QuotaConfig items={quotaItems} params={quotaParams} canEdit={canEdit} onClose={() => setQuotaOpen(false)} onChanged={() => void loadQuota()} /> : null}
    </>
  );
}

/* ───────── 从工单开单 ───────── */
interface WoRow {
  id: number; orderNo: string; summaryAddress?: string | null; summaryContent?: string | null;
  completedAt?: string | null; usedMaterials?: Array<{ name?: string; qty?: number; unit?: string }>;
}
function WorkOrderPick({ onClose, onPick }: { onClose: () => void; onPick: (id: number) => void }) {
  const [kw, setKw] = useState('');
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<WoRow[] | null>(null);
  useEffect(() => { const t = window.setTimeout(() => setQ(kw.trim()), 300); return () => window.clearTimeout(t); }, [kw]);
  useEffect(() => {
    setRows(null);
    request<WoRow[]>({ url: `/work-orders?scope=all${q ? `&q=${encodeURIComponent(q)}` : ''}` }).then(setRows).catch((e) => { toast(e instanceof Error ? e.message : '加载工单失败'); setRows([]); });
  }, [q]);
  return (
    <Sheet open onClose={onClose} width={860} title="选一张工单开养护单" subtitle="一张工单只开一张养护单；已经开过的会直接打开原来那张">
      <input className="in" autoFocus value={kw} onChange={(e) => setKw(e.target.value)} placeholder="工单号 / 地址 / 故障描述" style={{ marginBottom: 12 }} />
      {rows === null ? <Loading /> : (
        <div className="card" style={{ overflow: 'auto' }}>
          <table className="tbl">
            <thead><tr><th>工单</th><th>报修地址</th><th>报修内容</th><th>工单用料</th><th>完工时间</th></tr></thead>
            <tbody>
              {rows.length ? rows.slice(0, 60).map((r) => (
                <tr key={r.id} onClick={() => onPick(r.id)}>
                  <td><b>{r.orderNo}</b></td>
                  <td>{r.summaryAddress || '—'}</td>
                  <td style={{ maxWidth: 240 }}>{r.summaryContent || '—'}</td>
                  <td className="muted" style={{ fontSize: 13.5 }}>{r.usedMaterials?.length ? r.usedMaterials.map((m) => `${m.name || '未命名'}×${m.qty ?? 0}${m.unit || ''}`).join('、') : '未登记用料'}</td>
                  <td className="muted">{r.completedAt ? dayjs(r.completedAt).format('MM-DD HH:mm') : '未完工'}</td>
                </tr>
              )) : <tr><td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 30 }}>没有匹配的工单</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </Sheet>
  );
}

/* ───────── 定额库 ───────── */
interface QDraft { id: number | null; code: string; name: string; spec: string; unit: string; hours: string; materialFeeYuan: string; remark: string }
const emptyQ: QDraft = { id: null, code: '', name: '', spec: '', unit: '项', hours: '', materialFeeYuan: '', remark: '' };
function QuotaConfig({ items, params, canEdit, onClose, onChanged }: {
  items: QuotaItemRow[]; params: QuotaParams; canEdit: boolean; onClose: () => void; onChanged: () => void;
}) {
  const [rate, setRate] = useState(String(params.laborRateCents / 100));
  const [coef, setCoef] = useState(String(params.coefficient));
  const [kw, setKw] = useState('');
  const [showOff, setShowOff] = useState(false);
  const [d, setD] = useState<QDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const list = items.filter((i) => (showOff || i.enabled) && (!kw.trim() || `${i.code}${i.name}${i.spec}`.includes(kw.trim())));

  const saveParams = async () => {
    const r = Number(rate); const c = Number(coef);
    if (!(r > 0) || !(c > 0)) { toast('单价和系数要大于 0'); return; }
    setBusy(true);
    try { await request({ method: 'PUT', url: '/quota-params', data: { laborRateCents: Math.round(r * 100), coefficient: c } }); toast('已保存，之后新算的合计按新参数'); onChanged(); }
    catch (e) { toast(e instanceof Error ? e.message : '保存失败'); }
    finally { setBusy(false); }
  };
  const saveItem = async () => {
    if (!d) return;
    if (!d.code.trim() || !d.name.trim()) { toast('编号和名称必填'); return; }
    const data = { code: d.code.trim(), name: d.name.trim(), spec: d.spec.trim(), unit: d.unit.trim() || '项', hours: Number(d.hours || 0), materialFeeCents: Math.round(Number(d.materialFeeYuan || 0) * 100), remark: d.remark.trim() };
    setBusy(true);
    try {
      if (d.id) await request({ method: 'PATCH', url: `/quota-items/${d.id}`, data });
      else await request({ method: 'POST', url: '/quota-items', data });
      toast(d.id ? '已保存' : '已新增'); setD(null); onChanged();
    } catch (e) { toast(e instanceof Error ? e.message : '保存失败'); }
    finally { setBusy(false); }
  };
  /** 归档 = 停用：已开的养护单按编号文字保存，不受影响；停用后开新单时不再出现在下拉里 */
  const toggle = async (i: QuotaItemRow) => {
    try {
      await request({ method: 'PATCH', url: `/quota-items/${i.id}`, data: { code: i.code, name: i.name, spec: i.spec, unit: i.unit, hours: Number(i.hours), materialFeeCents: i.materialFeeCents, remark: i.remark || '', enabled: !i.enabled } });
      toast(i.enabled ? '已停用，可在「含已停用」里恢复' : '已恢复'); onChanged();
    } catch (e) { toast(e instanceof Error ? e.message : '操作失败'); }
  };

  return (
    <Sheet open onClose={onClose} width={900} title="预算定额库" subtitle="在养护单「编号」格选定额，工时和人工费自动算">
      <div className="card" style={{ padding: 14, display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 14 }}>
        <Field label="人工单价（元/工时）"><input className="in" type="number" step="0.01" style={{ width: 160 }} value={rate} disabled={!canEdit} onChange={(e) => setRate(e.target.value)} /></Field>
        <Field label="取费系数"><input className="in" type="number" step="0.0001" style={{ width: 140 }} value={coef} disabled={!canEdit} onChange={(e) => setCoef(e.target.value)} /></Field>
        {canEdit ? <div style={{ marginBottom: 14 }}><Btn kind="p" disabled={busy} onClick={() => void saveParams()}>保存取费参数</Btn></div> : null}
        <div className="muted" style={{ fontSize: 13, marginBottom: 14 }}>合计 =（人工费 + 材料费）× 系数</div>
      </div>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 8 }}>
        <input className="in" style={{ width: 260 }} value={kw} onChange={(e) => setKw(e.target.value)} placeholder="搜编号 / 名称 / 规格" />
        <button className={`chip ${showOff ? 'on' : ''}`} onClick={() => setShowOff(!showOff)}>含已停用</button>
        <span className="muted" style={{ fontSize: 13.5 }}>{list.length} 条</span>
        {canEdit ? <button className="btn p sm" style={{ marginLeft: 'auto' }} onClick={() => setD({ ...emptyQ })}><Icon name="plus" size={15} />新增定额</button> : null}
      </div>

      {d ? (
        <div className="card" style={{ padding: 14, marginBottom: 10 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '110px 1fr 100px 80px 100px 110px', gap: 8 }}>
            <Field label="编号"><input className="in" value={d.code} onChange={(e) => setD({ ...d, code: e.target.value })} /></Field>
            <Field label="项目名称"><input className="in" value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} /></Field>
            <Field label="规格"><input className="in" value={d.spec} onChange={(e) => setD({ ...d, spec: e.target.value })} placeholder="如 管径50" /></Field>
            <Field label="单位"><input className="in" value={d.unit} onChange={(e) => setD({ ...d, unit: e.target.value })} /></Field>
            <Field label="工时定额"><input className="in" type="number" step="0.01" value={d.hours} onChange={(e) => setD({ ...d, hours: e.target.value })} /></Field>
            <Field label="参考材料费(元)"><input className="in" type="number" step="0.01" value={d.materialFeeYuan} onChange={(e) => setD({ ...d, materialFeeYuan: e.target.value })} /></Field>
          </div>
          <Field label="备注"><input className="in" value={d.remark} onChange={(e) => setD({ ...d, remark: e.target.value })} /></Field>
          <div style={{ display: 'flex', gap: 8 }}><Btn kind="p" disabled={busy} onClick={() => void saveItem()}>{d.id ? '保存' : '新增'}</Btn><Btn onClick={() => setD(null)}>取消</Btn></div>
        </div>
      ) : null}

      <div className="card" style={{ overflow: 'auto', maxHeight: 'calc(100vh - 420px)' }}>
        <table className="tbl">
          <thead><tr><th>编号</th><th>项目名称</th><th>规格</th><th>单位</th><th style={{ textAlign: 'right' }}>工时定额</th><th style={{ textAlign: 'right' }}>参考材料费</th><th /></tr></thead>
          <tbody>
            {list.map((i) => (
              <tr key={i.id} className={i.enabled ? '' : 'off'} onClick={() => canEdit && setD({ id: i.id, code: i.code, name: i.name, spec: i.spec || '', unit: i.unit, hours: String(i.hours), materialFeeYuan: i.materialFeeCents ? String(i.materialFeeCents / 100) : '', remark: i.remark || '' })}>
                <td><b>{i.code}</b></td><td>{i.name}{i.remark ? <span className="sub">{i.remark}</span> : null}</td><td>{i.spec || '—'}</td><td>{i.unit}</td>
                <td style={{ textAlign: 'right' }}>{i.hours}</td><td style={{ textAlign: 'right' }}>{i.materialFeeCents ? money(i.materialFeeCents / 100) : '—'}</td>
                <td onClick={(e) => e.stopPropagation()}>{canEdit ? <button className="btn sm" onClick={() => void toggle(i)}>{i.enabled ? '停用' : '恢复'}</button> : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Sheet>
  );
}
