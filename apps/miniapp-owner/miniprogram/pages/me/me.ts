import { auth } from '@pms/api-client';
import { refreshUnreadBadge } from '../../utils/unread';
import { maskPhone } from '@pms/miniapp-ui';
import { buildStampText } from '../../utils/buildStamp';
import { AuditStatus, type MeResp } from '@pms/shared-types';
import { openFeedback } from '../../utils/feedback';

// 版本号和 git hash 由发版脚本写入 utils/buildStamp.ts，别在这里手改（见那个文件的说明）

const AUDIT_TEXT: Record<string, string> = {
  [AuditStatus.PENDING]: '审核中',
  [AuditStatus.APPROVED]: '已认证',
  [AuditStatus.REJECTED]: '未通过',
};

Page({
  data: {
    buildText: '',
    user: null as MeResp | null,
    phoneText: '',
    placeText: '',
    auditText: '',
    rejectReason: '',
    needOnboard: false,
    /** 没有微信头像授权，用姓名首字当头像 */
    avatarText: '业',
    unread: 0,
  },

  /** 显示当前跑的是哪个包：改完重新上传后，忘记「选为体验版本」一眼就能看出来 */
  showBuild() {
    try {
      const info = wx.getAccountInfoSync().miniProgram;
      const envText =
        { develop: '开发版', trial: '体验版', release: '正式版' }[info.envVersion] ||
        info.envVersion;
      this.setData({
        buildText: [envText, info.version || buildStampText()].filter(Boolean).join(' '),
      });
    } catch {
      this.setData({ buildText: '' });
    }
  },

  onShow() {
    this.showBuild();
    this.load();
    // 每次回到这一页都重拉一次未读：小程序没有推送到端的长连接，红点只能主动拉
    refreshUnreadBadge().then((unread) => this.setData({ unread }));
  },

  async load() {
    if (!wx.getStorageSync('pms.access_token')) {
      this.setData({ user: null });
      return;
    }
    try {
      const user = await auth.me();
      const place = user.place ?? null;
      this.setData({
        user,
        avatarText: (user.name || '').trim().charAt(0) || '业',
        phoneText: maskPhone(user.phone),
        placeText: place?.addressText || '',
        auditText: place ? AUDIT_TEXT[place.auditStatus] || '' : '',
        rejectReason: place?.rejectReason || '',
        needOnboard: !place || place.auditStatus === AuditStatus.REJECTED,
      });
    } catch (e: any) {
      wx.showToast({ icon: 'none', title: e?.message || '加载失败' });
    }
  },

  onTapMessages() {
    wx.navigateTo({ url: '/pages/messages/messages' });
  },

  onTapOrders() {
    wx.switchTab({ url: '/pages/orders/orders' });
  },

  /** 联系方式由物业配置，这里只解释「怎么找到人」，不回显任何个人号码 */
  onTapContact() {
    wx.showModal({
      title: '联系物业',
      content: '工单有疑问，可以在报修详情页点「催一下」，物业会收到提醒；也可以到小区物业服务中心当面沟通。',
      showCancel: false,
      confirmText: '知道了',
    });
  },

  onFeedback() {
    void openFeedback();
  },

  onTapOnboard() {
    wx.navigateTo({ url: '/pages/onboard/onboard' });
  },

  onTapLogin() {
    wx.switchTab({ url: '/pages/index/index' });
  },

  async onLogout() {
    const res = await wx.showModal({ title: '退出登录', content: '退出后需要重新微信登录' });
    if (!res.confirm) return;
    getApp<{ clearTokens: () => void }>().clearTokens();
    wx.reLaunch({ url: '/pages/index/index' });
  },
});
