import { auth } from './auth';

/** 当前账号对某页面有没有某档权限（企业超管 / 平台管理员一律有） */
export function can(pageKey: string, action: 'view' | 'edit' | 'delete' = 'view'): boolean {
  const a = auth.getAccess();
  if (!a) return false;
  if (a.isPlatformAdmin || a.isTenantAdmin) return true;
  return !!a.pages?.[pageKey]?.[action];
}
