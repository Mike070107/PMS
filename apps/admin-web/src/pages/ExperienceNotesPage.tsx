import { App as AntdApp, Button, Card, Collapse, Drawer, Empty, Image, Space, Tag, Tooltip, Typography } from 'antd';
import { AudioOutlined, BoldOutlined, CheckSquareOutlined, CodeOutlined, CommentOutlined, EditOutlined, ItalicOutlined, MinusOutlined, OrderedListOutlined, PlusOutlined, ReadOutlined, RedoOutlined, SaveOutlined, StrikethroughOutlined, UndoOutlined, UnorderedListOutlined } from '@ant-design/icons';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import ImageExtension from '@tiptap/extension-image';
import Placeholder from '@tiptap/extension-placeholder';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import { repairExperiences } from '@pms/api-client';
import type { RepairExperienceBlock, RepairExperienceNotebookView } from '@pms/shared-types';
import { formatDateTimeCn, repairExperienceBlocksToDocumentHtml, repairExperienceDocumentPlainText, repairExperienceInlineHtml, repairExperienceRenderBlocks } from '@pms/shared-types';
import { MaterialPhotosUpload, imageSrc } from '../components/MaterialPhotos';
import './ExperienceNotesPage.css';

const { Title, Text, Paragraph } = Typography;
interface Draft { id?: number; officeId: number; repairType: string; title: string; blocks: RepairExperienceBlock[]; html: string; revision: number; canEdit: boolean; }

