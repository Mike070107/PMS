const { isVideoUrl } = require('@pms/shared-types');
Component({
  data: { playingUrl: '' },
  properties: {
    urls: { type: Array, value: [] },
    posters: { type: Object, value: {} },
    editable: Boolean,
    disabled: Boolean,
  },
  observers: {
    'urls, posters'(urls, posters) {
      this.setData({ items: (urls || []).map(url => ({
        url, type: isVideoUrl(url) ? 'video' : 'image', poster: (posters || {})[url] || '',
      })) });
    },
  },
  methods: {
    preview(e) {
      const current = Number(e.currentTarget.dataset.index);
      const item = this.data.items[current];
      if (!item) return;
      if (item.type === 'video') {
        this.setData({ playingUrl: item.url }, () => {
          const player = wx.createVideoContext('gallery-player', this);
          player.requestFullScreen();
          player.play();
        });
        return;
      }
      const photos = this.data.items.filter(entry => entry.type === 'image');
      wx.previewMedia({ current: photos.indexOf(item), sources: photos.map(({url, type}) => ({url, type})) });
    },
    fullscreenChanged(event) {
      if (!event.detail.fullScreen) this.closeVideo();
    },
    closeVideo() {
      this.setData({ playingUrl: '' });
    },
    playbackFailed() {
      this.closeVideo();
      wx.showToast({ title: '视频加载失败，请重试', icon: 'none' });
    },
    remove(e) {
      if (this.data.editable && !this.data.disabled) this.triggerEvent('remove', { index: Number(e.currentTarget.dataset.index) });
    },
  },
});
