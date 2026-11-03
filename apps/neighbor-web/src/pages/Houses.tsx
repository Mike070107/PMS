import { useEffect, useMemo, useState } from 'react';
import { address, request } from '@pms/api-client';
import type { AddressCommunity } from '@pms/shared-types';
import { sortedBuildings } from '@pms/shared-types';
import { useSession } from '@/lib/auth';
import Icon from '@/components/Icon';
import { Loading, Sheet, ConfirmModal, Field, toast } from '@/components/ui';
import ToneIcon from '@/components/ToneIcon';

interface Owner { id: number; name: string | null; phone: string | null }
interface House {
  id: number; communityId: number; buildingId: number; roomNo: string; propertyType: string;
  roadName: string | null; fullAddress: string | null; shopName: string | null; areaSqm: number | null;
  lane: string | null; buildingNo: string; communityName: string;
  owner: Owner | null; owners: Owner[]; archivedAt: string | null;
}

const PAGE = 30;
const TYPES = ['住宅', '商铺', '办公楼', '公司', '车库', '其他'];
const maskPhone = (p?: string | null) => (p && p.length >= 7 ? `${p.slice(0, 3)}****${p.slice(-4)}` : p || '');
const typeTone = (t: string) => (t === '商铺' ? 'amber' : t === '办公楼' || t === '公司' ? 'blue' : 'green');
const tagClass = (t: string) => (typeTone(t) === 'green' ? 'ok' : typeTone(t) === 'amber' ? 'warn' : 'acc');

/**
 * 房产档案：完整房产清单，可查、可编辑、可归档（软删除可恢复），并显示关联业主。
 * 只做档案本身——不放「去收费」「车辆门禁」等跨业务入口（各有专门页面）。数据走 /houses。
 */
