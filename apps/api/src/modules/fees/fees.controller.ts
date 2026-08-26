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
import { RequirePermission } from '../../common/require-permission.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ResolvedAccess } from '../access/access.service';
import { CurrentAccess } from '../access/current-access.decorator';
import { PermissionsGuard } from '../access/permissions.guard';
import {
  ArrearsQueryDto,
  CancelBillsDto,
  CreateBillDto,
  CreateStandardDto,
  GenerateBillsDto,
  ImportFeesDto,
  ListBillsQueryDto,
  ListStandardsQueryDto,
  PayBillsDto,
  UpdateBillDto,
  UpdateStandardDto,
} from './dto';
import { FeesService } from './fees.service';

/**
 * 物业费（纯管理端页面），走页面权限矩阵。
 *
 * 列表一律服务端分页（{rows,total,page,pageSize}）—— 账单是「户 × 月 × 项目」，
 * 一个中等小区一年就是几万条，后台其它页那种「limit 5000 前端翻页」在这里撑不住。
 */
@Controller('fees')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class FeesController {
  constructor(private readonly feesService: FeesService) {}

  // ---------- 账单 ----------

  @Get('bills')
  @RequirePermission('fees', 'view')
  listBills(
    @Query() query: ListBillsQueryDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.feesService.listBills(query, user, access);
  }

  @Get('bills/summary')
  @RequirePermission('fees', 'view')
  billSummary(
    @Query() query: ListBillsQueryDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.feesService.billSummary(query, user, access);
  }

  @Get('arrears')
  @RequirePermission('fees', 'view')
  listArrears(
    @Query() query: ArrearsQueryDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.feesService.listArrears(query, user, access);
  }

  /** 一户的全部账单 + 收费标准（欠费页点「明细」） */
  @Get('houses/:houseId')
  @RequirePermission('fees', 'view')
  houseDetail(
    @Param('houseId', ParseIntPipe) houseId: number,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.feesService.houseDetail(houseId, user, access);
  }

  @Post('bills')
  @RequirePermission('fees', 'edit')
  createBill(
    @Body() dto: CreateBillDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.feesService.createBill(dto, user, access);
  }

  @Patch('bills/:id')
  @RequirePermission('fees', 'edit')
  updateBill(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateBillDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.feesService.updateBill(id, dto, user, access);
  }

  @Delete('bills/:id')
  @RequirePermission('fees', 'delete')
  deleteBill(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.feesService.deleteBill(id, user, access);
  }

  @Post('bills/pay')
  @RequirePermission('fees', 'edit')
  payBills(
    @Body() dto: PayBillsDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.feesService.payBills(dto, user, access);
  }

  @Post('bills/unpay')
  @RequirePermission('fees', 'edit')
  unpayBills(
    @Body() dto: CancelBillsDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.feesService.unpayBills(dto, user, access);
  }

  @Post('bills/cancel')
  @RequirePermission('fees', 'edit')
  cancelBills(
    @Body() dto: CancelBillsDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.feesService.cancelBills(dto, user, access);
  }

  @Post('bills/restore')
  @RequirePermission('fees', 'edit')
  restoreBills(
    @Body() dto: CancelBillsDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.feesService.restoreBills(dto, user, access);
  }

  @Post('bills/generate')
  @RequirePermission('fees', 'edit')
  generateBills(
    @Body() dto: GenerateBillsDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.feesService.generateBills(dto, user, access);
  }

  // ---------- 收费标准 ----------

  @Get('standards')
  @RequirePermission('fees', 'view')
  listStandards(
    @Query() query: ListStandardsQueryDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.feesService.listStandards(query, user, access);
  }

  @Post('standards')
  @RequirePermission('fees', 'edit')
  createStandard(
    @Body() dto: CreateStandardDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.feesService.createStandard(dto, user, access);
  }

  @Patch('standards/:id')
  @RequirePermission('fees', 'edit')
  updateStandard(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateStandardDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.feesService.updateStandard(id, dto, user, access);
  }

  @Delete('standards/:id')
  @RequirePermission('fees', 'delete')
  deleteStandard(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.feesService.deleteStandard(id, user, access);
  }

  // ---------- 导入 ----------

  /**
   * 老系统数据导入（收费标准 + 历史账单），按 legacy_ref 幂等。
   * 给一次性迁移脚本用，不在页面上暴露入口 —— 页面上的批量操作是「按标准生成账单」。
   */
  @Post('import')
  @RequirePermission('fees', 'edit')
  importFees(@Body() dto: ImportFeesDto, @CurrentUser() user: AuthUser) {
    return this.feesService.importFees(dto, user);
  }
}
