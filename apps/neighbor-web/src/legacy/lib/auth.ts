import { auth, useSession } from '@/lib/auth';
export { auth };
export const useAuth=useSession;
export function pagePerm(access: ReturnType<typeof useSession>['access'],pageKey:string){const p=access?.pages?.[pageKey];const admin=!!access?.isTenantAdmin||!!access?.isPlatformAdmin;return {canView:admin||!!p?.view,canEdit:admin||!!p?.edit,canDelete:admin||!!p?.delete}}
export function usePagePerm(pageKey:string){return pagePerm(useSession().access,pageKey)}
