import { configure, request } from '@pms/api-client';
import { setupAutoUpdate } from '@pms/miniapp-ui';

const TOKEN_KEY = 'pms.staff.access_token';
const LOGIN_PAGE = 'pages/login/login';
/** 上次踢回登录页的时刻，防止 401 连发时反复 reLaunch */
let lastKickAt = 0;
const REFRESH_KEY = 'pms.staff.refresh_token';
let lastError = '';
let lastErrorAt = 0;

interface AppData {
  baseURL: string;
  getToken(): string | undefined;
  setTokens(access: string, refresh: string): void;
  clearTokens(): void;
}

App<AppData>({
  baseURL: 'https://prsznh.cn/api/v1',
  getToken() {
    try { return wx.getStorageSync(TOKEN_KEY) || undefined; } catch { return undefined; }
  },
  setTokens(access, refresh) {
    wx.setStorageSync(TOKEN_KEY, access);
    wx.setStorageSync(REFRESH_KEY, refresh);
  },
  clearTokens() {
    wx.removeStorageSync(TOKEN_KEY);
    wx.removeStorageSync(REFRESH_KEY);
  },
  onLaunch() {
    // 冷启动就把新包应用上，否则「关掉重开」看到的还是旧界面（见 setupAutoUpdate 注释）
    setupAutoUpdate();
    configure({
      baseURL: this.baseURL,
      getToken: () => this.getToken(),
      getExtraHeaders: () => ({ 'x-client-source': 'miniapp-staff' }),
      /**
       * 登录态失效时踢回登录页。**必须防重入**：
       * 已经在登录页时再 reLaunch 一次，会把登录页重建、它 onLoad 又发请求、
       * 再 401 再 reLaunch …… 页面永远重建不完，表现就是「卡在登录页一片白」。
       * 所以：已经在登录页就只清 token，不再跳；两次跳转之间也留 1 秒冷却。
       */
      onUnauthorized: () => {
        this.clearTokens();
        const pages = getCurrentPages();
        const current = pages.length ? pages[pages.length - 1].route : '';
        if (current === LOGIN_PAGE) return;
        const now = Date.now();
        if (now - lastKickAt < 1000) return;
        lastKickAt = now;
        wx.reLaunch({ url: `/${LOGIN_PAGE}` });
      },
    });
  },
  onError(error) {
    reportError(this.getToken(), error);
  },
  onUnhandledRejection(event) {
    const reason = event.reason as any;
    reportError(this.getToken(), reason?.message || String(reason || '未处理的异步异常'), reason?.stack);
  },
});

function reportError(token: string | undefined, message: string, stack?: string) {
  const fingerprint = `${message}\n${stack || ''}`.slice(0, 800);
  const now = Date.now();
  if (!token || (lastError === fingerprint && now - lastErrorAt < 60_000)) return;
  lastError = fingerprint;
  lastErrorAt = now;
  const pages = getCurrentPages();
  void request({ method: 'POST', url: '/observability/client-errors', data: {
    source: 'miniapp-staff', message: String(message || '小程序异常').slice(0, 500),
    stack: String(stack || '').slice(0, 4000), route: pages[pages.length - 1]?.route || '',
  } }).catch(() => undefined);
}
