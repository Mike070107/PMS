import { ResolvedAccess } from './access.service';

/**
 * 后台角色的数据范围 → 可见小区 id 集合（含分期子小区）。
 * 返回 null = 不过滤：全公司范围，或走业务身份路径的小程序请求
 * （此时 access 为空，数据边界由各 service 按角色收敛的原有逻辑负责）。
 * 返回空数组 = 有账号但一个小区都没授权，查询层应返回空集。
 * 各管理端 service 的列表查询统一用它，新增范围过滤时直接引这里。
 */
export function scopeCommunityIds(access?: ResolvedAccess): number[] | null {
  if (!access || access.scopeAll) return null;
  return access.communityIds ?? [];
}
