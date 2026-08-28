import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../../common/current-user.decorator';
import { RequirePermission } from '../../common/require-permission.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ResolvedAccess } from '../access/access.service';
import { CurrentAccess } from '../access/current-access.decorator';
import { PermissionsGuard } from '../access/permissions.guard';
import {
  MaterialUsageReportDto,
  ReportOptionsDto,
  StaffReportDto,
  StockReportDto,
  WorkOrderReportDto,
} from './dto';
import { ReportsService } from './reports.service';

/** 报表查询：全部只读，挂「报表查询」页的查看权；数据范围跟角色范围 / 管理处视角走 */
@Controller('reports')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  @Get('options')
  @RequirePermission('reports', 'view')
  options(
    @Query() query: ReportOptionsDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.reportsService.options(query, user, access);
  }

  @Get('work-orders')
  @RequirePermission('reports', 'view')
  workOrders(
    @Query() query: WorkOrderReportDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.reportsService.workOrders(query, user, access);
  }

  @Get('staff')
  @RequirePermission('reports', 'view')
  staff(
    @Query() query: StaffReportDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.reportsService.staff(query, user, access);
  }

  @Get('stock')
  @RequirePermission('reports', 'view')
  stock(
    @Query() query: StockReportDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.reportsService.stock(query, user, access);
  }

  @Get('material-usage')
  @RequirePermission('reports', 'view')
  materialUsage(
    @Query() query: MaterialUsageReportDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.reportsService.materialUsage(query, user, access);
  }
}
