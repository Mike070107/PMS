import { useEffect, useMemo, useState } from 'react';
import { inventory, request } from '@pms/api-client';
import type { MaterialCategoryView, MaterialView, StockView, WarehouseView } from '@pms/shared-types';
import Icon from '@/components/Icon';
import { Btn, Empty, Field, Loading, Sheet, toast } from '@/components/ui';
import PhotoField from '@/components/PhotoField';
import { can } from '@/lib/perm';
import { ago, dayjs, money } from '@/lib/format';

const num = (v: unknown) => Number(v) || 0;
const whName = (ws: WarehouseView[], id: number) => ws.find((w) => w.id === id)?.name || `仓库#${id}`;

/* ───────── 材料搜索（按 SKU；库里没有当场建档） ───────── */
export function MaterialSearch({ materials, onPick, onCreated, extra, only }: {
  materials: MaterialView[];
  onPick: (m: MaterialView) => void;
  onCreated: (m: MaterialView) => void;
  /** 每条结果右侧的补充信息（如该仓库存） */
  extra?: (m: MaterialView) => string;
  /** 只允许选这些（调拨：只列调出仓有货的） */
  only?: Set<number>;
}) {
  const [q, setQ] = useState('');
  const [cats, setCats] = useState<MaterialCategoryView[]>([]);
  const [draft, setDraft] = useState<{ name: string; spec: string; unit: string; category: string } | null>(null);
  useEffect(() => { inventory.listMaterialCategories().then(setCats).catch(() => undefined); }, []);
  const hits = useMemo(() => {
    const kw = q.trim().toLowerCase();
    if (!kw) return [];
    return materials.filter((m) => (!only || only.has(m.id)) && [m.name, m.spec, m.code, ...(m.aliases || [])].some((v) => (v || '').toLowerCase().includes(kw))).slice(0, 12);
  }, [materials, q, only]);
  const create = async () => {
    if (!draft?.name.trim() || !draft.unit.trim()) { toast('名称和单位必填'); return; }
    try {
      const m = await inventory.createMaterial({ name: draft.name.trim(), spec: draft.spec.trim(), unit: draft.unit.trim(), category: draft.category || undefined } as Parameters<typeof inventory.createMaterial>[0]);
      onCreated(m); onPick(m); setDraft(null); setQ('');
      toast(`已建 SKU ${m.code || m.name}，照片和参数之后到「材料SKU」补`);
    } catch (e) { toast(e instanceof Error ? e.message : '建档失败'); }
  };
  return (
    <div style={{ position: 'relative', marginBottom: 10 }}>
      <input className="in" value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜材料：名称 / 规格 / 编码 / 别名，点一下加入" />
      {q.trim() ? (
        <div className="pr-pop">
          {hits.map((m) => (
            <div key={m.id} className="pr-hit" onClick={() => { onPick(m); setQ(''); }}>
              {m.photoUrl ? <img src={m.photoUrl} alt="" /> : <div className="ph0"><Icon name="box" size={18} /></div>}
              <div style={{ flex: 1 }}><b>{m.name}</b>{m.spec ? <span className="muted"> · {m.spec}</span> : null}<div className="muted" style={{ fontSize: 13 }}>{m.code} · {m.category || '未分类'}</div></div>
              <span className="muted">{extra ? extra(m) : ''}</span>
            </div>
          ))}
          {!hits.length && only ? <div className="pr-hit muted" style={{ cursor: 'default' }}>调出仓里没有匹配且有库存的材料</div> : null}
          {!only ? <div className="pr-hit" style={{ color: 'var(--acc)', fontWeight: 600 }} onClick={() => setDraft({ name: q.trim(), spec: '', unit: '个', category: '' })}><Icon name="plus" size={18} />库里没有「{q.trim()}」？当场建 SKU 并加入</div> : null}
        </div>
      ) : null}
      {draft ? (
        <div className="card" style={{ padding: 12, marginTop: 8 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr 90px 150px', gap: 8 }}>
            <Field label="名称"><input className="in" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></Field>
            <Field label="规格型号"><input className="in" value={draft.spec} onChange={(e) => setDraft({ ...draft, spec: e.target.value })} /></Field>
            <Field label="单位"><input className="in" value={draft.unit} onChange={(e) => setDraft({ ...draft, unit: e.target.value })} /></Field>
            <Field label="分类"><select className="in" value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value })}><option value="">（未分类）</option>{cats.filter((c) => c.enabled).map((c) => <option key={c.id} value={c.label}>{c.label}</option>)}</select></Field>
          </div>
          <div style={{ display: 'flex', gap: 8 }}><Btn kind="p" onClick={() => void create()}>建档并加入</Btn><Btn onClick={() => setDraft(null)}>取消</Btn></div>
        </div>
      ) : null}
    </div>
  );
}

