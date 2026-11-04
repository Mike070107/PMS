import { useEffect, useMemo, useState } from 'react';
import { inventory, request } from '@pms/api-client';
import type { MaterialView, StockView, WarehouseView } from '@pms/shared-types';
import Icon from '@/components/Icon';
import { can } from '@/lib/perm';
import PhotoField from '@/components/PhotoField';
import { Btn, Field, Loading, Sheet, toast } from '@/components/ui';
import { ago, dayjs, money } from '@/lib/format';

const num = (v: unknown) => Number(v) || 0;

/* ───────── 共用：按 SKU 搜材料、逐行填数量 ───────── */
export interface SkuLine { key: string; materialId: number; qty: string; cost: string }
function SkuLines({ materials, lines, onChange, avail, withCost, unitOf }: {
  materials: MaterialView[]; lines: SkuLine[]; onChange: (l: SkuLine[]) => void;
  avail?: (materialId: number) => number | null; withCost?: boolean; unitOf: (id: number) => string;
}) {
  const [q, setQ] = useState('');
  const hits = useMemo(() => {
    const kw = q.trim().toLowerCase();
    if (!kw) return [];
    return materials.filter((m) => [m.name, m.spec, m.code, ...(m.aliases || [])].some((v) => (v || '').toLowerCase().includes(kw))).slice(0, 10);
  }, [materials, q]);
  const add = (m: MaterialView) => {
    if (lines.some((l) => l.materialId === m.id)) { toast('已在清单里，直接改数量'); setQ(''); return; }
    onChange([...lines, { key: `${m.id}-${Date.now()}`, materialId: m.id, qty: '1', cost: m.defaultCostCents ? String(m.defaultCostCents / 100) : '' }]);
    setQ('');
  };
  const mOf = (id: number) => materials.find((m) => m.id === id);
  const set = (key: string, p: Partial<SkuLine>) => onChange(lines.map((l) => (l.key === key ? { ...l, ...p } : l)));
  return (
    <>
      <div style={{ position: 'relative', marginBottom: 8 }}>
        <input className="in" value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜材料SKU：名称 / 规格 / 编码 / 别名，点一下加入" />
        {q.trim() ? (
          <div className="pr-pop">
            {hits.length ? hits.map((m) => {
              const a = avail?.(m.id);
              return (
                <div key={m.id} className="pr-hit" onClick={() => add(m)}>
                  {m.photoUrl ? <img src={m.photoUrl} alt="" /> : <div className="ph0"><Icon name="box" size={18} /></div>}
                  <div style={{ flex: 1 }}><b>{m.name}</b>{m.spec ? <span className="muted"> · {m.spec}</span> : null}<div className="muted" style={{ fontSize: 13 }}>{m.code}{a !== undefined && a !== null ? ` · 可调 ${a}${m.unit}` : ''}</div></div>
                </div>
              );
            }) : <div className="pr-hit muted">没有匹配的材料。新材料先到「材料SKU」建档</div>}
          </div>
        ) : null}
      </div>
      <div className="card" style={{ overflow: 'auto' }}>
        <table className="tbl">
          <thead><tr><th>材料</th>{avail ? <th style={{ textAlign: 'right' }}>可调数量</th> : null}<th style={{ width: 120 }}>数量</th>{withCost ? <th style={{ width: 130 }}>单价(元)</th> : null}{withCost ? <th style={{ textAlign: 'right' }}>金额</th> : null}<th /></tr></thead>
          <tbody>
            {lines.length ? lines.map((l) => {
              const m = mOf(l.materialId); const a = avail?.(l.materialId);
              const over = a !== undefined && a !== null && num(l.qty) > a;
              return (
                <tr key={l.key} style={{ cursor: 'default' }}>
                  <td><div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>{m?.photoUrl ? <img src={m.photoUrl} alt="" className="pr-thumb" /> : <div className="pr-thumb ph0"><Icon name="box" size={16} /></div>}<div><b>{m?.name || `#${l.materialId}`}</b><span className="sub">{m?.spec || '—'}</span></div></div></td>
                  {avail ? <td style={{ textAlign: 'right' }} className={over ? 'over' : 'muted'}>{a ?? 0}{unitOf(l.materialId)}</td> : null}
                  <td><div style={{ display: 'flex', alignItems: 'center', gap: 4 }}><input className="in" type="number" min={0} step="any" style={{ height: 36, borderColor: over ? 'var(--dang)' : undefined }} value={l.qty} onChange={(e) => set(l.key, { qty: e.target.value })} /><span className="muted">{unitOf(l.materialId)}</span></div></td>
                  {withCost ? <td><input className="in" type="number" min={0} step="0.01" style={{ height: 36 }} value={l.cost} onChange={(e) => set(l.key, { cost: e.target.value })} /></td> : null}
                  {withCost ? <td style={{ textAlign: 'right', fontWeight: 600 }}>{money(num(l.cost) * num(l.qty))}</td> : null}
                  <td><button className="btn sm" onClick={() => onChange(lines.filter((x) => x.key !== l.key))}>✕</button></td>
                </tr>
              );
            }) : <tr><td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 24, cursor: 'default' }}>在上面搜材料加入</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

function useBase() {
  const [materials, setMaterials] = useState<MaterialView[] | null>(null);
  const [warehouses, setWarehouses] = useState<WarehouseView[]>([]);
  useEffect(() => {
    inventory.listMaterials().then((l) => setMaterials(l.filter((m) => m.enabled))).catch(() => setMaterials([]));
    inventory.listWarehouses({ scope: 'visible' }).then((l) => setWarehouses(l.filter((w) => w.enabled))).catch(() => setWarehouses([]));
  }, []);
  return { materials, warehouses };
}

/* ───────── 一般入库：不经采购单（零星采购、退库、调剂来的） ───────── */
const SOURCES = ['零星采购', '维修退库', '他处调剂', '赠送 / 其他'];
export function InboundForm({ defaultWarehouseId, onClose, onDone }: { defaultWarehouseId?: number | null; onClose: () => void; onDone: () => void }) {
  const { materials, warehouses } = useBase();
  const [warehouseId, setWarehouseId] = useState<number | ''>(defaultWarehouseId || '');
  const [srcTag, setSrcTag] = useState(SOURCES[0]);
  const [src, setSrc] = useState('');
  const [files, setFiles] = useState<string[]>([]);
  const [lines, setLines] = useState<SkuLine[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!warehouseId && warehouses.length) setWarehouseId((warehouses.find((w) => w.preferred) || warehouses[0]).id);
  }, [warehouses, warehouseId]);
  const unitOf = (id: number) => materials?.find((m) => m.id === id)?.unit || '';
  const total = lines.reduce((s, l) => s + num(l.cost) * num(l.qty), 0);


  const submit = async () => {
    if (!warehouseId) { toast('选入库仓库'); return; }
    if (!lines.length) { toast('加入要入库的材料'); return; }
    if (lines.some((l) => !(num(l.qty) > 0))) { toast('数量要大于 0'); return; }
    if (lines.some((l) => l.cost === '')) { toast('每行都要填单价（退库/赠送可填 0）'); return; }
    setBusy(true);
    try {
      const r = await inventory.createGeneralReceipt({
        warehouseId, sourceText: [srcTag, src.trim()].filter(Boolean).join('：'), attachments: files,
        items: lines.map((l) => ({ materialId: l.materialId, qty: num(l.qty), unitCostCents: Math.round(num(l.cost) * 100) })),
      } as Parameters<typeof inventory.createGeneralReceipt>[0]);
      toast(`已入库 ${r.receiptNo}`); onDone();
    } catch (e) { toast(e instanceof Error ? e.message : '入库失败'); }
    finally { setBusy(false); }
  };

  return (
    <Sheet open onClose={onClose} width={860} title="一般入库" subtitle="不经采购单的进货：零星采购、维修退库、他处调剂；按采购单到货请在「采购 → 在途」入库">
      {materials === null ? <Loading /> : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.4fr', gap: 12 }}>
            <Field label="入库仓库">
              <select className="in" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value ? Number(e.target.value) : '')}>
                <option value="">选择仓库</option>
                {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}{w.officeName ? ` · ${w.officeName}` : ''}</option>)}
              </select>
            </Field>
            <Field label="材料来源">
              <div className="chips" style={{ marginBottom: 6 }}>{SOURCES.map((s) => <button key={s} className={`chip ${srcTag === s ? 'on' : ''}`} onClick={() => setSrcTag(s)}>{s}</button>)}</div>
              <input className="in" value={src} onChange={(e) => setSrc(e.target.value)} placeholder="补充：哪家店 / 哪张工单退回 / 从哪调来" />
            </Field>
          </div>
          <SkuLines materials={materials} lines={lines} onChange={setLines} withCost unitOf={unitOf} />
          <Field label="小票 / 发票（照片或 PDF，选填）">
            <PhotoField value={files} onChange={setFiles} max={10} accept="image/*,application/pdf" asTags />
          </Field>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, borderTop: '1px solid var(--line)', paddingTop: 12 }}>
            <span>{lines.length} 种材料 · 金额 <b style={{ fontSize: 20 }}>{money(total)}</b></span><span style={{ flex: 1 }} />
            <Btn onClick={onClose}>取消</Btn><Btn kind="p" size="lg" disabled={busy} onClick={() => void submit()}>{busy ? '提交中…' : '确认入库'}</Btn>
          </div>
        </>
      )}
    </Sheet>
  );
}

