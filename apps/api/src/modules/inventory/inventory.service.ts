import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, FindOptionsWhere, In, Repository } from 'typeorm';
import { AuthUser } from '../../common/current-user.decorator';
import {
  NotifyChannel,
  NotifyStatus,
  PurchaseOrderStatus,
  PurchaseRequestStatus,
  StockMovementType,
  TransferOrderStatus,
  UserRole,
  UserStatus,
  WarehouseType,
} from '../../common/enums';
import {
  GoodsReceipt,
  Material,
  Notification,
  PurchaseOrder,
  PurchaseRequest,
  StaffProfile,
  Stock,
  StockLot,
  StockMovement,
  Supplier,
  TransferOrder,
  User,
  Warehouse,
  WarehouseLocation,
} from '../../entities';
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
import { ObjectStorageService } from '../upload/object-storage.service';

interface NotifyInput {
  eventKey: string;
  title: string;
  payload: Record<string, unknown>;
  operatorId: number | null;
}

const MATERIAL_CATEGORY_PREFIX: Record<string, string> = {
  卫生: 'WS',
  电器: 'DQ',
  化工: 'HG',
  黑色: 'HX',
  有色: 'YS',
  水料: 'SL',
  木料: 'ML',
  五金: 'WJ',
  工具: 'GJ',
  防护用品: 'FH',
  防台防汛: 'FT',
  低值易耗品: 'DZ',
};

interface LotAllocation {
  stockLotId: number;
  qty: number;
  unitCostCents: number;
  amountCents: number;
}

