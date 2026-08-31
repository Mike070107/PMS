import { useSyncExternalStore } from 'react';
import type { AdminLoginResp } from '@pms/api-client/src/endpoints/auth';
import type { AdminAccess } from '@pms/shared-types';

const TOKEN_KEY = 'pms.admin.token';
const USER_KEY = 'pms.admin.user';
const ACCESS_KEY = 'pms.admin.access';
const ACTING_KEY = 'pms.admin.actingTenant';
const ACTING_OFFICE_KEY = 'pms.admin.actingOffice';
const SESSION_KEYS = [TOKEN_KEY, USER_KEY, ACCESS_KEY, ACTING_KEY, ACTING_OFFICE_KEY];

/**
 * 会话存 sessionStorage 而不是 localStorage：**关掉网页就登出**。
 *
 * 物业办公室多是公用电脑，用 localStorage 的话人走了、浏览器关了，下一个人打开
 * 后台仍然是上一个人的身份，能看能改能导出。sessionStorage 由浏览器在标签页关闭时
 * 清空，天然就是「这一次开着网页」的生命周期：
 * - 刷新 / 页内跳转：会话保留，不会把人踢出去；
 * - 从当前页面里打开的新标签页：浏览器会复制一份，仍然是登录态；
 * - 手动新开标签页贴地址进来：要重新登录（或直接扫码，比输密码快）。这是这条规则的代价。
 *
 * 注意：这里清的是浏览器这一侧。服务端的 access token 是无状态 JWT，仍然按
 * JWT_ACCESS_EXPIRES_IN（默认 2h）自然过期，没有吊销名单。
 */
const store: Storage = window.sessionStorage;

export type AuthUser = AdminLoginResp['user'];

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
migrateLegacyLocalSession();
refreshFromStorage();

/**
 * 改用 sessionStorage 之前的会话躺在 localStorage 里。把它搬到本标签页的
 * sessionStorage（不至于一上线就把所有人踢下线），并**从 localStorage 里删掉** ——
 * 否则「关掉网页就登出」在老用户那儿永远不成立，token 还留在磁盘上。
 */
function migrateLegacyLocalSession() {
  // 判断只在循环前做一次：搬完 token 之后 store 里就有值了，写在循环里会漏搬后面几项
  const adopt = !!localStorage.getItem(TOKEN_KEY) && !store.getItem(TOKEN_KEY);
  for (const key of SESSION_KEYS) {
    const raw = localStorage.getItem(key);
    if (raw === null) continue;
    if (adopt) store.setItem(key, raw);
    localStorage.removeItem(key);
  }
}

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
    store.getItem(TOKEN_KEY) ?? '',
    store.getItem(USER_KEY) ?? '',
    store.getItem(ACCESS_KEY) ?? '',
    store.getItem(ACTING_KEY) ?? '',
    store.getItem(ACTING_OFFICE_KEY) ?? '',
  ].join(' ');
  if (parts === cachedRaw) return;
  cachedRaw = parts;
  cached = {
    token: store.getItem(TOKEN_KEY) || undefined,
    user: parseJson<AuthUser>(store.getItem(USER_KEY)),
    access: parseJson<AdminAccess>(store.getItem(ACCESS_KEY)),
    actingTenant: parseJson<ActingTenant>(store.getItem(ACTING_KEY)),
    actingOffice: parseJson<ActingOffice>(store.getItem(ACTING_OFFICE_KEY)),
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
    store.setItem(TOKEN_KEY, token);
    store.setItem(USER_KEY, JSON.stringify(user));
    refresh();
  },
  setAccess(access: AdminAccess | null) {
    if (access) store.setItem(ACCESS_KEY, JSON.stringify(access));
    else store.removeItem(ACCESS_KEY);
    refresh();
  },
  setActingTenant(t: ActingTenant | null) {
    if (t) store.setItem(ACTING_KEY, JSON.stringify(t));
    else store.removeItem(ACTING_KEY);
    // 换公司后旧的管理处选择必然无效，跟着清掉
    store.removeItem(ACTING_OFFICE_KEY);
    refresh();
  },
  setActingOffice(o: ActingOffice | null) {
    if (o) store.setItem(ACTING_OFFICE_KEY, JSON.stringify(o));
    else store.removeItem(ACTING_OFFICE_KEY);
    refresh();
  },
  clear() {
    SESSION_KEYS.forEach((key) => store.removeItem(key));
    refresh();
  },
  subscribe(l: () => void) {
    listeners.add(l);
    return () => { listeners.delete(l); };
  },
};

// 同源同标签页内（iframe）的会话变更同步。
// 注意：sessionStorage 的 storage 事件不跨标签页 —— 每个标签页各有一份会话，
// 这是「关掉网页就登出」的直接后果，不是漏掉了同步。
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === null || SESSION_KEYS.includes(e.key)) refresh();
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

/**
 * 是否「全公司视角」：平台管理员 / 租户管理员 / 数据范围是全公司的角色。
 *
 * 用来决定要不要显示**全公司口径的家底数字**（材料 SKU 总数、仓库数量这类）：
 * 范围受限的人页面上其它数据都是自己范围内的，旁边再摆一个全公司总数，
 * 只会让人对不上账、以为自己少看了东西。
 *
 * 与 pagePerm 相反，access 还没拉到时按 false 处理 —— 少显示一个统计卡没有代价，
 * 把全公司数字漏给受限角色才有。判断一律用这里，别在页面里手写角色名。
 */
export function isCompanyWideView(access: AdminAccess | null, user: AuthUser | null): boolean {
  if (user?.role === 'superadmin') return true;
  if (!access) return false;
  return access.isPlatformAdmin || access.isTenantAdmin || access.scopeAll;
}

export function useCompanyWideView(): boolean {
  const { access, user } = useAuth();
  return isCompanyWideView(access, user);
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
