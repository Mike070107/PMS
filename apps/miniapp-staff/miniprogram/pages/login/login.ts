import { auth } from '@pms/api-client';
import type { StaffLoginReq } from '@pms/shared-types';

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
  data: {
    checking: true,        // 进页面先尝试静默登录
    loading: false,        // 手机号登录中
    accountMode: false,    // 是否展开账号密码登录
    account: '',
    password: '',
    accountErr: '',
    passwordErr: '',
    errorMsg: '',          // 行内错误（绑定冲突/未开通等）
  },

  onLoad() {
    this.silentLogin();
  },

  /** 已绑定过微信的员工：只用 wx.login 的 code 直接进 */
  async silentLogin() {
    try {
      const { code } = await wx.login();
      const resp = await auth.staffLogin({ code });
      this.enter(resp.accessToken, resp.refreshToken);
    } catch {
      // 未绑定 / 已停用：停留在登录页，走手机号或账号密码验证
      this.setData({ checking: false });
    }
  },

  /** 微信手机号一键登录（首次绑定） */
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
    this.setData({ accountMode: !this.data.accountMode, errorMsg: '' });
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
    this.setData({ loading: true, errorMsg: '' });
    try {
      const { code } = await wx.login();
      const resp = await auth.staffLogin({ code, ...extra });
      this.enter(resp.accessToken, resp.refreshToken);
    } catch (err: any) {
      this.setData({ errorMsg: err?.message || '登录失败，请稍后重试' });
    } finally {
      this.setData({ loading: false });
    }
  },

  enter(accessToken: string, refreshToken: string) {
    getApp<StaffApp>().setTokens(accessToken, refreshToken);
    wx.switchTab({ url: '/pages/pool/pool' });
  },
});
