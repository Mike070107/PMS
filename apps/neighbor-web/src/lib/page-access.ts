import type { AdminAccess } from '@pms/shared-types';

/** 页面与服务端权限键的映射。新路由必须登记；未登记默认不可进入。 */
export const PAGE_ACCESS = [
  { paths: ['/today'], keys: ['dashboard'] },
  { paths: ['/cashier', '/vehicles', '/access-cards', '/parking/main', '/parking/civil', '/records', '/standards', '/devices'], keys: ['business'] },
  { paths: ['/plates'], keys: ['business', 'family-cars', 'app:approve-business-manager', 'app:approve-manager'] },
  { paths: ['/family-cars'], keys: ['family-cars', 'family-cars-approve', 'app:family-car-approve', 'app:approve-business-manager'] },
  { paths: ['/pending'], keys: ['business', 'app:approve-business-manager', 'app:approve-manager'] },
  { paths: ['/apartment', '/apartment-cashier'], keys: ['apartment-cashier'] },
  { paths: ['/meters'], keys: ['meters'] },
  // 新版收费报表调用 /fees/reports/summary，沿用费用模块权限，不是旧版统计报表。
  { paths: ['/fees', '/reports'], keys: ['fees'] },
  // 「账单与待缴」已从物业费里独立成可授权页面：只看 fees 不再自动能进 /bills。
  { paths: ['/bills'], keys: ['bills'] },
  { paths: ['/work-orders'], keys: ['work-orders'] },
  { paths: ['/maint'], keys: ['maintenance-orders', 'maintenance-inspect'] },
  { paths: ['/experience'], keys: ['experience-notes'] },
  { paths: ['/purchase', '/stock'], keys: ['inventory'] },
  { paths: ['/stocktakes'], keys: ['stocktakes'] },
  { paths: ['/materials'], keys: ['materials'] },
  { paths: ['/houses'], keys: ['properties'] },
  { paths: ['/owners'], keys: ['properties', 'owners'] },
  { paths: ['/staff'], keys: ['users', 'roles'] },
  { paths: ['/offices'], keys: ['offices'] },
  { paths: ['/qr'], keys: ['qr'] },
  { paths: ['/logs'], keys: ['logs'] },
  { paths: ['/settings', '/intranet'], keys: ['settings'] },
] as const;

export function pageForPath(pathname: string) {
  return PAGE_ACCESS.find(page => page.paths.some(path => pathname === path || pathname.startsWith(path + '/')));
}

export function canViewPath(pathname: string, access: AdminAccess | null | undefined): boolean {
  const page = pageForPath(pathname);
  if (!page || !access) return false;
  if (access.isPlatformAdmin || access.isTenantAdmin) return true;
  return page.keys.some(key => access.pages?.[key]?.view === true);
}

export function firstAllowedPath(access: AdminAccess | null | undefined): string | null {
  for (const page of PAGE_ACCESS) {
    for (const path of page.paths) if (canViewPath(path, access)) return path;
  }
  return null;
}
