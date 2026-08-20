/**
 * 小程序内扫码取 token。
 *
 * 楼栋码现在是「小程序码」，微信扫到自家小程序码时不会把内容放进 result，
 * 而是给一个 path（如 `pages/repair-create/repair-create?scene=abc123`），
 * token 藏在 scene 里。旧的普通二维码则是一条 `https://.../qr/<token>` 链接。
 * 两种都要能认，否则换码期间已贴出去的旧码会失效。
 */
export function tokenFromScanResult(res: { result?: string; path?: string }): string {
  if (res.path) {
    const matched = res.path.match(/[?&]scene=([^&]+)/);
    if (matched) return safeDecode(matched[1]);
  }
  const raw = (res.result || '').trim();
  const inUrl = raw.match(/\/qr\/([A-Za-z0-9_-]{6,32})/);
  if (inUrl) return inUrl[1];
  const inScene = raw.match(/[?&]scene=([^&]+)/);
  if (inScene) return safeDecode(inScene[1]);
  return raw;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** 拉起扫码并取出 token；用户取消返回 null */
export async function scanForToken(): Promise<string | null> {
  try {
    const res = await wx.scanCode({ scanType: ['qrCode'] });
    const token = tokenFromScanResult(res as { result?: string; path?: string });
    return token || null;
  } catch {
    return null; // 用户取消扫码
  }
}
