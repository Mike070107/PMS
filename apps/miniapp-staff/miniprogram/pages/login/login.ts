import { auth } from '@pms/api-client';
import type { StaffLoginReq } from '@pms/shared-types';
import { clearSession } from '../../utils/session';
import { clearAccessCache } from '../../utils/tabbar';
import { guideHandlers } from '../../utils/guide';

/** 扫码登录票据的暂存位：web-login 页发现没登录时写入，登录成功后由这里送回去 */
const PENDING_QR_KEY = 'pms.staff.pending_qr';
/** 「我的」页点退出时写下的一次性标记，见 onLoad */
const JUST_LOGGED_OUT_KEY = 'pms.staff.just_logged_out';

interface StaffApp {
  setTokens: (a: string, r: string) => void;
  clearTokens: () => void;
}

/** 把微信的 errMsg 翻成能照着处理的说明，同时保留原文便于排查 */
function explainPhoneFailure(detail: { errMsg?: string; encryptedData?: string }): string {
  const raw = detail.errMsg || '';
  if (detail.encryptedData) {
    return '当前微信版本过旧（未返回手机号 code），请升级微信后重试，或用账号密码登录';
  }
  if (/deny|cancel/i.test(raw)) {
    return '你取消了手机号授权，可重新点击或用账号密码登录';
  }
  if (/no permission|不具备|未认证|not verified/i.test(raw)) {
    return `小程序尚未完成企业主体认证，暂不能用微信手机号登录，请先用账号密码登录（微信原始提示：${raw}）`;
  }
  if (/privacy|隐私/i.test(raw)) {
    return `小程序后台的「用户隐私保护指引」还没声明手机号用途（微信原始提示：${raw}）`;
  }
  return raw ? `获取微信手机号失败：${raw}` : '未获取到微信手机号授权，可改用账号密码登录';
}

