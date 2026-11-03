import { useEffect, useMemo, useState } from 'react';
import { inventory, purchases, request } from '@pms/api-client';
import { PurchaseRequestStatus } from '@pms/shared-types';
import type { MaterialCategoryView, MaterialView, PurchaseRequestView } from '@pms/shared-types';
import Icon from '@/components/Icon';
import { Btn, Field, Loading, Sheet, toast } from '@/components/ui';
import { money } from '@/lib/format';

interface Line { key: string; materialId: number; name: string; spec: string; unit: string; photo: string | null; qty: number; costYuan: string; note: string }
const REASONS = ['补库存', '工单缺料', '公区耗材', '工具设备', '应急备货'];
const num = (v: string | number | null | undefined) => Number(v) || 0;

/**
 * 新建采购申请（重新设计）：
 *  - 低于安全库存的材料一键带入，数量默认补到安全库存的 2 倍；
 *  - 从材料SKU搜（名称/规格/编码/别名），带照片和当前库存，单价默认 SKU 参考价；
 *  - 库里没有的材料当场建 SKU 再加入 —— 采购单、入库都按 SKU 记，没 SKU 的行到下单时才被拦，返工最贵；
 *  - 维修工报上来、还在「待汇总」的缺料可以勾选一起并进来，一张单审批；
 *  - 原因快捷选项 + 补充说明，审批人第一眼看这个。
 */
