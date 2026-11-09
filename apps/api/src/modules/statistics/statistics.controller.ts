import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../../common/current-user.decorator';
import { RequirePermission } from '../../common/require-permission.decorator';
import { ResolvedAccess } from '../access/access.service';
import { CurrentAccess } from '../access/current-access.decorator';
import { PermissionsGuard } from '../access/permissions.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import {
  StatisticsAnnualDetailQueryDto,
  StatisticsAnnualQueryDto,
  StatisticsBillsQueryDto,
} from './dto';
import { StatisticsService } from './statistics.service';

/** 统计汇总报表：全部只读、复用 business:view 权限，数据范围由管理处→小区映射收敛。 */
@Controller('statistics')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class StatisticsController {
  constructor(private readonly statisticsService: StatisticsService) {}

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
}
