import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  Community,
  ManagementOffice,
  Role,
  RolePermission,
  RoleScope,
  RoleTemplate,
  RoleTemplatePermission,
  RoleWarehouse,
  Tenant,
  User,
  UserRoleAssignment,
} from '../../entities';
import { AccessService } from './access.service';
import { PermissionsGuard } from './permissions.guard';
import { RbacSeedService } from './rbac-seed.service';
import { RolesOrPermissionGuard } from './roles-or-permission.guard';

/**
 * 权限解析全局模块：任何模块都能直接注入 AccessService / 使用 PermissionsGuard，
 * 不必逐个 import。
 */
@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Tenant,
      Role,
      RolePermission,
      RoleScope,
      RoleTemplate,
      RoleTemplatePermission,
  RoleWarehouse,
      UserRoleAssignment,
      Community,
      ManagementOffice,
      User,
    ]),
  ],
  providers: [AccessService, PermissionsGuard, RolesOrPermissionGuard, RbacSeedService],
  exports: [AccessService, PermissionsGuard, RolesOrPermissionGuard, RbacSeedService],
})
export class AccessModule {}
