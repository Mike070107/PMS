import { Body, Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { AuthUser, CurrentUser } from '../../common/current-user.decorator';
import { RequirePermission } from '../../common/require-permission.decorator';
import { PermissionsGuard } from '../access/permissions.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ClientErrorDto, PageViewDto, SystemLogQueryDto } from './dto';
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
}
