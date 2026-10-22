import { useSyncExternalStore } from 'react';
import type { AdminLoginResp } from '@pms/api-client/src/endpoints/auth';
import type { AdminAccess } from '@pms/shared-types';

/**
 * 会话存储键与正式后台 (apps/admin-web) 保持一致。
 *
 * 原因：/beta/ 与 / 同源，sessionStorage 按 origin 隔离——同标签页里
 * 在测试环境登录后，打开正式后台也已经是登录态，反之亦然。物业的人
 * 不用为看新界面再登录一次。仍然存在 sessionStorage：关掉网页就登出。
 */
const TOKEN_KEY = 'pms.admin.token';
const USER_KEY = 'pms.admin.user';
const ACCESS_KEY = 'pms.admin.access';
const ACTING_KEY = 'pms.admin.actingTenant';
const ACTING_OFFICE_KEY = 'pms.admin.actingOffice';

const store: Storage = window.sessionStorage;

export type AuthUser = AdminLoginResp['user'];

export interface ActingTenant { id: number; name: string }
export interface ActingOffice { id: number; name: string }

export interface Session {
  token: string | undefined;
  user: AuthUser | null;
  access: AdminAccess | null;
  actingTenant: ActingTenant | null;
  actingOffice: ActingOffice | null;
}

const listeners = new Set<() => void>();
const EMPTY: Session = { token: undefined, user: null, access: null, actingTenant: null, actingOffice: null };
let cachedRaw: string | null = null;
let cached: Session = EMPTY;

function parse<T>(raw: string | null): T | null {
  if (!raw) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
}

function read(): Session {
  const parts = [
    store.getItem(TOKEN_KEY) ?? '',
    store.getItem(USER_KEY) ?? '',
    store.getItem(ACCESS_KEY) ?? '',
    store.getItem(ACTING_KEY) ?? '',
    store.getItem(ACTING_OFFICE_KEY) ?? '',
  ].join(' ');
  if (parts === cachedRaw && cached !== EMPTY) return cached;
  cachedRaw = parts;
  cached = {
    token: store.getItem(TOKEN_KEY) ?? undefined,
    user: parse<AuthUser>(store.getItem(USER_KEY)),
    access: parse<AdminAccess>(store.getItem(ACCESS_KEY)),
    actingTenant: parse<ActingTenant>(store.getItem(ACTING_KEY)),
    actingOffice: parse<ActingOffice>(store.getItem(ACTING_OFFICE_KEY)),
  };
  return cached;
}

// 首次调用放在函数定义之后：模块顶层的 read() 会撞上 let cached 的 TDZ
cached = read();

function emit() {
  read();
  listeners.forEach((l) => l());
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export const auth = {
  getSession: () => read(),
  getToken: () => read().token,
  getUser: () => read().user,
  getAccess: () => read().access,
  getActingTenant: () => read().actingTenant,
  getActingOffice: () => read().actingOffice,

  setLogin(resp: AdminLoginResp) {
    store.setItem(TOKEN_KEY, resp.accessToken);
    store.setItem(USER_KEY, JSON.stringify(resp.user));
    emit();
  },
  setAccess(access: AdminAccess | null) {
    if (access) store.setItem(ACCESS_KEY, JSON.stringify(access));
    else store.removeItem(ACCESS_KEY);
    emit();
  },
  setActingOffice(office: ActingOffice | null) {
    if (office) store.setItem(ACTING_OFFICE_KEY, JSON.stringify(office));
    else store.removeItem(ACTING_OFFICE_KEY);
    emit();
  },
  setActingTenant(tenant: ActingTenant | null) {
    if (tenant) store.setItem(ACTING_KEY, JSON.stringify(tenant));
    else store.removeItem(ACTING_KEY);
    emit();
  },
  clear() {
    [TOKEN_KEY, USER_KEY, ACCESS_KEY, ACTING_KEY, ACTING_OFFICE_KEY].forEach((k) => store.removeItem(k));
    emit();
  },
};

export function useSession(): Session {
  return useSyncExternalStore(subscribe, read, read);
}
