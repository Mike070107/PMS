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
  UpdateOfficeSuggestionSettingsDto,
  UpdateWorkOrderRepairTypeDto,
  UpdateWorkOrderSlaDto,
  UpsertRepairTypeRuleDto,
  WorkOrdersQueryDto,
  VoidWorkOrderDto,
} from './dto';
import { RepairsService } from './repairs.service';

/**
 * 鉴权：员工侧一律看角色的权限矩阵（work-orders 是网站那格，app:* 是小程序那几格）。
 * @Roles 只剩 OWNER 一种用法 —— 业主没有角色可绑，只能按端放行。
 * 2026-08-26 起 users.role 不再表达「他在物业里干哪一行」，别再往 @Roles 里加东西
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

  /** 报修类型配置弹窗的管理处 Tab：按本人范围算。必须声明在 repair-type-rules/:id 之前 */
  @Get('repair-type-rules/offices')
  @RequirePermission('work-orders', 'view')
  listRuleOffices(@CurrentUser() user: AuthUser) {
    return this.repairsService.listRuleOffices(user);
  }

  /** 某个管理处的「猜你想输」口径开关。同样要排在 repair-type-rules/:id 之前 */
  @Patch('repair-type-rules/offices/:id/suggestion-settings')
  @RequirePermission('work-orders', 'edit')
  updateOfficeSuggestionSettings(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateOfficeSuggestionSettingsDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.repairsService.updateOfficeSuggestionSettings(id, dto, user, access);
  }

  /** officeId 不传 = 公司默认模板；传了 = 该管理处那套（首次会从模板复制） */
  @Get('repair-type-rules')
  @RequirePermission('work-orders', 'view')
  listRepairTypeRules(
    @CurrentUser() user: AuthUser,
    @Query('officeId') officeId?: string,
    @CurrentAccess() access?: ResolvedAccess,
  ) {
    return this.repairsService.listRepairTypeRules(
      user,
      officeId ? Number(officeId) : null,
      access,
    );
  }

  @Post('repair-type-rules')
  @RequirePermission('work-orders', 'edit')
  createRepairTypeRule(
    @Body() dto: UpsertRepairTypeRuleDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.repairsService.createRepairTypeRule(dto, user, access);
  }

  @Patch('repair-type-rules/:id')
  @RequirePermission('work-orders', 'edit')
  updateRepairTypeRule(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpsertRepairTypeRuleDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.repairsService.updateRepairTypeRule(id, dto, user, access);
  }

  @Delete('repair-type-rules/:id')
  @RequirePermission('work-orders', 'delete')
  deleteRepairTypeRule(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.repairsService.deleteRepairTypeRule(id, user, access);
  }

  @Post('repair-type-rules/reorder')
  @RequirePermission('work-orders', 'edit')
  reorderRepairTypeRules(
    @Body() dto: ReorderRepairTypeRulesDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.repairsService.reorderRepairTypeRules(dto.ids, user, access);
  }

  /**
   * 报修类型（含关键词），任意登录角色可读。
   * 业主端用它渲染类型选项，并在「随手拍报修」里按关键词自动判定类型。
   * 只出启用中的类型，不下发派单规则（默认维修工 / 时限属于内部配置）。
   */
  @Get('repair-types')
  @Roles(...OWNER_APP_ROLES)
  @RequirePermission(
    ['work-orders', 'app:repair-create', 'app:pool', 'app:my-orders'],
    'view',
  )
  listPublicRepairTypes(
    @CurrentUser() user: AuthUser,
    @Query('communityId') communityId?: string,
    @CurrentAccess() access?: ResolvedAccess,
  ) {
    return this.repairsService.listPublicRepairTypes(
      user,
      communityId ? Number(communityId) : null,
      access,
    );
  }

  /**
   * 「猜你想输」。带 officeId / communityId 就按那个管理处的口径排序
   * （本处优先还是全公司，由管理处自己的开关决定）；都不带 = 全公司口径。
   */
  @Get('repair-suggestions')
  @RequirePermission('work-orders', 'view')
  listRepairSuggestions(
    @CurrentUser() user: AuthUser,
    @Query('officeId') officeId?: string,
    @Query('communityId') communityId?: string,
    @CurrentAccess() access?: ResolvedAccess,
  ) {
    return this.repairsService.listRepairSuggestions(user, {
      officeId: officeId ? Number(officeId) : null,
      communityId: communityId ? Number(communityId) : null,
    }, access);
  }

  /**
   * 维修说明的常用话术（维修工完工时点选）。
   * 维修工必须能读 —— 这就是给他们用的。
   */
  @Get('repair-action-suggestions')
  @RequirePermission(['work-orders', 'app:my-orders'], 'view')
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
  @Roles(...OWNER_APP_ROLES)
  // 「报修」这一格在矩阵里只有查看档，勾了就是能报修，别要求它有 edit ——
  // 要了的话维修工/保安/居委会这些代报角色一个都过不去（2026-08-31 修）
  @RequirePermission([['work-orders', 'edit'], ['app:repair-create', 'view']], 'edit')
  parseRepairAddress(
    @Body() dto: ParseRepairAddressDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.repairsService.parseRepairAddress(dto, user, access);
  }

  /** 两个小程序共用：业主端各身份 + 员工端（维修工/办公室巡查顺手报修） */
  @Post('repair-requests')
  @Roles(...OWNER_APP_ROLES)
  // 同上：代报角色靠 app:repair-create 的查看档提单
  @RequirePermission([['work-orders', 'edit'], ['app:repair-create', 'view']], 'edit')
  submitOwnerRepair(
    @Body() dto: CreateRepairRequestDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.repairsService.submitOwnerRepair(dto, user, access);
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
  @Roles(...OWNER_APP_ROLES)
  @RequirePermission(
    ['work-orders', 'app:pool', 'app:dispatch', 'app:my-orders', 'app:my-repairs'],
    'view',
  )
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

  /**
   * 派单台的维修工清单。必须声明在 `work-orders/:id` 之前 ——
   * Nest 按声明顺序匹配，排在后面会被 :id 吃掉（ParseIntPipe 直接 400）。
   */
  @Get('work-orders/technicians')
  @RequirePermission(['work-orders', 'app:dispatch'], 'edit')
  listDispatchTechnicians(
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
    @Query('officeId') officeId?: string,
    @Query('scope') scope?: string,
    @Query('communityId') communityId?: string,
  ) {
    // 报修类型配置用：scope=company 只列全公司范围的人；officeId=X 列范围覆盖 X 的人。都不传 = 全部能接单的人（派单用）
    const officeScope = scope === 'company' ? null : officeId ? Number(officeId) : undefined;
    return this.repairsService.listDispatchTechnicians(
      user,
      access,
      officeScope,
      communityId ? Number(communityId) : undefined,
    );
  }

  /** 工单池角标用：和 scope=pool 同一口径的条数。同样必须排在 :id 之前 */
  @Get('work-orders/pool-count')
  @RequirePermission(['app:pool', 'app:dispatch'], 'view')
  poolCount(@CurrentUser() user: AuthUser, @CurrentAccess() access: ResolvedAccess) {
    return this.repairsService.poolCount(user, access);
  }

  @Get('work-orders/:id')
  @Roles(...OWNER_APP_ROLES)
  @RequirePermission(
    ['work-orders', 'app:pool', 'app:dispatch', 'app:my-orders', 'app:my-repairs'],
    'view',
  )
  getWorkOrder(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.repairsService.getWorkOrder(id, user, access);
  }

  /**
   * 管理员作废工单：退回已领用库存、冲销报表口径并保留完整审计快照。
   * 必须是工单管理的独立“作废工单”权限，普通编辑权不能调用。
   */
  @Delete('work-orders/:id')
  @RequirePermission('work-orders', 'delete')
  voidWorkOrder(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: VoidWorkOrderDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.repairsService.voidWorkOrder(id, dto, user, access);
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

  /**
   * 办公室手动催修：催维修工在要求完成截止日期前修完。
   * 和定时的「超时没人接单」两回事 —— 那个催接单、系统发；这个催完成、人点发。
   */
  @Post('work-orders/:id/urge-repair')
  @RequirePermission(['work-orders', 'app:dispatch'], 'edit')
  urgeRepair(
    @Param('id', ParseIntPipe) id: number,
    @Body() _body: unknown,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.repairsService.urgeRepair(id, user, access);
  }

  /** 设定/取消工单的要求完成截止时间（body 不带 slaDueAt = 取消） */
  @Patch('work-orders/:id/sla-due')
  @RequirePermission(['work-orders', 'app:dispatch'], 'edit')
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
  @RequirePermission(['work-orders', 'app:dispatch'], 'edit')
  assignWorkOrder(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AssignWorkOrderDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.repairsService.assignWorkOrder(id, dto, user, access);
  }

  @Post('work-orders/:id/accept')
  @RequirePermission('app:pool', 'edit')
  acceptWorkOrder(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.repairsService.acceptWorkOrder(id, user, access);
  }

  @Post('work-orders/:id/complete')
  @RequirePermission('app:my-orders', 'edit')
  completeWorkOrder(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CompleteWorkOrderDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.repairsService.completeWorkOrder(id, dto, user, access);
  }

  @Post('work-orders/:id/need-material')
  @RequirePermission('app:my-orders', 'edit')
  markNeedMaterial(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: NeedMaterialDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.repairsService.markNeedMaterial(id, dto, user, access);
  }

  @Delete('work-orders/:id/materials/:usageId')
  @RequirePermission(['work-orders', 'app:my-orders'], 'edit')
  removeWorkOrderMaterial(
    @Param('id', ParseIntPipe) id: number,
    @Param('usageId', ParseIntPipe) usageId: number,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.repairsService.removeWorkOrderMaterial(id, usageId, user, access);
  }

  /**
   * 这张工单能领哪些料：默认本小区仓，本小区没配仓库时给到有货的仓。
   * 维修工必须能读 —— 「添加用料」就是给他用的；不传 warehouseId 时由工单反查默认仓，
   * 端上切仓库才带上它。
   */
  @Get('work-orders/:id/stock-options')
  @RequirePermission(['work-orders', 'app:my-orders', 'app:inventory'], 'view')
  listWorkOrderStockOptions(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
    @Query('warehouseId') warehouseId?: string,
  ) {
    const picked = Number(warehouseId);
    return this.repairsService.listWorkOrderStockOptions(
      id,
      user,
      access,
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
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.repairsService.updateMissingMaterials(id, dto, user, access);
  }

  @Post('work-orders/:id/review')
  @Roles(...OWNER_APP_ROLES)
  @RequirePermission(['work-orders', 'app:my-orders'], 'edit')
  reviewWorkOrder(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ReviewWorkOrderDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.repairsService.reviewWorkOrder(id, dto, user, access);
  }

  @Post('work-orders/:id/cancel')
  @Roles(...OWNER_APP_ROLES)
  @RequirePermission(['work-orders', 'app:my-orders'], 'edit')
  cancelWorkOrder(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CancelWorkOrderDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.repairsService.cancelWorkOrder(id, dto, user, access);
  }

  @Post('work-orders/:id/urge')
  @Roles(...OWNER_APP_ROLES)
  @RequirePermission(['work-orders', 'app:my-orders'], 'edit')
  urgeWorkOrder(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
  ) {
    return this.repairsService.urgeWorkOrder(id, user);
  }
}
