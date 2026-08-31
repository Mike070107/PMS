import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes } from 'crypto';
import { DataSource, EntityManager, In, Repository } from 'typeorm';
import { AuthUser } from '../../common/current-user.decorator';
import { UserRole } from '../../common/enums';
import {
  Building,
  Community,
  House,
  MaintenanceOrder,
  ManagementOffice,
  Material,
  QuotaItem,
  RepairRequest,
  RepairTypeRule,
  TenantConfig,
  User,
  WorkOrder,
  WorkOrderMaterial,
} from '../../entities';
import {
  MAINTENANCE_STATUS,
  MaintenanceItem,
  MaintenanceMaterial,
} from '../../entities/maintenance-order.entity';
import { ResolvedAccess } from '../access/access.service';
import { scopeCommunityIds } from '../access/scope.util';
import { extractSpot } from '../repairs/repair-suggestions.util';
import { resolveRepairTypeLabel } from '../repairs/repair-type-labels';
import { ObjectStorageService } from '../upload/object-storage.service';
import { materialTotalCents, totalFeeCents } from './maintenance-money.util';
import {
  CreateMaintenanceOrderDto,
  InspectMaintenanceOrderDto,
  MaintenanceItemDto,
  MaintenanceMaterialDto,
  MaintenanceQueryDto,
  SaveQuotaItemDto,
  SaveQuotaParamsDto,
  UpdateMaintenanceOrderDto,
} from './dto';

/** 定额取费参数存在 tenant_configs 里，改完立刻生效，不用改环境变量重部署 */
const QUOTA_PARAMS_KEY = 'quota_params';

export interface QuotaParams {
  /** 定额人工单价（分 / 工时）。样单：0.34 工时 × 17.5 元 = 5.95 元 */
  laborRateCents: number;
  /** 取费系数。样单：（人工费 5.95 + 材料费 6.00）× 1.0341 = 12.36 元 */
  coefficient: number;
}

const DEFAULT_QUOTA_PARAMS: QuotaParams = {
  laborRateCents: 1750,
  coefficient: 1.0341,
};

/**
 * 纸上三个括号里写的字。勾了哪一格就把哪个名字写进括号 ——
 * 前端勾选时也会跟着改（MaintenanceOrdersPage 的 optionText），两处口径一致。
 * 「修缮日期」那个括号不自动写：它要的是日期，不是部位名。
 */
const FEE_CATEGORY_LABELS: Record<string, string> = {
  owner: '业主自理',
  repair_fund: '修缮基金',
  elevator_fund: '电梯水泵基金',
  public_fund: '公共设施基金',
};
const SHARE_METHOD_LABELS: Record<string, string> = {
  natural: '自然幢',
  door: '门牌幢',
  zone: '住宅区域',
};

/** 单号字符集与工单同一套：去掉了 0/O、1/I、5/S、8/B 这些手写会认错的字 */
const ORDER_NO_ALPHABET = '34679ACDEFGHJKMNPQRTUVWXY';