/* ───────── 一般入库（不走采购：捐赠、退料、旧件回收、期初补录） ───────── */
export function InboundForm({ warehouses, onClose, onDone }: { warehouses: WarehouseView[]; onClose: () => void; onDone: () => void }) {
  const [materials, setMaterials] = useState<MaterialView[] | null>(null);
  const [warehouseId, setWarehouseId] = useState<number | ''>(() => (warehouses.find((w) => w.preferred) || warehouses[0])?.id ?? '');
  const [sourceTag, setSourceTag] = useState('退料入库');
  const [source, setSource] = useState('');
  const [attachments, setAttachments] = useState<string[]>([]);
  const [lines, setLines] = useState<Array<{ m: MaterialView; qty: string; cost: string }>>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => { inventory.listMaterials().then((l) => setMaterials(l.filter((m) => m.enabled))).catch(() => setMaterials([])); }, []);
  const add = (m: MaterialView) => setLines((p) => (p.some((l) => l.m.id === m.id) ? p : [...p, { m, qty: '1', cost: m.defaultCostCents ? String(m.defaultCostCents / 100) : '' }]));
  const total = lines.reduce((s, l) => s + num(l.qty) * num(l.cost), 0);

  const submit = async () => {
    if (!warehouseId) { toast('选入库仓库'); return; }
    if (!lines.length) { toast('还没加材料'); return; }
    if (lines.some((l) => !(num(l.qty) > 0))) { toast('数量要大于 0'); return; }
    setBusy(true);
    try {
      const r = await inventory.createGeneralReceipt({
        warehouseId, sourceText: [sourceTag, source.trim()].filter(Boolean).join('：'), attachments,
        items: lines.map((l) => ({ materialId: l.m.id, qty: num(l.qty), unitCostCents: Math.round(num(l.cost) * 100) })),
      } as Parameters<typeof inventory.createGeneralReceipt>[0]);
      toast(`已入库 ${r.receiptNo}`); onDone();
    } catch (e) { toast(e instanceof Error ? e.message : '入库失败'); }
    finally { setBusy(false); }
  };
  return (
    <Sheet open onClose={onClose} width={860} title="入库" subtitle="不走采购的入库：退料、捐赠、旧件回收、期初补录。采购到货请在「采购 → 在途」里入库">
      {materials === null ? <Loading /> : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 12 }}>
            <Field label="入库仓库"><select className="in" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value ? Number(e.target.value) : '')}><option value="">选择仓库</option>{warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select></Field>
            <Field label="来源">
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {['退料入库', '捐赠', '旧件回收', '期初补录', '其他'].map((t) => <button key={t} className={`chip ${sourceTag === t ? 'on' : ''}`} onClick={() => setSourceTag(t)}>{t}</button>)}
              </div>
            </Field>
          </div>
          <Field label="来源说明"><input className="in" value={source} onChange={(e) => setSource(e.target.value)} placeholder="例如：228弄工单退回的角阀 / 业委会捐赠" /></Field>
          <MaterialSearch materials={materials} onPick={add} onCreated={(m) => setMaterials((p) => [...(p ?? []), m])} extra={(m) => (m.defaultCostCents ? `${money(m.defaultCostCents / 100)}/${m.unit}` : '')} />
          <div className="card" style={{ overflow: 'auto' }}>
            <table className="tbl">
              <thead><tr><th>材料</th><th style={{ width: 120 }}>数量</th><th style={{ width: 130 }}>单价(元)</th><th style={{ textAlign: 'right' }}>金额</th><th /></tr></thead>
              <tbody>
                {lines.length ? lines.map((l) => (
                  <tr key={l.m.id} style={{ cursor: 'default' }}>
                    <td><b>{l.m.name}</b><span className="sub">{l.m.spec || '—'} · {l.m.code}</span></td>
                    <td><div style={{ display: 'flex', gap: 4, alignItems: 'center' }}><input className="in" type="number" min={0} step="any" style={{ height: 36 }} value={l.qty} onChange={(e) => setLines((p) => p.map((x) => (x.m.id === l.m.id ? { ...x, qty: e.target.value } : x)))} /><span className="muted">{l.m.unit}</span></div></td>
                    <td><input className="in" type="number" min={0} step="0.01" style={{ height: 36 }} value={l.cost} onChange={(e) => setLines((p) => p.map((x) => (x.m.id === l.m.id ? { ...x, cost: e.target.value } : x)))} /></td>
                    <td style={{ textAlign: 'right', fontWeight: 600 }}>{money(num(l.qty) * num(l.cost))}</td>
                    <td><button className="btn sm" onClick={() => setLines((p) => p.filter((x) => x.m.id !== l.m.id))}>✕</button></td>
                  </tr>
                )) : <tr><td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 24, cursor: 'default' }}>在上面搜材料加入</td></tr>}
              </tbody>
            </table>
          </div>
          <Field label="单据照片（选填，最多 6 张）">
            <PhotoField value={attachments} onChange={setAttachments} max={6} size={96} />
          </Field>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span>共 {lines.length} 种 · 金额 <b style={{ fontSize: 19 }}>{money(total)}</b></span><span style={{ flex: 1 }} />
            <Btn onClick={onClose}>取消</Btn><Btn kind="p" size="lg" disabled={busy} onClick={() => void submit()}>{busy ? '入库中…' : '确认入库'}</Btn>
          </div>
        </>
      )}
    </Sheet>
  );
}

