import { feedback, upload } from '@pms/api-client';

const MAX_IMAGES = 4;
const MAX_VIDEO_SECONDS = 15;

function videoDuration(path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    wx.getVideoInfo({
      src: path,
      success: (result) => resolve(Number(result.duration) || 0),
      fail: reject,
    });
  });
}

Page({
  data: {
    content: '',
    imageUrls: [] as string[],
    videoUrl: '',
    videoDurationSeconds: 0,
    uploadingImages: false,
    uploadingVideo: false,
    saving: false,
    errorMsg: '',
  },

  onContent(e: WechatMiniprogram.Input) {
    this.setData({ content: e.detail.value, errorMsg: '' });
  },

  async onChooseImages() {
    const remaining = MAX_IMAGES - this.data.imageUrls.length;
    if (remaining <= 0 || this.data.uploadingImages || this.data.saving) return;
    const result = await wx.chooseMedia({
      count: remaining,
      mediaType: ['image'],
      sourceType: ['camera', 'album'],
      sizeType: ['compressed'],
    }).catch(() => null);
    if (!result?.tempFiles?.length) return;
    this.setData({ uploadingImages: true, errorMsg: '' });
    wx.showLoading({ title: '上传图片中…', mask: true });
    try {
      const uploaded = await upload.uploadTempFiles(
        result.tempFiles.slice(0, remaining).map((item) => item.tempFilePath),
      );
      this.setData({
        imageUrls: [...this.data.imageUrls, ...uploaded.map((item) => item.publicUrl)].slice(0, MAX_IMAGES),
      });
    } catch (e: any) {
      this.setData({ errorMsg: e?.message || '图片上传失败，请重试' });
    } finally {
      wx.hideLoading();
      this.setData({ uploadingImages: false });
    }
  },

  onPreviewImage(e: WechatMiniprogram.BaseEvent) {
    const current = String(e.currentTarget.dataset.url || '');
    if (current) wx.previewImage({ current, urls: this.data.imageUrls });
  },

  onRemoveImage(e: WechatMiniprogram.BaseEvent) {
    if (this.data.saving) return;
    const next = this.data.imageUrls.slice();
    next.splice(Number(e.currentTarget.dataset.index), 1);
    this.setData({ imageUrls: next });
  },

  async onChooseVideo() {
    if (this.data.videoUrl || this.data.uploadingVideo || this.data.saving) return;
    const result = await wx.chooseMedia({
      count: 1,
      mediaType: ['video'],
      sourceType: ['camera', 'album'],
      maxDuration: MAX_VIDEO_SECONDS,
      camera: 'back',
    }).catch(() => null);
    const file = result?.tempFiles?.[0];
    if (!file) return;
    let duration = 0;
    try {
      // 相册能选到超过 maxDuration 的旧视频，必须读文件真实时长再拦一次。
      duration = await videoDuration(file.tempFilePath);
    } catch {
      return this.setData({ errorMsg: '无法读取视频时长，请重新选择' });
    }
    if (!duration || duration > MAX_VIDEO_SECONDS + 0.05) {
      return this.setData({ errorMsg: `视频不能超过${MAX_VIDEO_SECONDS}秒` });
    }
    this.setData({ uploadingVideo: true, errorMsg: '' });
    wx.showLoading({ title: '上传视频中…', mask: true });
    try {
      const uploaded = await upload.uploadTempFile(file.tempFilePath);
      this.setData({
        videoUrl: uploaded.publicUrl,
        videoDurationSeconds: Math.max(1, Math.ceil(duration)),
      });
    } catch (e: any) {
      this.setData({ errorMsg: e?.message || '视频上传失败，请重试' });
    } finally {
      wx.hideLoading();
      this.setData({ uploadingVideo: false });
    }
  },

  onRemoveVideo() {
    if (this.data.saving) return;
    this.setData({ videoUrl: '', videoDurationSeconds: 0 });
  },

  async onSubmit() {
    const content = this.data.content.trim();
    if (!content) return this.setData({ errorMsg: '请填写你的意见或建议' });
    if (this.data.uploadingImages || this.data.uploadingVideo || this.data.saving) return;
    this.setData({ saving: true, errorMsg: '' });
    try {
      await feedback.submit({
        content,
        imageUrls: this.data.imageUrls,
        ...(this.data.videoUrl
          ? {
              videoUrl: this.data.videoUrl,
              videoDurationSeconds: this.data.videoDurationSeconds,
            }
          : {}),
      });
      await wx.showModal({
        title: '提交成功',
        content: '感谢你的意见，我们会认真查看。',
        showCancel: false,
        confirmText: '知道了',
      });
      wx.navigateBack();
    } catch (e: any) {
      this.setData({ errorMsg: e?.message || '提交失败，请稍后重试' });
    } finally {
      this.setData({ saving: false });
    }
  },
});
