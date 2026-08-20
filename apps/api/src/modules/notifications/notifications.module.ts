import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Notification, SubscriptionGrant, User } from '../../entities';
import { AuthModule } from '../auth/auth.module';
import { SettingsModule } from '../settings/settings.module';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Notification, SubscriptionGrant, User]),
    // 模板 id 按租户配在设置里；WechatService 由 AuthModule 导出
    SettingsModule,
    AuthModule,
  ],
  controllers: [NotificationsController],
  providers: [NotificationsService],
  // 报修流程要用它给业主发通知
  exports: [NotificationsService],
})
export class NotificationsModule {}
