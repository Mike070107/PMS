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
import { RolesOrPermissionGuard } from '../access/roles-or-permission.guard';
import { ResolvedAccess } from '../access/access.service';
import { CurrentAccess } from '../access/current-access.decorator';
import {
  CreateGeneralReceiptDto,
  CreateGoodsReceiptDto,
  CreateMaterialDto,
  CreatePurchaseOrderDto,
  CreatePurchaseRequestDto,
  CreateSupplierDto,
  CreateTransferOrderDto,
  CreateWarehouseDto,
  CreateWarehouseLocationDto,
  PurchaseRequestQueryDto,
  ReceiveTransferOrderDto,
  RejectPurchaseRequestDto,
  RejectPurchaseRequestItemDto,
  RejectTransferOrderDto,
  StockMovementQueryDto,
  StockQueryDto,
  SubmitToManagerDto,
  UpdatePurchaseRequestItemsDto,
  TenantQueryDto,
  WarehousesQueryDto,
  UpdateMaterialDto,
  UpsertMaterialCategoryDto,
  UpdateSupplierDto,
  UpdateStockDto,
  UpdateWarehouseDto,
  UpdateWarehouseLocationDto,
  WarehouseLocationQueryDto,
} from './dto';
import { InventoryService } from './inventory.service';
import { NotificationsService, type NotificationRef } from '../notifications/notifications.service';

/**
 * 双轨鉴权：
 * - 普通增删改查走页面权限矩阵（materials 页 / inventory 页）；
 * - 采购审批链（办公室汇总 → 经理审批 → 采购经理审批）与下单/收货
 *   仍按业务身份 @Roles 把关 —— 这是审批流程语义，不是页面可见性，
 *   换成页面权限会让「谁都能替经理批」。
 */
