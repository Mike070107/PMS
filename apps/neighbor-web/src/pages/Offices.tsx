import { useEffect, useState } from 'react';
import { request } from '@pms/api-client';
import { can } from '@/lib/perm';
import Icon from '@/components/Icon';
import { Loading } from '@/components/ui';
import ToneIcon from '@/components/ToneIcon';
import '@/styles/offices-admin.css';

interface Community { id: number; name: string }
interface Office { id: number; name: string; remark: string | null; enabled: boolean; communities: Community[] }
interface Resp { offices: Office[]; unassigned: Community[] }
type Editor =
  | { mode: 'create' }
  | { mode: 'edit'; office: Office }
  | { mode: 'assign' }
  | { mode: 'delete'; office: Office };

/**
 * 管理处：每个管理处管哪些小区一目了然，未划分的小区单独提示。
 * 走 /offices；新建 / 改名 / 划分小区 / 删除全部在本页完成，不再跳旧管理处页。
 */
export default function Offices() {
  const canEdit = can('offices', 'edit');
  const canDelete = can('offices', 'delete');
  const [data, setData] = useState<Resp | null>(null);
  const [loadErr, setLoadErr] = useState('');
  const [retry, setRetry] = useState(0);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [formName, setFormName] = useState('');
  const [formRemark, setFormRemark] = useState('');
  const [formEnabled, setFormEnabled] = useState(true);
  const [selected, setSelected] = useState<number[]>([]);
  const [targetOfficeId, setTargetOfficeId] = useState<number | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setData(null); setLoadErr('');
    try { setData(await request<Resp>({ url: '/offices' })); }
    catch (e) { setData({ offices: [], unassigned: [] }); setLoadErr(e instanceof Error ? e.message : '管理处读取失败'); }
  };
  useEffect(() => { void load(); }, [retry]);

  if (data === null) return <Loading />;

  const total = data.offices.reduce((sum, office) => sum + office.communities.length, 0);
  const allCommunities: Community[] = Array.from(
    new Map(
      [...data.unassigned, ...data.offices.flatMap((office) => office.communities)]
        .map((community) => [community.id, community] as const),
    ).values(),
  );

  const openCreate = () => {
    if (!canEdit) return;
    setFormName(''); setFormRemark(''); setFormEnabled(true);
    setSelected([]); setErr(''); setEditor({ mode: 'create' });
  };
  const openEdit = (office: Office) => {
    if (!canEdit) return;
    setFormName(office.name); setFormRemark(office.remark || ''); setFormEnabled(office.enabled);
    setSelected(office.communities.map((community) => community.id));
    setErr(''); setEditor({ mode: 'edit', office });
  };
  const openAssign = () => {
    if (!canEdit || !data.unassigned.length) return;
    setSelected(data.unassigned.map((community) => community.id));
    setTargetOfficeId(data.offices[0]?.id ?? null);
    setErr(''); setEditor({ mode: 'assign' });
  };
  const openDelete = (office: Office) => {
    if (!canDelete) return;
    setErr(''); setEditor({ mode: 'delete', office });
  };
  const close = () => { if (busy) return; setEditor(null); setErr(''); };
  const toggle = (id: number) => setSelected((prev) => prev.includes(id) ? prev.filter((value) => value !== id) : [...prev, id]);
  const refresh = async () => {
    const next = await request<Resp>({ url: '/offices' });
    setData(next);
  };

  const save = async () => {
    if (!editor) return;
    if (editor.mode === 'delete') {
      setBusy(true); setErr('');
      try { await request({ method: 'DELETE', url: `/offices/${editor.office.id}` }); await refresh(); setEditor(null); }
      catch (e) { setErr(e instanceof Error ? e.message : '删除失败，请稍后重试'); }
      finally { setBusy(false); }
      return;
    }
    if (editor.mode === 'assign') {
      const target = data.offices.find((office) => office.id === targetOfficeId);
      if (!target) { setErr('请选择要划入的管理处'); return; }
      const communityIds = [...target.communities.map((community) => community.id), ...selected.filter((id) => !target.communities.some((community) => community.id === id))];
      setBusy(true); setErr('');
      try {
        await request({ method: 'PATCH', url: `/offices/${target.id}`, data: { name: target.name, remark: target.remark ?? undefined, enabled: target.enabled, communityIds } });
        await refresh(); setEditor(null);
      } catch (e) { setErr(e instanceof Error ? e.message : '划入失败，请稍后重试'); }
      finally { setBusy(false); }
      return;
    }
    const name = formName.trim();
    if (!name) { setErr('请填写管理处名称'); return; }
    setBusy(true); setErr('');
    try {
      if (editor.mode === 'create') {
        await request({ method: 'POST', url: '/offices', data: { name, remark: formRemark.trim() || undefined, communityIds: selected } });
      } else {
        await request({ method: 'PATCH', url: `/offices/${editor.office.id}`, data: { name, remark: formRemark.trim() || undefined, enabled: formEnabled, communityIds: selected } });
      }
      await refresh(); setEditor(null);
    } catch (e) { setErr(e instanceof Error ? e.message : '保存失败，请稍后重试'); }
    finally { setBusy(false); }
  };

  const title = !editor ? '' : editor.mode === 'create' ? '新建管理处' : editor.mode === 'edit' ? '编辑管理处' : editor.mode === 'assign' ? '划入管理处' : '删除管理处';
  const footer = editor?.mode === 'delete'
    ? <><button className="btn" onClick={close} disabled={busy}>取消</button><button className="btn p offices-danger" onClick={() => void save()} disabled={busy}>{busy ? '删除中…' : '确认删除'}</button></>
    : editor?.mode === 'assign'
      ? <><button className="btn" onClick={close} disabled={busy}>取消</button><button className="btn p" onClick={() => void save()} disabled={busy}>{busy ? '保存中…' : '确认划入'}</button></>
      : <><button className="btn" onClick={close} disabled={busy}>取消</button><button className="btn p" onClick={() => void save()} disabled={busy}>{busy ? '保存中…' : '保存'}</button></>;

  return (
    <>
      <div className="ph" style={{ marginBottom: 14 }}>
        <div><div className="h1row"><ToneIcon kind="offices" /><h1 style={{ fontSize: 22 }}>管理处</h1></div><p>{data.offices.length} 个管理处 · 共管 {total} 个小区</p></div>
        <div className="act">
          <button className="btn" disabled={!canEdit} title={!canEdit ? '需要管理处编辑权限' : '新建管理处'} onClick={openCreate}><Icon name="plus" size={18} />新建管理处</button>
        </div>
      </div>

      {loadErr ? <div className="note2" role="alert" style={{ color: 'var(--dang)', marginBottom: 12 }}><Icon name="alert" />{loadErr}<button className="btn sm" style={{ marginLeft: 10 }} onClick={() => setRetry((value) => value + 1)}>重试</button></div> : null}

      {data.unassigned.length ? (
        <div className="note2 offices-unassigned" role="status">
          <Icon name="alert" />
          <div className="offices-unassigned-text">有 {data.unassigned.length} 个小区还没划入管理处（{data.unassigned.map((community) => community.name).join('、')}），这些小区的工作单和收费不会出现在任何管理处视角里。</div>
          <button className="btn sm" disabled={!canEdit} title={!canEdit ? '需要管理处编辑权限' : undefined} onClick={openAssign}><Icon name="chev" size={15} />划入管理处</button>
        </div>
      ) : null}

      {data.offices.length === 0 ? <div className="card" style={{ padding: 48, textAlign: 'center' }}><span className="muted">还没有管理处</span></div> : (
        <div className="offices-grid">
          {data.offices.map((office) => (
            <div key={office.id} className="card offices-card">
              <div className="offices-card-head">
                <div className={`ic ${office.enabled ? 'blue' : 'red'}`} style={{ width: 40, height: 40 }}><Icon name="building" /></div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <b className="offices-name">{office.name}</b>
                  <div className="muted offices-sub">{office.remark || `${office.communities.length} 个小区`}</div>
                </div>
                {office.enabled ? <span className="tag ok">启用</span> : <span className="tag mute">停用</span>}
              </div>
              {office.communities.length ? (
                <div className="chips" style={{ flexWrap: 'wrap' }}>
                  {office.communities.map((community) => <span key={community.id} className="tag acc"><Icon name="home" size={13} />{community.name}</span>)}
                </div>
              ) : <span className="muted" style={{ fontSize: 13 }}>尚未划入小区</span>}
              <div className="offices-card-actions">
                {canEdit ? <button className="btn sm" onClick={() => openEdit(office)}><Icon name="gear" size={15} />编辑</button> : null}
                {canDelete ? <button className="btn sm offices-danger" onClick={() => openDelete(office)}><Icon name="trash" size={15} />删除</button> : null}
              </div>
            </div>
          ))}
        </div>
      )}

      {editor ? (
        <div className="offices-mask" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
          <div className="offices-dialog" role="dialog" aria-modal="true" aria-label={title}>
            <div className="offices-dialog-head"><b>{title}</b><button className="btn sm g" onClick={close} disabled={busy}>关闭</button></div>

            {editor.mode === 'delete' ? (
              <div className="offices-delete">
                <p>确认删除管理处「<b>{editor.office.name}</b>」？</p>
                <p className="muted">名下还有小区时后端会拒绝删除，请先把小区划到其他管理处。</p>
              </div>
            ) : editor.mode === 'assign' ? (
              <>
                <label className="fl">划入到哪个管理处
                  <select className="in" value={targetOfficeId ?? ''} onChange={(event) => setTargetOfficeId(event.target.value ? Number(event.target.value) : null)} aria-label="划入目标管理处">
                    {data.offices.map((office) => <option key={office.id} value={office.id}>{office.name}</option>)}
                  </select>
                </label>
                <div className="offices-field">
                  <span>要划入的小区</span>
                  <div className="offices-checks">
                    {data.unassigned.map((community) => (
                      <label key={community.id} className="offices-check">
                        <input type="checkbox" checked={selected.includes(community.id)} onChange={() => toggle(community.id)} />{community.name}
                      </label>
                    ))}
                  </div>
                </div>
              </>
            ) : (
              <>
                <label className="fl">名称（必填）
                  <input className="in" value={formName} maxLength={120} autoFocus onChange={(event) => setFormName(event.target.value)} placeholder="如：枫桦景苑管理处" aria-label="管理处名称" />
                </label>
                <label className="fl">备注
                  <input className="in" value={formRemark} maxLength={255} onChange={(event) => setFormRemark(event.target.value)} placeholder="选填" aria-label="管理处备注" />
                </label>
                {editor.mode === 'edit' ? (
                  <label className="offices-check offices-enabled">
                    <input type="checkbox" checked={formEnabled} onChange={(event) => setFormEnabled(event.target.checked)} />启用该管理处
                  </label>
                ) : null}
                <div className="offices-field">
                  <span>管辖小区（可多选）</span>
                  {allCommunities.length === 0 ? <div className="muted">暂无小区</div> : (
                    <div className="offices-checks">
                      {allCommunities.map((community) => (
                        <label key={community.id} className="offices-check">
                          <input type="checkbox" checked={selected.includes(community.id)} onChange={() => toggle(community.id)} />{community.name}
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}

            {err ? <div className="note2" role="alert" style={{ background: 'var(--dang-w)', color: 'var(--dang)' }}><Icon name="alert" />{err}</div> : null}
            <div className="offices-dialog-foot">{footer}</div>
          </div>
        </div>
      ) : null}
    </>
  );
}
