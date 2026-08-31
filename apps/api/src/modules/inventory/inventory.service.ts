import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AccessService, ResolvedAccess } from '../access/access.service';
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
  Community,
  ManagementOffice,
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
  StockMovementQueryDto,
  StockQueryDto,
  SubmitToManagerDto,
  TenantQueryDto,
  WarehousesQueryDto,
  UpdateMaterialDto,
  UpdateSupplierDto,
  UpdateStockDto,
  UpdateWarehouseDto,
  UpdateWarehouseLocationDto,
  WarehouseLocationQueryDto,
} from './dto';
import { ObjectStorageService } from '../upload/object-storage.service';
import {
  applyStockDelta,
  averageUnitCost,
  consumeStockLots,
  createStockLot,
  refreshMaterialReferenceCost,
  resolveStockValue,
  resolveUnitCost,
  summarizeLots,
} from './stock-ledger';

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

@Injectable()
export class InventoryService {
  constructor(
    private readonly accessService: AccessService,
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

  /**
   * 材料 SKU 全量（后台材料页、小程序「材料与库存」都用它）。
   *
   * 照片必须过 toDisplayUrl —— 和 /materials/options 同一个理由：库里存量数据有
   * COS 直连地址（私有桶直取 403）和相对代理路径（小程序当成本地包路径，渲染成一张白图）。
   * 2026-08-25 修过选料弹层那条路，漏了这一条，于是同一张照片在弹层里看得见、
   * 在材料库页是白的。**新增任何返回 photoUrl 的接口都要过这个函数。**
   */
  async listMaterials(query: TenantQueryDto, user: AuthUser) {
    const tenantId = this.resolveTenantId(user, query.tenantId);
    const materials = await this.materialRepo.find({
      where: { tenantId },
      order: { id: 'ASC' },
    });
    return materials.map((item) => this.withDisplayPhoto(item));
  }

  /** 出参统一走这里换照片地址，别在各处 map 里各写一遍 */
  private withDisplayPhoto<T extends { photoUrl?: string | null }>(item: T): T {
    return { ...item, photoUrl: this.storage.toDisplayUrl(item.photoUrl) || null };
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
    const saved = await this.materialRepo.save(
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
    // 新建完端上会直接把返回值塞进列表，照片地址要和 listMaterials 一个口径
    return this.withDisplayPhoto(saved);
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
    return this.withDisplayPhoto(await this.materialRepo.save(material));
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

  /**
   * 仓库列表。scope=mine 时按本人角色范围过滤（2026-08-27 要求「按报修类型配置里的范围显示 / 隐藏」）：
   *   · 全公司范围的人（总公司维修工 / 办公室 / 采购）→ 全部仓
   *   · 管理处范围的人 → 只有自己管理处的仓（员工端默认选第一个）；别的管理处的仓和公司级总仓都不出现
   * 工单选料的候选仓（listWorkOrderStockOptions）也是同一条规则，两处别各写一套。
   */
  async listWarehouses(query: WarehousesQueryDto, user: AuthUser) {
    const tenantId = this.resolveTenantId(user, query.tenantId);
    const all = await this.warehouseRepo.find({
      where: { tenantId },
      order: { id: 'ASC' },
    });
    const list = query.scope === 'mine' ? await this.filterWarehousesForUser(tenantId, user.id, all) : all;
    // 懒补「所属管理处」：加字段之前建的小区仓按 小区 → 管理处 推一次并落库，
    // 之后人员按管理处匹配仓库就有依据了；总仓（不挂小区）保持公司级
    const missing = list.filter((item) => !item.officeId && item.communityId);
    if (missing.length) {
      const communities = await this.dataSource.getRepository(Community).find({
        where: { tenantId, id: In(missing.map((item) => item.communityId as number)) },
        select: ['id', 'officeId', 'parentId'],
      });
      const parents = communities.filter((c) => !c.officeId && c.parentId);
      const parentRows = parents.length
        ? await this.dataSource.getRepository(Community).find({
            where: { tenantId, id: In(parents.map((c) => c.parentId as number)) },
            select: ['id', 'officeId'],
          })
        : [];
      const officeByCommunity = new Map<number, number | null>();
      for (const c of communities) {
        const viaParent = c.parentId ? parentRows.find((p) => p.id === c.parentId)?.officeId : null;
        officeByCommunity.set(c.id, c.officeId ?? viaParent ?? null);
      }
      const toSave = missing.filter((item) => officeByCommunity.get(item.communityId as number));
      if (toSave.length) {
        toSave.forEach((item) => {
          item.officeId = officeByCommunity.get(item.communityId as number) ?? null;
        });
        await this.warehouseRepo.save(toSave);
      }
    }
    return this.withOwnerNames(tenantId, list);
  }

  /**
   * 仓库列表带上管理处名 / 小区名。
   * 前端原来拿登录时下发的 `access.offices` 去查名字，那是「本人可切换的管理处」，
   * 新建管理处后不重登就查不到，档案页上直接显示成「#5」（2026-08-30 反馈）。
   * 名字由后端给，前端不再有第二份字典。
   */
  private async withOwnerNames(tenantId: number, list: Warehouse[]) {
    const officeIds = [...new Set(list.map((w) => w.officeId).filter((id): id is number => !!id))];
    const communityIds = [...new Set(list.map((w) => w.communityId).filter((id): id is number => !!id))];
    const [offices, communities] = await Promise.all([
      officeIds.length
        ? this.dataSource.getRepository(ManagementOffice).find({
            where: { tenantId, id: In(officeIds) },
            select: ['id', 'name'],
          })
        : Promise.resolve([]),
      communityIds.length
        ? this.dataSource.getRepository(Community).find({
            where: { tenantId, id: In(communityIds) },
            select: ['id', 'name'],
          })
        : Promise.resolve([]),
    ]);
    const officeName = new Map(offices.map((o) => [o.id, o.name]));
    const communityName = new Map(communities.map((c) => [c.id, c.name]));
    return list.map((w) => ({
      ...w,
      officeName: w.officeId ? officeName.get(w.officeId) ?? null : null,
      communityName: w.communityId ? communityName.get(w.communityId) ?? null : null,
    }));
  }

  /**
   * 本次请求能看到哪些仓 —— 库存清单、流水、汇总统一走这里，新增按仓查询的接口直接引。
   *
   * · 全公司数据范围：全部仓，包括不挂管理处的公司总仓
   * · 受限角色 / 顶栏切了管理处视角：只有该管理处名下的仓，**公司总仓不给**
   *
   * 「谁能看总仓」就是数据范围本身，不另设开关：管理处角色看到总仓的库存也领不到，
   * 反而会拿它当自己的可用量。要放开就把那个角色的数据范围改成全公司（业务角色页）。
   * 返回 null = 不过滤。
   */
  private async visibleWarehouseIds(
    tenantId: number,
    user: AuthUser,
    access?: ResolvedAccess,
  ): Promise<number[] | null> {
    const officeId = access?.actingOfficeId ?? null;
    if (!officeId && (!access || access.scopeAll)) return null;
    const all = await this.warehouseRepo.find({ where: { tenantId }, select: ['id', 'officeId'] });
    // 角色额外授权的仓一直可见：总仓不挂管理处，切了管理处视角也不该把它藏掉
    const extra = new Set(await this.accessService.extraWarehouseIdsOfUser(tenantId, user.id));
    if (officeId) {
      return all.filter((w) => w.officeId === officeId || extra.has(w.id)).map((w) => w.id);
    }
    const mine = await this.accessService.userOfficeIds(tenantId, user.id);
    if (mine.all) return null;
    const offices = new Set(mine.officeIds);
    return all
      .filter((w) => (w.officeId && offices.has(w.officeId)) || extra.has(w.id))
      .map((w) => w.id);
  }

  /**
   * 仓库表单「所属管理处」的下拉选项。
   * 前端原来用登录下发的 access.offices，那是「可切换的管理处」，新建的管理处
   * 不重登就选不到；改成现取。受限角色只给自己范围内的。
   */
  async listWarehouseOfficeOptions(user: AuthUser) {
    const tenantId = this.resolveTenantId(user);
    const offices = await this.dataSource.getRepository(ManagementOffice).find({
      where: { tenantId, enabled: true },
      order: { id: 'ASC' },
    });
    const mine = await this.accessService.userOfficeIds(tenantId, user.id);
    const list = mine.all ? offices : offices.filter((o) => mine.officeIds.includes(o.id));
    return list.map((o) => ({ id: o.id, name: o.name }));
  }

  /** 默认库位必须是这个仓自己的库位，不能拿别的仓的 */
  private async assertLocationOfWarehouse(
    tenantId: number,
    warehouseId: number,
    locationId: number | null | undefined,
  ): Promise<number | null> {
    if (!locationId) return null;
    const location = await this.dataSource.getRepository(WarehouseLocation).findOne({
      where: { id: locationId, tenantId, warehouseId },
    });
    if (!location) throw new BadRequestException('库位不属于这个仓库');
    return location.id;
  }

  /** 仓库配的默认入库库位；没配或已停用就返回 null（入库时手动挑） */
  private async defaultLocationOf(
    manager: EntityManager,
    tenantId: number,
    warehouseId: number,
  ): Promise<number | null> {
    const warehouse = await manager.findOne(Warehouse, {
      where: { id: warehouseId, tenantId },
      select: ['id', 'defaultLocationId'],
    });
    if (!warehouse?.defaultLocationId) return null;
    const location = await manager.findOne(WarehouseLocation, {
      where: { id: warehouse.defaultLocationId, tenantId, warehouseId, enabled: true },
      select: ['id'],
    });
    return location?.id ?? null;
  }

  /** 「只看总仓 / 只看管理处仓 / 只看小区仓」筛选。不传返回 null = 不筛 */
  private async warehouseIdsOfType(
    tenantId: number,
    type?: string,
  ): Promise<number[] | null> {
    if (!type) return null;
    if (!Object.values(WarehouseType).includes(type as WarehouseType)) {
      throw new BadRequestException('invalid warehouse type');
    }
    const rows = await this.warehouseRepo.find({
      where: { tenantId, type: type as WarehouseType },
      select: ['id'],
    });
    return rows.map((w) => w.id);
  }

  private intersectIds(a: number[] | null, b: number[] | null): number[] | null {
    if (!a) return b;
    if (!b) return a;
    const set = new Set(b);
    return a.filter((id) => set.has(id));
  }

  /** 按本人角色范围留下能看的仓：自己管理处的排前面，然后是公司级的；全公司范围的人不过滤 */
  async filterWarehousesForUser(tenantId: number, userId: number, all: Warehouse[]): Promise<Warehouse[]> {
    const mine = await this.accessService.userOfficeIds(tenantId, userId);
    if (mine.all) return all;
    const offices = new Set(mine.officeIds);
    // 严格按范围：只有自己管理处的仓，公司级总仓也不给（2026-08-27 Mike 定的口径）
    // —— 除非角色在「额外可见的仓库」里点名给了（2026-08-30）。
    // 管理处没建仓、也没额外授权 = 一个都看不到，端上会提示去建仓
    const extra = new Set(await this.accessService.extraWarehouseIdsOfUser(tenantId, userId));
    return all.filter((item) => (item.officeId && offices.has(item.officeId)) || extra.has(item.id));
  }

  /** 仓库归属校验：类型和挂靠要对得上，管理处得是本公司的 */
  private async resolveWarehouseBinding(
    tenantId: number,
    type: WarehouseType,
    communityId: number | null | undefined,
    officeId: number | null | undefined,
  ): Promise<{ communityId: number | null; officeId: number | null }> {
    if (!Object.values(WarehouseType).includes(type)) {
      throw new BadRequestException('invalid warehouse type');
    }
    if (type === WarehouseType.COMMUNITY && !communityId) {
      throw new BadRequestException('小区仓必须填小区');
    }
    if (type === WarehouseType.OFFICE && !officeId) {
      throw new BadRequestException('管理处仓必须选所属管理处');
    }
    if (officeId) {
      const office = await this.dataSource
        .getRepository(ManagementOffice)
        .findOne({ where: { id: officeId, tenantId } });
      if (!office) throw new BadRequestException('管理处不存在');
    }
    const nextCommunityId = type === WarehouseType.COMMUNITY ? (communityId as number) : null;
    // 小区仓没单独选管理处时按小区推，省得每个仓都要手动挑一遍
    let nextOfficeId = officeId ?? null;
    if (!nextOfficeId && nextCommunityId) {
      const community = await this.dataSource.getRepository(Community).findOne({
        where: { tenantId, id: nextCommunityId },
        select: ['id', 'officeId', 'parentId'],
      });
      nextOfficeId = community?.officeId ?? null;
      if (!nextOfficeId && community?.parentId) {
        const parent = await this.dataSource.getRepository(Community).findOne({
          where: { tenantId, id: community.parentId },
          select: ['id', 'officeId'],
        });
        nextOfficeId = parent?.officeId ?? null;
      }
    }
    return { communityId: nextCommunityId, officeId: nextOfficeId };
  }

  async createWarehouse(dto: CreateWarehouseDto, user: AuthUser) {
    const tenantId = this.resolveTenantId(user, dto.tenantId);
    const binding = await this.resolveWarehouseBinding(tenantId, dto.type, dto.communityId, dto.officeId);
    return this.warehouseRepo.save(
      this.warehouseRepo.create({
        tenantId,
        name: dto.name,
        type: dto.type,
        communityId: binding.communityId,
        officeId: binding.officeId,
        defaultLocationId: null, // 库位得先建出来才能选，新建仓时还没有
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
    const binding = await this.resolveWarehouseBinding(
      tenantId,
      nextType,
      dto.communityId ?? warehouse.communityId,
      // 显式传 null = 清成公司级；不传 = 不动
      dto.officeId === undefined ? warehouse.officeId : dto.officeId,
    );
    if (dto.name !== undefined) warehouse.name = dto.name;
    warehouse.type = nextType;
    warehouse.communityId = binding.communityId;
    warehouse.officeId = binding.officeId;
    if (dto.defaultLocationId !== undefined) {
      warehouse.defaultLocationId = await this.assertLocationOfWarehouse(
        tenantId,
        id,
        dto.defaultLocationId,
      );
    }
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

  /**
   * 库存清单。每行附带剩余批次的数量 / 金额 / 加权均价，后台估值用它，
   * 和报表页「库存清单」是同一口径（resolveUnitCost）：有批次按批次加权，没有才退回 SKU 参考成本。
   */
  async listStocks(query: StockQueryDto, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.resolveTenantId(user, query.tenantId);
    const where: FindOptionsWhere<Stock> = { tenantId };
    // 清单一直是「全公司所有仓」，顶栏切了管理处也纹丝不动（2026-08-30 反馈）。
    // 顶栏那个切换器就是本页的数据范围，这里跟着收窄。
    const visible = await this.visibleWarehouseIds(tenantId, user, access);
    const typed = await this.warehouseIdsOfType(tenantId, query.warehouseType);
    const allowed = this.intersectIds(visible, typed);
    if (allowed && !allowed.length) return [];
    if (query.warehouseId) {
      if (allowed && !allowed.includes(query.warehouseId)) return [];
      where.warehouseId = query.warehouseId;
    } else if (allowed) {
      where.warehouseId = In(allowed);
    }
    if (query.materialId) where.materialId = query.materialId;
    const [rows, lotMap] = await Promise.all([
      this.stockRepo.find({ where, order: { id: 'ASC' } }),
      summarizeLots(this.dataSource.manager, tenantId, {
        warehouseId: query.warehouseId,
        materialId: query.materialId,
      }),
    ]);
    const materialIds = [...new Set(rows.map((row) => row.materialId))];
    const materials = materialIds.length
      ? await this.materialRepo.find({ where: { tenantId, id: In(materialIds) } })
      : [];
    const defaultCostById = new Map(materials.map((m) => [m.id, m.defaultCostCents]));
    // 库位名一起带出来，清单直接显示「东西放在哪一格」，不用点进批次去猜
    const locationIds = [...new Set(rows.map((r) => r.locationId).filter((id): id is number => !!id))];
    const locations = locationIds.length
      ? await this.dataSource.getRepository(WarehouseLocation).find({
          where: { tenantId, id: In(locationIds) },
          select: ['id', 'label'],
        })
      : [];
    const locationLabel = new Map(locations.map((l) => [l.id, l.label]));
    return rows.map((row) => {
      const lot = lotMap.get(`${row.warehouseId}:${row.materialId}`);
      const lotQty = lot?.lotQty ?? 0;
      const lotValueCents = lot?.lotValueCents ?? 0;
      const unitCostCents = resolveUnitCost(lotQty, lotValueCents, defaultCostById.get(row.materialId) ?? 0);
      return {
        ...row,
        lotQty,
        lotValueCents,
        unitCostCents,
        costSource: lotQty > 0 ? 'lot' : 'default',
        // 金额从批次原值加总，别用均价乘回去（见 resolveStockValue 注释）
        amountCents: resolveStockValue(Number(row.qty), lotQty, lotValueCents, defaultCostById.get(row.materialId) ?? 0),
        locationLabel: row.locationId ? locationLabel.get(row.locationId) ?? null : null,
      };
    });
  }

  /** 某条库存的批次明细（含已耗尽的），先进先出的顺序 */
  async listStockLots(stockId: number, user: AuthUser) {
    const tenantId = this.resolveTenantId(user);
    const stock = await this.stockRepo.findOne({ where: { id: stockId, tenantId } });
    if (!stock) throw new NotFoundException('stock not found');
    return this.dataSource.getRepository(StockLot).find({
      where: { tenantId, warehouseId: stock.warehouseId, materialId: stock.materialId },
      order: { receivedAt: 'ASC', id: 'ASC' },
      take: 200,
    });
  }

  /** 出入库流水，最新在前 */
  async listStockMovements(query: StockMovementQueryDto, user: AuthUser) {
    const tenantId = this.resolveTenantId(user, query.tenantId);
    const where: FindOptionsWhere<StockMovement> = { tenantId };
    if (query.warehouseId) where.warehouseId = query.warehouseId;
    if (query.materialId) where.materialId = query.materialId;
    return this.dataSource.getRepository(StockMovement).find({
      where,
      order: { id: 'DESC' },
      take: Math.min(query.limit ?? 100, 500),
    });
  }

  /**
   * 盘点调整。数量只能通过批次变：
   * - 盘盈：新建一条批次，单价用填的，不填取 SKU 参考成本，之后刷新参考成本；
   * - 盘亏：先进先出扣批次，流水成本取被扣批次的加权价。
   * 以前是直接改 stocks.qty 不动批次，结果批次和实物对不上、下次出库扣到不存在的批次。
   */
  async updateStock(id: number, dto: UpdateStockDto, user: AuthUser) {
    const tenantId = this.resolveTenantId(user);
    return this.dataSource.transaction(async (manager) => {
      const stock = await manager.findOne(Stock, {
        where: { id, tenantId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!stock) throw new NotFoundException('stock not found');
      if (dto.safetyQty !== undefined) {
        stock.safetyQty = dto.safetyQty;
        stock.updatedBy = user.id;
        await manager.save(Stock, stock);
      }
      const previousQty = Number(stock.qty);
      const deltaQty = dto.qty !== undefined ? Number((dto.qty - previousQty).toFixed(2)) : 0;
      if (deltaQty === 0) return stock;

      const note = dto.note?.trim() ? `盘点调整：${dto.note.trim()}` : '盘点调整';
      if (deltaQty > 0) {
        const material = await manager.findOne(Material, { where: { id: stock.materialId, tenantId } });
        const unitCostCents = dto.unitCostCents ?? material?.defaultCostCents ?? 0;
        await createStockLot(manager, {
          tenantId,
          warehouseId: stock.warehouseId,
          materialId: stock.materialId,
          qty: deltaQty,
          unitCostCents,
          supplierId: null,
          purchaseOrderId: null,
          goodsReceiptId: null,
          sourceType: 'stock_adjust',
          sourceId: stock.id,
          lotNo: this.buildNo('ADJ'),
          operatorId: user.id,
        });
        const saved = await applyStockDelta(manager, {
          tenantId,
          warehouseId: stock.warehouseId,
          materialId: stock.materialId,
          deltaQty,
          type: StockMovementType.ADJUST,
          unitCostCents,
          refType: 'stock',
          refId: stock.id,
          operatorId: user.id,
          note,
        });
        await refreshMaterialReferenceCost(manager, tenantId, stock.materialId, user.id);
        return saved;
      }

      const allocations = await consumeStockLots(manager, {
        tenantId,
        warehouseId: stock.warehouseId,
        materialId: stock.materialId,
        qty: -deltaQty,
        operatorId: user.id,
      });
      return applyStockDelta(manager, {
        tenantId,
        warehouseId: stock.warehouseId,
        materialId: stock.materialId,
        deltaQty,
        type: StockMovementType.ADJUST,
        unitCostCents: averageUnitCost(allocations, -deltaQty),
        refType: 'stock',
        refId: stock.id,
        operatorId: user.id,
        note,
      });
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
      await this.notifyByPermission(manager, tenantId, 'app:approve-manager', {
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
      await this.notifyByPermission(manager, tenantId, 'app:approve-purchaser', {
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
      // 每行没单独挑库位时落到仓库的默认库位，省得每次入库都从头选（2026-08-30）
      const defaultLocationId = await this.defaultLocationOf(manager, tenantId, dto.warehouseId);

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
        await createStockLot(manager, {
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
        await applyStockDelta(manager, {
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
          locationId: item.locationId ?? defaultLocationId,
        });
      }
      await this.refreshReferenceCosts(manager, tenantId, dto.items.map((item) => item.materialId), user.id);

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
        await this.notifyByPermission(
          manager,
          tenantId,
          ['app:approve-purchaser', 'app:inventory'],
          {
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
      // 每行没单独挑库位时落到仓库的默认库位，省得每次入库都从头选（2026-08-30）
      const defaultLocationId = await this.defaultLocationOf(manager, tenantId, dto.warehouseId);

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
        await createStockLot(manager, {
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
        await applyStockDelta(manager, {
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
          locationId: item.locationId ?? defaultLocationId,
        });
      }
      await this.refreshReferenceCosts(manager, tenantId, dto.items.map((item) => item.materialId), user.id);
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
      await this.notifyByPermission(manager, tenantId, 'app:approve-manager', {
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
        const allocations = await consumeStockLots(manager, {
          tenantId,
          warehouseId: transfer.fromWarehouseId,
          materialId: item.materialId,
          qty: item.qty,
          operatorId: user.id,
        });
        await applyStockDelta(manager, {
          tenantId,
          warehouseId: transfer.fromWarehouseId,
          materialId: item.materialId,
          deltaQty: -item.qty,
          type: StockMovementType.TRANSFER,
          unitCostCents: averageUnitCost(allocations, item.qty),
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
      // 收货人可以指定入哪个库位，没指定就用接收仓的默认库位
      const receiveLocationId =
        dto.locationId ??
        (await this.defaultLocationOf(manager, tenantId, transfer.toWarehouseId));
      if (dto.locationId) {
        const exists = await manager.findOne(WarehouseLocation, {
          where: { id: dto.locationId, tenantId, warehouseId: transfer.toWarehouseId },
        });
        if (!exists) throw new BadRequestException('库位不属于接收仓');
      }
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
          await createStockLot(manager, {
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
          await applyStockDelta(manager, {
            tenantId,
            warehouseId: transfer.toWarehouseId,
            materialId: item.materialId,
            deltaQty: receivedQty,
            type: StockMovementType.TRANSFER,
            unitCostCents: averageUnitCost(allocations, shippedQty),
            refType: 'transfer_order',
            refId: transfer.id,
            operatorId: user.id,
            note: `调拨入库 ${transfer.transferNo}`,
            locationId: receiveLocationId,
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

  /** 入库 / 盘盈后按材料去重刷新参考成本（同一张单里同一材料可能有多行） */
  private async refreshReferenceCosts(
    manager: EntityManager,
    tenantId: number,
    materialIds: number[],
    operatorId: number | null,
  ) {
    for (const materialId of new Set(materialIds)) {
      await refreshMaterialReferenceCost(manager, tenantId, materialId, operatorId);
    }
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

  /**
   * 通知「有这一档权限的人」。
   *
   * 以前是 notifyRoles(..., [MANAGER, ADMIN], ...) 按业务身份找人 ——
   * 于是「谁该收待审批提醒」和「谁真的能批」是两套判断，配了新角色就对不上。
   * 现在两边同一个 key：能批的人才会收到待批提醒。
   */
  private async notifyByPermission(
    manager: EntityManager,
    tenantId: number,
    pageKeys: string | string[],
    input: NotifyInput,
  ) {
    const keys = Array.isArray(pageKeys) ? pageKeys : [pageKeys];
    const idSets = await Promise.all(
      keys.map((key) => this.accessService.userIdsWithPermission(tenantId, key, 'edit')),
    );
    const ids = [...new Set(idSets.flat())];
    if (!ids.length) return;
    const users = await manager.find(User, {
      where: { id: In(ids), tenantId, status: UserStatus.ACTIVE },
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
      await this.notifyByPermission(manager, tenantId, ['app:approve-manager', 'app:inventory'], input);
    }
  }
}
