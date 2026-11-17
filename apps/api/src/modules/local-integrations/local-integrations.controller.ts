import { Body, Controller, ForbiddenException, Get, Headers, Param, ParseIntPipe, Post, UseGuards } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../../common/current-user.decorator';
import { RequirePermission } from '../../common/require-permission.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../access/permissions.guard';
import { CurrentAccess } from '../access/current-access.decorator';
import { ResolvedAccess } from '../access/access.service';
import { bearerToken } from '../access-card-issuance/agent-auth';
import { LocalIntegrationsService } from './local-integrations.service';
import { EnrollIntegrationDto, IntegrationEnabledDto, IntegrationHeartbeatDto, IntegrationReportDto, IntegrationTaskDto } from './dto';

// Connection administration exposes tenant-wide local resources. Partial community viewers
// must not gain tenant-wide database access merely by knowing an integration/task identifier.
function fullScope(access: ResolvedAccess) {
  if (!access.scopeAll) throw new ForbiddenException('标准接入管理需要企业全部小区范围');
}
@Controller('local-integrations/v1')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class LocalIntegrationsController {
  constructor(private readonly service: LocalIntegrationsService) {}
  @Get()
  @RequirePermission('business', 'view')
  list(@CurrentUser() user: AuthUser, @CurrentAccess() access: ResolvedAccess) { fullScope(access); return this.service.list(user); }
  @Post()
  @RequirePermission('business', 'edit')
  enroll(@Body() dto: EnrollIntegrationDto, @CurrentUser() user: AuthUser, @CurrentAccess() access: ResolvedAccess) { fullScope(access); return this.service.enroll(dto, user); }
  @Post(':key/enabled')
  @RequirePermission('business', 'edit')
  enable(@Param('key') key: string, @Body() dto: IntegrationEnabledDto, @CurrentUser() user: AuthUser, @CurrentAccess() access: ResolvedAccess) { fullScope(access); return this.service.enable(key, dto.enabled, user); }
  @Post(':key/rotate-secret')
  @RequirePermission('business', 'edit')
  rotate(@Param('key') key: string, @CurrentUser() user: AuthUser, @CurrentAccess() access: ResolvedAccess) { fullScope(access); return this.service.rotate(key, user); }
  @Post(':key/tasks')
  @RequirePermission('business', 'edit')
  createTask(@Param('key') key: string, @Body() dto: IntegrationTaskDto, @CurrentUser() user: AuthUser, @CurrentAccess() access: ResolvedAccess) { fullScope(access); return this.service.createTask(key, dto, user); }
  @Get(':key/tasks/:id')
  @RequirePermission('business', 'view')
  task(@Param('key') key: string, @Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser, @CurrentAccess() access: ResolvedAccess) { fullScope(access); return this.service.getTask(key, id, user); }
}

@Controller('local-integration-agent/v1/:key')
export class LocalIntegrationAgentController {
  constructor(private readonly service: LocalIntegrationsService) {}
  @Post('heartbeat')
  heartbeat(@Param('key') key: string, @Headers('authorization') auth: string, @Body() dto: IntegrationHeartbeatDto) { return this.service.heartbeat(key, bearerToken(auth), dto); }
  @Post('claim')
  claim(@Param('key') key: string, @Headers('authorization') auth: string) { return this.service.claim(key, bearerToken(auth)); }
  @Post('tasks/:id/report')
  report(@Param('key') key: string, @Headers('authorization') auth: string, @Param('id', ParseIntPipe) id: number, @Body() dto: IntegrationReportDto) { return this.service.report(key, bearerToken(auth), id, dto); }
}
