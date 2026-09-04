import { auth } from '@pms/api-client';

const TOKEN_KEY = 'pms.access_token';
/**
 * 测试码：填了就用它当作 wx.login 的 code 发给服务端，跳过微信授权登录。
 *
 * 只有服务端 .env 里配了同一个 OWNER_TEST_LOGIN_CODE（且不短于 24 位）才认，
 * 线上默认不配 = 这条路径根本不存在。入口藏在「我的」页连点版本号 5 次，
 * 普通业主不会撞到。用完在同一个入口点「清除」即可。
 */
const TEST_CODE_KEY = 'pms.test_login_code';

export function getTestLoginCode(): string {
  try { return String(wx.getStorageSync(TEST_CODE_KEY) || '').trim(); } catch { return ''; }
}

export function setTestLoginCode(code: string) {
  try {
    if (code) wx.setStorageSync(TEST_CODE_KEY, code);
    else wx.removeStorageSync(TEST_CODE_KEY);
  } catch { /* 存不下就退回正常微信登录，不影响普通用户 */ }
}

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
    // 测试码存在就直接拿它当 code：真机上也能进，不用第二个微信号
    const testCode = getTestLoginCode();
    const code = testCode || (await wx.login()).code;
    const resp = await auth.loginByCode({ code, appType: 'owner' });
    getApp<OwnerApp>().setTokens(resp.accessToken, resp.refreshToken);
    return true;
  } catch (e: any) {
    wx.showToast({ icon: 'none', title: e?.message || '登录失败' });
    return false;
  }
}
