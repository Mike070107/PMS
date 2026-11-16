import { repairExperiences } from '@pms/api-client';
import { createHoldToTalk, speechErrorTip, type HoldToTalk } from '@pms/miniapp-ui';
import { repairExperienceBlocksToDocumentHtml, repairExperienceDocumentPlainText, repairExperienceRenderBlocks } from '@pms/shared-types';
import type { RepairExperienceBlock, RepairExperienceRenderBlock, RepairExperienceNoteView, SaveRepairExperienceNoteReq } from '@pms/shared-types';
import { experienceScope, experienceTypes, experienceError, experienceCancelled, experienceHasTable, experienceTablePresentation, type ExperienceCommunity } from '../../utils/experience-library';

let speechManager: any = null;
try { speechManager = requirePlugin('WechatSI').getRecordRecognitionManager(); } catch { speechManager = null; }

Page({
  data: {
    noteId: 0, title: '', blocks: [] as RepairExperienceBlock[], readerBlocks: [] as (RepairExperienceRenderBlock & { hasTable: boolean; tableMinWidth: string })[],
    documentHtml: '<p></p>', revision: 1, canEdit: false, canManage: false, canDelete: false, favorite: false,
    editing: false, saving: false, uploading: false, deleting: false, loading: false, loaded: false, error: '', dirty: false,
    visibility: 'private' as 'private' | 'published' | 'legacy', scopeText: '仅我可见', authorText: '',
    communityIds: [] as number[], repairTypes: [] as string[], allowEdit: false, allowDelete: false,
    sharingOpen: false, sharingError: '', optionsError: '', optionsLoaded: false,
    communities: [] as ExperienceCommunity[], shareCommunities: [] as (ExperienceCommunity & { checked: boolean })[],
    shareTypes: [] as { value: string; label: string; checked: boolean }[],
    shareVisibility: 'private' as 'private' | 'published' | 'legacy', shareCommunityIds: [] as number[], shareRepairTypes: [] as string[],
    shareAllowEdit: false, shareAllowDelete: false, sharingSaving: false,
    imageWarning: '', hasImages: false, hasTable: false, hasLegacyTable: false, hasSpeech: false, recording: false, pressing: false,
  },
  editorContext: null as WechatMiniprogram.EditorContext | null,
  hold: null as HoldToTalk | null,
  savedTitle: '', savedHtml: '<p></p>', editVersion: 0, loadVersion: 0, destroyed: false, favoriteBusy: false,
  async onLoad(query: Record<string, string>) {
    this.destroyed = false;
    this.bindSpeech();
    const id = Number(query.id || 0);
    this.setData({ noteId: id });
    if (id) await Promise.all([this.load(), this.loadOptions()]);
    else {
      this.setData({ loading: true });
      const allowed = await this.loadOptions();
      if (this.destroyed) return;
      this.setData({ loaded: true, loading: false, canEdit: allowed, canManage: allowed, canDelete: false, editing: allowed,
        error: allowed ? '' : this.data.optionsError || '暂无新建经验文档权限' });
    }
  },
  onUnload() {
    this.destroyed = true; this.loadVersion++;
    this.hold?.release(); this.hold = null; this.editorContext = null;
    wx.disableAlertBeforeUnload?.();
  },
  async loadOptions() {
    try {
      const options = await repairExperiences.sharingOptions();
      if (this.destroyed) return false;
      this.setData({ communities: options.communities, optionsLoaded: true, optionsError: '' });
      return options.canCreate === true;
    } catch (e: any) {
      if (!this.destroyed) this.setData({ optionsLoaded: false, optionsError: experienceError(e, '分享范围加载失败') });
      return false;
    }
  },
  applyNote(note: RepairExperienceNoteView, preserveDraft = false) {
    const html = repairExperienceBlocksToDocumentHtml(note.blocks);
    this.savedTitle = note.title; this.savedHtml = html;
    const readerBlocks = repairExperienceRenderBlocks(note.blocks).map((block, index) => {
      const html = String(note.blocks[index].html || '');
      return /<table\b/i.test(html)
        ? { ...block, type: 'document' as const, hasTable: true, ...experienceTablePresentation(html) }
        : { ...block, hasTable: false, tableMinWidth: '100%' };
    });
    this.setData({ noteId: note.id, blocks: note.blocks, readerBlocks, hasTable: experienceHasTable(note.blocks), hasLegacyTable: note.blocks.some((block) => block.type !== 'document' && /<table\b/i.test(block.html || '')), revision: note.revision, hasImages: note.blocks.some((b) => b.type === 'image' || /<img\b/i.test(b.html || '')),
      canEdit: note.canEdit === true, canManage: note.canManage === true, canDelete: note.canDelete === true,
      favorite: note.favorite, visibility: note.visibility || 'legacy', scopeText: experienceScope(note), authorText: note.createdByName || '',
      communityIds: note.communityIds || [], repairTypes: note.repairTypes || [], allowEdit: note.allowEdit === true, allowDelete: note.allowDelete === true,
      ...(preserveDraft ? {} : { title: note.title, documentHtml: html, dirty: false }) });
    this.syncDirty();
  },
  async load() {
    if (this.data.dirty || this.data.uploading || this.data.saving || !this.data.noteId) return;
    const version = ++this.loadVersion;
    const editVersion = this.editVersion;
    this.setData({ loading: true, error: '' });
    try {
      const note = await repairExperiences.detail(this.data.noteId);
      if (this.destroyed || version !== this.loadVersion) return;
      const preserve = editVersion !== this.editVersion;
      this.applyNote(note, preserve); this.setData({ loaded: true, ...(preserve ? {} : { imageWarning: '' }) });
      if (!preserve && this.data.editing) this.editorContext?.setContents({ html: this.data.documentHtml });
    } catch (e: any) { if (!this.destroyed && version === this.loadVersion) this.setData({ error: experienceError(e, '文档加载失败') }); }
    finally { if (!this.destroyed && version === this.loadVersion) this.setData({ loading: false }); }
  },
  async onReload() {
    if (this.data.uploading || this.data.saving || this.data.sharingSaving) return;
    if (this.data.dirty) {
      const choice = await wx.showModal({ title: '刷新文档？', content: '未保存的内容会丢失，建议先保存。', showCancel: true, confirmText: '仍然刷新' });
      if (!choice.confirm) return;
      this.setData({ dirty: false });
    }
    return this.data.noteId ? this.load() : this.onLoad({});
  },
  syncDirty() {
    const dirty = this.data.title !== this.savedTitle || this.data.documentHtml !== this.savedHtml;
    this.setData({ dirty });
    if (dirty) wx.enableAlertBeforeUnload?.({ message: '内容尚未保存，确定离开？' });
    else wx.disableAlertBeforeUnload?.();
  },
  changed() { this.editVersion++; this.syncDirty(); },
  bindSpeech() {
    if (!speechManager) return;
    this.hold = createHoldToTalk(speechManager, { onPressing: (pressing) => { if (!this.destroyed) this.setData({ pressing }); } });
    this.setData({ hasSpeech: true });
    speechManager.onStart = () => { if (!this.destroyed) { this.setData({ recording: true }); this.hold?.started(); } };
    speechManager.onRecognize = () => undefined;
    speechManager.onStop = (res: { result?: string }) => {
      this.hold?.ended(); if (this.destroyed) return;
      const text = String(res.result || '').trim();
      if (text && this.data.editing && this.data.canEdit) this.editorContext?.insertText({ text });
      this.setData({ recording: false });
    };
    speechManager.onError = (err: any) => { this.hold?.ended(); if (this.destroyed) return; this.setData({ recording: false }); speechErrorTip(err).then((title) => { if (!this.destroyed) wx.showToast({ icon: 'none', title }); }); };
  },
  onStartRecord() { if (this.data.canEdit && this.data.editing && !this.data.saving && !this.data.uploading) this.hold?.press(); },
  onStopRecord() { this.hold?.release(); },
  onHoldMove() {},
  onTitleInput(e: WechatMiniprogram.Input) { this.setData({ title: e.detail.value }); this.changed(); },
  onEditorReady() {
    if (this.tableEditingBlocked()) return;
    wx.createSelectorQuery().in(this).select('#experienceEditor').context((result) => {
      if (this.destroyed) return;
      this.editorContext = result.context as unknown as WechatMiniprogram.EditorContext;
      this.editorContext?.setContents({ html: this.data.documentHtml || '<p></p>' });
    }).exec();
  },
  onDocumentInput(e: WechatMiniprogram.CustomEvent) {
    if (this.tableEditingBlocked()) return;
    const html = String((e.detail as any).html || '');
    if (html === this.data.documentHtml) return;
    this.setData({ documentHtml: html }); this.changed();
  },
  onFormat(e: WechatMiniprogram.BaseEvent) { if (this.data.canEdit && !this.data.uploading) this.editorContext?.format(String(e.currentTarget.dataset.name), e.currentTarget.dataset.value || ''); },
  onUndo() { this.editorContext?.undo(); },
  onRedo() { this.editorContext?.redo(); },
  onInsertDivider() { this.editorContext?.insertDivider(); },
  async onToggleFavorite() {
    if (!this.data.noteId || this.favoriteBusy) return;
    this.favoriteBusy = true;
    try { const on = !this.data.favorite; await repairExperiences.setFavorite(this.data.noteId, on); if (!this.destroyed) this.setData({ favorite: on }); }
    catch (e: any) { wx.showToast({ icon: 'none', title: experienceError(e, '收藏操作失败') }); }
    finally { this.favoriteBusy = false; }
  },
  tableEditingBlocked(): boolean {
    const blocked = this.data.hasTable || experienceHasTable(this.data.blocks) || /<table\b/i.test(this.data.documentHtml);
    if (blocked) this.setData({ error: '含表格，请在Web编辑；小程序可阅读、收藏或管理分享。' });
    return blocked;
  },
  onEdit() {
    if (this.tableEditingBlocked()) return;
    if (!this.data.canEdit || this.data.saving || this.data.uploading || this.data.sharingSaving) return;
    this.setData({ editing: true, error: '' });
  },
  async onAddImage() {
    if (this.tableEditingBlocked()) return;
    if (!this.data.canEdit || !this.data.editing || this.data.uploading || this.data.saving || this.data.sharingSaving) return;
    this.setData({ uploading: true, error: '' }); // 先锁，再打开原生选择器。
    let loading = false;
    try {
      const chosen = await wx.chooseMedia({ count: 1, mediaType: ['image'], sourceType: ['album', 'camera'], sizeType: ['compressed'] });
      if (!chosen.tempFiles?.length || this.destroyed) return;
      wx.showLoading({ title: '上传图片' }); loading = true;
      const result = await repairExperiences.uploadAsset(chosen.tempFiles[0].tempFilePath);
      if (this.destroyed) return;
      if (!result.displayUrl || !result.objectKey) throw new Error('上传结果缺少安全附件地址');
      if (!this.editorContext) throw new Error('编辑器尚未就绪，请重试');
      await new Promise<void>((resolve, reject) => this.editorContext!.insertImage({ src: result.displayUrl, alt: '维修现场图片', width: '100%', success: () => resolve(), fail: reject }));
      this.editVersion++; this.setData({ dirty: true, hasImages: true }); wx.enableAlertBeforeUnload?.({ message: '图片尚未保存，确定离开？' });
      // 在解除上传锁之前读取实际editor内容，避免insertImage回调先于input导致立即保存漏图。
      if (typeof this.editorContext.getContents === 'function') {
        const version = this.editVersion;
        await new Promise<void>((resolve, reject) => this.editorContext!.getContents({ success: (result) => {
          if (!this.destroyed && version === this.editVersion && typeof result.html === 'string') this.setData({ documentHtml: result.html });
          resolve();
        }, fail: reject }));
      }
      // 原生input事件仍会同步后续输入；成功附件不会因下次上传失败被清空。
    } catch (e: any) {
      if (!this.destroyed && !experienceCancelled(e)) { const error = experienceError(e, '图片上传失败'); this.setData({ error }); wx.showToast({ icon: 'none', title: error }); }
    } finally { if (loading) wx.hideLoading(); if (!this.destroyed) this.setData({ uploading: false }); }
  },
  onImageError() { this.setData({ imageWarning: '图片链接可能已过期。请先保存正文，再刷新文档；刷新会重新获取访问地址。' }); },
  onPreview(e: WechatMiniprogram.BaseEvent) {
    const current = String(e.currentTarget.dataset.url);
    const urls = this.data.blocks.filter((b) => b.type === 'image' && b.url).map((b) => b.url as string);
    wx.previewImage({ current, urls });
  },
  async onSave() {
    if (this.tableEditingBlocked()) return;
    if (!this.data.canEdit || !this.data.editing || this.data.saving || this.data.uploading || this.data.sharingSaving || this.data.deleting || this.data.loading) return;
    const title = this.data.title.trim(), html = this.data.documentHtml.trim();
    if (!title) { this.setData({ error: '请填写文档标题' }); return; }
    if (!repairExperienceDocumentPlainText(html) && !/<img\b/i.test(html)) { this.setData({ error: '请至少写一段内容' }); return; }
    const version = this.editVersion;
    const payload: SaveRepairExperienceNoteReq = { title, blocks: [{ id: `doc-${this.data.noteId || Date.now()}`, type: 'document', html }], revision: this.data.revision };
    if (!this.data.noteId) { payload.visibility = 'private'; payload.allowEdit = false; payload.allowDelete = false; payload.communityIds = []; payload.repairTypes = []; }
    this.setData({ saving: true, error: '' });
    try {
      const note = this.data.noteId ? await repairExperiences.update(this.data.noteId, payload) : await repairExperiences.create(payload);
      if (this.destroyed) return;
      const preserve = version !== this.editVersion;
      this.applyNote(note, preserve);
      this.setData({ editing: preserve, error: '' });
      wx.showToast({ icon: 'success', title: preserve ? '已保存，新增输入待保存' : '已保存（分享范围未变）' });
    } catch (e: any) { if (!this.destroyed) this.setData({ error: experienceError(e, '保存失败，请保留草稿后重试') }); }
    finally { if (!this.destroyed) this.setData({ saving: false }); }
  },
  syncShareChoices() {
    const shareCommunities = this.data.communities.map((c) => ({ ...c, checked: this.data.shareCommunityIds.includes(c.id) }));
    const types = experienceTypes(shareCommunities.filter((c) => c.checked));
    this.setData({ shareCommunities, shareTypes: types.map((t) => ({ ...t, checked: this.data.shareRepairTypes.includes(t.value) })) });
  },
  async onOpenSharing() {
    if (!this.data.canManage || !this.data.noteId || this.data.saving || this.data.uploading || this.data.deleting) return;
    this.setData({ sharingOpen: true, sharingError: '', shareVisibility: this.data.visibility, shareCommunityIds: this.data.communityIds.slice(), shareRepairTypes: this.data.repairTypes.slice(), shareAllowEdit: this.data.allowEdit, shareAllowDelete: this.data.allowDelete });
    if (!this.data.optionsLoaded) await this.loadOptions();
    this.syncShareChoices();
  },
  onCloseSharing() { if (!this.data.sharingSaving) this.setData({ sharingOpen: false }); },
  onNoop() {},
  onVisibility(e: WechatMiniprogram.BaseEvent) { const value = String(e.currentTarget.dataset.value); if (value === 'private' || value === 'published') this.setData({ shareVisibility: value, sharingError: '' }); },
  onToggleCommunity(e: WechatMiniprogram.BaseEvent) {
    const id = Number(e.currentTarget.dataset.id);
    if (!this.data.communities.some((c) => c.id === id)) return;
    const selected = this.data.shareCommunityIds;
    const shareCommunityIds = selected.includes(id) ? selected.filter((v) => v !== id) : [...selected, id];
    const validTypes = experienceTypes(this.data.communities.filter((c) => shareCommunityIds.includes(c.id))).map((t) => t.value);
    this.setData({ shareCommunityIds, shareRepairTypes: this.data.shareRepairTypes.filter((t) => validTypes.includes(t)), sharingError: '' }); this.syncShareChoices();
  },
  onToggleType(e: WechatMiniprogram.BaseEvent) {
    const value = String(e.currentTarget.dataset.value);
    if (!this.data.shareTypes.some((t) => t.value === value)) return;
    const selected = this.data.shareRepairTypes;
    this.setData({ shareRepairTypes: selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value] }); this.syncShareChoices();
  },
  onAllTypes() { this.setData({ shareRepairTypes: [] }); this.syncShareChoices(); },
  onSharingSwitch(e: WechatMiniprogram.CustomEvent) { const field = e.currentTarget.dataset.field; if (field === 'allowEdit') this.setData({ shareAllowEdit: Boolean((e.detail as any).value) }); if (field === 'allowDelete') this.setData({ shareAllowDelete: Boolean((e.detail as any).value) }); },
  async onSaveSharing() {
    if (!this.data.canManage || !this.data.noteId || !this.data.sharingOpen || this.data.sharingSaving || this.data.saving || this.data.uploading) return;
    if (this.data.hasLegacyTable || this.data.blocks.some((block) => block.type !== 'document' && /<table\b/i.test(block.html || ''))) {
      this.setData({ sharingError: '旧版表格格式需先转换为文档；为避免丢表，暂不修改分享。' }); return;
    }
    if (this.data.dirty) { this.setData({ sharingError: '请先保存正文，再修改分享设置' }); return; }
    const visibility = this.data.shareVisibility;
    if (visibility === 'legacy') { this.setData({ sharingError: '请选择仅我可见或发布到小区；历史公开图片需先替换为安全附件' }); return; }
    if (visibility === 'published' && (!this.data.optionsLoaded || !this.data.shareCommunityIds.length)) { this.setData({ sharingError: '请选择至少一个小区' }); return; }
    const version = this.editVersion;
    const payload: SaveRepairExperienceNoteReq = { title: this.savedTitle, blocks: this.data.blocks, revision: this.data.revision,
      visibility, communityIds: visibility === 'published' ? this.data.shareCommunityIds.slice() : [], repairTypes: visibility === 'published' ? this.data.shareRepairTypes.slice() : [],
      allowEdit: visibility === 'published' && this.data.shareAllowEdit, allowDelete: visibility === 'published' && this.data.shareAllowDelete };
    this.setData({ sharingSaving: true, sharingError: '' });
    try {
      const note = await repairExperiences.update(this.data.noteId, payload);
      if (this.destroyed) return;
      this.applyNote(note, version !== this.editVersion); this.setData({ sharingOpen: false });
      wx.showToast({ icon: 'success', title: visibility === 'private' ? '已设为仅我可见' : '分享设置已保存' });
    } catch (e: any) { if (!this.destroyed) this.setData({ sharingError: experienceError(e, '分享设置保存失败') }); }
    finally { if (!this.destroyed) this.setData({ sharingSaving: false }); }
  },
  async onDelete() {
    if (!this.data.canDelete || !this.data.noteId || this.data.deleting || this.data.saving || this.data.uploading || this.data.sharingSaving) return;
    this.setData({ deleting: true });
    try {
      const result = await wx.showModal({ title: '删除这篇经验？', content: '删除后成员无法再查看。此操作不可恢复。', showCancel: true, confirmText: '删除', confirmColor: '#c13e45' });
      if (!result.confirm || this.destroyed) return;
      await repairExperiences.remove(this.data.noteId, this.data.revision);
      if (this.destroyed) return;
      this.setData({ dirty: false }); wx.disableAlertBeforeUnload?.(); wx.navigateBack();
    } catch (e: any) { if (!this.destroyed) this.setData({ error: experienceError(e, '删除失败，请刷新后重试') }); }
    finally { if (!this.destroyed) this.setData({ deleting: false }); }
  },
});
