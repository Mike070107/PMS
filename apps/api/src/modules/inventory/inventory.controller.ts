import {
  Body,
  Controller,
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
import { RolesOrPermissionGuard } from '../access/roles-or-permission.guard';
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
  RejectTransferOrderDto,
  StockQueryDto,
  SubmitToManagerDto,
  TenantQueryDto,
  UpdateMaterialDto,
  UpdateSupplierDto,
  UpdateStockDto,
  UpdateWarehouseDto,
  UpdateWarehouseLocationDto,
  WarehouseLocationQueryDto,
} from './dto';
import { InventoryService } from './inventory.service';

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
  constructor(private readonly inventoryService: InventoryService) {}

  // 员工端「材料与库存」那一格也调它：把 app:inventory 显式列出来，
  // 而不是在守卫里做「app:inventory 等价于 materials」的通用映射 ——
  // 那种映射会把这一格的权限顺带扩散到所有挂 materials/inventory 的接口
  @Get('materials')
  @RequirePermission(['materials', 'app:inventory'], 'view')
  listMaterials(@Query() query: TenantQueryDto, @CurrentUser() user: AuthUser) {
    return this.inventoryService.listMaterials(query, user);
  }

  /**
   * 材料选择器用的精简 SKU 列表：维修工在工单里做缺料登记要能挑材料、看实物照，
   * 但成本价不该给到现场，所以不复用 GET /materials，单独出一份不含金额的视图。
   */
  @Get('materials/options')
  @Roles(UserRole.TECHNICIAN)
  @RequirePermission(
    ['materials', 'inventory', 'work-orders', 'app:inventory', 'app:my-orders'],
    'view',
  )
  listMaterialOptions(@Query() query: TenantQueryDto, @CurrentUser() user: AuthUser) {
    return this.inventoryService.listMaterialOptions(query, user);
  }

  @Post('materials')
  @RequirePermission(['materials', 'app:inventory'], 'edit')
  createMaterial(@Body() dto: CreateMaterialDto, @CurrentUser() user: AuthUser) {
    return this.inventoryService.createMaterial(dto, user);
  }

  @Patch('materials/:id')
  @RequirePermission(['materials', 'app:inventory'], 'edit')
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
  @RequirePermission(['materials', 'app:inventory'], 'edit')
  updateMaterialViaPost(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateMaterialDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.inventoryService.updateMaterial(id, dto, user);
  }

  @Get('warehouses')
  @RequirePermission(['inventory', 'app:inventory'], 'view')
  listWarehouses(@Query() query: TenantQueryDto, @CurrentUser() user: AuthUser) {
    return this.inventoryService.listWarehouses(query, user);
  }

  @Post('warehouses')
  @RequirePermission('inventory', 'edit')
  createWarehouse(@Body() dto: CreateWarehouseDto, @CurrentUser() user: AuthUser) {
    return this.inventoryService.createWarehouse(dto, user);
  }

  @Patch('warehouses/:id')
  @RequirePermission('inventory', 'edit')
  updateWarehouse(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateWarehouseDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.inventoryService.updateWarehouse(id, dto, user);
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
  listStocks(@Query() query: StockQueryDto, @CurrentUser() user: AuthUser) {
    return this.inventoryService.listStocks(query, user);
  }

  @Patch('stocks/:id')
  @RequirePermission('inventory', 'edit')
  updateStock(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateStockDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.inventoryService.updateStock(id, dto, user);
  }

  // 员工端审批页拉待办用它；「材料与库存」那一格也要看得到采购进度
  @Get('purchase-requests')
  @RequirePermission(['inventory', 'app:approvals', 'app:inventory'], 'view')
  listPurchaseRequests(
    @Query() query: PurchaseRequestQueryDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.inventoryService.listPurchaseRequests(query, user);
  }

  @Post('purchase-requests')
  @RequirePermission('inventory', 'edit')
  createManualPurchaseRequest(
    @Body() dto: CreatePurchaseRequestDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.inventoryService.createManualPurchaseRequest(dto, user);
  }

  // ---------- 采购审批链：保留业务身份把关 ----------

  @Post('purchase-requests/submit-to-manager')
  @Roles(UserRole.ADMIN, UserRole.OFFICE)
  submitToManager(
    @Body() dto: SubmitToManagerDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.inventoryService.submitToManager(dto, user);
  }

  @Post('purchase-requests/:id/manager-approve')
  @Roles(UserRole.ADMIN, UserRole.MANAGER)
  approveByManager(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
  ) {
    return this.inventoryService.approveByManager(id, user);
  }

  @Post('purchase-requests/:id/purchaser-approve')
  @Roles(UserRole.ADMIN, UserRole.PURCHASER)
  approveByPurchaser(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
  ) {
    return this.inventoryService.approveByPurchaser(id, user);
  }

  @Post('purchase-requests/:id/reject')
  @Roles(UserRole.ADMIN, UserRole.OFFICE, UserRole.MANAGER, UserRole.PURCHASER)
  rejectPurchaseRequest(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: RejectPurchaseRequestDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.inventoryService.rejectPurchaseRequest(id, dto, user);
  }

  @Get('purchase-orders')
  @RequirePermission('inventory', 'view')
  listPurchaseOrders(
    @Query() query: TenantQueryDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.inventoryService.listPurchaseOrders(query, user);
  }

  @Post('purchase-orders')
  @Roles(UserRole.ADMIN, UserRole.PURCHASER)
  createPurchaseOrder(
    @Body() dto: CreatePurchaseOrderDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.inventoryService.createPurchaseOrder(dto, user);
  }

  @Get('goods-receipts')
  @RequirePermission('inventory', 'view')
  listGoodsReceipts(@Query() query: TenantQueryDto, @CurrentUser() user: AuthUser) {
    return this.inventoryService.listGoodsReceipts(query, user);
  }

  @Post('goods-receipts')
  @Roles(UserRole.ADMIN, UserRole.PURCHASER, UserRole.OFFICE)
  createGoodsReceipt(
    @Body() dto: CreateGoodsReceiptDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.inventoryService.createGoodsReceipt(dto, user);
  }

  @Post('goods-receipts/general')
  @Roles(UserRole.ADMIN, UserRole.PURCHASER, UserRole.OFFICE)
  createGeneralReceipt(
    @Body() dto: CreateGeneralReceiptDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.inventoryService.createGeneralReceipt(dto, user);
  }

  // ---------------- 库位/货架 ----------------

  @Get('warehouse-locations')
  @RequirePermission('inventory', 'view')
  listWarehouseLocations(
    @Query() query: WarehouseLocationQueryDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.inventoryService.listWarehouseLocations(query, user);
  }

  @Post('warehouse-locations')
  @RequirePermission('inventory', 'edit')
  createWarehouseLocation(
    @Body() dto: CreateWarehouseLocationDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.inventoryService.createWarehouseLocation(dto, user);
  }

  @Patch('warehouse-locations/:id')
  @RequirePermission('inventory', 'edit')
  updateWarehouseLocation(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateWarehouseLocationDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.inventoryService.updateWarehouseLocation(id, dto, user);
  }

  @Get('transfer-orders')
  @RequirePermission('inventory', 'view')
  listTransferOrders(
    @Query() query: TenantQueryDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.inventoryService.listTransferOrders(query, user);
  }

  @Post('transfer-orders')
  @RequirePermission('inventory', 'edit')
  createTransferOrder(
    @Body() dto: CreateTransferOrderDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.inventoryService.createTransferOrder(dto, user);
  }

  @Post('transfer-orders/:id/approve')
  @Roles(UserRole.ADMIN, UserRole.MANAGER)
  approveTransferOrder(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
  ) {
    return this.inventoryService.approveTransferOrder(id, user);
  }

  @Post('transfer-orders/:id/reject')
  @Roles(UserRole.ADMIN, UserRole.MANAGER)
  rejectTransferOrder(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: RejectTransferOrderDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.inventoryService.rejectTransferOrder(id, dto.reason, user);
  }

  @Post('transfer-orders/:id/receive')
  @Roles(UserRole.ADMIN, UserRole.MANAGER, UserRole.PURCHASER, UserRole.OFFICE)
  receiveTransferOrder(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ReceiveTransferOrderDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.inventoryService.receiveTransferOrder(id, dto, user);
  }
}
