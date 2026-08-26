import { ApiError, auth } from '@pms/api-client';
import type { QrLoginScanInfo } from '@pms/api-client/src/endpoints/auth';

/**
 * 后台网页的扫码登录确认页。
 *
 * 微信扫小程序码进来 → 这里显示「谁在哪台机器上要登录」→ 本人点确认，
 * 网页那边才拿得到 token。扫码本身不等于登录，确认动作必须是本人再点一次。
 *
 * 票据一进来就先存下（PENDING_KEY），而不是只在「没登录」时才存：
 * 员工端的 access token 只有 2 小时，隔天再扫时本地明明有 token 却已失效，
 * 第一个请求一打 401 就被 app.ts 踢回登录页 —— 那时 scene 已经丢了，
 * 静默登录完只能落到首页，人就得回电脑再扫一次（2026-08-26 实际反馈：
 * 「扫第一次是进小程序，第二次才出确认」）。存着票据，login.ts 登录成功后
 * 会把人送回这一页；票据核对成功或确定作废后再清掉。
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
    savePending(scene);

    let token = '';
    try { token = wx.getStorageSync(TOKEN_KEY) || ''; } catch { token = ''; }
    // 没 token、或 token 已经到期：直接去登录，别先打一个注定 401 的请求再被踢过去
    if (!token || isJwtExpired(token)) {
      wx.reLaunch({ url: '/pages/login/login' });
      return;
    }
    this.load(scene);
  },

  async load(ticket: string) {
    try {
      const info = await auth.qrLoginScan(ticket);
      clearPending();
      this.setData({
        loading: false,
        info,
        deviceText: describeUserAgent(info.userAgent),
        timeText: formatTime(info.requestedAt),
      });
    } catch (e: any) {
      // 401：app.ts 正在把人踢回登录页，票据留着给 login.ts 送回来用；
      // 其它错误（过期、无效）票据已经没用了，清掉免得下次登录又被送到一张废码上
      const unauthorized = e instanceof ApiError && (e.httpStatus === 401 || e.code === 401);
      if (!unauthorized) clearPending();
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

/** 带上时间戳：login.ts 只认最近几分钟内的票据，别把人送到一张早就过期的码上 */
function savePending(scene: string) {
  try {
    wx.setStorageSync(PENDING_KEY, JSON.stringify({ scene, at: Date.now() }));
  } catch { /* 存不下就只能重扫 */ }
}

function clearPending() {
  try { wx.removeStorageSync(PENDING_KEY); } catch { /* 清不掉不影响本次流程 */ }
}

/**
 * 只看 exp，不校验签名（签名是后端的事）。解不出来就当没过期，交给请求去试。
 * 留 5 秒余量：差几秒到期的 token 发出去也是 401。
 */
function isJwtExpired(token: string): boolean {
  try {
    const part = token.split('.')[1] || '';
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (part.length % 4)) % 4);
    const bytes = new Uint8Array(wx.base64ToArrayBuffer(b64));
    let json = '';
    for (let i = 0; i < bytes.length; i += 1) json += String.fromCharCode(bytes[i]);
    const exp = Number(JSON.parse(json).exp);
    return Number.isFinite(exp) && exp * 1000 < Date.now() + 5000;
  } catch {
    return false;
  }
}

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
