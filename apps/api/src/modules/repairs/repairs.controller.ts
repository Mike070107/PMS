import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthUser, CurrentUser } from '../../common/current-user.decorator';
import { UserRole } from '../../common/enums';
import { RequirePermission } from '../../common/require-permission.decorator';
import { Roles } from '../../common/roles.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ResolvedAccess } from '../access/access.service';
import { CurrentAccess } from '../access/current-access.decorator';
import { RolesOrPermissionGuard } from '../access/roles-or-permission.guard';
import {
  AssignWorkOrderDto,
  CancelWorkOrderDto,
  CompleteWorkOrderDto,
  CreateRepairRequestDto,
  NeedMaterialDto,
  ReorderRepairTypeRulesDto,
  ReviewWorkOrderDto,
  UpdateMissingMaterialsDto,
  UpsertRepairTypeRuleDto,
  WorkOrdersQueryDto,
} from './dto';
import { RepairsService } from './repairs.service';

/**
 * 双轨鉴权：@Roles 只保留小程序端业务身份（业主/维修工），
 * 管理后台一律走 @RequirePermission('work-orders', ...) 的角色权限矩阵。
 * 原先写在 @Roles 里的 office/manager/admin 由权限矩阵覆盖
 * （存量账号有自动种的兼容角色，见 docs/rbac-design.md）。
 */
@Controller()
@UseGuards(JwtAuthGuard, RolesOrPermissionGuard)
export class RepairsController {
  constructor(private readonly repairsService: RepairsService) {}

  @Get('repair-type-rules')
  @RequirePermission('work-orders', 'view')
  listRepairTypeRules(@CurrentUser() user: AuthUser) {
    return this.repairsService.listRepairTypeRules(user);
  }

  @Post('repair-type-rules')
  @RequirePermission('work-orders', 'edit')
  createRepairTypeRule(
    @Body() dto: UpsertRepairTypeRuleDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.repairsService.createRepairTypeRule(dto, user);
  }

  @Patch('repair-type-rules/:id')
  @RequirePermission('work-orders', 'edit')
  updateRepairTypeRule(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpsertRepairTypeRuleDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.repairsService.updateRepairTypeRule(id, dto, user);
  }

  @Delete('repair-type-rules/:id')
  @RequirePermission('work-orders', 'delete')
  deleteRepairTypeRule(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
  ) {
    return this.repairsService.deleteRepairTypeRule(id, user);
  }

  @Post('repair-type-rules/reorder')
  @RequirePermission('work-orders', 'edit')
  reorderRepairTypeRules(
    @Body() dto: ReorderRepairTypeRulesDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.repairsService.reorderRepairTypeRules(dto.ids, user);
  }

  /**
   * 报修类型（含关键词），任意登录角色可读。
   * 业主端用它渲染类型选项，并在「随手拍报修」里按关键词自动判定类型。
   * 只出启用中的类型，不下发派单规则（默认维修工 / 时限属于内部配置）。
   */
  @Get('repair-types')
  @Roles(UserRole.OWNER, UserRole.TECHNICIAN)
  @RequirePermission('work-orders', 'view')
  listPublicRepairTypes(@CurrentUser() user: AuthUser) {
    return this.repairsService.listPublicRepairTypes(user);
  }

  @Get('repair-suggestions')
  @RequirePermission('work-orders', 'view')
  listRepairSuggestions(@CurrentUser() user: AuthUser) {
    return this.repairsService.listRepairSuggestions(user);
  }

  /**
   * 维修说明的常用话术（维修工完工时点选）。
   * 维修工必须能读 —— 这就是给他们用的。
   */
  @Get('repair-action-suggestions')
  @Roles(UserRole.TECHNICIAN)
  @RequirePermission('work-orders', 'view')
  listActionSuggestions(@CurrentUser() user: AuthUser) {
    return this.repairsService.listActionSuggestions(user);
  }

  @Get('repair-history')
  @RequirePermission('work-orders', 'view')
  listRepairHistory(
    @Query() query: WorkOrdersQueryDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.repairsService.listRepairHistory(query, user, access);
  }

