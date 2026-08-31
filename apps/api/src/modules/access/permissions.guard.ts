import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  PERMISSION_KEY,
  RequiredPermission,
} from '../../common/require-permission.decorator';
import { AccessService } from './access.service';

/**
 * 页面级权限守卫：读取 @RequirePermission 元数据，按当前用户的后台角色
 * 权限矩阵放行/403。需放在 JwtAuthGuard 之后。
 * 解析结果挂到 req.access，同一请求内 controller/service 可直接复用（拿数据范围）。
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly accessService: AccessService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<RequiredPermission>(
      PERMISSION_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required) return true;

    const req = context.switchToHttp().getRequest();
    const user = req.user;
    if (!user) throw new ForbiddenException('权限不足');

    const access = req.access ?? (await this.accessService.getAccess(user));
    req.access = access;

    if (!this.accessService.hasAnyPermission(access, required.items)) {
      throw new ForbiddenException('权限不足');
    }
    return true;
  }
}
