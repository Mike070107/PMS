import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { House, TenantConfig, User } from '../../entities';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';
import { CollectionSmsService } from './collection-sms.service';

@Module({
  imports: [TypeOrmModule.forFeature([TenantConfig, User, House])],
  controllers: [SettingsController],
  providers: [SettingsService, CollectionSmsService],
  exports: [SettingsService, CollectionSmsService],
})
export class SettingsModule {}
