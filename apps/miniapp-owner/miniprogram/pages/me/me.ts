import { auth } from '@pms/api-client';
import { refreshUnreadBadge } from '../../utils/unread';
import { maskPhone } from '@pms/miniapp-ui';
import { buildStampText } from '../../utils/buildStamp';
import { AuditStatus, type MeResp } from '@pms/shared-types';
import { openFeedback } from '../../utils/feedback';
import { getTestLoginCode, setTestLoginCode } from '../../utils/session';

// 版本号和 git hash 由发版脚本写入 utils/buildStamp.ts，别在这里手改（见那个文件的说明）

const AUDIT_TEXT: Record<string, string> = {
  [AuditStatus.PENDING]: '审核中',
  [AuditStatus.APPROVED]: '已认证',
  [AuditStatus.REJECTED]: '未通过',
};

/** 连点版本号几次才弹测试登录入口。藏起来是为了普通业主永远撞不到 */
const TEST_ENTRY_TAPS = 5;
let versionTaps = 0;
let versionTapAt = 0;

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

  /**
   * 隐蔽入口：连点版本号 5 次 → 填测试码，之后登录就跳过微信授权。
   *
   * 服务端 .env 里配了同一个 OWNER_TEST_LOGIN_CODE（≥24 位）才认；
   * 线上不配 = 填了也没用。真机和开发者工具都能用，不需要第二个微信号。
   */
  onTapVersion() {
    const now = Date.now();
    // 两次点击间隔超过 1.5 秒就重新计数，避免平时误触攒够次数
    versionTaps = now - versionTapAt > 1500 ? 1 : versionTaps + 1;
    versionTapAt = now;
    if (versionTaps < TEST_ENTRY_TAPS) return;
    versionTaps = 0;
    const current = getTestLoginCode();
    wx.showModal({
      title: '测试登录',
      content: current ? '已设置测试码。清空即可恢复正常微信登录。' : '填入测试码后将跳过微信授权登录',
      editable: true,
      placeholderText: '粘贴测试码，留空表示清除',
      confirmText: '保存',
      success: (res) => {
        if (!res.confirm) return;
        const code = String(res.content || '').trim();
        setTestLoginCode(code);
        wx.showModal({
          title: code ? '已设置测试码' : '已清除测试码',
          content: '需要重新登录才生效：确定后会清掉本地登录态并回到首页。',
          showCancel: false,
          success: () => {
            try { wx.clearStorageSync(); } catch { /* 清不掉也不影响下面重开 */ }
            if (code) setTestLoginCode(code);
            wx.reLaunch({ url: '/pages/index/index' });
          },
        });
      },
    });
  },
});
