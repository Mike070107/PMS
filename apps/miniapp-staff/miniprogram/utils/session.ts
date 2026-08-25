/**
 * 「当前这个人能干什么」——员工端只有这一份判断，页面不要再各写一套角色白名单。
 *
 * 为什么必须共用：员工端有 9 种业务身份，同一个能力（能不能派单、能不能改材料）
 * 在工单页、材料页、tabBar 里各判一次，就一定会判得不一样。2026-08-25 之前就是这样：
 * 材料页把办公室写死成只读（后端其实按 materials:edit 放行），工单池对所有人都画「接单」
 * 按钮（后端只让维修工领单）。
 *
 * 判断的两条依据分工明确，别混：
 *   · **业务身份（role）** 决定「这个人在物业里干哪一行」—— 维修工接单、办公室派单。
 *     这是流程语义，后端也是按 @Roles 卡的（accept 只给 TECHNICIAN），端上照抄同一套。
 *   · **后台权限矩阵（access.pages）** 决定「他被授权到哪一页的哪一档」—— 后端的
 *     @RequirePermission 就是按它判的。凡是「按钮点下去会不会 403」，一律问它，
 *     不要再照身份猜（办公室的角色是企业超管在后台配的，可宽可窄）。
 *
 * 老会话 / 拿不到 access 时按业务身份兜底：宁可多给一个入口（后端仍会拦），
 * 也不要让有权限的人以为功能没了。
 */
import { auth } from '@pms/api-client';
import { type MeResp } from '@pms/shared-types';
import { isDispatcher, isReporter, isTechnician } from './roles';
import { rememberRole } from './tabbar';

export { DISPATCH_ROLES, REPORTER_ROLES, WORKER_ROLES } from './roles';

export interface StaffSession {
  me: MeResp | null;
  role: string;
  /** 维修工：接单、完工、报缺料 */
  isTechnician: boolean;
  /** 办公室一侧：派单、查工单、管材料库存 */
  isDispatcher: boolean;
  /** 代报身份：只报修 */
  isReporter: boolean;
  /** 能不能派单（业务身份 + 工单页 edit 权限） */
  canDispatch: boolean;
  /** 材料 SKU 库：能看 / 能改（改 = 补全信息、补照片、新建） */
  canViewMaterials: boolean;
  canEditMaterials: boolean;
  /** 库存与采购 */
  canViewInventory: boolean;
}

const emptySession = (): StaffSession => ({
  me: null,
  role: '',
  isTechnician: false,
  isDispatcher: false,
  isReporter: false,
  canDispatch: false,
  canViewMaterials: false,
  canEditMaterials: false,
  canViewInventory: false,
});

/** access 里某一页的某一档；没有 access 时交给调用方按身份兜底 */
function can(me: MeResp | null, pageKey: string, action: 'view' | 'edit'): boolean | null {
  const pages = me?.access?.pages;
  if (!pages) return null;
  const page = pages[pageKey];
  return !!page && !!page[action];
}

export function buildSession(me: MeResp | null): StaffSession {
  if (!me) return emptySession();
  const role = me.role as string;
  const technician = isTechnician(role);
  const dispatcher = isDispatcher(role);
  const reporter = isReporter(role);
  // 兜底口径 = 老代码里那份角色白名单：办公室一侧看得到材料与库存，维修工看不到
  const fallback = dispatcher;
  const perm = (pageKey: string, action: 'view' | 'edit', byRole: boolean) => {
    const granted = can(me, pageKey, action);
    return granted === null ? byRole : granted;
  };
  return {
    me,
    role,
    isTechnician: technician,
    isDispatcher: dispatcher,
    isReporter: reporter,
    canDispatch: dispatcher && perm('work-orders', 'edit', true),
    canViewMaterials: perm('materials', 'view', fallback),
    // 办公室原来被端上写死成只读，但后端一直是按 materials:edit 放行的 ——
    // 结果「补全 SKU 信息」这件本该办公室干的事，在小程序里根本点不动
    canEditMaterials: perm('materials', 'edit', fallback),
    canViewInventory: perm('inventory', 'view', fallback),
  };
}

/**
 * 一次会话内只打一次 /auth/me。
 * 每个页面各调一次 auth.me() 的后果是：切一次 tab 就多打三四个请求，
 * 而且几个页面各自判角色，判出来还不一样。
 */
let cached: Promise<StaffSession> | null = null;

export function getSession(page?: any, force = false): Promise<StaffSession> {
  if (force) cached = null;
  if (!cached) {
    cached = auth
      .me()
      .then((me) => {
        if (page) rememberRole(page, me.role);
        return buildSession(me);
      })
      .catch((e) => {
        // 失败不缓存，否则一次网络抖动会让整个会话都当成「没权限」
        cached = null;
        throw e;
      });
  }
  return cached;
}

/** 退出登录时清掉，换个人登进来不能还按上一个人的权限渲染 */
export function clearSession() {
  cached = null;
}
