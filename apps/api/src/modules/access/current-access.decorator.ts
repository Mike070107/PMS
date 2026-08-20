import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { ResolvedAccess } from './access.service';

/**
 * 取出 PermissionsGuard 解析好的访问能力（req.access）。
 * 只能用在挂了 @RequirePermission 的接口上，否则拿到 undefined。
 */
export const CurrentAccess = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): ResolvedAccess => {
    const req = ctx.switchToHttp().getRequest();
    return req.access;
  },
);
