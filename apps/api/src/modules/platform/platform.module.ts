import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Community, PlatformLog, Role, Tenant, User } from '../../entities';
import { PlatformController } from './platform.controller';
import { PlatformGuard } from './platform.guard';
import { PlatformService } from './platform.service';

@Module({
  imports: [TypeOrmModule.forFeature([Tenant, User, Community, Role, PlatformLog])],
  controllers: [PlatformController],
  providers: [PlatformService, PlatformGuard],
  exports: [PlatformService],
})
export class PlatformModule {}
