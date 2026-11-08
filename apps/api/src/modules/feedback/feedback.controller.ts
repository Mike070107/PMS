import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { AuthUser, CurrentUser } from '../../common/current-user.decorator';
import { RequirePermission } from '../../common/require-permission.decorator';
import { PermissionsGuard } from '../access/permissions.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CreateUserFeedbackDto, ListUserFeedbackDto, UpdateUserFeedbackDto } from './dto';
import { FeedbackService } from './feedback.service';

@Controller('feedback')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class FeedbackController {
  constructor(private readonly feedbackService: FeedbackService) {}

  /** 提交：任何登录用户都可提交；旧小程序字段保持不变。 */
  @Post()
  create(@Body() dto: CreateUserFeedbackDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    return this.feedbackService.create(dto, user, req);
  }

  /** 管理端统一列表：user_feedback + 历史 observability 异常反馈（读时合并）。 */
  @Get()
  @RequirePermission('logs', 'view')
  list(@Query() query: ListUserFeedbackDto, @CurrentUser() user: AuthUser) {
    return this.feedbackService.list(query, user);
  }

  /** 标记已处理（或撤回）；历史记录用 `log-<id>`。 */
  @Patch(':id')
  @RequirePermission('logs', 'edit')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateUserFeedbackDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.feedbackService.update(id, dto, user);
  }
}
