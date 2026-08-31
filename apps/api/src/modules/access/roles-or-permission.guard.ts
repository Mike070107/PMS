import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '../../common/enums';
import {
  PERMISSION_KEY,
  RequiredPermission,
} from '../../common/require-permission.decorator';
import { ROLES_KEY } from '../../common/roles.decorator';
import { AccessService } from './access.service';

/**
 * 双轨过渡守卫：业务身份命中 @Roles（小程序端：业主/维修工）或
 * 后台角色命中 @RequirePermission（管理后台），二者满足其一即放行。
 * 用于同一接口同时服务小程序与管理后台的模块（工单等）。
 * 命中角色路径时不解析权限（省两次查库），此时 req.access 为空，
 * service 里的范围过滤会自动跳过 —— 业务身份的数据边界仍由原有逻辑负责。
 */
@Injectable()
export class RolesOrPermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly accessService: AccessService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const roles = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const permission = this.reflector.getAllAndOverride<RequiredPermission>(
      PERMISSION_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!roles?.length && !permission) return true;

    const req = context.switchToHttp().getRequest();
    const user = req.user;
    if (!user) throw new ForbiddenException('权限不足');

    if (roles?.length && roles.includes(user.role)) {
      // 命中角色路径本可跳过权限解析，但带着管理处视角（顶栏切换器）时必须
      // 解析出收窄后的范围挂到 req.access —— 否则企业超管在工单这类共用接口上
      // 切了管理处却仍看到全公司数据，切换器形同虚设。
      // 只有视角真正生效（actingOfficeId 非空）才挂：无后台角色的业务身份用户
      // 解析出来是空范围，挂上去会把他本来能看的数据整个清空。
      if (user.actingOfficeId && !req.access) {
        const access = await this.accessService.getAccess(user);
        if (access.actingOfficeId) req.access = access;
      }
      return true;
    }

    if (permission) {
      const access = req.access ?? (await this.accessService.getAccess(user));
      req.access = access;
      if (
        this.accessService.hasAnyPermission(access, permission.items)
      ) {
        return true;
      }
    }
    throw new ForbiddenException('权限不足');
  }
}
