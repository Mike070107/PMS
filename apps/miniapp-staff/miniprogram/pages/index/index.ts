/**
 * 业主端首页路径的兜底页 —— 本身不显示任何内容，只负责把人送到员工登录页。
 *
 * 2026-08-30 两端 AppID 互换后，这个小程序（原业主端 wx002fde4bfaa4c7d9）跑的是员工端代码，
 * 但外面一大堆入口带的还是业主端的 `pages/index/index`：公众平台生成的体验版二维码、
 * 用户微信里「最近使用」的记录、以前分享出去的卡片。员工端没有这个页面，
 * 微信一律回「页面不存在」，人就卡在门外了 —— 2026-08-30 扫体验版码就是这么失败的。
 *
 * 用 reLaunch 而不是 redirectTo：这些入口多半是冷启动进来的，页面栈里没有别的页，
 * 而且登录页本来就该是栈底，reLaunch 顺带把栈清干净。
 *
 * 两端换回各自的 AppID 之后，这个页连同 app.json 里的那行注册可以一起删掉。
 * 对称的一份在 apps/miniapp-owner/miniprogram/pages/login/login.ts。
 */
Page({
  onLoad() {
    wx.reLaunch({ url: '/pages/login/login' });
  },
});
