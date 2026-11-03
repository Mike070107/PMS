import { useEffect, useMemo, useState } from 'react';
import { repairExperiences } from '@pms/api-client';
import type { RepairExperienceNotebookView, RepairExperienceNoteView, RepairExperienceBlock, RepairExperienceAccessView } from '@pms/shared-types';
import { repairExperienceBlocksToDocumentHtml } from '@pms/shared-types';
import Icon from '@/components/Icon';
import { Loading, Sheet, toast } from '@/components/ui';
import RichNoteEditor from '@/components/RichNoteEditor';
import ToneIcon from '@/components/ToneIcon';

interface Draft {
  id?: number;
  officeId: number;
  officeName: string;
  repairType: string;
  repairTypeLabel: string;
  title: string;
  html: string;
  revision: number;
}

/**
 * 维修经验：按工种/管理处分本的经验库。前台能搜、能读、能收藏，
 * 有权限的还能像笔记软件一样写富文本（标题/加粗/列表/清单/图片，可粘贴截图）。
 * 走 /repair-experiences（access/list/detail/favorite/create/update）。
 */
export default function Experience() {
  const [access, setAccess] = useState<RepairExperienceAccessView | null>(null);
  const [books, setBooks] = useState<RepairExperienceNotebookView[] | null>(null);
  const [q, setQ] = useState('');
  const [openId, setOpenId] = useState<number | null>(null);
  const [note, setNote] = useState<RepairExperienceNoteView | null>(null);
  const [favBusy, setFavBusy] = useState<number | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => { repairExperiences.access().then(setAccess).catch(() => setAccess({ canView: false, canEdit: false, notebookCount: 0, emptyReason: '无法读取经验库权限' })); }, []);
  const load = (kw?: string) => { setBooks(null); repairExperiences.list(kw).then(setBooks).catch(() => setBooks([])); };
  useEffect(() => { if (access?.canView) load(); }, [access?.canView]);

  const editableBooks = useMemo(() => (books ?? []).filter((b) => b.canEdit), [books]);

  const open = async (id: number) => {
    setOpenId(id); setNote(null);
    try { setNote(await repairExperiences.detail(id)); } catch { toast('打开失败'); setOpenId(null); }
  };
  const toggleFav = async (id: number, on: boolean) => {
    setFavBusy(id);
    try { await repairExperiences.setFavorite(id, on); load(q.trim() || undefined); }
    catch { toast('操作失败'); }
    finally { setFavBusy(null); }
  };

  const startNew = (b?: RepairExperienceNotebookView) => {
    const book = b || editableBooks[0];
    if (!book) { toast('你没有可写的经验本'); return; }
    setDraft({ officeId: book.officeId, officeName: book.officeName, repairType: book.repairType, repairTypeLabel: book.repairTypeLabel, title: '', html: '<p></p>', revision: 1 });
  };
  const startEdit = async (noteId: number) => {
    try {
      const n = await repairExperiences.detail(noteId);
      if (!n.canEdit) { toast('这本经验你没有编辑权限'); return; }
      setDraft({ id: n.id, officeId: n.officeId, officeName: n.officeName, repairType: n.repairType, repairTypeLabel: n.repairTypeLabel, title: n.title, html: repairExperienceBlocksToDocumentHtml(n.blocks), revision: n.revision });
      setOpenId(null);
    } catch { toast('打开失败'); }
  };

  const save = async () => {
    if (!draft) return;
    if (!draft.title.trim()) { toast('请填标题'); return; }
    const plain = draft.html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
    if (!plain && !/<img\b/i.test(draft.html)) { toast('正文还是空的'); return; }
    setSaving(true);
    try {
      const blocks: RepairExperienceBlock[] = [{ id: `doc-${draft.id || Date.now()}`, type: 'document', html: draft.html }];
      const payload = { officeId: draft.officeId, repairType: draft.repairType, title: draft.title.trim(), blocks, revision: draft.revision };
      if (draft.id) await repairExperiences.update(draft.id, payload);
      else await repairExperiences.create(payload);
      toast(draft.id ? '已保存' : '已发布');
      setDraft(null);
      load(q.trim() || undefined);
    } catch (e) {
      toast(e instanceof Error ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const total = useMemo(() => (books ?? []).reduce((s, b) => s + b.notes.length, 0), [books]);

  if (access === null) return <Loading />;
  if (!access.canView) {
    return (
      <>
        <div className="ph" style={{ marginBottom: 14 }}><div><div className="h1row"><ToneIcon kind="experience" /><h1 style={{ fontSize: 22 }}>维修经验</h1></div><p>工种经验库</p></div></div>
        <div className="card" style={{ padding: '48px 20px', textAlign: 'center' }}>
          <Icon name="book" size={40} style={{ color: 'var(--ink3)', marginBottom: 10 }} />
          <div className="muted">{access.emptyReason || '你暂时看不到任何经验笔记本'}</div>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="ph" style={{ marginBottom: 14 }}>
        <div><h1 style={{ fontSize: 22 }}>维修经验</h1><p>按工种/管理处分本 · 共 {total} 篇可查</p></div>
        {access.canEdit && editableBooks.length ? (
          <div className="act"><button className="btn p" onClick={() => startNew()}><Icon name="edit" size={16} />写经验</button></div>
        ) : null}
      </div>

      <div className="wo-bar" style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <input className="in" style={{ width: 320 }} value={q} placeholder="搜标题或正文关键词，回车"
          onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') load(q.trim() || undefined); }} />
        <button className="btn" onClick={() => load(q.trim() || undefined)}><Icon name="search" size={18} />搜索</button>
      </div>

      {books === null ? <Loading /> : books.length === 0 ? (
        <div className="card" style={{ padding: 48, textAlign: 'center', marginTop: 4 }}><span className="muted">没有匹配的经验笔记</span></div>
      ) : books.map((b) => (
        <div key={`${b.officeId}-${b.repairType}`} style={{ marginBottom: 18 }}>
          <div className="secTitle">
            <Icon name={b.isPublic ? 'users' : 'wrench'} size={18} />{b.repairTypeLabel}
            <span className="muted" style={{ fontWeight: 400, fontSize: 13 }}> · {b.officeName}</span>
            {b.isPublic ? <span className="tag acc" style={{ marginLeft: 8 }}>公共</span> : null}
            <span className="muted" style={{ marginLeft: 'auto', fontSize: 13, fontWeight: 400 }}>{b.notes.length} 篇</span>
            {b.canEdit ? <button className="btn g sm" style={{ marginLeft: 8 }} onClick={() => startNew(b)}><Icon name="edit" size={14} />写一篇</button> : null}
          </div>
          {b.notes.length === 0 ? <div className="card" style={{ padding: 20, textAlign: 'center' }}><span className="muted">本工种暂无笔记</span></div> : (
            <div className="card" style={{ overflow: 'hidden' }}>
              <div className="rowList">
                {b.notes.map((n) => (
                  <div key={n.id} className="lrow" style={{ cursor: 'pointer' }} onClick={() => open(n.id)}>
                    <div className="li ic blue"><Icon name="file" /></div>
                    <div className="lt">
                      <b>{n.title || '（无标题）'}</b>
                      <small>{n.preview || '—'}{n.imageCount ? ` · ${n.imageCount} 图` : ''} · {n.updatedByName} 更新</small>
                    </div>
                    {b.canEdit ? (
                      <button className="btn g sm" title="编辑" onClick={(e) => { e.stopPropagation(); void startEdit(n.id); }} style={{ minWidth: 40 }}><Icon name="edit" size={15} /></button>
                    ) : null}
                    <button className="btn g sm" title={n.favorite ? '取消收藏' : '收藏'} disabled={favBusy === n.id}
                      onClick={(e) => { e.stopPropagation(); toggleFav(n.id, !n.favorite); }}
                      style={{ color: n.favorite ? 'var(--warn)' : 'var(--ink3)', fontSize: 16, minWidth: 40 }}>
                      {n.favorite ? '★' : '☆'}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      ))}

      {/* 阅读 */}
      <Sheet open={openId !== null} onClose={() => setOpenId(null)} subtitle={note ? `${note.repairTypeLabel} · ${note.officeName}` : '维修经验'} width={560}>
        {note === null ? <Loading /> : (
          <div style={{ padding: '4px 2px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '0 0 6px' }}>
              <h2 style={{ fontSize: 19, margin: 0, flex: 1 }}>{note.title}</h2>
              {note.canEdit ? <button className="btn sm" onClick={() => void startEdit(note.id)}><Icon name="edit" size={15} />编辑</button> : null}
            </div>
            <div className="muted" style={{ fontSize: 13, marginBottom: 16 }}>{note.updatedByName} 更新 · 第 {note.revision} 版</div>
            {note.blocks.map((bl) => <Block key={bl.id} b={bl} />)}
          </div>
        )}
      </Sheet>

      {/* 撰写 / 编辑 */}
      <Sheet open={draft !== null} onClose={() => (saving ? null : setDraft(null))} subtitle={draft?.id ? '编辑维修经验' : '写一篇维修经验'} width={680}>
        {draft ? (
          <div style={{ padding: '4px 2px' }}>
            {!draft.id ? (
              <div style={{ marginBottom: 12 }}>
                <div className="muted" style={{ fontSize: 13, marginBottom: 6 }}>存到哪本经验</div>
                <div className="chips">
                  {editableBooks.map((b) => (
                    <button key={`${b.officeId}-${b.repairType}`}
                      className={`chip ${draft.officeId === b.officeId && draft.repairType === b.repairType ? 'on' : ''}`}
                      onClick={() => setDraft({ ...draft, officeId: b.officeId, officeName: b.officeName, repairType: b.repairType, repairTypeLabel: b.repairTypeLabel })}>
                      {b.repairTypeLabel}<span className="muted" style={{ fontWeight: 400 }}> · {b.officeName}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="muted" style={{ fontSize: 13, marginBottom: 10 }}>{draft.repairTypeLabel} · {draft.officeName}</div>
            )}
            <input className="in" style={{ fontSize: 17, fontWeight: 600, marginBottom: 12 }} maxLength={160}
              placeholder="标题，例如：更换角阀的常见坑" value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
            <RichNoteEditor html={draft.html} onChange={(html) => setDraft((cur) => (cur ? { ...cur, html } : cur))} />
            <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
              <button className="btn p" style={{ flex: 1 }} disabled={saving} onClick={() => void save()}>
                <Icon name="check" size={16} />{saving ? '保存中…' : draft.id ? '保存' : '发布'}
              </button>
              <button className="btn" disabled={saving} onClick={() => setDraft(null)}>取消</button>
            </div>
          </div>
        ) : null}
      </Sheet>
    </>
  );
}

function Block({ b }: { b: RepairExperienceBlock }) {
  if (b.html) return <div className="exp-html" style={{ lineHeight: 1.75, marginBottom: 10 }} dangerouslySetInnerHTML={{ __html: b.html }} />;
  switch (b.type) {
    case 'heading': return <h3 style={{ fontSize: 16, margin: '16px 0 6px' }}>{b.text}</h3>;
    case 'bullet': return <div style={{ display: 'flex', gap: 8, marginBottom: 4 }}><span style={{ color: 'var(--acc)' }}>•</span><span>{b.text}</span></div>;
    case 'ordered': return <div style={{ marginBottom: 4 }}>{b.text}</div>;
    case 'checklist': return <div style={{ display: 'flex', gap: 8, marginBottom: 4 }}><span>{b.checked ? '☑' : '☐'}</span><span>{b.text}</span></div>;
    case 'quote': return <blockquote style={{ borderLeft: '3px solid var(--line2)', paddingLeft: 12, color: 'var(--ink2)', margin: '8px 0' }}>{b.text}</blockquote>;
    case 'warning': return <div className="note2" style={{ background: 'var(--warn-w, #fbf1dd)', color: 'var(--warn)', borderColor: '#ecd9b0', margin: '8px 0' }}><Icon name="alert" />{b.text}</div>;
    case 'divider': return <hr style={{ border: 0, borderTop: '1px solid var(--line)', margin: '14px 0' }} />;
    case 'image': return b.url ? <figure style={{ margin: '10px 0' }}><img src={b.url} alt={b.caption || ''} style={{ maxWidth: '100%', borderRadius: 8 }} />{b.caption ? <figcaption className="muted" style={{ fontSize: 12, marginTop: 4 }}>{b.caption}</figcaption> : null}</figure> : null;
    case 'document': return b.url ? <a className="btn sm" href={b.url} target="_blank" rel="noreferrer" style={{ margin: '6px 0' }}><Icon name="file" size={16} />{b.caption || '附件'}</a> : null;
    default: return <p style={{ lineHeight: 1.75, margin: '0 0 10px' }}>{b.text}</p>;
  }
}
