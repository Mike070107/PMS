/**
 * 「当前这个人能干什么」—— 员工端只有这一份判断，页面不要再各写一套。
 *
 * 判据只有一个：**后台给他的角色勾了哪些入口、哪些档**（access.pages 里的 app:*）。
 * 后端接口也是按同一批 key 鉴权的，所以「端上给不给点」和「点下去会不会 403」
 * 永远一致。这里不再有「维修工 / 办公室」之类的身份判断 ——
 * 接单和派单是两格，审批的两步也是两格，谁有哪一格由勾选说了算。
 *
 * 拿不到 access 的老会话一律放行：宁可多给一个入口（后端仍会拦），
 * 也不要让有权限的人以为功能没了。
 */
import { auth } from '@pms/api-client';
import { type MeResp } from '@pms/shared-types';
import { rememberAccess } from './tabbar';

export interface StaffSession {
  me: MeResp | null;
  /** 他绑的角色名，「我的」页显示用 */
  roleNames: string[];
  /** 工单池那一格：看得到 / 能接单 */
  canSeePool: boolean;
  canAccept: boolean;
  /** 派单台那一格：看得到 / 能派单 */
  canSeeDispatch: boolean;
  canDispatch: boolean;
  /** 在手工单：看得到 / 能完工报料 */
  canSeeMyOrders: boolean;
  canHandleOrders: boolean;
  /** 材料与库存（现场查存量、看采购进度） */
  canViewMaterials: boolean;
  canEditMaterials: boolean;
  canViewInventory: boolean;
  /**
   * 材料 SKU 库单独一格（app:materials）：看全部材料档案、改名称型号照片。
   * 和上面那一格分开是因为改档案会影响全公司的编码和统计，不是人人都该有。
   */
  canViewSku: boolean;
  canEditSku: boolean;
  /** 采购审批（两步各自一格） */
  canApproveAsManager: boolean;
  canApproveAsPurchaser: boolean;
  canApprove: boolean;
  /** 替住户报修 */
  canReport: boolean;
  /** 消息中心 */
  canUseMessages: boolean;
  /**
   * 只替住户报修的人（保安、居委会…）：既看不到工单池也看不到派单台。
   * 报修位置受「可代报的小区」限制，落地页也不该是工单池。
   */
  reporterOnly: boolean;
}

const emptySession = (): StaffSession => ({
  me: null,
  roleNames: [],
  canSeePool: false,
  canAccept: false,
  canSeeDispatch: false,
  canDispatch: false,
  canSeeMyOrders: false,
  canHandleOrders: false,
  canViewMaterials: false,
  canEditMaterials: false,
  canViewInventory: false,
  canViewSku: false,
  canEditSku: false,
  canApproveAsManager: false,
  canApproveAsPurchaser: false,
  canApprove: false,
  canReport: false,
  canUseMessages: false,
  reporterOnly: false,
});

export function buildSession(me: MeResp | null): StaffSession {
  if (!me) return emptySession();
  const pages = me.access?.pages;
  // 老会话（还没拿到 access）一律给 —— 宁可多一个入口，后端仍会拦
  const can = (key: string, action: 'view' | 'edit') => {
    if (!pages) return true;
    const page = pages[key];
    return !!page && !!page[action];
  };
  const canSeePool = can('app:pool', 'view');
  const canSeeDispatch = can('app:dispatch', 'view');
  const canApproveAsManager = can('app:approve-manager', 'edit');
  const canApproveAsPurchaser = can('app:approve-purchaser', 'edit');
  return {
    me,
    roleNames: me.roleNames ?? [],
    canSeePool,
    canAccept: can('app:pool', 'edit'),
    canSeeDispatch,
    canDispatch: can('app:dispatch', 'edit'),
    canSeeMyOrders: can('app:my-orders', 'view'),
    canHandleOrders: can('app:my-orders', 'edit'),
    canViewMaterials: can('app:inventory', 'view'),
    canEditMaterials: can('app:inventory', 'edit'),
    canViewInventory: can('app:inventory', 'view'),
    canViewSku: can('app:materials', 'view'),
    canEditSku: can('app:materials', 'edit'),
    canApproveAsManager,
    canApproveAsPurchaser,
    canApprove: canApproveAsManager || canApproveAsPurchaser,
    canReport: can('app:repair-create', 'view'),
    canUseMessages: can('app:messages', 'view'),
    reporterOnly: !!pages && !canSeePool && !canSeeDispatch,
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
        if (page) rememberAccess(page, me.access?.pages);
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
