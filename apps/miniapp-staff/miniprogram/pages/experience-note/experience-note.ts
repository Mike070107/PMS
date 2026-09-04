import { repairExperiences, upload } from '@pms/api-client';
import { createHoldToTalk, speechErrorTip, type HoldToTalk } from '@pms/miniapp-ui';
import type { RepairExperienceBlock, RepairExperienceBlockType } from '@pms/shared-types';

let speechManager: any = null;
try { speechManager = requirePlugin('WechatSI').getRecordRecognitionManager(); } catch { speechManager = null; }
let hold: HoldToTalk | null = null;

const textTypes: RepairExperienceBlockType[] = ['paragraph', 'heading', 'bullet', 'warning'];
const newId = () => `b-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
const newTextBlock = (type: RepairExperienceBlockType = 'paragraph'): RepairExperienceBlock => ({ id: newId(), type, text: '' });

Page({
  data: {
    noteId: 0,
    officeId: 0,
    officeName: '',
    repairType: '',
    repairTypeLabel: '',
    title: '',
    blocks: [] as RepairExperienceBlock[],
    revision: 1,
    canEdit: false,
    favorite: false,
    editing: false,
    saving: false,
    hasSpeech: false,
    recording: false,
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
        revision: note.revision,
        canEdit: note.canEdit,
        favorite: note.favorite,
      });
    } catch (e: any) { wx.showToast({ icon: 'none', title: e?.message || '加载失败' }); }
  },

  bindSpeech() {
    if (!speechManager) return;
    hold = createHoldToTalk(speechManager);
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
  onTitleInput(e: WechatMiniprogram.Input) { this.setData({ title: e.detail.value }); },
  onTextInput(e: WechatMiniprogram.Input) {
    const index = Number(e.currentTarget.dataset.index);
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

  onEdit() { if (this.data.canEdit) this.setData({ editing: true }); },
  onAddBlock(e: WechatMiniprogram.BaseEvent) {
    const type = String(e.currentTarget.dataset.type) as RepairExperienceBlockType;
    this.setData({ blocks: [...this.data.blocks, newTextBlock(textTypes.includes(type) ? type : 'paragraph')] });
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
    const blocks = this.data.blocks.filter((block) => block.type === 'image' ? !!block.url : !!block.text?.trim());
    if (!title) { wx.showToast({ icon: 'none', title: '请填写笔记标题' }); return; }
    if (!blocks.length) { wx.showToast({ icon: 'none', title: '请至少写一段内容' }); return; }
    this.setData({ saving: true });
    try {
      const payload = { officeId: this.data.officeId, repairType: this.data.repairType, title, blocks, revision: this.data.revision };
      const note = this.data.noteId
        ? await repairExperiences.update(this.data.noteId, payload)
        : await repairExperiences.create(payload);
      this.setData({ noteId: note.id, revision: note.revision, blocks: note.blocks, editing: false, canEdit: note.canEdit });
      wx.showToast({ icon: 'success', title: '已保存' });
    } catch (e: any) { wx.showModal({ title: '保存失败', content: e?.message || '请稍后重试', showCancel: false }); }
    finally { this.setData({ saving: false }); }
  },
});
