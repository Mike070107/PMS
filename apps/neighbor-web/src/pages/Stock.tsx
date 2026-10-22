import { useCallback, useEffect, useMemo, useState } from 'react';
import type { MaterialView, StockMovementView, StockView, WarehouseView } from '@pms/shared-types';
import { inventory } from '@pms/api-client';
import { Btn, Card, ErrorNote, Loading, Sheet, toast } from '@/components/ui';
import { dayjs, money } from '@/lib/format';

const MOVEMENT_LABEL: Record<string, string> = {
  inbound: '入库', outbound: '出库', transfer: '调拨', adjust: '盘点调整',
};

/**
 * 库存：只看「有什么、在哪、够不够」。
 * 采购在「采购流程」，盘点在左侧标「旧」的入口，这里不内嵌。
 */
export default function Stock() {
  const [stocks, setStocks] = useState<StockView[] | null>(null);
  const [materials, setMaterials] = useState<MaterialView[]>([]);
  const [warehouses, setWarehouses] = useState<WarehouseView[]>([]);
  const [warehouseId, setWarehouseId] = useState<number | null>(null);
  const [onlyLow, setOnlyLow] = useState(false);
  const [q, setQ] = useState('');
  const [err, setErr] = useState('');
  const [peek, setPeek] = useState<StockView | null>(null);
  const [movements, setMovements] = useState<StockMovementView[] | null>(null);

  const load = useCallback(async () => {
    try {
      const [s, m, w] = await Promise.all([
        inventory.listStocks(warehouseId ? { warehouseId } : {}),
        inventory.listMaterials(),
        inventory.listWarehouses({ scope: 'visible' }),
      ]);
      setStocks(s);
      setMaterials(m);
      setWarehouses(w);
      setErr('');
    } catch (e) {
      setErr(e instanceof Error ? e.message : '库存加载失败');
    }
  }, [warehouseId]);

  useEffect(() => { void load(); }, [load]);

  const materialOf = (id: number) => materials.find((m) => m.id === id);
  const warehouseOf = (id: number) => warehouses.find((w) => w.id === id)?.name || '—';

  const rows = useMemo(() => {
    const kw = q.trim();
    return (stocks ?? [])
      .map((s) => {
        const m = materialOf(s.materialId);
        const qty = Number(s.qty);
        const safe = Number(s.safetyQty);
        return { s, m, qty, safe, low: qty <= safe };
      })
      .filter((r) => (onlyLow ? r.low : true))
      .filter((r) => (kw ? `${r.m?.name || ''}${r.m?.spec || ''}${warehouseOf(r.s.warehouseId)}`.includes(kw) : true))
      .sort((a, b) => Number(b.low) - Number(a.low) || (a.m?.name || '').localeCompare(b.m?.name || ''));
  }, [stocks, materials, warehouses, onlyLow, q]);

  const lowCount = useMemo(
    () => (stocks ?? []).filter((s) => Number(s.qty) <= Number(s.safetyQty)).length,
    [stocks],
  );

  const openPeek = async (s: StockView) => {
    setPeek(s);
    setMovements(null);
    try {
      setMovements(await inventory.listStockMovements({ materialId: s.materialId, warehouseId: s.warehouseId, limit: 30 }));
    } catch {
      setMovements([]);
    }
  };

  if (stocks === null && !err) return <Loading />;

  return (
    <>
      <div className="ph">
        <div>
          <h1>库存</h1>
          <p>有什么、在哪、够不够；采购在「采购流程」，盘点在左侧标「旧」的入口</p>
        </div>
        <div className="act">
          <button className="btn" onClick={() => { void load(); toast('已刷新'); }}>刷新</button>
          <button className="btn" onClick={() => { window.location.href = '/inventory'; }}>入库 / 调拨</button>
        </div>
      </div>

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
        <button className={`chip ${onlyLow ? 'on' : ''}`} onClick={() => setOnlyLow((v) => !v)}>
          只看预警 <span className="c">{lowCount}</span>
        </button>
      </div>

      <Card style={{ overflow: 'hidden' }}>
        <table className="t">
          <thead>
            <tr>
              <th>材料</th><th>规格</th><th>仓库</th>
              <th style={{ textAlign: 'right' }}>当前</th>
              <th style={{ textAlign: 'right' }}>安全库存</th>
              <th>状态</th>
              <th style={{ textAlign: 'right' }}>金额</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.length ? rows.map(({ s, m, qty, safe, low }) => (
              <tr key={s.id} className="row" onClick={() => void openPeek(s)}>
                <td><b>{m?.name || `#${s.materialId}`}</b></td>
                <td className="sub">{m?.spec || '—'}</td>
                <td>{warehouseOf(s.warehouseId)}</td>
                <td style={{ textAlign: 'right', fontWeight: 600 }}>{qty} {m?.unit || ''}</td>
                <td style={{ textAlign: 'right' }} className="muted">{safe}</td>
                <td>{low ? <span className="pill urg">{qty ? '低于安全库存' : '无货'}</span> : <span className="muted">正常</span>}</td>
                <td style={{ textAlign: 'right' }} className="muted">{money((s.amountCents ?? 0) / 100)}</td>
                <td style={{ textAlign: 'right' }} onClick={(e) => e.stopPropagation()}>
                  {low ? <Btn size="sm" onClick={() => { window.location.href = '/inventory'; }}>申请采购</Btn> : null}
                </td>
              </tr>
            )) : <tr><td colSpan={8} className="empty">没有符合条件的库存</td></tr>}
          </tbody>
        </table>
      </Card>

      <div className="note" style={{ marginTop: 14 }}>
        金额按批次加权成本计算（无批次时退回 SKU 参考成本）；当前数量 ≤ 安全库存即预警，安全库存为 0 的材料同样会显示。
        入库、调拨、盘点仍在现有「库存与采购」页，这里只读。
      </div>

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
            <div className="sec-t">最近出入库流水<span className="r muted">最新在前</span></div>
            {movements === null ? <Loading text="读取流水…" /> : movements.length ? (
              <table className="t">
                <thead><tr><th>类型</th><th style={{ textAlign: 'right' }}>数量</th><th>来源单据</th><th>时间</th></tr></thead>
                <tbody>
                  {movements.map((mv) => (
                    <tr key={mv.id}>
                      <td>{MOVEMENT_LABEL[mv.type] || mv.type}</td>
                      <td style={{ textAlign: 'right', fontWeight: 600 }} className={Number(mv.qty) < 0 ? 'over' : ''}>
                        {Number(mv.qty) > 0 ? `+${Number(mv.qty)}` : Number(mv.qty)}
                      </td>
                      <td className="sub">{mv.refNo || mv.note || '—'}</td>
                      <td className="muted">{mv.createdAt ? dayjs(mv.createdAt).format('MM-DD HH:mm') : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <div className="empty">这个仓还没有出入库记录</div>}
          </>
        ) : null}
      </Sheet>
    </>
  );
}
