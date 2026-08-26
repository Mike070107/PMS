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

export interface RequiredPermission {
  /** 任一页面命中即可（下拉基础数据被多个页面共用时传数组） */
  pageKeys: PermissionPageKey[];
  action: PermissionAction;
}

/**
 * 管理后台接口的页面级权限声明，配合 PermissionsGuard / RolesOrPermissionGuard
 * 使用（需在 JwtAuthGuard 之后）。
 * 与旧 @Roles 的关系：@Roles 只保留小程序端业务身份（业主/维修工/代报角色）；
 * 管理后台一律挂本装饰器，由后台角色的权限矩阵决定，业务身份不再参与判断。
 */
export const RequirePermission = (
  pageKey: PermissionPageKey | PermissionPageKey[],
  action: PermissionAction,
) =>
  SetMetadata(PERMISSION_KEY, {
    pageKeys: Array.isArray(pageKey) ? pageKey : [pageKey],
    action,
  } satisfies RequiredPermission);
