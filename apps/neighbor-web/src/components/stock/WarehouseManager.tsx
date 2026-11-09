import { useCallback, useEffect, useMemo, useState } from 'react';
import { request } from '@pms/api-client';
import type { WarehouseView } from '@pms/shared-types';
import { Btn, Loading, Sheet, toast } from '@/components/ui';

type LocationView = { id: number; warehouseId: number; zone?: string | null; shelf?: string | null; bin?: string | null; label: string; enabled: boolean };
type OfficeOption = { id: number; name: string };
type WarehouseDraft = { name: string; type: string; officeId: string; enabled: boolean };
type LocationDraft = { zone: string; shelf: string; bin: string; enabled: boolean };

const emptyWarehouse = (): WarehouseDraft => ({ name: '', type: 'office', officeId: '', enabled: true });
const emptyLocation = (): LocationDraft => ({ zone: '', shelf: '', bin: '', enabled: true });

/** 仓库与库位管理：仓库新建/改名/启停；点仓库进入库位增改/删除。 */
export default function WarehouseManager({ open, onClose, warehouses, canEdit, onChanged }: {
  open: boolean;
  onClose: () => void;
  warehouses: WarehouseView[];
  canEdit: boolean;
  onChanged: () => void;
}) {
  const [locations, setLocations] = useState<LocationView[] | null>(null);
  const [offices, setOffices] = useState<OfficeOption[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<WarehouseView | null>(null);
  const [warehouseForm, setWarehouseForm] = useState<WarehouseDraft | null>(null);
  const [editingWarehouse, setEditingWarehouse] = useState<WarehouseView | null>(null);
  const [locationForm, setLocationForm] = useState<LocationDraft | null>(null);
  const [editingLocation, setEditingLocation] = useState<LocationView | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<LocationView | null>(null);

  const reload = useCallback(async () => {
    try {
      const [locs, opts] = await Promise.all([
        request<LocationView[]>({ url: '/warehouse-locations' }),
        request<OfficeOption[]>({ url: '/warehouses/offices' }).catch(() => [] as OfficeOption[]),
      ]);
      setLocations(Array.isArray(locs) ? locs : []);
      setOffices(Array.isArray(opts) ? opts : []);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : '仓库数据读取失败');
      setLocations([]);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setSelected(null); setWarehouseForm(null); setEditingWarehouse(null); setLocationForm(null); setEditingLocation(null); setConfirmDelete(null);
    void reload();
  }, [open, reload]);

  const locationCount = useMemo(() => {
    const map = new Map<number, number>();
    for (const loc of locations || []) map.set(loc.warehouseId, (map.get(loc.warehouseId) || 0) + 1);
    return map;
  }, [locations]);

  const selectedLocations = useMemo(() => (locations || []).filter((loc) => selected && loc.warehouseId === selected.id), [locations, selected]);

  const run = async (action: () => Promise<unknown>, ok: string) => {
    if (!canEdit || busy) return;
    setBusy(true); setError('');
    try {
      await action();
      toast(ok);
      await reload();
      onChanged();
      return true;
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : '操作失败，请稍后重试');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const saveWarehouse = async () => {
    const form = warehouseForm;
    if (!form || !form.name.trim()) { setError('请填写仓库名称'); return; }
    const body = { name: form.name.trim(), type: form.type, officeId: form.officeId ? Number(form.officeId) : null, enabled: form.enabled };
    const ok = await run(() => editingWarehouse
      ? request({ method: 'PATCH', url: '/warehouses/' + editingWarehouse.id, data: body })
      : request({ method: 'POST', url: '/warehouses', data: body }), editingWarehouse ? '仓库已改名' : '仓库已新建');
    if (ok) { setWarehouseForm(null); setEditingWarehouse(null); }
  };
  const toggleWarehouse = (warehouse: WarehouseView) => run(
    () => request({ method: 'PATCH', url: '/warehouses/' + warehouse.id, data: { enabled: !warehouse.enabled } }),
    warehouse.enabled ? '已停用仓库' : '已启用仓库',
  );

  const saveLocation = async () => {
    const form = locationForm;
    if (!form || !selected) return;
    if (!form.zone.trim() && !form.shelf.trim() && !form.bin.trim()) { setError('请至少填写库区 / 货架 / 货位之一'); return; }
    const body = { zone: form.zone.trim() || null, shelf: form.shelf.trim() || null, bin: form.bin.trim() || null, enabled: form.enabled };
    const ok = await run(() => editingLocation
      ? request({ method: 'PATCH', url: '/warehouse-locations/' + editingLocation.id, data: body })
      : request({ method: 'POST', url: '/warehouse-locations', data: { ...body, warehouseId: selected.id } }), editingLocation ? '库位已更新' : '库位已新增');
    if (ok) { setLocationForm(null); setEditingLocation(null); }
  };
  const toggleLocation = (loc: LocationView) => run(
    () => request({ method: 'PATCH', url: '/warehouse-locations/' + loc.id, data: { enabled: !loc.enabled } }),
    loc.enabled ? '已停用库位' : '已启用库位',
  );
  const deleteLocation = async (loc: LocationView) => {
    setBusy(true); setError('');
    try {
      await request({ method: 'DELETE', url: '/warehouse-locations/' + loc.id });
      toast('库位已删除');
      setConfirmDelete(null);
      await reload();
      onChanged();
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : '删除失败：该库位可能还有库存');
    } finally { setBusy(false); }
  };

  return (
    <Sheet open={open} onClose={onClose} width={860} title={selected ? `库位管理 · ${selected.name}` : '仓库管理'} subtitle={selected ? `${selected.officeName || selected.communityName || '公司级'} · 共 ${selectedLocations.length} 个库位` : '仓库新建 / 改名 / 启停；点仓库进入库位管理'}>
      {error ? <div className="note2 danger" role="alert">{error}</div> : null}
      {!canEdit ? <div className="note2">当前账号没有库存编辑权限，仅可查看。</div> : null}
      {locations === null ? <Loading /> : selected ? (
        <>
          <div className="wm-bar">
            <Btn size="sm" onClick={() => { setSelected(null); setLocationForm(null); setEditingLocation(null); setConfirmDelete(null); }}>← 返回仓库列表</Btn>
            {canEdit ? <Btn size="sm" kind="p" onClick={() => { setLocationForm(emptyLocation()); setEditingLocation(null); }}>+ 新增库位</Btn> : null}
          </div>
          {locationForm ? (
            <div className="wm-form">
              <input className="in" placeholder="库区（可选）" value={locationForm.zone} onChange={(e) => setLocationForm({ ...locationForm, zone: e.target.value })} />
              <input className="in" placeholder="货架（可选）" value={locationForm.shelf} onChange={(e) => setLocationForm({ ...locationForm, shelf: e.target.value })} />
              <input className="in" placeholder="货位（可选）" value={locationForm.bin} onChange={(e) => setLocationForm({ ...locationForm, bin: e.target.value })} />
              <label className="wm-check"><input type="checkbox" checked={locationForm.enabled} onChange={(e) => setLocationForm({ ...locationForm, enabled: e.target.checked })} />启用</label>
              <Btn size="sm" kind="p" disabled={busy} onClick={() => void saveLocation()}>{editingLocation ? '保存' : '新增'}</Btn>
              <Btn size="sm" onClick={() => { setLocationForm(null); setEditingLocation(null); }}>取消</Btn>
            </div>
          ) : null}
          <table className="t wm-table">
            <thead><tr><th>库区</th><th>货架</th><th>货位</th><th>组合名</th><th>启用</th><th /></tr></thead>
            <tbody>
              {selectedLocations.map((loc) => (
                <tr key={loc.id}>
                  <td>{loc.zone || '—'}</td>
                  <td>{loc.shelf || '—'}</td>
                  <td>{loc.bin || '—'}</td>
                  <td><b>{loc.label}</b></td>
                  <td>{loc.enabled ? <span className="pill ok">启用</span> : <span className="pill">停用</span>}</td>
                  <td className="wm-actions">
                    {canEdit ? <>
                      <button className="btn sm" onClick={() => { setEditingLocation(loc); setLocationForm({ zone: loc.zone || '', shelf: loc.shelf || '', bin: loc.bin || '', enabled: loc.enabled }); }}>改名</button>
                      <button className="btn sm" disabled={busy} onClick={() => void toggleLocation(loc)}>{loc.enabled ? '停用' : '启用'}</button>
                      <button className="btn sm danger" disabled={busy} onClick={() => setConfirmDelete(loc)}>删除</button>
                    </> : null}
                  </td>
                </tr>
              ))}
              {!selectedLocations.length ? <tr><td colSpan={6} className="empty">该仓库还没有库位</td></tr> : null}
            </tbody>
          </table>
          {confirmDelete ? (
            <div className="wm-confirm" role="alert">
              <span>删除库位「{confirmDelete.label}」？有库存时后端会拒绝。</span>
              <Btn size="sm" kind="d" disabled={busy} onClick={() => void deleteLocation(confirmDelete)}>确认删除</Btn>
              <Btn size="sm" onClick={() => setConfirmDelete(null)}>取消</Btn>
            </div>
          ) : null}
        </>
      ) : (
        <>
          <div className="wm-bar">
            {canEdit ? <Btn size="sm" kind="p" onClick={() => { setWarehouseForm(emptyWarehouse()); setEditingWarehouse(null); }}>+ 新建仓库</Btn> : null}
          </div>
          {warehouseForm ? (
            <div className="wm-form">
              <input className="in" placeholder="仓库名称" value={warehouseForm.name} onChange={(e) => setWarehouseForm({ ...warehouseForm, name: e.target.value })} />
              <select className="in" value={warehouseForm.type} onChange={(e) => setWarehouseForm({ ...warehouseForm, type: e.target.value })}>
                <option value="office">管理处仓</option><option value="community">小区仓</option><option value="central">总仓</option>
              </select>
              <select className="in" value={warehouseForm.officeId} onChange={(e) => setWarehouseForm({ ...warehouseForm, officeId: e.target.value })}>
                <option value="">公司级</option>
                {offices.map((office) => <option key={office.id} value={office.id}>{office.name}</option>)}
              </select>
              <Btn size="sm" kind="p" disabled={busy} onClick={() => void saveWarehouse()}>{editingWarehouse ? '保存' : '新建'}</Btn>
              <Btn size="sm" onClick={() => { setWarehouseForm(null); setEditingWarehouse(null); }}>取消</Btn>
            </div>
          ) : null}
          <table className="t wm-table">
            <thead><tr><th>仓库名</th><th>管理处</th><th>库位数</th><th>启用</th><th /></tr></thead>
            <tbody>
              {warehouses.map((warehouse) => (
                <tr key={warehouse.id} className="wm-row" onClick={() => setSelected(warehouse)}>
                  <td><b>{warehouse.name}</b></td>
                  <td>{warehouse.officeName || warehouse.communityName || '公司级'}</td>
                  <td>{locationCount.get(warehouse.id) || 0}</td>
                  <td>{warehouse.enabled ? <span className="pill ok">启用</span> : <span className="pill">停用</span>}</td>
                  <td className="wm-actions" onClick={(e) => e.stopPropagation()}>
                    {canEdit ? <>
                      <button className="btn sm" onClick={() => { setEditingWarehouse(warehouse); setWarehouseForm({ name: warehouse.name, type: warehouse.type, officeId: warehouse.officeId ? String(warehouse.officeId) : '', enabled: warehouse.enabled }); }}>改名</button>
                      <button className="btn sm" disabled={busy} onClick={() => void toggleWarehouse(warehouse)}>{warehouse.enabled ? '停用' : '启用'}</button>
                    </> : null}
                    <span className="muted">库位管理 →</span>
                  </td>
                </tr>
              ))}
              {!warehouses.length ? <tr><td colSpan={5} className="empty">还没有仓库</td></tr> : null}
            </tbody>
          </table>
        </>
      )}
    </Sheet>
  );
}
