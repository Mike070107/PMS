import { useSession } from '@/lib/auth';

/**
 * 旧后台 lib/auth 的兼容层：公寓收费台是从 admin-web 原样复制过来的，
 * 它用 useAuth()/usePagePerm()，这里用 beta 的会话对象把它们等价实现，
 * 这样复制过来的页面代码一行都不用改（也就不会出现"改着改着就和旧页不一样"）。
 */
export function useAuth() {
  const s = useSession();
  return { user: s.user, access: s.access } as never as { user: { id: number; name?: string | null }; access: any }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export function usePagePerm(pageKey: string): { canView: boolean; canEdit: boolean; canDelete: boolean } {
  const s = useSession();
  const a = (s.access ?? {}) as {
    isTenantAdmin?: boolean;
    isPlatformAdmin?: boolean;
    scopeAll?: boolean;
    pages?: Record<string, { view?: boolean; edit?: boolean; delete?: boolean }>;
  };
  const admin = !!a.isTenantAdmin || !!a.isPlatformAdmin;
  const p = a.pages?.[pageKey];
  return {
    canView: admin || !!p?.view || !!a.scopeAll,
    canEdit: admin || !!p?.edit,
    canDelete: admin || !!p?.delete || !!p?.edit,
  };
}