export default function Houses() {
  const session = useSession();
  const [tree, setTree] = useState<AddressCommunity[] | null>(null);
  const [communityId, setCommunityId] = useState<number | 0>(0);
  const [buildingId, setBuildingId] = useState<number | 0>(0);
  const [q, setQ] = useState('');
  const [archived, setArchived] = useState(false);
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<House[] | null>(null);
  const [total, setTotal] = useState(0);
  const [err, setErr] = useState('');
  const [active, setActive] = useState<House | null>(null);

  useEffect(() => { address.tree().then(setTree).catch(() => setTree([])); }, []);

  const allowedIds = useMemo(() => {
    const a = session.access;
    if (!a || a.scopeAll) return null;
    return new Set(a.communityIds ?? []);
  }, [session.access]);
  const communities = useMemo(() => {
    const list = (tree ?? []).filter((c) => !c.isGroup);
    return allowedIds ? list.filter((c) => allowedIds.has(c.id)) : list;
  }, [tree, allowedIds]);
  const buildings = useMemo(() => sortedBuildings(communities.find((c) => c.id === communityId)?.buildings ?? []), [communities, communityId]);

  const query = useMemo(() => ({
    communityId: communityId || undefined,
    buildingId: buildingId || undefined,
    q: q.trim() || undefined,
    archived: archived ? '1' : undefined,
    page, pageSize: PAGE,
  }), [communityId, buildingId, q, archived, page]);

  const load = () => {
    setRows(null); setErr('');
    request<{ rows: House[]; total: number }>({ url: '/houses', query })
      .then((r) => { setRows(r.rows); setTotal(r.total); })
      .catch((e) => { setRows([]); setErr(e instanceof Error ? e.message : '加载失败'); });
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [communityId, buildingId, archived, page]);

  const pages = Math.max(1, Math.ceil(total / PAGE));

  return (
    <>
      <div className="ph" style={{ marginBottom: 14 }}>
        <div><div className="h1row"><ToneIcon kind="houses" /><h1 style={{ fontSize: 22 }}>房产档案</h1></div><p>按小区楼栋查房、看业主，编辑或归档房产 · 共 {total} 套{archived ? '（已归档）' : ''}</p></div>
      </div>

      <div className="wo-bar" style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <div className="chips" style={{ display: 'flex', gap: 6 }}>
          <button className={`chip ${!archived ? 'on' : ''}`} onClick={() => { setArchived(false); setPage(1); }}>在册</button>
          <button className={`chip ${archived ? 'on' : ''}`} onClick={() => { setArchived(true); setPage(1); }}>已归档</button>
        </div>
        <select className="in" style={{ width: 200 }} value={communityId} onChange={(e) => { setCommunityId(Number(e.target.value)); setBuildingId(0); setPage(1); }}>
          <option value={0}>全部小区</option>
          {communities.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select className="in" style={{ width: 170 }} value={buildingId} disabled={!communityId} onChange={(e) => { setBuildingId(Number(e.target.value)); setPage(1); }}>
          <option value={0}>{communityId ? '全部楼栋' : '先选小区'}</option>
          {buildings.map((b) => <option key={b.id} value={b.id}>{b.lane ? `${b.lane}弄${b.buildingNo}号` : `${b.buildingNo}号楼`}</option>)}
        </select>
        <input className="in" style={{ width: 240 }} value={q} placeholder="搜房号 / 业主 / 地址，回车"
          onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { setPage(1); load(); } }} />
        <button className="btn" onClick={() => { setPage(1); load(); }}><Icon name="search" size={18} />查询</button>
      </div>

      {err ? <div className="note2" style={{ background: 'var(--dang-w)', color: 'var(--dang)', borderColor: '#eccac6', marginTop: 4 }}><Icon name="alert" />{err}</div> : null}

      {rows === null ? <Loading /> : rows.length === 0 ? (
        <div className="card" style={{ padding: 48, textAlign: 'center', marginTop: 4 }}><span className="muted">{archived ? '没有已归档的房产' : '没有匹配的房产'}</span></div>
      ) : (
        <div className="card" style={{ overflow: 'hidden', marginTop: 4 }}>
          <div className="rowList">
            {rows.map((h) => (
              <div key={h.id} className="lrow" style={{ cursor: 'pointer' }} onClick={() => setActive(h)}>
                <div className={`li ic ${typeTone(h.propertyType)}`}><Icon name="home" /></div>
                <div className="lt">
                  <b>{h.communityName} {h.buildingNo}/{h.roomNo}{h.shopName ? ` · ${h.shopName}` : ''}</b>
                  <small>
                    {h.owner?.name || '未登记业主'}{h.owner?.phone ? ` · ${maskPhone(h.owner.phone)}` : ''}
                    {h.owners.length > 1 ? ` · 共 ${h.owners.length} 位业主` : ''}
                    {h.areaSqm ? ` · ${h.areaSqm}㎡` : ''}
                  </small>
                </div>
                {h.archivedAt ? <span className="tag muted">已归档</span> : <span className={`tag ${tagClass(h.propertyType)}`}>{h.propertyType}</span>}
                <button className="btn sm" onClick={(e) => { e.stopPropagation(); setActive(h); }}><Icon name="edit" size={16} />详情</button>
              </div>
            ))}
          </div>
        </div>
      )}

      {pages > 1 ? (
        <div style={{ display: 'flex', gap: 10, justifyContent: 'center', alignItems: 'center', marginTop: 18 }}>
          <button className="btn sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>上一页</button>
          <span className="muted">第 {page} / {pages} 页</span>
          <button className="btn sm" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>下一页</button>
        </div>
      ) : null}

      <div className="note2" style={{ marginTop: 16 }}><Icon name="alert" />归档为软删除：从在册清单移除但可随时在「已归档」里恢复，不会丢数据。新增房产、楼栋单元管理仍在旧房产页（管理员操作）。手机号默认脱敏。</div>

      {active ? <HouseSheet house={active} onClose={() => setActive(null)} onSaved={() => { setActive(null); load(); }} /> : null}
    </>
  );
}