@Injectable()
export class MaintenanceService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(MaintenanceOrder)
    private readonly orderRepo: Repository<MaintenanceOrder>,
    @InjectRepository(QuotaItem)
    private readonly quotaRepo: Repository<QuotaItem>,
    @InjectRepository(TenantConfig)
    private readonly configRepo: Repository<TenantConfig>,
    @InjectRepository(WorkOrder)
    private readonly workOrderRepo: Repository<WorkOrder>,
    @InjectRepository(WorkOrderMaterial)
    private readonly workOrderMaterialRepo: Repository<WorkOrderMaterial>,
    @InjectRepository(RepairRequest)
    private readonly requestRepo: Repository<RepairRequest>,
    @InjectRepository(RepairTypeRule)
    private readonly repairTypeRuleRepo: Repository<RepairTypeRule>,
    @InjectRepository(House)
    private readonly houseRepo: Repository<House>,
    @InjectRepository(Building)
    private readonly buildingRepo: Repository<Building>,
    @InjectRepository(Community)
    private readonly communityRepo: Repository<Community>,
    @InjectRepository(ManagementOffice)
    private readonly officeRepo: Repository<ManagementOffice>,
    @InjectRepository(Material)
    private readonly materialRepo: Repository<Material>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly storage: ObjectStorageService,
  ) {}

  // ==================== 预算定额配置 ====================

  async getQuotaParams(user: AuthUser): Promise<QuotaParams> {
    return this.loadQuotaParams(this.requireTenant(user));
  }

  private async loadQuotaParams(tenantId: number): Promise<QuotaParams> {
    const row = await this.configRepo.findOne({
      where: { tenantId, key: QUOTA_PARAMS_KEY },
    });
    return this.normalizeParams(row?.value);
  }

  async saveQuotaParams(dto: SaveQuotaParamsDto, user: AuthUser): Promise<QuotaParams> {
    const tenantId = this.requireTenant(user);
    const value: QuotaParams = {
      laborRateCents: Math.round(dto.laborRateCents),
      coefficient: Number(dto.coefficient),
    };
    const existing = await this.configRepo.findOne({
      where: { tenantId, key: QUOTA_PARAMS_KEY },
    });
    if (existing) {
      existing.value = { ...value };
      existing.updatedBy = user.id;
      await this.configRepo.save(existing);
    } else {
      await this.configRepo.save(
        this.configRepo.create({
          tenantId,
          key: QUOTA_PARAMS_KEY,
          value: { ...value },
          createdBy: user.id,
          updatedBy: user.id,
        }),
      );
    }
    return value;
  }

  async listQuotaItems(user: AuthUser) {
    const tenantId = this.requireTenant(user);
    return this.quotaRepo.find({
      where: { tenantId },
      order: { sortOrder: 'ASC', code: 'ASC' },
    });
  }

  async createQuotaItem(dto: SaveQuotaItemDto, user: AuthUser) {
    const tenantId = this.requireTenant(user);
    await this.ensureQuotaCodeFree(tenantId, dto.code, null);
    return this.quotaRepo.save(
      this.quotaRepo.create({
        tenantId,
        code: dto.code.trim(),
        name: dto.name.trim(),
        unit: dto.unit?.trim() || '项',
        hours: String(dto.hours ?? 0),
        materialFeeCents: dto.materialFeeCents ?? 0,
        remark: dto.remark?.trim() || null,
        enabled: dto.enabled ?? true,
        sortOrder: dto.sortOrder ?? 0,
        createdBy: user.id,
        updatedBy: user.id,
      }),
    );
  }

  async updateQuotaItem(id: number, dto: SaveQuotaItemDto, user: AuthUser) {
    const tenantId = this.requireTenant(user);
    const item = await this.quotaRepo.findOne({ where: { id, tenantId } });
    if (!item) throw new NotFoundException('定额条目不存在');
    await this.ensureQuotaCodeFree(tenantId, dto.code, id);
    item.code = dto.code.trim();
    item.name = dto.name.trim();
    item.unit = dto.unit?.trim() || '项';
    item.hours = String(dto.hours ?? 0);
    item.materialFeeCents = dto.materialFeeCents ?? 0;
    item.remark = dto.remark?.trim() || null;
    if (dto.enabled !== undefined) item.enabled = dto.enabled;
    if (dto.sortOrder !== undefined) item.sortOrder = dto.sortOrder;
    item.updatedBy = user.id;
    return this.quotaRepo.save(item);
  }

  async removeQuotaItem(id: number, user: AuthUser) {
    const tenantId = this.requireTenant(user);
    const item = await this.quotaRepo.findOne({ where: { id, tenantId } });
    if (!item) throw new NotFoundException('定额条目不存在');
    await this.quotaRepo.delete({ id, tenantId });
    return { ok: true };
  }

  // ==================== 养护单 ====================

  async list(query: MaintenanceQueryDto, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    const scope = scopeCommunityIds(access);
    if (scope && !scope.length) return [];

    const qb = this.orderRepo
      .createQueryBuilder('mo')
      .where('mo.tenant_id = :tenantId', { tenantId });
    if (scope) qb.andWhere('mo.community_id IN (:...scope)', { scope });
    if (query.communityId) qb.andWhere('mo.community_id = :cid', { cid: query.communityId });
    if (query.status && query.status !== 'all') {
      qb.andWhere('mo.status = :status', { status: query.status });
    }
    const keyword = query.q?.trim();
    if (keyword) {
      const like = `%${keyword}%`;
      // 这里写库里的列名（snake_case），不写实体属性名：
      // 拼在 COALESCE 里的 alias.property 不一定会被 TypeORM 翻译，翻不了就是运行时 SQL 报错
      qb.andWhere(
        `(mo.order_no ILIKE :like OR mo.paper_no ILIKE :like OR mo.work_order_no ILIKE :like
          OR mo.reporter_name ILIKE :like OR mo.repair_item ILIKE :like
          OR COALESCE(mo.addr_village,'') || COALESCE(mo.addr_road,'') || COALESCE(mo.addr_lane,'')
             || COALESCE(mo.addr_building_no,'') || COALESCE(mo.addr_room,'') ILIKE :like)`,
        { like },
      );
    }
    const rows = await qb.orderBy('mo.id', 'DESC').take(300).getMany();
    return rows.map((row) => this.toListRow(row));
  }

  async getOne(id: number, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    const row = await this.orderRepo.findOne({ where: { id, tenantId } });
    if (!row) throw new NotFoundException('养护单不存在');
    this.assertInScope(row.communityId, access);
    return this.toDetail(row);
  }

  /** 工单详情页「填养护单」用：这张工单有没有养护单，有就直接打开 */
  async findByWorkOrder(workOrderId: number, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    const row = await this.orderRepo.findOne({
      where: [
        { tenantId, workOrderId, status: MAINTENANCE_STATUS.DRAFT },
        { tenantId, workOrderId, status: MAINTENANCE_STATUS.INSPECTED },
      ],
      order: { id: 'DESC' },
    });
    if (!row) return null;
    this.assertInScope(row.communityId, access);
    return this.toDetail(row);
  }

  /**
   * 从工单开单。**填单人就是点这个按钮的人** —— 纸面上「填单人」那一格签的是他，
   * 所以这里不接受传入的 fillerId，只认当前登录账号。
   * 同一张工单已经开过就直接返回原单（不重复开、不覆盖已填内容）。
   */
  async createFromWorkOrder(
    dto: CreateMaintenanceOrderDto,
    user: AuthUser,
    access?: ResolvedAccess,
  ) {
    const tenantId = this.requireTenant(user);
    const workOrder = await this.workOrderRepo.findOne({
      where: { id: dto.workOrderId, tenantId },
    });
    if (!workOrder) throw new NotFoundException('工单不存在');
    this.assertInScope(workOrder.communityId, access);

    const existing = await this.orderRepo.findOne({
      where: [
        { tenantId, workOrderId: workOrder.id, status: MAINTENANCE_STATUS.DRAFT },
        { tenantId, workOrderId: workOrder.id, status: MAINTENANCE_STATUS.INSPECTED },
      ],
    });
    if (existing) return this.toDetail(existing);

    const draft = await this.buildPrefill(tenantId, workOrder, user);
    const saved = await this.dataSource.transaction(async (manager) => {
      draft.orderNo = await this.nextOrderNo(manager);
      return manager.save(MaintenanceOrder, manager.create(MaintenanceOrder, draft));
    });
    return this.toDetail(saved);
  }

  async update(
    id: number,
    dto: UpdateMaintenanceOrderDto,
    user: AuthUser,
    access?: ResolvedAccess,
  ) {
    const tenantId = this.requireTenant(user);
    const row = await this.orderRepo.findOne({ where: { id, tenantId } });
    if (!row) throw new NotFoundException('养护单不存在');
    this.assertInScope(row.communityId, access);
    if (row.status === MAINTENANCE_STATUS.VOID) {
      throw new BadRequestException('这张养护单已作废，不能再改');
    }
    // 查验过的单不能再改内容：经理签的是他当时看到的那份。要改就先作废重开。
    if (row.status === MAINTENANCE_STATUS.INSPECTED) {
      throw new BadRequestException('已查验的养护单不能再修改，需要改请先作废后重新开单');
    }

    const text = (v: string | undefined, cur: string | null) =>
      v === undefined ? cur : v.trim() || null;

    row.paperNo = text(dto.paperNo, row.paperNo);
    row.unitName = text(dto.unitName, row.unitName);
    row.reporterName = text(dto.reporterName, row.reporterName);
    row.addrVillage = text(dto.addrVillage, row.addrVillage);
    row.addrRoad = text(dto.addrRoad, row.addrRoad);
    row.addrLane = text(dto.addrLane, row.addrLane);
    row.addrBuildingNo = text(dto.addrBuildingNo, row.addrBuildingNo);
    row.addrRoom = text(dto.addrRoom, row.addrRoom);
    row.presentTime = text(dto.presentTime, row.presentTime);
    row.faultPart = text(dto.faultPart, row.faultPart);
    row.repairItem = text(dto.repairItem, row.repairItem);
    row.reportedOn = dto.reportedOn === undefined ? row.reportedOn : this.dateOnly(dto.reportedOn);
    row.appointOn = dto.appointOn === undefined ? row.appointOn : this.dateOnly(dto.appointOn);
    row.startOn = dto.startOn === undefined ? row.startOn : this.dateOnly(dto.startOn);
    row.finishOn = dto.finishOn === undefined ? row.finishOn : this.dateOnly(dto.finishOn);
    row.partCategory = text(dto.partCategory, row.partCategory);
    row.feeCategory = text(dto.feeCategory, row.feeCategory);
    row.shareMethod = text(dto.shareMethod, row.shareMethod);
    row.repairDateText = text(dto.repairDateText, row.repairDateText);
    row.feeCategoryText = text(dto.feeCategoryText, row.feeCategoryText);
    row.shareMethodText = text(dto.shareMethodText, row.shareMethodText);
    row.scrapNote = text(dto.scrapNote, row.scrapNote);
    row.voucherIssue = text(dto.voucherIssue, row.voucherIssue);
    row.serviceRecord = text(dto.serviceRecord, row.serviceRecord);
    row.followUpRecord = text(dto.followUpRecord, row.followUpRecord);
    row.fillerName = text(dto.fillerName, row.fillerName);
    row.fillerSignUrl = text(dto.fillerSignUrl, row.fillerSignUrl);
    row.repairerName = text(dto.repairerName, row.repairerName);
    row.repairerSignUrl = text(dto.repairerSignUrl, row.repairerSignUrl);
    row.ownerSignUrl = text(dto.ownerSignUrl, row.ownerSignUrl);

    if (dto.items) row.items = dto.items.map((item) => this.normalizeItem(item));
    if (dto.materials) {
      row.materials = dto.materials.map((item) => this.normalizeMaterial(item));
    }

    // 合计一律服务端算：纸上印出来的钱不能靠前端算对
    const params = await this.loadQuotaParams(tenantId);
    row.laborRateCents = params.laborRateCents;
    row.coefficient = String(params.coefficient);
    row.totalCents = totalFeeCents(row.items, params.coefficient);
    row.materialTotalCents = materialTotalCents(row.materials);
    row.updatedBy = user.id;
    const saved = await this.orderRepo.save(row);
    return this.toDetail(saved);
  }

  /** 物业经理查验并签名 */
  async inspect(
    id: number,
    dto: InspectMaintenanceOrderDto,
    user: AuthUser,
    access?: ResolvedAccess,
  ) {
    const tenantId = this.requireTenant(user);
    const row = await this.orderRepo.findOne({ where: { id, tenantId } });
    if (!row) throw new NotFoundException('养护单不存在');
    this.assertInScope(row.communityId, access);
    if (row.status === MAINTENANCE_STATUS.VOID) {
      throw new BadRequestException('这张养护单已作废');
    }
    if (!dto.signUrl?.trim()) {
      throw new BadRequestException('请先手写签名再查验');
    }
    const me = await this.userRepo.findOne({
      where: { id: user.id, tenantId },
      select: ['id', 'name'],
    });
    row.inspectorId = user.id;
    row.inspectorName = dto.name?.trim() || me?.name || row.inspectorName;
    row.inspectorSignUrl = dto.signUrl.trim();
    row.inspectedAt = dto.inspectedOn ? new Date(dto.inspectedOn) : new Date();
    row.status = MAINTENANCE_STATUS.INSPECTED;
    row.updatedBy = user.id;
    return this.toDetail(await this.orderRepo.save(row));
  }

  /** 作废：单据不删，作废留痕；作废后同一张工单可以重新开单 */
  async voidOne(id: number, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    const row = await this.orderRepo.findOne({ where: { id, tenantId } });
    if (!row) throw new NotFoundException('养护单不存在');
    this.assertInScope(row.communityId, access);
    row.status = MAINTENANCE_STATUS.VOID;
    row.updatedBy = user.id;
    await this.orderRepo.save(row);
    return { ok: true };
  }

  // ==================== 内部 ====================

  private async buildPrefill(
    tenantId: number,
    workOrder: WorkOrder,
    user: AuthUser,
  ): Promise<Partial<MaintenanceOrder>> {
    const [request, community, assignee, me, typeRules] = await Promise.all([
      this.requestRepo.findOne({ where: { id: workOrder.requestId, tenantId } }),
      this.communityRepo.findOne({ where: { id: workOrder.communityId, tenantId } }),
      workOrder.assigneeId
        ? this.userRepo.findOne({
            where: { id: workOrder.assigneeId, tenantId },
            select: ['id', 'name'],
          })
        : Promise.resolve(null),
      this.userRepo.findOne({ where: { id: user.id }, select: ['id', 'name'] }),
      this.repairTypeRuleRepo.find({ where: { tenantId }, select: ['repairType', 'label'] }),
    ]);
    const typeLabel = resolveRepairTypeLabel(
      request?.repairType,
      new Map(typeRules.map((rule) => [rule.repairType, rule.label])),
    );

    const house = request?.houseId
      ? await this.houseRepo.findOne({ where: { id: request.houseId, tenantId } })
      : null;
    const buildingId = house?.buildingId ?? request?.buildingId ?? null;
    const building = buildingId
      ? await this.buildingRepo.findOne({ where: { id: buildingId, tenantId } })
      : null;
    // 分期（枫桦景苑一期）挂在顶层小区下，纸上写的是顶层那个名字
    const topCommunity = community?.parentId
      ? await this.communityRepo.findOne({ where: { id: community.parentId, tenantId } })
      : community;
    const office = topCommunity?.officeId
      ? await this.officeRepo.findOne({ where: { id: topCommunity.officeId, tenantId } })
      : null;

    const materials = await this.buildMaterialRows(tenantId, workOrder);
    const params = await this.loadQuotaParams(tenantId);

    // 公区报修没有门牌（监控室、水泵房这类点位另建档），地址五格留空，
    // 具体位置落在「报修部位」那一格 —— 硬塞进「号」会印出「监控室2号号」
    const isPublicArea = !house && !building;

    // 「报修部位」纸上只有 13mm 宽，写的是「大门 / 楼道 / 水泵房」这种部位。
    // 工单的 faultLocation 常常是整条地址（「枫桦景苑二期 228弄51号 公共区域」），
    // 原样搬过去既印不下、也和上面的地址栏重复 —— 用报修建议那套把门牌剥掉只留部位，
    // 剥完什么都不剩就留空，让办公室手填（2026-08-31 线上真实工单上验出来的）
    const spot = extractSpot(
      workOrder.faultLocation ?? '',
      [community?.name, topCommunity?.name].filter((name): name is string => !!name),
    );

    const firstItem: MaintenanceItem = {
      part: spot,
      name:
        workOrder.repairContent?.trim() ||
        workOrder.actionNote?.trim() ||
        request?.content?.trim() ||
        '',
      surveyQty: null,
      actualQty: 1,
      actualHours: null,
      measureQty: null,
      quotaCode: '',
      quotaHours: null,
      laborFeeCents: null,
      materialFeeCents: materialTotalCents(materials) || null,
      quality: '合格',
      note: '',
    };

    return {
      tenantId,
      orderNo: '',
      workOrderId: workOrder.id,
      workOrderNo: workOrder.orderNo,
      requestId: workOrder.requestId,
      communityId: workOrder.communityId,
      status: MAINTENANCE_STATUS.DRAFT,
      unitName: office?.name || topCommunity?.name || null,
      reporterName: request?.contactName || null,
      // 有门牌的地址不写「村」：小区名在「管房单位」那一格已经有了，
      // 两处写同一个名字既重复，也会把纸上不到 1cm 的格子撑爆。
      // 公区没有门牌，才拿小区名占住这一格，否则地址整行是空的
      addrVillage: isPublicArea ? topCommunity?.name || null : null,
      addrRoad: house?.roadName || null,
      addrLane: building?.lane || null,
      addrBuildingNo: building?.buildingNo || null,
      addrRoom: house?.roomNo || null,
      reportedOn: this.dateOnly(request?.createdAt ?? workOrder.createdAt),
      presentTime: null,
      faultPart: spot || null,
      repairItem: typeLabel || null,
      appointOn: null,
      startOn: this.dateOnly(workOrder.acceptedAt ?? workOrder.dispatchedAt),
      finishOn: this.dateOnly(workOrder.completedAt),
      // 报修在自己家 = 自用部位；公区/共用位置 = 共用部位，费用走修缮基金、按门牌幢分摊
      // （物业最常见的一档，勾错了在页面上点一下就能改）
      partCategory: house ? 'self' : 'shared',
      feeCategory: house ? 'owner' : 'repair_fund',
      shareMethod: house ? null : 'door',
      repairDateText: null,
      // 括号里的字跟着勾选一起写上，不然纸上勾了「修缮基金」括号却是空的
      feeCategoryText: house ? FEE_CATEGORY_LABELS.owner : FEE_CATEGORY_LABELS.repair_fund,
      shareMethodText: house ? null : SHARE_METHOD_LABELS.door,
      items: [firstItem],
      materials,
      laborRateCents: params.laborRateCents,
      coefficient: String(params.coefficient),
      // 用料的钱开单那一刻就该出现在「合计」里，不能等人点一下才算
      totalCents: totalFeeCents([firstItem], params.coefficient),
      materialTotalCents: materialTotalCents(materials),
      scrapNote: null,
      voucherIssue: null,
      fillerId: user.id,
      fillerName: me?.name || null,
      fillerSignUrl: null,
      repairerId: workOrder.assigneeId,
      repairerName: assignee?.name || null,
      repairerSignUrl: null,
      inspectorId: null,
      inspectorName: null,
      inspectorSignUrl: null,
      inspectedAt: null,
      ownerSignUrl: null,
      // 纸上这两栏物业每次都写同样的字，默认填好，要改再改
      serviceRecord: '良',
      followUpRecord: '好',
      createdBy: user.id,
      updatedBy: user.id,
    };
  }

  /**
   * 背面《材料领耗记录》：工单上的用料原样抄过来。
   * 按用户要求只填实耗数量 / 实耗金额 / 备注，估料、领料、退料几格留白由人手写。
   */
  private async buildMaterialRows(
    tenantId: number,
    workOrder: WorkOrder,
  ): Promise<MaintenanceMaterial[]> {
    const usageRows = await this.workOrderMaterialRepo.find({
      where: { tenantId, workOrderId: workOrder.id },
      order: { id: 'ASC' },
    });
    const materialIds = [
      ...new Set([
        ...usageRows.map((row) => row.materialId),
        ...(workOrder.usedMaterials ?? [])
          .map((item) => (item as { materialId?: number }).materialId)
          .filter((id): id is number => !!id),
      ]),
    ];
    const skus = materialIds.length
      ? await this.materialRepo.find({ where: { tenantId, id: In(materialIds) } })
      : [];
    const skuById = new Map(skus.map((sku) => [sku.id, sku]));
    const costByMaterialId = new Map(
      usageRows.map((row) => [row.materialId, row.totalCostCents]),
    );

    const used = (workOrder.usedMaterials ?? []) as Array<{
      materialId?: number;
      name?: string;
      qty?: number;
      unit?: string;
      note?: string;
    }>;
    const rows: MaintenanceMaterial[] = used.map((item) => {
      const sku = item.materialId ? skuById.get(item.materialId) : undefined;
      return {
        name: item.name || sku?.name || '',
        spec: sku?.spec || '',
        unit: item.unit || sku?.unit || '',
        estQty: null,
        pickQty: null,
        usedQty: item.qty ?? null,
        returnQty: null,
        amountCents: item.materialId ? costByMaterialId.get(item.materialId) ?? null : null,
        note: item.note?.trim() || '',
      };
    });
    // 完工记录里没有、但库存确实扣了的（历史数据），补在后面，别让金额对不上
    const covered = new Set(
      used.map((item) => item.materialId).filter((id): id is number => !!id),
    );
    for (const row of usageRows) {
      if (covered.has(row.materialId)) continue;
      const sku = skuById.get(row.materialId);
      rows.push({
        name: sku?.name || `#${row.materialId}`,
        spec: sku?.spec || '',
        unit: sku?.unit || '',
        estQty: null,
        pickQty: null,
        usedQty: Number(row.qty),
        returnQty: null,
        amountCents: row.totalCostCents,
        note: '',
      });
    }
    return rows;
  }

  private normalizeItem(dto: MaintenanceItemDto): MaintenanceItem {
    const num = (v: unknown): number | null => {
      if (v === null || v === undefined || v === '') return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const int = (v: unknown): number | null => {
      const n = num(v);
      return n === null ? null : Math.round(n);
    };
    const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
    return {
      part: str(dto.part),
      name: str(dto.name),
      surveyQty: num(dto.surveyQty),
      actualQty: num(dto.actualQty),
      actualHours: num(dto.actualHours),
      measureQty: num(dto.measureQty),
      quotaCode: str(dto.quotaCode),
      quotaHours: num(dto.quotaHours),
      laborFeeCents: int(dto.laborFeeCents),
      materialFeeCents: int(dto.materialFeeCents),
      quality: str(dto.quality),
      note: str(dto.note),
    };
  }

  private normalizeMaterial(dto: MaintenanceMaterialDto): MaintenanceMaterial {
    const num = (v: unknown): number | null => {
      if (v === null || v === undefined || v === '') return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
    const amount = num(dto.amountCents);
    return {
      name: str(dto.name),
      spec: str(dto.spec),
      unit: str(dto.unit),
      estQty: num(dto.estQty),
      pickQty: num(dto.pickQty),
      usedQty: num(dto.usedQty),
      returnQty: num(dto.returnQty),
      amountCents: amount === null ? null : Math.round(amount),
      note: str(dto.note),
    };
  }

  private toListRow(row: MaintenanceOrder) {
    return {
      id: row.id,
      orderNo: row.orderNo,
      paperNo: row.paperNo,
      workOrderId: row.workOrderId,
      workOrderNo: row.workOrderNo,
      status: row.status,
      communityId: row.communityId,
      unitName: row.unitName,
      reporterName: row.reporterName,
      addressText: this.addressText(row),
      repairItem: row.repairItem,
      fillerName: row.fillerName,
      repairerName: row.repairerName,
      inspectorName: row.inspectorName,
      inspectedAt: row.inspectedAt,
      totalCents: row.totalCents,
      materialTotalCents: row.materialTotalCents,
      finishOn: row.finishOn,
      createdAt: row.createdAt,
    };
  }

  private toDetail(row: MaintenanceOrder) {
    return {
      ...row,
      coefficient: Number(row.coefficient),
      addressText: this.addressText(row),
      fillerSignUrl: this.storage.toDisplayUrl(row.fillerSignUrl),
      repairerSignUrl: this.storage.toDisplayUrl(row.repairerSignUrl),
      inspectorSignUrl: this.storage.toDisplayUrl(row.inspectorSignUrl),
      ownerSignUrl: this.storage.toDisplayUrl(row.ownerSignUrl),
    };
  }

  private addressText(row: MaintenanceOrder): string {
    return [
      row.addrVillage,
      row.addrRoad ? `${row.addrRoad}路` : '',
      row.addrLane ? `${row.addrLane}弄` : '',
      row.addrBuildingNo ? `${row.addrBuildingNo}号` : '',
      row.addrRoom ? `${row.addrRoom}室` : '',
    ]
      .filter(Boolean)
      .join('');
  }

  private normalizeParams(value: unknown): QuotaParams {
    const raw = (value ?? {}) as Partial<QuotaParams>;
    const rate = Number(raw.laborRateCents);
    const coefficient = Number(raw.coefficient);
    return {
      laborRateCents:
        Number.isFinite(rate) && rate >= 0 ? Math.round(rate) : DEFAULT_QUOTA_PARAMS.laborRateCents,
      coefficient:
        Number.isFinite(coefficient) && coefficient > 0
          ? coefficient
          : DEFAULT_QUOTA_PARAMS.coefficient,
    };
  }

  private async ensureQuotaCodeFree(tenantId: number, code: string, selfId: number | null) {
    const hit = await this.quotaRepo.findOne({
      where: { tenantId, code: code.trim() },
      select: ['id'],
    });
    if (hit && hit.id !== selfId) {
      throw new BadRequestException(`定额编号「${code}」已经有了`);
    }
  }

  private async nextOrderNo(manager: EntityManager, at: Date = new Date()): Promise<string> {
    const yyyy = at.getFullYear();
    const mm = String(at.getMonth() + 1).padStart(2, '0');
    const dd = String(at.getDate()).padStart(2, '0');
    const prefix = `YH-${yyyy}${mm}${dd}-`;
    await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `maintenance-order-no:${prefix}`,
    ]);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const candidate = `${prefix}${this.randomSuffix(4)}`;
      const hit: Array<{ id: number }> = await manager.query(
        'SELECT id FROM maintenance_orders WHERE order_no = $1 LIMIT 1',
        [candidate],
      );
      if (!hit.length) return candidate;
    }
    return `${prefix}${this.randomSuffix(5)}`;
  }

  private randomSuffix(length: number): string {
    const bytes = randomBytes(length);
    let out = '';
    for (let i = 0; i < length; i += 1) {
      out += ORDER_NO_ALPHABET[bytes[i] % ORDER_NO_ALPHABET.length];
    }
    return out;
  }

  /** Date / ISO 串 → YYYY-MM-DD（date 列只存日期，别把时区带进来） */
  private dateOnly(value: Date | string | null | undefined): string | null {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  private assertInScope(communityId: number, access?: ResolvedAccess) {
    const scope = scopeCommunityIds(access);
    if (scope && !scope.includes(communityId)) {
      throw new NotFoundException('养护单不存在');
    }
  }

  private requireTenant(user: AuthUser): number {
    if (user.tenantId) return user.tenantId;
    if (user.role === UserRole.SUPERADMIN) {
      throw new BadRequestException('平台超管请先进入某家物业公司的视角');
    }
    throw new ForbiddenException('账号没有归属物业');
  }
}
