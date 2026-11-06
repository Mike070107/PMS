import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { House, TenantConfig, User } from '../../entities';
import { MisCollectionSms } from '../../entities/mis-collection-sms.entity';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';
import { CollectionSmsService } from './collection-sms.service';
import { CollectionSmsLogService } from './collection-sms-log.service';
import { CollectionSmsCallbackController } from './collection-sms-callback.controller';

@Module({
  imports: [TypeOrmModule.forFeature([TenantConfig, User, House, MisCollectionSms])],
  controllers: [SettingsController, CollectionSmsCallbackController],
  providers: [SettingsService, CollectionSmsService, CollectionSmsLogService],
  exports: [SettingsService, CollectionSmsService, CollectionSmsLogService],
})
export class SettingsModule {}
