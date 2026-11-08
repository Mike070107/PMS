import { MisCollectionEffectQueryDto, MisCollectionFollowupDto, MisCollectionFollowupQueryDto, MisCollectionPrintDto } from './mis-fees.dto';
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
  StreamableFile,
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
  CreateCashierChargeDto,
  UpdateCashierContactDto,
  CreateBillDto,
  CreateStandardDto,
  FeeReportQueryDto,
  GenerateBillsDto,
  ImportFeesDto,
  ListBillsQueryDto,
  ListStandardsQueryDto,
  PageQueryDto,
  PayBillsDto,
  RefundReceiptDto,
  UpdateBillDto,
  UpdateStandardDto,
} from './dto';
import { buildReportWorkbook } from '../../common/report-excel';
import { FeesService } from './fees.service';
import { MisFeesService } from './mis-fees.service';
import { MisMirrorService } from './mis-mirror.service';
import { MisCollectionSmsService } from './mis-collection-sms.service';
import { CollectionTargetsService } from './collection-targets.service';
import { ListCollectionTargetsQueryDto, ScreenSummaryQueryDto, UpsertCollectionTargetDto } from './collection-targets.dto';
import {MisLedgerQueryDto} from './mis-ledger.dto';
import { MisFeesQueryDto, MisHouseSearchDto, MisResidentialQueryDto, MisCollectionPreviewDto, MisCollectionSmsStatsQueryDto, MisRecentPaymentsQueryDto, MisTodayQueryDto, MisTodayDetailsQueryDto } from './mis-fees.dto';

/**
 * 物业费（纯管理端页面），走页面权限矩阵。
 *
 * 列表一律服务端分页（{rows,total,page,pageSize}）—— 账单是「户 × 月 × 项目」，
 * 一个中等小区一年就是几万条，后台其它页那种「limit 5000 前端翻页」在这里撑不住。
 */
