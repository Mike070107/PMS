import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseIntPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AuthUser, CurrentUser } from '../../common/current-user.decorator';
import { RequirePermission } from '../../common/require-permission.decorator';
import { CurrentAccess } from '../access/current-access.decorator';
import { ResolvedAccess } from '../access/access.service';
import { PermissionsGuard } from '../access/permissions.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AccessCardIssuanceService } from './access-card-issuance.service';
import {
  AgentHeartbeatDto,
  AgentReportDto,
  CreateAccessCardIssueDto,
  EnrollAccessCardAgentDto,
  LegacyHistoryReportDto,
} from './dto';
import { bearerToken } from './agent-auth';

@Controller('access-card-issuance')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AccessCardIssuanceController {
  constructor(private readonly service: AccessCardIssuanceService) {}

  @Get('readiness')
  @RequirePermission('business', 'view')
  readiness(@CurrentUser() user: AuthUser) {
    return this.service.readiness(user);
  }

  @Post('agents')
  @RequirePermission('business', 'edit')
  enrollAgent(@Body() dto: EnrollAccessCardAgentDto, @CurrentUser() user: AuthUser) {
    return this.service.enrollAgent(dto, user);
  }

  @Get('houses/:houseId/context')
  @RequirePermission('business', 'view')
  houseContext(
    @Param('houseId', ParseIntPipe) houseId: number,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.service.getHouseContext(houseId, user, access);
  }

  @Post('batches')
  @RequirePermission('business', 'edit')
  create(
    @Body() dto: CreateAccessCardIssueDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.service.create(dto, user, access);
  }

  @Get('batches/:id')
  @RequirePermission('business', 'view')
  getBatch(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.service.getBatch(id, user);
  }

  @Post('batches/:id/simulate-next')
  @RequirePermission('business', 'edit')
  simulateNext(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.service.simulateNext(id, user);
  }

  @Post('batches/:id/simulate-legacy-sync')
  @RequirePermission('business', 'edit')
  simulateLegacySync(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.service.simulateLegacySync(id, user);
  }
}

/** Windows 本地代理专用入口：不用员工 JWT，只接受一次性注册后保存的代理凭据。 */
@Controller('access-card-agent')
export class AccessCardAgentController {
  constructor(private readonly service: AccessCardIssuanceService) {}

  @Post('heartbeat')
  heartbeat(
    @Headers('x-agent-id') agentKey: string,
    @Headers('authorization') authorization: string,
    @Body() dto: AgentHeartbeatDto,
  ) {
    return this.service.heartbeat(agentKey, bearerToken(authorization), dto);
  }

  @Post('claim')
  claim(
    @Headers('x-agent-id') agentKey: string,
    @Headers('authorization') authorization: string,
  ) {
    return this.service.claimAgentTask(agentKey, bearerToken(authorization));
  }

  @Post('report')
  report(
    @Headers('x-agent-id') agentKey: string,
    @Headers('authorization') authorization: string,
    @Body() dto: AgentReportDto,
  ) {
    return this.service.reportAgentTask(agentKey, bearerToken(authorization), dto);
  }

  @Post('legacy-history/claim')
  claimLegacyHistory(
    @Headers('x-agent-id') agentKey: string,
    @Headers('authorization') authorization: string,
  ) {
    return this.service.claimLegacyHistory(agentKey, bearerToken(authorization));
  }

  @Post('legacy-history/report')
  reportLegacyHistory(
    @Headers('x-agent-id') agentKey: string,
    @Headers('authorization') authorization: string,
    @Body() dto: LegacyHistoryReportDto,
  ) {
    return this.service.reportLegacyHistory(agentKey, bearerToken(authorization), dto);
  }
}
