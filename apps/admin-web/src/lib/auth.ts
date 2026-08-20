import { useSyncExternalStore } from 'react';
import type { AdminLoginResp } from '@pms/api-client/src/endpoints/auth';
import type { AdminAccess } from '@pms/shared-types';

const TOKEN_KEY = 'pms.admin.token';
const USER_KEY = 'pms.admin.user';
const ACCESS_KEY = 'pms.admin.access';
const ACTING_KEY = 'pms.admin.actingTenant';
const ACTING_OFFICE_KEY = 'pms.admin.actingOffice';

type AuthUser = AdminLoginResp['user'];

/** 平台超管「进入公司视角」时记录的目标公司 */
export interface ActingTenant {
  id: number;
  name: string;
}

/** 顶栏「管理处视角」选择（只收窄数据范围，后端校验合法性） */
export interface ActingOffice {
  id: number;
  name: string;
}

interface Snapshot {
  token: string | undefined;
  user: AuthUser | null;
  /** 后台权限（/auth/me 下发）。null = 旧会话还没拉到，按全可见处理，后端兜底 */
  access: AdminAccess | null;
  actingTenant: ActingTenant | null;
  actingOffice: ActingOffice | null;
}

const listeners = new Set<() => void>();

// useSyncExternalStore 要求 getSnapshot 返回的引用稳定（同样状态返回同一对象）。
// 这里缓存一份当前 snapshot 及其来源原文，仅当任一字段原文变化时才生成新引用。
let cachedRaw = '';
let cached: Snapshot = {
  token: undefined,
  user: null,
  access: null,
  actingTenant: null,
  actingOffice: null,
};
refreshFromStorage();

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function refreshFromStorage() {
  const parts = [
    localStorage.getItem(TOKEN_KEY) ?? '',
    localStorage.getItem(USER_KEY) ?? '',
    localStorage.getItem(ACCESS_KEY) ?? '',
    localStorage.getItem(ACTING_KEY) ?? '',
    localStorage.getItem(ACTING_OFFICE_KEY) ?? '',
  ].join(' ');
  if (parts === cachedRaw) return;
  cachedRaw = parts;
  cached = {
    token: localStorage.getItem(TOKEN_KEY) || undefined,
    user: parseJson<AuthUser>(localStorage.getItem(USER_KEY)),
    access: parseJson<AdminAccess>(localStorage.getItem(ACCESS_KEY)),
    actingTenant: parseJson<ActingTenant>(localStorage.getItem(ACTING_KEY)),
    actingOffice: parseJson<ActingOffice>(localStorage.getItem(ACTING_OFFICE_KEY)),
  };
}

function refresh() {
  refreshFromStorage();
  listeners.forEach((l) => l());
}

export const auth = {
  getToken(): string | undefined { return cached.token; },
  getUser(): AuthUser | null { return cached.user; },
  getAccess(): AdminAccess | null { return cached.access; },
  getActingTenant(): ActingTenant | null { return cached.actingTenant; },
  getActingOffice(): ActingOffice | null { return cached.actingOffice; },
  setSession(token: string, user: AuthUser) {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
    refresh();
  },
  setAccess(access: AdminAccess | null) {
    if (access) localStorage.setItem(ACCESS_KEY, JSON.stringify(access));
    else localStorage.removeItem(ACCESS_KEY);
    refresh();
  },
  setActingTenant(t: ActingTenant | null) {
    if (t) localStorage.setItem(ACTING_KEY, JSON.stringify(t));
    else localStorage.removeItem(ACTING_KEY);
    // 换公司后旧的管理处选择必然无效，跟着清掉
    localStorage.removeItem(ACTING_OFFICE_KEY);
    refresh();
  },
  setActingOffice(o: ActingOffice | null) {
    if (o) localStorage.setItem(ACTING_OFFICE_KEY, JSON.stringify(o));
    else localStorage.removeItem(ACTING_OFFICE_KEY);
    refresh();
  },
  clear() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    localStorage.removeItem(ACCESS_KEY);
    localStorage.removeItem(ACTING_KEY);
    localStorage.removeItem(ACTING_OFFICE_KEY);
    refresh();
  },
  subscribe(l: () => void) {
    listeners.add(l);
    return () => { listeners.delete(l); };
  },
};

// 跨标签页同步
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (
      e.key === TOKEN_KEY ||
      e.key === USER_KEY ||
      e.key === ACCESS_KEY ||
      e.key === ACTING_KEY ||
      e.key === ACTING_OFFICE_KEY
    ) {
      refresh();
    }
  });
}

export function useAuth(): Snapshot {
  return useSyncExternalStore(auth.subscribe, () => cached);
}

/**
 * 页面三档权限。access 还没拉到（旧会话）时按全可见处理 —— 菜单不至于白屏，
 * 真正的拦截在后端。新增页面直接用这个 hook，别在页面里手写角色判断。
 */
export function usePagePerm(pageKey: string): {
  canView: boolean;
  canEdit: boolean;
  canDelete: boolean;
} {
  const { access } = useAuth();
  return pagePerm(access, pageKey);
}

export function pagePerm(access: AdminAccess | null, pageKey: string) {
  if (!access) return { canView: true, canEdit: true, canDelete: true };
  const p = access.pages[pageKey];
  return {
    canView: !!p?.view,
    canEdit: !!p?.edit,
    canDelete: !!p?.delete,
  };
}