function HouseSheet({ house, onClose, onSaved }: { house: House; onClose: () => void; onSaved: () => void }) {
  const [roomNo, setRoomNo] = useState(house.roomNo);
  const [propertyType, setPropertyType] = useState(house.propertyType);
  const [areaSqm, setAreaSqm] = useState(house.areaSqm != null ? String(house.areaSqm) : '');
  const [shopName, setShopName] = useState(house.shopName ?? '');
  const [roadName, setRoadName] = useState(house.roadName ?? '');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [confirm, setConfirm] = useState<null | 'archive' | 'restore'>(null);
  const [busy, setBusy] = useState(false);
  const archived = !!house.archivedAt;
  const showShop = propertyType === '商铺' || propertyType === '办公楼' || propertyType === '公司';

  const save = async () => {
    setErr('');
    if (!roomNo.trim()) { setErr('请填写房号或房间／部门名称'); return; }
    if (areaSqm && !/^\d+(\.\d{1,2})?$/.test(areaSqm.trim())) { setErr('面积只能是数字，最多两位小数'); return; }
    setSaving(true);
    try {
      await request({
        url: `/houses/${house.id}`, method: 'PATCH',
        data: {
          roomNo: roomNo.trim(), propertyType,
          areaSqm: areaSqm.trim() || '',
          shopName: showShop ? shopName.trim() : '',
          roadName: roadName.trim(),
        },
      });
      toast('已保存');
      onSaved();
    } catch (e) { setErr(e instanceof Error ? e.message : '保存失败'); setSaving(false); }
  };

  const doArchive = async (restore: boolean) => {
    setBusy(true);
    try {
      await request({ url: restore ? `/houses/${house.id}/restore` : `/houses/${house.id}`, method: restore ? 'POST' : 'DELETE' });
      toast(restore ? '已恢复到在册' : '已归档');
      onSaved();
    } catch (e) { setErr(e instanceof Error ? e.message : '操作失败'); setBusy(false); setConfirm(null); }
  };

  return (
    <Sheet open onClose={onClose} width={520}
      title={`${house.communityName} ${house.buildingNo}/${house.roomNo}`}
      subtitle={archived ? '已归档房产' : '房产档案'}>
      <div style={{ padding: '4px 2px' }}>
        {archived ? <div className="note" style={{ background: 'var(--warn-w)', color: 'var(--warn)', marginBottom: 14, fontSize: 13 }}>这套房已归档，不在在册清单里。可恢复后再编辑。</div> : null}

        <div className="muted" style={{ fontSize: 13, marginBottom: 6 }}>关联业主</div>
        <div className="card" style={{ padding: '10px 12px', marginBottom: 16, background: 'var(--bg)' }}>
          {house.owners.length === 0 ? <span className="muted">未登记业主</span> : house.owners.map((o) => (
            <div key={o.id} style={{ display: 'flex', gap: 10, fontSize: 14, lineHeight: 2 }}>
              <b style={{ minWidth: 72 }}>{o.name || '（无名）'}</b>
              <span className="muted">{maskPhone(o.phone)}</span>
            </div>
          ))}
        </div>

        <Field label="房号 / 房间·部门名称">
          <input className="in" value={roomNo} disabled={archived} onChange={(e) => setRoomNo(e.target.value)} style={{ width: '100%' }} />
        </Field>
        <Field label="房产类型">
          <select className="in" value={propertyType} disabled={archived} onChange={(e) => setPropertyType(e.target.value)} style={{ width: '100%' }}>
            {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </Field>
        {showShop ? (
          <Field label="商铺 / 单位名称">
            <input className="in" value={shopName} disabled={archived} onChange={(e) => setShopName(e.target.value)} style={{ width: '100%' }} />
          </Field>
        ) : null}
        <Field label="建筑面积（㎡）" hint="可留空">
          <input className="in" value={areaSqm} disabled={archived} onChange={(e) => setAreaSqm(e.target.value)} placeholder="如 89.50" style={{ width: 200 }} />
        </Field>
        <Field label="所在道路" hint="可留空">
          <input className="in" value={roadName} disabled={archived} onChange={(e) => setRoadName(e.target.value)} placeholder="如 剑川路" style={{ width: '100%' }} />
        </Field>

        {err ? <div className="note" style={{ background: 'var(--dang-w)', color: 'var(--dang)', margin: '8px 0' }}>{err}</div> : null}

        <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
          {archived ? (
            <button className="btn p" style={{ flex: 1 }} disabled={busy} onClick={() => setConfirm('restore')}><Icon name="refresh" size={16} />恢复到在册</button>
          ) : (
            <>
              <button className="btn p" style={{ flex: 1 }} disabled={saving} onClick={() => void save()}>{saving ? '保存中…' : '保存修改'}</button>
              <button className="btn g" disabled={busy} onClick={() => setConfirm('archive')}><Icon name="trash" size={16} />归档</button>
            </>
          )}
        </div>
      </div>

      <ConfirmModal open={confirm === 'archive'} onClose={() => setConfirm(null)} title="归档这套房产？" danger busy={busy}
        confirmText="归档" onConfirm={() => void doArchive(false)}>
        归档后从在册清单移除，业主关联和历史记录都保留，可随时在「已归档」里恢复。
      </ConfirmModal>
      <ConfirmModal open={confirm === 'restore'} onClose={() => setConfirm(null)} title="恢复这套房产？" busy={busy}
        confirmText="恢复" onConfirm={() => void doArchive(true)}>
        恢复后重新出现在在册清单里。
      </ConfirmModal>
    </Sheet>
  );
}
