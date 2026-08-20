import { configure } from '@pms/api-client';

const TOKEN_KEY = 'pms.staff.access_token';
const REFRESH_KEY = 'pms.staff.refresh_token';

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
    configure({
      baseURL: this.baseURL,
      getToken: () => this.getToken(),
      onUnauthorized: () => {
        this.clearTokens();
        wx.reLaunch({ url: '/pages/login/login' });
      },
    });
  },
});