@Controller()
@UseGuards(JwtAuthGuard, RolesOrPermissionGuard)
export class InventoryController {
  constructor(
    private readonly inventoryService: InventoryService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * 操作成功后把指向这张单的未读站内信标已读（2026-09-06 Mike：别处处理过的消息不该还是未读）。
   * 只在成功后标 —— 失败的操作不算「看过」；标记本身失败不影响返回。
   */
  private async seen<T>(result: Promise<T>, user: AuthUser, ref: NotificationRef): Promise<T> {
    const value = await result;
    void this.notifications.markReadByRef(user, ref);
    return value;
  }

  // 员工端「材料与库存」那一格也调它：把 app:inventory 显式列出来，
  // 而不是在守卫里做「app:inventory 等价于 materials」的通用映射 ——
  // 那种映射会把这一格的权限顺带扩散到所有挂 materials/inventory 的接口
  @Get('materials')
  @RequirePermission(['materials', 'app:inventory', 'app:materials'], 'view')
  listMaterials(@Query() query: TenantQueryDto, @CurrentUser() user: AuthUser) {
    return this.inventoryService.listMaterials(query, user);
  }

  /**
   * 材料选择器用的精简 SKU 列表：维修工在工单里做缺料登记要能挑材料、看实物照，
   * 但成本价不该给到现场，所以不复用 GET /materials，单独出一份不含金额的视图。
   */
  @Get('materials/options')
  @RequirePermission(
    ['materials', 'inventory', 'work-orders', 'app:inventory', 'app:materials', 'app:my-orders'],
    'view',
  )
  listMaterialOptions(@Query() query: TenantQueryDto, @CurrentUser() user: AuthUser) {
    return this.inventoryService.listMaterialOptions(query, user);
  }

  @Post('materials')
  @RequirePermission(['materials', 'app:inventory', 'app:materials'], 'edit')
  createMaterial(@Body() dto: CreateMaterialDto, @CurrentUser() user: AuthUser) {
    return this.inventoryService.createMaterial(dto, user);
  }

  @Patch('materials/:id')
  @RequirePermission(['materials', 'app:inventory', 'app:materials'], 'edit')
  updateMaterial(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateMaterialDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.inventoryService.updateMaterial(id, dto, user);
  }

  /**
   * 小程序端更新材料。wx.request 不支持 PATCH，这里给一个等价的 POST 入口，
   * 逻辑与 PATCH /materials/:id 完全相同。
   */
  @Post('materials/:id/update')
  @RequirePermission(['materials', 'app:inventory', 'app:materials'], 'edit')
  updateMaterialViaPost(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateMaterialDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.inventoryService.updateMaterial(id, dto, user);
  }

  // ---------------- 材料类别 ----------------
  // 读：新建 SKU 的下拉要用，员工端也要（所以带 app:inventory）
  @Get('material-categories')
  @RequirePermission(
    ['materials', 'inventory', 'work-orders', 'app:inventory', 'app:materials'],
    'view',
  )
  listMaterialCategories(@Query() query: TenantQueryDto, @CurrentUser() user: AuthUser) {
    return this.inventoryService.listMaterialCategoriesWithUsage(user, query);
  }

  // 写：只给后台「材料 SKU 库 / 库存与采购」的编辑权限，
  // 类别是全公司的账本口径，不放给员工端现场改
  @Post('material-categories')
  @RequirePermission(['materials', 'inventory'], 'edit')
  createMaterialCategory(
    @Body() dto: UpsertMaterialCategoryDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.inventoryService.createMaterialCategory(dto, user);
  }

  @Patch('material-categories/:id')
  @RequirePermission(['materials', 'inventory'], 'edit')
  updateMaterialCategory(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpsertMaterialCategoryDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.inventoryService.updateMaterialCategory(id, dto, user);
  }

  @Delete('material-categories/:id')
  @RequirePermission(['materials', 'inventory'], 'delete')
  deleteMaterialCategory(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
  ) {
    return this.inventoryService.deleteMaterialCategory(id, user);
  }

  @Get('warehouses')
  @RequirePermission(['inventory', 'app:inventory'], 'view')
  listWarehouses(
    @Query() query: WarehousesQueryDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.inventoryService.listWarehouses(query, user, access);
  }

  /** 仓库表单的「所属管理处」下拉选项（现取，不用登录时下发的那份） */
  @Get('warehouses/offices')
  @RequirePermission(['inventory', 'app:inventory'], 'view')
  listWarehouseOfficeOptions(@CurrentUser() user: AuthUser) {
    return this.inventoryService.listWarehouseOfficeOptions(user);
  }

  @Post('warehouses')
  @RequirePermission('inventory', 'edit')
  createWarehouse(
    @Body() dto: CreateWarehouseDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.inventoryService.createWarehouse(dto, user, access);
  }

  @Patch('warehouses/:id')
  @RequirePermission('inventory', 'edit')
  updateWarehouse(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateWarehouseDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.inventoryService.updateWarehouse(id, dto, user, access);
  }

  @Get('suppliers')
  @RequirePermission('inventory', 'view')
  listSuppliers(@Query() query: TenantQueryDto, @CurrentUser() user: AuthUser) {
    return this.inventoryService.listSuppliers(query, user);
  }

  @Post('suppliers')
  @RequirePermission('inventory', 'edit')
  createSupplier(@Body() dto: CreateSupplierDto, @CurrentUser() user: AuthUser) {
    return this.inventoryService.createSupplier(dto, user);
  }

  @Patch('suppliers/:id')
  @RequirePermission('inventory', 'edit')
  updateSupplier(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateSupplierDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.inventoryService.updateSupplier(id, dto, user);
  }

  @Get('stocks')
  @RequirePermission(['inventory', 'app:inventory'], 'view')
  listStocks(
    @Query() query: StockQueryDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.inventoryService.listStocks(query, user, access);
  }

  /** 某条库存的批次明细：哪批、什么价、还剩多少 */
  @Get('stocks/:id/lots')
  @RequirePermission(['inventory', 'app:inventory'], 'view')
  listStockLots(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.inventoryService.listStockLots(id, user, access);
  }

  @Get('stock-movements')
  @RequirePermission(['inventory', 'app:inventory'], 'view')
  listStockMovements(
    @Query() query: StockMovementQueryDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.inventoryService.listStockMovements(query, user, access);
  }

  @Patch('stocks/:id')
  @RequirePermission('inventory', 'edit')
  updateStock(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateStockDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.inventoryService.updateStock(id, dto, user, access);
  }

  // 员工端审批页拉待办用它；「材料与库存」那一格也要看得到采购进度
  @Get('purchase-requests')
  @RequirePermission(
    ['inventory', 'app:inventory', 'app:approve-manager', 'app:approve-purchaser'],
    'view',
  )
  listPurchaseRequests(
    @Query() query: PurchaseRequestQueryDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.inventoryService.listPurchaseRequests(query, user, access);
  }

  /** 单张申请：员工端详情 / 编辑页。点开即把指向它的未读站内信标已读 */
  @Get('purchase-requests/:id')
  @RequirePermission(
    ['inventory', 'app:inventory', 'app:approve-manager', 'app:approve-purchaser'],
    'view',
  )
  getPurchaseRequest(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.seen(this.inventoryService.getPurchaseRequest(id, user, access), user, {
      purchaseRequestId: id,
    });
  }

  @Post('purchase-requests')
  @RequirePermission('inventory', 'edit')
  createManualPurchaseRequest(
    @Body() dto: CreatePurchaseRequestDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.inventoryService.createManualPurchaseRequest(dto, user, access);
  }

  // ---------- 采购审批链：保留业务身份把关 ----------

  // 提交采购申请 = 管材料库存那格的「改材料 / 提采购」
  /** 只合并不提交：多张待汇总申请合成一张（仍在办公室汇总，可继续编辑），采购按批次走 */
  @Post('purchase-requests/merge')
  @RequirePermission(['inventory', 'app:inventory'], 'edit')
  mergePurchaseRequests(
    @Body() dto: SubmitToManagerDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.seen(this.inventoryService.mergePurchaseRequests(dto, user, access), user, {
      purchaseRequestId: dto.requestIds,
    });
  }

  @Post('purchase-requests/submit-to-manager')
  @RequirePermission(['inventory', 'app:inventory'], 'edit')
  submitToManager(
    @Body() dto: SubmitToManagerDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.seen(this.inventoryService.submitToManager(dto, user, access), user, {
      purchaseRequestId: dto.requestIds,
    });
  }

  /** 办公室修改被单项驳回的描述/数量，之后可再次提交经理 */
  @Patch('purchase-requests/:id/items')
  @RequirePermission(['inventory', 'app:inventory'], 'edit')
  updatePurchaseRequestItems(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdatePurchaseRequestItemsDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.seen(this.inventoryService.updatePurchaseRequestItems(id, dto, user, access), user, {
      purchaseRequestId: id,
    });
  }

  // 审批链的两步各是一格勾选：谁批第一步、谁批第二步，由角色配置说了算
  @Post('purchase-requests/:id/manager-approve')
  @RequirePermission('app:approve-manager', 'edit')
  approveByManager(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.seen(this.inventoryService.approveByManager(id, user, access), user, {
      purchaseRequestId: id,
    });
  }

  @Post('purchase-requests/:id/purchaser-approve')
  @RequirePermission('app:approve-purchaser', 'edit')
  approveByPurchaser(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.seen(this.inventoryService.approveByPurchaser(id, user, access), user, {
      purchaseRequestId: id,
    });
  }

  // 驳回：两步审批人任一都能驳，提交人自己也能撤
  @Post('purchase-requests/:id/reject')
  @RequirePermission(
    ['app:approve-manager', 'app:approve-purchaser', 'inventory', 'app:inventory'],
    'edit',
  )
  rejectPurchaseRequest(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: RejectPurchaseRequestDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.seen(this.inventoryService.rejectPurchaseRequest(id, dto, user, access), user, {
      purchaseRequestId: id,
    });
  }

  /** 已驳回 → 回到办公室汇总，改完明细再提交；办公室或申请人本人能开 */
  @Post('purchase-requests/:id/reopen')
  @RequirePermission(['inventory', 'app:inventory', 'app:pool', 'app:my-orders'], 'view')
  reopenPurchaseRequest(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.seen(this.inventoryService.reopenPurchaseRequest(id, user, access), user, {
      purchaseRequestId: id,
    });
  }

  @Post('purchase-requests/:id/reject-item')
  @RequirePermission(['app:approve-manager', 'app:approve-purchaser'], 'edit')
  rejectPurchaseRequestItem(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: RejectPurchaseRequestItemDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.seen(this.inventoryService.rejectPurchaseRequestItem(id, dto, user, access), user, {
      purchaseRequestId: id,
    });
  }

  // 员工端「按采购单入库」要列待入库的采购单，所以带上 app:inventory
  @Get('purchase-orders')
  @RequirePermission(['inventory', 'app:inventory'], 'view')
  listPurchaseOrders(
    @Query() query: TenantQueryDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.inventoryService.listPurchaseOrders(query, user, access);
  }

  // 下单是采购那一步的后续动作
  @Post('purchase-orders')
  @RequirePermission(['app:approve-purchaser', 'inventory'], 'edit')
  createPurchaseOrder(
    @Body() dto: CreatePurchaseOrderDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.inventoryService.createPurchaseOrder(dto, user, access);
  }

  @Get('goods-receipts')
  @RequirePermission('inventory', 'view')
  listGoodsReceipts(
    @Query() query: TenantQueryDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.inventoryService.listGoodsReceipts(query, user, access);
  }

  @Post('goods-receipts')
  @RequirePermission(['inventory', 'app:inventory', 'app:approve-purchaser'], 'edit')
  createGoodsReceipt(
    @Body() dto: CreateGoodsReceiptDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.seen(this.inventoryService.createGoodsReceipt(dto, user, access), user, {
      purchaseOrderId: dto.purchaseOrderId,
    });
  }

  @Post('goods-receipts/general')
  @RequirePermission(['inventory', 'app:inventory', 'app:approve-purchaser'], 'edit')
  createGeneralReceipt(
    @Body() dto: CreateGeneralReceiptDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.inventoryService.createGeneralReceipt(dto, user, access);
  }

  // ---------------- 库位/货架 ----------------

  // 员工端「新增材料并入库」也要挑库位，所以带上 app:inventory
  @Get('warehouse-locations')
  @RequirePermission(['inventory', 'app:inventory'], 'view')
  listWarehouseLocations(
    @Query() query: WarehouseLocationQueryDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.inventoryService.listWarehouseLocations(query, user, access);
  }

  @Post('warehouse-locations')
  @RequirePermission('inventory', 'edit')
  createWarehouseLocation(
    @Body() dto: CreateWarehouseLocationDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.inventoryService.createWarehouseLocation(dto, user, access);
  }

  @Patch('warehouse-locations/:id')
  @RequirePermission('inventory', 'edit')
  updateWarehouseLocation(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateWarehouseLocationDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.inventoryService.updateWarehouseLocation(id, dto, user, access);
  }

  @Get('transfer-orders')
  @RequirePermission('inventory', 'view')
  listTransferOrders(
    @Query() query: TenantQueryDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.inventoryService.listTransferOrders(query, user, access);
  }

  @Post('transfer-orders')
  @RequirePermission('inventory', 'edit')
  createTransferOrder(
    @Body() dto: CreateTransferOrderDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.inventoryService.createTransferOrder(dto, user, access);
  }

  @Post('transfer-orders/:id/approve')
  @RequirePermission('app:approve-manager', 'edit')
  approveTransferOrder(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.seen(this.inventoryService.approveTransferOrder(id, user, access), user, {
      transferId: id,
    });
  }

  @Post('transfer-orders/:id/reject')
  @RequirePermission('app:approve-manager', 'edit')
  rejectTransferOrder(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: RejectTransferOrderDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.seen(this.inventoryService.rejectTransferOrder(id, dto.reason, user, access), user, {
      transferId: id,
    });
  }

  @Post('transfer-orders/:id/receive')
  @RequirePermission(['inventory', 'app:inventory'], 'edit')
  receiveTransferOrder(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ReceiveTransferOrderDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.seen(this.inventoryService.receiveTransferOrder(id, dto, user, access), user, {
      transferId: id,
    });
  }
}
