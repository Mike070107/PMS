/** 完工小结是维修工个人输入偏好，不改变租户AI配置；共享手机也不能串账号。 */
export function completionSummaryPreferenceKey(user: { tenantId: number | null; id: number } | null): string {
  return user?.tenantId && user.id ? `pms.staff.completion-auto-summary.${user.tenantId}.${user.id}` : '';
}

/** 首次/无身份/存储不可读均关闭：优先保留维修工原意。 */
export function readCompletionSummaryPreference(key: string): boolean {
  if (!key) return false;
  try { return wx.getStorageSync(key) === '1'; } catch { return false; }
}

export function writeCompletionSummaryPreference(key: string, enabled: boolean): boolean {
  if (!key) return false;
  try { wx.setStorageSync(key, enabled ? '1' : '0'); return true; } catch { return false; }
}

/** 不修剪已有人工文字或标点，只把本次识别原文接在后面。 */
export function appendCompletionOriginal(before: string, spoken: string): string {
  return before && spoken ? `${before}；${spoken}` : before || spoken;
}