Page({
  onShow() { this.syncGuide(); },
  ...guideHandlers(),
  data: {
    /** 指导层：说明文字默认收起，点右上角「?」展开，见 utils/guide.ts */
    guide: false,
    checking: true,        // 进页面先尝试静默登录
    loading: false,        // 手机号登录中
    accountMode: false,    // 是否展开账号密码登录
    account: '',
    password: '',
    accountErr: '',
    passwordErr: '',
    errorMsg: '',          // 行内错误（绑定冲突/未开通等）
    noticeMsg: '',         // 中性提示（刚退出登录），别用红色的 errorMsg 说这件事
  },

  /**
   * 刚点过「退出登录」的人**不能**再走静默登录。
   *
   * 静默登录只认微信 openid，绑定关系是留在服务端的，清掉本地 token 没有任何影响 ——
   * 于是退出后一跳回这一页，onLoad 立刻又把人登了进去、switchTab 回工单池，
   * 屏幕上只闪一下，看起来就是「点了退出退不出去」（2026-08-31 反馈）。
   * 想换个手机号登录的人也因此被锁死在原账号里。
   *
   * 标记只用一次，读完就清：下次正常打开小程序仍然免登录直接进，别把免登录也弄没了。
   */
  onLoad() {
    if (takeJustLoggedOut()) {
      this.setData({
        checking: false,
        noticeMsg: '已退出登录。可以换一个手机号登录，或用账号密码登录。',
      });
      return;
    }
    this.silentLogin();
  },

  /**
   * 已绑定过微信的员工：只用 wx.login 的 code 直接进。
   *
   * 必须带超时：wx.login 或这一次请求卡住（弱网、后端不响应）时，checking 会一直是 true，
   * 页面就只剩一行灰色的「正在登录…」，看着和白屏没区别，而且没有任何出路。
   * 8 秒还没结果就先把登录方式露出来，让人能用手机号/账号密码自己登。
   */
  async silentLogin() {
    const timer = setTimeout(() => {
      if (this.data.checking) this.setData({ checking: false });
    }, 8000);
    try {
      const { code } = await wx.login();
      const resp = await auth.staffLogin({ code });
      clearTimeout(timer);
      this.enter(resp.accessToken, resp.refreshToken, resp.user && resp.user.role);
    } catch {
      // 未绑定 / 已停用：停留在登录页，走手机号或账号密码验证
      clearTimeout(timer);
      this.setData({ checking: false });
    }
  },

  /** 手机号快捷登录：微信把手机号给我们，首次登录后自动绑定本微信 */
  async onGetPhone(
    e: WechatMiniprogram.CustomEvent<{ code?: string; errMsg?: string; encryptedData?: string }>,
  ) {
    const detail = e.detail || {};
    if (!detail.code) {
      console.error('[staff-login] getPhoneNumber 未返回 code:', detail);
      this.setData({ errorMsg: explainPhoneFailure(detail) });
      return;
    }
    await this.submit({ phoneCode: detail.code });
  },

  onTapAccountMode() {
    this.setData({ accountMode: !this.data.accountMode, errorMsg: '', noticeMsg: '' });
  },

  onInputAccount(e: WechatMiniprogram.Input) {
    this.setData({ account: e.detail.value, accountErr: '', errorMsg: '' });
  },

  onInputPassword(e: WechatMiniprogram.Input) {
    this.setData({ password: e.detail.value, passwordErr: '', errorMsg: '' });
  },

  async onTapAccountLogin() {
    const account = this.data.account.trim();
    const password = this.data.password;
    this.setData({
      accountErr: account ? '' : '请输入登录账号',
      passwordErr: password.length >= 6 ? '' : '密码至少 6 位',
    });
    if (!account || password.length < 6) return;
    await this.submit({ account, password });
  },

  async submit(extra: Omit<StaffLoginReq, 'code'>) {
    if (this.data.loading) return;
    this.setData({ loading: true, errorMsg: '', noticeMsg: '' });
    try {
      const { code } = await wx.login();
      const resp = await auth.staffLogin({ code, ...extra });
      this.enter(resp.accessToken, resp.refreshToken, resp.user && resp.user.role);
    } catch (err: any) {
      this.setData({ errorMsg: err?.message || '登录失败，请稍后重试' });
    } finally {
      this.setData({ loading: false });
    }
  },

  enter(accessToken: string, refreshToken: string, role?: string) {
    getApp<StaffApp>().setTokens(accessToken, refreshToken);
    // 上一个人的权限缓存必须作废，否则换账号登录后各页还按旧身份渲染
    clearSession();
    clearAccessCache();
    // 角色先存下，tabBar 首次渲染就能按身份藏 tab，不用等 me() 回来再跳一下；
    // 权限矩阵要等首页那次 auth.me()（rememberAccess）才补齐，在那之前按身份兜底
    if (role) wx.setStorageSync('pms.staff.role', role);

    // 扫了网页登录码但当时没登录（或登录态已过期）的人：登录完必须送回确认页，
    // 否则 scene 已经丢了，只能让人回电脑重新出码再扫一遍
    const pendingQr = takePendingQr();
    if (pendingQr) {
      wx.redirectTo({ url: `/pages/web-login/web-login?scene=${encodeURIComponent(pendingQr)}` });
      return;
    }

    // 落地页统一先进工单池那一屏。只报修的人（保安、居委会…）在「工单池」那一档
    // 什么都看不到，由 pool 页拿到权限后自己把他切到「我报的」那一档 ——
    // 这里还没有 /auth/me 的结果，硬猜会猜错。
    wx.switchTab({ url: '/pages/pool/pool' });
  },
});

/** 读一次「刚退出登录」标记并清掉。存不下 / 读不到都当没退出过，最多是又静默登回去 */
function takeJustLoggedOut(): boolean {
  try {
    if (wx.getStorageSync(JUST_LOGGED_OUT_KEY) !== '1') return false;
    wx.removeStorageSync(JUST_LOGGED_OUT_KEY);
    return true;
  } catch {
    return false;
  }
}

/**
 * 取出 web-login 页暂存的票据并清掉。
 * 网页那张码只活 2 分钟，暂存超过 10 分钟的就不送了 ——
 * 否则上次扫完没登录成的人，几天后一登录会被送到一张早就作废的码上。
 * 兼容旧版直接存字符串的写法。
 */
function takePendingQr(): string {
  let raw = '';
  try { raw = wx.getStorageSync(PENDING_QR_KEY) || ''; } catch { raw = ''; }
  if (!raw) return '';
  try { wx.removeStorageSync(PENDING_QR_KEY); } catch { /* 清不掉也不该挡住跳转 */ }
  if (!raw.startsWith('{')) return raw;
  try {
    const parsed = JSON.parse(raw) as { scene?: string; at?: number };
    if (!parsed.scene) return '';
    if (parsed.at && Date.now() - parsed.at > 10 * 60 * 1000) return '';
    return parsed.scene;
  } catch {
    return '';
  }
}
