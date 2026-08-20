import { SetMetadata } from '@nestjs/common';
import { AdminPageKey, PermissionAction } from './pages';

export const PERMISSION_KEY = 'required_permission';

export interface RequiredPermission {
  /** 任一页面命中即可（下拉基础数据被多个页面共用时传数组） */
  pageKeys: AdminPageKey[];
  action: PermissionAction;
}

/**
 * 管理后台接口的页面级权限声明，配合 PermissionsGuard / RolesOrPermissionGuard
 * 使用（需在 JwtAuthGuard 之后）。
 * 与旧 @Roles 的关系：@Roles 只保留小程序端业务身份（业主/维修工/代报角色）；
 * 管理后台一律挂本装饰器，由后台角色的权限矩阵决定，业务身份不再参与判断。
 */
export const RequirePermission = (
  pageKey: AdminPageKey | AdminPageKey[],
  action: PermissionAction,
) =>
  SetMetadata(PERMISSION_KEY, {
    pageKeys: Array.isArray(pageKey) ? pageKey : [pageKey],
    action,
  } satisfies RequiredPermission);
