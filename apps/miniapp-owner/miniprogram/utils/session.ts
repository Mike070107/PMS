import { auth } from '@pms/api-client';

const TOKEN_KEY = 'pms.access_token';

interface OwnerApp {
  setTokens: (access: string, refresh: string) => void;
  clearTokens: () => void;
}

export function hasToken(): boolean {
  try {
    return !!wx.getStorageSync(TOKEN_KEY);
  } catch {
    return false;
  }
}

/**
 * 确保已登录，未登录就地静默走 wx.login。
 * 扫码直达报修页时本页就是启动页，必须自己完成登录，不能假设首页已经登过。
 */
export async function ensureOwnerLogin(): Promise<boolean> {
  if (hasToken()) return true;
  try {
    const { code } = await wx.login();
    const resp = await auth.loginByCode({ code, appType: 'owner' });
    getApp<OwnerApp>().setTokens(resp.accessToken, resp.refreshToken);
    return true;
  } catch (e: any) {
    wx.showToast({ icon: 'none', title: e?.message || '登录失败' });
    return false;
  }
}
