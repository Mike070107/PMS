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
  DictType,
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
  DictItem,
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
  WorkOrder,
} from '../../entities';
import { scopeCommunityIds } from '../access/scope.util';
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
  UpsertMaterialCategoryDto,
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
  /** undefined = 沿用公司级旧行为；null = 只通知全公司范围；数字 = 覆盖该管理处 */
  officeId?: number | null;
}

/**
 * 一条 SKU 最多几张实物照片。四张的来历：正面、侧面、铭牌/型号、包装 ——
 * 维修工在库房比对时正是按这四样认货。改这个数要同步改端上的选图上限。
 */
const MATERIAL_PHOTO_LIMIT = 4;

/**
 * 内置材料类别的**种子**：名称 → SKU 编码前缀（五金 → WJ-0001）。
 *
 * 这份表只在「公司第一次打开材料类别」时种进 dict_items（type=material_category），
 * 之后**以库里那份为准** —— 类别要能在后台增删改（2026-09-01 Mike 问「材料类别
 * 怎样修改怎样新增」，当时答案是「只能改代码」）。
 * 别再往这里加类别：加了也只对还没种过的新公司生效。
 */
const MATERIAL_CATEGORY_SEED: Record<string, string> = {
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

  /** 出参统一走这里换照片地址，别在各处 map 里各写一遍（多图那一份也要换，否则第二张起是白图） */
  private withDisplayPhoto<T extends { photoUrl?: string | null; photoUrls?: string[] | null }>(
    item: T,
  ): T {
    const photoUrls = (item.photoUrls || [])
      .map((url) => this.storage.toDisplayUrl(url) || '')
      .filter(Boolean);
    return {
      ...item,
      photoUrl: this.storage.toDisplayUrl(item.photoUrl) || photoUrls[0] || null,
      photoUrls,
    };
  }

  /**
   * 实物照片入库前的清洗：去空、去重、限 4 张。
   * 只在这里写一次 —— 新建、编辑、以后从别处补图都走它，
   * 免得某个入口漏了限制，库里出现 20 张图的 SKU。
   */
  private normalizePhotoUrls(photoUrls?: string[] | null, fallback?: string | null): string[] {
    const source = photoUrls?.length ? photoUrls : fallback ? [fallback] : [];
    return Array.from(
      new Set(source.map((url) => (url || '').trim()).filter(Boolean)),
    ).slice(0, MATERIAL_PHOTO_LIMIT);
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
      // 多图一起给：选料弹层点开大图要能左右滑，只给一张就滑不动
      photoUrls: (item.photoUrls || [])
        .map((url) => this.storage.toDisplayUrl(url) || '')
        .filter(Boolean),
      aliases: item.aliases || [],
    }));
  }

  // ---------------- 材料类别（后台可增删改） ----------------

  /**
   * 材料类别档案。存 dict_items（type=material_category），**一个公司一份**。
   *
   * 为什么不用平台预置（tenant_id 为空）那一档：类别是各家物业自己的账本口径，
   * 甲公司把「五金」改名成「五金件」不该影响乙公司。所以第一次读的时候
   * 按 MATERIAL_CATEGORY_SEED 给这家公司种一份，之后各改各的。
   *
   * 种子必须写在这里而不是只写 migration：线上 DB_SYNCHRONIZE=true、
   * migrations 表不存在，migration 里的 INSERT 一句都不会跑（见部署约定）。
   */
  async listMaterialCategories(tenantId: number): Promise<DictItem[]> {
    const repo = this.dataSource.getRepository(DictItem);
    const where = { tenantId, type: DictType.MATERIAL_CATEGORY };
    let rows = await repo.find({ where, order: { sortOrder: 'ASC', id: 'ASC' } });
    if (rows.length) return rows;
    // 幂等：并发第一次进来时可能重复种，靠再查一次收敛（类别量极小，代价可忽略）
    const seeds = Object.entries(MATERIAL_CATEGORY_SEED).map(([label, code], index) =>
      repo.create({
        tenantId,
        type: DictType.MATERIAL_CATEGORY,
        code,
        label,
        sortOrder: (index + 1) * 10,
        enabled: true,
      }),
    );
    await repo.save(seeds);
    rows = await repo.find({ where, order: { sortOrder: 'ASC', id: 'ASC' } });
    return rows;
  }

  /** 出参带上「有几条 SKU 在用」：用着的类别不给删，只能停用 */
  async listMaterialCategoriesWithUsage(user: AuthUser, query: TenantQueryDto) {
    const tenantId = this.resolveTenantId(user, query.tenantId);
    const rows = await this.listMaterialCategories(tenantId);
    const counts = await this.materialRepo
      .createQueryBuilder('m')
      .select('BTRIM(m.category)', 'label')
      .addSelect('COUNT(*)', 'count')
      .where('m.tenant_id = :tenantId', { tenantId })
      .andWhere('m.category IS NOT NULL')
      .groupBy('BTRIM(m.category)')
      .getRawMany<{ label: string; count: string }>();
    const usedBy = new Map(counts.map((row) => [row.label, Number(row.count)]));
    return rows.map((row) => ({
      id: row.id,
      code: row.code,
      label: row.label,
      sortOrder: row.sortOrder,
      enabled: row.enabled,
      materialCount: usedBy.get(row.label) ?? 0,
    }));
  }

  /** 前缀：2~4 位大写字母，全公司唯一 —— 它直接决定 SKU 编码（五金 → WJ-0001） */
  private normalizeCategoryCode(code: string): string {
    const value = (code || '').trim().toUpperCase();
    if (!/^[A-Z]{2,4}$/.test(value)) {
      throw new BadRequestException('编码前缀只能是 2~4 位英文字母，如 WJ');
    }
    return value;
  }

  async createMaterialCategory(dto: UpsertMaterialCategoryDto, user: AuthUser) {
    const tenantId = this.resolveTenantId(user, dto.tenantId);
    const label = (dto.label || '').trim();
    if (!label) throw new BadRequestException('请填写类别名称');
    const code = this.normalizeCategoryCode(dto.code || '');
    const existing = await this.listMaterialCategories(tenantId);
    if (existing.some((item) => item.label === label)) {
      throw new BadRequestException(`已经有「${label}」这个类别了`);
    }
    if (existing.some((item) => item.code === code)) {
      const hit = existing.find((item) => item.code === code) as DictItem;
      throw new BadRequestException(`编码前缀 ${code} 已被「${hit.label}」占用，换一个`);
    }
    const repo = this.dataSource.getRepository(DictItem);
    return repo.save(
      repo.create({
        tenantId,
        type: DictType.MATERIAL_CATEGORY,
        code,
        label,
        sortOrder: dto.sortOrder ?? (existing.length + 1) * 10,
        enabled: dto.enabled ?? true,
        createdBy: user.id,
        updatedBy: user.id,
      }),
    );
  }

  /**
   * 改类别。两条硬规矩：
   * 1. **改名要把已有 SKU 一起改**  —— materials.category 存的是名字本身，
   *    只改字典的话，老料的类别名对不上任何一条档案，在列表里全掉进「未分类」。
   * 2. **已发过编码的类别不许改前缀** —— WJ-0001 已经贴在实物上、印在单据里，
   *    改成别的前缀之后老编码再也解释不了它属于谁。
   */
  async updateMaterialCategory(id: number, dto: UpsertMaterialCategoryDto, user: AuthUser) {
    const tenantId = this.resolveTenantId(user);
    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(DictItem);
      const row = await repo.findOne({
        where: { id, tenantId, type: DictType.MATERIAL_CATEGORY },
      });
      if (!row) throw new NotFoundException('material category not found');
      const siblings = (
        await repo.find({ where: { tenantId, type: DictType.MATERIAL_CATEGORY } })
      ).filter((item) => item.id !== id);

      const nextLabel = dto.label !== undefined ? dto.label.trim() : row.label;
      if (!nextLabel) throw new BadRequestException('请填写类别名称');
      if (siblings.some((item) => item.label === nextLabel)) {
        throw new BadRequestException(`已经有「${nextLabel}」这个类别了`);
      }

      const usedCount = await manager.count(Material, { where: { tenantId, category: row.label } });
      if (dto.code !== undefined) {
        const nextCode = this.normalizeCategoryCode(dto.code);
        if (nextCode !== row.code) {
          if (usedCount > 0) {
            throw new BadRequestException(
              `「${row.label}」下已有 ${usedCount} 条材料用着 ${row.code}- 开头的编码，前缀不能再改；` +
                '需要换前缀请新建一个类别，把这些材料改过去。',
            );
          }
          if (siblings.some((item) => item.code === nextCode)) {
            throw new BadRequestException(`编码前缀 ${nextCode} 已被占用，换一个`);
          }
          row.code = nextCode;
        }
      }

      if (nextLabel !== row.label) {
        // 存量材料跟着改名，一条都不能落下（见方法头注释第 1 条）
        await manager
          .createQueryBuilder()
          .update(Material)
          .set({ category: nextLabel })
          .where('tenant_id = :tenantId AND BTRIM(category) = :label', {
            tenantId,
            label: row.label,
          })
          .execute();
        row.label = nextLabel;
      }
      if (dto.sortOrder !== undefined) row.sortOrder = dto.sortOrder;
      if (dto.enabled !== undefined) row.enabled = dto.enabled;
      row.updatedBy = user.id;
      return repo.save(row);
    });
  }

  /** 删类别：只有一条材料都没用过的才给删，用过的走停用（停用后新建选不到，老料照常显示） */
  async deleteMaterialCategory(id: number, user: AuthUser) {
    const tenantId = this.resolveTenantId(user);
    const repo = this.dataSource.getRepository(DictItem);
    const row = await repo.findOne({
      where: { id, tenantId, type: DictType.MATERIAL_CATEGORY },
    });
    if (!row) throw new NotFoundException('material category not found');
    const usedCount = await this.materialRepo.count({
      where: { tenantId, category: row.label },
    });
    if (usedCount > 0) {
      throw new BadRequestException(
        `「${row.label}」下还有 ${usedCount} 条材料，删了这些材料就没类别了。` +
          '不想再用请改成「停用」：新建材料时选不到它，已有的材料照常显示。',
      );
    }
    await repo.remove(row);
    return { id };
  }

  async createMaterial(dto: CreateMaterialDto, user: AuthUser) {
    const tenantId = this.resolveTenantId(user, dto.tenantId);
    await this.assertMaterialUnique(tenantId, dto.name, dto.spec ?? null, null);
    // 类别必须是档案里有的、且没停用的 —— 端上的下拉就是这份档案，
    // 走到这里对不上说明客户端拿的是旧列表，直说比默默落成「其它 QT」强
    const categories = await this.listMaterialCategories(tenantId);
    const picked = categories.find((item) => item.label === dto.category?.trim());
    if (!picked) {
      throw new BadRequestException(
        `材料类别「${dto.category}」不存在。请下拉刷新重选，或去后台「库存与采购 → 基础资料 → 材料类别」新增它`,
      );
    }
    if (!picked.enabled) {
      throw new BadRequestException(`材料类别「${picked.label}」已停用，请选别的类别`);
    }
    const code = dto.code?.trim() || await this.buildMaterialCode(tenantId, dto.category);
    const photoUrls = this.normalizePhotoUrls(dto.photoUrls, dto.photoUrl);
    const saved = await this.materialRepo.save(
      this.materialRepo.create({
        tenantId,
        code,
        name: dto.name.trim(),
        spec: dto.spec?.trim() || null,
        category: dto.category,
        unit: dto.unit ?? '个',
        defaultCostCents: dto.defaultCostCents ?? 0,
        photoUrl: photoUrls[0] ?? null,
        photoUrls,
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
    // 多图是唯一真相，photoUrl 跟着取第一张：两个字段各改各的迟早对不上
    if (dto.photoUrls !== undefined) {
      material.photoUrls = this.normalizePhotoUrls(dto.photoUrls);
      material.photoUrl = material.photoUrls[0] ?? null;
    } else if (dto.photoUrl !== undefined) {
      material.photoUrl = dto.photoUrl || null;
      material.photoUrls = this.normalizePhotoUrls(null, material.photoUrl);
    }
    if (dto.aliases !== undefined) material.aliases = this.normalizeAliases(dto.aliases);
    if (dto.params !== undefined) material.params = dto.params?.trim() || null;
    if (dto.enabled !== undefined) material.enabled = dto.enabled;
    material.updatedBy = user.id;
    return this.withDisplayPhoto(await this.materialRepo.save(material));
  }

  /**
   * 判重口径：名称 + 型号相同视为同一材料；同名不同型号不算重复。
   *
   * 报错必须说清「那条在哪」：2026-09-01 反馈过一次「提示已存在 WJ-0010，可我在
   * 库存里翻到 WJ-0009 就没有了」—— 那条 SKU 建过但**一件都没入库**，
   * 而库存页默认勾着「仅显示有货」，于是它在列表里根本不出现。
   * 所以这里连名称、型号、启用状态、当前是否有货一并写进提示。
   */
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
    if (!dup) return;
    const stocked = await this.stockRepo
      .createQueryBuilder('s')
      .where('s.tenant_id = :tenantId', { tenantId })
      .andWhere('s.material_id = :materialId', { materialId: dup.id })
      .andWhere('s.qty > 0')
      .getCount();
    const hints = [
      !dup.enabled ? '已停用' : '',
      stocked ? '' : '当前无库存，库存页勾着「仅显示有货」时看不到它',
    ].filter(Boolean);
    const title = [dup.name, dup.spec].filter(Boolean).join(' · ');
    throw new BadRequestException(
      `已存在同名同型号材料：${dup.code} ${title}` +
        (hints.length ? `（${hints.join('；')}）` : '') +
        '。请直接选它入库，或把这个名称加成它的别名',
    );
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
  async listWarehouses(query: WarehousesQueryDto, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.resolveTenantId(user, query.tenantId);
    const all = await this.warehouseRepo.find({
      where: { tenantId },
      order: { id: 'ASC' },
    });
    const list = await this.scopeWarehouses(tenantId, user, all, query.scope, access);
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
   * · 受限角色：只有自己管理处名下的仓，**公司总仓不给**
   * · 本体是全公司、只是在顶栏切了管理处视角：该管理处的仓 **+ 公司级总仓**
   *
   * 「谁能看总仓」就是数据范围本身，不另设开关：管理处角色看到总仓的库存也领不到，
   * 反而会拿它当自己的可用量。要放开就把那个角色的数据范围改成全公司（业务角色页）。
   *
   * 最后那条是 2026-09-01 修的：顶栏切管理处对管理员只是「换个筛子」，
   * 总仓不挂任何管理处，一律按 office_id 匹配就把它筛没了 ——
   * 于是管理员在库存清单里点「总仓」永远是空的，看着像总仓一件东西都没有。
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
    // 本人「本体」的数据范围。access.scopeAll 在切了视角之后已被置 false，问不出来；
    // 而 userOfficeIds 只看 user_roles —— 管理员往往一个业务角色都没绑，
    // 单靠它会把管理员判成「受限」（2026-09-01 线上实测：切管理处后总仓又没了）。
    // 所以平台超管 / 企业超管直接算全公司。
    const mine = await this.accessService.userOfficeIds(tenantId, user.id);
    const baseScopeAll = !!access?.isPlatformAdmin || !!access?.isTenantAdmin || mine.all;
    if (officeId) {
      return all
        .filter(
          (w) =>
            w.officeId === officeId ||
            extra.has(w.id) ||
            // 公司级仓（不挂管理处）：本体是全公司范围的人切了视角也还看得见
            (baseScopeAll && !w.officeId),
        )
        .map((w) => w.id);
    }
    if (baseScopeAll) return null;
    const offices = new Set(mine.officeIds);
    return all
      .filter((w) => (w.officeId && offices.has(w.officeId)) || extra.has(w.id))
      .map((w) => w.id);
  }

  /** 所有按仓库 id 读写的接口共用这一道范围校验，避免列表收窄了、详情/操作仍能猜 id 越界。 */
  private async assertWarehouseVisible(
    tenantId: number,
    user: AuthUser,
    warehouseId: number,
    access?: ResolvedAccess,
  ): Promise<void> {
    const visible = await this.visibleWarehouseIds(tenantId, user, access);
    if (visible && !visible.includes(warehouseId)) {
      throw new NotFoundException('warehouse not found');
    }
  }

  /** 新建/改挂靠时还没有可供反查的仓库 id，直接按目标管理处/小区校验数据范围。 */
  private async assertWarehouseBindingVisible(
    tenantId: number,
    binding: { communityId: number | null; officeId: number | null },
    access?: ResolvedAccess,
  ): Promise<void> {
    if (!access || (access.scopeAll && !access.actingOfficeId)) return;
    if (access.actingOfficeId) {
      if (binding.officeId === access.actingOfficeId) return;
      throw new ForbiddenException('不能在当前管理处视角下创建或改挂到其它范围的仓库');
    }
    const communities = new Set(access.communityIds ?? []);
    if (binding.communityId && communities.has(binding.communityId)) return;
    if (binding.officeId) {
      const officeCommunities = await this.accessService.officeCommunityIds(
        tenantId,
        binding.officeId,
      );
      if (officeCommunities.some((id) => communities.has(id))) return;
    }
    throw new ForbiddenException('仓库不在你的管理范围内');
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

  /**
   * 仓库列表的三档范围，别在调用方各写一套：
   *   · 不传      → 全部仓（后台基础资料、下拉选项等要看全量的地方）
   *   · mine     → 本人角色范围能用的仓（员工端），与顶栏视角无关
   *   · visible  → **和库存清单同一口径**（visibleWarehouseIds，受顶栏管理处视角影响）。
   *                后台「仓库库存」的仓库下拉必须用它 —— 用全量的话，
   *                下拉里会出现一些选了就是空表的仓，看着像库存丢了。
   */
  private async scopeWarehouses(
    tenantId: number,
    user: AuthUser,
    all: Warehouse[],
    scope: string | undefined,
    access?: ResolvedAccess,
  ): Promise<Warehouse[]> {
    if (scope === 'mine') return this.filterWarehousesForUser(tenantId, user.id, all);
    if (scope === 'visible') {
      const ids = await this.visibleWarehouseIds(tenantId, user, access);
      if (!ids) return all;
      const allowed = new Set(ids);
      return all.filter((item) => allowed.has(item.id));
    }
    return all;
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

  async createWarehouse(dto: CreateWarehouseDto, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.resolveTenantId(user, dto.tenantId);
    const binding = await this.resolveWarehouseBinding(tenantId, dto.type, dto.communityId, dto.officeId);
    await this.assertWarehouseBindingVisible(tenantId, binding, access);
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

  async updateWarehouse(
    id: number,
    dto: UpdateWarehouseDto,
    user: AuthUser,
    access?: ResolvedAccess,
  ) {
    const tenantId = this.resolveTenantId(user);
    const warehouse = await this.warehouseRepo.findOne({ where: { id, tenantId } });
    if (!warehouse) throw new NotFoundException('warehouse not found');
    await this.assertWarehouseVisible(tenantId, user, warehouse.id, access);
    const nextType = dto.type ?? warehouse.type;
    const binding = await this.resolveWarehouseBinding(
      tenantId,
      nextType,
      dto.communityId ?? warehouse.communityId,
      // 显式传 null = 清成公司级；不传 = 不动
      dto.officeId === undefined ? warehouse.officeId : dto.officeId,
    );
    await this.assertWarehouseBindingVisible(tenantId, binding, access);
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
  async listStockLots(stockId: number, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.resolveTenantId(user);
    const stock = await this.stockRepo.findOne({ where: { id: stockId, tenantId } });
    if (!stock) throw new NotFoundException('stock not found');
    await this.assertWarehouseVisible(tenantId, user, stock.warehouseId, access);
    return this.dataSource.getRepository(StockLot).find({
      where: { tenantId, warehouseId: stock.warehouseId, materialId: stock.materialId },
      order: { receivedAt: 'ASC', id: 'ASC' },
      take: 200,
    });
  }

  /**
   * 出入库流水，最新在前。**来源单据要带单号**（refNo）——
   * 界面上写「一般入库单 GR20260901…」，不是「一般入库单 #12」：
   * id 是程序定位用的，人对不上（2026-09-01 反馈）。
   */
  async listStockMovements(
    query: StockMovementQueryDto,
    user: AuthUser,
    access?: ResolvedAccess,
  ) {
    const tenantId = this.resolveTenantId(user, query.tenantId);
    const where: FindOptionsWhere<StockMovement> = { tenantId };
    const visible = await this.visibleWarehouseIds(tenantId, user, access);
    if (query.warehouseId) {
      if (visible && !visible.includes(query.warehouseId)) return [];
      where.warehouseId = query.warehouseId;
    } else if (visible) {
      if (!visible.length) return [];
      where.warehouseId = In(visible);
    }
    if (query.materialId) where.materialId = query.materialId;
    const rows = await this.dataSource.getRepository(StockMovement).find({
      where,
      order: { id: 'DESC' },
      take: Math.min(query.limit ?? 100, 500),
    });
    return this.withRefNos(tenantId, rows);
  }

  /** 流水的来源单据 id → 单号（入库单号 / 调拨单号 / 工单号）；查不到就给 null */
  private async withRefNos(tenantId: number, rows: StockMovement[]) {
    const idsOf = (type: string) => [
      ...new Set(
        rows
          .filter((r) => r.refType === type && r.refId)
          .map((r) => r.refId as number),
      ),
    ];
    const receiptIds = [...new Set([...idsOf('goods_receipt'), ...idsOf('general_receipt')])];
    const transferIds = idsOf('transfer_order');
    const workOrderIds = idsOf('work_order');
    const [receipts, transfers, workOrders] = await Promise.all([
      receiptIds.length
        ? this.dataSource.getRepository(GoodsReceipt).find({
            where: { tenantId, id: In(receiptIds) },
            select: ['id', 'receiptNo'],
          })
        : Promise.resolve([]),
      transferIds.length
        ? this.transferOrderRepo.find({
            where: { tenantId, id: In(transferIds) },
            select: ['id', 'transferNo'],
          })
        : Promise.resolve([]),
      workOrderIds.length
        ? this.dataSource.query(
            'SELECT id, order_no FROM work_orders WHERE tenant_id = $1 AND id = ANY($2::int[])',
            [tenantId, workOrderIds],
          )
        : Promise.resolve([]),
    ]);
    const receiptNo = new Map(receipts.map((r) => [r.id, r.receiptNo]));
    const transferNo = new Map(transfers.map((t) => [t.id, t.transferNo]));
    const orderNo = new Map<number, string>(
      (workOrders as Array<{ id: number; order_no: string }>).map((w) => [w.id, w.order_no]),
    );
    return rows.map((row) => {
      let refNo: string | null = null;
      if (row.refId) {
        if (row.refType === 'goods_receipt' || row.refType === 'general_receipt') {
          refNo = receiptNo.get(row.refId) ?? null;
        } else if (row.refType === 'transfer_order') {
          refNo = transferNo.get(row.refId) ?? null;
        } else if (row.refType === 'work_order') {
          refNo = orderNo.get(row.refId) ?? null;
        }
      }
      return { ...row, refNo };
    });
  }

  /**
   * 盘点调整。数量只能通过批次变：
   * - 盘盈：新建一条批次，单价用填的，不填取 SKU 参考成本，之后刷新参考成本；
   * - 盘亏：先进先出扣批次，流水成本取被扣批次的加权价。
   * 以前是直接改 stocks.qty 不动批次，结果批次和实物对不上、下次出库扣到不存在的批次。
   */
  async updateStock(id: number, dto: UpdateStockDto, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.resolveTenantId(user);
    const current = await this.stockRepo.findOne({ where: { id, tenantId } });
    if (!current) throw new NotFoundException('stock not found');
    await this.assertWarehouseVisible(tenantId, user, current.warehouseId, access);
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

  /**
   * 采购申请列表。**名字和单号由服务端补齐**，端上不许拿 id 顶着显示 ——
   * 2026-09-01 反馈：申请信息里「申请人 #2」「来源工单 #19」，用户看不懂这是谁、是哪张单。
   * id 是程序定位用的，人看的是姓名和单号，新增字段一律照这个口径给。
   */
  async listPurchaseRequests(
    query: PurchaseRequestQueryDto,
    user: AuthUser,
    access?: ResolvedAccess,
  ) {
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
    const rows = await this.purchaseRequestRepo.find({ where, order: { id: 'DESC' } });
    return this.withRequestNames(
      tenantId,
      await this.filterPurchaseRequestsByAccess(tenantId, rows, user, access),
    );
  }

  /**
   * 采购申请旧表没有 office_id：工单缺料按工单小区判断；办公室手工申请按申请人
   * 当前角色所属管理处判断。这样先把跨管理处读取和审批封住，后续即使补 office_id，
   * 对外口径也不需要再变。
   */
  private async filterPurchaseRequestsByAccess(
    tenantId: number,
    rows: PurchaseRequest[],
    user: AuthUser,
    access?: ResolvedAccess,
  ): Promise<PurchaseRequest[]> {
    const scope = scopeCommunityIds(access);
    if (!scope) return rows;
    if (!scope.length || !rows.length) return [];

    const workOrderIds = [
      ...new Set(rows.map((row) => row.workOrderId).filter((id): id is number => !!id)),
    ];
    const workOrders = workOrderIds.length
      ? await this.dataSource.getRepository(WorkOrder).find({
          where: { tenantId, id: In(workOrderIds) },
          select: ['id', 'communityId'],
        })
      : [];
    const visibleWorkOrderIds = new Set(
      workOrders
        .filter((workOrder) => scope.includes(workOrder.communityId))
        .map((workOrder) => workOrder.id),
    );

    const allowedOfficeIds = new Set<number>();
    for (const communityId of scope) {
      const officeId = await this.accessService.officeIdOfCommunity(
        tenantId,
        communityId,
      );
      if (officeId) allowedOfficeIds.add(officeId);
    }
    const manualApplicantIds = [
      ...new Set(
        rows
          .filter((row) => !row.workOrderId)
          .map((row) => row.applicantId),
      ),
    ];
    const visibleApplicants = new Set<number>();
    for (const applicantId of manualApplicantIds) {
      if (applicantId === user.id) {
        visibleApplicants.add(applicantId);
        continue;
      }
      const mine = await this.accessService.userOfficeIds(tenantId, applicantId);
      if (
        !mine.all &&
        mine.officeIds.length > 0 &&
        mine.officeIds.every((id) => allowedOfficeIds.has(id))
      ) {
        visibleApplicants.add(applicantId);
      }
    }

    return rows.filter((row) =>
      row.workOrderId
        ? visibleWorkOrderIds.has(row.workOrderId)
        : visibleApplicants.has(row.applicantId),
    );
  }

  private async assertPurchaseRequestVisible(
    tenantId: number,
    request: PurchaseRequest,
    user: AuthUser,
    access?: ResolvedAccess,
  ) {
    if (
      !(await this.filterPurchaseRequestsByAccess(
        tenantId,
        [request],
        user,
        access,
      )).length
    ) {
      throw new NotFoundException('purchase request not found');
    }
  }

  private async purchaseRequestOfficeId(
    tenantId: number,
    request: PurchaseRequest,
  ): Promise<number | null> {
    if (request.workOrderId) {
      const workOrder = await this.dataSource.getRepository(WorkOrder).findOne({
        where: { tenantId, id: request.workOrderId },
        select: ['id', 'communityId'],
      });
      return workOrder
        ? this.accessService.officeIdOfCommunity(tenantId, workOrder.communityId)
        : null;
    }
    const applicant = await this.accessService.userOfficeIds(
      tenantId,
      request.applicantId,
    );
    return !applicant.all && applicant.officeIds.length === 1
      ? applicant.officeIds[0]
      : null;
  }

  private async assertPurchaseOrderVisible(
    tenantId: number,
    order: PurchaseOrder,
    user: AuthUser,
    access?: ResolvedAccess,
  ) {
    if (!scopeCommunityIds(access)) return;
    if (!order.requestId) throw new NotFoundException('purchase order not found');
    const request = await this.purchaseRequestRepo.findOne({
      where: { tenantId, id: order.requestId },
    });
    if (!request) throw new NotFoundException('purchase order not found');
    await this.assertPurchaseRequestVisible(tenantId, request, user, access);
  }

  /** 采购申请出参统一补名字：申请人 / 两位审批人 / 来源工单单号 */
  private async withRequestNames(tenantId: number, rows: PurchaseRequest[]) {
    if (!rows.length) return [];
    const userIds = [
      ...new Set(
        rows
          .flatMap((r) => [r.applicantId, r.managerId, r.purchaserId])
          .filter((id): id is number => !!id),
      ),
    ];
    const workOrderIds = [
      ...new Set(rows.map((r) => r.workOrderId).filter((id): id is number => !!id)),
    ];
    const [users, workOrders] = await Promise.all([
      userIds.length
        ? this.dataSource.getRepository(User).find({
            where: { id: In(userIds) },
            select: ['id', 'name'],
          })
        : Promise.resolve([]),
      workOrderIds.length
        ? this.dataSource.query(
            'SELECT id, order_no FROM work_orders WHERE tenant_id = $1 AND id = ANY($2::int[])',
            [tenantId, workOrderIds],
          )
        : Promise.resolve([]),
    ]);
    const nameById = new Map(users.map((u) => [u.id, u.name || '']));
    const orderNoById = new Map<number, string>(
      (workOrders as Array<{ id: number; order_no: string }>).map((w) => [w.id, w.order_no]),
    );
    const nameOf = (id: number | null) => (id ? nameById.get(id) || null : null);
    return rows.map((row) => ({
      ...row,
      applicantName: nameOf(row.applicantId),
      managerName: nameOf(row.managerId),
      purchaserName: nameOf(row.purchaserId),
      workOrderNo: row.workOrderId ? orderNoById.get(row.workOrderId) ?? null : null,
    }));
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
            name: nameById.get(item.materialId) ?? '未知材料',
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
  submitToManager(
    dto: SubmitToManagerDto,
    user: AuthUser,
    access?: ResolvedAccess,
  ) {
    const tenantId = this.resolveTenantId(user);
    const ids = Array.from(new Set(dto.requestIds));
    if (!ids.length) throw new BadRequestException('请选择要提交的申请');
    return this.dataSource.transaction(async (manager) => {
      const requests: PurchaseRequest[] = [];
      for (const id of ids) {
        const req = await this.lockPurchaseRequest(manager, id, tenantId);
        await this.assertPurchaseRequestVisible(tenantId, req, user, access);
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
      const officeId = await this.purchaseRequestOfficeId(tenantId, saved);
      await this.notifyByPermission(manager, tenantId, 'app:approve-manager', {
        eventKey: 'purchase_pending_manager',
        title: `采购申请 ${saved.requestNo} 待物业经理审批`,
        payload: { purchaseRequestId: saved.id, requestNo: saved.requestNo },
        operatorId: user.id,
        officeId,
      });
      return saved;
    });
  }

  approveByManager(id: number, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.resolveTenantId(user);
    return this.dataSource.transaction(async (manager) => {
      const request = await this.lockPurchaseRequest(manager, id, tenantId);
      await this.assertPurchaseRequestVisible(tenantId, request, user, access);
      if (request.status !== PurchaseRequestStatus.MANAGER_REVIEW) {
        throw new BadRequestException('purchase request is not pending manager');
      }
      request.status = PurchaseRequestStatus.PURCHASER_REVIEW;
      request.managerId = user.id;
      request.managerAt = new Date();
      request.updatedBy = user.id;
      const saved = await manager.save(PurchaseRequest, request);
      const officeId = await this.purchaseRequestOfficeId(tenantId, saved);
      await this.notifyByPermission(manager, tenantId, 'app:approve-purchaser', {
        eventKey: 'purchase_pending_purchaser',
        title: `采购申请 ${saved.requestNo} 待采购经理审批`,
        payload: { purchaseRequestId: saved.id, requestNo: saved.requestNo },
        operatorId: user.id,
        officeId,
      });
      return saved;
    });
  }

  approveByPurchaser(id: number, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.resolveTenantId(user);
    return this.dataSource.transaction(async (manager) => {
      const request = await this.lockPurchaseRequest(manager, id, tenantId);
      await this.assertPurchaseRequestVisible(tenantId, request, user, access);
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

  rejectPurchaseRequest(
    id: number,
    dto: RejectPurchaseRequestDto,
    user: AuthUser,
    access?: ResolvedAccess,
  ) {
    const tenantId = this.resolveTenantId(user);
    return this.dataSource.transaction(async (manager) => {
      const request = await this.lockPurchaseRequest(manager, id, tenantId);
      await this.assertPurchaseRequestVisible(tenantId, request, user, access);
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
      const canEdit = (pageKey: string) =>
        !!access?.isPlatformAdmin ||
        !!access?.isTenantAdmin ||
        access?.pages?.[pageKey]?.edit === true;
      const allowed =
        (request.status === PurchaseRequestStatus.OFFICE_REVIEW &&
          (request.applicantId === user.id || canEdit('inventory') || canEdit('app:inventory'))) ||
        (request.status === PurchaseRequestStatus.MANAGER_REVIEW &&
          canEdit('app:approve-manager')) ||
        ([PurchaseRequestStatus.PURCHASER_REVIEW, PurchaseRequestStatus.APPROVED].includes(
          request.status,
        ) && canEdit('app:approve-purchaser'));
      if (!allowed) {
        throw new ForbiddenException('当前审批环节不能由你驳回');
      }
      request.status = PurchaseRequestStatus.REJECTED;
      request.rejectReason = dto.reason;
      request.updatedBy = user.id;
      return manager.save(PurchaseRequest, request);
    });
  }

  /** 采购单列表。「关联申请」要给申请单号，不是申请的 id（同 withRequestNames 的口径） */
  async listPurchaseOrders(
    query: TenantQueryDto,
    user: AuthUser,
    access?: ResolvedAccess,
  ) {
    const tenantId = this.resolveTenantId(user, query.tenantId);
    let rows = await this.purchaseOrderRepo.find({
      where: { tenantId },
      order: { id: 'DESC' },
    });
    if (scopeCommunityIds(access)) {
      const linkedIds = [
        ...new Set(rows.map((row) => row.requestId).filter((id): id is number => !!id)),
      ];
      const requests = linkedIds.length
        ? await this.purchaseRequestRepo.find({ where: { tenantId, id: In(linkedIds) } })
        : [];
      const visible = new Set(
        (await this.filterPurchaseRequestsByAccess(tenantId, requests, user, access)).map(
          (request) => request.id,
        ),
      );
      rows = rows.filter((row) => row.requestId != null && visible.has(row.requestId));
    }
    const requestIds = [
      ...new Set(rows.map((r) => r.requestId).filter((id): id is number => !!id)),
    ];
    const requests = requestIds.length
      ? await this.purchaseRequestRepo.find({
          where: { tenantId, id: In(requestIds) },
          select: ['id', 'requestNo'],
        })
      : [];
    const requestNoById = new Map(requests.map((r) => [r.id, r.requestNo]));
    return rows.map((row) => ({
      ...row,
      requestNo: row.requestId ? requestNoById.get(row.requestId) ?? null : null,
    }));
  }

  createPurchaseOrder(
    dto: CreatePurchaseOrderDto,
    user: AuthUser,
    access?: ResolvedAccess,
  ) {
    const tenantId = this.resolveTenantId(user, dto.tenantId);
    if (scopeCommunityIds(access) && !dto.requestId) {
      throw new ForbiddenException('受限账号只能为本管理处的采购申请下单');
    }
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
        await this.assertPurchaseRequestVisible(tenantId, lockedRequest, user, access);
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

  async createGoodsReceipt(
    dto: CreateGoodsReceiptDto,
    user: AuthUser,
    access?: ResolvedAccess,
  ) {
    const tenantId = this.resolveTenantId(user, dto.tenantId);
    if (!dto.items.length) throw new BadRequestException('items is required');
    await this.assertWarehouseVisible(tenantId, user, dto.warehouseId, access);
    return this.dataSource.transaction(async (manager) => {
      const order = await manager.findOne(PurchaseOrder, {
        where: { id: dto.purchaseOrderId, tenantId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!order) throw new NotFoundException('purchase order not found');
      await this.assertPurchaseOrderVisible(tenantId, order, user, access);
      if (![PurchaseOrderStatus.PLACED, PurchaseOrderStatus.PARTIAL].includes(order.status)) {
        throw new BadRequestException('purchase order cannot receive goods');
      }
      await this.ensureWarehouse(manager, tenantId, dto.warehouseId);
      await this.ensureMaterials(manager, tenantId, dto.items.map((item) => item.materialId));
      // 实物照片选填（2026-09-01）：货到了先入账，照片仓库慢慢补。
      // 强制拍照的后果是仓管手上没相机就干脆不入库，账实差得更远
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
      const orderLabels = await this.materialLabels(
        manager,
        tenantId,
        order.items.map((i) => i.materialId),
      );
      const variances: string[] = [];
      let allComplete = true;
      for (const orderItem of order.items) {
        const received = receivedTotals.get(orderItem.materialId) ?? 0;
        if (received < orderItem.qty) allComplete = false;
        if (received !== orderItem.qty) {
          // 这条会原样进通知，采购经理看到的必须是材料名
          variances.push(
            `${orderLabels.get(orderItem.materialId) ?? '未知材料'}：订 ${orderItem.qty}、累计收 ${received}`,
          );
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

  /** 一般入库（无采购单，零星采买）：填来源 + 凭证附件，逐项选库位；实物照片选填，可事后补 */
  async createGeneralReceipt(
    dto: CreateGeneralReceiptDto,
    user: AuthUser,
    access?: ResolvedAccess,
  ) {
    const tenantId = this.resolveTenantId(user, dto.tenantId);
    if (!dto.items.length) throw new BadRequestException('items is required');
    if (!dto.sourceText?.trim()) throw new BadRequestException('请填写材料来源');
    await this.assertWarehouseVisible(tenantId, user, dto.warehouseId, access);
    return this.dataSource.transaction(async (manager) => {
      await this.ensureWarehouse(manager, tenantId, dto.warehouseId);
      await this.ensureMaterials(manager, tenantId, dto.items.map((item) => item.materialId));
      // 实物照片选填，理由同 createGoodsReceipt
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

  async listGoodsReceipts(query: TenantQueryDto, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.resolveTenantId(user, query.tenantId);
    const visible = await this.visibleWarehouseIds(tenantId, user, access);
    if (visible && !visible.length) return [];
    return this.dataSource.getRepository(GoodsReceipt).find({
      where: { tenantId, ...(visible ? { warehouseId: In(visible) } : {}) },
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

  async listWarehouseLocations(
    query: WarehouseLocationQueryDto,
    user: AuthUser,
    access?: ResolvedAccess,
  ) {
    const tenantId = this.resolveTenantId(user, query.tenantId);
    const where: FindOptionsWhere<WarehouseLocation> = { tenantId };
    const visible = await this.visibleWarehouseIds(tenantId, user, access);
    if (query.warehouseId) {
      if (visible && !visible.includes(query.warehouseId)) return [];
      where.warehouseId = query.warehouseId;
    } else if (visible) {
      if (!visible.length) return [];
      where.warehouseId = In(visible);
    }
    return this.dataSource.getRepository(WarehouseLocation).find({
      where,
      order: { id: 'ASC' },
    });
  }

  async createWarehouseLocation(
    dto: CreateWarehouseLocationDto,
    user: AuthUser,
    access?: ResolvedAccess,
  ) {
    const tenantId = this.resolveTenantId(user, dto.tenantId);
    await this.assertWarehouseVisible(tenantId, user, dto.warehouseId, access);
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

  async updateWarehouseLocation(
    id: number,
    dto: UpdateWarehouseLocationDto,
    user: AuthUser,
    access?: ResolvedAccess,
  ) {
    const tenantId = this.resolveTenantId(user);
    const repo = this.dataSource.getRepository(WarehouseLocation);
    const location = await repo.findOne({ where: { id, tenantId } });
    if (!location) throw new NotFoundException('库位不存在');
    await this.assertWarehouseVisible(tenantId, user, location.warehouseId, access);
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

  async listTransferOrders(query: TenantQueryDto, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.resolveTenantId(user, query.tenantId);
    const rows = await this.transferOrderRepo.find({
      where: { tenantId },
      order: { id: 'DESC' },
    });
    const visible = await this.visibleWarehouseIds(tenantId, user, access);
    if (!visible) return rows;
    const allowed = new Set(visible);
    return rows.filter(
      (row) => allowed.has(row.fromWarehouseId) || allowed.has(row.toWarehouseId),
    );
  }

  /** 发起调拨 → 进入经理审批（此时不扣库存，仅校验发货仓库存充足） */
  async createTransferOrder(
    dto: CreateTransferOrderDto,
    user: AuthUser,
    access?: ResolvedAccess,
  ) {
    const tenantId = this.resolveTenantId(user, dto.tenantId);
    if (!dto.items.length) throw new BadRequestException('items is required');
    if (dto.fromWarehouseId === dto.toWarehouseId) {
      throw new BadRequestException('发货仓与接收仓不能相同');
    }
    await this.assertWarehouseVisible(tenantId, user, dto.fromWarehouseId, access);
    await this.assertWarehouseVisible(tenantId, user, dto.toWarehouseId, access);
    return this.dataSource.transaction(async (manager) => {
      await this.ensureWarehouse(manager, tenantId, dto.fromWarehouseId);
      await this.ensureWarehouse(manager, tenantId, dto.toWarehouseId);
      const labels = await this.ensureMaterials(manager, tenantId, dto.items.map((item) => item.materialId));

      // 提交时校验发货仓当前库存足够（正式扣减在审批通过时）
      for (const item of dto.items) {
        const stock = await manager.findOne(Stock, {
          where: { tenantId, warehouseId: dto.fromWarehouseId, materialId: item.materialId },
        });
        if (Number(stock?.qty ?? 0) < item.qty) {
          const have = Number(stock?.qty ?? 0);
          throw new BadRequestException(
            `${labels.get(item.materialId) ?? '未知材料'} 发货仓只有 ${have}，不够调 ${item.qty}`,
          );
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
  approveTransferOrder(id: number, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.resolveTenantId(user);
    return this.dataSource.transaction(async (manager) => {
      const transfer = await this.lockTransferOrder(manager, id, tenantId);
      await this.assertWarehouseVisible(tenantId, user, transfer.fromWarehouseId, access);
      await this.assertWarehouseVisible(tenantId, user, transfer.toWarehouseId, access);
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
  rejectTransferOrder(
    id: number,
    reason: string,
    user: AuthUser,
    access?: ResolvedAccess,
  ) {
    const tenantId = this.resolveTenantId(user);
    return this.dataSource.transaction(async (manager) => {
      const transfer = await this.lockTransferOrder(manager, id, tenantId);
      await this.assertWarehouseVisible(tenantId, user, transfer.fromWarehouseId, access);
      await this.assertWarehouseVisible(tenantId, user, transfer.toWarehouseId, access);
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
  receiveTransferOrder(
    id: number,
    dto: ReceiveTransferOrderDto,
    user: AuthUser,
    access?: ResolvedAccess,
  ) {
    const tenantId = this.resolveTenantId(user);
    const receivedByMaterial = new Map<number, number>();
    (dto.items ?? []).forEach((item) => receivedByMaterial.set(item.materialId, item.receivedQty));

    return this.dataSource.transaction(async (manager) => {
      const transfer = await this.lockTransferOrder(manager, id, tenantId);
      await this.assertWarehouseVisible(tenantId, user, transfer.toWarehouseId, access);
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
      const receiveLabels = await this.materialLabels(
        manager,
        tenantId,
        transfer.items.map((i) => i.materialId),
      );
      const finalItems: TransferOrder['items'] = [];
      for (const item of transfer.items) {
        const shippedQty = item.qty;
        const receivedQty = receivedByMaterial.has(item.materialId)
          ? Number(receivedByMaterial.get(item.materialId))
          : shippedQty;
        if (receivedQty < 0 || receivedQty > shippedQty) {
          throw new BadRequestException(
            `${receiveLabels.get(item.materialId) ?? '未知材料'} 实收数量必须在 0 ~ ${shippedQty} 之间`,
          );
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
    // 前缀以库里的类别档案为准（后台可改），种子表只是兜底；都没有就落「其它」QT
    const categories = await this.listMaterialCategories(tenantId);
    const prefix =
      categories.find((item) => item.label === category?.trim())?.code ||
      MATERIAL_CATEGORY_SEED[category] ||
      'QT';
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

  /**
   * 校验材料都在、都启用，**并把名字带回来**。
   * 带名字是因为下游的报错和通知都是给人看的：「材料 #37 发货仓库存不足」
   * 没人知道 37 是什么（2026-09-01 反馈：不要再出现 #19 这种表述）。
   */
  private async ensureMaterials(
    manager,
    tenantId: number,
    materialIds: number[],
  ): Promise<Map<number, string>> {
    const uniqueIds = Array.from(new Set(materialIds));
    const labels = new Map<number, string>();
    for (const id of uniqueIds) {
      const material = await manager.findOne(Material, {
        where: { id, tenantId, enabled: true },
      });
      if (!material) throw new NotFoundException(`material not found: ${id}`);
      labels.set(id, this.materialLabel(material));
    }
    return labels;
  }

  /** 材料 id → 「名称（型号）」，查不到就说查不到，别把 id 当名字给用户 */
  private async materialLabels(
    manager: EntityManager,
    tenantId: number,
    materialIds: number[],
  ): Promise<Map<number, string>> {
    const ids = [...new Set(materialIds)];
    if (!ids.length) return new Map();
    const rows = await manager.find(Material, { where: { tenantId, id: In(ids) } });
    return new Map(rows.map((m) => [m.id, this.materialLabel(m)]));
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
    let ids = [...new Set(idSets.flat())];
    if (input.officeId !== undefined) {
      const coverage = await this.accessService.filterUsersCoveringOffice(
        tenantId,
        ids,
        input.officeId,
      );
      ids = ids.filter((id) => coverage.has(id));
    }
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
