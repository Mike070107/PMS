export const LOGIN_METHODS = ['password', 'wechat'] as const;
export type LoginMethod = (typeof LOGIN_METHODS)[number];

export const LOGIN_FAILURE_REASONS = [
  'invalid_credentials',
  'account_disabled',
  'no_permission',
  'invalid_wechat_ticket',
  'tenant_inactive',
  'unknown',
] as const;
export type LoginFailureReason = (typeof LOGIN_FAILURE_REASONS)[number];

export const LOGIN_REASON_TEXT: Record<LoginFailureReason, string> = {
  invalid_credentials: '账号或密码错误',
  account_disabled: '账号已停用',
  no_permission: '无后台页面权限',
  invalid_wechat_ticket: '微信登录票据无效',
  tenant_inactive: '公司已停用或到期',
  unknown: '登录失败',
};

/** 按现有日志脱敏习惯：手机保留前三后四，邮箱保留前两位与域名，其余保留首尾各两位。 */
export function maskAccount(account?: string | null): string | null {
  const value = String(account ?? '').trim();
  if (!value) return null;
  if (/^1[3-9]\d{9}$/.test(value)) return `${value.slice(0, 3)}****${value.slice(-4)}`;
  if (value.includes('@')) {
    const [local, domain] = value.split('@');
    const shown = local.length <= 2 ? `${local.slice(0, 1)}***` : `${local.slice(0, 2)}***`;
    return `${shown}@${domain}`;
  }
  if (value.length <= 2) return `${value.slice(0, 1)}***`;
  if (value.length <= 6) return `${value.slice(0, 1)}***${value.slice(-1)}`;
  return `${value.slice(0, 2)}***${value.slice(-2)}`;
}

/** 登录方式：账号密码登录为 password，二维码/OIDC/小程序登录归入 wechat。 */
export function loginMethodOfAction(action?: string | null): LoginMethod {
  const value = String(action ?? '');
  if (value === 'web_password_login') return 'password';
  return 'wechat';
}

/** 把登录失败响应映射为稳定枚举，便于撞库/未授权尝试统计。 */
export function loginFailureReasonOf(action?: string | null, message?: string | null): LoginFailureReason {
  const text = String(message ?? '');
  if (!text) return 'unknown';
  if (/不能登录网页后台|页面权限|角色管理|没有可用的页面|勾选要用的页面/.test(text)) return 'no_permission';
  if (/账号.*(停用|禁用)|account is disabled|disabled account/i.test(text)) return 'account_disabled';
  if (/公司.*(停用|到期)|tenant.*(disabled|expired)|服务已到期/i.test(text)) return 'tenant_inactive';
  if (/ticket|票据|二维码|扫码|微信/i.test(text) || ['web_qr_login', 'staff_miniapp_login', 'owner_miniapp_login'].includes(String(action ?? ''))) return 'invalid_wechat_ticket';
  if (/invalid account or password|账号或密码|密码错误/i.test(text)) return 'invalid_credentials';
  return 'unknown';
}
