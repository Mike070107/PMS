import { configure } from '@pms/api-client';
import { setupAutoUpdate } from '@pms/miniapp-ui';

const TOKEN_KEY = 'pms.access_token';
const REFRESH_KEY = 'pms.refresh_token';

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
      onUnauthorized: () => {
        this.clearTokens();
        wx.reLaunch({ url: '/pages/index/index' });
      },
    });
  },
});
