import { useEffect, useMemo, useState } from 'react';
import { address, request } from '@pms/api-client';
import type { AddressCommunity } from '@pms/shared-types';
import { useSession } from '@/lib/auth';
import { dayjs } from '@/lib/format';
import Icon from '@/components/Icon';
import { Loading, toast, Sheet, ConfirmModal, Field } from '@/components/ui';
import HousePicker, { type PickedHouse } from '@/components/HousePicker';
import { useAddressTree } from '@/lib/address-tree';
import ToneIcon from '@/components/ToneIcon';
import { can } from '@/lib/perm';

interface LastInteraction { kind: 'repair'; at: string; label: string }
interface OwnerHouse { id: number; roomNo: string; buildingNo: string; lane: string | null; communityName: string | null }
interface OwnerRow {
  id: number; name: string | null; phone: string | null; status: string | null; source: string | null;
  contactNote: string | null; houseId: number | null; house: OwnerHouse | null; lastInteraction: LastInteraction | null;
}
interface Audit {
  id: number; name: string; phone: string; address: string; communityName: string;
  houseId: number | null; roomNo: string; status: string; rejectReason: string | null; createdAt: string;
}

const maskPhone = (p?: string | null) => (p && p.length >= 7 ? `${p.slice(0, 3)}****${p.slice(-4)}` : p || '');
const placeOf = (h: OwnerHouse | null) => (h ? `${h.communityName || ''} ${h.buildingNo}/${h.roomNo}` : '');
// contactNote 里存着主号之外的其它号码/固话，按常见分隔切开当「多电话」展示
const extraPhones = (note: string | null) => (note || '').split(/[,，;；/、\n]+/).map((s) => s.trim()).filter(Boolean);

/**
 * 业主：待核实审核（小程序/报修登记进来的，审核通过才正式绑房）+ 业主档案。
 * 档案页只做档案：查、编辑、归档/恢复、多电话、关联房产；不放「去收费」等跨业务入口。
 * 「已核实」= 活跃业主且系统里有过真实交互（最近报修）。走 /owners/audits 与 /owners-mgmt。
 */
