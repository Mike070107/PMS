import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthUser, CurrentUser } from '../../common/current-user.decorator';
import { RequirePermission } from '../../common/require-permission.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ResolvedAccess } from '../access/access.service';
import { CurrentAccess } from '../access/current-access.decorator';
import { PermissionsGuard } from '../access/permissions.guard';
import {
  BusinessRuleQueryDto,
  BusinessSearchDto,
  CompleteBusinessDto,
  EstimateBusinessDto,
  UpsertBusinessRuleDto,
  HouseholdParkingQueryDto,
  ReviewDecisionDto,
} from './dto';
import { BusinessService } from './business.service';
import { BusinessExecutionService } from './business-execution.service';
import { scopeCommunityIds } from '../access/scope.util';

/** 前台收费（纯管理端页面），走页面权限矩阵。 */
@Controller('business')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class BusinessController {
  constructor(
    private readonly businessService: BusinessService,
    private readonly execution: BusinessExecutionService,
  ) {}

  @Get('rules')
  @RequirePermission('business', 'view')
  listRules(
    @Query() query: BusinessRuleQueryDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.businessService.listRules(query, user, access);
  }

  @Post('rules')
  @RequirePermission('business', 'edit')
  createRule(
    @Body() dto: UpsertBusinessRuleDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.businessService.createRule(dto, user, access);
  }

  @Patch('rules/:id')
  @RequirePermission('business', 'edit')
  updateRule(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpsertBusinessRuleDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.businessService.updateRule(id, dto, user, access);
  }

  /** 物业经理：待审核的非标准停车续期 */
  @Get('reviews')
  @RequirePermission(['app:approve-manager', 'business'], 'view')
  reviews(@CurrentUser() user: AuthUser, @CurrentAccess() access: ResolvedAccess) {
    return this.businessService.listReviews(user, access);
  }

  @Post('transactions/:id/approve')
  @RequirePermission('app:approve-manager', 'edit')
  approveReview(@Param('id', ParseIntPipe) id: number, @Body() dto: ReviewDecisionDto, @CurrentUser() user: AuthUser, @CurrentAccess() access: ResolvedAccess) {
    return this.businessService.decideReview(id, true, dto.reason, user, access);
  }

  @Post('transactions/:id/reject')
  @RequirePermission('app:approve-manager', 'edit')
  rejectReview(@Param('id', ParseIntPipe) id: number, @Body() dto: ReviewDecisionDto, @CurrentUser() user: AuthUser, @CurrentAccess() access: ResolvedAccess) {
    return this.businessService.decideReview(id, false, dto.reason, user, access);
  }

  /** 收银台：一户在各停车系统登记的车（德立云实时；本地库由前端发现场查询） */
  @Get('household-parking')
  @RequirePermission('business', 'view')
  householdParking(@Query() query: HouseholdParkingQueryDto, @CurrentUser() user: AuthUser, @CurrentAccess() access: ResolvedAccess) {
    return this.businessService.householdParking(query.houseId, user, access);
  }

  @Get('search')
  @RequirePermission('business', 'view')
  search(
    @Query() query: BusinessSearchDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.businessService.search(query, user, access);
  }

  @Post('estimate')
  @RequirePermission('business', 'view')
  estimate(@Body() dto: EstimateBusinessDto, @CurrentUser() user: AuthUser) {
    return this.businessService.estimate(dto, user);
  }

  @Post('complete')
  @RequirePermission('business', 'edit')
  complete(
    @Body() dto: CompleteBusinessDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.businessService.complete(dto, user, access);
  }

  @Get('transactions')
  @RequirePermission('business', 'view')
  listTransactions(@CurrentUser() user: AuthUser, @CurrentAccess() access: ResolvedAccess) {
    return this.businessService.listTransactions(user, access);
  }

  /** 停车目标目录：配置收费标准、收银台按小区选停车场 */
  @Get('parking-targets')
  @RequirePermission('business', 'view')
  parkingTargets() {
    return this.businessService.parkingTargets();
  }

  /** 执行层：待处理（排队/执行中/重试/转人工/失败/演练）的停车同步 */
  @Get('execution/pending')
  @RequirePermission('business', 'view')
  executionPending(@CurrentUser() user: AuthUser, @CurrentAccess() access: ResolvedAccess) {
    return this.execution.pending(user.tenantId!, scopeCommunityIds(access));
  }

  /** 执行层：当前同步模式（off / dry-run / on），前端据此提示 */
  @Get('execution/mode')
  @RequirePermission('business', 'view')
  executionMode() {
    return { mode: this.execution.mode() };
  }

  /** 执行层：人工重试一笔（转人工 / 失败 / 演练 → 重新排队） */
  @Post('transactions/:id/retry-sync')
  @RequirePermission('business', 'edit')
  retrySync(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.execution.retry(id, user);
  }
}
