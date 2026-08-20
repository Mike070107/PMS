import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export interface AuthUser {
  id: number;
  tenantId: number | null;
  role: string;
  /**
   * 管理处视角（x-acting-office-id 请求头，管理后台顶栏切换器写入）。
   * 只用于把数据范围收窄到该管理处，不放大权限；无效值会被 AccessService 忽略。
   */
  actingOfficeId?: number | null;
}

/** 从请求中取出 JWT 解析后的当前用户 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => {
    const req = ctx.switchToHttp().getRequest();
    return req.user;
  },
);
