import { configure, request } from '@pms/api-client';
import { flushPageTelemetry, installPageTelemetry, setupAutoUpdate } from '@pms/miniapp-ui';

const TOKEN_KEY = 'pms.access_token';
const REFRESH_KEY = 'pms.refresh_token';
let lastError = '';
let lastErrorAt = 0;

/**
 * 页面访问统计：包住全局 Page，给每个页面的 onShow 挂一次上报（页面代码零改动）。
 * 路径形如 /miniapp-owner/index；未登录不上报，批量 20 条/30 秒，切后台立即 flush。
 */
installPageTelemetry({
  source: 'miniapp-owner',
  prefix: 'miniapp-owner',
  hasToken: () => {
    try {
      return !!getApp<{ getToken(): string | undefined }>()?.getToken();
    } catch {
      return false;
    }
  },
  send: sendPageViews,
});

/**
 * 直接走 wx.request 上报页面访问，不走 api-client：
 * 401 只丢弃，不触发全局「踢回登录页」——统计不该成为用户被登出的原因。
 */
function sendPageViews(views: Array<{ path: string; source: string }>) {
  return new Promise<void>((resolve) => {
    try {
      const app = getApp<{ baseURL: string; getToken(): string | undefined }>();
      const token = app?.getToken?.();
      if (!token) return resolve();
      wx.request({
        url: `${app.baseURL}/telemetry/page-views`,
        method: 'POST',
        header: { 'content-type': 'application/json', Authorization: `Bearer ${token}`, 'x-client-source': 'miniapp-owner' },
        data: { views },
        timeout: 10000,
        complete: () => resolve(),
      });
    } catch {
      resolve();
    }
  });
}

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
  /** 切后台立即把待发的页面访问发出去，避免只停留在内存里丢掉 */
  onHide() {
    flushPageTelemetry();
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