export default function RequestComposer({ onClose, onCreated }: { onClose: () => void; onCreated: (r: PurchaseRequestView) => void }) {
  const [materials, setMaterials] = useState<MaterialView[] | null>(null);
  const [cats, setCats] = useState<MaterialCategoryView[]>([]);
  const [stockBy, setStockBy] = useState<Map<number, { qty: number; safety: number }>>(new Map());
  const [pending, setPending] = useState<PurchaseRequestView[]>([]);
  const [lines, setLines] = useState<Line[]>([]);
  const [mergeIds, setMergeIds] = useState<number[]>([]);
  const [q, setQ] = useState('');
  const [reasonTag, setReasonTag] = useState('补库存');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [newSku, setNewSku] = useState<{ name: string; spec: string; unit: string; category: string; cost: string } | null>(null);

  useEffect(() => {
    inventory.listMaterials().then((l) => setMaterials(l.filter((m) => m.enabled))).catch(() => setMaterials([]));
    inventory.listMaterialCategories().then(setCats).catch(() => setCats([]));
    inventory.listStocks().then((rows) => {
      const m = new Map<number, { qty: number; safety: number }>();
      for (const s of rows) {
        const cur = m.get(s.materialId) || { qty: 0, safety: 0 };
        m.set(s.materialId, { qty: cur.qty + num(s.qty), safety: cur.safety + num(s.safetyQty) });
      }
      setStockBy(m);
    }).catch(() => undefined);
    purchases.listRequests({ status: PurchaseRequestStatus.OFFICE_REVIEW }).then(setPending).catch(() => setPending([]));
  }, []);

  const low = useMemo(() => (materials ?? []).filter((m) => {
    const s = stockBy.get(m.id);
    return s && s.safety > 0 && s.qty < s.safety;
  }), [materials, stockBy]);

  const hits = useMemo(() => {
    const kw = q.trim().toLowerCase();
    if (!kw) return [];
    return (materials ?? []).filter((m) => [m.name, m.spec, m.code, ...(m.aliases || [])].some((v) => (v || '').toLowerCase().includes(kw))).slice(0, 12);
  }, [materials, q]);

  const add = (m: MaterialView, qty?: number) => {
    setLines((prev) => {
      const at = prev.findIndex((l) => l.materialId === m.id);
      if (at >= 0) return prev.map((l, i) => (i === at ? { ...l, qty: l.qty + (qty ?? 1) } : l));
      return [...prev, { key: `${m.id}-${Date.now()}`, materialId: m.id, name: m.name, spec: m.spec || '', unit: m.unit, photo: m.photoUrl || m.photoUrls?.[0] || null, qty: qty ?? 1, costYuan: m.defaultCostCents ? String(m.defaultCostCents / 100) : '', note: '' }];
    });
  };
  const addLow = () => {
    let n = 0;
    for (const m of low) {
      if (lines.some((l) => l.materialId === m.id)) continue;
      const s = stockBy.get(m.id)!;
      add(m, Math.max(1, Math.ceil(s.safety * 2 - s.qty)));
      n += 1;
    }
    toast(n ? `已带入 ${n} 种低库存材料（补到安全库存的 2 倍，可改）` : '低库存材料都已经在清单里');
  };
  const setLine = (key: string, p: Partial<Line>) => setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...p } : l)));

  const createSku = async () => {
    if (!newSku || !newSku.name.trim() || !newSku.unit.trim()) { toast('名称和单位必填'); return; }
    setBusy(true);
    try {
      const created = await inventory.createMaterial({
        name: newSku.name.trim(), spec: newSku.spec.trim(), unit: newSku.unit.trim(), category: newSku.category || undefined,
        defaultCostCents: Math.round(num(newSku.cost) * 100),
      } as Parameters<typeof inventory.createMaterial>[0]);
      setMaterials((p) => [...(p ?? []), created]);
      add(created);
      setNewSku(null); setQ('');
      toast(`已建 SKU ${created.code || created.name} 并加入清单，之后到材料SKU里补照片和参数`);
    } catch (e) { toast(e instanceof Error ? e.message : '建档失败'); }
    finally { setBusy(false); }
  };

  const merged = pending.filter((r) => mergeIds.includes(r.id));
  const total = lines.reduce((s, l) => s + Math.round(num(l.costYuan) * 100) * l.qty, 0)
    + merged.reduce((s, r) => s + (r.estTotalCents || 0), 0);

  const submit = async () => {
    if (!lines.length && !mergeIds.length) { toast('清单是空的：搜材料加进来，或勾选要并入的待汇总申请'); return; }
    if (lines.some((l) => !(l.qty > 0))) { toast('数量要大于 0'); return; }
    const text = [reasonTag, reason.trim()].filter(Boolean).join('：');
    setBusy(true);
    try {
      const created = await request<PurchaseRequestView>({
        method: 'POST', url: '/purchase-requests',
        data: {
          reason: text,
          mergeRequestIds: mergeIds.length ? mergeIds : undefined,
          items: lines.map((l) => ({
            materialId: l.materialId, name: l.name, spec: l.spec || undefined, unit: l.unit || undefined,
            qty: l.qty, estUnitCostCents: l.costYuan ? Math.round(num(l.costYuan) * 100) : undefined, note: l.note || undefined,
          })),
        },
      });
      toast(`已提交 ${created.requestNo}${created.nextStepLabel ? `，下一步：${created.nextStepLabel}` : ''}`);
      onCreated(created);
    } catch (e) { toast(e instanceof Error ? e.message : '提交失败'); }
    finally { setBusy(false); }
  };

  return (
    <Sheet open onClose={onClose} width={960} title="新建采购申请" subtitle="从材料SKU选，库里没有的当场建档；低库存一键带入">
      {materials === null ? <Loading /> : (
        <>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
            <div style={{ position: 'relative', flex: 1, minWidth: 320 }}>
              <input className="in" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜材料：名称 / 规格 / 编码 / 别名，点一下加入清单" />
              {q.trim() ? (
                <div className="pr-pop">
                  {hits.map((m) => {
                    const s = stockBy.get(m.id);
                    return (
                      <div key={m.id} className="pr-hit" onClick={() => { add(m); setQ(''); }}>
                        {m.photoUrl ? <img src={m.photoUrl} alt="" /> : <div className="ph0"><Icon name="box" size={18} /></div>}
                        <div style={{ flex: 1 }}><b>{m.name}</b>{m.spec ? <span className="muted"> · {m.spec}</span> : null}<div className="muted" style={{ fontSize: 13 }}>{m.code} · {m.category || '未分类'} · 库存 {s ? s.qty : 0}{m.unit}{s && s.safety > 0 && s.qty < s.safety ? <span style={{ color: 'var(--dang)' }}>（低于安全库存 {s.safety}）</span> : null}</div></div>
                        <span className="muted">{m.defaultCostCents ? `${money(m.defaultCostCents / 100)}/${m.unit}` : ''}</span>
                      </div>
                    );
                  })}
                  <div className="pr-hit" style={{ color: 'var(--acc)', fontWeight: 600 }} onClick={() => setNewSku({ name: q.trim(), spec: '', unit: '个', category: '', cost: '' })}>
                    <Icon name="plus" size={18} />库里没有「{q.trim()}」？当场建 SKU 并加入
                  </div>
                </div>
              ) : null}
            </div>
            <Btn disabled={!low.length} onClick={addLow}><Icon name="alert" size={16} />带入低库存材料 {low.length}</Btn>
          </div>

          {newSku ? (
            <div className="card" style={{ padding: 14, marginBottom: 10 }}>
              <b>新建材料SKU</b><span className="muted" style={{ fontSize: 13.5, marginLeft: 8 }}>建好后直接加入清单；照片、参数之后到「材料SKU」里补</span>
              <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr 90px 150px 110px', gap: 8, marginTop: 8 }}>
                <Field label="名称"><input className="in" value={newSku.name} onChange={(e) => setNewSku({ ...newSku, name: e.target.value })} /></Field>
                <Field label="规格型号"><input className="in" value={newSku.spec} onChange={(e) => setNewSku({ ...newSku, spec: e.target.value })} placeholder="如 DN15 铜" /></Field>
                <Field label="单位"><input className="in" value={newSku.unit} onChange={(e) => setNewSku({ ...newSku, unit: e.target.value })} /></Field>
                <Field label="分类">
                  <select className="in" value={newSku.category} onChange={(e) => setNewSku({ ...newSku, category: e.target.value })}>
                    <option value="">（未分类）</option>
                    {cats.filter((c) => c.enabled).map((c) => <option key={c.id} value={c.label}>{c.label}</option>)}
                  </select>
                </Field>
                <Field label="参考单价(元)"><input className="in" type="number" step="0.01" value={newSku.cost} onChange={(e) => setNewSku({ ...newSku, cost: e.target.value })} /></Field>
              </div>
              <div style={{ display: 'flex', gap: 8 }}><Btn kind="p" disabled={busy} onClick={() => void createSku()}>建档并加入</Btn><Btn onClick={() => setNewSku(null)}>取消</Btn></div>
            </div>
          ) : null}

          <div className="card" style={{ overflow: 'auto' }}>
            <table className="tbl">
              <thead><tr><th>材料</th><th style={{ textAlign: 'right' }}>当前库存</th><th style={{ width: 110 }}>数量</th><th style={{ width: 120 }}>预估单价(元)</th><th style={{ textAlign: 'right' }}>小计</th><th>备注</th><th /></tr></thead>
              <tbody>
                {lines.length ? lines.map((l) => {
                  const s = stockBy.get(l.materialId);
                  return (
                    <tr key={l.key} style={{ cursor: 'default' }}>
                      <td><div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>{l.photo ? <img src={l.photo} alt="" className="pr-thumb" /> : <div className="pr-thumb ph0"><Icon name="box" size={16} /></div>}<div><b>{l.name}</b><span className="sub">{l.spec || '—'}</span></div></div></td>
                      <td style={{ textAlign: 'right' }} className={s && s.safety > 0 && s.qty < s.safety ? 'over' : 'muted'}>{s ? s.qty : 0}{l.unit}{s && s.safety > 0 ? <span className="sub">安全 {s.safety}</span> : null}</td>
                      <td><div style={{ display: 'flex', alignItems: 'center', gap: 4 }}><input className="in" type="number" min={0} step="any" style={{ height: 36 }} value={l.qty} onChange={(e) => setLine(l.key, { qty: num(e.target.value) })} /><span className="muted">{l.unit}</span></div></td>
                      <td><input className="in" type="number" min={0} step="0.01" style={{ height: 36 }} value={l.costYuan} placeholder="选填" onChange={(e) => setLine(l.key, { costYuan: e.target.value })} /></td>
                      <td style={{ textAlign: 'right', fontWeight: 600 }}>{l.costYuan ? money(num(l.costYuan) * l.qty) : <span className="muted">—</span>}</td>
                      <td><input className="in" style={{ height: 36 }} value={l.note} placeholder="用在哪 / 品牌要求" onChange={(e) => setLine(l.key, { note: e.target.value })} /></td>
                      <td><button className="btn sm" onClick={() => setLines((p) => p.filter((x) => x.key !== l.key))}>✕</button></td>
                    </tr>
                  );
                }) : <tr><td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 28, cursor: 'default' }}>还没有材料。在上面搜索加入，或点「带入低库存材料」</td></tr>}
              </tbody>
            </table>
          </div>

          {pending.length ? (
            <div className="card" style={{ padding: 12, marginTop: 12 }}>
              <b>一起并入待汇总的缺料申请</b><span className="muted" style={{ fontSize: 13.5, marginLeft: 8 }}>维修工报上来的，勾上就和这张合成一张审批</span>
              <table className="pm-mx" style={{ marginTop: 6 }}>
                <tbody>
                  {pending.map((r) => (
                    <tr key={r.id} style={{ cursor: 'pointer' }} onClick={() => setMergeIds((p) => (p.includes(r.id) ? p.filter((x) => x !== r.id) : [...p, r.id]))}>
                      <td className="c"><input type="checkbox" readOnly checked={mergeIds.includes(r.id)} /></td>
                      <td><b>{r.requestNo}</b>{r.workOrderNo ? <span className="muted"> · 工单 {r.workOrderNo}</span> : null}</td>
                      <td className="muted">{r.items.map((i) => `${i.name}×${i.qty}${i.unit || ''}`).join('、')}</td>
                      <td className="muted">{r.applicantName || ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          <Field label="申请原因（审批人第一眼看这个）">
            <div className="chips" style={{ marginBottom: 6 }}>{REASONS.map((r) => <button key={r} className={`chip ${reasonTag === r ? 'on' : ''}`} onClick={() => setReasonTag(r)}>{r}</button>)}</div>
            <input className="in" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="补充：用在哪、急不急，例如「枫桦二期水泵房换阀门，本周内」" />
          </Field>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12, borderTop: '1px solid var(--line)', paddingTop: 12 }}>
            <span>共 <b>{lines.length}</b> 种材料{mergeIds.length ? `，并入 ${mergeIds.length} 张申请` : ''} · 预估 <b style={{ fontSize: 20 }}>{money(total / 100)}</b></span>
            <span style={{ flex: 1 }} />
            <Btn onClick={onClose}>取消</Btn>
            <Btn kind="p" size="lg" disabled={busy} onClick={() => void submit()}>{busy ? '提交中…' : '提交申请'}</Btn>
          </div>
        </>
      )}
    </Sheet>
  );
}
