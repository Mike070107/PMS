import { SetMetadata } from '@nestjs/common';
import { AdminPageKey, PermissionAction, StaffAppPageKey } from './pages';

/**
 * 接口可以声明的权限 key：后台页面 + 员工端入口。
 *
 * 小程序和后台调同一批接口时，把 app: key 和后台 key 一起列在同一个装饰器上
 * （见 inventory.controller）。**不要**改成在守卫里做「app:x 等价于 y」的通用映射 ——
 * 那样一格权限会顺带扩散到所有挂同一个后台 key 的接口：
 * 勾个「报修」就能派单、勾个「采购审批」就能清空库存。
 */
export type PermissionPageKey = AdminPageKey | StaffAppPageKey;

export const PERMISSION_KEY = 'required_permission';

/**
 * 一条要求：某个页面 key 上要有某个动作。
 * 写成 `[key, action]` 元组可以给这一个 key 单独指定动作 —— 用在同一个接口
 * 对后台 key 和 app: key 要求不同档位的场合，例如提交报修：
 * `work-orders` 必须有「编辑」，而 `app:repair-create`（报修入口）
 * **在矩阵里根本没有编辑档**，勾了「查看」就是能报修。
 * 2026-08-26 拆端时两个 key 用了同一个 'edit'，结果维修工/保安/居委会
 * 这些代报角色全都提交不了报修 —— 他们那一格永远是 view。
 */
export type PermissionRequirementItem =
  | PermissionPageKey
  | readonly [PermissionPageKey, PermissionAction];

export interface RequiredPermission {
  /** 任一条命中即可（下拉基础数据被多个页面共用时传数组） */
  items: Array<{ pageKey: PermissionPageKey; action: PermissionAction }>;
}

/**
 * 管理后台接口的页面级权限声明，配合 PermissionsGuard / RolesOrPermissionGuard
 * 使用（需在 JwtAuthGuard 之后）。
 * 与旧 @Roles 的关系：@Roles 只保留小程序端业务身份（业主/维修工/代报角色）；
 * 管理后台一律挂本装饰器，由后台角色的权限矩阵决定，业务身份不再参与判断。
 */
export const RequirePermission = (
  pageKey: PermissionRequirementItem | PermissionRequirementItem[],
  action: PermissionAction,
) => SetMetadata(PERMISSION_KEY, normalizeRequirements(pageKey, action));

/** 单独导出好单测：元组与普通 key 混写时，各自的动作不能串味 */
export function normalizeRequirements(
  pageKey: PermissionRequirementItem | PermissionRequirementItem[],
  action: PermissionAction,
): RequiredPermission {
  const list = Array.isArray(pageKey) && !isTuple(pageKey) ? pageKey : [pageKey];
  return {
    items: (list as PermissionRequirementItem[]).map((item) =>
      isTuple(item)
        ? { pageKey: item[0], action: item[1] }
        : { pageKey: item as PermissionPageKey, action },
    ),
  };
}

/** `['work-orders', 'edit']` 是一条要求，`['a', 'b']` 是两个 key —— 靠第二项是不是动作词区分 */
function isTuple(v: unknown): v is readonly [PermissionPageKey, PermissionAction] {
  return (
    Array.isArray(v) &&
    v.length === 2 &&
    (v[1] === 'view' || v[1] === 'edit' || v[1] === 'delete')
  );
}