export default function ExperienceNotesPage() {
  const { message } = AntdApp.useApp();
  const [notebooks, setNotebooks] = useState<RepairExperienceNotebookView[]>([]);
  const [activeKey, setActiveKey] = useState('');
  const [loading, setLoading] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [emptyReason, setEmptyReason] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await repairExperiences.list();
      setNotebooks(rows);
      if (rows.length) setEmptyReason(null);
      else { try { setEmptyReason((await repairExperiences.access()).emptyReason ?? null); } catch { setEmptyReason(null); } }
      setActiveKey((current) => current && rows.some((row) => `${row.officeId}:${row.repairType}` === current) ? current : rows.length ? `${rows[0].officeId}:${rows[0].repairType}` : '');
    } catch (e: any) { message.error(e?.message || '维修经验加载失败'); }
    finally { setLoading(false); }
  }, [message]);
  useEffect(() => { void load(); }, [load]);

  const active = useMemo(() => notebooks.find((row) => `${row.officeId}:${row.repairType}` === activeKey) || null, [activeKey, notebooks]);
  const officeGroups = useMemo(() => {
    const byOffice = new Map<number, { officeId: number; officeName: string; rows: RepairExperienceNotebookView[]; noteCount: number }>();
    for (const row of notebooks) {
      const group = byOffice.get(row.officeId) || { officeId: row.officeId, officeName: row.officeName, rows: [], noteCount: 0 };
      group.rows.push(row); group.noteCount += row.notes.length; byOffice.set(row.officeId, group);
    }
    return [...byOffice.values()];
  }, [notebooks]);
  const [openOffices, setOpenOffices] = useState<string[]>([]);
  const activeOfficeKey = active ? String(active.officeId) : '';
  useEffect(() => { if (activeOfficeKey) setOpenOffices((current) => current.includes(activeOfficeKey) ? current : [...current, activeOfficeKey]); }, [activeOfficeKey]);

  const openNew = () => {
    if (!active?.canEdit) return;
    setDraft({ officeId: active.officeId, repairType: active.repairType, title: '', revision: 1, canEdit: true, blocks: [], html: '<p></p>' });
    setEditing(true); setDrawerOpen(true);
  };
  const openNote = async (id: number) => {
    try {
      const note = await repairExperiences.detail(id);
      setDraft({ id: note.id, officeId: note.officeId, repairType: note.repairType, title: note.title, blocks: note.blocks, html: repairExperienceBlocksToDocumentHtml(note.blocks), revision: note.revision, canEdit: note.canEdit });
      setEditing(false); setDrawerOpen(true);
    } catch (e: any) { message.error(e?.message || '笔记加载失败'); }
  };
  const save = async () => {
    if (!draft) return;
    const title = draft.title.trim();
    if (!title) { message.warning('请填写笔记标题'); return; }
    if (!repairExperienceDocumentPlainText(draft.html) && !/<img\b/i.test(draft.html)) { message.warning('请至少写一段正文或添加一张图片'); return; }
    setSaving(true);
    try {
      const blocks: RepairExperienceBlock[] = [{ id: `doc-${draft.id || Date.now()}`, type: 'document', html: draft.html }];
      const payload = { officeId: draft.officeId, repairType: draft.repairType, title, blocks, revision: draft.revision };
      const saved = draft.id ? await repairExperiences.update(draft.id, payload) : await repairExperiences.create(payload);
      setDraft({ id: saved.id, officeId: saved.officeId, repairType: saved.repairType, title: saved.title, blocks: saved.blocks, html: repairExperienceBlocksToDocumentHtml(saved.blocks), revision: saved.revision, canEdit: saved.canEdit });
      setEditing(false); message.success('维修经验已保存'); await load();
    } catch (e: any) { message.error(e?.message || '保存失败'); }
    finally { setSaving(false); }
  };

  return <div className="experience-page">
    <div className="experience-hero"><div><Title level={2}>维修经验总结</Title><Paragraph>按管理处和报修类别共用一本笔记，把排查方法、维修步骤和返工注意事项留给同事。</Paragraph></div>{active?.canEdit && <Button type="primary" size="large" icon={<PlusOutlined />} onClick={openNew}>写一篇经验</Button>}</div>
    <div className="experience-layout">
      <Card className="experience-notebooks" loading={loading} title="共享笔记本">
        {officeGroups.length > 1 ? <Collapse className="experience-office-groups" activeKey={openOffices} onChange={(keys) => setOpenOffices(Array.isArray(keys) ? keys.map(String) : [String(keys)])} items={officeGroups.map((group) => ({ key: String(group.officeId), label: <Space size={8}><strong>{group.officeName}</strong><Tag>{group.rows.length} 本</Tag><Text type="secondary">{group.noteCount} 篇</Text></Space>, children: <NotebookList rows={group.rows} activeKey={activeKey} onSelect={setActiveKey} /> }))} /> : <NotebookList rows={notebooks} activeKey={activeKey} onSelect={setActiveKey} />}
        {!loading && !notebooks.length && <Empty description={emptyReason || '暂无可查看的类别笔记本'} />}
      </Card>
      <Card className="experience-notes" title={active ? <Space wrap><span>{active.repairTypeLabel}</span><Tag>{active.officeName}</Tag></Space> : '经验笔记'}>
        {!active || !active.notes.length ? <Empty description={active ? '还没有经验记录' : '请先选择笔记本'} /> : <div className="experience-note-grid">{active.notes.map((note) => <button key={note.id} className="experience-note-card" onClick={() => void openNote(note.id)}><ReadOutlined className="experience-note-icon" /><strong>{note.title}</strong><span>{note.preview || '包含图片或排版内容，点击查看'}</span><small>{note.updatedByName} · {formatDateTimeCn(note.updatedAt)}{note.imageCount ? ` · ${note.imageCount} 张图` : ''}</small></button>)}</div>}
      </Card>
    </div>
    <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)} width={900} className="experience-drawer" title={draft?.id ? '维修经验' : '新建维修经验'} extra={draft?.canEdit && !editing ? <Button icon={<EditOutlined />} onClick={() => setEditing(true)}>编辑</Button> : null}>
      {draft && (editing ? <div className="experience-editor"><input className="experience-title-input" maxLength={160} placeholder="输入笔记标题" value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /><ExperienceDocumentEditor key={`${draft.id || 'new'}-${draft.revision}`} html={draft.html} onChange={(html) => setDraft((current) => current ? { ...current, html } : current)} /><Button type="primary" size="large" block icon={<SaveOutlined />} loading={saving} onClick={() => void save()}>保存维修经验</Button></div> : <ExperienceReader title={draft.title} blocks={draft.blocks} />)}
    </Drawer>
  </div>;
}

function NotebookList({ rows, activeKey, onSelect }: { rows: RepairExperienceNotebookView[]; activeKey: string; onSelect: (key: string) => void }) {
  return <div className="experience-notebook-list">{rows.map((row) => { const key = `${row.officeId}:${row.repairType}`; return <button key={key} className={`experience-notebook ${activeKey === key ? 'is-active' : ''}`} onClick={() => onSelect(key)}><strong>{row.repairTypeLabel}</strong><em>{row.notes.length} 篇</em></button>; })}</div>;
}

