import { useCallback, useEffect, useMemo, useState } from 'react';
import type { MaterialView, StockMovementView, StockView, WarehouseView } from '@pms/shared-types';
import { inventory, request } from '@pms/api-client';
import { auth } from '@/lib/auth';
import { apiBaseURL } from '@/lib/api';
import WarehouseManager from '@/components/stock/WarehouseManager';
import '@/styles/stock.css';
import { InboundForm, InboundList, TransferForm, TransferList } from '@/components/stock/StockOps';
import { can } from '@/lib/perm';
import { Btn, Card, ErrorNote, Loading, Sheet, toast } from '@/components/ui';
import Icon from '@/components/Icon';
import { dayjs, money } from '@/lib/format';
import ToneIcon from '@/components/ToneIcon';

type StockLocationQty = { locationId?: number; label?: string; zone?: string | null; shelf?: string | null; bin?: string | null; qty?: string | number };
type StockRow = StockView & { updatedAt?: string; locations?: StockLocationQty[]; locationLabel?: string | null };
type StockSort = 'updatedAt' | 'qty' | 'safetyStock' | 'unitCost' | 'amount';
type MovementExtra = StockMovementView & { locationLabel?: string | null; operatorName?: string | null; amountCents?: number };
const SORT_FIELDS: { key: StockSort; label: string }[] = [
  { key: 'qty', label: '当前库存' }, { key: 'safetyStock', label: '安全库存' },
  { key: 'unitCost', label: '单位成本' }, { key: 'amount', label: '库存金额' },
];
const locLabel = (loc: StockLocationQty) => String(loc.label || [loc.zone, loc.shelf, loc.bin].filter(Boolean).join('-') || '库位');
const locQty = (loc: StockLocationQty) => Number(loc.qty) || 0;

const PHOTO_OF = (m?: MaterialView): string[] => {
  if (!m) return [];
  const urls = m.photoUrls?.length ? m.photoUrls : (m.photoUrl ? [m.photoUrl] : []);
  return urls.filter(Boolean);
};

const MOVEMENT_LABEL: Record<string, string> = {
  inbound: '入库', outbound: '出库', transfer: '调拨', adjust: '盘点调整',
};

/**
 * 库存：只看「有什么、在哪、够不够」。
 * 采购在「采购流程」，盘点在左侧标「旧」的入口，这里不内嵌。
 */
