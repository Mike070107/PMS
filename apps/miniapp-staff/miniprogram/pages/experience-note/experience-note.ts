import { repairExperiences, upload } from '@pms/api-client';
import { createHoldToTalk, speechErrorTip, type HoldToTalk } from '@pms/miniapp-ui';
import {
  repairExperienceBlocksToMarkdown,
  repairExperienceMarkdownToBlocks,
  repairExperienceRenderBlocks,
} from '@pms/shared-types';
import type { RepairExperienceBlock, RepairExperienceBlockType, RepairExperienceRenderBlock } from '@pms/shared-types';

let speechManager: any = null;
try { speechManager = requirePlugin('WechatSI').getRecordRecognitionManager(); } catch { speechManager = null; }
let hold: HoldToTalk | null = null;

const textTypes: RepairExperienceBlockType[] = ['paragraph', 'heading', 'bullet', 'ordered', 'checklist', 'quote', 'warning'];
const newId = () => `b-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
const newTextBlock = (type: RepairExperienceBlockType = 'paragraph'): RepairExperienceBlock => ({
  id: newId(),
  type,
  ...(type === 'divider' ? {} : { text: '' }),
  ...(type === 'checklist' ? { checked: false } : {}),
});

Page({
  data: {
    noteId: 0,
    officeId: 0,
    officeName: '',
    repairType: '',
    repairTypeLabel: '',
    title: '',
    blocks: [] as RepairExperienceBlock[],
    readerBlocks: [] as RepairExperienceRenderBlock[],
    editorMode: 'visual' as 'visual' | 'markdown',
    markdownSource: '',
    revision: 1,
    canEdit: false,
    favorite: false,
    editing: false,
    saving: false,
    hasSpeech: false,
    recording: false,
    /** 手指按着、插件 onStart 还没回来的那一段：按下就变色，不然人以为没按上
        （2026-09-14「按了没反应」，判定都在 createHoldToTalk 里） */
    pressing: false,
    speechIndex: -1,
  },

  onLoad(query: Record<string, string>) {
    this.bindSpeech();
    const id = Number(query.id || 0);
    if (id) {
      this.setData({ noteId: id });
      this.load();
      return;
    }
    this.setData({
      officeId: Number(query.officeId),
      officeName: decodeURIComponent(query.officeName || ''),
      repairType: decodeURIComponent(query.repairType || ''),
      repairTypeLabel: decodeURIComponent(query.typeLabel || ''),
      title: '',
      blocks: [newTextBlock('heading'), newTextBlock('paragraph')],
      readerBlocks: [],
      editorMode: 'visual',
      markdownSource: '',
      canEdit: true,
      editing: true,
    });
  },

  async load() {
    try {
      const note = await repairExperiences.detail(this.data.noteId);
      this.setData({
        officeId: note.officeId,
        officeName: note.officeName,
        repairType: note.repairType,
        repairTypeLabel: note.repairTypeLabel,
        title: note.title,
        blocks: note.blocks,
        readerBlocks: repairExperienceRenderBlocks(note.blocks),
        markdownSource: repairExperienceBlocksToMarkdown(note.blocks),
        revision: note.revision,
        canEdit: note.canEdit,
        favorite: note.favorite,
      });
    } catch (e: any) { wx.showToast({ icon: 'none', title: e?.message || '加载失败' }); }
  },

  bindSpeech() {
    if (!speechManager) return;
    hold = createHoldToTalk(speechManager, {
      // 按下 / 松开立刻反映到界面，不等插件的 onStart
      onPressing: (pressing) => this.setData({ pressing }),
    });
    this.setData({ hasSpeech: true });
    speechManager.onStart = () => { this.setData({ recording: true }); hold?.started(); };
    speechManager.onRecognize = () => undefined;
    speechManager.onStop = (res: { result?: string }) => {
      hold?.ended();
      const text = String(res.result || '').trim();
      const index = this.data.speechIndex;
      const blocks = this.data.blocks.slice();
      if (text && blocks[index]) {
        const before = String(blocks[index].text || '').trim();
        blocks[index] = { ...blocks[index], text: before ? `${before}；${text}` : text };
      }
      this.setData({ recording: false, blocks });
    };
    speechManager.onError = (err: any) => {
      hold?.ended(); this.setData({ recording: false });
      speechErrorTip(err).then((title) => wx.showToast({ icon: 'none', title }));
    };
  },

  onStartRecord(e: WechatMiniprogram.BaseEvent) { this.setData({ speechIndex: Number(e.currentTarget.dataset.index) }); hold?.press(); },
  onStopRecord() { hold?.release(); },

  /** 按住时手指微动不算翻页：WXML 用 catchtouchmove 截住，页面不滚就不会派 touchcancel 把这一段作废 */
  onHoldMove() {},
  onTitleInput(e: WechatMiniprogram.Input) { this.setData({ title: e.detail.value }); },
  onTextInput(e: WechatMiniprogram.Input) {
    const index = Number(e.currentTarget.dataset.index);
    const current = this.data.blocks[index];
    if (!current) return;
    const shortcut = markdownShortcut(String(e.detail.value));
    if (shortcut) {
      const block = { ...current, ...shortcut };
      if (block.type === 'divider') delete block.text;
      this.setData({ [`blocks[${index}]`]: block });
      return;
    }
    this.setData({ [`blocks[${index}].text`]: e.detail.value });
  },
  onCaptionInput(e: WechatMiniprogram.Input) {
    const index = Number(e.currentTarget.dataset.index);
    this.setData({ [`blocks[${index}].caption`]: e.detail.value });
  },
  async onToggleFavorite() {
    const on = !this.data.favorite;
    try {
      await repairExperiences.setFavorite(this.data.noteId, on);
      this.setData({ favorite: on });
      wx.showToast({ icon: 'none', title: on ? '已收藏，列表里会放最上面' : '已取消收藏' });
    } catch (e: any) { wx.showToast({ icon: 'none', title: e?.message || '操作失败' }); }
  },

  onEdit() {
    if (this.data.canEdit) this.setData({
      editing: true,
      editorMode: 'visual',
      markdownSource: repairExperienceBlocksToMarkdown(this.data.blocks),
    });
  },
  onAddBlock(e: WechatMiniprogram.BaseEvent) {
    const type = String(e.currentTarget.dataset.type) as RepairExperienceBlockType;
    const safeType = textTypes.includes(type) || type === 'divider' ? type : 'paragraph';
    this.setData({ blocks: [...this.data.blocks, newTextBlock(safeType)] });
  },
  onRemoveBlock(e: WechatMiniprogram.BaseEvent) {
    const index = Number(e.currentTarget.dataset.index);
    this.setData({ blocks: this.data.blocks.filter((_, i) => i !== index) });
  },
  onMoveBlock(e: WechatMiniprogram.BaseEvent) {
    const index = Number(e.currentTarget.dataset.index);
    const to = index + Number(e.currentTarget.dataset.delta);
    if (to < 0 || to >= this.data.blocks.length) return;
    const blocks = this.data.blocks.slice();
    [blocks[index], blocks[to]] = [blocks[to], blocks[index]];
    this.setData({ blocks });
  },
  onToggleCheck(e: WechatMiniprogram.BaseEvent) {
    const index = Number(e.currentTarget.dataset.index);
    const block = this.data.blocks[index];
    if (!block || block.type !== 'checklist') return;
    this.setData({ [`blocks[${index}].checked`]: !block.checked });
  },
  onSwitchEditorMode(e: WechatMiniprogram.BaseEvent) {
    const mode = String(e.currentTarget.dataset.mode) as 'visual' | 'markdown';
    if (mode === this.data.editorMode) return;
    if (mode === 'markdown') {
      this.setData({ editorMode: mode, markdownSource: repairExperienceBlocksToMarkdown(this.data.blocks) });
      return;
    }
    this.setData({ editorMode: mode, blocks: repairExperienceMarkdownToBlocks(this.data.markdownSource) });
  },
  onMarkdownInput(e: WechatMiniprogram.Input) { this.setData({ markdownSource: e.detail.value }); },
  onCopyMarkdown() {
    const body = repairExperienceBlocksToMarkdown(this.data.blocks);
    wx.setClipboardData({ data: `# ${this.data.title || '维修经验'}\n\n${body}` });
  },
  async onAddImage() {
    try {
      const chosen = await wx.chooseMedia({ count: 1, mediaType: ['image'], sizeType: ['compressed'] });
      if (!chosen.tempFiles?.length) return;
      wx.showLoading({ title: '上传图片' });
      const result = await upload.uploadTempFile(chosen.tempFiles[0].tempFilePath, 120000);
      const url = result.displayUrl || result.publicUrl || (result.objectKey ? `/api/v1/upload/file?key=${encodeURIComponent(result.objectKey)}` : '');
      if (!url) throw new Error('上传结果无地址');
      this.setData({ blocks: [...this.data.blocks, { id: newId(), type: 'image', url, caption: '' }] });
    } catch (e: any) { wx.showToast({ icon: 'none', title: e?.message || '图片上传失败' }); }
    finally { wx.hideLoading(); }
  },
  onPreview(e: WechatMiniprogram.BaseEvent) {
    const current = e.currentTarget.dataset.url;
    const urls = this.data.blocks.filter((b) => b.type === 'image' && b.url).map((b) => b.url as string);
    wx.previewImage({ current, urls });
  },
  async onSave() {
    const title = this.data.title.trim();
    const sourceBlocks = this.data.editorMode === 'markdown'
      ? repairExperienceMarkdownToBlocks(this.data.markdownSource)
      : this.data.blocks;
    const blocks = sourceBlocks.filter((block) => block.type === 'image' ? !!block.url : block.type === 'divider' || !!block.text?.trim());
    if (!title) { wx.showToast({ icon: 'none', title: '请填写笔记标题' }); return; }
    if (!blocks.length) { wx.showToast({ icon: 'none', title: '请至少写一段内容' }); return; }
    this.setData({ saving: true });
    try {
      const payload = { officeId: this.data.officeId, repairType: this.data.repairType, title, blocks, revision: this.data.revision };
      const note = this.data.noteId
        ? await repairExperiences.update(this.data.noteId, payload)
        : await repairExperiences.create(payload);
      this.setData({
        noteId: note.id,
        revision: note.revision,
        blocks: note.blocks,
        readerBlocks: repairExperienceRenderBlocks(note.blocks),
        markdownSource: repairExperienceBlocksToMarkdown(note.blocks),
        editorMode: 'visual',
        editing: false,
        canEdit: note.canEdit,
      });
      wx.showToast({ icon: 'success', title: '已保存' });
    } catch (e: any) { wx.showModal({ title: '保存失败', content: e?.message || '请稍后重试', showCancel: false }); }
    finally { this.setData({ saving: false }); }
  },
});

function markdownShortcut(value: string): Partial<RepairExperienceBlock> | null {
  const rules: Array<[RegExp, RepairExperienceBlockType, boolean?]> = [
    [/^#{1,6}\s+/, 'heading'],
    [/^-\s+\[x\]\s+/i, 'checklist', true],
    [/^-\s+\[\s\]\s+/, 'checklist', false],
    [/^\d+[.)]\s+/, 'ordered'],
    [/^[-+*]\s+/, 'bullet'],
    [/^>\s+/, 'quote'],
  ];
  if (/^[-*_]{3,}\s*$/.test(value)) return { type: 'divider' };
  for (const [pattern, type, checked] of rules) {
    if (pattern.test(value)) {
      return { type, text: value.replace(pattern, ''), ...(type === 'checklist' ? { checked: !!checked } : {}) };
    }
  }
  return null;
}
