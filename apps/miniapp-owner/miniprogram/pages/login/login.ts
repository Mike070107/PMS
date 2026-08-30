/**
 * 员工端首页路径的兜底页 —— 本身不显示任何内容，只负责把人送到业主端首页。
 *
 * 和 apps/miniapp-staff/miniprogram/pages/index/index.ts 是对称的一对：
 * 2026-08-30 两端 AppID 互换后，这个小程序（原员工端 wx8ef4de0e498064c4）跑的是业主端代码，
 * 而老员工手机里存着的入口、以前发出去的体验版二维码，带的都是员工端的
 * `pages/login/login` —— 业主端没有这个页面，微信一律回「页面不存在」。
 *
 * 两端换回各自的 AppID 之后，这个页连同 app.json 里的那行注册可以一起删掉。
 */
Page({
  onLoad() {
    wx.reLaunch({ url: '/pages/index/index' });
  },
});
