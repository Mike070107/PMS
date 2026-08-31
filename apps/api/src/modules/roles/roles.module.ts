import { Module } from '@nestjs/common';
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
  User,
  UserRoleAssignment,
} from '../../entities';
import { RolesController } from './roles.controller';
import { RolesService } from './roles.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Role,
      RolePermission,
      RoleScope,
      RoleTemplate,
      RoleTemplatePermission,
  RoleWarehouse,
      User,
      UserRoleAssignment,
      ManagementOffice,
      Community,
    ]),
  ],
  controllers: [RolesController],
  providers: [RolesService],
  exports: [RolesService],
})
export class RolesModule {}
