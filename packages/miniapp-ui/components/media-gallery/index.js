const { isVideoUrl } = require('@pms/shared-types');
Component({
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
      if (this.data.items[current]) wx.previewMedia({ current, sources: this.data.items.map(({url,type}) => ({url,type})) });
    },
    remove(e) {
      if (this.data.editable && !this.data.disabled) this.triggerEvent('remove', { index: Number(e.currentTarget.dataset.index) });
    },
  },
});
