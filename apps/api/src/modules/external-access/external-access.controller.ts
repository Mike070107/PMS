import { Body, Controller, Get, Headers, Param, ParseIntPipe, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { AuthUser, CurrentUser } from '../../common/current-user.decorator';
import { RequirePermission } from '../../common/require-permission.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../access/permissions.guard';
import {
  CreateExternalAccessAppDto,
  CreateLanGatewayAgentDto,
  EnrollLanGatewayAgentDto,
  LanGatewayHeartbeatDto,
  UpdateExternalAccessAppDto,
  UpdateLanGatewayAgentDto,
} from './dto';
import { ExternalAccessService } from './external-access.service';

@Controller('external-access')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class ExternalAccessController {
  constructor(private readonly service: ExternalAccessService) {}

  @Get('apps')
  @RequirePermission('settings', 'view')
  list(@CurrentUser() user: AuthUser) {
    return this.service.list(user);
  }

  @Get('config')
  @RequirePermission('settings', 'view')
  configuration() {
    return this.service.configuration();
  }

  @Get('users')
  @RequirePermission('settings', 'view')
  users(@CurrentUser() user: AuthUser) {
    return this.service.users(user);
  }

  @Get('agents')
  @RequirePermission('settings', 'view')
  agents(@CurrentUser() user: AuthUser) {
    return this.service.listAgents(user);
  }

  @Post('agents')
  @RequirePermission('settings', 'edit')
  createAgent(@Body() dto: CreateLanGatewayAgentDto, @CurrentUser() user: AuthUser) {
    return this.service.createAgent(dto, user);
  }

  @Patch('agents/:id')
  @RequirePermission('settings', 'edit')
  updateAgent(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateLanGatewayAgentDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.updateAgent(id, dto, user);
  }

  @Post('agents/:id/install-code')
  @RequirePermission('settings', 'edit')
  rotateAgentInstallCode(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.service.rotateAgentInstallCode(id, user);
  }

  @Post('apps')
  @RequirePermission('settings', 'edit')
  create(@Body() dto: CreateExternalAccessAppDto, @CurrentUser() user: AuthUser) {
    return this.service.create(dto, user);
  }

  @Patch('apps/:id')
  @RequirePermission('settings', 'edit')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateExternalAccessAppDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.update(id, dto, user);
  }

  @Post('apps/:id/sync')
  @RequirePermission('settings', 'edit')
  sync(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.service.sync(id, user);
  }
}

/** Windows 内网应用连接助手入口：仅接受短期一次性配对密钥或设备凭据。 */
@Controller('external-access-agent')
export class ExternalAccessAgentController {
  constructor(private readonly service: ExternalAccessService) {}

  @Post('enroll')
  enroll(@Body() dto: EnrollLanGatewayAgentDto, @Req() req: Request) {
    return this.service.enrollAgent(dto, req.ip);
  }

  @Get('configuration')
  configuration(
    @Headers('x-agent-id') deviceKey: string,
    @Headers('authorization') authorization: string,
  ) {
    return this.service.agentConfiguration(deviceKey, bearerToken(authorization));
  }

  @Post('heartbeat')
  heartbeat(
    @Headers('x-agent-id') deviceKey: string,
    @Headers('authorization') authorization: string,
    @Body() dto: LanGatewayHeartbeatDto,
  ) {
    return this.service.agentHeartbeat(deviceKey, bearerToken(authorization), dto);
  }

  /** frps 仅从本机调用；路径密钥防止公网对设备令牌进行探测。 */
  @Post('frp-plugin/:pluginSecret')
  frpPlugin(
    @Param('pluginSecret') pluginSecret: string,
    @Query('op') operation: string,
    @Body() body: Record<string, any>,
  ) {
    return this.service.authorizeFrpOperation(pluginSecret, operation, body);
  }
}

function bearerToken(value: string) {
  const match = /^Bearer\s+(.+)$/i.exec(value || '');
  return match?.[1]?.trim() || '';
}
