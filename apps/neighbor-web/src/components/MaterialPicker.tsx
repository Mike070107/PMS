import { useEffect, useMemo, useState } from 'react';
import type { WorkOrderStockOptions } from '@pms/shared-types';
import { repairs } from '@pms/api-client';
import { Btn, Loading } from '@/components/ui';

/** 一行用料：从材料SKU选的带 materialId/warehouseId（扣库存），手填的只记名称数量 */
export interface MatLine {
  key: string;
  materialId?: number;
  warehouseId?: number;
  name: string;
  spec?: string | null;
  unit?: string;
  qty: string;
  /** 选中时该仓库存，用来提示「超出库存」 */
  stockQty?: number;
}

let seq = 0;
const nextKey = () => `l${Date.now()}_${seq++}`;

/**
 * 工单用料选择（完工领料 / 缺料登记共用）：
 * 先选仓库 → 搜材料SKU（名称/规格/编码/别名）点一下加入 → 填数量；材料SKU里没有的可手填。
 * mode='use' 只列有货的、超出库存会标红；mode='missing' 连 0 库存的也列，用于报缺料。
 */
export default function MaterialPicker({
  workOrderId, mode, lines, onChange,
}: {
  workOrderId: number;
  mode: 'use' | 'missing';
  lines: MatLine[];
  onChange: (lines: MatLine[]) => void;
}) {
  const [stock, setStock] = useState<WorkOrderStockOptions | null>(null);
  const [warehouseId, setWarehouseId] = useState<number | undefined>(undefined);
  const [q, setQ] = useState('');
  const [loadErr, setLoadErr] = useState('');

  useEffect(() => {
    setStock(null); setLoadErr('');
    repairs.stockOptions(workOrderId, warehouseId)
      .then((s) => { setStock(s); if (warehouseId === undefined && s.warehouseId) setWarehouseId(s.warehouseId); })
      .catch((e) => { setLoadErr(e instanceof Error ? e.message : '材料加载失败'); setStock(null); });
  }, [workOrderId, warehouseId]);

  const matches = useMemo(() => {
    const items = (stock?.items ?? []).filter((it) => (mode === 'use' ? it.qty > 0 : true));
    const kw = q.trim().toLowerCase();
    const hit = kw
      ? items.filter((it) => [it.name, it.spec, it.code, ...(it.aliases ?? [])].some((s) => (s || '').toLowerCase().includes(kw)))
      : items;
    return hit.slice(0, kw ? 30 : 12);
  }, [stock, q, mode]);

  const add = (line: Omit<MatLine, 'key'>) => {
    const dup = line.materialId ? lines.find((l) => l.materialId === line.materialId && l.warehouseId === line.warehouseId) : undefined;
    if (dup) return;
    onChange([...lines, { ...line, key: nextKey() }]);
  };
  const update = (key: string, patch: Partial<MatLine>) => onChange(lines.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const remove = (key: string) => onChange(lines.filter((l) => l.key !== key));

  return (
    <div className="matpick">
      {stock && stock.warehouses.length > 1 ? (
        // 仓库按数据授权范围由服务端过滤；等宽网格排齐，名字太长省略号 + 悬停看全名
        <div className="mp-wh">
          {stock.warehouses.map((w) => (
            <button key={w.id} type="button" title={w.name} className={`mp-wh-i ${(warehouseId ?? stock.warehouseId) === w.id ? 'on' : ''}`} onClick={() => setWarehouseId(w.id)}>
              <span className="nm">{w.name}</span>
              {w.own ? <span className="tag acc">默认</span> : null}
              {mode === 'use' && !w.hasStock ? <span className="tag mute">无货</span> : null}
            </button>
          ))}
        </div>
      ) : null}

      <input className="in" value={q} onChange={(e) => setQ(e.target.value)} placeholder={`搜材料SKU：名称 / 规格 / 编码${stock?.warehouseName ? ` · ${stock.warehouseName}` : ''}`} />
      {loadErr ? <div className="note" style={{ color: 'var(--dang)' }}>{loadErr}</div> : null}
      {!stock && !loadErr ? <Loading text="加载材料…" /> : null}
      {stock ? (
        <div className="matpick-list">
          {matches.length === 0 ? <div className="muted" style={{ padding: '8px 4px', fontSize: 14 }}>{q ? '材料SKU里没找到，可在下面手填' : mode === 'use' ? '这个仓没有有货的材料' : '没有材料'}</div> : matches.map((it) => {
            const on = lines.some((l) => l.materialId === it.materialId && l.warehouseId === (stock.warehouseId ?? undefined));
            return (
              <button key={it.materialId} className={`matpick-item ${on ? 'on' : ''}`} disabled={on}
                onClick={() => add({ materialId: it.materialId, warehouseId: stock.warehouseId ?? undefined, name: it.name, spec: it.spec, unit: it.unit, qty: '1', stockQty: it.qty })}>
                {it.photoUrl ? <img src={it.photoUrl} alt="" /> : <span className="ph" />}
                <span className="nm">{it.name}{it.spec ? <small> · {it.spec}</small> : null}</span>
                <span className={`st ${it.qty > 0 ? '' : 'zero'}`}>{it.qty > 0 ? `库存 ${it.qty}${it.unit}` : '无货'}</span>
                <span className="add">{on ? '已加' : '＋'}</span>
              </button>
            );
          })}
        </div>
      ) : null}

      {lines.length ? (
        <table className="t" style={{ marginTop: 10 }}>
          <thead><tr><th>材料</th><th style={{ width: 150 }}>数量</th><th style={{ width: 120 }}>单位</th><th style={{ width: 44 }} /></tr></thead>
          <tbody>
            {lines.map((l) => {
              const over = mode === 'use' && l.materialId != null && l.stockQty != null && Number(l.qty) > l.stockQty;
              return (
                <tr key={l.key} className="mp-row">
                  <td>
                    {l.materialId ? <b style={{ fontWeight: 600 }}>{l.name}{l.spec ? <span className="muted" style={{ fontWeight: 400 }}> · {l.spec}</span> : null}</b>
                      : <input className="in" value={l.name} onChange={(e) => update(l.key, { name: e.target.value })} placeholder="材料名称（手填）" />}
                    {l.materialId ? null : <div className="muted" style={{ fontSize: 12.5 }}>{mode === 'use' ? '手填的不扣库存，只记录' : '手填的会进采购申请，由办公室对应到材料SKU'}</div>}
                    {over ? <div style={{ color: 'var(--dang)', fontSize: 12.5 }}>超出库存 {l.stockQty}{l.unit}，不够的部分请登记缺料</div> : null}
                  </td>
                  <td>
                    {/* 加减按钮放在输入框两边，按钮和框一样高，方便点 */}
                    <span className="mp-step">
                      <button type="button" aria-label="减一" disabled={!(Number(l.qty) > 1)} onClick={() => update(l.key, { qty: String(Math.max(1, Math.round((Number(l.qty) || 1) - 1))) })}>−</button>
                      <input className="in" inputMode="decimal" value={l.qty} onChange={(e) => update(l.key, { qty: e.target.value })} />
                      <button type="button" aria-label="加一" onClick={() => update(l.key, { qty: String(Math.floor(Number(l.qty) || 0) + 1) })}>＋</button>
                    </span>
                  </td>
                  <td>
                    {l.materialId ? <span className="mp-unit-ro">{l.unit}</span> : <UnitSelect value={l.unit || ''} onChange={(unit) => update(l.key, { unit })} />}
                  </td>
                  <td><button className="btn sm" onClick={() => remove(l.key)} title="删除">✕</button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : null}
      <div style={{ marginTop: 8 }}>
        <Btn size="sm" onClick={() => onChange([...lines, { key: nextKey(), name: q.trim(), qty: '1' }])}>＋ 材料SKU里没有，手填一种</Btn>
      </div>
    </div>
  );
}

const COMMON_UNITS = ['个', '只', '套', '米', '根', '卷', '盒', '包', '把', '块', '张', '桶', '升', '公斤'];

/** 单位：常用单位直接选，选「其他」再手写（手写过的值也能回显） */
function UnitSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [custom, setCustom] = useState(!!value && !COMMON_UNITS.includes(value));
  if (custom) {
    return (
      <span className="mp-unit">
        <input className="in" autoFocus={!value} maxLength={6} value={value} placeholder="单位" onChange={(e) => onChange(e.target.value.trim())} />
        <button type="button" className="btn g sm" title="改回从列表选" onClick={() => { setCustom(false); onChange(''); }}>选</button>
      </span>
    );
  }
  return (
    <select className="in" value={value} onChange={(e) => { if (e.target.value === '__other') { setCustom(true); onChange(''); } else onChange(e.target.value); }}>
      <option value="">选单位</option>
      {COMMON_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
      <option value="__other">其他（手写）</option>
    </select>
  );
}

/** 校验并转成接口要的行；有问题返回错误文案 */
export function linesToPayload(lines: MatLine[], mode: 'use' | 'missing'): { error: string } | { rows: Array<{ materialId?: number; warehouseId?: number; name: string; qty: number; unit?: string }> } {
  const rows = [];
  for (const l of lines) {
    const qty = Number(l.qty);
    if (!l.name.trim() && !l.materialId) continue;
    if (!(qty > 0)) return { error: `「${l.name || '手填材料'}」数量要大于 0` };
    if (!l.materialId && !l.unit?.trim()) return { error: `「${l.name || '手填材料'}」请选单位` };
    if (mode === 'use' && l.materialId != null && l.stockQty != null && qty > l.stockQty) {
      return { error: `「${l.name}」超出库存（${l.stockQty}${l.unit || ''}），不够的部分请登记缺料` };
    }
    rows.push({ materialId: l.materialId, warehouseId: l.warehouseId, name: l.name.trim(), qty, unit: l.unit || undefined });
  }
  return { rows };
}
