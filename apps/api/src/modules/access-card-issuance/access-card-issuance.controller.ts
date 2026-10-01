import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
  UseGuards,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
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
  AccessPermissionReportDto,
  AccessCardAuthorizationReportDto,
  CardPreflightDto,
  CreateAccessCardIssueDto,
  CreateAccessCardAuthorizationDto,
  EnrollAccessCardAgentDto,
  LegacyCardCheckReportDto,
  LegacyHistoryReportDto,
  CreateParkingQueryDto,
  CreateParkingOwnerUpdateDto,
  CreateParkingProofUploadDto,
  ParkingQueryReportDto,
  ParkingOwnerUpdateReportDto,
  ParkingHistoryQueryDto,
  CreateParkingOperationDto,
  ParkingOperationReportDto,
} from './dto';
import { ParkingProofService } from './parking-proof.service';
import { bearerToken } from './agent-auth';

@Controller('access-card-issuance')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AccessCardIssuanceController {
  constructor(
    private readonly service: AccessCardIssuanceService,
    private readonly parkingProof: ParkingProofService,
  ) {}

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

  @Post('parking/queries')
  @RequirePermission('business', 'view')
  createParkingQuery(@Body() dto: CreateParkingQueryDto, @CurrentUser() user: AuthUser) {
    return this.service.createParkingQuery(dto, user);
  }

  @Get('parking/queries/:id')
  @RequirePermission('business', 'view')
  getParkingQuery(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.service.getParkingQuery(id, user);
  }

  @Post('parking/owners/updates')
  @RequirePermission('business', 'edit')
  createParkingOwnerUpdate(@Body() dto: CreateParkingOwnerUpdateDto, @CurrentUser() user: AuthUser) {
    return this.service.createParkingOwnerUpdate(dto, user);
  }

  @Get('parking/owners/updates/:id')
  @RequirePermission('business', 'view')
  getParkingOwnerUpdate(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.service.getParkingOwnerUpdate(id, user);
  }

  @Post('parking/operations')
  @RequirePermission('business', 'edit')
  createParkingOperation(@Body() dto: CreateParkingOperationDto, @CurrentUser() user: AuthUser) {
    return this.service.createParkingOperation(dto, user);
  }

  @Get('parking/operations/:id')
  @RequirePermission('business', 'view')
  getParkingOperation(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.service.getParkingOperation(id, user);
  }

  @Post('parking/operations/:id/rollback')
  @RequirePermission('business', 'edit')
  rollbackParkingOperation(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.service.rollbackParkingOperation(id, user);
  }

  @Get('parking/history')
  @RequirePermission('business', 'view')
  getParkingHistory(@Query() query: ParkingHistoryQueryDto, @CurrentUser() user: AuthUser) {
    return this.service.getParkingHistory(query, user);
  }

  @Post('parking/proof-uploads')
  @RequirePermission('business', 'edit')
  createParkingProof(@Body() dto: CreateParkingProofUploadDto, @CurrentUser() user: AuthUser) {
    return this.parkingProof.create(dto, user);
  }

  @Get('parking/proof-uploads/:id')
  @RequirePermission('business', 'view')
  parkingProofStatus(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.parkingProof.status(id, user);
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

  @Post('houses/:houseId/history/:historyId/authorizations')
  @RequirePermission('business', 'edit')
  createHistoryAuthorization(
    @Param('houseId', ParseIntPipe) houseId: number,
    @Param('historyId', ParseIntPipe) historyId: number,
    @Body() dto: CreateAccessCardAuthorizationDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.service.createHistoryAuthorization(houseId, historyId, dto, user, access);
  }

  @Get('history-authorizations/:id')
  @RequirePermission('business', 'view')
  historyAuthorization(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.service.getHistoryAuthorization(id, user);
  }

  @Get('batches/:id')
  @RequirePermission('business', 'view')
  getBatch(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.service.getBatch(id, user);
  }

  @Post('batches/:batchId/items/:itemId/retry-access')
  @RequirePermission('business', 'edit')
  retryAccessUpload(
    @Param('batchId', ParseIntPipe) batchId: number,
    @Param('itemId', ParseIntPipe) itemId: number,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.retryAccessUpload(batchId, itemId, user);
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

/** 手机扫码上传页：短期随机 token 是唯一凭据，只能给指定车牌提交一份证明。 */
@Controller('parking-proof')
export class ParkingProofController {
  constructor(private readonly service: ParkingProofService) {}

  @Get('session')
  session(@Query('token') token: string) {
    return this.service.session(token || '');
  }

  @Post('submit')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 20 * 1024 * 1024 } }))
  submit(@Query('token') token: string, @UploadedFile() file?: Express.Multer.File) {
    return this.service.submit(token || '', file);
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

  @Post('card-preflight')
  cardPreflight(
    @Headers('x-agent-id') agentKey: string,
    @Headers('authorization') authorization: string,
    @Body() dto: CardPreflightDto,
  ) {
    return this.service.cardPreflight(agentKey, bearerToken(authorization), dto);
  }

  @Post('legacy-card-check/claim')
  claimLegacyCardCheck(
    @Headers('x-agent-id') agentKey: string,
    @Headers('authorization') authorization: string,
  ) {
    return this.service.claimLegacyCardCheck(agentKey, bearerToken(authorization));
  }

  @Post('legacy-card-check/report')
  reportLegacyCardCheck(
    @Headers('x-agent-id') agentKey: string,
    @Headers('authorization') authorization: string,
    @Body() dto: LegacyCardCheckReportDto,
  ) {
    return this.service.reportLegacyCardCheck(agentKey, bearerToken(authorization), dto);
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

  @Post('access-permissions/claim')
  claimAccessPermissions(
    @Headers('x-agent-id') agentKey: string,
    @Headers('authorization') authorization: string,
  ) {
    return this.service.claimAccessPermissions(agentKey, bearerToken(authorization));
  }

  @Post('access-permissions/report')
  reportAccessPermissions(
    @Headers('x-agent-id') agentKey: string,
    @Headers('authorization') authorization: string,
    @Body() dto: AccessPermissionReportDto,
  ) {
    return this.service.reportAccessPermissions(agentKey, bearerToken(authorization), dto);
  }

  @Post('history-authorizations/claim')
  claimHistoryAuthorization(
    @Headers('x-agent-id') agentKey: string,
    @Headers('authorization') authorization: string,
  ) {
    return this.service.claimHistoryAuthorization(agentKey, bearerToken(authorization));
  }

  @Post('history-authorizations/report')
  reportHistoryAuthorization(
    @Headers('x-agent-id') agentKey: string,
    @Headers('authorization') authorization: string,
    @Body() dto: AccessCardAuthorizationReportDto,
  ) {
    return this.service.reportHistoryAuthorization(agentKey, bearerToken(authorization), dto);
  }

  @Post('parking/queries/claim')
  claimParkingQuery(
    @Headers('x-agent-id') agentKey: string,
    @Headers('authorization') authorization: string,
  ) {
    return this.service.claimParkingQuery(agentKey, bearerToken(authorization));
  }

  @Post('parking/queries/report')
  reportParkingQuery(
    @Headers('x-agent-id') agentKey: string,
    @Headers('authorization') authorization: string,
    @Body() dto: ParkingQueryReportDto,
  ) {
    return this.service.reportParkingQuery(agentKey, bearerToken(authorization), dto);
  }

  @Post('parking/owners/updates/claim')
  claimParkingOwnerUpdate(
    @Headers('x-agent-id') agentKey: string,
    @Headers('authorization') authorization: string,
  ) {
    return this.service.claimParkingOwnerUpdate(agentKey, bearerToken(authorization));
  }

  @Post('parking/owners/updates/report')
  reportParkingOwnerUpdate(
    @Headers('x-agent-id') agentKey: string,
    @Headers('authorization') authorization: string,
    @Body() dto: ParkingOwnerUpdateReportDto,
  ) {
    return this.service.reportParkingOwnerUpdate(agentKey, bearerToken(authorization), dto);
  }

  @Post('parking/operations/claim')
  claimParkingOperation(
    @Headers('x-agent-id') agentKey: string,
    @Headers('authorization') authorization: string,
  ) {
    return this.service.claimParkingOperation(agentKey, bearerToken(authorization));
  }

  @Post('parking/operations/report')
  reportParkingOperation(
    @Headers('x-agent-id') agentKey: string,
    @Headers('authorization') authorization: string,
    @Body() dto: ParkingOperationReportDto,
  ) {
    return this.service.reportParkingOperation(agentKey, bearerToken(authorization), dto);
  }
}
