import { repairExperiences, upload } from '@pms/api-client';
import { createHoldToTalk, speechErrorTip, type HoldToTalk } from '@pms/miniapp-ui';
import {
  repairExperienceBlocksToDocumentHtml,
  repairExperienceDocumentPlainText,
  repairExperienceRenderBlocks,
} from '@pms/shared-types';
import type { RepairExperienceBlock, RepairExperienceRenderBlock } from '@pms/shared-types';

let speechManager: any = null;
try { speechManager = requirePlugin('WechatSI').getRecordRecognitionManager(); } catch { speechManager = null; }
let hold: HoldToTalk | null = null;
let editorContext: WechatMiniprogram.EditorContext | null = null;

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
    documentHtml: '<p></p>',
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
      blocks: [],
      readerBlocks: [],
      documentHtml: '<p></p>',
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
        documentHtml: repairExperienceBlocksToDocumentHtml(note.blocks),
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
      if (text) editorContext?.insertText({ text });
      this.setData({ recording: false });
    };
    speechManager.onError = (err: any) => {
      hold?.ended(); this.setData({ recording: false });
      speechErrorTip(err).then((title) => wx.showToast({ icon: 'none', title }));
    };
  },

  onStartRecord() { hold?.press(); },
  onStopRecord() { hold?.release(); },

  /** 按住时手指微动不算翻页：WXML 用 catchtouchmove 截住，页面不滚就不会派 touchcancel 把这一段作废 */
  onHoldMove() {},
  onTitleInput(e: WechatMiniprogram.Input) { this.setData({ title: e.detail.value }); },
  onEditorReady() {
    wx.createSelectorQuery().in(this).select('#experienceEditor').context((result) => {
      editorContext = result.context as unknown as WechatMiniprogram.EditorContext;
      editorContext?.setContents({ html: this.data.documentHtml || '<p></p>' });
    }).exec();
  },
  onDocumentInput(e: WechatMiniprogram.CustomEvent) {
    this.setData({ documentHtml: String((e.detail as any).html || '') });
  },
  onFormat(e: WechatMiniprogram.BaseEvent) {
    editorContext?.format(String(e.currentTarget.dataset.name), e.currentTarget.dataset.value || '');
  },
  onInsertDivider() { editorContext?.insertDivider(); },
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
      documentHtml: repairExperienceBlocksToDocumentHtml(this.data.blocks),
    }, () => editorContext?.setContents({ html: this.data.documentHtml }));
  },
  async onAddImage() {
    try {
      const chosen = await wx.chooseMedia({ count: 1, mediaType: ['image'], sizeType: ['compressed'] });
      if (!chosen.tempFiles?.length) return;
      wx.showLoading({ title: '上传图片' });
      const result = await upload.uploadTempFile(chosen.tempFiles[0].tempFilePath, 120000);
      const url = result.displayUrl || result.publicUrl || (result.objectKey ? `/api/v1/upload/file?key=${encodeURIComponent(result.objectKey)}` : '');
      if (!url) throw new Error('上传结果无地址');
      editorContext?.insertImage({ src: url, alt: '维修现场图片', width: '100%' });
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
    const html = this.data.documentHtml.trim();
    const blocks: RepairExperienceBlock[] = [{ id: `doc-${this.data.noteId || Date.now()}`, type: 'document', html }];
    if (!title) { wx.showToast({ icon: 'none', title: '请填写笔记标题' }); return; }
    if (!repairExperienceDocumentPlainText(html) && !/<img\b/i.test(html)) { wx.showToast({ icon: 'none', title: '请至少写一段内容' }); return; }
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
        documentHtml: repairExperienceBlocksToDocumentHtml(note.blocks),
        editing: false,
        canEdit: note.canEdit,
      });
      wx.showToast({ icon: 'success', title: '已保存' });
    } catch (e: any) { wx.showModal({ title: '保存失败', content: e?.message || '请稍后重试', showCancel: false }); }
    finally { this.setData({ saving: false }); }
  },
});
