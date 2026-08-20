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
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { GrantSubscribeDto } from './dto';
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
}