/* ───────── 入库记录 ───────── */
interface Receipt { id: number; receiptNo: string; receiptType: string; purchaseOrderId: number | null; sourceText: string | null; attachments: string[]; warehouseId: number; items: Array<{ materialId: number; qty: number; unitCostCents: number; locationLabel?: string | null }>; createdAt: string }
export function InboundList({ warehouses, materials }: { warehouses: WarehouseView[]; materials: MaterialView[] }) {
  const [rows, setRows] = useState<Receipt[] | null>(null);
  const [open, setOpen] = useState<Receipt | null>(null);
  useEffect(() => { request<Receipt[]>({ url: '/goods-receipts' }).then(setRows).catch(() => setRows([])); }, []);
  const mat = (id: number) => materials.find((m) => m.id === id);
  if (rows === null) return <Loading />;
  if (!rows.length) return <Empty>还没有入库记录</Empty>;
  return (
    <>
      <table className="t">
        <thead><tr><th>入库单</th><th>类型</th><th>仓库</th><th>材料</th><th style={{ textAlign: 'right' }}>金额</th><th>来源</th><th>时间</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="row" onClick={() => setOpen(r)}>
              <td><b>{r.receiptNo}</b></td>
              <td><span className={`pill ${r.purchaseOrderId ? 's-acc' : 's-wait'}`}>{r.purchaseOrderId ? '采购入库' : '一般入库'}</span></td>
              <td>{whName(warehouses, r.warehouseId)}</td>
              <td className="sub" style={{ maxWidth: 300 }}>{r.items.map((i) => `${mat(i.materialId)?.name || '#' + i.materialId}×${i.qty}`).join('、')}</td>
              <td style={{ textAlign: 'right', fontWeight: 600 }}>{money(r.items.reduce((s, i) => s + i.qty * i.unitCostCents, 0) / 100)}</td>
              <td className="sub" style={{ maxWidth: 200 }}>{r.sourceText || '—'}</td>
              <td className="muted">{ago(r.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <Sheet open={!!open} onClose={() => setOpen(null)} title={open?.receiptNo || ''} subtitle={open ? `${open.purchaseOrderId ? '采购入库' : '一般入库'} · ${whName(warehouses, open.warehouseId)} · ${dayjs(open.createdAt).format('YYYY-MM-DD HH:mm')}` : ''}>
        {open ? (
          <>
            {open.sourceText ? <div className="note2" style={{ marginBottom: 12 }}><Icon name="file" />{open.sourceText}</div> : null}
            <table className="t">
              <thead><tr><th>材料</th><th>库位</th><th style={{ textAlign: 'right' }}>数量</th><th style={{ textAlign: 'right' }}>单价</th><th style={{ textAlign: 'right' }}>金额</th></tr></thead>
              <tbody>{open.items.map((i, k) => { const m = mat(i.materialId); return (
                <tr key={k}><td>{m?.name || `#${i.materialId}`}<span className="sub">{m?.spec || ''}</span></td><td className="muted">{i.locationLabel || '默认'}</td><td style={{ textAlign: 'right' }}>{i.qty}{m?.unit || ''}</td><td style={{ textAlign: 'right' }}>{money(i.unitCostCents / 100)}</td><td style={{ textAlign: 'right' }}>{money(i.qty * i.unitCostCents / 100)}</td></tr>
              ); })}</tbody>
            </table>
            {open.attachments?.length ? <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>{open.attachments.map((u) => <a key={u} href={u} target="_blank" rel="noreferrer"><img src={u} alt="" style={{ width: 90, height: 90, objectFit: 'cover', borderRadius: 8 }} /></a>)}</div> : null}
          </>
        ) : null}
      </Sheet>
    </>
  );
}

/* ───────── 调拨 ───────── */
interface Transfer {
  id: number; transferNo: string; fromWarehouseId: number; toWarehouseId: number;
  items: Array<{ materialId: number; qty: number; receivedQty?: number }>;
  status: 'pending_review' | 'approved' | 'received' | 'rejected'; rejectReason: string | null; note: string | null;
  approvedAt: string | null; receivedAt: string | null; createdAt: string;
}
const T_STATUS: Record<Transfer['status'], { text: string; cls: string }> = {
  pending_review: { text: '待审批', cls: 's-pend' }, approved: { text: '待收货', cls: 's-work' },
  received: { text: '已收货', cls: 's-done' }, rejected: { text: '已驳回', cls: 's-off' },
};

export function TransferForm({ warehouses, onClose, onDone }: { warehouses: WarehouseView[]; onClose: () => void; onDone: () => void }) {
  const [materials, setMaterials] = useState<MaterialView[]>([]);
  const [fromId, setFromId] = useState<number | ''>('');
  const [toId, setToId] = useState<number | ''>('');
  const [stocks, setStocks] = useState<StockView[]>([]);
  const [lines, setLines] = useState<Array<{ m: MaterialView; qty: string }>>([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { inventory.listMaterials().then(setMaterials).catch(() => undefined); }, []);
  useEffect(() => {
    setLines([]);
    if (!fromId) { setStocks([]); return; }
    inventory.listStocks({ warehouseId: fromId }).then(setStocks).catch(() => setStocks([]));
  }, [fromId]);
  const avail = useMemo(() => new Map(stocks.map((s) => [s.materialId, num(s.qty)])), [stocks]);
  const has = useMemo(() => new Set(stocks.filter((s) => num(s.qty) > 0).map((s) => s.materialId)), [stocks]);
  const submit = async () => {
    if (!fromId || !toId) { toast('选调出仓和调入仓'); return; }
    if (fromId === toId) { toast('调出仓和调入仓不能是同一个'); return; }
    if (!lines.length) { toast('还没加材料'); return; }
    const over = lines.find((l) => !(num(l.qty) > 0) || num(l.qty) > (avail.get(l.m.id) || 0));
    if (over) { toast(`「${over.m.name}」数量要大于 0 且不超过调出仓库存 ${avail.get(over.m.id) || 0}`); return; }
    setBusy(true);
    try {
      await request({ method: 'POST', url: '/transfer-orders', data: { fromWarehouseId: fromId, toWarehouseId: toId, note: note.trim() || undefined, items: lines.map((l) => ({ materialId: l.m.id, qty: num(l.qty) })) } });
      toast('已提交调拨，等待审批'); onDone();
    } catch (e) { toast(e instanceof Error ? e.message : '提交失败'); }
    finally { setBusy(false); }
  };
  return (
    <Sheet open onClose={onClose} width={820} title="调拨" subtitle="调出仓 → 调入仓；审批通过后调出仓扣库存，调入仓按实收入库">
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 40px 1fr', gap: 8, alignItems: 'end' }}>
        <Field label="调出仓"><select className="in" value={fromId} onChange={(e) => setFromId(e.target.value ? Number(e.target.value) : '')}><option value="">选择仓库</option>{warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select></Field>
        <div style={{ textAlign: 'center', marginBottom: 22, fontSize: 20 }}>→</div>
        <Field label="调入仓"><select className="in" value={toId} onChange={(e) => setToId(e.target.value ? Number(e.target.value) : '')}><option value="">选择仓库</option>{warehouses.filter((w) => w.id !== fromId).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select></Field>
      </div>
      {fromId ? (
        <MaterialSearch materials={materials} only={has} onPick={(m) => setLines((p) => (p.some((l) => l.m.id === m.id) ? p : [...p, { m, qty: '1' }]))} onCreated={() => undefined} extra={(m) => `可调 ${avail.get(m.id) || 0}${m.unit}`} />
      ) : <div className="muted" style={{ marginBottom: 10 }}>先选调出仓，只列有库存的材料</div>}
      <div className="card" style={{ overflow: 'auto' }}>
        <table className="tbl">
          <thead><tr><th>材料</th><th style={{ textAlign: 'right' }}>调出仓库存</th><th style={{ width: 130 }}>调拨数量</th><th /></tr></thead>
          <tbody>
            {lines.length ? lines.map((l) => {
              const a = avail.get(l.m.id) || 0;
              return (
                <tr key={l.m.id} style={{ cursor: 'default' }}>
                  <td><b>{l.m.name}</b><span className="sub">{l.m.spec || '—'}</span></td>
                  <td style={{ textAlign: 'right' }}>{a}{l.m.unit}</td>
                  <td><input className="in" type="number" min={0} max={a} step="any" style={{ height: 36, borderColor: num(l.qty) > a ? 'var(--dang)' : undefined }} value={l.qty} onChange={(e) => setLines((p) => p.map((x) => (x.m.id === l.m.id ? { ...x, qty: e.target.value } : x)))} /></td>
                  <td><button className="btn sm" onClick={() => setLines((p) => p.filter((x) => x.m.id !== l.m.id))}>✕</button></td>
                </tr>
              );
            }) : <tr><td colSpan={4} className="muted" style={{ textAlign: 'center', padding: 24, cursor: 'default' }}>在上面搜材料加入</td></tr>}
          </tbody>
        </table>
      </div>
      <Field label="备注（选填）"><input className="in" value={note} onChange={(e) => setNote(e.target.value)} placeholder="为什么调、急不急" /></Field>
      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}><Btn onClick={onClose}>取消</Btn><Btn kind="p" size="lg" disabled={busy} onClick={() => void submit()}>{busy ? '提交中…' : '提交调拨'}</Btn></div>
    </Sheet>
  );
}

export function TransferList({ warehouses, materials, refreshKey }: { warehouses: WarehouseView[]; materials: MaterialView[]; refreshKey: number }) {
  const [rows, setRows] = useState<Transfer[] | null>(null);
  const [filter, setFilter] = useState<Transfer['status'] | 'all'>('pending_review');
  const [open, setOpen] = useState<Transfer | null>(null);
  const [recv, setRecv] = useState<Record<number, string>>({});
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  // 调拨单的经理这一步跟采购同属「采购·经理审核」，兼容旧 key
  const canApprove = can('app:approve-purchase-manager', 'edit') || can('app:approve-manager', 'edit');
  const canReceive = can('inventory', 'edit') || can('app:inventory', 'edit');
  const load = () => request<Transfer[]>({ url: '/transfer-orders' }).then(setRows).catch(() => setRows([]));
  useEffect(() => { void load(); }, [refreshKey]);
  const mat = (id: number) => materials.find((m) => m.id === id);
  const list = (rows ?? []).filter((r) => filter === 'all' || r.status === filter);
  const act = async (fn: () => Promise<unknown>, msg: string) => {
    setBusy(true);
    try { await fn(); toast(msg); setOpen(null); setReason(''); await load(); }
    catch (e) { toast(e instanceof Error ? e.message : '操作失败'); }
    finally { setBusy(false); }
  };
  const openRow = (r: Transfer) => { setOpen(r); setReason(''); setRecv(Object.fromEntries(r.items.map((i) => [i.materialId, String(i.qty)]))); };
  if (rows === null) return <Loading />;
  return (
    <>
      <div className="chips" style={{ padding: '10px 14px', borderBottom: '1px solid var(--line)' }}>
        {(['pending_review', 'approved', 'received', 'rejected', 'all'] as const).map((k) => (
          <button key={k} className={`chip ${filter === k ? 'on' : ''}`} onClick={() => setFilter(k)}>{k === 'all' ? '全部' : T_STATUS[k].text}<span className="c">{k === 'all' ? rows.length : rows.filter((r) => r.status === k).length}</span></button>
        ))}
      </div>
      {list.length ? (
        <table className="t">
          <thead><tr><th>调拨单</th><th>调出 → 调入</th><th>材料</th><th>状态</th><th>提交</th></tr></thead>
          <tbody>
            {list.map((r) => (
              <tr key={r.id} className="row" onClick={() => openRow(r)}>
                <td><b>{r.transferNo}</b></td>
                <td>{whName(warehouses, r.fromWarehouseId)} → {whName(warehouses, r.toWarehouseId)}</td>
                <td className="sub" style={{ maxWidth: 320 }}>{r.items.map((i) => `${mat(i.materialId)?.name || '#' + i.materialId}×${i.qty}`).join('、')}</td>
                <td><span className={`pill ${T_STATUS[r.status].cls}`}>{T_STATUS[r.status].text}</span></td>
                <td className="muted">{ago(r.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <Empty>这一栏没有调拨单</Empty>}

      <Sheet open={!!open} onClose={() => setOpen(null)} width={720} title={open?.transferNo || ''} subtitle={open ? `${whName(warehouses, open.fromWarehouseId)} → ${whName(warehouses, open.toWarehouseId)} · ${dayjs(open.createdAt).format('YYYY-MM-DD HH:mm')}` : ''}>
        {open ? (
          <>
            <div className="facts">
              <div><small>状态</small><b>{T_STATUS[open.status].text}</b></div>
              <div><small>提交</small><b>{dayjs(open.createdAt).format('MM-DD HH:mm')}</b></div>
              <div><small>审批</small><b>{open.approvedAt ? dayjs(open.approvedAt).format('MM-DD HH:mm') : '—'}</b></div>
              <div><small>收货</small><b>{open.receivedAt ? dayjs(open.receivedAt).format('MM-DD HH:mm') : '—'}</b></div>
            </div>
            {open.note ? <div className="note2" style={{ marginBottom: 10 }}><Icon name="file" />{open.note}</div> : null}
            {open.rejectReason ? <div className="note2" style={{ marginBottom: 10, color: 'var(--dang)' }}><Icon name="alert" />驳回原因：{open.rejectReason}</div> : null}
            <table className="t">
              <thead><tr><th>材料</th><th style={{ textAlign: 'right' }}>调拨数</th><th style={{ textAlign: 'right', width: 140 }}>{open.status === 'approved' ? '实收' : open.status === 'received' ? '已收' : ''}</th></tr></thead>
              <tbody>{open.items.map((i) => { const m = mat(i.materialId); return (
                <tr key={i.materialId}>
                  <td>{m?.name || `#${i.materialId}`}<span className="sub">{m?.spec || ''}</span></td>
                  <td style={{ textAlign: 'right' }}>{i.qty}{m?.unit || ''}</td>
                  <td style={{ textAlign: 'right' }}>{open.status === 'approved' && canReceive
                    ? <input className="in" type="number" min={0} max={i.qty} step="any" style={{ height: 34, width: 110 }} value={recv[i.materialId] ?? ''} onChange={(e) => setRecv((p) => ({ ...p, [i.materialId]: e.target.value }))} />
                    : open.status === 'received' ? `${i.receivedQty ?? i.qty}${m?.unit || ''}` : ''}</td>
                </tr>
              ); })}</tbody>
            </table>
            {open.status === 'pending_review' && canApprove ? (
              <>
                <Field label="驳回原因（驳回时必填）"><input className="in" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="例如：调出仓也快用完了" /></Field>
                <div style={{ display: 'flex', gap: 8 }}>
                  <Btn kind="p" disabled={busy} onClick={() => void act(() => request({ method: 'POST', url: `/transfer-orders/${open.id}/approve` }), '已通过，等待调入仓收货')}>通过</Btn>
                  <Btn kind="d" disabled={busy || !reason.trim()} onClick={() => void act(() => request({ method: 'POST', url: `/transfer-orders/${open.id}/reject`, data: { reason: reason.trim() } }), '已驳回')}>驳回</Btn>
                </div>
              </>
            ) : null}
            {open.status === 'pending_review' && !canApprove ? <div className="muted" style={{ marginTop: 10 }}>等待有「审批」权限的人处理</div> : null}
            {open.status === 'approved' && canReceive ? (
              <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
                <Btn kind="p" disabled={busy} onClick={() => void act(() => request({ method: 'POST', url: `/transfer-orders/${open.id}/receive`, data: { items: open.items.map((i) => ({ materialId: i.materialId, receivedQty: num(recv[i.materialId]) })) } }), '已收货入库')}>确认收货</Btn>
                <span className="muted" style={{ alignSelf: 'center', fontSize: 13.5 }}>按实际收到的数量填，少收的差额会留痕</span>
              </div>
            ) : null}
          </>
        ) : null}
      </Sheet>
    </>
  );
}
