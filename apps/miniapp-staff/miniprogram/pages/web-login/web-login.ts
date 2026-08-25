import { auth } from '@pms/api-client';
import type { QrLoginScanInfo } from '@pms/api-client/src/endpoints/auth';

/**
 * 后台网页的扫码登录确认页。
 *
 * 微信扫小程序码进来 → 这里显示「谁在哪台机器上要登录」→ 本人点确认，
 * 网页那边才拿得到 token。扫码本身不等于登录，确认动作必须是本人再点一次。
 *
 * 没登录时不能直接把人踢走了事：scene 丢了，登录完就回不来这一步了。
 * 所以先把票据存下来，登录成功后由 login.ts 送回这一页（见 PENDING_KEY）。
 */
const PENDING_KEY = 'pms.staff.pending_qr';
const TOKEN_KEY = 'pms.staff.access_token';

Page({
  data: {
    ticket: '',
    loading: true,
    /** 加载失败/过期的原因，直接展示 */
    errorMsg: '',
    submitting: false,
    done: '' as '' | 'confirmed' | 'cancelled',
    info: null as QrLoginScanInfo | null,
    /** 浏览器 UA 太长，页面上只显示认得出的那部分 */
    deviceText: '',
    timeText: '',
  },

  onLoad(q: Record<string, string>) {
    // 小程序码的 scene 会被 URL 编码一次
    const scene = decodeURIComponent(q.scene || q.ticket || '');
    if (!scene) {
      this.setData({ loading: false, errorMsg: '没有拿到二维码信息，请在网页上刷新一张再扫' });
      return;
    }
    this.setData({ ticket: scene });

    let token = '';
    try { token = wx.getStorageSync(TOKEN_KEY) || ''; } catch { token = ''; }
    if (!token) {
      // 先记下票据再去登录，登录成功后 login.ts 会把人送回来
      try { wx.setStorageSync(PENDING_KEY, scene); } catch { /* 存不下就只能重扫 */ }
      wx.reLaunch({ url: '/pages/login/login' });
      return;
    }
    this.load(scene);
  },

  async load(ticket: string) {
    try {
      const info = await auth.qrLoginScan(ticket);
      this.setData({
        loading: false,
        info,
        deviceText: describeUserAgent(info.userAgent),
        timeText: formatTime(info.requestedAt),
      });
    } catch (e: any) {
      this.setData({ loading: false, errorMsg: e?.message || '二维码已失效，请在网页上刷新一张' });
    }
  },

  async onConfirm() {
    if (this.data.submitting) return;
    this.setData({ submitting: true });
    try {
      await auth.qrLoginConfirm(this.data.ticket);
      this.setData({ done: 'confirmed' });
    } catch (e: any) {
      // 没绑后台角色的人（维修工、保安等）在这里就要看到原因，
      // 不能让他点完确认、网页那边报一句他根本看不见的错
      this.setData({ errorMsg: e?.message || '确认失败，请重试' });
    } finally {
      this.setData({ submitting: false });
    }
  },

  async onCancel() {
    if (this.data.submitting) return;
    this.setData({ submitting: true });
    try {
      await auth.qrLoginCancel(this.data.ticket);
      this.setData({ done: 'cancelled' });
    } catch (e: any) {
      this.setData({ errorMsg: e?.message || '操作失败，请重试' });
    } finally {
      this.setData({ submitting: false });
    }
  },

  onBackHome() {
    wx.switchTab({ url: '/pages/me/me' });
  },
});

/** Chrome/135 → 「Chrome 浏览器 · Windows」，认不出就原样截一段 */
function describeUserAgent(ua: string | null): string {
  if (!ua) return '未知设备';
  const browser =
    /Edg\//.test(ua) ? 'Edge 浏览器'
    : /Chrome\//.test(ua) ? 'Chrome 浏览器'
    : /Safari\//.test(ua) ? 'Safari 浏览器'
    : /Firefox\//.test(ua) ? 'Firefox 浏览器'
    : '';
  const os =
    /Windows/.test(ua) ? 'Windows'
    : /Macintosh|Mac OS/.test(ua) ? 'Mac'
    : /Android/.test(ua) ? 'Android'
    : /iPhone|iPad/.test(ua) ? 'iOS'
    : /Linux/.test(ua) ? 'Linux'
    : '';
  if (browser || os) return [browser, os].filter(Boolean).join(' · ');
  return ua.slice(0, 40);
}

/** 标准 ISO 直接交给 Date：先 replace(/-/g,'/') 会把带 T 的串弄成 Invalid Date */
function formatTime(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
