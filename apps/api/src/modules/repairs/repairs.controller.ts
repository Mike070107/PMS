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
import {
  OWNER_APP_ROLES,
  SELF_SCOPED_ROLES,
  STAFF_APP_ROLES,
  UserRole,
} from '../../common/enums';
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
  ParseRepairAddressDto,
  ReorderRepairTypeRulesDto,
  ReviewWorkOrderDto,
  UpdateMissingMaterialsDto,
  UpdateWorkOrderRepairTypeDto,
  UpdateWorkOrderSlaDto,
  UpsertRepairTypeRuleDto,
  WorkOrdersQueryDto,
} from './dto';
import { RepairsService } from './repairs.service';

/**
 * 双轨鉴权：@Roles 只保留小程序端业务身份，管理后台一律走
 * @RequirePermission('work-orders', ...) 的角色权限矩阵。
 * 原先写在 @Roles 里的 office/manager/admin 由权限矩阵覆盖
 * （存量账号有自动种的兼容角色，见 docs/rbac-design.md）。
 *
 * 业主端的接口必须放行整个 OWNER_APP_ROLES（业主 + 保安/居委会/业委会/
 * 物业工作人员）：代报身份用的就是业主端小程序，只写 OWNER 会把他们全部 403
 * （2026-08-21 实际踩过：业主档案里标成保安后小程序直接「没有权限」）。
 * 数据边界不靠这里：service 里按 submittedBy / 代报授权小区收敛。
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
  @Roles(...OWNER_APP_ROLES, ...STAFF_APP_ROLES)
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

  /**
   * 随手拍：从描述文字里识别报修地址（「一期24号302」→ 真实楼栋/房号）。
   * 鉴权与提交报修完全同一套 —— 能提单的人才需要识别地址。
   */
  @Post('repair-requests/parse-address')
  @Roles(...OWNER_APP_ROLES, ...STAFF_APP_ROLES)
  @RequirePermission('work-orders', 'edit')
  parseRepairAddress(
    @Body() dto: ParseRepairAddressDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.repairsService.parseRepairAddress(dto, user);
  }

  /** 两个小程序共用：业主端各身份 + 员工端（维修工/办公室巡查顺手报修） */
  @Post('repair-requests')
  @Roles(...OWNER_APP_ROLES, ...STAFF_APP_ROLES)
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
  @Roles(...SELF_SCOPED_ROLES, UserRole.TECHNICIAN)
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
  @Roles(...SELF_SCOPED_ROLES, UserRole.TECHNICIAN)
  @RequirePermission('work-orders', 'view')
  getWorkOrder(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.repairsService.getWorkOrder(id, user, access);
  }

  /** 更正类型弹窗用的关键词候选（从这单描述里挑「学进新类型」的词） */
  @Get('work-orders/:id/repair-type-hints')
  @RequirePermission('work-orders', 'edit')
  repairTypeCorrectionHints(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.repairsService.repairTypeCorrectionHints(id, user, access);
  }

  /** 设定/取消工单的要求完成截止时间（body 不带 slaDueAt = 取消） */
  @Patch('work-orders/:id/sla-due')
  @RequirePermission('work-orders', 'edit')
  updateWorkOrderSlaDue(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateWorkOrderSlaDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.repairsService.updateWorkOrderSlaDue(id, dto, user, access);
  }

  /** 后台更正工单类型；learnKeywords 同时写进新类型的判定关键词（自学习） */
  @Patch('work-orders/:id/repair-type')
  @RequirePermission('work-orders', 'edit')
  updateWorkOrderRepairType(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateWorkOrderRepairTypeDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.repairsService.updateWorkOrderRepairType(id, dto, user, access);
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
   * 这张工单能领哪些料：默认本小区仓，本小区没配仓库时给到有货的仓。
   * 维修工必须能读 —— 「添加用料」就是给他用的；不传 warehouseId 时由工单反查默认仓，
   * 端上切仓库才带上它。
   */
  @Get('work-orders/:id/stock-options')
  @Roles(UserRole.TECHNICIAN)
  @RequirePermission('work-orders', 'view')
  listWorkOrderStockOptions(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
    @Query('warehouseId') warehouseId?: string,
  ) {
    const picked = Number(warehouseId);
    return this.repairsService.listWorkOrderStockOptions(
      id,
      user,
      Number.isFinite(picked) && picked > 0 ? picked : undefined,
    );
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
  @Roles(...SELF_SCOPED_ROLES)
  @RequirePermission('work-orders', 'edit')
  reviewWorkOrder(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ReviewWorkOrderDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.repairsService.reviewWorkOrder(id, dto, user);
  }

  @Post('work-orders/:id/cancel')
  @Roles(...SELF_SCOPED_ROLES)
  @RequirePermission('work-orders', 'edit')
  cancelWorkOrder(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CancelWorkOrderDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.repairsService.cancelWorkOrder(id, dto, user);
  }

  @Post('work-orders/:id/urge')
  @Roles(...SELF_SCOPED_ROLES)
  @RequirePermission('work-orders', 'edit')
  urgeWorkOrder(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
  ) {
    return this.repairsService.urgeWorkOrder(id, user);
  }
}