export default function Owners() {
  const session = useSession();
  const canAudit = can('owners', 'view'), canDirectory = can('properties', 'view');
  const [selectedTab, setTab] = useState<'audit' | 'dir'>('audit');
  const tab = (selectedTab === 'audit' ? canAudit : canDirectory) ? selectedTab : canAudit ? 'audit' : 'dir';
  const [tree, setTree] = useState<AddressCommunity[]>([]);
  const [audits, setAudits] = useState<Audit[] | null>(null);
  const [owners, setOwners] = useState<OwnerRow[] | null>(null);
  const [communityId, setCommunityId] = useState<number | 0>(0);
  const [archived, setArchived] = useState(false);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState<number | null>(null);
  const [active, setActive] = useState<OwnerRow | null>(null);

  useEffect(() => { if (canDirectory) address.tree().then(setTree).catch(() => setTree([])); }, [canDirectory]);
  const loadAudits = () => { if (!canAudit) return; setAudits(null); request<Audit[]>({ url: '/owners/audits', query: { status: 'pending' } }).then(setAudits).catch(() => setAudits([])); };
  const loadOwners = () => {
    if (!canDirectory) return;
    setOwners(null);
    request<OwnerRow[]>({ url: '/owners-mgmt', query: { communityId: communityId || undefined, status: archived ? 'disabled' : 'active', q: q.trim() || undefined } })
      .then(setOwners).catch(() => setOwners([]));
  };
  useEffect(loadAudits, [canAudit]);
  useEffect(loadOwners, [communityId, archived, canDirectory]);

  const communities = useMemo(() => {
    const list = tree.filter((c) => !c.isGroup);
    const a = session.access;
    if (!a || a.scopeAll) return list;
    const ids = new Set(a.communityIds ?? []);
    return list.filter((c) => ids.has(c.id));
  }, [tree, session.access]);

  if (!canAudit && !canDirectory) return null;

  const approve = async (a: Audit) => {
    setBusy(a.id);
    try { await request({ method: 'POST', url: `/owners/audits/${a.id}/approve`, data: {} }); toast(`已通过：${a.name}`); loadAudits(); }
    catch (e) { toast(e instanceof Error ? e.message : '操作失败'); }
    finally { setBusy(null); }
  };
  const reject = async (a: Audit) => {
    const reason = window.prompt(`驳回「${a.name}」的业主登记，请填写原因：`, '信息不符');
    if (!reason) return;
    setBusy(a.id);
    try { await request({ method: 'POST', url: `/owners/audits/${a.id}/reject`, data: { reason } }); toast(`已驳回：${a.name}`); loadAudits(); }
    catch (e) { toast(e instanceof Error ? e.message : '操作失败'); }
    finally { setBusy(null); }
  };

  const pendN = audits?.length ?? 0;

  return (
    <>
      <div className="ph" style={{ marginBottom: 14 }}>
        <div><div className="h1row"><ToneIcon kind="owners" /><h1 style={{ fontSize: 22 }}>业主</h1></div><p>审核新登记、管理业主档案</p></div>
      </div>

      <div className="seg" style={{ display: 'inline-flex', marginBottom: 16 }}>
        {canAudit ? <button className={tab === 'audit' ? 'on' : ''} onClick={() => setTab('audit')}><Icon name="shield" size={16} />待核实{pendN ? ` (${pendN})` : ''}</button> : null}
        {canDirectory ? <button className={tab === 'dir' ? 'on' : ''} onClick={() => setTab('dir')}><Icon name="users" size={16} />业主档案</button> : null}
      </div>

      {tab === 'audit' ? (
        audits === null ? <Loading /> : audits.length === 0 ? (
          <div className="card" style={{ padding: '48px 20px', textAlign: 'center' }}>
            <Icon name="check" size={40} style={{ color: 'var(--ok)', marginBottom: 10 }} />
            <div className="muted">没有待核实的业主登记</div>
          </div>
        ) : (
          <div className="card" style={{ overflow: 'hidden' }}>
            <div className="rowList">
              {audits.map((a) => (
                <div key={a.id} className="lrow">
                  <div className="li ic amber"><Icon name="users" /></div>
                  <div className="lt">
                    <b>{a.name || '（未填名）'} · {maskPhone(a.phone)}</b>
                    <small>自报地址：{a.address || a.roomNo || '—'} · 登记于 {dayjs(a.createdAt).format('MM-DD HH:mm')}</small>
                  </div>
                  <button className="btn sm" disabled={busy === a.id} onClick={() => reject(a)}><Icon name="x" size={16} />驳回</button>
                  <button className="btn p sm" disabled={busy === a.id} onClick={() => approve(a)}><Icon name="check" size={16} />{busy === a.id ? '…' : '通过并绑房'}</button>
                </div>
              ))}
            </div>
          </div>
        )
      ) : (
        <>
          <div className="wo-bar" style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <div className="chips" style={{ display: 'flex', gap: 6 }}>
              <button className={`chip ${!archived ? 'on' : ''}`} onClick={() => setArchived(false)}>在册</button>
              <button className={`chip ${archived ? 'on' : ''}`} onClick={() => setArchived(true)}>已归档</button>
            </div>
            <select className="in" style={{ width: 200 }} value={communityId} onChange={(e) => setCommunityId(Number(e.target.value))}>
              <option value={0}>全部小区</option>
              {communities.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <input className="in" style={{ width: 240 }} value={q} placeholder="搜业主姓名 / 手机号，回车"
              onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') loadOwners(); }} />
            <button className="btn" onClick={loadOwners}><Icon name="search" size={18} />查询</button>
          </div>
          {owners === null ? <Loading /> : owners.length === 0 ? (
            <div className="card" style={{ padding: 48, textAlign: 'center', marginTop: 4 }}><span className="muted">{archived ? '没有已归档的业主' : '没有匹配的业主'}</span></div>
          ) : (
            <div className="card" style={{ overflow: 'hidden', marginTop: 4 }}>
              <div className="rowList">
                {owners.map((o) => {
                  const extras = extraPhones(o.contactNote);
                  const verified = o.status === 'active' && !!o.lastInteraction;
                  return (
                    <div key={o.id} className="lrow" style={{ cursor: 'pointer' }} onClick={() => setActive(o)}>
                      <div className={`li ic ${o.status === 'active' ? 'blue' : 'mute'}`}><Icon name="users" /></div>
                      <div className="lt">
                        <b>
                          {o.name || '（未填名）'}
                          {o.status !== 'active' ? <span className="tag mute" style={{ marginLeft: 8, height: 20 }}>已归档</span>
                            : verified ? <span className="tag ok" style={{ marginLeft: 8, height: 20 }}>已核实</span>
                            : <span className="tag mute" style={{ marginLeft: 8, height: 20 }}>无交互记录</span>}
                        </b>
                        <small>
                          {maskPhone(o.phone) || '无手机号'}{extras.length ? ` · +${extras.length} 个号码` : ''}
                          {o.house ? ` · ${placeOf(o.house)}` : ' · 未绑房'}
                          {o.lastInteraction ? ` · 最近报修 ${dayjs(o.lastInteraction.at).fromNow()}` : ''}
                        </small>
                      </div>
                      <button className="btn sm" onClick={(e) => { e.stopPropagation(); setActive(o); }}><Icon name="edit" size={16} />详情</button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}

      <div className="note2" style={{ marginTop: 16 }}><Icon name="alert" />「通过并绑房」按业主自报房号绑定。「已核实」表示该业主在系统里有过真实交互（最近报修）。归档为软删除，可在「已归档」里恢复。手机号默认脱敏。</div>

      {active ? <OwnerSheet owner={active} onClose={() => setActive(null)} onSaved={() => { setActive(null); loadOwners(); }} /> : null}
    </>
  );
}

function OwnerSheet({ owner, onClose, onSaved }: { owner: OwnerRow; onClose: () => void; onSaved: () => void }) {
  const { communities } = useAddressTree();
  const [name, setName] = useState(owner.name ?? '');
  const [phone, setPhone] = useState(owner.phone ?? '');
  const [extras, setExtras] = useState<string[]>(() => extraPhones(owner.contactNote));
  const [picked, setPicked] = useState<PickedHouse | null>(null);
  const [rebind, setRebind] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [confirm, setConfirm] = useState<null | 'archive' | 'restore'>(null);
  const [busy, setBusy] = useState(false);
  const archived = owner.status !== 'active';

  const setExtra = (i: number, v: string) => setExtras((xs) => xs.map((x, j) => (j === i ? v : x)));
  const addExtra = () => setExtras((xs) => [...xs, '']);
  const delExtra = (i: number) => setExtras((xs) => xs.filter((_, j) => j !== i));

  const save = async () => {
    setErr('');
    const cleanExtras = extras.map((s) => s.trim()).filter(Boolean);
    const body: Record<string, unknown> = {
      name: name.trim(),
      phone: phone.trim(),
      contactNote: cleanExtras.join('、') || '',
    };
    if (rebind && picked?.houseId) body.houseId = picked.houseId;
    setSaving(true);
    try {
      await request({ url: `/owners-mgmt/${owner.id}`, method: 'PATCH', data: body });
      toast('已保存');
      onSaved();
    } catch (e) { setErr(e instanceof Error ? e.message : '保存失败'); setSaving(false); }
  };

  const doArchive = async (restore: boolean) => {
    setBusy(true);
    try {
      if (restore) await request({ url: `/owners-mgmt/${owner.id}`, method: 'PATCH', data: { status: 'active' } });
      else await request({ url: `/owners-mgmt/${owner.id}`, method: 'DELETE' });
      toast(restore ? '已恢复' : '已归档');
      onSaved();
    } catch (e) { setErr(e instanceof Error ? e.message : '操作失败'); setBusy(false); setConfirm(null); }
  };

  return (
    <Sheet open onClose={onClose} width={520}
      title={owner.name || '（未填名）'}
      subtitle={archived ? '已归档业主' : '业主档案'}>
      <div style={{ padding: '4px 2px' }}>
        {owner.lastInteraction ? (
          <div className="card" style={{ padding: '10px 12px', marginBottom: 14, background: 'var(--bg)' }}>
            <div style={{ fontSize: 13 }}><b>最近交互</b> · 报修 {dayjs(owner.lastInteraction.at).format('YYYY-MM-DD')}（{dayjs(owner.lastInteraction.at).fromNow()}）</div>
            <div className="muted" style={{ fontSize: 13 }}>{owner.lastInteraction.label}</div>
          </div>
        ) : <div className="note" style={{ background: 'var(--bg)', marginBottom: 14, fontSize: 13 }}>这位业主在系统里还没有交互记录（报修），尚未核实。</div>}

        {archived ? <div className="note" style={{ background: 'var(--warn-w)', color: 'var(--warn)', marginBottom: 14, fontSize: 13 }}>该业主已归档。可恢复后再编辑。</div> : null}

        <Field label="姓名">
          <input className="in" value={name} disabled={archived} onChange={(e) => setName(e.target.value)} style={{ width: '100%' }} />
        </Field>
        <Field label="主手机号" hint="业主端小程序按此号匹配房屋，全公司唯一">
          <input className="in" value={phone} disabled={archived} onChange={(e) => setPhone(e.target.value)} placeholder="13800138000" style={{ width: '100%' }} />
        </Field>

        <Field label="其他电话 / 联系方式" hint="配偶、固话、第二个号码——打不通主号时备用">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {extras.map((x, i) => (
              <div key={i} style={{ display: 'flex', gap: 6 }}>
                <input className="in" value={x} disabled={archived} onChange={(e) => setExtra(i, e.target.value)} placeholder="号码 / 说明，如 021-5xxxxxxx 固话" style={{ flex: 1 }} />
                <button className="btn g sm" disabled={archived} onClick={() => delExtra(i)}><Icon name="x" size={15} /></button>
              </div>
            ))}
            {!archived ? <button className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={addExtra}><Icon name="plus" size={15} />加一个号码</button> : null}
          </div>
        </Field>

        <Field label="关联房产">
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 14 }}>{owner.house ? placeOf(owner.house) : '未绑房'}</span>
            {!archived ? <button className="btn sm" onClick={() => setRebind((v) => !v)}>{rebind ? '取消改绑' : (owner.house ? '改绑房产' : '绑定房产')}</button> : null}
          </div>
          {rebind ? (
            <div style={{ marginTop: 8 }}>
              <HousePicker communities={communities} value={picked} placeholder="输入 228/4/501 选房产" onPick={setPicked} onClear={() => setPicked(null)} />
            </div>
          ) : null}
        </Field>

        {err ? <div className="note" style={{ background: 'var(--dang-w)', color: 'var(--dang)', margin: '8px 0' }}>{err}</div> : null}

        <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
          {archived ? (
            <button className="btn p" style={{ flex: 1 }} disabled={busy} onClick={() => setConfirm('restore')}><Icon name="refresh" size={16} />恢复</button>
          ) : (
            <>
              <button className="btn p" style={{ flex: 1 }} disabled={saving} onClick={() => void save()}>{saving ? '保存中…' : '保存修改'}</button>
              <button className="btn g" disabled={busy} onClick={() => setConfirm('archive')}><Icon name="trash" size={16} />归档</button>
            </>
          )}
        </div>
      </div>

      <ConfirmModal open={confirm === 'archive'} onClose={() => setConfirm(null)} title="归档这位业主？" danger busy={busy}
        confirmText="归档" onConfirm={() => void doArchive(false)}>
        归档后从在册清单移除，房产关联和历史记录都保留，可随时在「已归档」里恢复。
      </ConfirmModal>
      <ConfirmModal open={confirm === 'restore'} onClose={() => setConfirm(null)} title="恢复这位业主？" busy={busy}
        confirmText="恢复" onConfirm={() => void doArchive(true)}>
        恢复后重新出现在在册清单里。
      </ConfirmModal>
    </Sheet>
  );
}
