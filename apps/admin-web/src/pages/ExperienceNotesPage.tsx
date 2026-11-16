import { useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import ImageExtension from '@tiptap/extension-image';
import Placeholder from '@tiptap/extension-placeholder';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import { Table, TableRow, TableHeader, TableCell } from '@tiptap/extension-table';
import { AudioOutlined, BoldOutlined, CheckSquareOutlined, CodeOutlined, CommentOutlined, ItalicOutlined, MinusOutlined, OrderedListOutlined, PictureOutlined, RedoOutlined, StrikethroughOutlined, TableOutlined, UndoOutlined, UnorderedListOutlined } from '@ant-design/icons';
import { repairExperiences } from '@pms/api-client';
import type { RepairExperienceLibraryQuery, RepairExperienceLibraryView, RepairExperienceNoteSummary, RepairExperienceNoteView, RepairExperienceSharingOptions, SaveRepairExperienceNoteReq } from '@pms/shared-types';
import { REPAIR_EXPERIENCE_TABLE_LIMITS, formatDateTimeCn, repairExperienceBlocksToDocumentHtml, repairExperienceDocumentPlainText } from '@pms/shared-types';
import './ExperienceNotesPage.css';

export interface ExperienceEditorProps { html: string; onChange: (html: string) => void; onBusyChange?: (busy: boolean) => void; readOnly?: boolean; }
interface Draft { title: string; html: string; }
interface Sharing { visibility: 'private' | 'published'; communityIds: number[]; repairTypes: string[]; allowEdit: boolean; allowDelete: boolean; allTrades: boolean; }
const emptyLibrary: RepairExperienceLibraryView = { items: [], total: 0, page: 1, pageSize: 20 };
const initialDraft = (): Draft => ({ title: '', html: '<p></p>' });
/** Rendering-only wrappers: API HTML remains the existing document block format. */
export const experienceReadHtml = (blocks: RepairExperienceNoteView['blocks']) => repairExperienceBlocksToDocumentHtml(blocks).replace(/<table\b/gi, '<div class="en-table-scroll" role="region" tabindex="0" aria-label="表格，可左右滚动"><table').replace(/<\/table>/gi, '</table></div>');
const failure = (e: unknown, fallback: string) => e instanceof Error ? e.message : fallback;
const statusOf = (e: unknown) => (e as { httpStatus?: number; status?: number } | null)?.httpStatus || (e as { status?: number } | null)?.status;
const compactLabels = (labels: string[] | undefined, fallback: string) => labels?.length ? `${labels.slice(0, 2).join('、')}${labels.length > 2 ? ` +${labels.length - 2}` : ''}` : fallback;
const visibilityLabel = (visibility: RepairExperienceNoteSummary['visibility']) => visibility === 'private' ? '仅自己可见' : visibility === 'published' ? '已分享' : '旧版共享';
function sharingFrom(note: RepairExperienceNoteView): Sharing {
  return { visibility: note.visibility === 'private' ? 'private' : 'published', communityIds: [...(note.communityIds || [])], repairTypes: [...(note.repairTypes || [])], allowEdit: note.allowEdit === true, allowDelete: note.allowDelete === true, allTrades: note.visibility === 'published' && !note.repairTypes?.length };
}
/** Content saves NEVER carry ACL fields. Only a separate owner-authorized sharing action may do that. */
export function experienceContentPayload(draft: Draft, note: RepairExperienceNoteView | null): SaveRepairExperienceNoteReq {
  const content = { title: draft.title.trim(), blocks: [{ id: `doc-${note?.id || 'new'}`, type: 'document' as const, html: draft.html }] };
  return note ? { ...content, revision: note.revision } : { ...content, visibility: 'private', communityIds: [], repairTypes: [], allowEdit: false, allowDelete: false };
}
export function experienceSharingPayload(note: RepairExperienceNoteView, share: Sharing): SaveRepairExperienceNoteReq {
  const published = share.visibility === 'published';
  return { title: note.title, blocks: note.blocks, revision: note.revision, visibility: share.visibility, communityIds: published ? share.communityIds : [], repairTypes: published ? share.repairTypes : [], allowEdit: published && share.allowEdit, allowDelete: published && share.allowDelete };
}

/** One library and ACL implementation for the existing two Web entries; editors remain injectable. */
export function ExperienceNotebook({ Editor = ExperienceDocumentEditor, className = '' }: { Editor?: ComponentType<ExperienceEditorProps>; className?: string }) {
  const [options, setOptions] = useState<RepairExperienceSharingOptions | null>(null);
  const [optionsError, setOptionsError] = useState('');
  const [optionsRefresh, setOptionsRefresh] = useState(0);
  const [query, setQuery] = useState('');
  const [view, setView] = useState<RepairExperienceLibraryQuery['view']>('all');
  const [communityId, setCommunityId] = useState('');
  const [repairType, setRepairType] = useState('');
  const [page, setPage] = useState(1);
  const [refresh, setRefresh] = useState(0);
  const [library, setLibrary] = useState(emptyLibrary);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [denied, setDenied] = useState(false);
  const [inDocument, setInDocument] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [note, setNote] = useState<RepairExperienceNoteView | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [base, setBase] = useState<Draft | null>(null);
  const [sharing, setSharing] = useState<Sharing | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [favoriteBusy, setFavoriteBusy] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [assetExpired, setAssetExpired] = useState(false);
  const listGeneration = useRef(0), detailGeneration = useRef(0), mutationBusy = useRef(false);
  const dirty = !!draft && !!base && (draft.title !== base.title || draft.html !== base.html);
  const leaveGuard = useRef({ dirty: false, uploading: false, saving: false });
  leaveGuard.current = { dirty, uploading, saving };

  useEffect(() => {
    let live = true; setOptions(null); setOptionsError('');
    repairExperiences.sharingOptions().then(result => { if (live) setOptions(result); }).catch(e => { if (live) setOptionsError(failure(e, '无法读取经验本权限')); });
    return () => { live = false; };
  }, [optionsRefresh]);
  useEffect(() => {
    const generation = ++listGeneration.current;
    if (!options) return;
    setListLoading(true); setListError(''); setDenied(false);
    const timer = window.setTimeout(async () => {
      try {
        const result = await repairExperiences.library({ q: query.trim() || undefined, view, communityId: communityId ? Number(communityId) : undefined, repairType: repairType || undefined, page, pageSize: 20 });
        if (generation !== listGeneration.current) return;
        if (!result.items.length && result.total > 0 && page > 1) { setPage(Math.max(1, Math.ceil(result.total / 20))); return; }
        setLibrary(result);
      } catch (e) { if (generation === listGeneration.current) { setListError(failure(e, '无法加载文档，请重试')); setDenied(statusOf(e) === 403); } }
      finally { if (generation === listGeneration.current) setListLoading(false); }
    }, query ? 250 : 0);
    return () => { clearTimeout(timer); ++listGeneration.current; };
  }, [options, query, view, communityId, repairType, page, refresh]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => { const guard = leaveGuard.current; if (guard.dirty || guard.uploading || guard.saving) { event.preventDefault(); event.returnValue = ''; } };
    const beforeLink = (event: MouseEvent) => {
      const anchor = (event.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!anchor || anchor.target === '_blank' || anchor.href === location.href || event.defaultPrevented) return;
      const guard = leaveGuard.current;
      if (guard.uploading || guard.saving || (guard.dirty && !window.confirm('有尚未保存的修改，确定离开吗？'))) { event.preventDefault(); event.stopImmediatePropagation(); }
    };
    window.addEventListener('beforeunload', beforeUnload); document.addEventListener('click', beforeLink, true);
    return () => { window.removeEventListener('beforeunload', beforeUnload); document.removeEventListener('click', beforeLink, true); };
  }, []);
  const filterTrades = options?.communities.find(c => c.id === Number(communityId))?.repairTypes || [];
  const shareTrades = useMemo(() => {
    const trades = new Map<string, string>();
    for (const community of options?.communities || []) if (sharing?.communityIds.includes(community.id)) for (const trade of community.repairTypes) trades.set(trade.value, trade.label);
    return [...trades].map(([value, label]) => ({ value, label }));
  }, [options, sharing?.communityIds]);
  const returnToLibrary = () => {
    if (saving || uploading) { setError('正在保存或处理内容，请稍候。'); return; }
    if (dirty && !window.confirm('有尚未保存的修改，确定放弃并返回文档库吗？')) return;
    ++detailGeneration.current; setInDocument(false); setNote(null); setDraft(null); setBase(null); setSharing(null); setError(''); setNotice(''); setAssetExpired(false);
  };
  const openNote = async (id: number) => {
    const generation = ++detailGeneration.current;
    setInDocument(true); setDetailLoading(true); setNote(null); setDraft(null); setBase(null); setSharing(null); setError(''); setNotice(''); setAssetExpired(false);
    try { const result = await repairExperiences.detail(id); if (generation === detailGeneration.current) setNote(result); }
    catch (e) { if (generation === detailGeneration.current) setError(failure(e, '打开文档失败，请返回后重试')); }
    finally { if (generation === detailGeneration.current) setDetailLoading(false); }
  };
  const newDocument = () => {
    if (!options?.canCreate || denied) return;
    ++detailGeneration.current; const next = initialDraft(); setNote(null); setDraft(next); setBase(next); setInDocument(true); setError(''); setNotice(''); setAssetExpired(false);
  };
  const edit = () => { if (!note?.canEdit) return; const next = { title: note.title, html: repairExperienceBlocksToDocumentHtml(note.blocks) }; setDraft(next); setBase(next); setNotice(''); setError(''); };
  const save = async () => {
    if (!draft || uploading || mutationBusy.current || (note ? !note.canEdit : !options?.canCreate)) return;
    if (!draft.title.trim()) { setError('请填写文档标题'); return; }
    if (!repairExperienceDocumentPlainText(draft.html) && !/<(?:img|table)\b/i.test(draft.html)) { setError('请至少写一段正文或添加一张图片'); return; }
    mutationBusy.current = true; setSaving(true); setError(''); setNotice('');
    try {
      const payload = experienceContentPayload(draft, note);
      const saved = note ? await repairExperiences.update(note.id, payload) : await repairExperiences.create(payload);
      setNote(saved); setDraft(null); setBase(null); setAssetExpired(false); setNotice(saved.visibility === 'private' ? '已保存，仅自己可见' : '已保存'); setRefresh(n => n + 1);
    } catch (e) {
      const networkFailure = (e as { networkFailure?: boolean } | null)?.networkFailure;
      setError(networkFailure ? '保存结果暂未确认，草稿已保留。请先到“我写的”核对，勿重复新建。' : `${failure(e, '保存失败')}。本地输入已保留${statusOf(e) === 409 ? '，请复制草稿后重新打开文档核对版本' : '，可修正后重试'}。`);
    } finally { mutationBusy.current = false; setSaving(false); }
  };
  const saveSharing = async () => {
    if (!note?.canManage || !sharing || mutationBusy.current || uploading || draft) return;
    if (sharing.visibility === 'published') {
      if (!sharing.communityIds.length) { setError('请先选择可见小区'); return; }
      if (sharing.communityIds.some(id => !options?.communities.some(c => c.id === id))) { setError('请移除不可再分享的小区，再重新选择可见范围'); return; }
      if ((!sharing.allTrades && !sharing.repairTypes.length) || sharing.repairTypes.some(value => !shareTrades.some(t => t.value === value))) { setError('请明确选择“不限工种”，或选择当前小区内的工种'); return; }
    }
    mutationBusy.current = true; setSaving(true); setError('');
    try { const saved = await repairExperiences.update(note.id, experienceSharingPayload(note, sharing)); setNote(saved); setSharing(null); setNotice('分享设置已更新'); setRefresh(n => n + 1); }
    catch (e) { setError(`${failure(e, '分享设置保存失败')}。设置已保留，尚未确认生效。`); }
    finally { mutationBusy.current = false; setSaving(false); }
  };
  const remove = async () => {
    if (!note?.canDelete || mutationBusy.current || uploading || dirty || !window.confirm(`确定删除“${note.title}”吗？此操作无法撤销。`)) return;
    mutationBusy.current = true; setSaving(true); setError('');
    try { await repairExperiences.remove(note.id, note.revision); setInDocument(false); setNote(null); setRefresh(n => n + 1); setNotice('文档已删除'); }
    catch (e) { setError(`${failure(e, '删除失败')}。未确认删除成功，请刷新核对。`); }
    finally { mutationBusy.current = false; setSaving(false); }
  };
  const favorite = async (item: RepairExperienceNoteSummary) => {
    if (favoriteBusy !== null) return; setFavoriteBusy(item.id); setError('');
    try { await repairExperiences.setFavorite(item.id, !item.favorite); setRefresh(n => n + 1); }
    catch (e) { setError(failure(e, '收藏失败，请重试')); }
    finally { setFavoriteBusy(null); }
  };
  const refreshAssets = async () => {
    if (mutationBusy.current) return;
    if (!note || dirty || uploading) { setError('请先保存本地修改，再刷新图片链接；不会覆盖当前草稿。'); return; }
    const generation = ++detailGeneration.current;
    mutationBusy.current = true; setSaving(true); setError('');
    try {
      const result = await repairExperiences.detail(note.id);
      if (generation !== detailGeneration.current) return;
      setNote(result);
      if (draft) { const next = { title: result.title, html: repairExperienceBlocksToDocumentHtml(result.blocks) }; setDraft(next); setBase(next); }
      setAssetExpired(false);
    } catch (e) { if (generation === detailGeneration.current) setError(failure(e, '图片链接刷新失败，可能已过期或权限已改变')); }
    finally { mutationBusy.current = false; setSaving(false); }
  };
  const copyDraft = async () => { if (!draft) return; try { await navigator.clipboard.writeText(`${draft.title}\n\n${draft.html}`); setNotice('草稿已复制（含图片标记），请妥善保管'); } catch { setError('复制失败，请手动选中并复制标题和正文；输入仍保留。'); } };
  const changeCommunity = (id: number, selected: boolean) => setSharing(current => {
    if (!current) return current;
    const ids = selected ? [...current.communityIds, id] : current.communityIds.filter(value => value !== id);
    const available = new Set((options?.communities || []).filter(c => ids.includes(c.id)).flatMap(c => c.repairTypes.map(t => t.value)));
    return { ...current, communityIds: ids, repairTypes: current.repairTypes.filter(value => available.has(value)) };
  });
  const messageArea = <>{error && <div className="en-message en-message--error" role="alert">{error}{draft && <button type="button" className="en-text-button" onClick={() => void copyDraft()}>复制草稿</button>}</div>}{notice && <div className="en-notice" role="status">{notice}</div>}</>;

  return <section className={`experience-notebook ${className}`} aria-label="经验本">
    {!inDocument ? <>
      <header className="en-header"><h1>经验本</h1>{options?.canCreate && !denied && <button type="button" className="en-button en-button--primary" onClick={newDocument}>新建文档</button>}</header>
      {messageArea}
      {optionsError ? <div className="en-state" role="alert"><p>{optionsError}</p><button type="button" className="en-button" onClick={() => setOptionsRefresh(n => n + 1)}>重试</button></div> : <>
        <div className="en-library-tools"><input type="search" aria-label="搜索文档" placeholder="搜索标题或正文" value={query} disabled={!options} onChange={event => { setQuery(event.target.value); setPage(1); }} /><select aria-label="筛选小区" value={communityId} disabled={!options} onChange={event => { setCommunityId(event.target.value); setRepairType(''); setPage(1); }}><option value="">全部小区</option>{options?.communities.map(c => <option value={c.id} key={c.id}>{c.name}</option>)}</select><select aria-label="筛选工种" value={repairType} disabled={!communityId} onChange={event => { setRepairType(event.target.value); setPage(1); }}><option value="">全部工种</option>{filterTrades.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}</select></div>
        <nav className="en-views" aria-label="文档范围">{([['all', '全部可见'], ['mine', '我写的'], ['private', '仅我可见'], ['favorites', '收藏']] as const).map(([key, label]) => <button type="button" key={key} aria-pressed={view === key} onClick={() => { setView(key); setPage(1); }}>{label}</button>)}</nav>
        {listLoading ? <div className="en-state" role="status">正在加载文档…</div> : listError ? <div className="en-state" role="alert"><p>{listError}</p><button type="button" className="en-button" onClick={() => setRefresh(n => n + 1)}>重试</button></div> : !library.items.length ? <div className="en-state"><h2>{query || communityId || repairType || view !== 'all' ? '没有匹配的文档' : '还没有文档'}</h2><p>{query || communityId || repairType || view !== 'all' ? '试试其他关键词或筛选条件。' : options?.canCreate ? '从右上角新建文档，保存后仅自己可见。' : '分享给你的文档会显示在这里。'}</p></div> : <>
          <div className="en-list">{library.items.map(item => <article key={item.id} className="en-row"><div className="en-row-body"><button type="button" className="en-title-link" onClick={() => void openNote(item.id)}>{item.title || '未命名文档'}</button><p className="en-preview">{item.preview || (item.imageCount ? '图文内容' : '暂无摘要')}</p><div className="en-row-meta"><span className={`en-scope en-scope--${item.visibility || 'legacy'}`}>{visibilityLabel(item.visibility)}</span>{item.visibility === 'published' && <span>{compactLabels(item.communityNames, '选定小区')} · {compactLabels(item.repairTypeLabels, '不限工种')}</span>}<span>{item.createdByName || item.updatedByName} · {formatDateTimeCn(item.updatedAt)}</span></div></div><button type="button" className="en-favorite" aria-label={`${item.favorite ? '取消收藏' : '收藏'} ${item.title}`} aria-pressed={item.favorite} disabled={favoriteBusy !== null} onClick={() => void favorite(item)}>{item.favorite ? '★' : '☆'}</button></article>)}</div>
          <footer className="en-pagination"><span>共 {library.total} 篇</span>{library.total > 20 && <div><button type="button" className="en-button" disabled={page <= 1} onClick={() => setPage(n => Math.max(1, n - 1))}>上一页</button><span>第 {page} / {Math.max(1, Math.ceil(library.total / 20))} 页</span><button type="button" className="en-button" disabled={page >= Math.ceil(library.total / 20)} onClick={() => setPage(n => n + 1)}>下一页</button></div>}</footer>
        </>}
      </>}
    </> : <>
      <header className="en-document-header"><button type="button" className="en-button" disabled={saving || uploading} onClick={returnToLibrary}>返回文档库</button><div className="en-document-actions">{note?.canManage && <button type="button" className="en-button" disabled={!!draft || saving || uploading} title={draft ? '请先保存正文，再设置分享' : undefined} onClick={() => { setError(''); setSharing(sharingFrom(note)); }}>分享设置</button>}{note?.canDelete && !draft && <button type="button" className="en-button en-button--danger" disabled={saving} onClick={() => void remove()}>删除文档</button>}{draft ? <button type="button" className="en-button en-button--primary" disabled={saving || uploading} onClick={() => void save()}>{saving ? '保存中…' : '保存'}</button> : note?.canEdit && <button type="button" className="en-button en-button--primary" disabled={saving} onClick={edit}>编辑</button>}</div></header>
      {messageArea}
      {detailLoading ? <div className="en-state" role="status">正在打开文档…</div> : draft ? <div className="en-paper"><div className="en-paper-status">{dirty ? '有未保存的修改' : note ? visibilityLabel(note.visibility) : '新文档 · 保存后仅自己可见'}{uploading && ' · 正在处理内容'}</div><input aria-label="文档标题" className="en-title-input" maxLength={160} placeholder="未命名文档" value={draft.title} disabled={saving} onChange={event => setDraft(current => current ? { ...current, title: event.target.value } : current)} /><div onErrorCapture={event => { if ((event.target as HTMLElement).tagName === 'IMG') setAssetExpired(true); }}><Editor key={`${note?.id || 'new'}:${note?.revision || 0}`} html={draft.html} onChange={html => setDraft(current => current ? { ...current, html } : current)} onBusyChange={setUploading} readOnly={saving} /></div></div> : note && <article className="en-paper"><div className="en-paper-status">{visibilityLabel(note.visibility)} · {note.createdByName} · {formatDateTimeCn(note.updatedAt)} 更新</div><h1 className="en-document-title">{note.title}</h1>{note.visibility === 'legacy' && <p className="en-legacy-note">旧版共享文档沿用原访问范围。历史公开图片链接无法通过改为私密自动撤回，请先替换为受保护图片。</p>}<div className="en-prose" onErrorCapture={event => { if ((event.target as HTMLElement).tagName === 'IMG') setAssetExpired(true); }} dangerouslySetInnerHTML={{ __html: experienceReadHtml(note.blocks) }} /></article>}
      {assetExpired && <div className="en-message" role="alert">图片链接可能已过期或权限已变化。{dirty || uploading ? '请先保存草稿后刷新，不会自动覆盖本地输入。' : <button type="button" className="en-text-button" disabled={saving || uploading} onClick={() => void refreshAssets()}>{saving ? '刷新中…' : '刷新图片链接'}</button>}</div>}
    </>}
    {sharing && note?.canManage && <SharingDialog onClose={() => { if (!saving) { setSharing(null); setError(''); } }}><header><h2 id="experience-share-title">分享设置</h2></header>{error && <p className="en-message en-message--error" role="alert">{error}</p>}{note.visibility === 'legacy' && <p className="en-legacy-note">旧版共享沿用原访问范围；历史公开图片链接不能自动撤回，请先替换图片后再设为私密。</p>}<fieldset disabled={saving}><legend>谁可以查看</legend><label className="en-choice"><input type="radio" name="visibility" checked={sharing.visibility === 'private'} onChange={() => setSharing({ ...sharing, visibility: 'private' })} />仅自己可见</label><label className="en-choice"><input type="radio" name="visibility" checked={sharing.visibility === 'published'} onChange={() => setSharing({ ...sharing, visibility: 'published' })} />选定成员可见</label></fieldset>{sharing.visibility === 'published' && <><fieldset disabled={saving}><legend>可见小区</legend><div className="en-options">{options?.communities.map(c => <label className="en-choice" key={c.id}><input type="checkbox" checked={sharing.communityIds.includes(c.id)} onChange={event => changeCommunity(c.id, event.target.checked)} />{c.name}</label>)}{sharing.communityIds.filter(id => !options?.communities.some(c => c.id === id)).map(id => <label className="en-choice" key={id}><input type="checkbox" checked onChange={() => changeCommunity(id, false)} />小区 #{id}（不可再分享，请移除）</label>)}</div>{!options?.communities.length && <p className="en-muted">当前没有可分享的小区，可先保留为私密。</p>}</fieldset><fieldset disabled={saving || !sharing.communityIds.length}><legend>可见工种</legend><label className="en-choice"><input type="radio" name="tradeMode" checked={sharing.allTrades} onChange={() => setSharing({ ...sharing, allTrades: true, repairTypes: [] })} />不限工种</label><label className="en-choice"><input type="radio" name="tradeMode" checked={!sharing.allTrades} onChange={() => setSharing({ ...sharing, allTrades: false })} />指定工种</label><div className="en-options">{shareTrades.map(t => <label className="en-choice" key={t.value}><input type="checkbox" checked={sharing.repairTypes.includes(t.value)} onChange={event => setSharing({ ...sharing, allTrades: false, repairTypes: event.target.checked ? [...sharing.repairTypes, t.value] : sharing.repairTypes.filter(value => value !== t.value) })} />{t.label}</label>)}</div></fieldset><fieldset disabled={saving}><legend>协作权限</legend><label className="en-choice"><input type="checkbox" checked={sharing.allowEdit} onChange={event => setSharing({ ...sharing, allowEdit: event.target.checked })} />允许编辑</label><label className="en-choice"><input type="checkbox" checked={sharing.allowDelete} onChange={event => setSharing({ ...sharing, allowDelete: event.target.checked })} />允许删除</label><p className="en-muted">仅对同时符合小区和工种范围的成员生效。</p></fieldset></>}<footer><button type="button" className="en-button" disabled={saving} onClick={() => { setSharing(null); setError(''); }}>取消</button><button type="button" className="en-button en-button--primary" disabled={saving} onClick={() => void saveSharing()}>{saving ? '应用中…' : '应用分享'}</button></footer></SharingDialog>}
  </section>;
}

function SharingDialog({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const element = dialog.current; element?.showModal(); return () => { element?.close(); }; }, []);
  return <dialog ref={dialog} className="en-sharing-dialog" aria-labelledby="experience-share-title" onCancel={event => { event.preventDefault(); onClose(); }}>{children}</dialog>;
}

/** Existing TipTap visual editor, now using the private document-asset endpoint for ALL image paths. */
export function ExperienceDocumentEditor({ html, onChange, onBusyChange, readOnly = false }: ExperienceEditorProps) {
  const [busy, setBusy] = useState(false), [uploadError, setUploadError] = useState('');
  const [listening, setListening] = useState(false);
  type Recognition = { lang: string; continuous: boolean; interimResults: boolean; start: () => void; stop: () => void; abort: () => void; onresult: ((event: { resultIndex?: number; results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null; onend: (() => void) | null; onerror: (() => void) | null };
  const recognitionRef = useRef<Recognition | null>(null);
  const tableToolsRef = useRef<HTMLDetailsElement>(null);
  const busyRef = useRef(false);
  const callbacks = useRef({ onChange, onBusyChange }); callbacks.current = { onChange, onBusyChange };
  const insertRef = useRef<(files: File[]) => Promise<void>>(async () => {});
  const editor = useEditor({
    shouldRerenderOnTransaction: true,
    extensions: [StarterKit.configure({ heading: { levels: [2, 3] } }), TaskList, TaskItem.configure({ nested: true }), ImageExtension.configure({ allowBase64: false }), Table.configure({ resizable: false, renderWrapper: true, cellMinWidth: 100 }), TableRow, TableHeader, TableCell, Placeholder.configure({ placeholder: '写下排查过程、维修步骤和注意事项…' })], content: html,
    editorProps: { attributes: { role: 'textbox', 'aria-label': '文档正文', 'aria-multiline': 'true' },
      handlePaste: (_view, event) => { const files = Array.from(event.clipboardData?.files || []).filter(file => file.type.startsWith('image/')); if (files.length) { event.preventDefault(); void insertRef.current(files); return true; } if (/<img\b/i.test(event.clipboardData?.getData('text/html') || '')) { setUploadError('请粘贴图片文件或上传图片，不能插入外链图片。'); event.preventDefault(); return true; } return false; },
      handleDrop: (_view, event, _slice, moved) => { if (moved) return false; const files = Array.from(event.dataTransfer?.files || []).filter(file => file.type.startsWith('image/')); if (files.length) { event.preventDefault(); void insertRef.current(files); return true; } if (/<img\b/i.test(event.dataTransfer?.getData('text/html') || '')) { setUploadError('请拖入图片文件，不能插入外链图片。'); event.preventDefault(); return true; } return false; },
    }, onUpdate: ({ editor: current }) => callbacks.current.onChange(current.getHTML()),
  });
  insertRef.current = async files => {
    if (!editor || !files.length) return;
    if (busyRef.current) { setUploadError('图片正在上传，请稍后再添加。'); return; }
    busyRef.current = true; setBusy(true); callbacks.current.onBusyChange?.(true); setUploadError('');
    let successful = 0;
    try { for (const file of files) { const asset = await repairExperiences.uploadAssetFile(file); editor.chain().focus().insertContentAt(editor.state.selection.to, [{ type: 'image', attrs: { src: asset.displayUrl, alt: file.name } }, { type: 'paragraph' }]).run(); successful++; } }
    catch (e) { setUploadError(`图片上传失败：${failure(e, '请重试')}。${successful ? `本次已成功的 ${successful} 张图片已保留，` : '已插入图片与正文均保留，'}请仅重传失败的图片。`); }
    finally { busyRef.current = false; setBusy(false); callbacks.current.onBusyChange?.(false); }
  };
  useEffect(() => { editor?.setEditable(!readOnly, false); }, [editor, readOnly]);
  useEffect(() => { if (editor && editor.getHTML() !== html) editor.commands.setContent(html, { emitUpdate: false }); }, [editor, html]);
  useEffect(() => () => { recognitionRef.current?.abort(); }, []);
  const voiceInput = () => {
    if (listening) { recognitionRef.current?.stop(); return; }
    if (!editor || busyRef.current || readOnly) return;
    const host = window as Window & { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
    const Engine = host.SpeechRecognition || host.webkitSpeechRecognition;
    if (!Engine) { setUploadError('当前浏览器不支持语音输入，请使用键盘或系统听写。'); return; }
    const recognition = new Engine(); recognitionRef.current = recognition;
    recognition.lang = 'zh-CN'; recognition.continuous = false; recognition.interimResults = false;
    const finish = () => { busyRef.current = false; setBusy(false); setListening(false); callbacks.current.onBusyChange?.(false); recognitionRef.current = null; };
    recognition.onresult = event => { const text = event.results[event.resultIndex || 0]?.[0]?.transcript; if (text) editor.chain().focus().insertContent({ type: 'text', text }).run(); };
    recognition.onend = finish; recognition.onerror = () => { setUploadError('语音输入未成功，请检查麦克风权限或使用键盘；原文已保留。'); finish(); };
    setUploadError(''); busyRef.current = true; setBusy(true); setListening(true); callbacks.current.onBusyChange?.(true);
    try { recognition.start(); } catch { setUploadError('无法启动语音输入，请使用键盘；原文已保留。'); finish(); }
  };
  const chooseImage = () => { if (readOnly || busyRef.current) return; const input = document.createElement('input'); input.type = 'file'; input.accept = 'image/*'; input.multiple = true; input.onchange = () => void insertRef.current(Array.from(input.files || [])); input.click(); };
  if (!editor) return null;
  let tableCount = 0, totalGridCells = 0, currentRows = 0, currentColumns = 0;
  editor.state.doc.descendants(node => {
    if (node.type.name !== 'table') return;
    let columns = 0; node.firstChild?.forEach(cell => { columns += Number(cell.attrs.colspan) || 1; });
    tableCount++; totalGridCells += columns * node.childCount;
    return false;
  });
  for (let depth = editor.state.selection.$from.depth; depth > 0; depth--) {
    const node = editor.state.selection.$from.node(depth);
    if (node.type.name === 'table') { currentRows = node.childCount; node.firstChild?.forEach(cell => { currentColumns += Number(cell.attrs.colspan) || 1; }); break; }
  }
  const limits = REPAIR_EXPERIENCE_TABLE_LIMITS;
  const tableAction = (label: string, command: () => void, disabled = false) => <button type="button" className="en-table-command" disabled={disabled || readOnly} onMouseDown={event => event.preventDefault()} onClick={command}>{label}</button>;
  const action = (label: string, icon: ReactNode, command: () => void, active?: boolean, disabled = false) => <button type="button" title={label} aria-label={label} aria-pressed={active} disabled={disabled || readOnly} className={`en-tool ${active ? 'is-active' : ''}`} onMouseDown={event => event.preventDefault()} onClick={command}>{icon}</button>;
  return <div className="en-editor"><div className="en-toolbar" role="toolbar" aria-label="正文排版">
    {action('撤销', <UndoOutlined />, () => editor.chain().focus().undo().run(), undefined, !editor.can().undo())}{action('重做', <RedoOutlined />, () => editor.chain().focus().redo().run(), undefined, !editor.can().redo())}
    {action('小标题', <span>H2</span>, () => editor.chain().focus().toggleHeading({ level: 2 }).run(), editor.isActive('heading', { level: 2 }))}{action('加粗', <BoldOutlined />, () => editor.chain().focus().toggleBold().run(), editor.isActive('bold'))}{action('斜体', <ItalicOutlined />, () => editor.chain().focus().toggleItalic().run(), editor.isActive('italic'))}{action('删除线', <StrikethroughOutlined />, () => editor.chain().focus().toggleStrike().run(), editor.isActive('strike'))}{action('行内代码', <CodeOutlined />, () => editor.chain().focus().toggleCode().run(), editor.isActive('code'))}
    {action('项目符号', <UnorderedListOutlined />, () => editor.chain().focus().toggleBulletList().run(), editor.isActive('bulletList'))}{action('编号列表', <OrderedListOutlined />, () => editor.chain().focus().toggleOrderedList().run(), editor.isActive('orderedList'))}{action('待办清单', <CheckSquareOutlined />, () => editor.chain().focus().toggleTaskList().run(), editor.isActive('taskList'))}{action('引用', <CommentOutlined />, () => editor.chain().focus().toggleBlockquote().run(), editor.isActive('blockquote'))}{action('分隔线', <MinusOutlined />, () => editor.chain().focus().setHorizontalRule().run())}{action('插入图片', <PictureOutlined />, chooseImage, undefined, busy)}{action(listening ? '停止语音' : '语音输入', <AudioOutlined />, voiceInput, listening, busy && !listening)}
    <details ref={tableToolsRef} className="en-table-tools" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus(); } }}>
      <summary className="en-tool" aria-label="表格工具" title="表格" aria-disabled={readOnly} onClick={event => { if (readOnly) event.preventDefault(); }}><TableOutlined /></summary>
      <div className="en-table-panel" role="group" aria-label="表格操作">
        {tableAction('插入表格', () => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(), !!currentRows || tableCount >= limits.maxTables || totalGridCells + 9 > limits.maxExpandedCells)}
        {tableAction('在上方插入行', () => editor.chain().focus().addRowBefore().run(), !currentRows || currentRows >= limits.maxRows || totalGridCells + currentColumns > limits.maxExpandedCells)}
        {tableAction('在下方插入行', () => editor.chain().focus().addRowAfter().run(), !currentRows || currentRows >= limits.maxRows || totalGridCells + currentColumns > limits.maxExpandedCells)}
        {tableAction('在左侧插入列', () => editor.chain().focus().addColumnBefore().run(), !currentRows || currentColumns >= limits.maxColumns || totalGridCells + currentRows > limits.maxExpandedCells)}
        {tableAction('在右侧插入列', () => editor.chain().focus().addColumnAfter().run(), !currentRows || currentColumns >= limits.maxColumns || totalGridCells + currentRows > limits.maxExpandedCells)}
        {tableAction('删除当前行', () => editor.chain().focus().deleteRow().run(), !currentRows)}
        {tableAction('删除当前列', () => editor.chain().focus().deleteColumn().run(), !currentRows)}
        {tableAction('删除表格', () => editor.chain().focus().deleteTable().run(), !currentRows)}
        <small>先点单元格，再编辑行列。每表最多 {limits.maxRows} 行、{limits.maxColumns} 列。</small>
      </div>
    </details>
  </div>{busy && <div className="en-upload-status" role="status">{listening ? '语音输入中，请说话或点停止…' : '图片上传中，请稍候再保存…'}</div>}{uploadError && <div className="en-message en-message--error" role="alert">{uploadError}</div>}<EditorContent editor={editor} /></div>;
}

export default function ExperienceNotesPage() { return <ExperienceNotebook />; }
