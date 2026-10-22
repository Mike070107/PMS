/**
 * 未迁移页面的跳转前缀。
 *
 * 生产上线后旧后台在站点根路径（/fees、/inventory…），测试环境把它挂在
 * /beta-legacy/ 下——用 VITE_LEGACY_BASE 区分，避免测试环境一点就跳回生产界面。
 */
export const LEGACY_BASE = (import.meta.env.VITE_LEGACY_BASE || '').replace(/\/$/, '');

export function legacyUrl(path: string): string {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return `${LEGACY_BASE}${normalized}`;
}
