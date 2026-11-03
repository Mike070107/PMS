import { useEffect, useMemo, useState } from 'react';
import { stocktakes, inventory } from '@pms/api-client';
import type { StocktakeTaskView, StocktakeStatus, WarehouseView } from '@pms/shared-types';
import { STOCKTAKE_STATUS_LABELS } from '@pms/shared-types';
import { legacyUrl } from '@/lib/legacy';
import { dayjs } from '@/lib/format';
import Icon from '@/components/Icon';
import { Loading, toast } from '@/components/ui';

const TAG: Record<StocktakeStatus, string> = {
  counting: 'warn', submitted: 'acc', approved: 'ok', rejected: 'dang', cancelled: 'mute',
};
type Filter = '' | StocktakeStatus;

/**
 * 盘点（beta 新建）：盘点任务列表——状态、进度（已盘/总数）、差异；可新建。
 * 走 /stocktakes。逐项点数与复核进旧盘点页（扫码/逐行录入，流程重），这里管调度和总览。
 */
export default function Stocktakes() {
  const [list, setList] = useState<StocktakeTaskView[] | null>(null);
  const [warehouses, setWarehouses] = useState<WarehouseView[]>([]);
  const [filter, setFilter] = useState<Filter>('');
  const [newWh, setNewWh] = useState<number | 0>(0);
  const [busy, setBusy] = useState(false);

  const load = () => { setList(null); stocktakes.list().then(setList).catch(() => setList([])); };
  useEffect(() => {
    load();
    inventory.listWarehouses({ scope: 'mine' }).then(setWarehouses).catch(() => setWarehouses([]));
  }, []);

  const rows = useMemo(() => (list ?? []).filter((t) => !filter || t.status === filter), [list, filter]);

  const create = async () => {
    if (!newWh) { toast('请先选择仓库'); return; }
    setBusy(true);
    try {
      const t = await stocktakes.create({ warehouseId: newWh });
      toast(`已建盘点单 ${t.taskNo}`);
      window.location.href = legacyUrl('/stocktakes');
    } catch (e) { toast(e instanceof Error ? e.message : '新建失败'); }
    finally { setBusy(false); }
  };

  if (list === null) return <Loading />;

  const FILTERS: Array<[Filter, string]> = [['', '全部'], ['counting', '盘点中'], ['submitted', '待复核'], ['approved', '已完成'], ['rejected', '已退回']];

  return (
    <>
      <div className="ph" style={{ marginBottom: 14 }}>
        <div><h1 style={{ fontSize: 22 }}>盘点</h1><p>盘点任务的状态与进度 · 共 {rows.length} 单</p></div>
        <div className="act" style={{ display: 'flex', gap: 8 }}>
          <select className="in" style={{ width: 160 }} value={newWh} onChange={(e) => setNewWh(Number(e.target.value))}>
            <option value={0}>选择仓库…</option>
            {warehouses.filter((w) => w.enabled).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
          <button className="btn p" disabled={busy || !newWh} onClick={create}><Icon name="plus" size={18} />新建盘点</button>
        </div>
      </div>

      <div className="wo-bar"><div className="chips">{FILTERS.map(([k, n]) => <button key={k} className={`chip ${filter === k ? 'on' : ''}`} onClick={() => setFilter(k)}>{n}</button>)}</div></div>

      {rows.length === 0 ? (
        <div className="card" style={{ padding: 48, textAlign: 'center', marginTop: 4 }}><span className="muted">没有盘点单</span></div>
      ) : (
        <div className="card" style={{ overflow: 'hidden', marginTop: 4 }}>
          <div className="rowList">
            {rows.map((t) => {
              const pct = t.totalCount ? Math.round((t.countedCount / t.totalCount) * 100) : 0;
              return (
                <div key={t.id} className="lrow" style={{ cursor: 'pointer' }} onClick={() => { window.location.href = legacyUrl('/stocktakes'); }}>
                  <div className={`li ic ${t.status === 'approved' ? 'green' : t.status === 'rejected' ? 'red' : 'amber'}`}><Icon name="clipboard" /></div>
                  <div className="lt">
                    <b>{t.title || t.taskNo} <span className={`tag ${TAG[t.status]}`} style={{ marginLeft: 6 }}>{STOCKTAKE_STATUS_LABELS[t.status]}</span></b>
                    <small>{t.warehouseName} · 已盘 {t.countedCount}/{t.totalCount}（{pct}%）{t.differenceCount ? ` · 差异 ${t.differenceCount} 项` : ''} · {dayjs(t.createdAt).format('MM-DD HH:mm')}</small>
                  </div>
                  {t.differenceCount ? <span className="tag warn"><Icon name="alert" size={14} />差异 {t.differenceCount}</span> : t.status === 'approved' ? <span className="tag ok"><Icon name="check" size={14} />无差异</span> : null}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="note2" style={{ marginTop: 16 }}><Icon name="alert" />逐项点数、扫码录入与复核仍在旧盘点页（流程重、要留痕）；这里管新建与进度总览，点一条进旧页继续。</div>
    </>
  );
}
