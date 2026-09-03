import {
  App as AntdApp, Button, Card, Collapse, Drawer, Empty, Image, Input, Space, Tag, Typography,
} from 'antd';
import {
  ArrowDownOutlined, ArrowUpOutlined, AudioOutlined, EditOutlined,
  ExclamationCircleOutlined, FileImageOutlined, PlusOutlined, ReadOutlined, SaveOutlined,
} from '@ant-design/icons';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { repairExperiences } from '@pms/api-client';
import type {
  RepairExperienceBlock, RepairExperienceBlockType, RepairExperienceNotebookView,
} from '@pms/shared-types';
import { formatDateTimeCn } from '@pms/shared-types';
import { MaterialPhotosUpload, imageSrc } from '../components/MaterialPhotos';
import './ExperienceNotesPage.css';

const { Title, Text, Paragraph } = Typography;
const makeBlock = (type: RepairExperienceBlockType): RepairExperienceBlock => ({
  id: `b-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  type,
  ...(type === 'image' ? { url: '', caption: '' } : { text: '' }),
});
interface Draft { id?: number; officeId: number; repairType: string; title: string; blocks: RepairExperienceBlock[]; revision: number; canEdit: boolean; }

export default function ExperienceNotesPage() {
  const { message } = AntdApp.useApp();
  const [notebooks, setNotebooks] = useState<RepairExperienceNotebookView[]>([]);
  const [activeKey, setActiveKey] = useState('');
  const [loading, setLoading] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await repairExperiences.list();
      setNotebooks(rows);
      setActiveKey((current) => current && rows.some((row) => `${row.officeId}:${row.repairType}` === current) ? current : rows.length ? `${rows[0].officeId}:${rows[0].repairType}` : '');
    } catch (e: any) { message.error(e?.message || '维修经验加载失败'); }
    finally { setLoading(false); }
  }, [message]);
  useEffect(() => { void load(); }, [load]);
  const active = useMemo(() => notebooks.find((row) => `${row.officeId}:${row.repairType}` === activeKey) || null, [activeKey, notebooks]);
  /**
   * 按管理处分组：一屏平铺几十本笔记谁都扫不过来（2026-09-03 反馈）。
   * 服务端下发的 notebooks 已经只含**本账号数据范围内**的管理处（见
   * RepairExperiencesService.allowedNotebooks → scopedOffices，右上角管理处视角
   * 会收窄 access.communityIds，所以这里天然跟着视角走），前端只负责分组和折叠。
   */
  const officeGroups = useMemo(() => {
    const byOffice = new Map<number, { officeId: number; officeName: string; rows: RepairExperienceNotebookView[]; noteCount: number }>();
    for (const row of notebooks) {
      const group = byOffice.get(row.officeId)
        || { officeId: row.officeId, officeName: row.officeName, rows: [], noteCount: 0 };
      group.rows.push(row);
      group.noteCount += row.notes.length;
      byOffice.set(row.officeId, group);
    }
    return [...byOffice.values()];
  }, [notebooks]);
  // 默认只展开「当前选中的那本笔记所属的管理处」，其余折叠；用户手动展开后按他的选择走
  const [openOffices, setOpenOffices] = useState<string[]>([]);
  const activeOfficeKey = active ? String(active.officeId) : '';
  useEffect(() => {
    if (!activeOfficeKey) return;
    setOpenOffices((current) => (current.includes(activeOfficeKey) ? current : [...current, activeOfficeKey]));
  }, [activeOfficeKey]);

  const openNew = () => {
    if (!active?.canEdit) return;
    setDraft({ officeId: active.officeId, repairType: active.repairType, title: '', revision: 1, canEdit: true, blocks: [makeBlock('heading'), makeBlock('paragraph')] });
    setEditing(true); setDrawerOpen(true);
  };
  const openNote = async (id: number) => {
    try {
      const note = await repairExperiences.detail(id);
      setDraft({ id: note.id, officeId: note.officeId, repairType: note.repairType, title: note.title, blocks: note.blocks, revision: note.revision, canEdit: note.canEdit });
      setEditing(false); setDrawerOpen(true);
    } catch (e: any) { message.error(e?.message || '笔记加载失败'); }
  };
  const patchBlock = (index: number, patch: Partial<RepairExperienceBlock>) => setDraft((current) => current ? ({ ...current, blocks: current.blocks.map((block, i) => i === index ? { ...block, ...patch } : block) }) : current);
  const moveBlock = (index: number, delta: number) => setDraft((current) => {
    if (!current) return current; const target = index + delta;
    if (target < 0 || target >= current.blocks.length) return current;
    const blocks = current.blocks.slice(); [blocks[index], blocks[target]] = [blocks[target], blocks[index]];
    return { ...current, blocks };
  });
  const removeBlock = (index: number) => setDraft((current) => current ? ({ ...current, blocks: current.blocks.filter((_, i) => i !== index) }) : current);
  const addBlock = (type: RepairExperienceBlockType) => setDraft((current) => current ? ({ ...current, blocks: [...current.blocks, makeBlock(type)] }) : current);
  const dictate = (index: number) => {
    const Recognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!Recognition) { message.info('当前浏览器不支持语音输入，可在手机小程序里使用按住说话'); return; }
    const recognition = new Recognition(); recognition.lang = 'zh-CN'; recognition.interimResults = false;
    recognition.onresult = (event: any) => {
      const spoken = String(event.results?.[0]?.[0]?.transcript || '').trim(); if (!spoken) return;
      setDraft((current) => {
        if (!current?.blocks[index]) return current; const before = String(current.blocks[index].text || '').trim();
        return { ...current, blocks: current.blocks.map((block, i) => i === index ? { ...block, text: before ? `${before}；${spoken}` : spoken } : block) };
      });
    };
    recognition.onerror = () => message.warning('语音识别失败，请重试或直接输入');
    recognition.start(); message.info('请开始说话，说完后稍等片刻');
  };
  const save = async () => {
    if (!draft) return; const title = draft.title.trim();
    const blocks = draft.blocks.filter((block) => block.type === 'image' ? !!block.url : !!block.text?.trim());
    if (!title) { message.warning('请填写笔记标题'); return; }
    if (!blocks.length) { message.warning('请至少填写一段正文或添加一张图片'); return; }
    setSaving(true);
    try {
      const payload = { officeId: draft.officeId, repairType: draft.repairType, title, blocks, revision: draft.revision };
      const saved = draft.id ? await repairExperiences.update(draft.id, payload) : await repairExperiences.create(payload);
      setDraft({ id: saved.id, officeId: saved.officeId, repairType: saved.repairType, title: saved.title, blocks: saved.blocks, revision: saved.revision, canEdit: saved.canEdit });
      setEditing(false); message.success('维修经验已保存'); await load();
    } catch (e: any) { message.error(e?.message || '保存失败'); }
    finally { setSaving(false); }
  };

  return <div className="experience-page">
    <div className="experience-hero">
      <div><Title level={2}>维修经验总结</Title><Paragraph>按管理处和报修类别共用一本笔记，把排查方法、维修步骤和返工注意事项留给同事。</Paragraph></div>
      {active?.canEdit && <Button type="primary" size="large" icon={<PlusOutlined />} onClick={openNew}>写一篇经验</Button>}
    </div>
    <div className="experience-layout">
      <Card className="experience-notebooks" loading={loading} title="共享笔记本">
        {officeGroups.length > 1 ? <Collapse
          className="experience-office-groups"
          activeKey={openOffices}
          onChange={(keys) => setOpenOffices(Array.isArray(keys) ? keys.map(String) : [String(keys)])}
          items={officeGroups.map((group) => ({
            key: String(group.officeId),
            label: <Space size={8}><strong>{group.officeName}</strong><Tag>{group.rows.length} 本</Tag><Text type="secondary">{group.noteCount} 篇</Text></Space>,
            children: <div className="experience-notebook-list">{group.rows.map((row) => { const key = `${row.officeId}:${row.repairType}`; return <button key={key} className={`experience-notebook ${activeKey === key ? 'is-active' : ''}`} onClick={() => setActiveKey(key)}><strong>{row.repairTypeLabel}</strong><em>{row.notes.length} 篇</em></button>; })}</div>,
          }))}
        /> : <div className="experience-notebook-list">{notebooks.map((row) => { const key = `${row.officeId}:${row.repairType}`; return <button key={key} className={`experience-notebook ${activeKey === key ? 'is-active' : ''}`} onClick={() => setActiveKey(key)}><strong>{row.repairTypeLabel}</strong><em>{row.notes.length} 篇</em></button>; })}</div>}
        {!loading && !notebooks.length && <Empty description="暂无可查看的类别笔记本" />}
      </Card>
      <Card className="experience-notes" title={active ? <Space wrap><span>{active.repairTypeLabel}</span><Tag>{active.officeName}</Tag></Space> : '经验笔记'}>
        {!active || !active.notes.length ? <Empty description={active ? '还没有经验记录' : '请先选择笔记本'} /> : <div className="experience-note-grid">{active.notes.map((note) => <button key={note.id} className="experience-note-card" onClick={() => void openNote(note.id)}><ReadOutlined className="experience-note-icon" /><strong>{note.title}</strong><span>{note.preview || '包含图片或结构化内容，点击查看'}</span><small>{note.updatedByName} · {formatDateTimeCn(note.updatedAt)}{note.imageCount ? ` · ${note.imageCount} 张图` : ''}</small></button>)}</div>}
      </Card>
    </div>
    <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)} width={760} className="experience-drawer" title={draft?.id ? '维修经验' : '新建维修经验'} extra={draft?.canEdit && !editing ? <Button icon={<EditOutlined />} onClick={() => setEditing(true)}>编辑</Button> : null}>
      {draft && (editing ? <div className="experience-editor">
        <label>笔记标题</label><Input size="large" maxLength={160} placeholder="例如：单元门门禁无响应的排查方法" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
        {draft.blocks.map((block, index) => <Card key={block.id} size="small" className={`experience-block-editor is-${block.type}`} title={blockLabel(block.type)} extra={<Space><Button size="small" type="text" icon={<ArrowUpOutlined />} onClick={() => moveBlock(index, -1)} /><Button size="small" type="text" icon={<ArrowDownOutlined />} onClick={() => moveBlock(index, 1)} /><Button size="small" danger type="text" onClick={() => removeBlock(index)}>删除</Button></Space>}>
          {block.type === 'image' ? <MaterialPhotosUpload max={1} value={block.url ? [block.url] : []} onChange={(urls) => patchBlock(index, { url: urls[0] || '' })} /> : <><Input.TextArea autoSize={{ minRows: block.type === 'heading' ? 1 : 3, maxRows: 12 }} maxLength={4000} value={block.text} placeholder={block.type === 'warning' ? '写容易忽略、安全风险或返工点' : '输入内容'} onChange={(e) => patchBlock(index, { text: e.target.value })} /><Button className="experience-voice" icon={<AudioOutlined />} onClick={() => dictate(index)}>语音输入</Button></>}
          {block.type === 'image' && <Input className="experience-caption" maxLength={300} placeholder="图片说明（可不填）" value={block.caption} onChange={(e) => patchBlock(index, { caption: e.target.value })} />}
        </Card>)}
        <div className="experience-add"><Text strong>继续添加：</Text><Space wrap><Button onClick={() => addBlock('paragraph')}>正文</Button><Button onClick={() => addBlock('heading')}>小标题</Button><Button onClick={() => addBlock('bullet')}>步骤</Button><Button icon={<ExclamationCircleOutlined />} onClick={() => addBlock('warning')}>注意事项</Button><Button icon={<FileImageOutlined />} onClick={() => addBlock('image')}>图片</Button></Space></div>
        <Button type="primary" size="large" block icon={<SaveOutlined />} loading={saving} onClick={() => void save()}>保存维修经验</Button>
      </div> : <article className="experience-reader"><Title level={2}>{draft.title}</Title>{draft.blocks.map((block) => block.type === 'image' ? <figure key={block.id}><Image src={imageSrc(block.url)} /><figcaption>{block.caption}</figcaption></figure> : <div key={block.id} className={`reader-${block.type}`}>{block.type === 'bullet' && '• '}{block.text}</div>)}</article>)}
    </Drawer>
  </div>;
}
function blockLabel(type: RepairExperienceBlockType) { return ({ heading: '小标题', paragraph: '正文', bullet: '步骤', warning: '注意事项', image: '图片' } as const)[type]; }
