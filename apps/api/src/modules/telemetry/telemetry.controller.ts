import { Body, Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { AuthUser, CurrentUser } from '../../common/current-user.decorator';
import { RequirePermission } from '../../common/require-permission.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../access/permissions.guard';
import { LoginHistoryQueryDto, PageUsageDrilldownQueryDto, PageUsageQueryDto, PageViewsDto } from './telemetry.dto';
import { TelemetryService } from './telemetry.service';

@Controller('telemetry')
export class TelemetryController {
  constructor(private readonly telemetry: TelemetryService) {}

  /** 页面访问上报：任何登录用户可写；服务端补租户/用户/IP/UA 与时间。 */
  @Post('page-views')
  @UseGuards(JwtAuthGuard)
  pageViews(@Body() dto: PageViewsDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    return this.telemetry.recordPageViews(user, dto, req);
  }

  /** 页面使用统计：使用日志页面权限。 */
  @Get('page-usage')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermission('logs', 'view')
  pageUsage(@Query() query: PageUsageQueryDto, @CurrentUser() user: AuthUser) {
    return this.telemetry.pageUsage(user, query);
  }

  /** 使用统计下钻：顶层榜单点数字后按页面/用户查看明细或聚合。 */
  @Get('page-usage/drilldown')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermission('logs', 'view')
  pageUsageDrilldown(@Query() query: PageUsageDrilldownQueryDto, @CurrentUser() user: AuthUser) {
    return this.telemetry.pageUsageDrilldown(user, query);
  }

  /** 登录历史：优先复用 system_logs（登录审计），结构化失败原因来自 login_attempts。 */
  @Get('login-history')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermission('logs', 'view')
  loginHistory(@Query() query: LoginHistoryQueryDto, @CurrentUser() user: AuthUser) {
    return this.telemetry.loginHistory(user, query);
  }
}
