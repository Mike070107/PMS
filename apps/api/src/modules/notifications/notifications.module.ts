import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Notification, SubscriptionGrant, User } from '../../entities';
import { AccessModule } from '../access/access.module';
import { AuthModule } from '../auth/auth.module';
import { SettingsModule } from '../settings/settings.module';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { WxServiceAccountService } from './wx-service-account.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Notification, SubscriptionGrant, User]),
    // 模板 id 按租户配在设置里；WechatService 由 AuthModule 导出
    SettingsModule,
    AuthModule,
    // 后台「校验模板 / 发测试」两个接口挂 PermissionsGuard，守卫由 AccessModule 提供
    AccessModule,
  ],
  controllers: [NotificationsController],
  providers: [NotificationsService, WxServiceAccountService],
  // 报修流程要用它给业主发通知；设置页要用服务号那个做「同步关注者 / 发送测试」
  exports: [NotificationsService, WxServiceAccountService],
})
export class NotificationsModule {}
