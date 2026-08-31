import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthUser, CurrentUser } from '../../common/current-user.decorator';
import { RequirePermission } from '../../common/require-permission.decorator';
import { ResolvedAccess } from '../access/access.service';
import { CurrentAccess } from '../access/current-access.decorator';
import { PermissionsGuard } from '../access/permissions.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import {
  CreateMaintenanceOrderDto,
  InspectMaintenanceOrderDto,
  MaintenanceQueryDto,
  SaveQuotaItemDto,
  SaveQuotaParamsDto,
  UpdateMaintenanceOrderDto,
} from './dto';
import { MaintenanceService } from './maintenance.service';

/**
 * 养护单（《房屋修理养护任务单》）。
 *
 * 两个权限位，别合成一个：
 * · maintenance-orders —— 填单、打印（办公室干的活）
 * · maintenance-inspect —— 查验并签名（物业经理干的活）
 * 合成一个的话，填单的人自己就能把自己填的单查验了，纸面上的三方签字就没意义了。
 */
@Controller()
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class MaintenanceController {
  constructor(private readonly service: MaintenanceService) {}

  // ---------- 预算定额配置 ----------

  /** 定额条目要给填单页做下拉，读权限跟着养护单走 */
  @Get('quota-items')
  @RequirePermission('maintenance-orders', 'view')
  listQuotaItems(@CurrentUser() user: AuthUser) {
    return this.service.listQuotaItems(user);
  }

  @Post('quota-items')
  @RequirePermission('maintenance-orders', 'edit')
  createQuotaItem(@Body() dto: SaveQuotaItemDto, @CurrentUser() user: AuthUser) {
    return this.service.createQuotaItem(dto, user);
  }

  @Patch('quota-items/:id')
  @RequirePermission('maintenance-orders', 'edit')
  updateQuotaItem(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: SaveQuotaItemDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.updateQuotaItem(id, dto, user);
  }

  @Delete('quota-items/:id')
  @RequirePermission('maintenance-orders', 'delete')
  removeQuotaItem(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.service.removeQuotaItem(id, user);
  }

  @Get('quota-params')
  @RequirePermission('maintenance-orders', 'view')
  getQuotaParams(@CurrentUser() user: AuthUser) {
    return this.service.getQuotaParams(user);
  }

  @Put('quota-params')
  @RequirePermission('maintenance-orders', 'edit')
  saveQuotaParams(@Body() dto: SaveQuotaParamsDto, @CurrentUser() user: AuthUser) {
    return this.service.saveQuotaParams(dto, user);
  }

  // ---------- 养护单 ----------

  @Get('maintenance-orders')
  @RequirePermission('maintenance-orders', 'view')
  list(
    @Query() query: MaintenanceQueryDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.service.list(query, user, access);
  }

  /** 必须声明在 :id 之前，否则被 ParseIntPipe 吃掉直接 400 */
  @Get('maintenance-orders/by-work-order/:workOrderId')
  @RequirePermission('maintenance-orders', 'view')
  byWorkOrder(
    @Param('workOrderId', ParseIntPipe) workOrderId: number,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.service.findByWorkOrder(workOrderId, user, access);
  }

  @Get('maintenance-orders/:id')
  @RequirePermission('maintenance-orders', 'view')
  getOne(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.service.getOne(id, user, access);
  }

  @Post('maintenance-orders')
  @RequirePermission('maintenance-orders', 'edit')
  create(
    @Body() dto: CreateMaintenanceOrderDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.service.createFromWorkOrder(dto, user, access);
  }

  @Patch('maintenance-orders/:id')
  @RequirePermission('maintenance-orders', 'edit')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateMaintenanceOrderDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.service.update(id, dto, user, access);
  }

  /** 查验只认「养护单查验」这一格，填单权限再大也点不了 */
  @Post('maintenance-orders/:id/inspect')
  @RequirePermission('maintenance-inspect', 'view')
  inspect(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: InspectMaintenanceOrderDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.service.inspect(id, dto, user, access);
  }

  @Delete('maintenance-orders/:id')
  @RequirePermission('maintenance-orders', 'delete')
  remove(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.service.voidOne(id, user, access);
  }
}