export default function Stock() {
  const [stocks, setStocks] = useState<StockRow[] | null>(null);
  const [materials, setMaterials] = useState<MaterialView[]>([]);
  const [warehouses, setWarehouses] = useState<WarehouseView[]>([]);
  const [warehouseId, setWarehouseId] = useState<number | null>(null);
  const [onlyLow, setOnlyLow] = useState(false);
  const [onlyStocked, setOnlyStocked] = useState(true);
  const [q, setQ] = useState('');
  const [err, setErr] = useState('');
  const [peek, setPeek] = useState<StockView | null>(null);
  const [movements, setMovements] = useState<StockMovementView[] | null>(null);
  const [photos, setPhotos] = useState<{ name: string; urls: string[]; index: number } | null>(null);
  const [tab, setTab] = useState<'stock' | 'inbound' | 'transfer'>('stock');
  const [form, setForm] = useState<'inbound' | 'transfer' | null>(null);
  const [opsKey, setOpsKey] = useState(0);
  const [sort, setSort] = useState<StockSort>('updatedAt');
  const [dir, setDir] = useState<'asc' | 'desc'>('desc');
  const [exporting, setExporting] = useState(false);
  const [warehouseOpen, setWarehouseOpen] = useState(false);
  const [movementError, setMovementError] = useState('');
  const canEdit = can('inventory', 'edit') || can('app:inventory', 'edit');

  const load = useCallback(async () => {
    try {
      const [s, m, w] = await Promise.all([
        request<StockRow[]>({ url: '/stocks', query: { warehouseId: warehouseId || undefined, sort, dir } }),
        inventory.listMaterials(),
        inventory.listWarehouses({ scope: 'visible' }),
      ]);
      setStocks(Array.isArray(s) ? s : []);
      setMaterials(m);
      setWarehouses(w);
      setErr('');
    } catch (e) {
      setErr(e instanceof Error ? e.message : '库存加载失败');
    }
  }, [warehouseId, sort, dir]);

  useEffect(() => { void load(); }, [load]);

  const materialOf = (id: number) => materials.find((m) => m.id === id);
  const warehouseOf = (id: number) => warehouses.find((w) => w.id === id)?.name || '—';

  const rows = useMemo(() => {
    const kw = q.trim();
    const mapped = (stocks ?? [])
      .map((s) => {
        const m = materialOf(s.materialId);
        const qty = Number(s.qty);
        const safe = Number(s.safetyQty);
        return { s, m, qty, safe, low: qty <= safe, unitCost: Number(s.unitCostCents) || 0, amount: Number(s.amountCents) || 0, updatedAt: s.updatedAt ? Date.parse(s.updatedAt) : 0, locations: Array.isArray(s.locations) ? s.locations : [] };
      })
      .filter((r) => (onlyLow ? r.low : true))
      .filter((r) => !onlyStocked || r.qty > 0)
      .filter((r) => (kw ? `${r.m?.name || ''}${r.m?.spec || ''}${warehouseOf(r.s.warehouseId)}`.includes(kw) : true));
    const value = (row: typeof mapped[number]) => sort === 'qty' ? row.qty : sort === 'safetyStock' ? row.safe : sort === 'unitCost' ? row.unitCost : sort === 'amount' ? row.amount : row.updatedAt;
    return mapped.sort((a, b) => {
      const byValue = value(a) - value(b);
      const ordered = byValue || (a.m?.name || '').localeCompare(b.m?.name || '');
      return dir === 'asc' ? ordered : -ordered;
    });
  }, [stocks, materials, warehouses, onlyLow, onlyStocked, q, sort, dir]);

  const lowCount = useMemo(
    () => (stocks ?? []).filter((s) => Number(s.qty) <= Number(s.safetyQty)).length,
    [stocks],
  );

  const openPeek = async (s: StockRow) => {
    setPeek(s);
    setMovements(null);
    setMovementError('');
    try {
      setMovements(await inventory.listStockMovements({ materialId: s.materialId, warehouseId: s.warehouseId, limit: 30 }) as MovementExtra[]);
    } catch (e) {
      setMovementError(e instanceof Error ? e.message : '流水读取失败');
      setMovements([]);
    }
  };

  const toggleSort = (field: StockSort) => {
    if (sort === field) setDir((value) => value === 'asc' ? 'desc' : 'asc');
    else { setSort(field); setDir('desc'); }
  };

  const sortTh = (label: string, field: StockSort) => (
    <th style={{ textAlign: 'right' }}>
      <button type="button" className={'stock-sort' + (sort === field ? ' on' : '')} onClick={() => toggleSort(field)}>
        {label}<i aria-hidden="true">{sort === field ? (dir === 'asc' ? '↑' : '↓') : '↕'}</i>
      </button>
    </th>
  );

  const exportStock = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const params = new URLSearchParams();
      if (warehouseId) params.set('warehouseId', String(warehouseId));
      if (q.trim()) params.set('q', q.trim());
      if (onlyLow) params.set('lowOnly', '1');
      params.set('onlyStocked', onlyStocked ? '1' : '0');
      params.set('sort', sort); params.set('dir', dir);
      const token = auth.getToken();
      const tenant = auth.getActingTenant();
      const headers: Record<string, string> = { 'x-client-source': 'admin-web' };
      if (token) headers.Authorization = 'Bearer ' + token;
      if (tenant) headers['x-acting-tenant-id'] = String(tenant.id);
      const res = await fetch((apiBaseURL || '/api/v1') + '/stocks/export?' + params.toString(), { headers });
      if (!res.ok) {
        let msg = '导出失败（HTTP ' + res.status + '）';
        try { const body = await res.json(); msg = body?.message || msg; } catch { /* 非 JSON */ }
        throw new Error(msg);
      }
      const count = Number(res.headers.get('x-export-count') || res.headers.get('x-total-count')) || rows.length;
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url; link.download = '库存清单_' + dayjs().format('YYYYMMDD') + '.xlsx';
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      toast('已导出 ' + count + ' 条');
    } catch (e) {
      toast(e instanceof Error && e.message ? e.message : '导出失败，请稍后重试');
    } finally { setExporting(false); }
  };

  if (stocks === null && !err) return <Loading />;

  return (
    <>
      <div className="ph">
        <div>
          <div className="h1row"><ToneIcon kind="stock" /><h1>库存</h1></div>
          <p>有什么、在哪、够不够；入库、调拨在这里办，采购到货在「采购 → 在途」入库</p>
        </div>
        <div className="act">
          <button className="btn" onClick={() => { void load(); setOpsKey((k) => k + 1); toast('已刷新'); }}>刷新</button>
          <button className="btn" disabled={exporting} onClick={() => void exportStock()}><Icon name="file" size={16} />{exporting ? '导出中…' : '导出 Excel'}</button>
          <button className="btn" onClick={() => setWarehouseOpen(true)}><Icon name="building" size={16} />仓库管理</button>
          {canEdit ? <button className="btn" onClick={() => setForm('transfer')}><Icon name="flow" size={16} />调拨</button> : null}
          {canEdit ? <button className="btn p" onClick={() => setForm('inbound')}><Icon name="plus" size={17} />入库</button> : null}
        </div>
      </div>

      <div className="seg" style={{ marginBottom: 12 }}>
        {([['stock', '库存'], ['inbound', '入库记录'], ['transfer', '调拨']] as const).map(([k, n]) => (
          <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{n}</button>
        ))}
      </div>
      {tab === 'inbound' ? <Card style={{ overflow: 'hidden' }}><InboundList key={opsKey} warehouses={warehouses} materials={materials} /></Card> : null}
      {tab === 'transfer' ? <Card style={{ overflow: 'hidden' }}><TransferList warehouses={warehouses} materials={materials} refreshKey={opsKey} /></Card> : null}
      {form === 'inbound' ? <InboundForm warehouses={warehouses} onClose={() => setForm(null)} onDone={() => { setForm(null); setTab('inbound'); setOpsKey((k) => k + 1); void load(); }} /> : null}
      {form === 'transfer' ? <TransferForm warehouses={warehouses} onClose={() => setForm(null)} onDone={() => { setForm(null); setTab('transfer'); setOpsKey((k) => k + 1); }} /> : null}
      {tab === 'stock' ? (<>

      {err ? <ErrorNote>{err}</ErrorNote> : null}

      <div className="wo-bar">
        <div className="chips">
          <button className={`chip ${warehouseId === null ? 'on' : ''}`} onClick={() => setWarehouseId(null)}>全部仓库</button>
          {warehouses.map((w) => (
            <button key={w.id} className={`chip ${warehouseId === w.id ? 'on' : ''}`} onClick={() => setWarehouseId(w.id)}>{w.name}</button>
          ))}
        </div>
        <input className="in" style={{ width: 220, marginLeft: 'auto' }} placeholder="搜材料名称 / 规格"
          value={q} onChange={(e) => setQ(e.target.value)} />
        <button type="button" className={`chip ${onlyStocked ? 'on' : ''}`} aria-pressed={onlyStocked} onClick={() => setOnlyStocked((v) => !v)}>
          仅显示有货
        </button>
        <button className={`chip ${onlyLow ? 'on' : ''}`} onClick={() => { setOnlyLow((v) => !v); if (!onlyLow) setOnlyStocked(false); }}>
          只看预警 <span className="c">{lowCount}</span>
        </button>
      </div>

      <Card style={{ overflow: 'hidden' }}>
        <table className="t">
          <thead>
            <tr>
              <th style={{ width: 70 }}>图片</th><th>材料</th><th>规格</th><th>仓库</th><th>库位</th>
              {sortTh('当前库存', 'qty')}
              {sortTh('安全库存', 'safetyStock')}
              {sortTh('单位成本', 'unitCost')}
              <th>状态</th>
              {sortTh('库存金额', 'amount')}
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.length ? rows.map(({ s, m, qty, safe, low, locations }) => {
              const shownLocs = locations.slice(0, 2);
              const locTitle = locations.map((loc) => locLabel(loc) + '×' + locQty(loc)).join(' / ') || s.locationLabel || '';
              return (
                <tr key={s.id} className="row" onClick={() => void openPeek(s)}>
                  <td onClick={(e) => {
                    e.stopPropagation();
                    const urls = PHOTO_OF(m);
                    if (urls.length) setPhotos({ name: m?.name || '', urls, index: 0 });
                  }}>
                    {PHOTO_OF(m).length ? (
                      <img src={PHOTO_OF(m)[0]} alt={m?.name || ''} className="stock-thumb" />
                    ) : (
                      <span className="stock-thumb is-empty"><Icon name="box" size={22} /></span>
                    )}
                  </td>
                  <td><b>{m?.name || `#${s.materialId}`}</b></td>
                  <td className="sub">{m?.spec || '—'}</td>
                  <td>{warehouseOf(s.warehouseId)}</td>
                  <td className="stock-locations" title={locTitle || undefined}>
                    {locations.length ? (
                      <>{shownLocs.map((loc) => locLabel(loc) + '×' + locQty(loc)).join(' / ')}{locations.length > 2 ? <span className="muted"> 等 {locations.length} 处</span> : null}</>
                    ) : (s.locationLabel || '—')}
                  </td>
                  <td style={{ textAlign: 'right', fontWeight: 600 }}>{qty} {m?.unit || ''}</td>
                  <td style={{ textAlign: 'right' }} className="muted">{safe}</td>
                  <td style={{ textAlign: 'right' }} className="muted">{money((s.unitCostCents ?? 0) / 100)}</td>
                  <td>{low ? <span className="pill urg">{qty ? '低于安全库存' : '无货'}</span> : <span className="muted">正常</span>}</td>
                  <td style={{ textAlign: 'right' }} className="muted">{money((s.amountCents ?? 0) / 100)}</td>
                  <td style={{ textAlign: 'right' }} onClick={(e) => e.stopPropagation()}>
                    {low ? <Btn size="sm" onClick={() => { window.location.href = `${import.meta.env.BASE_URL}purchase?new=1`; }}>申请采购</Btn> : null}
                  </td>
                </tr>
              );
            }) : <tr><td colSpan={11} className="empty">没有符合条件的库存</td></tr>}
          </tbody>
        </table>
      </Card>

      <div className="note" style={{ marginTop: 14 }}>
        金额按批次加权成本计算（无批次时退回 SKU 参考成本）；当前数量 ≤ 安全库存即预警，安全库存为 0 的材料同样会显示。
      </div>
      </>) : null}

      <Sheet
        open={!!peek}
        onClose={() => setPeek(null)}
        title={peek ? (materialOf(peek.materialId)?.name || `材料 #${peek.materialId}`) : ''}
        subtitle={peek ? `${warehouseOf(peek.warehouseId)} · 批次与流水` : ''}
      >
        {peek ? (
          <>
            <div className="facts">
              <div><small>当前数量</small><b>{Number(peek.qty)} {materialOf(peek.materialId)?.unit || ''}</b></div>
              <div><small>安全库存</small><b>{Number(peek.safetyQty)}</b></div>
              <div><small>单位成本</small><b>{money((peek.unitCostCents ?? 0) / 100)}</b></div>
              <div><small>库存金额</small><b>{money((peek.amountCents ?? 0) / 100)}</b></div>
            </div>
            {PHOTO_OF(materialOf(peek.materialId)).length ? (
              <>
                <div className="sec-t">材料实物照片</div>
                <div className="photos" style={{ marginBottom: 16 }}>
                  {PHOTO_OF(materialOf(peek.materialId)).map((url, index) => (
                    <button key={url} type="button" style={{ padding: 0, border: 0, background: 'none', cursor: 'zoom-in' }}
                      onClick={() => setPhotos({ name: materialOf(peek.materialId)?.name || '', urls: PHOTO_OF(materialOf(peek.materialId)), index })}>
                      <i style={{ backgroundImage: `url(${url})`, backgroundSize: 'cover', backgroundPosition: 'center', width: 96, height: 96, borderRadius: 9, display: 'block' }} />
                    </button>
                  ))}
                </div>
              </>
            ) : null}
            <div className="sec-t">最近出入库流水<span className="r muted">最新在前</span></div>
            {movements === null ? <Loading text="读取流水…" /> : movementError ? (
              <div className="note2 danger" role="alert">{movementError}</div>
            ) : movements.length ? (
              <table className="t stock-lots">
                <thead><tr><th>时间</th><th>类型</th><th style={{ textAlign: 'right' }}>数量</th><th style={{ textAlign: 'right' }}>单价</th><th style={{ textAlign: 'right' }}>金额</th><th>单号</th><th>库位</th><th>经手人</th></tr></thead>
                <tbody>
                  {(movements as MovementExtra[]).map((mv) => {
                    const qty = Number(mv.qty) || 0;
                    const unit = Number(mv.unitCostCents) || 0;
                    const amount = mv.amountCents ?? Math.round(unit * Math.abs(qty));
                    return (
                      <tr key={mv.id}>
                        <td className="muted">{mv.createdAt ? dayjs(mv.createdAt).format('MM-DD HH:mm') : '—'}</td>
                        <td>{MOVEMENT_LABEL[mv.type] || mv.type}</td>
                        <td style={{ textAlign: 'right', fontWeight: 600 }} className={qty < 0 ? 'over' : ''}>{qty > 0 ? `+${qty}` : qty}</td>
                        <td style={{ textAlign: 'right' }}>{money(unit / 100)}</td>
                        <td style={{ textAlign: 'right' }}>{money(amount / 100)}</td>
                        <td className="sub">{mv.refNo || mv.note || '—'}</td>
                        <td>{mv.locationLabel || '—'}</td>
                        <td>{mv.operatorName || '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : <div className="empty">这个仓还没有出入库记录</div>}
          </>
        ) : null}
      </Sheet>
      <WarehouseManager open={warehouseOpen} onClose={() => setWarehouseOpen(false)} warehouses={warehouses} canEdit={canEdit} onChanged={() => void load()} />
      {photos ? (
        <div className="photo-viewer" onClick={() => setPhotos(null)}>
          <div className="pv-inner" onClick={(e) => e.stopPropagation()}>
            <img src={photos.urls[photos.index]} alt={photos.name} />
            <div className="pv-bar">
              <b>{photos.name}</b>
              <span className="muted">{photos.index + 1} / {photos.urls.length}</span>
              <button className="btn sm" onClick={() => setPhotos(null)}>关闭</button>
            </div>
            {photos.urls.length > 1 ? (
              <div className="pv-thumbs">
                {photos.urls.map((url, index) => (
                  <button key={url} type="button" className={index === photos.index ? 'on' : ''}
                    onClick={() => setPhotos({ ...photos, index })}>
                    <img src={url} alt="" />
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}
