import { SetMetadata } from '@nestjs/common';
import { UserRole } from './enums';

export const ROLES_KEY = 'roles';

/** 标注接口所需角色，配合 RolesGuard 使用 */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);
