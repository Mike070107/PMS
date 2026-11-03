/** 仅使用当前有效票据的官方微信入口；刷新期间不能继续打开旧票据。 */
export function wechatLaunchHref(scheme: string | null, status: string, loading: boolean, expiresAt: number, now = Date.now()): string | undefined {
  if (loading || !['pending', 'scanned'].includes(status) || now >= expiresAt) return undefined;
  return scheme && /^weixin:\/\/dl\/business\/\?t=[A-Za-z0-9_-]+$/.test(scheme) ? scheme : undefined;
}