function ExperienceDocumentEditor({ html, onChange }: { html: string; onChange: (html: string) => void }) {
  const { message } = AntdApp.useApp();
  const editor = useEditor({ extensions: [StarterKit.configure({ heading: { levels: [2, 3] } }), TaskList, TaskItem.configure({ nested: true }), ImageExtension.configure({ allowBase64: false }), Placeholder.configure({ placeholder: '输入正文，或用上方工具添加标题、清单、图片...' })], content: html, onUpdate: ({ editor: current }) => onChange(current.getHTML()) });
  const speak = () => {
    const Recognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!Recognition || !editor) { message.info('当前浏览器不支持语音输入，可在员工小程序里使用'); return; }
    const recognition = new Recognition(); recognition.lang = 'zh-CN'; recognition.interimResults = false;
    recognition.onresult = (event: any) => { const text = String(event.results?.[0]?.[0]?.transcript || '').trim(); if (text) editor.chain().focus().insertContent(text).run(); };
    recognition.onerror = () => message.warning('语音识别失败，请重试或直接输入'); recognition.start(); message.info('请开始说话');
  };
  if (!editor) return null;
  const action = (label: string, icon: ReactNode, command: () => void, active = false) => <Tooltip title={label}><Button aria-label={label} type={active ? 'primary' : 'text'} icon={icon} onClick={command} /></Tooltip>;
  return <div className="notion-editor"><div className="notion-toolbar">
    {action('撤销', <UndoOutlined />, () => editor.chain().focus().undo().run())}{action('重做', <RedoOutlined />, () => editor.chain().focus().redo().run())}<span className="notion-toolbar__divider" />
    <Button type={editor.isActive('heading', { level: 2 }) ? 'primary' : 'text'} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}>标题</Button>
    {action('加粗', <BoldOutlined />, () => editor.chain().focus().toggleBold().run(), editor.isActive('bold'))}{action('斜体', <ItalicOutlined />, () => editor.chain().focus().toggleItalic().run(), editor.isActive('italic'))}{action('删除线', <StrikethroughOutlined />, () => editor.chain().focus().toggleStrike().run(), editor.isActive('strike'))}{action('行内代码', <CodeOutlined />, () => editor.chain().focus().toggleCode().run(), editor.isActive('code'))}
    {action('项目符号', <UnorderedListOutlined />, () => editor.chain().focus().toggleBulletList().run(), editor.isActive('bulletList'))}{action('编号列表', <OrderedListOutlined />, () => editor.chain().focus().toggleOrderedList().run(), editor.isActive('orderedList'))}{action('待办清单', <CheckSquareOutlined />, () => editor.chain().focus().toggleTaskList().run(), editor.isActive('taskList'))}{action('引用', <CommentOutlined />, () => editor.chain().focus().toggleBlockquote().run(), editor.isActive('blockquote'))}{action('分隔线', <MinusOutlined />, () => editor.chain().focus().setHorizontalRule().run())}{action('语音输入', <AudioOutlined />, speak)}
    <div className="notion-image-tool"><MaterialPhotosUpload compact max={1} value={[]} onChange={(urls) => { if (urls[0]) editor.chain().focus().setImage({ src: urls[0] }).run(); }} /></div>
  </div><EditorContent editor={editor} /></div>;
}

function ExperienceReader({ title, blocks }: { title: string; blocks: RepairExperienceBlock[] }) {
  const documentBlock = blocks.find((block) => block.type === 'document');
  return <article className="experience-reader"><Title level={2}>{title}</Title>{documentBlock ? <div className="experience-document" dangerouslySetInnerHTML={{ __html: documentBlock.html || '' }} /> : repairExperienceRenderBlocks(blocks).map((block) => block.type === 'image' ? <figure key={block.id}><Image src={imageSrc(block.url)} /><figcaption>{block.caption}</figcaption></figure> : block.type === 'divider' ? <hr key={block.id} /> : <div key={block.id} className={`reader-${block.type}`}>{block.type === 'ordered' && <span className="reader-marker">{block.order}.</span>}{block.type === 'bullet' && <span className="reader-marker">•</span>}{block.type === 'checklist' && <span className={`reader-check ${block.checked ? 'is-checked' : ''}`} />}<span dangerouslySetInnerHTML={{ __html: block.html || repairExperienceInlineHtml(block.text || '') }} /></div>)}</article>;
}
