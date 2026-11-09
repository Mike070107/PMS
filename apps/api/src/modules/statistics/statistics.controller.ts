import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../../common/current-user.decorator';
import { RequirePermission } from '../../common/require-permission.decorator';
import { ResolvedAccess } from '../access/access.service';
import { CurrentAccess } from '../access/current-access.decorator';
import { PermissionsGuard } from '../access/permissions.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CollectionStatisticsService } from './collection.service';
import {
  CollectionDailyQueryDto,
  CollectionDetailQueryDto,
  CollectionFeeNatureQueryDto,
  CollectionMonthlyQueryDto,
  CollectionSummaryQueryDto,
  StatisticsAnnualDetailQueryDto,
  StatisticsAnnualQueryDto,
  StatisticsBillsQueryDto,
} from './dto';
import { StatisticsService } from './statistics.service';

/** 统计汇总报表：全部只读、复用 business:view 权限，数据范围由管理处→小区映射收敛。 */
@Controller('statistics')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class StatisticsController {
  constructor(
    private readonly statisticsService: StatisticsService,
    private readonly collectionService: CollectionStatisticsService,
  ) {}

  @Get('options')
  @RequirePermission('business', 'view')
  options(@CurrentUser() user: AuthUser, @CurrentAccess() access: ResolvedAccess) {
    return this.statisticsService.options(user, access);
  }

  @Get('annual')
  @RequirePermission('business', 'view')
  annual(
    @Query() query: StatisticsAnnualQueryDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.statisticsService.annual(query, user, access);
  }

  @Get('annual/detail')
  @RequirePermission('business', 'view')
  annualDetail(
    @Query() query: StatisticsAnnualDetailQueryDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.statisticsService.annualDetail(query, user, access);
  }

  @Get('annual/detail/bills')
  @RequirePermission('business', 'view')
  annualDetailBills(
    @Query() query: StatisticsBillsQueryDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.statisticsService.annualDetailBills(query, user, access);
  }

  /** P2-A 收费汇总：实收/退款按收费项目/管理处/收款方式/收款人分组。 */
  @Get('collection/summary')
  @RequirePermission('business', 'view')
  collectionSummary(
    @Query() query: CollectionSummaryQueryDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.collectionService.collectionSummary(query, user, access);
  }

  /** P2-A 实收明细：逐笔账单，合计 = 实收 - 退款。 */
  @Get('collection/fee-nature')
  @RequirePermission('business', 'view')
  collectionFeeNature(
    @Query() query: CollectionFeeNatureQueryDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.collectionService.collectionFeeNature(query, user, access);
  }

  @Get('collection/detail')
  @RequirePermission('business', 'view')
  collectionDetail(
    @Query() query: CollectionDetailQueryDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.collectionService.collectionDetail(query, user, access);
  }

  /** P2-A 日常收费项目收款日报表。 */
  @Get('daily')
  @RequirePermission('business', 'view')
  daily(
    @Query() query: CollectionDailyQueryDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.collectionService.daily(query, user, access);
  }

  /** P2-A 月报表。 */
  @Get('monthly')
  @RequirePermission('business', 'view')
  monthly(
    @Query() query: CollectionMonthlyQueryDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.collectionService.monthly(query, user, access);
  }
}