  @Post('repair-requests')
  @Roles(UserRole.OWNER)
  @RequirePermission('work-orders', 'edit')
  submitOwnerRepair(
    @Body() dto: CreateRepairRequestDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.repairsService.submitOwnerRepair(dto, user);
  }

  @Post('repair-requests/office')
  @RequirePermission('work-orders', 'edit')
  submitOfficeRepair(
    @Body() dto: CreateRepairRequestDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.repairsService.submitOfficeRepair(dto, user, access);
  }

  @Get('work-orders')
  @Roles(UserRole.TECHNICIAN, UserRole.OWNER)
  @RequirePermission('work-orders', 'view')
  listWorkOrders(
    @Query() query: WorkOrdersQueryDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.repairsService.listWorkOrders(query, user, access);
  }

  @Get('work-orders/stats')
  @RequirePermission('work-orders', 'view')
  getWorkOrderStats(
    @Query() query: WorkOrdersQueryDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.repairsService.getWorkOrderStats(query, user, access);
  }

  @Get('work-orders/:id')
  @Roles(UserRole.TECHNICIAN, UserRole.OWNER)
  @RequirePermission('work-orders', 'view')
  getWorkOrder(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.repairsService.getWorkOrder(id, user, access);
  }

  @Post('work-orders/:id/assign')
  @RequirePermission('work-orders', 'edit')
  assignWorkOrder(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AssignWorkOrderDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.repairsService.assignWorkOrder(id, dto, user, access);
  }

  @Post('work-orders/:id/accept')
  @Roles(UserRole.TECHNICIAN)
  @RequirePermission('work-orders', 'edit')
  acceptWorkOrder(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
  ) {
    return this.repairsService.acceptWorkOrder(id, user);
  }

  @Post('work-orders/:id/complete')
  @Roles(UserRole.TECHNICIAN)
  @RequirePermission('work-orders', 'edit')
  completeWorkOrder(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CompleteWorkOrderDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.repairsService.completeWorkOrder(id, dto, user);
  }

  @Post('work-orders/:id/need-material')
  @Roles(UserRole.TECHNICIAN)
  @RequirePermission('work-orders', 'edit')
  markNeedMaterial(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: NeedMaterialDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.repairsService.markNeedMaterial(id, dto, user);
  }

  /**
   * 这张工单能领哪些料：本小区仓的库存清单。
   * 维修工必须能读 —— 「添加用料」就是给他用的；仓库由工单反查，端上不用知道仓库 id。
   */
  @Get('work-orders/:id/stock-options')
  @Roles(UserRole.TECHNICIAN)
  @RequirePermission('work-orders', 'view')
  listWorkOrderStockOptions(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
  ) {
    return this.repairsService.listWorkOrderStockOptions(id, user);
  }

  /**
   * 办公室在 web 端补建 SKU 后回来更正缺料清单（不新开采购申请）。
   * 维修工手填的名称只有办公室能对上库里的 SKU，所以这个入口不给 TECHNICIAN。
   */
  @Post('work-orders/:id/missing-materials')
  @RequirePermission('work-orders', 'edit')
  updateMissingMaterials(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateMissingMaterialsDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.repairsService.updateMissingMaterials(id, dto, user);
  }

  @Post('work-orders/:id/review')
  @Roles(UserRole.OWNER)
  @RequirePermission('work-orders', 'edit')
  reviewWorkOrder(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ReviewWorkOrderDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.repairsService.reviewWorkOrder(id, dto, user);
  }

  @Post('work-orders/:id/cancel')
  @Roles(UserRole.OWNER)
  @RequirePermission('work-orders', 'edit')
  cancelWorkOrder(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CancelWorkOrderDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.repairsService.cancelWorkOrder(id, dto, user);
  }

  @Post('work-orders/:id/urge')
  @Roles(UserRole.OWNER)
  @RequirePermission('work-orders', 'edit')
  urgeWorkOrder(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
  ) {
    return this.repairsService.urgeWorkOrder(id, user);
  }
}
