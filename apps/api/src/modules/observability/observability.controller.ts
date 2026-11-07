import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { AuthUser, CurrentUser } from '../../common/current-user.decorator';
import { RequirePermission } from '../../common/require-permission.decorator';
import { PermissionsGuard } from '../access/permissions.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ClientErrorDto, FeedbackStatusDto, IntroViewDto, IntroViewQueryDto, PageViewDto, SystemLogQueryDto, UserFeedbackDto } from './dto';
import { ObservabilityService } from './observability.service';

@Controller('observability')
@UseGuards(JwtAuthGuard)
export class ClientTelemetryController {
  constructor(private readonly observability: ObservabilityService) {}

  @Post('page-view')
  pageView(@Body() dto: PageViewDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    return this.observability.recordPageView(user, dto, req);
  }

  @Post('client-errors')
  clientError(@Body() dto: ClientErrorDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    return this.observability.recordClientError(user, dto, req);
  }

  @Post('feedback')
  feedback(@Body() dto: UserFeedbackDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    return this.observability.recordUserFeedback(user, dto, req);
  }
}

@Controller('observability')
export class PublicIntroController {
  constructor(private readonly observability: ObservabilityService) {}

  /** 公开汇报页（/intro/）打开上报：无需登录，由服务端记录时间、IP、UA */
  @Post('intro-view')
  introView(@Body() dto: IntroViewDto, @Req() req: Request) {
    return this.observability.recordIntroView(dto, req);
  }
}

@Controller('observability')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class ObservabilityController {
  constructor(private readonly observability: ObservabilityService) {}

  @Get('overview')
  @RequirePermission('logs', 'view')
  overview(@CurrentUser() user: AuthUser) {
    return this.observability.overview(user);
  }

  @Get('logs')
  @RequirePermission('logs', 'view')
  logs(@Query() query: SystemLogQueryDto, @CurrentUser() user: AuthUser) {
    return this.observability.list(user, query);
  }

  /** 汇报页访问统计：打开次数、打开时间、来源 IP（日志页使用） */
  @Get('intro-views')
  @RequirePermission('logs', 'view')
  introViews(@Query() query: IntroViewQueryDto) {
    return this.observability.introViewOverview(query);
  }

  /** 筛选下拉用：业务模块 → 具体操作（静态清单，不查库） */
  @Get('log-filters')
  @RequirePermission('logs', 'view')
  logFilters() {
    return this.observability.logFilterOptions();
  }

  @Patch('feedback/:id/status')
  @RequirePermission('logs', 'edit')
  updateFeedbackStatus(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: FeedbackStatusDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.observability.updateFeedbackStatus(id, dto, user);
  }
}
