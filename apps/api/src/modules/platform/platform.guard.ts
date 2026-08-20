import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { UserRole } from '../../common/enums';

/** 平台管理接口：仅 superadmin。需放在 JwtAuthGuard 之后。 */
@Injectable()
export class PlatformGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    if (req.user?.role !== UserRole.SUPERADMIN) {
      throw new ForbiddenException('仅平台管理员可操作');
    }
    return true;
  }
}
