import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  Role,
  StaffProfile,
  User,
  UserReportCommunity,
  UserRoleAssignment,
} from '../../entities';
import { RolesModule } from '../roles/roles.module';
import { StaffController } from './staff.controller';
import { StaffService } from './staff.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      User,
      StaffProfile,
      UserReportCommunity,
      Role,
      UserRoleAssignment,
    ]),
    // 校验「角色范围是否不超过操作者」复用 RolesService
    RolesModule,
  ],
  controllers: [StaffController],
  providers: [StaffService],
})
export class StaffModule {}
