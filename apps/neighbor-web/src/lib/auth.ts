import { useSyncExternalStore } from 'react';
import type { AdminLoginResp } from '@pms/api-client/src/endpoints/auth';
import type { AdminAccess } from '@pms/shared-types';

/**
 * 会话存储键与正式后台 (apps/admin-web) 保持一致。
 *
 * 只用 sessionStorage；刷新续用当天会话，SPA 站内切换不重建模块。
 * 新文档重新进入或恢复历史页时，不自动采用残留凭据，必须重新登录。
 * 这是保守的重新认证策略，不依赖不可靠的浏览器退出/unload 事件。
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

export interface SessionIdentity {
  readonly token: string | undefined;
  readonly generation: number;
}

export interface Session extends SessionIdentity {
  user: AuthUser | null;
  access: AdminAccess | null;
  actingTenant: ActingTenant | null;
  actingOffice: ActingOffice | null;
}

const listeners = new Set<() => void>();
const EMPTY: Session = { token: undefined, generation: 0, user: null, access: null, actingTenant: null, actingOffice: null };
let loginGeneration = 0;
let cachedRaw: string | null = null;
let cached: Session = EMPTY;
let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
let timerGeneration = 0;
const SESSION_KEYS = [TOKEN_KEY, USER_KEY, ACCESS_KEY, ACTING_KEY, ACTING_OFFICE_KEY];

// JWT is only decoded for local expiry UX; the API still verifies its signature.
function tokenDeadline(token: string): number {
  try {
    const payload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const exp = JSON.parse(atob(payload)).exp;
    return typeof exp === 'number' && Number.isFinite(exp) && exp > 0 ? exp * 1000 : 0;
  } catch { return 0; }
}

function clearStoredSession() {
  SESSION_KEYS.forEach((key) => store.removeItem(key));
}

function scheduleDeadline() {
  if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
  deadlineTimer = undefined;
  const generation = ++timerGeneration;
  const token = store.getItem(TOKEN_KEY);
  if (!token) return;
  const remaining = tokenDeadline(token) - Date.now();
  deadlineTimer = setTimeout(() => {
    // A queued callback from the previous login must never clear the new one.
    if (generation !== timerGeneration || store.getItem(TOKEN_KEY) !== token) return;
    emit();
  }, Math.max(0, Math.min(remaining, 2147483647)));
}

function parse<T>(raw: string | null): T | null {
  if (!raw) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
}

function read(): Session {
  const token = store.getItem(TOKEN_KEY);
  const expired = !!token && tokenDeadline(token) <= Date.now();
  if (expired) ++loginGeneration;
  if (!token || expired) clearStoredSession();
  const parts = [
    String(loginGeneration),
    store.getItem(TOKEN_KEY) ?? '',
    store.getItem(USER_KEY) ?? '',
    store.getItem(ACCESS_KEY) ?? '',
    store.getItem(ACTING_KEY) ?? '',
    store.getItem(ACTING_OFFICE_KEY) ?? '',
  ].join(' ');
  if (parts === cachedRaw && cached !== EMPTY) return cached;
  cachedRaw = parts;
  cached = {
    generation: loginGeneration,
    token: store.getItem(TOKEN_KEY) ?? undefined,
    user: parse<AuthUser>(store.getItem(USER_KEY)),
    access: parse<AdminAccess>(store.getItem(ACCESS_KEY)),
    actingTenant: parse<ActingTenant>(store.getItem(ACTING_KEY)),
    actingOffice: parse<ActingOffice>(store.getItem(ACTING_OFFICE_KEY)),
  };
  // getToken() can discover expiry before a throttled timer. Notify even then,
  // after the current render/snapshot read has completed.
  if (expired) queueMicrotask(() => listeners.forEach((listener) => listener()));
  return cached;
}

// 首次调用放在函数定义之后：模块顶层的 read() 会撞上 let cached 的 TDZ
// 浏览器可能恢复 sessionStorage；仅真正刷新允许续用旧会话。
// 其他新文档进入（包括恢复历史页）一律重新认证，宁可多登录不隐式恢复。
const navigation = window.performance?.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
if (navigation?.type !== 'reload') clearStoredSession();
cached = read();
scheduleDeadline();

// Timers can be throttled/frozen while hidden or asleep. Recheck wall-clock time
// before the UI resumes; never clear on unload/pagehide (refresh must survive).
window.addEventListener('focus', emit);
window.addEventListener('pageshow', emit);
window.addEventListener('storage', emit);
document.addEventListener('visibilitychange', emit);

function emit() {
  read();
  scheduleDeadline();
  listeners.forEach((l) => l());
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function captureIdentity(): SessionIdentity {
  const { token, generation } = read();
  return Object.freeze({ token, generation });
}

function isCurrent(identity: SessionIdentity | undefined): boolean {
  const current = read();
  return !!identity?.token && identity.token === current.token && identity.generation === current.generation;
}

export const auth = {
  captureIdentity,
  isCurrent,
  getSession: () => read(),
  getToken: () => read().token,
  getUser: () => read().user,
  getAccess: () => read().access,
  getActingTenant: () => read().actingTenant,
  getActingOffice: () => read().actingOffice,

  setLogin(resp: AdminLoginResp) {
    ++loginGeneration;
    clearStoredSession();
    store.setItem(TOKEN_KEY, resp.accessToken);
    store.setItem(USER_KEY, JSON.stringify(resp.user));
    emit();
  },
  setAccess(access: AdminAccess | null, identity: SessionIdentity) {
    // Never infer ownership at completion time: even an identical JWT can be a new login.
    if (!isCurrent(identity)) return;
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
    ++loginGeneration;
    clearStoredSession();
    emit();
  },
};

export function useSession(): Session {
  return useSyncExternalStore(subscribe, read, read);
}