/* ───────── 发起调拨：发货仓 → 接收仓，经理审批后发货，接收仓按实收入库 ───────── */
export function TransferForm({ defaultFromId, onClose, onDone }: { defaultFromId?: number | null; onClose: () => void; onDone: () => void }) {
  const { materials, warehouses } = useBase();
  const [fromId, setFromId] = useState<number | ''>(defaultFromId || '');
  const [toId, setToId] = useState<number | ''>('');
  const [stocks, setStocks] = useState<StockView[]>([]);
  const [lines, setLines] = useState<SkuLine[]>([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!fromId) { setStocks([]); return; }
    inventory.listStocks({ warehouseId: fromId }).then(setStocks).catch(() => setStocks([]));
  }, [fromId]);
  const avail = (id: number) => (fromId ? num(stocks.find((s) => s.materialId === id)?.qty) : null);
  const unitOf = (id: number) => materials?.find((m) => m.id === id)?.unit || '';
  // 只列发货仓有货的材料，免得选了才发现调不出
  const inStock = useMemo(() => (materials ?? []).filter((m) => !fromId || num(stocks.find((s) => s.materialId === m.id)?.qty) > 0), [materials, stocks, fromId]);

  const submit = async () => {
    if (!fromId || !toId) { toast('选发货仓和接收仓'); return; }
    if (fromId === toId) { toast('发货仓和接收仓不能相同'); return; }
    if (!lines.length) { toast('加入要调拨的材料'); return; }
    const bad = lines.find((l) => !(num(l.qty) > 0) || num(l.qty) > (avail(l.materialId) ?? 0));
    if (bad) { toast('有材料的数量为 0 或超过发货仓库存'); return; }
    setBusy(true);
    try {
      await request({ method: 'POST', url: '/transfer-orders', data: { fromWarehouseId: fromId, toWarehouseId: toId, note: note.trim() || undefined, items: lines.map((l) => ({ materialId: l.materialId, qty: num(l.qty) })) } });
      toast('已提交调拨，等物业经理审批'); onDone();
    } catch (e) { toast(e instanceof Error ? e.message : '提交失败'); }
    finally { setBusy(false); }
  };

  return (
    <Sheet open onClose={onClose} width={820} title="发起调拨" subtitle="经理审批通过即从发货仓扣出，接收仓按实收入库">
      {materials === null ? <Loading /> : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', gap: 10, alignItems: 'end' }}>
            <Field label="发货仓">
              <select className="in" value={fromId} onChange={(e) => { setFromId(e.target.value ? Number(e.target.value) : ''); setLines([]); }}>
                <option value="">选择仓库</option>
                {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select>
            </Field>
            <div style={{ marginBottom: 22, fontSize: 20 }}>→</div>
            <Field label="接收仓">
              <select className="in" value={toId} onChange={(e) => setToId(e.target.value ? Number(e.target.value) : '')}>
                <option value="">选择仓库</option>
                {warehouses.filter((w) => w.id !== fromId).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select>
            </Field>
          </div>
          {fromId ? <SkuLines materials={inStock} lines={lines} onChange={setLines} avail={avail} unitOf={unitOf} /> : <div className="muted" style={{ padding: 20, textAlign: 'center' }}>先选发货仓，只列它有货的材料</div>}
          <Field label="备注（选填）"><input className="in" value={note} onChange={(e) => setNote(e.target.value)} placeholder="为什么调、急不急" /></Field>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <Btn onClick={onClose}>取消</Btn><Btn kind="p" size="lg" disabled={busy} onClick={() => void submit()}>{busy ? '提交中…' : '提交调拨'}</Btn>
          </div>
        </>
      )}
    </Sheet>
  );
}

