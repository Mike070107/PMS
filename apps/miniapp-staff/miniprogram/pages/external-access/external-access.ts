import { clearSession } from '../../utils/session';
import { clearAccessCache } from '../../utils/tabbar';

/**
 * 仅有内网应用权限的用户借用小程序做微信确认，不应落入 PMS 员工工作台。
 * 这里刻意不提供“更多应用”或工单入口；真正的入口始终是浏览器中的内网应用域名。
 */
Page({
  data: { closeHint: '' },

  onClose() {
    const hint = '请点右上角“…”关闭小程序。';
    if (typeof wx.exitMiniProgram !== 'function') {
      this.setData({ closeHint: hint });
      return;
    }
    wx.exitMiniProgram({ fail: () => this.setData({ closeHint: hint }) });
  },

  async onLogout() {
    const result = await wx.showModal({ title: '退出授权账号', content: '退出后，下次扫码需要重新验证身份。' });
    if (!result.confirm) return;
    getApp<{ clearTokens: () => void }>().clearTokens();
    clearAccessCache();
    clearSession();
    wx.reLaunch({ url: '/pages/login/login' });
  },
});