@Controller('fees')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class FeesController {
  constructor(private readonly feesService: FeesService,private readonly misFeesService:MisFeesService,private readonly misCollectionSmsService:MisCollectionSmsService,private readonly misMirrorService:MisMirrorService,private readonly collectionTargetsService:CollectionTargetsService) {}

  @Post('mis/collections/:id/prints')
  @RequirePermission('fees','edit')
  registerMisCollectionPrint(@Param('id',ParseIntPipe) id:number,@Body() dto:MisCollectionPrintDto,@CurrentUser() user:AuthUser,@CurrentAccess() access:ResolvedAccess){return this.misFeesService.registerCollectionPrint(id,dto,user,access);}

  @Post('mis/collections/:id/sms')
  @RequirePermission('fees','edit')
  misCollectionSms(@Param('id',ParseIntPipe) id:number,@Body() body:{real?:boolean},@CurrentUser() user:AuthUser,@CurrentAccess() access:ResolvedAccess){return this.misCollectionSmsService.sendBatch(id,user,access,body);}

  @Get('mis/collections/followups')
  @RequirePermission('fees','view')
  misFollowups(@Query() query:MisCollectionFollowupQueryDto,@CurrentUser() user:AuthUser,@CurrentAccess() access:ResolvedAccess){return this.misFeesService.collectionFollowups(query,user,access);}

  @Post('mis/collections/followups')
  @RequirePermission('fees','edit')
  recordMisFollowup(@Body() dto:MisCollectionFollowupDto,@CurrentUser() user:AuthUser,@CurrentAccess() access:ResolvedAccess){return this.misFeesService.recordCollectionFollowup(dto,user,access);}

  @Get('mis/collections/effect')
  @RequirePermission('fees','view')
  misCollectionEffects(@Query() query:MisCollectionEffectQueryDto,@CurrentUser() user:AuthUser,@CurrentAccess() access:ResolvedAccess){return this.misFeesService.collectionEffects(query,user,access);}

  @Get('mis/options')
  @RequirePermission('fees','view')
  misOptions(@CurrentUser() user:AuthUser,@CurrentAccess() access:ResolvedAccess){return this.misRead(user,()=>this.misFeesService.metadata(user,access),()=>this.misMirrorService.metadata(user,access));}

  @Get('mis/ledger')
  @RequirePermission('fees','view')
  misLedger(@Query() query:MisLedgerQueryDto,@CurrentUser() user:AuthUser,@CurrentAccess() access:ResolvedAccess){return this.misFeesService.ledger(query,user,access);}

  @Get('mis/bills')
  @RequirePermission('fees','view')
  misBills(@Query() query:MisFeesQueryDto,@CurrentUser() user:AuthUser,@CurrentAccess() access:ResolvedAccess){return this.misFeesService.list(query,user,access);}

  @Get('mis/houses')
  @RequirePermission('fees','view')
  misHouses(@Query() query:MisHouseSearchDto,@CurrentUser() user:AuthUser,@CurrentAccess() access:ResolvedAccess){return this.misFeesService.searchHouses(query.communityId,query.q,user,access);}

  @Get('mis/today')
 @RequirePermission('fees','view')
 misToday(@Query() query:MisTodayQueryDto,@CurrentUser() user:AuthUser,@CurrentAccess() access:ResolvedAccess){return this.misRead(user,()=>this.misFeesService.today(query,user,access),()=>this.misMirrorService.today(query,user,access));}

 @Get('mis/today/details')
 @RequirePermission('fees','view')
 misTodayDetails(@Query() query:MisTodayDetailsQueryDto,@CurrentUser() user:AuthUser,@CurrentAccess() access:ResolvedAccess){return this.misRead(user,()=>this.misFeesService.todayDetails(query,user,access),()=>this.misMirrorService.todayDetails(query,user,access));}

 @Get('mis/recent-payments')
  @RequirePermission('fees','view')
  misRecentPayments(@Query() query:MisRecentPaymentsQueryDto,@CurrentUser() user:AuthUser,@CurrentAccess() access:ResolvedAccess){return this.misRead(user,()=>this.misFeesService.recentPayments(query,user,access),()=>this.misMirrorService.recentPayments(query,user,access));}

  @Get('targets')
  @RequirePermission('fees','view')
  collectionTargets(@Query() query:ListCollectionTargetsQueryDto,@CurrentUser() user:AuthUser){
    const now=new Date();const year=query.year??Number(new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric'}).format(now));
    return this.collectionTargetsService.list(Number(user.tenantId||0),year);
  }

  @Put('targets')
  @RequirePermission('fees','edit')
  upsertCollectionTarget(@Body() dto:UpsertCollectionTargetDto,@CurrentUser() user:AuthUser){return this.collectionTargetsService.upsert(Number(user.tenantId||0),Number(user.id||0),dto);}

  @Delete('targets/:communityId')
  @RequirePermission('fees','edit')
  deleteCollectionTarget(@Param('communityId',ParseIntPipe) communityId:number,@Query('year',ParseIntPipe) year:number,@CurrentUser() user:AuthUser){return this.collectionTargetsService.remove(Number(user.tenantId||0),communityId,year);}

  @Get('mis/screen-summary')
  @RequirePermission('fees','view')
  misScreenSummary(@Query() query:ScreenSummaryQueryDto,@CurrentUser() user:AuthUser,@CurrentAccess() access:ResolvedAccess){
    const communityIds=query.communityIds?query.communityIds.split(',').map(value=>Number(value.trim())).filter(value=>Number.isInteger(value)&&value>0):undefined;
    const q={year:query.year,granularity:query.granularity??'month',communityIds};
    return this.misRead(user,()=>this.misFeesService.screenSummary(q,user,access),()=>this.misMirrorService.screenSummary(q,user,access));
  }

  @Get('mis/mirror/status')
  @RequirePermission(['settings','fees'],'view')
  misMirrorStatus(@CurrentUser() user:AuthUser){return this.misMirrorService.status(Number(user.tenantId||0));}

  @Patch('mis/mirror/mode')
  @RequirePermission('settings','edit')
  misMirrorMode(@Body() body:{mode?:'mis'|'mirror'},@CurrentUser() user:AuthUser){return this.misMirrorService.setMode(Number(user.tenantId||0),body.mode==='mirror'?'mirror':'mis');}

  @Post('mis/mirror/reload')
  @RequirePermission('settings','edit')
  misMirrorReload(@CurrentUser() user:AuthUser){return this.misMirrorService.reloadAll(Number(user.tenantId||0));}

  @Post('mis/mirror/sync')
  @RequirePermission('settings','edit')
  misMirrorSync(){return this.misMirrorService.syncAll();}

  @Get('mis/mirror/reconcile')
  @RequirePermission(['settings','fees'],'view')
  misMirrorReconcile(@CurrentUser() user:AuthUser){return this.misMirrorService.reconcile(Number(user.tenantId||0));}

  @Get('mis/residential')
  @RequirePermission('fees','view')
  misResidential(@Query() q:MisResidentialQueryDto,@CurrentUser() user:AuthUser,@CurrentAccess() access:ResolvedAccess){return this.misRead(user,()=>this.misFeesService.residential(q,user,access),()=>this.misMirrorService.residential(q,user,access));}

  /** 对账 CSV：与 households 同一套筛选参数；只读导出，不写库。 */
  @Get('mis/residential/export')
  @RequirePermission('fees','view')
  async misResidentialExport(@Query() q:MisResidentialQueryDto,@CurrentUser() user:AuthUser,@CurrentAccess() access:ResolvedAccess){
   const file=await this.misFeesService.exportResidentialCsv(q,user,access);
   return new StreamableFile(file.stream,{type:'text/csv; charset=utf-8',disposition:file.disposition});
  }

  @Post('mis/collections/preview')
  @RequirePermission('fees','edit')
  misCollectionPreview(@Body() body:MisCollectionPreviewDto,@CurrentUser() user:AuthUser,@CurrentAccess() access:ResolvedAccess){return this.misFeesService.previewCollection(body,user,access);}

  @Post('mis/collections')
  @RequirePermission('fees','edit')
  misCollectionCreate(@Body() body:MisCollectionPreviewDto,@CurrentUser() user:AuthUser,@CurrentAccess() access:ResolvedAccess){return this.misFeesService.createCollection(body,user,access);}

  @Get('mis/collections/sms-stats')
  @RequirePermission('fees','view')
  misCollectionSmsStats(@Query() query:MisCollectionSmsStatsQueryDto,@CurrentUser() user:AuthUser,@CurrentAccess() access:ResolvedAccess){return this.misCollectionSmsService.statsRange(query,user,access);}

  @Get('mis/collections')
  @RequirePermission('fees','view')
  misCollectionHistory(@Query() q:MisResidentialQueryDto,@CurrentUser() user:AuthUser,@CurrentAccess() access:ResolvedAccess){return this.misFeesService.collectionHistory(q,user,access);}

  @Get('mis/collections/:id')
  @RequirePermission('fees','view')
  misCollectionDetail(@Param('id',ParseIntPipe) id:number|string,@CurrentUser() user:AuthUser,@CurrentAccess() access:ResolvedAccess){return this.misFeesService.collectionDetail(Number(id),user,access);}

  // ---------- 账单 ----------

  @Get('bills')
  @RequirePermission(['fees', 'apartment-cashier'], 'view')
  listBills(
    @Query() query: ListBillsQueryDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.feesService.listBills(query, user, access);
  }

  @Get('bills/summary')
  @RequirePermission(['fees', 'apartment-cashier'], 'view')
  billSummary(
    @Query() query: ListBillsQueryDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.feesService.billSummary(query, user, access);
  }

  /** 收费报表：按实收时间统计，不是按账期 */
  @Get('reports/summary')
  @RequirePermission(['fees', 'apartment-cashier'], 'view')
  feeReport(
    @Query() query: FeeReportQueryDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.feesService.feeReport(query, user, access);
  }

  /** 收费报表 Excel 导出：与 reports/summary 完全同一套筛选与口径。 */
  @Get('reports/summary/export')
  @RequirePermission(['fees', 'apartment-cashier'], 'view')
  async feeReportExport(
    @Query() query: FeeReportQueryDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    const data = await this.feesService.feeReport(query, user, access);
    const previous: Record<string, number> = {};
    for (const [key, value] of Object.entries(data.previous)) previous['上期' + key] = value as number;
    const buffer = await buildReportWorkbook([
      { name: '汇总', meta: { from: data.range.from, to: data.range.to, granularity: data.range.granularity, ...data.totals, ...previous }, rows: [] },
      { name: '收款趋势', rows: data.trend as unknown as Record<string, unknown>[] },
      { name: '按费项', rows: data.byFee as unknown as Record<string, unknown>[] },
      { name: '按收款方式', rows: data.byMethod as unknown as Record<string, unknown>[] },
      { name: '按小区', rows: data.byCommunity as unknown as Record<string, unknown>[] },
      { name: '按收费员', rows: data.byCashier as unknown as Record<string, unknown>[] },
    ]);
    const filename = '收费报表_' + data.range.from + '_' + data.range.to + '.xlsx';
    return new StreamableFile(buffer, {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition: `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    });
  }

  /** 财务对账：按日 × 收款方式，和收费报表同一套取数口径 */
  @Get('reports/reconciliation')
  @RequirePermission(['fees', 'apartment-cashier'], 'view')
  feeReconciliation(
    @Query() query: FeeReportQueryDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.feesService.feeReconciliation(query, user, access);
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
  @RequirePermission(['fees', 'apartment-cashier', 'app:apartment-cashier'], 'view')
  houseDetail(
    @Param('houseId', ParseIntPipe) houseId: number,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.feesService.houseDetail(houseId, user, access);
  }

  @Get('cashier/houses/:houseId/history')
  @RequirePermission(['fees', 'apartment-cashier', 'app:apartment-cashier'], 'view')
  cashierHistory(
    @Param('houseId', ParseIntPipe) houseId: number,
    @Query('page') page: string,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.feesService.cashierHistory(houseId, Number(page), user, access);
  }

  /** 今日收费流水 + 今日合计（收费员交班对账用） */
  @Get('cashier/payment-methods')
  @RequirePermission(['fees', 'apartment-cashier', 'app:apartment-cashier'], 'view')
  cashierPaymentMethods(@CurrentUser() user: AuthUser, @CurrentAccess() access: ResolvedAccess) {
    return this.feesService.cashierPaymentMethods(user, access);
  }

  @Get('cashier/today')
  @RequirePermission(['fees', 'apartment-cashier', 'app:apartment-cashier'], 'view')
  cashierToday(
    @Query() query: PageQueryDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.feesService.cashierToday(query, user, access);
  }

  @Get('cashier/receipts/:receiptNo')
  @RequirePermission(['fees', 'apartment-cashier', 'app:apartment-cashier'], 'view')
  cashierReceipt(
    @Param('receiptNo') receiptNo: string,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.feesService.cashierReceipt(receiptNo, user, access);
  }

  /**
   * 补打小票：票面数据前端已经有了，这个请求存在的意义是让「谁在什么时候补打了哪张票」
   * 进日志管理 —— 小票是收费凭证，重复打印必须可追溯。
   */
  @Post('cashier/receipts/:receiptNo/reprint')
  @RequirePermission(['fees', 'apartment-cashier', 'app:apartment-cashier'], 'view')
  async reprintReceipt(
    @Param('receiptNo') receiptNo: string,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    await this.feesService.cashierReceipt(receiptNo, user, access);
    return { ok: true, receiptNo };
  }

  @Post('cashier/receipts/:receiptNo/refund')
  @RequirePermission(['fees', 'apartment-cashier', 'app:apartment-cashier'], 'edit')
  refundReceipt(
    @Param('receiptNo') receiptNo: string,
    @Body() dto: RefundReceiptDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.feesService.refundReceipt(receiptNo, dto, user, access);
  }

  @Post('cashier/charges')
  @RequirePermission(['fees', 'apartment-cashier', 'app:apartment-cashier'], 'edit')
  createCashierCharge(
    @Body() dto: CreateCashierChargeDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.feesService.createCashierCharge(dto, user, access);
  }

  @Patch('cashier/houses/:houseId/contact')
  @RequirePermission(['apartment-cashier', 'app:apartment-cashier'], 'edit')
  updateCashierContact(
    @Param('houseId', ParseIntPipe) houseId: number,
    @Body() dto: UpdateCashierContactDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.feesService.updateCashierContact(houseId, dto, user, access);
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
  @RequirePermission(['settings', 'fees'], 'view')
  listStandards(
    @Query() query: ListStandardsQueryDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.feesService.listStandards(query, user, access);
  }

  @Post('standards')
  @RequirePermission(['settings', 'fees'], 'edit')
  createStandard(
    @Body() dto: CreateStandardDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.feesService.createStandard(dto, user, access);
  }

  @Patch('standards/:id')
  @RequirePermission(['settings', 'fees'], 'edit')
  updateStandard(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateStandardDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.feesService.updateStandard(id, dto, user, access);
  }

  @Delete('standards/:id')
  @RequirePermission(['settings', 'fees'], 'delete')
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

  /** 数据源选择：显式 mirror 时绝不查询 MIS；mis 直连失败且镜像可用时自动降级并标注。 */
  private async misRead(user: AuthUser, direct: () => Promise<any>, mirror: () => Promise<any>) {
    const tenantId = Number(user.tenantId || 0);
    const mode = tenantId ? await this.misMirrorService.mode(tenantId) : 'mis';
    if (mode === 'mirror') return mirror();
    try {
      return await direct();
    } catch (error) {
      const status = Number((error as any)?.getStatus?.() || (error as any)?.status || 0);
      if (status >= 500) {
        const fallback = await mirror().catch(() => null);
        if (fallback) return { ...fallback, degraded: true };
      }
      throw error;
    }
  }
}