/* ───────── 单据：调拨单（审批 / 驳回 / 收货）与入库记录 ───────── */
interface TransferRow {
  id: number; transferNo: string; fromWarehouseId: number; toWarehouseId: number; status: 'pending_review' | 'approved' | 'received' | 'rejected';
  items: Array<{ materialId: number; qty: number; receivedQty?: number }>; note: string | null; rejectReason: string | null;
  createdAt: string; approvedAt: string | null; receivedAt: string | null;
}
interface ReceiptRow { id: number; receiptNo: string; receiptType: string; purchaseOrderId: number | null; sourceText: string | null; attachments: string[]; warehouseId: number; items: Array<{ materialId: number; qty: number; unitCostCents: number }>; createdAt: string }
const TR_TEXT: Record<TransferRow['status'], { t: string; c: string }> = {
  pending_review: { t: '待经理审批', c: 's-pend' }, approved: { t: '已发货，待收货', c: 's-work' }, received: { t: '已收货', c: 's-done' }, rejected: { t: '已驳回', c: 's-off' },
};

export function StockDocs({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const { materials, warehouses } = useBase();
  const [tab, setTab] = useState<'transfer' | 'receipt'>('transfer');
  const [transfers, setTransfers] = useState<TransferRow[] | null>(null);
  const [receipts, setReceipts] = useState<ReceiptRow[] | null>(null);
  const [open, setOpen] = useState<TransferRow | null>(null);
  const [recv, setRecv] = useState<Record<number, string>>({});
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  // 调拨单的经理这一步跟采购同属「采购·经理审核」，兼容旧 key
  const canApprove = can('app:approve-purchase-manager', 'edit') || can('app:approve-manager', 'edit');
  const canEdit = can('inventory', 'edit') || can('app:inventory', 'edit');

  const load = () => {
    request<TransferRow[]>({ url: '/transfer-orders' }).then(setTransfers).catch(() => setTransfers([]));
    request<ReceiptRow[]>({ url: '/goods-receipts' }).then(setReceipts).catch(() => setReceipts([]));
  };
  useEffect(load, []);
  const wName = (id: number) => warehouses.find((w) => w.id === id)?.name || `仓库#${id}`;
  const mOf = (id: number) => materials?.find((m) => m.id === id);
  const itemsText = (items: Array<{ materialId: number; qty: number }>) => items.map((i) => `${mOf(i.materialId)?.name || '#' + i.materialId}×${i.qty}${mOf(i.materialId)?.unit || ''}`).join('、');

  const act = async (fn: () => Promise<unknown>, msg: string) => {
    setBusy(true);
    try { await fn(); toast(msg); setOpen(null); setReason(''); load(); onChanged(); }
    catch (e) { toast(e instanceof Error ? e.message : '操作失败'); }
    finally { setBusy(false); }
  };
  const sorted = useMemo(() => {
    const order = { pending_review: 0, approved: 1, received: 2, rejected: 3 } as const;
    return [...(transfers ?? [])].sort((a, b) => order[a.status] - order[b.status] || b.id - a.id);
  }, [transfers]);

  return (
    <Sheet open onClose={onClose} width={980} title="入库与调拨单据" subtitle="调拨：审批 → 发货 → 接收仓收货；入库记录含采购到货与一般入库">
      <div className="seg" style={{ marginBottom: 12 }}>
        <button className={tab === 'transfer' ? 'on' : ''} onClick={() => setTab('transfer')}>调拨单 {transfers?.filter((t) => t.status === 'pending_review' || t.status === 'approved').length || ''}</button>
        <button className={tab === 'receipt' ? 'on' : ''} onClick={() => setTab('receipt')}>入库记录</button>
      </div>
      {tab === 'transfer' ? (
        transfers === null ? <Loading /> : (
          <div className="card" style={{ overflow: 'auto' }}>
            <table className="tbl">
              <thead><tr><th>调拨单</th><th>发货 → 接收</th><th>材料</th><th>状态</th><th>发起</th></tr></thead>
              <tbody>
                {sorted.length ? sorted.map((t) => (
                  <tr key={t.id} className={t.status === 'rejected' ? 'off' : ''} onClick={() => { setOpen(t); setReason(''); setRecv(Object.fromEntries(t.items.map((i) => [i.materialId, String(i.qty)]))); }}>
                    <td><b>{t.transferNo}</b>{t.note ? <span className="sub">{t.note}</span> : null}</td>
                    <td>{wName(t.fromWarehouseId)} → {wName(t.toWarehouseId)}</td>
                    <td className="muted" style={{ maxWidth: 300 }}>{itemsText(t.items)}</td>
                    <td><span className={`pill ${TR_TEXT[t.status].c}`}>{TR_TEXT[t.status].t}</span></td>
                    <td className="muted">{ago(t.createdAt)}</td>
                  </tr>
                )) : <tr><td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 24 }}>还没有调拨单</td></tr>}
              </tbody>
            </table>
          </div>
        )
      ) : receipts === null ? <Loading /> : (
        <div className="card" style={{ overflow: 'auto' }}>
          <table className="tbl">
            <thead><tr><th>入库单</th><th>仓库</th><th>来源</th><th>材料</th><th style={{ textAlign: 'right' }}>金额</th><th>时间</th></tr></thead>
            <tbody>
              {receipts.length ? receipts.map((r) => (
                <tr key={r.id} style={{ cursor: 'default' }}>
                  <td><b>{r.receiptNo}</b>{r.attachments?.length ? <span className="sub">{r.attachments.map((u, i) => <a key={u} href={u} target="_blank" rel="noreferrer" style={{ marginRight: 6 }}>附件{i + 1}</a>)}</span> : null}</td>
                  <td>{wName(r.warehouseId)}</td>
                  <td className="muted">{r.purchaseOrderId ? '采购到货' : r.sourceText || '一般入库'}</td>
                  <td className="muted" style={{ maxWidth: 300 }}>{itemsText(r.items)}</td>
                  <td style={{ textAlign: 'right' }}>{money(r.items.reduce((s, i) => s + i.qty * i.unitCostCents, 0) / 100)}</td>
                  <td className="muted">{dayjs(r.createdAt).format('MM-DD HH:mm')}</td>
                </tr>
              )) : <tr><td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 24 }}>还没有入库记录</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {open ? (
        <div className="cmdk" style={{ alignItems: 'center', paddingTop: 0 }} onClick={() => setOpen(null)}>
          <div className="box" style={{ width: 640, padding: 20 }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ margin: '0 0 6px', fontSize: 18 }}>{open.transferNo} <span className={`pill ${TR_TEXT[open.status].c}`}>{TR_TEXT[open.status].t}</span></h3>
            <div className="muted" style={{ marginBottom: 10 }}>{wName(open.fromWarehouseId)} → {wName(open.toWarehouseId)} · 发起 {dayjs(open.createdAt).format('MM-DD HH:mm')}{open.approvedAt ? ` · 审批 ${dayjs(open.approvedAt).format('MM-DD HH:mm')}` : ''}{open.receivedAt ? ` · 收货 ${dayjs(open.receivedAt).format('MM-DD HH:mm')}` : ''}</div>
            {open.rejectReason ? <div className="note2" style={{ marginBottom: 10 }}><Icon name="alert" />驳回原因：{open.rejectReason}</div> : null}
            <table className="tbl">
              <thead><tr><th>材料</th><th style={{ textAlign: 'right' }}>调拨数</th><th style={{ width: 130 }}>{open.status === 'approved' ? '实收' : '已收'}</th></tr></thead>
              <tbody>
                {open.items.map((i) => (
                  <tr key={i.materialId} style={{ cursor: 'default' }}>
                    <td><b>{mOf(i.materialId)?.name || `#${i.materialId}`}</b><span className="sub">{mOf(i.materialId)?.spec || ''}</span></td>
                    <td style={{ textAlign: 'right' }}>{i.qty}{mOf(i.materialId)?.unit || ''}</td>
                    <td>{open.status === 'approved' && canEdit
                      ? <input className="in" type="number" min={0} max={i.qty} step="any" style={{ height: 34 }} value={recv[i.materialId] ?? ''} onChange={(e) => setRecv((p) => ({ ...p, [i.materialId]: e.target.value }))} />
                      : <span className="muted">{i.receivedQty ?? '—'}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {open.status === 'pending_review' && canApprove ? (
              <input className="in" style={{ marginTop: 10 }} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="驳回时填原因（通过不用填）" />
            ) : null}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
              <Btn onClick={() => setOpen(null)}>关闭</Btn>
              {open.status === 'pending_review' && canApprove ? (
                <>
                  <Btn kind="d" disabled={busy || !reason.trim()} onClick={() => void act(() => request({ method: 'POST', url: `/transfer-orders/${open.id}/reject`, data: { reason: reason.trim() } }), '已驳回')}>驳回</Btn>
                  <Btn kind="p" disabled={busy} onClick={() => void act(() => request({ method: 'POST', url: `/transfer-orders/${open.id}/approve` }), '已通过，发货仓已扣出，等接收仓收货')}>通过并发货</Btn>
                </>
              ) : null}
              {open.status === 'pending_review' && !canApprove ? <span className="muted" style={{ alignSelf: 'center' }}>等物业经理审批</span> : null}
              {open.status === 'approved' && canEdit ? (
                <Btn kind="p" disabled={busy} onClick={() => {
                  const items = open.items.map((i) => ({ materialId: i.materialId, receivedQty: num(recv[i.materialId]) }));
                  if (items.some((x, k) => x.receivedQty < 0 || x.receivedQty > open.items[k].qty)) { toast('实收不能超过调拨数'); return; }
                  void act(() => request({ method: 'POST', url: `/transfer-orders/${open.id}/receive`, data: { items } }), '已收货入库');
                }}>确认收货</Btn>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </Sheet>
  );
}