@Injectable()
export class InventoryService {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    @InjectRepository(Material)
    private readonly materialRepo: Repository<Material>,
    @InjectRepository(Warehouse)
    private readonly warehouseRepo: Repository<Warehouse>,
    @InjectRepository(Supplier)
    private readonly supplierRepo: Repository<Supplier>,
    @InjectRepository(Stock)
    private readonly stockRepo: Repository<Stock>,
    @InjectRepository(PurchaseRequest)
    private readonly purchaseRequestRepo: Repository<PurchaseRequest>,
    @InjectRepository(PurchaseOrder)
    private readonly purchaseOrderRepo: Repository<PurchaseOrder>,
    @InjectRepository(TransferOrder)
    private readonly transferOrderRepo: Repository<TransferOrder>,
    private readonly storage: ObjectStorageService,
  ) {}

  listMaterials(query: TenantQueryDto, user: AuthUser) {
    const tenantId = this.resolveTenantId(user, query.tenantId);
    return this.materialRepo.find({ where: { tenantId }, order: { id: 'ASC' } });
  }

  /**
   * 材料选择器数据源：只给启用中的 SKU，且不含成本价。
   * 照片统一翻成代理地址 —— 库里存量数据有 COS 直连地址，私有桶直接取是 403，
   * 小程序上表现为一片灰图。
   */
  async listMaterialOptions(query: TenantQueryDto, user: AuthUser) {
    const tenantId = this.resolveTenantId(user, query.tenantId);
    const materials = await this.materialRepo.find({
      where: { tenantId, enabled: true },
      order: { category: 'ASC', id: 'ASC' },
    });
    return materials.map((item) => ({
      id: item.id,
      code: item.code,
      name: item.name,
      spec: item.spec,
      category: item.category,
      unit: item.unit,
      photoUrl: this.storage.toDisplayUrl(item.photoUrl) || null,
      aliases: item.aliases || [],
    }));
  }

  async createMaterial(dto: CreateMaterialDto, user: AuthUser) {
    const tenantId = this.resolveTenantId(user, dto.tenantId);
    await this.assertMaterialUnique(tenantId, dto.name, dto.spec ?? null, null);
    const code = dto.code?.trim() || await this.buildMaterialCode(tenantId, dto.category);
    return this.materialRepo.save(
      this.materialRepo.create({
        tenantId,
        code,
        name: dto.name.trim(),
        spec: dto.spec?.trim() || null,
        category: dto.category,
        unit: dto.unit ?? '个',
        defaultCostCents: dto.defaultCostCents ?? 0,
        photoUrl: dto.photoUrl ?? null,
        aliases: this.normalizeAliases(dto.aliases),
        params: dto.params?.trim() || null,
        enabled: dto.enabled ?? true,
        createdBy: user.id,
        updatedBy: user.id,
      }),
    );
  }

  async updateMaterial(id: number, dto: UpdateMaterialDto, user: AuthUser) {
    const tenantId = this.resolveTenantId(user);
    const material = await this.materialRepo.findOne({ where: { id, tenantId } });
    if (!material) throw new NotFoundException('material not found');

    const nextName = dto.name !== undefined ? dto.name.trim() : material.name;
    const nextSpec = dto.spec !== undefined ? (dto.spec?.trim() || null) : material.spec;
    const identityChanged = nextName !== material.name || nextSpec !== material.spec;
    if (identityChanged) {
      if (await this.isMaterialReferenced(tenantId, id)) {
        throw new BadRequestException(
          '该材料已被业务单据引用，名称和型号不可修改；请新建 SKU 并停用本条',
        );
      }
      await this.assertMaterialUnique(tenantId, nextName, nextSpec, id);
      material.name = nextName;
      material.spec = nextSpec;
    }
    if (dto.category !== undefined) material.category = dto.category;
    if (dto.unit !== undefined) material.unit = dto.unit;
    if (dto.defaultCostCents !== undefined) {
      material.defaultCostCents = dto.defaultCostCents;
    }
    if (dto.photoUrl !== undefined) material.photoUrl = dto.photoUrl || null;
    if (dto.aliases !== undefined) material.aliases = this.normalizeAliases(dto.aliases);
    if (dto.params !== undefined) material.params = dto.params?.trim() || null;
    if (dto.enabled !== undefined) material.enabled = dto.enabled;
    material.updatedBy = user.id;
    return this.materialRepo.save(material);
  }

  /** 判重口径：名称 + 型号相同视为同一材料；同名不同型号不算重复 */
  private async assertMaterialUnique(
    tenantId: number,
    name: string,
    spec: string | null,
    ignoreId: number | null,
  ) {
    const qb = this.materialRepo
      .createQueryBuilder('m')
      .where('m.tenant_id = :tenantId', { tenantId })
      .andWhere('BTRIM(m.name) = :name', { name: name.trim() });
    if (spec) {
      qb.andWhere('BTRIM(COALESCE(m.spec, \'\')) = :spec', { spec: spec.trim() });
    } else {
      qb.andWhere("COALESCE(BTRIM(m.spec), '') = ''");
    }
    if (ignoreId) qb.andWhere('m.id <> :ignoreId', { ignoreId });
    const dup = await qb.getOne();
    if (dup) {
      throw new BadRequestException(
        `已存在同名同型号材料（编码 ${dup.code}），请直接使用或补充为别名`,
      );
    }
  }

  /** 是否已被业务引用（库存/批次/流水/工单耗材/采购单任一存在即锁定名称型号） */
  private async isMaterialReferenced(tenantId: number, materialId: number): Promise<boolean> {
    const [movement, lot, usage] = await Promise.all([
      this.dataSource
        .getRepository(StockMovement)
        .findOne({ where: { tenantId, materialId }, select: ['id'] }),
      this.dataSource
        .getRepository(StockLot)
        .findOne({ where: { tenantId, materialId }, select: ['id'] }),
      this.dataSource
        .query(
          'SELECT id FROM work_order_materials WHERE tenant_id = $1 AND material_id = $2 LIMIT 1',
          [tenantId, materialId],
        ),
    ]);
    return !!movement || !!lot || (Array.isArray(usage) && usage.length > 0);
  }

  private normalizeAliases(aliases?: string[]): string[] {
    if (!aliases?.length) return [];
    return Array.from(
      new Set(aliases.map((item) => item.trim()).filter(Boolean)),
    ).slice(0, 20);
  }

  listWarehouses(query: TenantQueryDto, user: AuthUser) {
    const tenantId = this.resolveTenantId(user, query.tenantId);
    return this.warehouseRepo.find({
      where: { tenantId },
      order: { id: 'ASC' },
    });
  }

  createWarehouse(dto: CreateWarehouseDto, user: AuthUser) {
    const tenantId = this.resolveTenantId(user, dto.tenantId);
    if (!Object.values(WarehouseType).includes(dto.type)) {
      throw new BadRequestException('invalid warehouse type');
    }
    if (dto.type === WarehouseType.COMMUNITY && !dto.communityId) {
      throw new BadRequestException('communityId is required');
    }
    return this.warehouseRepo.save(
      this.warehouseRepo.create({
        tenantId,
        name: dto.name,
        type: dto.type,
        communityId: dto.type === WarehouseType.COMMUNITY ? dto.communityId! : null,
        enabled: dto.enabled ?? true,
        createdBy: user.id,
        updatedBy: user.id,
      }),
    );
  }

  async updateWarehouse(id: number, dto: UpdateWarehouseDto, user: AuthUser) {
    const tenantId = this.resolveTenantId(user);
    const warehouse = await this.warehouseRepo.findOne({ where: { id, tenantId } });
    if (!warehouse) throw new NotFoundException('warehouse not found');
    const nextType = dto.type ?? warehouse.type;
    if (!Object.values(WarehouseType).includes(nextType)) {
      throw new BadRequestException('invalid warehouse type');
    }
    const nextCommunityId = dto.communityId ?? warehouse.communityId;
    if (nextType === WarehouseType.COMMUNITY && !nextCommunityId) {
      throw new BadRequestException('communityId is required');
    }
    if (dto.name !== undefined) warehouse.name = dto.name;
    warehouse.type = nextType;
    warehouse.communityId = nextType === WarehouseType.COMMUNITY ? nextCommunityId : null;
    if (dto.enabled !== undefined) warehouse.enabled = dto.enabled;
    warehouse.updatedBy = user.id;
    return this.warehouseRepo.save(warehouse);
  }

  listSuppliers(query: TenantQueryDto, user: AuthUser) {
    const tenantId = this.resolveTenantId(user, query.tenantId);
    return this.supplierRepo.find({ where: { tenantId }, order: { id: 'ASC' } });
  }

  createSupplier(dto: CreateSupplierDto, user: AuthUser) {
    const tenantId = this.resolveTenantId(user, dto.tenantId);
    return this.supplierRepo.save(
      this.supplierRepo.create({
        tenantId,
        name: dto.name,
        contactName: dto.contactName ?? null,
        contactPhone: dto.contactPhone ?? null,
        address: dto.address ?? null,
        rating: dto.rating ?? null,
        note: dto.note ?? null,
        enabled: true,
        createdBy: user.id,
        updatedBy: user.id,
      }),
    );
  }

  async updateSupplier(id: number, dto: UpdateSupplierDto, user: AuthUser) {
    const tenantId = this.resolveTenantId(user);
    const supplier = await this.supplierRepo.findOne({ where: { id, tenantId } });
    if (!supplier) throw new NotFoundException('supplier not found');
    if (dto.name !== undefined) supplier.name = dto.name;
    if (dto.contactName !== undefined) supplier.contactName = dto.contactName || null;
    if (dto.contactPhone !== undefined) supplier.contactPhone = dto.contactPhone || null;
    if (dto.address !== undefined) supplier.address = dto.address || null;
    if (dto.rating !== undefined) supplier.rating = dto.rating;
    if (dto.note !== undefined) supplier.note = dto.note || null;
    if (dto.enabled !== undefined) supplier.enabled = dto.enabled;
    supplier.updatedBy = user.id;
    return this.supplierRepo.save(supplier);
  }

  listStocks(query: StockQueryDto, user: AuthUser) {
    const tenantId = this.resolveTenantId(user, query.tenantId);
    const where: FindOptionsWhere<Stock> = { tenantId };
    if (query.warehouseId) where.warehouseId = query.warehouseId;
    if (query.materialId) where.materialId = query.materialId;
    return this.stockRepo.find({ where, order: { id: 'ASC' } });
  }

  async updateStock(id: number, dto: UpdateStockDto, user: AuthUser) {
    const tenantId = this.resolveTenantId(user);
    return this.dataSource.transaction(async (manager) => {
      const stock = await manager.findOne(Stock, {
        where: { id, tenantId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!stock) throw new NotFoundException('stock not found');
      const previousQty = Number(stock.qty);
      if (dto.qty !== undefined) stock.qty = dto.qty;
      if (dto.safetyQty !== undefined) stock.safetyQty = dto.safetyQty;
      stock.updatedBy = user.id;
      const saved = await manager.save(Stock, stock);
      const deltaQty = Number(saved.qty) - previousQty;
      if (deltaQty !== 0) {
        await manager.save(
          StockMovement,
          manager.create(StockMovement, {
            tenantId,
            warehouseId: saved.warehouseId,
            materialId: saved.materialId,
            type: StockMovementType.ADJUST,
            qty: deltaQty,
            unitCostCents: 0,
            refType: 'stock',
            refId: saved.id,
            note: 'manual stock edit',
            createdBy: user.id,
            updatedBy: user.id,
          }),
        );
      }
      return saved;
    });
  }

  listPurchaseRequests(query: PurchaseRequestQueryDto, user: AuthUser) {
    const tenantId = this.resolveTenantId(user, query.tenantId);
    const where: FindOptionsWhere<PurchaseRequest> = { tenantId };
    if (query.status) {
      if (
        !Object.values(PurchaseRequestStatus).includes(
          query.status as PurchaseRequestStatus,
        )
      ) {
        throw new BadRequestException('invalid purchase request status');
      }
      where.status = query.status as PurchaseRequestStatus;
    }
    return this.purchaseRequestRepo.find({ where, order: { id: 'DESC' } });
  }

  /** 办公室手工新建采购申请（直接进入办公室汇总环节，可继续合并或提交经理） */
  createManualPurchaseRequest(dto: CreatePurchaseRequestDto, user: AuthUser) {
    const tenantId = this.resolveTenantId(user, dto.tenantId);
    if (!dto.items?.length) throw new BadRequestException('items is required');
    return this.dataSource.transaction(async (manager) => {
      await this.ensureMaterials(manager, tenantId, dto.items.map((item) => item.materialId));
      const materials = await manager.find(Material, {
        where: { tenantId, id: In(dto.items.map((item) => item.materialId)) },
      });
      const nameById = new Map(materials.map((m) => [m.id, this.materialLabel(m)]));
      const request = await manager.save(
        PurchaseRequest,
        manager.create(PurchaseRequest, {
          tenantId,
          requestNo: this.buildNo('PR'),
          workOrderId: null,
          applicantId: user.id,
          items: dto.items.map((item) => ({
            materialId: item.materialId,
            name: nameById.get(item.materialId) ?? `#${item.materialId}`,
            qty: item.qty,
            estUnitCostCents: item.estUnitCostCents ?? 0,
          })),
          estTotalCents: dto.items.reduce(
            (sum, item) => sum + (item.estUnitCostCents ?? 0) * item.qty,
            0,
          ),
          status: PurchaseRequestStatus.OFFICE_REVIEW,
          createdBy: user.id,
          updatedBy: user.id,
        }),
      );
      return request;
    });
  }

  /** 办公室汇总提交：把若干条办公室待汇总申请合并成一条，提交给物业经理 */
  submitToManager(dto: SubmitToManagerDto, user: AuthUser) {
    const tenantId = this.resolveTenantId(user);
    const ids = Array.from(new Set(dto.requestIds));
    if (!ids.length) throw new BadRequestException('请选择要提交的申请');
    return this.dataSource.transaction(async (manager) => {
      const requests: PurchaseRequest[] = [];
      for (const id of ids) {
        const req = await this.lockPurchaseRequest(manager, id, tenantId);
        if (req.status !== PurchaseRequestStatus.OFFICE_REVIEW) {
          throw new BadRequestException(`申请 ${req.requestNo} 不在办公室汇总环节`);
        }
        requests.push(req);
      }

      // 单条：直接推进；多条：合并明细为主单，其余标记 merged
      const primary = requests[0];
      if (requests.length > 1) {
        // 按 materialId 合并同材料数量
        const merged = new Map<string, { materialId?: number; name: string; qty: number; estUnitCostCents?: number }>();
        for (const req of requests) {
          for (const item of req.items) {
            const key = item.materialId ? `m${item.materialId}` : `n${item.name}`;
            const exist = merged.get(key);
            if (exist) {
              exist.qty += item.qty;
            } else {
              merged.set(key, { ...item });
            }
          }
        }
        primary.items = Array.from(merged.values());
        primary.estTotalCents = primary.items.reduce(
          (sum, item) => sum + (item.estUnitCostCents ?? 0) * item.qty,
          0,
        );
        for (const req of requests.slice(1)) {
          req.status = PurchaseRequestStatus.MERGED;
          req.rejectReason = `已合并进 ${primary.requestNo}`;
          req.updatedBy = user.id;
          await manager.save(PurchaseRequest, req);
        }
      }

      primary.status = PurchaseRequestStatus.MANAGER_REVIEW;
      primary.updatedBy = user.id;
      const saved = await manager.save(PurchaseRequest, primary);
      await this.notifyRoles(manager, tenantId, [UserRole.MANAGER, UserRole.ADMIN], {
        eventKey: 'purchase_pending_manager',
        title: `采购申请 ${saved.requestNo} 待物业经理审批`,
        payload: { purchaseRequestId: saved.id, requestNo: saved.requestNo },
        operatorId: user.id,
      });
      return saved;
    });
  }

  approveByManager(id: number, user: AuthUser) {
    const tenantId = this.resolveTenantId(user);
    return this.dataSource.transaction(async (manager) => {
      const request = await this.lockPurchaseRequest(manager, id, tenantId);
      if (request.status !== PurchaseRequestStatus.MANAGER_REVIEW) {
        throw new BadRequestException('purchase request is not pending manager');
      }
      request.status = PurchaseRequestStatus.PURCHASER_REVIEW;
      request.managerId = user.id;
      request.managerAt = new Date();
      request.updatedBy = user.id;
      const saved = await manager.save(PurchaseRequest, request);
      await this.notifyRoles(manager, tenantId, [UserRole.PURCHASER, UserRole.ADMIN], {
        eventKey: 'purchase_pending_purchaser',
        title: `采购申请 ${saved.requestNo} 待采购经理审批`,
        payload: { purchaseRequestId: saved.id, requestNo: saved.requestNo },
        operatorId: user.id,
      });
      return saved;
    });
  }

  approveByPurchaser(id: number, user: AuthUser) {
    const tenantId = this.resolveTenantId(user);
    return this.dataSource.transaction(async (manager) => {
      const request = await this.lockPurchaseRequest(manager, id, tenantId);
      if (request.status !== PurchaseRequestStatus.PURCHASER_REVIEW) {
        throw new BadRequestException('purchase request is not pending purchaser');
      }
      request.status = PurchaseRequestStatus.APPROVED;
      request.purchaserId = user.id;
      request.purchaserAt = new Date();
      request.updatedBy = user.id;
      return manager.save(PurchaseRequest, request);
    });
  }

  rejectPurchaseRequest(id: number, dto: RejectPurchaseRequestDto, user: AuthUser) {
    const tenantId = this.resolveTenantId(user);
    return this.dataSource.transaction(async (manager) => {
      const request = await this.lockPurchaseRequest(manager, id, tenantId);
      if (
        ![
          PurchaseRequestStatus.OFFICE_REVIEW,
          PurchaseRequestStatus.MANAGER_REVIEW,
          PurchaseRequestStatus.PURCHASER_REVIEW,
          PurchaseRequestStatus.APPROVED,
        ].includes(request.status)
      ) {
        throw new BadRequestException('purchase request cannot be rejected');
      }
      request.status = PurchaseRequestStatus.REJECTED;
      request.rejectReason = dto.reason;
      request.updatedBy = user.id;
      return manager.save(PurchaseRequest, request);
    });
  }

  listPurchaseOrders(query: TenantQueryDto, user: AuthUser) {
    const tenantId = this.resolveTenantId(user, query.tenantId);
    return this.purchaseOrderRepo.find({
      where: { tenantId },
      order: { id: 'DESC' },
    });
  }

  createPurchaseOrder(dto: CreatePurchaseOrderDto, user: AuthUser) {
    const tenantId = this.resolveTenantId(user, dto.tenantId);
    return this.dataSource.transaction(async (manager) => {
      const supplier = await manager.findOne(Supplier, {
        where: { id: dto.supplierId, tenantId, enabled: true },
      });
      if (!supplier) throw new NotFoundException('supplier not found');

      let request: PurchaseRequest | null = null;
      let items = dto.items ?? [];
      if (dto.requestId) {
        const lockedRequest = await this.lockPurchaseRequest(
          manager,
          dto.requestId,
          tenantId,
        );
        request = lockedRequest;
        if (lockedRequest.status !== PurchaseRequestStatus.APPROVED) {
          throw new BadRequestException('purchase request is not approved');
        }
        if (!items.length) {
          items = lockedRequest.items.map((item) => {
            if (!item.materialId) {
              throw new BadRequestException(
                `missing materialId for purchase item: ${item.name}`,
              );
            }
            return {
              materialId: item.materialId,
              qty: item.qty,
              unitCostCents: item.estUnitCostCents ?? 0,
            };
          });
        }
      }
      if (!items.length) throw new BadRequestException('items is required');
      await this.ensureMaterials(manager, tenantId, items.map((item) => item.materialId));

      const order = await manager.save(
        PurchaseOrder,
        manager.create(PurchaseOrder, {
          tenantId,
          orderNo: this.buildNo('PO'),
          requestId: request?.id ?? null,
          supplierId: dto.supplierId,
          items,
          totalCents: items.reduce(
            (sum, item) => sum + item.qty * item.unitCostCents,
            0,
          ),
          status: PurchaseOrderStatus.PLACED,
          createdBy: user.id,
          updatedBy: user.id,
        }),
      );

      if (request) {
        request.status = PurchaseRequestStatus.DONE;
        request.updatedBy = user.id;
        await manager.save(PurchaseRequest, request);
      }
      return order;
    });
  }

  createGoodsReceipt(dto: CreateGoodsReceiptDto, user: AuthUser) {
    const tenantId = this.resolveTenantId(user, dto.tenantId);
    if (!dto.items.length) throw new BadRequestException('items is required');
    return this.dataSource.transaction(async (manager) => {
      const order = await manager.findOne(PurchaseOrder, {
        where: { id: dto.purchaseOrderId, tenantId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!order) throw new NotFoundException('purchase order not found');
      if (![PurchaseOrderStatus.PLACED, PurchaseOrderStatus.PARTIAL].includes(order.status)) {
        throw new BadRequestException('purchase order cannot receive goods');
      }
      await this.ensureWarehouse(manager, tenantId, dto.warehouseId);
      await this.ensureMaterials(manager, tenantId, dto.items.map((item) => item.materialId));
      // 每种材料至少一张实物照片
      for (const item of dto.items) {
        if (!item.photoUrls?.length) {
          throw new BadRequestException('每种材料至少需要上传 1 张实物照片');
        }
      }
      const locationLabels = await this.resolveLocationLabels(manager, tenantId, dto.warehouseId, dto.items);

      const receipt = await manager.save(
        GoodsReceipt,
        manager.create(GoodsReceipt, {
          tenantId,
          receiptNo: this.buildNo('GR'),
          receiptType: 'purchase_order',
          purchaseOrderId: order.id,
          sourceText: null,
          attachments: [],
          warehouseId: dto.warehouseId,
          receiverId: user.id,
          items: dto.items.map((item) => ({
            materialId: item.materialId,
            qty: item.qty,
            unitCostCents: item.unitCostCents,
            photoUrls: item.photoUrls ?? [],
            locationId: item.locationId ?? null,
            locationLabel: locationLabels.get(item.locationId ?? -1) ?? null,
          })),
          createdBy: user.id,
          updatedBy: user.id,
        }),
      );

      for (const [index, item] of dto.items.entries()) {
        await this.createStockLot(manager, {
          tenantId,
          warehouseId: dto.warehouseId,
          materialId: item.materialId,
          qty: item.qty,
          unitCostCents: item.unitCostCents,
          supplierId: order.supplierId,
          purchaseOrderId: order.id,
          goodsReceiptId: receipt.id,
          sourceType: 'goods_receipt',
          sourceId: receipt.id,
          lotNo: `${receipt.receiptNo}-${String(index + 1).padStart(2, '0')}`,
          operatorId: user.id,
        });
        await this.applyStockDelta(manager, {
          tenantId,
          warehouseId: dto.warehouseId,
          materialId: item.materialId,
          deltaQty: item.qty,
          type: StockMovementType.INBOUND,
          unitCostCents: item.unitCostCents,
          refType: 'goods_receipt',
          refId: receipt.id,
          operatorId: user.id,
          note: order.orderNo,
        });
      }

      // 分批到货：累计各材料已收数量，判断是全部收齐(received)还是部分到货(partial)
      const receivedTotals = await this.sumReceivedQtyByMaterial(manager, tenantId, order.id);
      const variances: string[] = [];
      let allComplete = true;
      for (const orderItem of order.items) {
        const received = receivedTotals.get(orderItem.materialId) ?? 0;
        if (received < orderItem.qty) allComplete = false;
        if (received !== orderItem.qty) {
          variances.push(`材料 #${orderItem.materialId}：订 ${orderItem.qty}、累计收 ${received}`);
        }
      }
      order.status = allComplete ? PurchaseOrderStatus.RECEIVED : PurchaseOrderStatus.PARTIAL;
      order.updatedBy = user.id;
      await manager.save(PurchaseOrder, order);

      // 实收与采购数量有差异 → 提醒采购经理和办公室
      if (variances.length) {
        await this.notifyRoles(manager, tenantId, [UserRole.PURCHASER, UserRole.OFFICE, UserRole.ADMIN], {
          eventKey: 'receipt_qty_variance',
          title: `采购单 ${order.orderNo} 实收与订购数量存在差异`,
          payload: { purchaseOrderId: order.id, orderNo: order.orderNo, variances, receiptNo: receipt.receiptNo },
          operatorId: user.id,
        });
      }
      return receipt;
    });
  }

  /** 一般入库（无采购单，零星采买）：填来源 + 凭证附件，逐项拍照 + 选库位 */
  createGeneralReceipt(dto: CreateGeneralReceiptDto, user: AuthUser) {
    const tenantId = this.resolveTenantId(user, dto.tenantId);
    if (!dto.items.length) throw new BadRequestException('items is required');
    if (!dto.sourceText?.trim()) throw new BadRequestException('请填写材料来源');
    return this.dataSource.transaction(async (manager) => {
      await this.ensureWarehouse(manager, tenantId, dto.warehouseId);
      await this.ensureMaterials(manager, tenantId, dto.items.map((item) => item.materialId));
      for (const item of dto.items) {
        if (!item.photoUrls?.length) {
          throw new BadRequestException('每种材料至少需要上传 1 张实物照片');
        }
      }
      const locationLabels = await this.resolveLocationLabels(manager, tenantId, dto.warehouseId, dto.items);

      const receipt = await manager.save(
        GoodsReceipt,
        manager.create(GoodsReceipt, {
          tenantId,
          receiptNo: this.buildNo('GR'),
          receiptType: 'general',
          purchaseOrderId: null,
          sourceText: dto.sourceText.trim(),
          attachments: dto.attachments ?? [],
          warehouseId: dto.warehouseId,
          receiverId: user.id,
          items: dto.items.map((item) => ({
            materialId: item.materialId,
            qty: item.qty,
            unitCostCents: item.unitCostCents,
            photoUrls: item.photoUrls ?? [],
            locationId: item.locationId ?? null,
            locationLabel: locationLabels.get(item.locationId ?? -1) ?? null,
          })),
          createdBy: user.id,
          updatedBy: user.id,
        }),
      );

      for (const [index, item] of dto.items.entries()) {
        await this.createStockLot(manager, {
          tenantId,
          warehouseId: dto.warehouseId,
          materialId: item.materialId,
          qty: item.qty,
          unitCostCents: item.unitCostCents,
          supplierId: null,
          purchaseOrderId: null,
          goodsReceiptId: receipt.id,
          sourceType: 'general_receipt',
          sourceId: receipt.id,
          lotNo: `${receipt.receiptNo}-${String(index + 1).padStart(2, '0')}`,
          operatorId: user.id,
        });
        await this.applyStockDelta(manager, {
          tenantId,
          warehouseId: dto.warehouseId,
          materialId: item.materialId,
          deltaQty: item.qty,
          type: StockMovementType.INBOUND,
          unitCostCents: item.unitCostCents,
          refType: 'general_receipt',
          refId: receipt.id,
          operatorId: user.id,
          note: dto.sourceText.trim(),
        });
      }
      return receipt;
    });
  }

  listGoodsReceipts(query: TenantQueryDto, user: AuthUser) {
    const tenantId = this.resolveTenantId(user, query.tenantId);
    return this.dataSource.getRepository(GoodsReceipt).find({
      where: { tenantId },
      order: { id: 'DESC' },
      take: 100,
    });
  }

  private async sumReceivedQtyByMaterial(
    manager: EntityManager,
    tenantId: number,
    purchaseOrderId: number,
  ): Promise<Map<number, number>> {
    const receipts = await manager.find(GoodsReceipt, {
      where: { tenantId, purchaseOrderId },
    });
    const totals = new Map<number, number>();
    for (const receipt of receipts) {
      for (const item of receipt.items) {
        totals.set(item.materialId, (totals.get(item.materialId) ?? 0) + Number(item.qty));
      }
    }
    return totals;
  }

  private async resolveLocationLabels(
    manager: EntityManager,
    tenantId: number,
    warehouseId: number,
    items: Array<{ locationId?: number | null }>,
  ): Promise<Map<number, string>> {
    const ids = Array.from(
      new Set(items.map((item) => item.locationId).filter((id): id is number => !!id)),
    );
    const labels = new Map<number, string>();
    if (!ids.length) return labels;
    const locations = await manager.find(WarehouseLocation, {
      where: { tenantId, id: In(ids) },
    });
    for (const loc of locations) {
      if (loc.warehouseId !== warehouseId) {
        throw new BadRequestException('所选库位不属于该入库仓库');
      }
      labels.set(loc.id, loc.label);
    }
    return labels;
  }

  // ---------------- 库位/货架 ----------------

  listWarehouseLocations(query: WarehouseLocationQueryDto, user: AuthUser) {
    const tenantId = this.resolveTenantId(user, query.tenantId);
    const where: FindOptionsWhere<WarehouseLocation> = { tenantId };
    if (query.warehouseId) where.warehouseId = query.warehouseId;
    return this.dataSource.getRepository(WarehouseLocation).find({
      where,
      order: { id: 'ASC' },
    });
  }

  async createWarehouseLocation(dto: CreateWarehouseLocationDto, user: AuthUser) {
    const tenantId = this.resolveTenantId(user, dto.tenantId);
    await this.ensureWarehouse(this.dataSource.manager, tenantId, dto.warehouseId);
    const label = this.buildLocationLabel(dto.zone, dto.shelf, dto.bin);
    if (!label) throw new BadRequestException('请至少填写库区、货架或货位之一');
    return this.dataSource.getRepository(WarehouseLocation).save(
      this.dataSource.getRepository(WarehouseLocation).create({
        tenantId,
        warehouseId: dto.warehouseId,
        zone: dto.zone?.trim() || null,
        shelf: dto.shelf?.trim() || null,
        bin: dto.bin?.trim() || null,
        label,
        enabled: dto.enabled ?? true,
        createdBy: user.id,
        updatedBy: user.id,
      }),
    );
  }

  async updateWarehouseLocation(id: number, dto: UpdateWarehouseLocationDto, user: AuthUser) {
    const tenantId = this.resolveTenantId(user);
    const repo = this.dataSource.getRepository(WarehouseLocation);
    const location = await repo.findOne({ where: { id, tenantId } });
    if (!location) throw new NotFoundException('库位不存在');
    if (dto.zone !== undefined) location.zone = dto.zone?.trim() || null;
    if (dto.shelf !== undefined) location.shelf = dto.shelf?.trim() || null;
    if (dto.bin !== undefined) location.bin = dto.bin?.trim() || null;
    if (dto.enabled !== undefined) location.enabled = dto.enabled;
    location.label = this.buildLocationLabel(location.zone, location.shelf, location.bin);
    if (!location.label) throw new BadRequestException('请至少填写库区、货架或货位之一');
    location.updatedBy = user.id;
    return repo.save(location);
  }

  private buildLocationLabel(
    zone?: string | null,
    shelf?: string | null,
    bin?: string | null,
  ): string {
    return [zone?.trim(), shelf?.trim(), bin?.trim()].filter(Boolean).join('-');
  }

  listTransferOrders(query: TenantQueryDto, user: AuthUser) {
    const tenantId = this.resolveTenantId(user, query.tenantId);
    return this.transferOrderRepo.find({
      where: { tenantId },
      order: { id: 'DESC' },
    });
  }

  /** 发起调拨 → 进入经理审批（此时不扣库存，仅校验发货仓库存充足） */
  createTransferOrder(dto: CreateTransferOrderDto, user: AuthUser) {
    const tenantId = this.resolveTenantId(user, dto.tenantId);
    if (!dto.items.length) throw new BadRequestException('items is required');
    if (dto.fromWarehouseId === dto.toWarehouseId) {
      throw new BadRequestException('发货仓与接收仓不能相同');
    }
    return this.dataSource.transaction(async (manager) => {
      await this.ensureWarehouse(manager, tenantId, dto.fromWarehouseId);
      await this.ensureWarehouse(manager, tenantId, dto.toWarehouseId);
      await this.ensureMaterials(manager, tenantId, dto.items.map((item) => item.materialId));

      // 提交时校验发货仓当前库存足够（正式扣减在审批通过时）
      for (const item of dto.items) {
        const stock = await manager.findOne(Stock, {
          where: { tenantId, warehouseId: dto.fromWarehouseId, materialId: item.materialId },
        });
        if (Number(stock?.qty ?? 0) < item.qty) {
          throw new BadRequestException(`材料 #${item.materialId} 发货仓库存不足`);
        }
      }

      const saved = await manager.save(
        TransferOrder,
        manager.create(TransferOrder, {
          tenantId,
          transferNo: this.buildNo('TR'),
          fromWarehouseId: dto.fromWarehouseId,
          toWarehouseId: dto.toWarehouseId,
          items: dto.items.map((item) => ({ materialId: item.materialId, qty: item.qty })),
          status: TransferOrderStatus.PENDING_REVIEW,
          applicantId: user.id,
          note: dto.note ?? null,
          shippedAt: null,
          receivedAt: null,
          createdBy: user.id,
          updatedBy: user.id,
        }),
      );
      await this.notifyRoles(manager, tenantId, [UserRole.MANAGER, UserRole.ADMIN], {
        eventKey: 'transfer_pending_review',
        title: `调拨单 ${saved.transferNo} 待审批`,
        payload: { transferId: saved.id, transferNo: saved.transferNo },
        operatorId: user.id,
      });
      return saved;
    });
  }

  /** 经理审批通过 → 发货仓扣减、锁定在途，推送接收仓仓管 */
  approveTransferOrder(id: number, user: AuthUser) {
    const tenantId = this.resolveTenantId(user);
    return this.dataSource.transaction(async (manager) => {
      const transfer = await this.lockTransferOrder(manager, id, tenantId);
      if (transfer.status !== TransferOrderStatus.PENDING_REVIEW) {
        throw new BadRequestException('调拨单不在待审批状态');
      }
      const shippedItems: TransferOrder['items'] = [];
      for (const item of transfer.items) {
        const allocations = await this.consumeStockLots(manager, {
          tenantId,
          warehouseId: transfer.fromWarehouseId,
          materialId: item.materialId,
          qty: item.qty,
          operatorId: user.id,
        });
        await this.applyStockDelta(manager, {
          tenantId,
          warehouseId: transfer.fromWarehouseId,
          materialId: item.materialId,
          deltaQty: -item.qty,
          type: StockMovementType.TRANSFER,
          unitCostCents: this.averageUnitCost(allocations, item.qty),
          refType: 'transfer_order',
          refId: transfer.id,
          operatorId: user.id,
          note: `调拨出库 ${transfer.transferNo}`,
        });
        shippedItems.push({ ...item, allocations });
      }
      transfer.items = shippedItems;
      transfer.status = TransferOrderStatus.APPROVED;
      transfer.approverId = user.id;
      transfer.approvedAt = new Date();
      transfer.shippedAt = new Date();
      transfer.updatedBy = user.id;
      const saved = await manager.save(TransferOrder, transfer);
      await this.notifyWarehouseManagers(manager, tenantId, transfer.toWarehouseId, {
        eventKey: 'transfer_approved',
        title: `调拨单 ${transfer.transferNo} 已审批，待接收`,
        payload: { transferId: transfer.id, transferNo: transfer.transferNo },
        operatorId: user.id,
      });
      return saved;
    });
  }

  /** 经理驳回 */
  rejectTransferOrder(id: number, reason: string, user: AuthUser) {
    const tenantId = this.resolveTenantId(user);
    return this.dataSource.transaction(async (manager) => {
      const transfer = await this.lockTransferOrder(manager, id, tenantId);
      if (transfer.status !== TransferOrderStatus.PENDING_REVIEW) {
        throw new BadRequestException('调拨单不在待审批状态');
      }
      transfer.status = TransferOrderStatus.REJECTED;
      transfer.approverId = user.id;
      transfer.approvedAt = new Date();
      transfer.rejectReason = reason;
      transfer.updatedBy = user.id;
      const saved = await manager.save(TransferOrder, transfer);
      if (transfer.applicantId) {
        await this.notifyUsers(manager, tenantId, [transfer.applicantId], {
          eventKey: 'transfer_rejected',
          title: `调拨单 ${transfer.transferNo} 被驳回：${reason}`,
          payload: { transferId: transfer.id, transferNo: transfer.transferNo },
          operatorId: user.id,
        });
      }
      return saved;
    });
  }

  /** 接收仓确认收货（可修改实收数量）→ 按实收入接收仓，通知发货人 */
  receiveTransferOrder(id: number, dto: ReceiveTransferOrderDto, user: AuthUser) {
    const tenantId = this.resolveTenantId(user);
    const receivedByMaterial = new Map<number, number>();
    (dto.items ?? []).forEach((item) => receivedByMaterial.set(item.materialId, item.receivedQty));

    return this.dataSource.transaction(async (manager) => {
      const transfer = await this.lockTransferOrder(manager, id, tenantId);
      if (transfer.status !== TransferOrderStatus.APPROVED) {
        throw new BadRequestException('调拨单不在待接收状态');
      }
      let hasVariance = false;
      const finalItems: TransferOrder['items'] = [];
      for (const item of transfer.items) {
        const shippedQty = item.qty;
        const receivedQty = receivedByMaterial.has(item.materialId)
          ? Number(receivedByMaterial.get(item.materialId))
          : shippedQty;
        if (receivedQty < 0 || receivedQty > shippedQty) {
          throw new BadRequestException(`材料 #${item.materialId} 实收数量必须在 0 ~ ${shippedQty} 之间`);
        }
        if (receivedQty !== shippedQty) hasVariance = true;

        // 按发货批次成本，成比例入接收仓（实收/发出）
        const allocations = item.allocations?.length
          ? item.allocations
          : [{ stockLotId: 0, qty: shippedQty, unitCostCents: 0, amountCents: 0 }];
        let remainingToReceive = receivedQty;
        for (const [index, allocation] of allocations.entries()) {
          if (remainingToReceive <= 0) break;
          const take = Math.min(Number(allocation.qty), remainingToReceive);
          if (take <= 0) continue;
          await this.createStockLot(manager, {
            tenantId,
            warehouseId: transfer.toWarehouseId,
            materialId: item.materialId,
            qty: take,
            unitCostCents: allocation.unitCostCents,
            supplierId: null,
            purchaseOrderId: null,
            goodsReceiptId: null,
            sourceType: 'transfer_order',
            sourceId: transfer.id,
            lotNo: `${transfer.transferNo}-${String(index + 1).padStart(2, '0')}`,
            operatorId: user.id,
          });
          remainingToReceive = Number((remainingToReceive - take).toFixed(2));
        }
        if (receivedQty > 0) {
          await this.applyStockDelta(manager, {
            tenantId,
            warehouseId: transfer.toWarehouseId,
            materialId: item.materialId,
            deltaQty: receivedQty,
            type: StockMovementType.TRANSFER,
            unitCostCents: this.averageUnitCost(allocations, shippedQty),
            refType: 'transfer_order',
            refId: transfer.id,
            operatorId: user.id,
            note: `调拨入库 ${transfer.transferNo}`,
          });
        }
        finalItems.push({ ...item, receivedQty });
      }

      transfer.items = finalItems;
      transfer.status = TransferOrderStatus.RECEIVED;
      transfer.receiverId = user.id;
      transfer.receivedAt = new Date();
      transfer.updatedBy = user.id;
      const saved = await manager.save(TransferOrder, transfer);

      const notifyTargets = [transfer.applicantId].filter((v): v is number => !!v);
      if (notifyTargets.length) {
        await this.notifyUsers(manager, tenantId, notifyTargets, {
          eventKey: hasVariance ? 'transfer_received_variance' : 'transfer_received',
          title: hasVariance
            ? `调拨单 ${transfer.transferNo} 已接收（存在实收差异，请核查）`
            : `调拨单 ${transfer.transferNo} 已接收完成`,
          payload: { transferId: transfer.id, transferNo: transfer.transferNo, hasVariance },
          operatorId: user.id,
        });
      }
      return saved;
    });
  }

  private async applyStockDelta(
    manager: EntityManager,
    input: {
      tenantId: number;
      warehouseId: number;
      materialId: number;
      deltaQty: number;
      type: StockMovementType;
      unitCostCents: number;
      refType: string;
      refId: number;
      operatorId: number | null;
      note?: string | null;
    },
  ) {
    let stock = await manager.findOne(Stock, {
      where: {
        tenantId: input.tenantId,
        warehouseId: input.warehouseId,
        materialId: input.materialId,
      },
      lock: { mode: 'pessimistic_write' },
    });
    if (!stock) {
      stock = manager.create(Stock, {
        tenantId: input.tenantId,
        warehouseId: input.warehouseId,
        materialId: input.materialId,
        qty: 0,
        safetyQty: 0,
        createdBy: input.operatorId,
        updatedBy: input.operatorId,
      });
    }
    const nextQty = Number(stock.qty) + input.deltaQty;
    if (nextQty < 0) throw new BadRequestException('stock is insufficient');
    stock.qty = nextQty;
    stock.updatedBy = input.operatorId;
    await manager.save(Stock, stock);

    await manager.save(
      StockMovement,
      manager.create(StockMovement, {
        tenantId: input.tenantId,
        warehouseId: input.warehouseId,
        materialId: input.materialId,
        type: input.type,
        qty: input.deltaQty,
        unitCostCents: input.unitCostCents,
        refType: input.refType,
        refId: input.refId,
        note: input.note ?? null,
        createdBy: input.operatorId,
        updatedBy: input.operatorId,
      }),
    );
  }

  private async createStockLot(
    manager: EntityManager,
    input: {
      tenantId: number;
      warehouseId: number;
      materialId: number;
      qty: number;
      unitCostCents: number;
      supplierId: number | null;
      purchaseOrderId: number | null;
      goodsReceiptId: number | null;
      sourceType: string;
      sourceId: number;
      lotNo: string;
      operatorId: number | null;
    },
  ) {
    return manager.save(
      StockLot,
      manager.create(StockLot, {
        tenantId: input.tenantId,
        warehouseId: input.warehouseId,
        materialId: input.materialId,
        lotNo: input.lotNo,
        initialQty: input.qty,
        remainingQty: input.qty,
        unitCostCents: input.unitCostCents,
        supplierId: input.supplierId,
        purchaseOrderId: input.purchaseOrderId,
        goodsReceiptId: input.goodsReceiptId,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        receivedAt: new Date(),
        createdBy: input.operatorId,
        updatedBy: input.operatorId,
      }),
    );
  }

  private async consumeStockLots(
    manager: EntityManager,
    input: {
      tenantId: number;
      warehouseId: number;
      materialId: number;
      qty: number;
      operatorId: number | null;
    },
  ): Promise<LotAllocation[]> {
    await this.ensureLegacyLotIfNeeded(manager, input);
    const lots = await manager
      .createQueryBuilder(StockLot, 'lot')
      .where('lot.tenant_id = :tenantId', { tenantId: input.tenantId })
      .andWhere('lot.warehouse_id = :warehouseId', { warehouseId: input.warehouseId })
      .andWhere('lot.material_id = :materialId', { materialId: input.materialId })
      .andWhere('lot.remaining_qty > 0')
      .orderBy('lot.received_at', 'ASC')
      .addOrderBy('lot.id', 'ASC')
      .setLock('pessimistic_write')
      .getMany();

    let remaining = input.qty;
    const allocations: LotAllocation[] = [];
    for (const lot of lots) {
      if (remaining <= 0) break;
      const available = Number(lot.remainingQty);
      const take = Math.min(available, remaining);
      if (take <= 0) continue;
      lot.remainingQty = available - take;
      lot.updatedBy = input.operatorId;
      await manager.save(StockLot, lot);
      allocations.push({
        stockLotId: lot.id,
        qty: take,
        unitCostCents: lot.unitCostCents,
        amountCents: Math.round(take * lot.unitCostCents),
      });
      remaining = Number((remaining - take).toFixed(2));
    }
    if (remaining > 0) throw new BadRequestException('stock lot is insufficient');
    return allocations;
  }

  private async ensureLegacyLotIfNeeded(
    manager: EntityManager,
    input: {
      tenantId: number;
      warehouseId: number;
      materialId: number;
      qty: number;
      operatorId: number | null;
    },
  ) {
    const lots = await manager.find(StockLot, {
      where: {
        tenantId: input.tenantId,
        warehouseId: input.warehouseId,
        materialId: input.materialId,
      },
    });
    const lotQty = lots.reduce((sum, lot) => sum + Number(lot.remainingQty), 0);
    if (lotQty >= input.qty) return;

    const stock = await manager.findOne(Stock, {
      where: {
        tenantId: input.tenantId,
        warehouseId: input.warehouseId,
        materialId: input.materialId,
      },
      lock: { mode: 'pessimistic_write' },
    });
    const stockQty = Number(stock?.qty ?? 0);
    const missingLotQty = Number((stockQty - lotQty).toFixed(2));
    if (missingLotQty <= 0) return;

    const material = await manager.findOne(Material, {
      where: { id: input.materialId, tenantId: input.tenantId },
    });
    await manager.save(
      StockLot,
      manager.create(StockLot, {
        tenantId: input.tenantId,
        warehouseId: input.warehouseId,
        materialId: input.materialId,
        lotNo: `LEGACY-${input.warehouseId}-${input.materialId}`,
        initialQty: missingLotQty,
        remainingQty: missingLotQty,
        unitCostCents: material?.defaultCostCents ?? 0,
        supplierId: null,
        purchaseOrderId: null,
        goodsReceiptId: null,
        sourceType: 'legacy_stock',
        sourceId: stock?.id ?? null,
        receivedAt: new Date(0),
        createdBy: input.operatorId,
        updatedBy: input.operatorId,
      }),
    );
  }

  private averageUnitCost(allocations: LotAllocation[], qty: number): number {
    if (!qty) return 0;
    const total = allocations.reduce((sum, item) => sum + item.amountCents, 0);
    return Math.round(total / qty);
  }

  private async buildMaterialCode(tenantId: number, category: string): Promise<string> {
    const prefix = MATERIAL_CATEGORY_PREFIX[category] ?? 'QT';
    const rows = await this.materialRepo
      .createQueryBuilder('material')
      .select('material.code', 'code')
      .where('material.tenant_id = :tenantId', { tenantId })
      .andWhere('material.code LIKE :pattern', { pattern: `${prefix}-%` })
      .getRawMany<{ code: string }>();
    const maxSeq = rows.reduce((max, row) => {
      const match = row.code.match(new RegExp(`^${prefix}-(\\d+)$`));
      return match ? Math.max(max, Number(match[1])) : max;
    }, 0);
    return `${prefix}-${String(maxSeq + 1).padStart(4, '0')}`;
  }

  private async ensureWarehouse(manager, tenantId: number, warehouseId: number) {
    const warehouse = await manager.findOne(Warehouse, {
      where: { id: warehouseId, tenantId, enabled: true },
    });
    if (!warehouse) throw new NotFoundException('warehouse not found');
    return warehouse;
  }

  private async ensureMaterials(manager, tenantId: number, materialIds: number[]) {
    const uniqueIds = Array.from(new Set(materialIds));
    for (const id of uniqueIds) {
      const material = await manager.findOne(Material, {
        where: { id, tenantId, enabled: true },
      });
      if (!material) throw new NotFoundException(`material not found: ${id}`);
    }
  }

  private async lockPurchaseRequest(manager, id: number, tenantId: number) {
    const request = await manager.findOne(PurchaseRequest, {
      where: { id, tenantId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!request) throw new NotFoundException('purchase request not found');
    return request;
  }

  private async lockTransferOrder(manager, id: number, tenantId: number) {
    const transfer = await manager.findOne(TransferOrder, {
      where: { id, tenantId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!transfer) throw new NotFoundException('transfer order not found');
    return transfer;
  }

  private materialLabel(material: Material): string {
    return material.spec ? `${material.name}（${material.spec}）` : material.name;
  }

  private buildNo(prefix: string): string {
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const tail = String(now.getTime()).slice(-8);
    return `${prefix}-${yyyy}${mm}${dd}-${tail}`;
  }

  private resolveTenantId(user: AuthUser, requestedTenantId?: number): number {
    // 公司视角由 JwtStrategy 校验 x-acting-tenant-id 后写入 user.tenantId。
    // 角色仍是 superadmin，因此这里必须先使用已经验证过的租户范围。
    if (user.tenantId) {
      if (requestedTenantId && requestedTenantId !== user.tenantId) {
        throw new ForbiddenException('tenant mismatch');
      }
      return user.tenantId;
    }
    if (user.role === UserRole.SUPERADMIN) {
      if (!requestedTenantId) {
        throw new BadRequestException('tenantId is required for superadmin');
      }
      return requestedTenantId;
    }
    throw new ForbiddenException('tenant scope is required');
  }

  private async notifyUsers(
    manager: EntityManager,
    tenantId: number,
    receiverIds: number[],
    input: NotifyInput,
  ) {
    const uniqueIds = Array.from(new Set(receiverIds)).filter((id) => !!id);
    if (!uniqueIds.length) return;
    await manager.save(
      Notification,
      uniqueIds.map((receiverId) =>
        manager.create(Notification, {
          tenantId,
          receiverId,
          channel: NotifyChannel.IN_APP,
          eventKey: input.eventKey,
          title: input.title,
          payload: input.payload,
          status: NotifyStatus.SENT,
          readAt: null,
          createdBy: input.operatorId,
          updatedBy: input.operatorId,
        }),
      ),
    );
  }

  private async notifyRoles(
    manager: EntityManager,
    tenantId: number,
    roles: UserRole[],
    input: NotifyInput,
  ) {
    const users = await manager.find(User, {
      where: { tenantId, role: In(roles), status: UserStatus.ACTIVE },
      select: ['id'],
    });
    await this.notifyUsers(manager, tenantId, users.map((u) => u.id), input);
  }

  /** 通知某仓库的仓管（员工档案绑定该仓）；无绑定则回退给经理/管理员 */
  private async notifyWarehouseManagers(
    manager: EntityManager,
    tenantId: number,
    warehouseId: number,
    input: NotifyInput,
  ) {
    const profiles = await manager
      .createQueryBuilder(StaffProfile, 'p')
      .where('p.tenant_id = :tenantId', { tenantId })
      .andWhere('p.warehouse_ids @> :wid', { wid: JSON.stringify([warehouseId]) })
      .getMany();
    const receiverIds = profiles.map((p) => p.userId);
    if (receiverIds.length) {
      await this.notifyUsers(manager, tenantId, receiverIds, input);
    } else {
      await this.notifyRoles(manager, tenantId, [UserRole.MANAGER, UserRole.ADMIN, UserRole.OFFICE], input);
    }
  }
}
