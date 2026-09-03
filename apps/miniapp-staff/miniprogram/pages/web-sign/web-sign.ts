Page({
  data: { url: '' },
  onLoad(query: Record<string, string>) {
    const url = decodeURIComponent(query.url || '');
    if (!/^https:\/\//i.test(url)) {
      wx.showModal({ title: '链接无效', content: '无法打开养护单，请返回重试', showCancel: false });
      return;
    }
    this.setData({ url });
  },
});
