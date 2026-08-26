import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  Community,
  PlatformLog,
  Role,
  Tenant,
  User,
  UserRoleAssignment,
} from '../../entities';
import { PlatformController } from './platform.controller';
import { PlatformGuard } from './platform.guard';
import { AccessModule } from '../access/access.module';
import { PlatformService } from './platform.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Tenant,
      User,
      Community,
      Role,
      PlatformLog,
      UserRoleAssignment,
    ]),
    // 开通公司时要立刻补身份角色，否则对方当天一个员工都建不出来
    AccessModule,
  ],
  controllers: [PlatformController],
  providers: [PlatformService, PlatformGuard],
  exports: [PlatformService],
})
export class PlatformModule {}
