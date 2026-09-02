import { configure, request } from '@pms/api-client';
import { setupAutoUpdate } from '@pms/miniapp-ui';

const TOKEN_KEY = 'pms.access_token';
const REFRESH_KEY = 'pms.refresh_token';
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
      getExtraHeaders: () => ({ 'x-client-source': 'miniapp-owner' }),
      onUnauthorized: () => {
        this.clearTokens();
        wx.reLaunch({ url: '/pages/index/index' });
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
    source: 'miniapp-owner', message: String(message || '小程序异常').slice(0, 500),
    stack: String(stack || '').slice(0, 4000), route: pages[pages.length - 1]?.route || '',
  } }).catch(() => undefined);
}
