import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthUser, CurrentUser } from '../../common/current-user.decorator';
import { RequirePermission } from '../../common/require-permission.decorator';
import { PermissionsGuard } from '../access/permissions.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { GrantSubscribeDto, TemplateCheckDto, TemplateTestDto } from './dto';
import { NotificationsService } from './notifications.service';

@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Get()
  list(@Query('unread') unread: string, @CurrentUser() user: AuthUser) {
    return this.notificationsService.list(user, unread === '1' || unread === 'true');
  }

  @Get('unread-count')
  unreadCount(@CurrentUser() user: AuthUser) {
    return this.notificationsService.unreadCount(user);
  }

  @Post(':id/read')
  markRead(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.notificationsService.markRead(id, user);
  }

  /**
   * 记录订阅授权。前端必须只上报 wx.requestSubscribeMessage 回调里
   * 结果为 accept 的模板 id —— 微信没有查余量的接口，这里全靠前端如实上报。
   */
  @Post('subscribe')
  subscribe(@Body() dto: GrantSubscribeDto, @CurrentUser() user: AuthUser) {
    return this.notificationsService.grantSubscribe(user, dto.templateIds);
  }

  @Post('read-all')
  markAllRead(@Body() _body: unknown, @CurrentUser() user: AuthUser) {
    return this.notificationsService.markAllRead(user);
  }

  /** 后台「系统设置」用：校验模板 ID，回显每个关键词会被填成什么 */
  @Post('templates/check')
  @UseGuards(PermissionsGuard)
  @RequirePermission('settings', 'view')
  checkTemplate(@Body() dto: TemplateCheckDto, @CurrentUser() user: AuthUser) {
    return this.notificationsService.checkTemplate(user, dto.template, dto.templateId);
  }

  /** 后台「系统设置」用：给自己发一条测试，回显微信真实错误 */
  @Post('templates/test')
  @UseGuards(PermissionsGuard)
  @RequirePermission('settings', 'edit')
  testTemplate(@Body() dto: TemplateTestDto, @CurrentUser() user: AuthUser) {
    return this.notificationsService.sendTest(user, dto.template);
  }

  /**
   * 服务号：把关注者拉回来，按 unionid 认领到员工账号上。
   * 维修工新关注了服务号之后要点一次，否则系统不知道他是谁。
   */
  @Post('service-account/sync-followers')
  @UseGuards(PermissionsGuard)
  @RequirePermission('settings', 'edit')
  syncFollowers(@Body() _body: unknown, @CurrentUser() user: AuthUser) {
    return this.notificationsService.syncServiceAccountFollowers(user);
  }

  /** 服务号：给自己发一条测试模板消息，回显微信真实错误 */
  @Post('service-account/test')
  @UseGuards(PermissionsGuard)
  @RequirePermission('settings', 'edit')
  testServiceAccount(@Body() _body: unknown, @CurrentUser() user: AuthUser) {
    return this.notificationsService.sendServiceAccountTest(user);
  }
}
