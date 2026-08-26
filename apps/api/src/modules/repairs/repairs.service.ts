import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { randomBytes } from 'crypto';
import {
  DataSource,
  EntityManager,
  FindOptionsWhere,
  ILike,
  In,
  IsNull,
  Repository,
} from 'typeorm';
import { AuthUser } from '../../common/current-user.decorator';
import { ResolvedAccess } from '../access/access.service';
import { scopeCommunityIds } from '../access/scope.util';
import { NotificationsService } from '../notifications/notifications.service';
import { SettingsService } from '../settings/settings.service';
import {
  NotifyChannel,
  NotifyStatus,
  OwnerSource,
  OWNER_APP_ROLES,
  SELF_SCOPED_ROLES,
  STAFF_APP_ROLES,
  RepairSource,
  REPAIR_SOURCE_LABELS,
  REPORTER_ROLES,
  USER_ROLE_LABELS,
  PurchaseRequestStatus,
  StockMovementType,
  UserRole,
  UserStatus,
  WarehouseType,
  WorkOrderStatus,
} from '../../common/enums';
import {
  Building,
  Community,
  House,
  Notification,
  PurchaseRequest,
  RepairRequest,
  RepairTypeCorrection,
  RepairTypeRule,
  RepairTypeWarehouse,
  Review,
  Material,
  StaffProfile,
  User,
  UserReportCommunity,
  Stock,
  StockLot,
  StockMovement,
  Warehouse,
  WorkOrder,
  WorkOrderLog,
  WorkOrderMaterial,
  WorkOrderMaterialAllocation,
} from '../../entities';
import {
  AssignWorkOrderDto,
  CancelWorkOrderDto,
  CompleteWorkOrderDto,
  CreateRepairRequestDto,
  NeedMaterialDto,
  ParseRepairAddressDto,
  ReviewWorkOrderDto,
  UpdateMissingMaterialsDto,
  UpdateWorkOrderRepairTypeDto,
  UpdateWorkOrderSlaDto,
  UpsertRepairTypeRuleDto,
  UpsertRepairTypeWarehouseDto,
  WorkOrdersQueryDto,
} from './dto';
import {
  extractAddressCandidate,
  extractKeywordCandidates,
  sameNo,
} from './repair-address.util';
import {
  COMMON_ACTION_SUGGESTIONS,
  MAX_ACTION_SUGGESTIONS,
  SEED_ACTION_SUGGESTIONS,
  SEED_CONTENT_SUGGESTIONS,
  normalizeSuggestionList,
  SUGGESTION_SCAN_LIMIT,
  collectSuggestion,
  normalizeSuggestionText,
  rankSuggestions,
  type SuggestionBucket,
} from './repair-suggestions.util';
import { ObjectStorageService } from '../upload/object-storage.service';
import { buildTypeKeywords, classifyByKeywords } from './repair-classify.util';
import { assertWorkOrderTransition } from './work-order-state-machine';

const DEFAULT_REPAIR_TYPES = [
  { repairType: 'water', label: '水相关' },
  { repairType: 'electric', label: '电相关' },
  { repairType: 'door_window', label: '家里门锁/门窗相关' },
  { repairType: 'appliance', label: '家电/设备相关' },
  { repairType: 'elevator', label: '电梯相关' },
  { repairType: 'smart', label: '智能化相关' },
  { repairType: 'public', label: '公共设施相关' },
  { repairType: 'other', label: '其它' },
];

/** 旧类型编码 → 新类型编码/标准名（存量租户懒迁移用） */
const LEGACY_REPAIR_TYPE_MAP: Record<string, { repairType: string; label: string }> = {
  plumbing: { repairType: 'water', label: '水相关' },
  electric: { repairType: 'electric', label: '电相关' },
  lock: { repairType: 'door_window', label: '家里门锁/门窗相关' },
  elevator: { repairType: 'elevator', label: '电梯相关' },
  appliance: { repairType: 'appliance', label: '家电/设备相关' },
  public: { repairType: 'public', label: '公共设施相关' },
  other: { repairType: 'other', label: '其它' },
};

/** 撤单快选原因 */
const CANCEL_REASONS: Record<string, string> = {
  wrong_info: '填错了',
  duplicate: '重复提交',
  self_resolved: '已自行解决',
  owner_cancel: '业主取消',
  other: '其他',
};

interface LotAllocation {
  stockLotId: number;
  qty: number;
  unitCostCents: number;
  amountCents: number;
}

@Injectable()
export class RepairsService implements OnModuleInit {
  private readonly logger = new Logger(RepairsService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    @InjectRepository(Community)
    private readonly communityRepo: Repository<Community>,
    @InjectRepository(Building)
    private readonly buildingRepo: Repository<Building>,
    @InjectRepository(House)
    private readonly houseRepo: Repository<House>,
    @InjectRepository(WorkOrder)
    private readonly workOrderRepo: Repository<WorkOrder>,
    @InjectRepository(RepairRequest)
    private readonly repairRequestRepo: Repository<RepairRequest>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(RepairTypeRule)
    private readonly repairTypeRuleRepo: Repository<RepairTypeRule>,
    private readonly storage: ObjectStorageService,
    private readonly notifications: NotificationsService,
    private readonly settings: SettingsService,
  ) {}

  /**
   * 启动时把历史工单号统一成新规则。放在启动里而不是留个手工接口：
   * 手工的那种迟早忘了跑，列表里就一直两种格式混排。已合规的单不动，重启也不会反复换号。
   */
  async onModuleInit() {
    try {
      await this.renumberLegacyOrderNos();
    } catch (error) {
      // 迁移失败不能拦住服务启动 —— 报修比单号好看重要
      this.logger.error(
        `工单号迁移失败：${error instanceof Error ? error.message : error}`,
      );
    }
  }

  async listRepairTypeRules(user: AuthUser) {
    const tenantId = this.resolveTenantId(user);
    await this.ensureDefaultRepairTypeRules(tenantId, user.id);
    return this.repairTypeRuleRepo.find({
      where: { tenantId },
      order: { sortOrder: 'ASC', id: 'ASC' },
    });
  }

  async createRepairTypeRule(dto: UpsertRepairTypeRuleDto, user: AuthUser) {
    const tenantId = this.resolveTenantId(user);
    await this.assertAssignee(tenantId, dto.assigneeId ?? null);
    const existing = await this.repairTypeRuleRepo.findOne({
      where: { tenantId, repairType: dto.repairType },
    });
    if (existing) throw new BadRequestException('该报修类型规则已存在');
    const sortOrder = dto.sortOrder ?? (await this.nextRepairTypeSortOrder(tenantId));
    return this.repairTypeRuleRepo.save(
      this.repairTypeRuleRepo.create({
        tenantId,
        repairType: dto.repairType,
        label: dto.label,
        assigneeId: dto.assigneeId ?? null,
        slaHours: dto.slaHours ?? null,
        sortOrder,
        enabled: dto.enabled ?? true,
        contentSuggestions:
          dto.contentSuggestions ?? SEED_CONTENT_SUGGESTIONS[dto.repairType] ?? [],
        createdBy: user.id,
        updatedBy: user.id,
      }),
    );
  }

  async updateRepairTypeRule(id: number, dto: UpsertRepairTypeRuleDto, user: AuthUser) {
    const tenantId = this.resolveTenantId(user);
    await this.assertAssignee(tenantId, dto.assigneeId ?? null);
    const rule = await this.repairTypeRuleRepo.findOne({ where: { id, tenantId } });
    if (!rule) throw new NotFoundException('repair type rule not found');
    const dup = await this.repairTypeRuleRepo.findOne({
      where: { tenantId, repairType: dto.repairType },
    });
    if (dup && dup.id !== id) throw new BadRequestException('该报修类型规则已存在');
    rule.repairType = dto.repairType;
    rule.label = dto.label;
    rule.assigneeId = dto.assigneeId ?? null;
    rule.slaHours = dto.slaHours ?? null;
    rule.sortOrder = dto.sortOrder ?? rule.sortOrder;
    rule.enabled = dto.enabled ?? true;
    if (dto.contentSuggestions !== undefined) {
      rule.contentSuggestions = normalizeSuggestionList(dto.contentSuggestions);
    }
    rule.updatedBy = user.id;
    return this.repairTypeRuleRepo.save(rule);
  }

  async deleteRepairTypeRule(id: number, user: AuthUser) {
    const tenantId = this.resolveTenantId(user);
    const rule = await this.repairTypeRuleRepo.findOne({ where: { id, tenantId } });
    if (!rule) throw new NotFoundException('repair type rule not found');
    await this.repairTypeRuleRepo.remove(rule);
    return { ok: true };
  }

  async reorderRepairTypeRules(ids: number[], user: AuthUser) {
    const tenantId = this.resolveTenantId(user);
    if (!ids.length) return this.listRepairTypeRules(user);

    const rules = await this.repairTypeRuleRepo.find({ where: { tenantId } });
    const ruleById = new Map(rules.map((rule) => [rule.id, rule]));
    for (const id of ids) {
      if (!ruleById.has(id)) throw new NotFoundException('repair type rule not found');
    }

    ids.forEach((id, index) => {
      const rule = ruleById.get(id)!;
      rule.sortOrder = (index + 1) * 10;
      rule.updatedBy = user.id;
    });
    await this.repairTypeRuleRepo.save(ids.map((id) => ruleById.get(id)!));
    return this.listRepairTypeRules(user);
  }

  /** 报修类型的对外精简版：只给编码、名称和关键词，不含派单规则 */
  async listPublicRepairTypes(user: AuthUser) {
    const tenantId = this.resolveTenantId(user);
    await this.ensureDefaultRepairTypeRules(tenantId, user.id);
    const rules = await this.repairTypeRuleRepo.find({
      where: { tenantId, enabled: true },
      order: { sortOrder: 'ASC', id: 'ASC' },
    });
    // keywords 不只是后台配的那几句：类型名切出来的词 + 同义词也算，
    // 否则租户自建的类型（「门铃 / 对讲 / 门禁 /监控 / 道闸 问题」）一个关键词都没有，
    // 业主写什么都判成「其它」
    const negativeByType = await this.buildNegativeKeywords(tenantId);
    return rules.map((rule) => {
      const keywords = buildTypeKeywords(rule);
      // 后台明确配过的词永远算数：人写进去的意图，不能被几次误判推翻
      const configured = new Set(rule.contentSuggestions ?? []);
      return {
        repairType: rule.repairType,
        label: rule.label,
        keywords,
        negativeKeywords: (negativeByType.get(rule.repairType) ?? []).filter(
          (word) => !configured.has(word),
        ),
      };
    });
  }

  /**
   * 负样本 → 每个类型的「别再按这个词判我」清单。
   *
   * 来源是 repair_type_corrections：端上判成 A、人当场改成 B 的那些单。
   * 从被改判的描述里取出「当初让 A 命中的词」，同一个词被改走 ≥2 次才算数 ——
   * 一次可能是手滑或个例，两次就是判定确实不对。
   *
   * 只降权、不删配置：后台明明白白配过的词在上面被排除掉了，
   * 这里管的是类型名切词、同义词这类「系统自己猜的」匹配。
   */
  private async buildNegativeKeywords(tenantId: number): Promise<Map<string, string[]>> {
    const corrections = await this.dataSource.getRepository(RepairTypeCorrection).find({
      where: { tenantId },
      order: { id: 'DESC' },
      take: 500,
    });
    const wrongOnes = corrections.filter((row) => row.fromType && row.fromType !== row.toType);
    if (!wrongOnes.length) return new Map();

    const rules = await this.repairTypeRuleRepo.find({ where: { tenantId } });
    const keywordsByType = new Map(
      rules.map((rule) => [rule.repairType, buildTypeKeywords(rule)] as const),
    );

    // type -> keyword -> 被改走的次数
    const counter = new Map<string, Map<string, number>>();
    for (const row of wrongOnes) {
      const text = String(row.content || '').toLowerCase();
      for (const word of keywordsByType.get(row.fromType!) ?? []) {
        const key = word.trim().toLowerCase();
        if (key.length < 2 || !text.includes(key)) continue;
        const bucket = counter.get(row.fromType!) ?? new Map<string, number>();
        bucket.set(word, (bucket.get(word) ?? 0) + 1);
        counter.set(row.fromType!, bucket);
      }
    }

    const out = new Map<string, string[]>();
    for (const [type, bucket] of counter) {
      const words = Array.from(bucket.entries())
        .filter(([, count]) => count >= 2)
        .map(([word]) => word);
      if (words.length) out.set(type, words);
    }
    return out;
  }

  async listRepairSuggestions(user: AuthUser) {
    const tenantId = this.resolveTenantId(user);
    const [locations, contents, rules] = await Promise.all([
      this.listFrequentRepairText(tenantId, 'address_text', 8),
      this.summarizeRepairContents(tenantId),
      this.repairTypeRuleRepo.find({ where: { tenantId } }),
    ]);

    // 每个已配置关键词被真实用了多少次，供后台「按使用次数排序」
    const keywordUsageByType: Record<string, Record<string, number>> = {};
    for (const rule of rules) {
      const counts = contents.keyCountsByType[rule.repairType];
      const usage: Record<string, number> = {};
      for (const keyword of rule.contentSuggestions ?? []) {
        const key = normalizeSuggestionText(keyword);
        usage[keyword] = (key && counts?.[key]) || 0;
      }
      keywordUsageByType[rule.repairType] = usage;
    }

    return {
      locations,
      contents: contents.general,
      contentsByType: contents.byType,
      keywordUsageByType,
    };
  }

  /**
   * 维修说明的常用话术：给维修工点选，少打字。
   *
   * 排序完全由本租户历史维修说明归纳（哪句用得多、用得新，哪句排前面），
   * 种子话术只在历史里没有时兜底 —— 单子越多，这个列表越贴合这个小区实际在修什么。
   */
  async listActionSuggestions(user: AuthUser) {
    const tenantId = this.resolveTenantId(user);
    const [history, rules] = await Promise.all([
      this.summarizeActionNotes(tenantId),
      this.repairTypeRuleRepo.find({ where: { tenantId }, select: ['repairType'] }),
    ]);

    /** 历史 → 该类型种子 → 通用兜底，逐层补到 12 条，去重按聚类键 */
    const merge = (type: string) => {
      const rows = (history.byType[type] ?? []).slice();
      const used = new Set(rows.map((item) => normalizeSuggestionText(item.text)));
      const topUp = (texts: string[]) => {
        for (const text of texts) {
          if (rows.length >= MAX_ACTION_SUGGESTIONS) return;
          const key = normalizeSuggestionText(text);
          if (!key || used.has(key)) continue;
          used.add(key);
          rows.push({ text, count: 0 });
        }
      };
      topUp(SEED_ACTION_SUGGESTIONS[type] ?? []);
      // 租户自建的类型（menjing 这种）种子表里没有，不兜底就是一片空白
      topUp(COMMON_ACTION_SUGGESTIONS);
      return rows;
    };

    // 覆盖到租户真实配置的每一个类型，而不是只有内置那 8 个
    const types = new Set([
      ...Object.keys(SEED_ACTION_SUGGESTIONS),
      ...Object.keys(history.byType),
      ...rules.map((rule) => rule.repairType),
    ]);
    return {
      byType: Object.fromEntries(Array.from(types).map((type) => [type, merge(type)])),
      general: merge(''),
    };
  }

  async submitOwnerRepair(dto: CreateRepairRequestDto, user: AuthUser) {
    // 两个小程序都走这个入口：业主端（业主 + 保安/居委会/业委会/物业工作人员）
    // 和员工端（维修工/办公室等，巡查发现问题顺手提单），位置都不受「自己家」约束
    const allowed: string[] = [...OWNER_APP_ROLES, ...STAFF_APP_ROLES];
    if (!allowed.includes(user.role)) {
      throw new ForbiddenException('该角色不能提交报修');
    }

    // 没入驻的业主（tenantId 为空）也要能报修：扫了楼栋码就该能提，
    // 不能逼着人先绑定房号——有人只是想报个楼道灯，也有人不愿意透露住哪。
    // 租户从小区反查，与 ownerOnboard 同一套信任模型（小区 id 来自扫码解析）。
    let tenantId: number;
    if (user.tenantId) {
      tenantId = this.resolveTenantId(user, dto.tenantId);
    } else {
      const community = await this.communityRepo.findOne({
        where: { id: dto.communityId, enabled: true },
      });
      if (!community) throw new NotFoundException('community not found');
      tenantId = community.tenantId;
      // 落一次租户归属，否则他之后看不到自己提的工单
      await this.userRepo.update({ id: user.id }, { tenantId });
    }

    await this.assertCanReportAt(dto, tenantId, user);

    // 非业主本人报的都把身份标出来（保安/维修工/办公室…），
    // 办公室看到「张三（维修工代报）」才知道电话那头不是住户本人
    return this.createRepairAndWorkOrder(
      dto,
      tenantId,
      STAFF_APP_ROLES.includes(user.role as UserRole)
        ? RepairSource.STAFF_MINIAPP
        : RepairSource.OWNER_MINIAPP,
      user.id,
      user.role !== UserRole.OWNER ? user.role : null,
    );
  }

  submitOfficeRepair(dto: CreateRepairRequestDto, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.resolveTenantId(user, dto.tenantId);
    const scope = this.scopeIds(access);
    if (scope && dto.communityId && !scope.includes(dto.communityId)) {
      throw new ForbiddenException('该小区不在你的管理范围内');
    }
    return this.createRepairAndWorkOrder(
      dto,
      tenantId,
      RepairSource.OFFICE_WEB,
      user.id,
      null,
    );
  }

  private scopeIds(access?: ResolvedAccess): number[] | null {
    return scopeCommunityIds(access);
  }

  async listWorkOrders(query: WorkOrdersQueryDto, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.resolveTenantId(user, query.tenantId);
    await this.autoCompleteExpiredReviews(tenantId);
    const where: FindOptionsWhere<WorkOrder> = { tenantId };
    if (query.communityId) where.communityId = query.communityId;
    const scope = this.scopeIds(access);
    if (scope) {
      if (!scope.length) return [];
      if (query.communityId) {
        if (!scope.includes(query.communityId)) return [];
      } else {
        where.communityId = In(scope);
      }
    }
    if (query.status) {
      if (!Object.values(WorkOrderStatus).includes(query.status as WorkOrderStatus)) {
        throw new BadRequestException('invalid work order status');
      }
      where.status = query.status as WorkOrderStatus;
    }

    // 小程序角色按人收敛可见范围，后台角色维持全租户。
    // 业主端身份不止 OWNER：保安/居委/业委/物业工作人员也在业主端提单，
    // 漏了他们要么 403、要么（更糟）落到无过滤分支看到全租户的单
    if (SELF_SCOPED_ROLES.includes(user.role as UserRole)) {
      const myRequestIds = await this.repairRequestRepo.find({
        where: { tenantId, submittedBy: user.id },
        select: ['id'],
        order: { id: 'DESC' },
        take: 200,
      });
      if (!myRequestIds.length) return [];
      where.requestId = In(myRequestIds.map((item) => item.id));
    } else if (query.scope === 'pool') {
      // 池子对两种人是同一批单，只是叫法不同：维修工看「我能接什么」，
      // 办公室看「我该派谁」。所以这一档不再只认 TECHNICIAN ——
      // 原来办公室带 scope=pool 会掉进下面的无过滤分支，把全公司的单（含维修中、
      // 已完成）当成待接单列出来，卡片上还挂着「接单」按钮。
      where.assigneeId = IsNull();
      if (!query.status) {
        // 等待材料的单也在池子里：缺料提报后工单会退回池子（见 markNeedMaterial），
        // 材料到货后由办公室重新派单，或维修工自己接回去接着修
        where.status = In([
          WorkOrderStatus.CREATED,
          WorkOrderStatus.DISPATCHED,
          WorkOrderStatus.WAITING_MATERIAL,
        ]);
      }
    } else if (query.scope === 'mine' || user.role === UserRole.TECHNICIAN) {
      // 「在手工单」= 派到我头上的单，对谁都是这个意思。
      // 原来这一档只认 TECHNICIAN，办公室带 scope=mine 会掉进无过滤分支，
      // 把全公司的工单当成「我手上的」列出来。
      // 维修工不带 scope 时仍然默认只看自己的单 —— 这条不能丢，丢了就是越权看全公司。
      where.assigneeId = user.id;
    }

    // 关键词：单号在工单表上，地址/描述在报修表上，先把命中的 requestId 捞出来再合并。
    // 命中一条都没有时必须直接返回空 —— 不加这层，where 里没有 requestId 约束，
    // 搜不到反而会把全部工单列出来，看着像「搜索没生效」
    const keyword = query.q?.trim();
    let wheres: FindOptionsWhere<WorkOrder>[] = [where];
    if (keyword) {
      const hitRequests = await this.repairRequestRepo.find({
        where: [
          { tenantId, addressText: ILike(`%${keyword}%`) },
          { tenantId, content: ILike(`%${keyword}%`) },
        ],
        select: ['id'],
        take: 300,
      });
      wheres = [{ ...where, orderNo: ILike(`%${keyword}%`) }];
      if (hitRequests.length) {
        wheres.push({ ...where, requestId: In(hitRequests.map((item) => item.id)) });
      }
    }

    const workOrders = await this.workOrderRepo.find({
      where: wheres.length === 1 ? wheres[0] : wheres,
      order: { id: 'DESC' },
      take: 100,
    });
    const requestIds = workOrders.map((item) => item.requestId);
    if (!requestIds.length) return workOrders;

    const requests = await this.repairRequestRepo.find({
      where: { tenantId, id: In(requestIds) },
      select: ['id', 'repairType', 'houseId', 'buildingId', 'addressText', 'content'],
    });
    const houseIds = requests
      .map((item) => item.houseId)
      .filter((id): id is number => !!id);
    const houses = houseIds.length
      ? await this.dataSource.getRepository(House).find({
          where: { tenantId, id: In(houseIds) },
          select: ['id', 'buildingId', 'roomNo', 'fullAddress'],
        })
      : [];
    const buildingIds = Array.from(new Set([
      ...requests.map((item) => item.buildingId).filter((id): id is number => !!id),
      ...houses.map((item) => item.buildingId),
    ]));
    const buildings = buildingIds.length
      ? await this.dataSource.getRepository(Building).find({
          where: { tenantId, id: In(buildingIds) },
          select: ['id', 'lane', 'buildingNo'],
        })
      : [];
    const requestById = new Map(requests.map((item) => [item.id, item]));
    const houseById = new Map(houses.map((item) => [item.id, item]));
    const buildingById = new Map(buildings.map((item) => [item.id, item]));
    const typeLabels = await this.repairTypeLabels(tenantId);
    // 派单台要显示「这单在谁手上」。端上查不到人名（/staff 是 users 页权限，
    // 办公室不一定有），所以这里一并带出来
    const assigneeIds = Array.from(
      new Set(workOrders.map((item) => item.assigneeId).filter((id): id is number => !!id)),
    );
    const assignees = assigneeIds.length
      ? await this.userRepo.find({
          where: { tenantId, id: In(assigneeIds) },
          select: ['id', 'name'],
        })
      : [];
    const assigneeNameById = new Map(assignees.map((item) => [item.id, item.name]));
    return workOrders.map((item) => {
      const repairType = requestById.get(item.requestId)?.repairType ?? item.skill;
      return {
        ...item,
        repairType,
        // 租户自建的类型（menjing、duijiang…）在端上查不到中文，卡片会直接显示编码，
        // 所以中文名由后端给：租户配的 label 优先，回退到内置类型表
        repairTypeLabel: this.repairTypeLabel(repairType, typeLabels),
        summaryAddress: this.buildRequestAddressSummary(
          requestById.get(item.requestId),
          houseById,
          buildingById,
        ),
        summaryContent: requestById.get(item.requestId)?.content ?? '',
        assigneeName: item.assigneeId
          ? assigneeNameById.get(item.assigneeId) ?? `#${item.assigneeId}`
          : null,
      };
    });
  }

  /**
   * 派单台的维修工清单（含在手单数）。
   *
   * 为什么不复用 GET /staff：那是「用户管理」页的权限，办公室的角色未必勾了 ——
   * 派单是工单页的事，权限就该按工单页算。返回的字段也只够派单用（姓名/电话/工种/在手几单），
   * 不下发账号、微信绑定这些跟派单无关的信息。
   */
  async listDispatchTechnicians(user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.resolveTenantId(user);
    const technicians = await this.userRepo.find({
      where: { tenantId, role: UserRole.TECHNICIAN, status: UserStatus.ACTIVE },
      select: ['id', 'name', 'phone'],
      order: { id: 'ASC' },
    });
    if (!technicians.length) return [];

    const ids = technicians.map((item) => item.id);
    const scope = this.scopeIds(access);
    const openWhere: FindOptionsWhere<WorkOrder> = {
      tenantId,
      assigneeId: In(ids),
      status: In([WorkOrderStatus.DISPATCHED, WorkOrderStatus.IN_PROGRESS]),
    };
    if (scope) {
      if (!scope.length) return [];
      openWhere.communityId = In(scope);
    }
    const open = await this.workOrderRepo.find({
      where: openWhere,
      select: ['id', 'assigneeId'],
    });
    const openCount = new Map<number, number>();
    open.forEach((item) => {
      if (item.assigneeId) {
        openCount.set(item.assigneeId, (openCount.get(item.assigneeId) ?? 0) + 1);
      }
    });

    const profiles = await this.dataSource.getRepository(StaffProfile).find({
      where: { tenantId, userId: In(ids) },
      select: ['userId', 'skills'],
    });
    const skillsByUser = new Map(profiles.map((item) => [item.userId, item.skills || []]));

    return technicians.map((item) => ({
      id: item.id,
      name: item.name || `#${item.id}`,
      phone: item.phone ?? null,
      skills: skillsByUser.get(item.id) ?? [],
      openCount: openCount.get(item.id) ?? 0,
    }));
  }

  /**
   * 这张工单能领哪些料：本小区仓的库存清单（维修工可读）。
   *
   * 为什么按工单查而不是让端上自己挑仓库：维修工不该、也不会知道仓库 id，
   * 他只知道「我在这个小区修这单」。仓库由工单的 communityId 反查，
   * 没有小区仓就退回总仓 —— 小物业往往只有一个仓，不能因此就选不了料。
   *
   * 库存为 0 的材料也返回（标 qty=0）：现场需要它但仓里没有，正是要走缺料登记的场景，
   * 列表里看不到反而让人以为「这东西系统里不存在」。
   */
  // ---------------- 报修类型 → 领料仓库（按小区配） ----------------

  /**
   * 全租户的「小区 + 类型 → 仓库」对照表，连可选仓库一起给。
   *
   * 仓库列表跟着一起返回，是为了不让「报修类型配置」这个页面依赖 inventory 权限——
   * 配派单规则的办公室文员不一定有库存模块权限，缺一个 /warehouses 就整页配不了。
   * 一次全给：小区数 × 类型数 撑死几十条，后台切小区时不用来回请求。
   */
  async listRepairTypeWarehouses(user: AuthUser) {
    const tenantId = this.resolveTenantId(user);
    const [rows, warehouses] = await Promise.all([
      this.dataSource.getRepository(RepairTypeWarehouse).find({
        where: { tenantId },
        order: { communityId: 'ASC', id: 'ASC' },
      }),
      this.dataSource.getRepository(Warehouse).find({
        where: { tenantId, enabled: true },
        order: { id: 'ASC' },
      }),
    ]);
    return {
      warehouses: warehouses.map((item) => ({
        id: item.id,
        name: item.name,
        type: item.type,
        communityId: item.communityId,
        enabled: item.enabled,
      })),
      items: rows.map((row) => ({
        communityId: row.communityId,
        repairType: row.repairType,
        warehouseId: row.warehouseId,
      })),
    };
  }

  /**
   * 配 / 改 / 清空一个「小区 + 类型」的领料仓库。warehouseId 传 null = 清空这一条。
   * 仓库必须是本租户启用中的 —— 配到停用仓上，维修工那边就是一屏空列表。
   */
  async upsertRepairTypeWarehouse(dto: UpsertRepairTypeWarehouseDto, user: AuthUser) {
    const tenantId = this.resolveTenantId(user);
    const repo = this.dataSource.getRepository(RepairTypeWarehouse);
    const where = {
      tenantId,
      communityId: dto.communityId,
      repairType: dto.repairType,
    };
    const existing = await repo.findOne({ where });

    if (dto.warehouseId === null || dto.warehouseId === undefined) {
      if (existing) await repo.remove(existing);
      return { ...where, warehouseId: null };
    }

    const warehouse = await this.dataSource.getRepository(Warehouse).findOne({
      where: { id: dto.warehouseId, tenantId, enabled: true },
    });
    if (!warehouse) throw new BadRequestException('仓库不存在或已停用');

    const saved = await repo.save(
      existing
        ? Object.assign(existing, { warehouseId: dto.warehouseId, updatedBy: user.id })
        : repo.create({ ...where, warehouseId: dto.warehouseId, createdBy: user.id }),
    );
    return {
      communityId: saved.communityId,
      repairType: saved.repairType,
      warehouseId: saved.warehouseId,
    };
  }

  /**
   * 这张工单能领哪些料。
   *
   * 仓库由「小区 + 报修类型」定：小区取工单所在小区（= 报修人所属小区），
   * 类型对应哪个仓在后台「报修类型配置」里按小区分别配（repair_type_warehouses）。
   * 同一个门禁故障，一期从智能化维修工仓库领、二期可能另有仓，靠猜是猜不出来的。
   *
   * 没配就是没配 —— 不回退到「本小区仓」或「第一个总仓」：
   * 猜错仓就是把料从别人的账上扣走，账对不上比领不到料更难查。
   * 这种情况下端上给一句「去配」的提示，同时留「换仓库」让维修工手动挑，
   * 别让人卡在这儿干等办公室。
   */
  async listWorkOrderStockOptions(id: number, user: AuthUser, warehouseId?: number) {
    const tenantId = this.resolveTenantId(user);
    const workOrder = await this.workOrderRepo.findOne({ where: { id, tenantId } });
    if (!workOrder) throw new NotFoundException('work order not found');

    const request = await this.repairRequestRepo.findOne({
      where: { id: workOrder.requestId, tenantId },
      select: ['id', 'repairType'],
    });
    const repairType = request?.repairType ?? null;
    const labels = await this.repairTypeLabels(tenantId);
    const repairTypeLabel = this.repairTypeLabel(repairType, labels);

    const warehouseRepo = this.dataSource.getRepository(Warehouse);
    const all = await warehouseRepo.find({ where: { tenantId, enabled: true }, order: { id: 'ASC' } });

    // 本单「小区 + 类型」配的仓
    const mapping = repairType
      ? await this.dataSource.getRepository(RepairTypeWarehouse).findOne({
          where: { tenantId, communityId: workOrder.communityId, repairType },
        })
      : null;
    const mapped = mapping ? all.find((item) => item.id === mapping.warehouseId) ?? null : null;

    // 配好的排最前，其余按 id —— 手动换仓库时也是这个顺序
    const candidates = all
      .slice()
      .sort((a, b) => (a.id === mapped?.id ? -1 : 0) - (b.id === mapped?.id ? -1 : 0) || a.id - b.id);

    const stockRepo = this.dataSource.getRepository(Stock);
    const allStocks = candidates.length
      ? await stockRepo.find({
          where: { tenantId, warehouseId: In(candidates.map((item) => item.id)) },
        })
      : [];
    const stockedWarehouses = new Set(
      allStocks.filter((row) => Number(row.qty) > 0).map((row) => row.warehouseId),
    );

    // 端上明确指定了就用它（手动换仓库），否则只认配置，配了才有默认仓
    const warehouse = warehouseId
      ? candidates.find((item) => item.id === warehouseId) ?? null
      : mapped;

    const materials = await this.dataSource.getRepository(Material).find({
      where: { tenantId, enabled: true },
      order: { category: 'ASC', id: 'ASC' },
    });
    const qtyByMaterial = new Map(
      allStocks
        .filter((row) => warehouse && row.warehouseId === warehouse.id)
        .map((row) => [row.materialId, Number(row.qty) || 0]),
    );

    return {
      warehouseId: warehouse?.id ?? null,
      warehouseName: warehouse?.name ?? '',
      /** 本单报修类型（端上提示「哪个类型没配仓库」要用，别让人自己去猜） */
      repairType,
      repairTypeLabel,
      /** 这个「小区 + 类型」在后台配没配仓库；没配时端上给去配的提示 */
      configured: !!mapped,
      warehouses: candidates.map((item) => ({
        id: item.id,
        name: item.name,
        type: item.type,
        /** 就是本单「小区 + 类型」配好的那个仓 */
        own: item.id === mapped?.id,
        hasStock: stockedWarehouses.has(item.id),
      })),
      items: materials.map((item) => ({
        materialId: item.id,
        code: item.code,
        name: item.name,
        spec: item.spec,
        category: item.category,
        unit: item.unit,
        photoUrl: this.storage.toDisplayUrl(item.photoUrl) || null,
        aliases: item.aliases || [],
        qty: qtyByMaterial.get(item.id) ?? 0,
      })),
    };
  }

  /** 报修类型编码 → 中文名（租户配的），端上不该自己猜 */
  private async repairTypeLabels(tenantId: number): Promise<Map<string, string>> {
    const rules = await this.repairTypeRuleRepo.find({
      where: { tenantId },
      select: ['repairType', 'label'],
    });
    return new Map(rules.map((rule) => [rule.repairType, rule.label]));
  }

  private repairTypeLabel(
    repairType: string | null | undefined,
    labels: Map<string, string>,
  ): string {
    if (!repairType) return '其它';
    return (
      labels.get(repairType) ||
      DEFAULT_REPAIR_TYPES.find((item) => item.repairType === repairType)?.label ||
      LEGACY_REPAIR_TYPE_MAP[repairType]?.label ||
      repairType
    );
  }

  async getWorkOrderStats(query: WorkOrdersQueryDto, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.resolveTenantId(user, query.tenantId);
    await this.autoCompleteExpiredReviews(tenantId);
    const scope = this.scopeIds(access);
    if (scope && !scope.length) return { total: 0, byStatus: {} };
    const qb = this.workOrderRepo
      .createQueryBuilder('wo')
      .select('wo.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .where('wo.tenant_id = :tenantId', { tenantId });

    if (scope) {
      qb.andWhere('wo.community_id IN (:...scope)', { scope });
    }
    if (query.communityId) {
      qb.andWhere('wo.community_id = :communityId', { communityId: query.communityId });
    }

    const rows = await qb.groupBy('wo.status').getRawMany<{ status: WorkOrderStatus; count: string }>();
    const byStatus = rows.reduce((acc, item) => {
      acc[item.status] = Number(item.count);
      return acc;
    }, {} as Partial<Record<WorkOrderStatus, number>>);
    const total = Object.values(byStatus).reduce((sum, count) => sum + (count || 0), 0);
    return { total, byStatus };
  }

  async listRepairHistory(query: WorkOrdersQueryDto, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.resolveTenantId(user, query.tenantId);
    if (!query.buildingId) return [];
    await this.autoCompleteExpiredReviews(tenantId);

    const scope = this.scopeIds(access);
    if (scope) {
      const scopedBuilding = await this.dataSource.getRepository(Building).findOne({
        where: { tenantId, id: query.buildingId },
        select: ['id', 'communityId'],
      });
      if (!scopedBuilding || !scope.includes(scopedBuilding.communityId)) return [];
    }

    const requests = await this.repairRequestRepo.find({
      where: { tenantId, buildingId: query.buildingId },
      order: { id: 'DESC' },
      take: 12,
      select: ['id', 'repairType', 'houseId', 'buildingId', 'addressText', 'content', 'createdAt'],
    });
    if (!requests.length) return [];

    const requestIds = requests.map((item) => item.id);
    const workOrders = await this.workOrderRepo.find({
      where: { tenantId, requestId: In(requestIds) },
      select: ['id', 'requestId', 'orderNo', 'status', 'createdAt', 'completedAt'],
    });
    const workOrderByRequestId = new Map(workOrders.map((item) => [item.requestId, item]));
    const houseIds = requests.map((item) => item.houseId).filter((id): id is number => !!id);
    const houses = houseIds.length
      ? await this.dataSource.getRepository(House).find({
          where: { tenantId, id: In(houseIds) },
          select: ['id', 'buildingId', 'roomNo', 'fullAddress'],
        })
      : [];
    const building = await this.dataSource.getRepository(Building).findOne({
      where: { tenantId, id: query.buildingId },
      select: ['id', 'lane', 'buildingNo'],
    });
    const houseById = new Map(houses.map((item) => [item.id, item]));
    const buildingById = new Map(building ? [[building.id, building]] : []);

    return requests.map((request) => {
      const workOrder = workOrderByRequestId.get(request.id);
      return {
        requestId: request.id,
        workOrderId: workOrder?.id ?? null,
        orderNo: workOrder?.orderNo ?? null,
        status: workOrder?.status ?? null,
        repairType: request.repairType,
        summaryAddress: this.buildRequestAddressSummary(request, houseById, buildingById),
        summaryContent: request.content,
        createdAt: request.createdAt,
        completedAt: workOrder?.completedAt ?? null,
      };
    });
  }

  private buildRequestAddressSummary(
    request: Pick<RepairRequest, 'addressText' | 'houseId' | 'buildingId'> | undefined,
    houseById: Map<number, Pick<House, 'id' | 'buildingId' | 'roomNo' | 'fullAddress'>>,
    buildingById: Map<number, Pick<Building, 'id' | 'lane' | 'buildingNo'>>,
  ) {
    if (!request) return '';
    const house = request.houseId ? houseById.get(request.houseId) : undefined;
    const buildingId = house?.buildingId ?? request.buildingId ?? undefined;
    const building = buildingId ? buildingById.get(buildingId) : undefined;
    const parts = [
      building?.lane ? `${building.lane}弄` : '',
      building?.buildingNo ? `${building.buildingNo}号` : '',
      house?.roomNo ? `${house.roomNo}室` : '',
    ];
    const houseLabel = parts.filter(Boolean).join('');
    return houseLabel || request.addressText || '';
  }

  async getWorkOrder(id: number, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.resolveTenantId(user);
    await this.autoCompleteExpiredReviews(tenantId);
    const workOrder = await this.workOrderRepo.findOne({ where: { id, tenantId } });
    if (!workOrder) throw new NotFoundException('work order not found');
    const scope = this.scopeIds(access);
    if (scope && !scope.includes(workOrder.communityId)) {
      throw new NotFoundException('work order not found');
    }
    const [request, logs] = await Promise.all([
      this.repairRequestRepo.findOne({
        where: { id: workOrder.requestId, tenantId },
      }),
      this.dataSource.getRepository(WorkOrderLog).find({
        where: { workOrderId: id, tenantId },
        order: { id: 'ASC' },
      }),
    ]);
    // 业主端身份（业主/保安/居委/业委/物业工作人员）只能看自己提交的报修
    if (SELF_SCOPED_ROLES.includes(user.role as UserRole) && request?.submittedBy !== user.id) {
      throw new NotFoundException('work order not found');
    }
    // 存量工单的联系人/电话是空的（那会儿端上选填、服务端也不兜底），
    // 读取时补上，不改历史数据；新单在创建时就已经写进库里了
    const contact = request
      ? await this.resolveContact(request, tenantId, request.submittedBy, {
          submitterIsContact: request.source !== RepairSource.OFFICE_WEB,
          allowHouseOwnerFallback: !request.reporterRole,
        })
      : null;
    const typeLabels = await this.repairTypeLabels(tenantId);
    // 报修人登记地址（认证的房屋）单独给一栏：报修地址可能是公区或别人家，
    // 办公室要能一眼分清「他家在哪」和「要去修哪」
    const reporterAddressText = request?.submittedBy
      ? await this.registeredAddressText(request.submittedBy, tenantId)
      : null;

    // 详情页要写「谁在修 / 谁修的」。和列表同一口径，端上不再各自去查人名
    const assignee = workOrder.assigneeId
      ? await this.userRepo.findOne({
          where: { id: workOrder.assigneeId, tenantId },
          select: ['id', 'name'],
        })
      : null;

    return {
      workOrder: {
        ...workOrder,
        assigneeName: workOrder.assigneeId
          ? assignee?.name || `#${workOrder.assigneeId}`
          : null,
        resultAttachments: this.storage.toDisplayUrls(workOrder.resultAttachments),
      },
      request: request
        ? {
            ...request,
            // 中文类型名由后端给，端上不认识租户自建的编码（会直接显示 menjing）
            repairTypeLabel: this.repairTypeLabel(request.repairType, typeLabels),
            contactName: contact?.name ?? request.contactName,
            contactPhone: contact?.phone ?? request.contactPhone,
            // 代报时前端要显示「张三（保安）」，别让办公室以为是业主本人报的
            reporterRoleLabel: request.reporterRole
              ? USER_ROLE_LABELS[request.reporterRole] ?? request.reporterRole
              : null,
            reporterAddressText,
            attachments: this.storage.toDisplayUrls(request.attachments),
          }
        : request,
      logs: logs.map((log) => ({ ...log, note: this.displayLogNote(log.note) })),
    };
  }

  /** 报修人（提交账号）认证的登记地址；没绑房时返回 null */
  private async registeredAddressText(
    userId: number,
    tenantId: number,
  ): Promise<string | null> {
    const reporter = await this.userRepo.findOne({
      where: { id: userId, tenantId },
      select: ['id', 'houseId'],
    });
    if (!reporter?.houseId) return null;
    const house = await this.houseRepo.findOne({
      where: { id: reporter.houseId, tenantId },
    });
    if (!house) return null;
    const building = await this.buildingRepo.findOne({
      where: { id: house.buildingId, tenantId },
    });
    const community = building
      ? await this.communityRepo.findOne({ where: { id: building.communityId, tenantId } })
      : null;
    // 门牌连写、段间空格，与 auth.me 同口径：枫桦景苑一期 198弄24号302室
    const buildingText = building
      ? `${building.lane ? building.lane + '弄' : ''}${building.buildingNo}号`
      : '';
    const text = [
      community?.name,
      `${buildingText}${house.roomNo ? house.roomNo + '室' : ''}`,
    ]
      .filter(Boolean)
      .join(' ');
    return text || null;
  }

  /**
   * 时间轴备注是直接给业主看的。存量数据里「创建」这一条曾把来源枚举原样写进去
   * （表现为进度里冒出一行 owner_miniapp），读取时翻成中文，不用改历史数据。
   */
  private displayLogNote(note?: string | null): string | null {
    if (!note) return note ?? null;
    let text = note;
    for (const [code, label] of Object.entries(REPAIR_SOURCE_LABELS)) {
      if (text === code) return label;
      if (text.startsWith(`${code};`)) {
        text = `${label}${text.slice(code.length + 1)}`;
        break;
      }
    }
    return text;
  }

  async assignWorkOrder(
    id: number,
    dto: AssignWorkOrderDto,
    user: AuthUser,
    access?: ResolvedAccess,
  ) {
    const tenantId = this.resolveTenantId(user);
    const scope = this.scopeIds(access);
    if (scope) {
      const target = await this.workOrderRepo.findOne({
        where: { id, tenantId },
        select: ['id', 'communityId'],
      });
      if (!target || !scope.includes(target.communityId)) {
        throw new NotFoundException('work order not found');
      }
    }
    const assignee = await this.userRepo.findOne({
      where: { id: dto.assigneeId, tenantId },
    });
    if (!assignee || assignee.status !== UserStatus.ACTIVE) {
      throw new NotFoundException('assignee not found');
    }
    if (assignee.role !== UserRole.TECHNICIAN) {
      throw new BadRequestException('assignee must be technician');
    }

    const saved = await this.dataSource.transaction(async (manager) => {
      const workOrder = await this.lockWorkOrder(manager, id, tenantId);
      const fromStatus = workOrder.status;
      assertWorkOrderTransition(
        fromStatus,
        WorkOrderStatus.DISPATCHED,
        'assign',
        'work order cannot be assigned',
      );

      workOrder.assigneeId = dto.assigneeId;
      workOrder.skill = dto.skill ?? workOrder.skill;
      workOrder.status = WorkOrderStatus.DISPATCHED;
      workOrder.dispatchedAt = new Date();
      workOrder.slaDueAt = dto.slaHours
        ? new Date(Date.now() + dto.slaHours * 60 * 60 * 1000)
        : workOrder.slaDueAt;
      workOrder.updatedBy = user.id;
      const saved = await manager.save(WorkOrder, workOrder);
      await this.writeLog(manager, saved, fromStatus, 'assign', user.id, dto.note);
      return saved;
    });

    await this.notifyOwnerOnStatus(saved, 'dispatched', assignee?.name ?? null);
    // 派单不通知维修工，那这单就得等他自己想起来打开小程序看一眼 ——
    // 「已派单」堆在那儿没人动，办公室还以为派出去就完事了
    await this.notifyAssigneeOnDispatch(saved, dto.note ?? null);
    return saved;
  }

  async acceptWorkOrder(id: number, user: AuthUser) {
    const tenantId = this.resolveTenantId(user);
    return this.dataSource.transaction(async (manager) => {
      const workOrder = await this.lockWorkOrder(manager, id, tenantId);
      // 工单池抢单：未指派的工单允许维修工自行认领（行锁保证只会有一个人抢到）
      const isClaim = workOrder.assigneeId === null;
      if (isClaim) {
        assertWorkOrderTransition(
          workOrder.status,
          WorkOrderStatus.IN_PROGRESS,
          'claim',
          'work order cannot be claimed',
        );
        if (user.role !== UserRole.TECHNICIAN) {
          throw new ForbiddenException('only technician can claim work order from pool');
        }
        workOrder.assigneeId = user.id;
        workOrder.dispatchedAt = workOrder.dispatchedAt ?? new Date();
      } else {
        assertWorkOrderTransition(
          workOrder.status,
          WorkOrderStatus.IN_PROGRESS,
          'accept',
          'only dispatched work order can be accepted',
        );
        if (user.role === UserRole.TECHNICIAN && workOrder.assigneeId !== user.id) {
          throw new ForbiddenException('work order is not assigned to current user');
        }
      }

      const fromStatus = workOrder.status;
      workOrder.status = WorkOrderStatus.IN_PROGRESS;
      workOrder.acceptedAt = new Date();
      workOrder.updatedBy = user.id;
      const saved = await manager.save(WorkOrder, workOrder);
      await this.writeLog(
        manager,
        saved,
        fromStatus,
        isClaim ? 'claim' : 'accept',
        user.id,
        isClaim
          ? fromStatus === WorkOrderStatus.WAITING_MATERIAL
            ? '维修工从工单池接回（缺料单）'
            : '维修工从工单池认领'
          : null,
      );
      return saved;
    });
  }

  async completeWorkOrder(id: number, dto: CompleteWorkOrderDto, user: AuthUser) {
    const tenantId = this.resolveTenantId(user);
    const saved = await this.dataSource.transaction(async (manager) => {
      const workOrder = await this.lockWorkOrder(manager, id, tenantId);
      assertWorkOrderTransition(
        workOrder.status,
        WorkOrderStatus.DONE_PENDING_REVIEW,
        'complete',
        'work order cannot be completed',
      );
      this.ensureAssigneeOrAdmin(workOrder, user);

      const fromStatus = workOrder.status;
      workOrder.status = WorkOrderStatus.DONE_PENDING_REVIEW;
      workOrder.completedAt = new Date();
      workOrder.actionTags = dto.actionTags ?? workOrder.actionTags;
      workOrder.actionNote = dto.actionNote ?? workOrder.actionNote;
      workOrder.faultLocation = dto.faultLocation ?? workOrder.faultLocation;
      workOrder.faultSymptom = dto.faultSymptom ?? workOrder.faultSymptom;
      workOrder.repairContent = dto.repairContent ?? workOrder.repairContent;
      workOrder.usedMaterials =
        dto.materials?.map((item) => ({
          materialId: item.materialId,
          name: item.name || (item.materialId ? `#${item.materialId}` : ''),
          qty: item.qty,
          unit: item.unit,
        })).filter((item) => item.name || item.materialId) ?? workOrder.usedMaterials;
      workOrder.resultAttachments =
        dto.resultAttachments ?? workOrder.resultAttachments;
      workOrder.feeCents = dto.feeCents ?? workOrder.feeCents;
      workOrder.updatedBy = user.id;
      const saved = await manager.save(WorkOrder, workOrder);

      const inventoryMaterials = dto.materials?.filter((item) => item.materialId && item.warehouseId) ?? [];
      if (inventoryMaterials.length) {
        const existingRows = await manager.find(WorkOrderMaterial, {
          where: { tenantId, workOrderId: saved.id },
        });
        if (existingRows.length) {
          await manager.delete(WorkOrderMaterialAllocation, {
            tenantId,
            workOrderMaterialId: In(existingRows.map((row) => row.id)),
          });
        }
        await manager.delete(WorkOrderMaterial, {
          tenantId,
          workOrderId: saved.id,
        });
        for (const item of inventoryMaterials) {
          const allocations = await this.consumeStockLots(manager, {
            tenantId,
            warehouseId: item.warehouseId!,
            materialId: item.materialId!,
            qty: item.qty,
            operatorId: user.id,
          });
          const totalCostCents = allocations.reduce((sum, allocation) => sum + allocation.amountCents, 0);
          const materialUsage = await manager.save(
            WorkOrderMaterial,
            manager.create(WorkOrderMaterial, {
              tenantId,
              workOrderId: saved.id,
              materialId: item.materialId!,
              warehouseId: item.warehouseId!,
              qty: item.qty,
              unitCostCents: this.averageUnitCost(allocations, item.qty),
              totalCostCents,
              createdBy: user.id,
              updatedBy: user.id,
            }),
          );
          await manager.save(
            WorkOrderMaterialAllocation,
            allocations.map((allocation) =>
              manager.create(WorkOrderMaterialAllocation, {
                tenantId,
                workOrderMaterialId: materialUsage.id,
                stockLotId: allocation.stockLotId,
                qty: allocation.qty,
                unitCostCents: allocation.unitCostCents,
                amountCents: allocation.amountCents,
                createdBy: user.id,
                updatedBy: user.id,
              }),
            ),
          );
          await this.applyStockDelta(manager, {
            tenantId,
            warehouseId: item.warehouseId!,
            materialId: item.materialId!,
            deltaQty: -item.qty,
            type: StockMovementType.OUTBOUND,
            unitCostCents: this.averageUnitCost(allocations, item.qty),
            refType: 'work_order',
            refId: saved.id,
            operatorId: user.id,
            note: `complete work order ${saved.id}`,
          });
        }
      }

      await this.writeLog(
        manager,
        saved,
        fromStatus,
        'complete',
        user.id,
        dto.actionNote ?? null,
      );
      return saved;
    });

    await this.notifyOwnerOnStatus(saved, 'review');
    return saved;
  }

  /**
   * 缺料登记：工单转「等待材料」并退回工单池，同时生成采购申请进审批流。
   *
   * 退回池子（assigneeId 置空）是有意的：材料短则半天长则一周，人不能被这张单挂着 ——
   * 「我的工单」里只留真正在手上能干的活。材料到货后办公室重新派单，
   * 或者哪个维修工顺路就自己从池子里接回去（见 acceptWorkOrder 的 isClaim 分支）。
   */
  async markNeedMaterial(id: number, dto: NeedMaterialDto, user: AuthUser) {
    const missingMaterials = this.normalizeMissingMaterials(dto.missingMaterials);
    const tenantId = this.resolveTenantId(user);
    return this.dataSource.transaction(async (manager) => {
      const workOrder = await this.lockWorkOrder(manager, id, tenantId);
      assertWorkOrderTransition(
        workOrder.status,
        WorkOrderStatus.WAITING_MATERIAL,
        'need_material',
        'work order cannot wait material',
      );
      this.ensureAssigneeOrAdmin(workOrder, user);

      const fromStatus = workOrder.status;
      workOrder.status = WorkOrderStatus.WAITING_MATERIAL;
      workOrder.missingMaterials = missingMaterials;
      workOrder.assigneeId = null;
      workOrder.acceptedAt = null;
      workOrder.updatedBy = user.id;
      const saved = await manager.save(WorkOrder, workOrder);

      const purchaseRequest = await manager.save(
        PurchaseRequest,
        manager.create(PurchaseRequest, {
          tenantId,
          requestNo: await this.buildPurchaseRequestNo(manager, tenantId, saved.id),
          workOrderId: saved.id,
          applicantId: user.id,
          items: missingMaterials,
          estTotalCents: dto.missingMaterials.reduce(
            (sum, item) => sum + (item.estUnitCostCents ?? 0) * item.qty,
            0,
          ),
          // 维修工报缺料先进入物业办公室汇总合并环节
          status: PurchaseRequestStatus.OFFICE_REVIEW,
          managerId: null,
          managerAt: null,
          purchaserId: null,
          purchaserAt: null,
          rejectReason: null,
          createdBy: user.id,
          updatedBy: user.id,
        }),
      );

      // 通知物业办公室有新的缺料申请待汇总
      const officeUsers = await manager.find(User, {
        where: { tenantId, role: In([UserRole.OFFICE, UserRole.ADMIN]), status: UserStatus.ACTIVE },
        select: ['id'],
      });
      if (officeUsers.length) {
        await manager.save(
          Notification,
          officeUsers.map((receiver) =>
            manager.create(Notification, {
              tenantId,
              receiverId: receiver.id,
              channel: NotifyChannel.IN_APP,
              eventKey: 'purchase_pending_office',
              title: `工单 ${saved.orderNo} 缺料申请待汇总（${purchaseRequest.requestNo}）`,
              payload: { purchaseRequestId: purchaseRequest.id, requestNo: purchaseRequest.requestNo },
              status: NotifyStatus.SENT,
              readAt: null,
              createdBy: user.id,
              updatedBy: user.id,
            }),
          ),
        );
      }

      // 时间轴上业主和办公室都要看得出「缺什么、退回池子了」，光写状态名等于没说
      const summary = this.summarizeMissingMaterials(missingMaterials);
      await this.writeLog(
        manager,
        saved,
        fromStatus,
        'need_material',
        user.id,
        [`缺料：${summary}`, dto.note?.trim(), '已退回工单池，材料到位后重新派单']
          .filter(Boolean)
          .join('；'),
      );
      return { workOrder: saved, purchaseRequest };
    });
  }

  /**
   * 办公室补建 SKU 后回来更正缺料清单：改工单快照，并同步还没进审批的那张采购申请。
   * 已经报到经理/采购那边的申请不动 —— 审批看到的和批的必须是同一份东西。
   */
  async updateMissingMaterials(
    id: number,
    dto: UpdateMissingMaterialsDto,
    user: AuthUser,
  ) {
    const missingMaterials = this.normalizeMissingMaterials(dto.missingMaterials);
    const tenantId = this.resolveTenantId(user);
    return this.dataSource.transaction(async (manager) => {
      const workOrder = await this.lockWorkOrder(manager, id, tenantId);
      if (workOrder.status !== WorkOrderStatus.WAITING_MATERIAL) {
        throw new BadRequestException('work order is not waiting material');
      }

      workOrder.missingMaterials = missingMaterials;
      workOrder.updatedBy = user.id;
      const saved = await manager.save(WorkOrder, workOrder);

      const purchaseRequest = await manager.findOne(PurchaseRequest, {
        where: {
          tenantId,
          workOrderId: saved.id,
          status: In([PurchaseRequestStatus.DRAFT, PurchaseRequestStatus.OFFICE_REVIEW]),
        },
        order: { id: 'DESC' },
      });
      if (purchaseRequest) {
        purchaseRequest.items = missingMaterials;
        purchaseRequest.updatedBy = user.id;
        await manager.save(PurchaseRequest, purchaseRequest);
      }

      await this.writeLog(
        manager,
        saved,
        saved.status,
        'update_missing_materials',
        user.id,
        [
          `缺料清单更正为：${this.summarizeMissingMaterials(missingMaterials)}`,
          dto.note?.trim(),
          purchaseRequest ? null : '关联采购申请已进入审批，本次只更新工单记录',
        ]
          .filter(Boolean)
          .join('；'),
      );
      return { workOrder: saved, purchaseRequest };
    });
  }

  /** 缺料明细统一整形：去空行、名称去空格、数量转数字，落库的永远是干净数据 */
  private normalizeMissingMaterials(
    rows: Array<{ materialId?: number; name: string; qty: number; unit?: string; estUnitCostCents?: number }>,
  ) {
    const normalized = (rows || [])
      .map((item) => ({
        materialId: item.materialId ?? undefined,
        name: String(item.name ?? '').trim(),
        qty: Number(item.qty),
        unit: item.unit?.trim() || undefined,
      }))
      .filter((item) => item.name && Number.isFinite(item.qty) && item.qty > 0);
    if (!normalized.length) {
      throw new BadRequestException('missingMaterials is required');
    }
    return normalized;
  }

  private summarizeMissingMaterials(
    rows: Array<{ name: string; qty: number; unit?: string }>,
  ): string {
    return rows.map((item) => `${item.name} ×${item.qty}${item.unit || ''}`).join('、');
  }

  async reviewWorkOrder(id: number, dto: ReviewWorkOrderDto, user: AuthUser) {
    const tenantId = this.resolveTenantId(user);
    return this.dataSource.transaction(async (manager) => {
      const workOrder = await this.lockWorkOrder(manager, id, tenantId);
      assertWorkOrderTransition(
        workOrder.status,
        WorkOrderStatus.COMPLETED,
        'review',
        'work order is not pending review',
      );

      const request = await manager.findOne(RepairRequest, {
        where: { id: workOrder.requestId, tenantId },
      });
      if (!request) throw new NotFoundException('repair request not found');
      if (
        SELF_SCOPED_ROLES.includes(user.role as UserRole) &&
        request.submittedBy !== user.id
      ) {
        throw new ForbiddenException('只能验收自己提交的报修');
      }

      const review = await manager.save(
        Review,
        manager.create(Review, {
          tenantId,
          workOrderId: workOrder.id,
          ownerId: user.id,
          rating: dto.rating,
          comment: dto.comment ?? null,
          attachments: dto.attachments ?? [],
          autoConfirmed: false,
          createdBy: user.id,
          updatedBy: user.id,
        }),
      );

      const fromStatus = workOrder.status;
      workOrder.status = WorkOrderStatus.COMPLETED;
      workOrder.updatedBy = user.id;
      const saved = await manager.save(WorkOrder, workOrder);
      await this.writeLog(manager, saved, fromStatus, 'review', user.id, null);
      return { workOrder: saved, review };
    });
  }

  /** 撤单：业主（限本人提交）与后台均可，需选择原因 */
  async cancelWorkOrder(id: number, dto: CancelWorkOrderDto, user: AuthUser) {
    const reasonLabel = CANCEL_REASONS[dto.reasonCode];
    if (!reasonLabel) throw new BadRequestException('invalid cancel reason');
    if (dto.reasonCode === 'other' && !dto.note?.trim()) {
      throw new BadRequestException('请填写撤单原因');
    }
    const tenantId = this.resolveTenantId(user);
    return this.dataSource.transaction(async (manager) => {
      const workOrder = await this.lockWorkOrder(manager, id, tenantId);
      assertWorkOrderTransition(
        workOrder.status,
        WorkOrderStatus.CANCELLED,
        'cancel',
        '当前状态不可撤单',
      );
      if (SELF_SCOPED_ROLES.includes(user.role as UserRole)) {
        const request = await manager.findOne(RepairRequest, {
          where: { id: workOrder.requestId, tenantId },
        });
        if (!request || request.submittedBy !== user.id) {
          throw new ForbiddenException('只能撤销自己提交的报修');
        }
      }

      const fromStatus = workOrder.status;
      workOrder.status = WorkOrderStatus.CANCELLED;
      workOrder.updatedBy = user.id;
      const saved = await manager.save(WorkOrder, workOrder);
      const note = dto.note?.trim()
        ? `${reasonLabel}：${dto.note.trim()}`
        : reasonLabel;
      await this.writeLog(manager, saved, fromStatus, 'cancel', user.id, note);
      return saved;
    });
  }

  /**
   * 催单：工单超 24 小时未响应（未接单）时可催。
   * 第 1 次通知物业办公室，第 2 次升级通知物业经理，最多 2 次。
   */
  async urgeWorkOrder(id: number, user: AuthUser) {
    const tenantId = this.resolveTenantId(user);
    return this.dataSource.transaction(async (manager) => {
      const workOrder = await this.lockWorkOrder(manager, id, tenantId);
      if (
        ![WorkOrderStatus.CREATED, WorkOrderStatus.DISPATCHED].includes(workOrder.status)
      ) {
        throw new BadRequestException('工单已在处理中，无需催单');
      }
      if (SELF_SCOPED_ROLES.includes(user.role as UserRole)) {
        const request = await manager.findOne(RepairRequest, {
          where: { id: workOrder.requestId, tenantId },
        });
        if (!request || request.submittedBy !== user.id) {
          throw new ForbiddenException('只能催办自己提交的报修');
        }
      }
      const ageMs = Date.now() - new Date(workOrder.createdAt).getTime();
      if (ageMs < 24 * 60 * 60 * 1000) {
        throw new BadRequestException('工单提交未满 24 小时，暂不可催单');
      }

      const urgeCount = await manager.count(WorkOrderLog, {
        where: { tenantId, workOrderId: workOrder.id, action: In(['urge_office', 'urge_manager']) },
      });
      if (urgeCount >= 2) {
        throw new BadRequestException('该工单已催办 2 次，物业经理已介入');
      }

      const isFirst = urgeCount === 0;
      const targetRoles = isFirst
        ? [UserRole.OFFICE, UserRole.ADMIN]
        : [UserRole.MANAGER, UserRole.ADMIN];
      const receivers = await manager.find(User, {
        where: { tenantId, role: In(targetRoles), status: UserStatus.ACTIVE },
        select: ['id'],
      });
      if (receivers.length) {
        await manager.save(
          Notification,
          receivers.map((receiver) =>
            manager.create(Notification, {
              tenantId,
              receiverId: receiver.id,
              channel: NotifyChannel.IN_APP,
              eventKey: isFirst ? 'order_urged' : 'order_urged_escalated',
              title: isFirst
                ? `工单 ${workOrder.orderNo} 业主催办，请尽快安排`
                : `工单 ${workOrder.orderNo} 第 2 次催办，请经理关注`,
              payload: { workOrderId: workOrder.id, orderNo: workOrder.orderNo },
              status: NotifyStatus.SENT,
              readAt: null,
              createdBy: user.id,
              updatedBy: user.id,
            }),
          ),
        );
      }

      await this.writeLog(
        manager,
        workOrder,
        workOrder.status,
        isFirst ? 'urge_office' : 'urge_manager',
        user.id,
        isFirst ? '业主催单，已提醒物业办公室' : '业主第 2 次催单，已升级提醒物业经理',
      );
      return { ok: true, urgeCount: urgeCount + 1, escalated: !isFirst };
    });
  }

  /**
   * 补齐联系人/联系电话。
   *
   * 端上这两项都是选填（随手拍连问都不问），但办公室派单、维修工上门前都要打电话，
   * 空着等于这单没法处理 —— 所以在服务端按下面的顺序兜底，而不是指望每个入口自己填：
   *   1. 表单里填的（业主特意留的号最准，比如让家里老人接）
   *   2. 提交人自己的账号 —— 只在提交人就是现场那个人时用
   *   3. 报修房屋绑定的业主账号
   *
   * 第 2 步对后台代报必须跳过：那时提交人是物业员工，回落过去等于把员工的手机号
   * 当成业主联系方式发给维修工，既找不到人也泄露了员工的号。
   *
   * 第 3 步对保安/居委会/业委会代报要跳过：他们本人就是要联系的人（在现场、知道情况），
   * 再回落到住户会出现「联系人写着住户的名字、身份标着保安」这种自相矛盾的单子。
   */
  private async resolveContact(
    input: { contactName?: string | null; contactPhone?: string | null; houseId?: number | null },
    tenantId: number,
    submittedBy: number | null,
    opts: { submitterIsContact: boolean; allowHouseOwnerFallback: boolean },
  ): Promise<{ name: string | null; phone: string | null }> {
    let name = input.contactName?.trim() || null;
    let phone = input.contactPhone?.trim() || null;
    if (name && phone) return { name, phone };

    if (submittedBy && opts.submitterIsContact) {
      const submitter = await this.dataSource.getRepository(User).findOne({
        where: { id: submittedBy },
        select: ['id', 'name', 'phone', 'wxNickname'],
      });
      name = name || submitter?.name || submitter?.wxNickname || null;
      phone = phone || submitter?.phone || null;
    }
    if (name && phone) return { name, phone };

    if (input.houseId && opts.allowHouseOwnerFallback) {
      const owner = await this.dataSource.getRepository(User).findOne({
        where: {
          tenantId,
          houseId: input.houseId,
          role: UserRole.OWNER,
          status: UserStatus.ACTIVE,
        },
        select: ['id', 'name', 'phone'],
      });
      name = name || owner?.name || null;
      phone = phone || owner?.phone || null;
    }
    return { name, phone };
  }

  /**
   * 状态变了通知业主。
   *
   * 特意放在事务**之外**：写库和推微信是两码事，微信接口有几百毫秒往返，
   * 塞进事务里会白白拉长行锁持有时间，派单高峰互相阻塞；
   * 而且推送失败也不该把已经成功的派单回滚掉。
   *
   * notifyOwner 内部自己吞异常，这里不用再包 try。
   */
  private async notifyOwnerOnStatus(
    workOrder: WorkOrder,
    kind: 'dispatched' | 'review',
    assigneeName?: string | null,
  ): Promise<void> {
    const request = await this.repairRequestRepo.findOne({
      where: { id: workOrder.requestId, tenantId: workOrder.tenantId },
    });
    // 办公室代录的单没有提交人，没人可通知
    if (!request?.submittedBy) return;

    // 类型名取租户自己配的那套，不用内置字典 —— 物业改了「水相关」叫法，通知里也要跟着变
    const rule = request.repairType
      ? await this.repairTypeRuleRepo.findOne({
          where: { tenantId: workOrder.tenantId, repairType: request.repairType },
        })
      : null;
    const typeLabel = rule?.label || '报修';
    const page = `pages/order-detail/order-detail?id=${workOrder.id}`;
    const when = this.formatWhen(new Date());

    if (kind === 'dispatched') {
      await this.notifications.notifyUser({
        tenantId: workOrder.tenantId,
        receiverId: request.submittedBy,
        eventKey: 'order_dispatched',
        title: `${typeLabel}已派单，维修工${assigneeName ? ` ${assigneeName}` : ''}会尽快联系你`,
        payload: { workOrderId: workOrder.id, orderNo: workOrder.orderNo },
        page,
        template: 'orderDispatched',
        templateData: {
          character_string1: workOrder.orderNo,
          thing2: typeLabel,
          thing3: assigneeName || '物业维修工',
          time4: when,
        },
      });
      return;
    }

    await this.notifications.notifyUser({
      tenantId: workOrder.tenantId,
      receiverId: request.submittedBy,
      eventKey: 'order_review',
      title: `${typeLabel}已修好，请进小程序确认验收`,
      payload: { workOrderId: workOrder.id, orderNo: workOrder.orderNo },
      page,
      template: 'orderReview',
      templateData: {
        character_string1: workOrder.orderNo,
        thing2: typeLabel,
        time3: when,
      },
    });
  }

  /**
   * 通知被派单的维修工：站内信一定写，微信订阅消息尽力而为。
   *
   * 为什么单独一个方法而不是塞进 notifyOwnerOnStatus：收件人不同（维修工 vs 业主）、
   * 模板不同（员工端小程序有自己的模板 id）、落地页也不同。两件事混在一起，
   * 以后改业主文案很容易顺手把维修工那条也改了。
   *
   * 通知里必须带上地址和故障描述：只写「你有一张新工单」等于没说，
   * 人还得点进去才知道要不要现在去。
   */
  private async notifyAssigneeOnDispatch(
    workOrder: WorkOrder,
    note: string | null,
  ): Promise<void> {
    if (!workOrder.assigneeId) return;
    const request = await this.repairRequestRepo.findOne({
      where: { id: workOrder.requestId, tenantId: workOrder.tenantId },
    });
    const rule = request?.repairType
      ? await this.repairTypeRuleRepo.findOne({
          where: { tenantId: workOrder.tenantId, repairType: request.repairType },
        })
      : null;
    const typeLabel = rule?.label || '报修';
    const address = request?.addressText?.trim() || '（未填地址）';
    const content = request?.content?.trim() || '';
    // 标题里用短日期：站内信列表一行放不下「2026年8月26日 18:00」，
    // 一条消息折成三行，扫一眼看不出是哪一单
    const deadline = workOrder.slaDueAt
      ? `，${this.formatWhenShort(new Date(workOrder.slaDueAt))} 前完成`
      : '';

    await this.notifications.notifyUser({
      tenantId: workOrder.tenantId,
      receiverId: workOrder.assigneeId,
      eventKey: 'order_assigned',
      title: `新工单：${typeLabel} · ${address}${deadline}`,
      payload: {
        workOrderId: workOrder.id,
        orderNo: workOrder.orderNo,
        note,
        content,
      },
      // 员工端的详情页路径，和业主端同名但不是同一个小程序
      page: `pages/order-detail/order-detail?id=${workOrder.id}`,
      template: 'orderAssigned',
      templateData: {
        character_string1: workOrder.orderNo,
        thing2: typeLabel,
        thing3: address,
        time4: this.formatWhen(new Date()),
      },
    });
  }

  /** 列表标题里的短日期：「8月26日 18:00」，年份靠上下文 */
  private formatWhenShort(d: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  /** 订阅消息里的时间字段微信要求「2026年8月9日 17:07」这种可读格式 */
  private formatWhen(d: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  private async createRepairAndWorkOrder(
    dto: CreateRepairRequestDto,
    tenantId: number,
    source: RepairSource,
    submittedBy: number | null,
    /** 代报角色编码；业主本人或物业录入时为 null */
    reporterRole: string | null,
  ) {
    await this.validateLocation(dto, tenantId);
    // 端上判不出类型（或压根是老版本没判）时服务端再判一次，
    // 判不出才落「其它」——类型是自动派单的依据，空着等于这单没人认领
    const repairType =
      dto.repairType || (await this.guessRepairType(dto.content, tenantId)) || undefined;
    const assignRule = await this.findAutoAssignRule(repairType, tenantId);
    const sourceLabel = REPAIR_SOURCE_LABELS[source] ?? source;
    // 联系人/电话在端上都是选填（随手拍压根不问），不在服务端兜底的话
    // 后台工单详情就是两个「-」，办公室拿到单子找不到人
    const contact = await this.resolveContact(dto, tenantId, submittedBy, {
      // 两个小程序提交的联系人都默认是提交人本人；办公室录入才另填
      submitterIsContact: source !== RepairSource.OFFICE_WEB,
      allowHouseOwnerFallback: !reporterRole,
    });

    const created = await this.dataSource.transaction(async (manager) => {
      const request = await manager.save(
        RepairRequest,
        manager.create(RepairRequest, {
          tenantId,
          source,
          communityId: dto.communityId,
          buildingId: dto.buildingId ?? null,
          houseId: dto.houseId ?? null,
          addressText: dto.addressText ?? null,
          contactName: contact.name,
          contactPhone: contact.phone,
          reporterRole,
          repairType: repairType ?? null,
          content: dto.content,
          attachments: dto.attachments ?? [],
          submittedBy,
          createdBy: submittedBy,
          updatedBy: submittedBy,
        }),
      );

      const workOrder = await manager.save(
        WorkOrder,
        manager.create(WorkOrder, {
          tenantId,
          orderNo: await this.nextOrderNo(manager),
          requestId: request.id,
          communityId: dto.communityId,
          assigneeId: assignRule?.assigneeId ?? null,
          skill: repairType ?? null,
          status: assignRule ? WorkOrderStatus.DISPATCHED : WorkOrderStatus.CREATED,
          dispatchedAt: assignRule ? new Date() : null,
          acceptedAt: null,
          completedAt: null,
          // 办公室录入时明确勾了截止时间就用它；没勾才落到类型规则里的默认时限。
          // 截止时间是内部管理承诺，业主端提交的这个字段不认
          slaDueAt:
            dto.slaDueAt && source !== RepairSource.OWNER_MINIAPP
              ? new Date(dto.slaDueAt)
              : assignRule?.slaHours
                ? new Date(Date.now() + assignRule.slaHours * 60 * 60 * 1000)
                : null,
          actionTags: [],
          actionNote: null,
          faultLocation: null,
          faultSymptom: null,
          repairContent: null,
          usedMaterials: [],
          resultAttachments: [],
          feeCents: 0,
          missingMaterials: [],
          createdBy: submittedBy,
          updatedBy: submittedBy,
        }),
      );

      await manager.save(
        WorkOrderLog,
        manager.create(WorkOrderLog, {
          tenantId,
          workOrderId: workOrder.id,
          fromStatus: null,
          toStatus: workOrder.status,
          action: assignRule ? 'create_auto_assign' : 'create',
          operatorId: submittedBy,
          // 业主在小程序进度里能看到这一条，写中文，别把枚举值透出去
          note: assignRule
            ? `${sourceLabel}；按报修类型自动派单给维修工 #${assignRule.assigneeId}`
            : sourceLabel,
          createdBy: submittedBy,
          updatedBy: submittedBy,
        }),
      );

      return { request, workOrder };
    });

    // 端上判了一个类型、人当场改成了别的 —— 判错了的最直接证据。
    //
    // 特意放在事务**外面**并吞掉异常：这只是给判定攒经验的信号，
    // 记不上顶多是下次判得没那么准，绝不能因为它让业主的报修提交失败。
    // 只记录、不自动改关键词：报修的人只是顺手改个下拉框，没打算给系统当老师，
    // 拿一次手滑去改配置容易把整个类型带偏。攒够次数后由 listPublicRepairTypes
    // 给误判的词降权，后台也能对着这张表把词收编成正式关键词。
    const predicted = dto.predictedRepairType?.trim();
    if (predicted && repairType && predicted !== repairType) {
      try {
        await this.dataSource.getRepository(RepairTypeCorrection).save({
          tenantId,
          workOrderId: created.workOrder.id,
          requestId: created.request.id,
          fromType: predicted,
          toType: repairType,
          content: dto.content,
          learnedKeywords: [],
          createdBy: submittedBy,
          updatedBy: submittedBy,
        });
      } catch (error) {
        this.logger.warn(
          `报修类型负样本记录失败（不影响报修）：${error instanceof Error ? error.message : error}`,
        );
      }
    }

    // 「这个电话 → 这个人 → 这个房号」记进业主档案。
    // 和上面的类型负样本一样放在事务外、吞掉异常：这是顺手攒的资料，
    // 绝不能因为它让报修提交失败。
    await this.rememberContactAsOwner(dto, tenantId, source, submittedBy);

    // 按报修类型规则自动派出去的单，也要通知那位维修工 ——
    // 派单有两个入口（办公室手动派 / 类型规则自动派），只在一个入口发通知，
    // 自动派的那批就成了「系统悄悄塞给你、你永远不知道」
    if (created.workOrder.assigneeId) {
      await this.notifyAssigneeOnDispatch(created.workOrder, '按报修类型自动派单');
    }

    return created;
  }

  /**
   * 员工报修时报出来的联系人，顺手落一条业主档案（来源标记「报修登记」）。
   *
   * 为什么值得做：维修工在现场说一句「一期17号201，张先生，13800138000」，
   * 这三样凑齐就是一条业主资料。不记的话，下次同一户报修还得再问一遍。
   *
   * 四条约束，少一条都会把档案搞脏：
   * 1. 只认端上**明确传上来的** contactName/contactPhone —— resolveContact 会
   *    把提交人自己兜底成联系人，那是维修工不是业主，记进去就全是自己人；
   * 2. 业主自己报的不记：他的档案本来就该由认证流程建，来源不能被覆盖成「报修登记」；
   * 3. 已有档案只补空字段，不覆盖已填的（尤其不改房号）—— 一个手机号可能有多套房，
   *    也可能后台已经核实过，自动流程不跟人抢方向盘；
   * 4. 房号已经绑了别的业主就不动，避免一次口误把人家的房子改姓。
   */
  private async rememberContactAsOwner(
    dto: CreateRepairRequestDto,
    tenantId: number,
    source: RepairSource,
    submittedBy: number | null,
  ) {
    if (source === RepairSource.OWNER_MINIAPP) return;

    const name = dto.contactName?.trim();
    const phone = dto.contactPhone?.trim();
    if (!name || !phone) return;

    try {
      // 提交人自己的手机号：维修工把自己填成联系人了，不是业主
      if (submittedBy) {
        const me = await this.userRepo.findOne({
          where: { id: submittedBy },
          select: ['id', 'phone'],
        });
        if (me?.phone && me.phone === phone) return;
      }

      const houseId = dto.houseId ?? null;
      const existing = await this.userRepo.findOne({
        where: { tenantId, phone, role: UserRole.OWNER },
      });

      if (existing) {
        const patch: Partial<User> = {};
        if (!existing.name && name) patch.name = name;
        // 只在这条档案还没绑房号时补，绝不改已绑的
        if (!existing.houseId && houseId && (await this.isHouseFree(tenantId, houseId))) {
          patch.houseId = houseId;
        }
        if (Object.keys(patch).length) {
          await this.userRepo.update(existing.id, { ...patch, updatedBy: submittedBy });
        }
        return;
      }

      await this.userRepo.save(
        this.userRepo.create({
          tenantId,
          name,
          phone,
          role: UserRole.OWNER,
          houseId: houseId && (await this.isHouseFree(tenantId, houseId)) ? houseId : null,
          status: UserStatus.ACTIVE,
          source: OwnerSource.REPAIR_INTAKE,
          createdBy: submittedBy,
          updatedBy: submittedBy,
        }),
      );
    } catch (error) {
      this.logger.warn(
        `业主档案自动登记失败（不影响报修）：${error instanceof Error ? error.message : error}`,
      );
    }
  }

  /** 这个房号还没有业主绑着 */
  private async isHouseFree(tenantId: number, houseId: number): Promise<boolean> {
    const taken = await this.userRepo.findOne({
      where: { tenantId, houseId, role: UserRole.OWNER },
      select: ['id'],
    });
    return !taken;
  }

  /** 供定时任务调用：全租户扫描超时待验收工单并自动完成，返回处理数量 */
  async autoCompleteExpiredReviewsAllTenants(): Promise<number> {
    const pending = await this.workOrderRepo.find({
      where: { status: WorkOrderStatus.DONE_PENDING_REVIEW },
      select: ['id', 'tenantId', 'status', 'completedAt'],
    });
    if (!pending.length) return 0;

    const tenantIds = [...new Set(pending.map((item) => item.tenantId))];
    const hoursByTenant = new Map(
      await Promise.all(
        tenantIds.map(async (tenantId) => [
          tenantId,
          await this.settings.getAutoReviewHoursByTenant(tenantId),
        ] as const),
      ),
    );
    const now = Date.now();
    const targets = pending
      .filter((item) => {
        if (!item.completedAt) return false;
        const hours = hoursByTenant.get(item.tenantId)!;
        return item.completedAt.getTime() <= now - hours * 60 * 60 * 1000;
      })
      .map((item) => ({
        id: item.id,
        tenantId: item.tenantId,
        autoReviewHours: hoursByTenant.get(item.tenantId)!,
      }));
    if (!targets.length) return 0;
    return this.completeExpiredTargets(targets);
  }

  private async autoCompleteExpiredReviews(tenantId: number) {
    const autoReviewHours = await this.settings.getAutoReviewHoursByTenant(tenantId);
    const cutoff = new Date(Date.now() - autoReviewHours * 60 * 60 * 1000);
    const expired = await this.workOrderRepo.find({
      where: { tenantId, status: WorkOrderStatus.DONE_PENDING_REVIEW },
      select: ['id', 'tenantId', 'status', 'completedAt'],
    });
    const targets = expired
      .filter((item) => item.completedAt && item.completedAt <= cutoff)
      .map((item) => ({ id: item.id, tenantId, autoReviewHours }));
    if (!targets.length) return;
    await this.completeExpiredTargets(targets);
  }

  private async completeExpiredTargets(
    targets: Array<Pick<WorkOrder, 'id' | 'tenantId'> & { autoReviewHours: number }>,
  ): Promise<number> {
    return this.dataSource.transaction(async (manager) => {
      let completedCount = 0;
      for (const workOrder of targets) {
        const current = await manager.findOne(WorkOrder, {
          where: { id: workOrder.id, tenantId: workOrder.tenantId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!current || current.status !== WorkOrderStatus.DONE_PENDING_REVIEW) continue;
        const fromStatus = current.status;
        assertWorkOrderTransition(
          fromStatus,
          WorkOrderStatus.COMPLETED,
          'auto_review_complete',
        );
        current.status = WorkOrderStatus.COMPLETED;
        current.updatedBy = null;
        const saved = await manager.save(WorkOrder, current);
        await this.writeLog(
          manager,
          saved,
          fromStatus,
          'auto_review_complete',
          null,
          `待验收超过${workOrder.autoReviewHours}小时，系统自动完成`,
        );
        completedCount += 1;
      }
      return completedCount;
    });
  }

  private async validateLocation(dto: CreateRepairRequestDto, tenantId: number) {
    const community = await this.communityRepo.findOne({
      where: { id: dto.communityId, tenantId, enabled: true },
    });
    if (!community) throw new NotFoundException('community not found');

    if (dto.buildingId) {
      const building = await this.buildingRepo.findOne({
        where: {
          id: dto.buildingId,
          tenantId,
          communityId: dto.communityId,
        },
      });
      if (!building) throw new NotFoundException('building not found');
    }

    if (dto.houseId) {
      const house = await this.houseRepo.findOne({
        where: { id: dto.houseId, tenantId },
      });
      if (!house) throw new NotFoundException('house not found');
    }
  }

  /**
   * 「你有没有权报这个地址」——和「这个地址存不存在」是两回事。
   *
   * 之前只校验了后者，等于任何业主都能给别人家提报修单（工单会挂到那户名下，
   * 维修工上门敲的是别人的门）。加代报角色时必须先把这层补上，
   * 否则新角色的授权范围形同虚设。
   *
   * 规则：
   * - 业主：houseId 只能是自己认证的那套；公共区域（不带 houseId）不限，
   *   扫楼道码替楼里报个灯本来就该允许。
   * - 保安/居委会/业委会：只能报授权小区内的地址，房号不限。
   * - 物业角色走 submitOfficeRepair，租户内不限。
   */
  private async assertCanReportAt(
    dto: CreateRepairRequestDto,
    tenantId: number,
    user: AuthUser,
  ) {
    if (REPORTER_ROLES.includes(user.role as UserRole)) {
      const granted = await this.dataSource.getRepository(UserReportCommunity).findOne({
        where: { tenantId, userId: user.id, communityId: dto.communityId },
      });
      if (!granted) {
        throw new ForbiddenException('没有该小区的代报权限，请联系物业开通');
      }
      return;
    }

    if (user.role !== UserRole.OWNER || !dto.houseId) return;

    const self = await this.userRepo.findOne({
      where: { id: user.id },
      select: ['id', 'houseId'],
    });
    if (self?.houseId !== dto.houseId) {
      throw new ForbiddenException(
        '只能给自己认证的房屋报修；公共区域的问题请把报修位置改成楼栋或小区',
      );
    }
  }

  /**
   * 随手拍：从描述文字里识别报修地址（「侯队报一期24号大门关不上」→ 198弄24号）。
   * 正则抽出「期/弄/号/室」候选（repair-address.util），再撞本租户真实存在的
   * 分期/楼栋/房号 —— 撞上才算识别到，撞不上宁可返回没识别，绝不猜。
   * 识别结果在端上明示并可一键撤掉，提交时关联 id 跟着识别结果走。
   */
  async parseRepairAddress(dto: ParseRepairAddressDto, user: AuthUser) {
    const tenantId = this.resolveTenantId(user);
    const candidate = extractAddressCandidate(dto.text);
    if (!candidate) return { matched: false as const };

    const communities = await this.communityRepo.find({
      where: { tenantId, enabled: true },
    });
    const parentIds = new Set(
      communities.map((c) => c.parentId).filter((id): id is number => !!id),
    );
    // 分组节点（「枫桦景苑」）不挂楼栋，候选只在叶子（分期或独立小区）里找
    const leaves = communities.filter((c) => !parentIds.has(c.id));
    if (!leaves.length) return { matched: false as const };

    const context = dto.communityId
      ? communities.find((c) => c.id === dto.communityId) ?? null
      : null;
    const contextGroupId = context ? context.parentId ?? context.id : null;
    const nameById = new Map(communities.map((c) => [c.id, c.name] as const));

    // 「一期」优先解释成报修人所在分组里的分期；整个租户都没有这个分期时当没说
    let phaseLeaves: Community[] = [];
    if (candidate.phase) {
      phaseLeaves = leaves.filter((c) => {
        const groupName = c.parentId ? nameById.get(c.parentId) ?? '' : '';
        const shortName =
          groupName && c.name.startsWith(groupName)
            ? c.name.slice(groupName.length)
            : c.name;
        return shortName === candidate.phase || c.name.endsWith(candidate.phase!);
      });
    }
    const pool = phaseLeaves.length ? phaseLeaves : leaves;
    const ranked = [...pool].sort((a, b) => {
      const rank = (c: Community) =>
        c.id === context?.id
          ? 0
          : contextGroupId !== null && c.parentId === contextGroupId
            ? 1
            : 2;
      return rank(a) - rank(b) || a.id - b.id;
    });

    // 只说了分期没说楼栋：定位到小区级就够了（「二期大门坏了」）
    if (!candidate.buildingNo) {
      if (!phaseLeaves.length) return { matched: false as const };
      const community = ranked[0];
      return {
        matched: true as const,
        level: 'community' as const,
        communityId: community.id,
        communityName: community.name,
        buildingId: null,
        buildingText: '',
        houseId: null,
        roomNo: null,
        // 没有室号就是公区单，文案里写明白，派单的人一眼看出不是入户维修
        addressText: `${community.name} 公共区域`,
        matchedText: candidate.matchedText,
      };
    }

    const buildings = await this.buildingRepo.find({
      where: { tenantId, communityId: In(ranked.map((c) => c.id)) },
    });
    let picked: Building | null = null;
    let pickedCommunity: Community | null = null;
    for (const community of ranked) {
      let matches = buildings.filter(
        (b) =>
          b.communityId === community.id && sameNo(b.buildingNo, candidate.buildingNo),
      );
      if (candidate.lane) {
        matches = matches.filter((b) => sameNo(b.lane, candidate.lane));
      }
      if (!matches.length) continue;
      if (matches.length > 1) {
        // 同号不同弄且描述里没说弄：取主弄（该小区楼栋最多的弄）；主弄里还不唯一就放弃。
        // 挑错弄会让维修工白跑一栋楼，宁可不填让业主用默认位置。
        const laneCount = new Map<string, number>();
        for (const b of buildings) {
          if (b.communityId !== community.id || !b.lane) continue;
          laneCount.set(b.lane, (laneCount.get(b.lane) ?? 0) + 1);
        }
        const countOf = (b: Building) => laneCount.get(b.lane ?? '') ?? 0;
        matches.sort((a, b) => countOf(b) - countOf(a));
        if (matches.length > 1 && countOf(matches[1]) === countOf(matches[0])) {
          return { matched: false as const };
        }
        matches = [matches[0]];
      }
      picked = matches[0];
      pickedCommunity = community;
      break;
    }
    if (!picked || !pickedCommunity) return { matched: false as const };

    let house: House | null = null;
    if (candidate.roomNo) {
      const houses = await this.houseRepo.find({
        where: { tenantId, buildingId: picked.id },
      });
      house = houses.find((h) => sameNo(h.roomNo, candidate.roomNo)) ?? null;
    }

    // 业主只能把单挂到自己认证的房号上（assertCanReportAt 的同一条口径）。
    // 识别到别人家的室号时降级成楼栋级，但室号保留在地址文本里给师傅看。
    let houseId = house?.id ?? null;
    if (houseId && user.role === UserRole.OWNER) {
      const self = await this.userRepo.findOne({
        where: { id: user.id },
        select: ['id', 'houseId'],
      });
      if (self?.houseId !== houseId) houseId = null;
    }

    const buildingText = `${picked.lane ? picked.lane + '弄' : ''}${picked.buildingNo}号`;
    const roomText = house ? `${house.roomNo}室` : '';
    return {
      matched: true as const,
      level: houseId ? ('house' as const) : ('building' as const),
      communityId: pickedCommunity.id,
      communityName: pickedCommunity.name,
      buildingId: picked.id,
      buildingText,
      houseId,
      roomNo: house?.roomNo ?? null,
      // 门牌连写、段间空格，与 auth.me 的 addressText 同口径：枫桦景苑一期 198弄24号302室。
      // 连楼里哪个位置都没说的按公区单写，派单的人一眼看出不是入户维修
      addressText: [
        pickedCommunity.name,
        roomText ? `${buildingText}${roomText}` : `${buildingText} 公共区域`,
      ]
        .filter(Boolean)
        .join(' '),
      matchedText: candidate.matchedText,
    };
  }

  /**
   * 后台更正工单类型 + 半自动学习。
   * learnKeywords 里的词写进新类型的判定关键词（并从原类型里摘掉，
   * 否则下次两边照旧五五开），同时落一条 RepairTypeCorrection 供复盘和
   * 后续全自动学习攒数据。状态机不动，只在轨迹里记一条。
   */
  async updateWorkOrderRepairType(
    id: number,
    dto: UpdateWorkOrderRepairTypeDto,
    user: AuthUser,
    access?: ResolvedAccess,
  ) {
    const tenantId = this.resolveTenantId(user);
    const workOrder = await this.workOrderRepo.findOne({ where: { id, tenantId } });
    if (!workOrder) throw new NotFoundException('work order not found');
    const scope = this.scopeIds(access);
    if (scope && !scope.includes(workOrder.communityId)) {
      throw new NotFoundException('work order not found');
    }
    const request = await this.repairRequestRepo.findOne({
      where: { id: workOrder.requestId, tenantId },
    });

    const rules = await this.repairTypeRuleRepo.find({ where: { tenantId } });
    const target = rules.find((rule) => rule.repairType === dto.repairType && rule.enabled);
    if (!target) throw new BadRequestException('报修类型不存在或已停用');
    const fromType = request?.repairType ?? workOrder.skill ?? null;
    const fromRule = rules.find((rule) => rule.repairType === fromType) ?? null;
    const learned = normalizeSuggestionList(dto.learnKeywords ?? []).filter(
      (word) => word.length >= 2,
    );
    if (fromType === dto.repairType && !learned.length) {
      throw new BadRequestException('类型没有变化');
    }

    await this.dataSource.transaction(async (manager) => {
      if (request && request.repairType !== dto.repairType) {
        request.repairType = dto.repairType;
        request.updatedBy = user.id;
        await manager.save(RepairRequest, request);
      }
      if (workOrder.skill !== dto.repairType) {
        workOrder.skill = dto.repairType;
        workOrder.updatedBy = user.id;
        await manager.save(WorkOrder, workOrder);
      }
      await this.writeLog(
        manager,
        workOrder,
        null,
        'change_type',
        user.id,
        `报修类型由「${fromRule?.label ?? fromType ?? '未判定'}」更正为「${target.label}」` +
          (learned.length ? `；记住关键词：${learned.join('、')}` : ''),
      );
      if (learned.length) {
        // 学到的词插到最前面：这就是刚被误判的场景，下次要立刻生效
        target.contentSuggestions = normalizeSuggestionList([
          ...learned,
          ...(target.contentSuggestions ?? []),
        ]);
        target.updatedBy = user.id;
        await manager.save(RepairTypeRule, target);
        if (fromRule && fromRule.id !== target.id) {
          const remaining = (fromRule.contentSuggestions ?? []).filter(
            (word) => !learned.includes(word),
          );
          if (remaining.length !== (fromRule.contentSuggestions ?? []).length) {
            fromRule.contentSuggestions = remaining;
            fromRule.updatedBy = user.id;
            await manager.save(RepairTypeRule, fromRule);
          }
        }
      }
      await manager.save(
        RepairTypeCorrection,
        manager.create(RepairTypeCorrection, {
          tenantId,
          workOrderId: workOrder.id,
          requestId: workOrder.requestId,
          fromType,
          toType: dto.repairType,
          content: request?.content ?? '',
          learnedKeywords: learned,
          createdBy: user.id,
          updatedBy: user.id,
        }),
      );
    });
    return { ok: true, learned };
  }

  /**
   * 设定/取消工单的要求完成截止时间（后台详情里勾选 + 选时间）。
   * 不传 slaDueAt = 取消。已完结的单没有「要求完成」可言，不给改。
   */
  async updateWorkOrderSlaDue(
    id: number,
    dto: UpdateWorkOrderSlaDto,
    user: AuthUser,
    access?: ResolvedAccess,
  ) {
    const tenantId = this.resolveTenantId(user);
    const workOrder = await this.workOrderRepo.findOne({ where: { id, tenantId } });
    if (!workOrder) throw new NotFoundException('work order not found');
    const scope = this.scopeIds(access);
    if (scope && !scope.includes(workOrder.communityId)) {
      throw new NotFoundException('work order not found');
    }
    if (
      workOrder.status === WorkOrderStatus.COMPLETED ||
      workOrder.status === WorkOrderStatus.CANCELLED
    ) {
      throw new BadRequestException('工单已完结，不能再改截止时间');
    }
    const next = dto.slaDueAt ? new Date(dto.slaDueAt) : null;
    workOrder.slaDueAt = next;
    workOrder.updatedBy = user.id;
    await this.dataSource.transaction(async (manager) => {
      await manager.save(WorkOrder, workOrder);
      await this.writeLog(
        manager,
        workOrder,
        null,
        'set_sla',
        user.id,
        next ? `要求完成截止时间设为 ${this.formatWhen(next)}` : '取消要求完成截止时间',
      );
    });
    return { ok: true, slaDueAt: workOrder.slaDueAt };
  }

  /** 更正类型弹窗的关键词候选：从这单的描述里挑出可以「学进新类型」的词 */
  async repairTypeCorrectionHints(id: number, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.resolveTenantId(user);
    const workOrder = await this.workOrderRepo.findOne({
      where: { id, tenantId },
      select: ['id', 'communityId', 'requestId', 'skill'],
    });
    if (!workOrder) throw new NotFoundException('work order not found');
    const scope = this.scopeIds(access);
    if (scope && !scope.includes(workOrder.communityId)) {
      throw new NotFoundException('work order not found');
    }
    const request = await this.repairRequestRepo.findOne({
      where: { id: workOrder.requestId, tenantId },
    });
    const content = request?.content ?? '';
    const fromType = request?.repairType ?? workOrder.skill ?? null;
    const fromRule = fromType
      ? await this.repairTypeRuleRepo.findOne({ where: { tenantId, repairType: fromType } })
      : null;
    const text = content.toLowerCase();
    const matchedOld = fromRule
      ? buildTypeKeywords(fromRule).filter(
          (word) => word.length >= 2 && text.includes(word.toLowerCase()),
        )
      : [];
    return {
      fromType,
      matchedOld,
      candidates: extractKeywordCandidates(content, matchedOld),
    };
  }

  /** 按描述判类型。判不出返回 null，交给后台按「其它」核对，不硬塞一个 */
  private async guessRepairType(content: string, tenantId: number): Promise<string | null> {
    if (!content?.trim()) return null;
    const rules = await this.repairTypeRuleRepo.find({
      where: { tenantId, enabled: true },
      order: { sortOrder: 'ASC', id: 'ASC' },
    });
    return classifyByKeywords(
      content,
      rules.map((rule) => ({
        repairType: rule.repairType,
        keywords: buildTypeKeywords(rule),
      })),
    );
  }

  private async findAutoAssignRule(repairType: string | undefined, tenantId: number) {
    if (!repairType) return null;
    const rule = await this.repairTypeRuleRepo.findOne({
      where: { tenantId, repairType, enabled: true },
    });
    if (!rule?.assigneeId) return null;
    const assignee = await this.userRepo.findOne({
      where: { id: rule.assigneeId, tenantId },
    });
    if (!assignee || assignee.status !== UserStatus.ACTIVE || assignee.role !== UserRole.TECHNICIAN) {
      return null;
    }
    return rule;
  }

  private async ensureDefaultRepairTypeRules(tenantId: number, operatorId: number) {
    let existing = await this.repairTypeRuleRepo.find({ where: { tenantId } });

    // 懒迁移：把旧类型编码/名称统一为新 8 类口径
    const currentCodes = new Set(existing.map((r) => r.repairType));
    const toMigrate = existing.filter((rule) => {
      const target = LEGACY_REPAIR_TYPE_MAP[rule.repairType];
      if (!target) return false;
      if (target.repairType !== rule.repairType && currentCodes.has(target.repairType)) {
        return false; // 新编码已存在，避免撞唯一约束
      }
      return target.repairType !== rule.repairType || target.label !== rule.label;
    });
    if (toMigrate.length) {
      for (const rule of toMigrate) {
        const target = LEGACY_REPAIR_TYPE_MAP[rule.repairType];
        rule.repairType = target.repairType;
        rule.label = target.label;
        rule.updatedBy = operatorId;
      }
      await this.repairTypeRuleRepo.save(toMigrate);
      existing = await this.repairTypeRuleRepo.find({ where: { tenantId } });
    }

    // 懒补种子关键词：老租户的规则建于「猜你想输」可配置之前，content_suggestions 是空的。
    // 只填空，不覆盖租户已经维护过的词。
    const needSeed = existing.filter(
      (rule) =>
        (!rule.contentSuggestions || rule.contentSuggestions.length === 0) &&
        SEED_CONTENT_SUGGESTIONS[rule.repairType]?.length,
    );
    if (needSeed.length) {
      for (const rule of needSeed) {
        rule.contentSuggestions = [...SEED_CONTENT_SUGGESTIONS[rule.repairType]];
        rule.updatedBy = operatorId;
      }
      await this.repairTypeRuleRepo.save(needSeed);
    }

    // 仅首次初始化时播种默认类型；之后由租户自行增删，删除的类型不再自动补回
    if (existing.length > 0) return;
    await this.repairTypeRuleRepo.save(
      DEFAULT_REPAIR_TYPES.map((item, index) =>
        this.repairTypeRuleRepo.create({
          tenantId,
          repairType: item.repairType,
          label: item.label,
          assigneeId: null,
          slaHours: 24,
          sortOrder: (index + 1) * 10,
          enabled: true,
          contentSuggestions: SEED_CONTENT_SUGGESTIONS[item.repairType] ?? [],
          createdBy: operatorId,
          updatedBy: operatorId,
        }),
      ),
    );
  }

  private async assertAssignee(tenantId: number, assigneeId: number | null) {
    if (!assigneeId) return;
    const assignee = await this.userRepo.findOne({ where: { id: assigneeId, tenantId } });
    if (!assignee || assignee.status !== UserStatus.ACTIVE) {
      throw new NotFoundException('assignee not found');
    }
    if (assignee.role !== UserRole.TECHNICIAN) {
      throw new BadRequestException('assignee must be technician');
    }
  }

  private async nextRepairTypeSortOrder(tenantId: number) {
    const row = await this.repairTypeRuleRepo
      .createQueryBuilder('rule')
      .select('COALESCE(MAX(rule.sort_order), 0)', 'max')
      .where('rule.tenant_id = :tenantId', { tenantId })
      .getRawOne<{ max: string }>();
    return Number(row?.max || 0) + 10;
  }

  /**
   * 把历史报修内容按「报修类型」归纳成常用短语，供「猜你想输」按类型展示。
   *
   * 直接按原文分组太散（「水管漏水」「水管漏水了」「厨房水管漏水。」会算成三条），
   * 这里先归一化出聚类键（去首尾标点/语气词/空白、去「我家」这类前缀），
   * 同一类里挑出现次数最多的原文当展示文案。
   * 只收 2~16 字的短句 —— 更长的是具体描述，贴到标签上既放不下也没法复用。
   */
  private async summarizeRepairContents(tenantId: number, limitPerType = 8) {
    const rows = await this.repairRequestRepo.find({
      where: { tenantId },
      select: ['repairType', 'content', 'createdAt'],
      order: { id: 'DESC' },
      take: SUGGESTION_SCAN_LIMIT,
    });

    const byType = new Map<string, SuggestionBucket>();
    const general: SuggestionBucket = new Map();
    for (const row of rows) {
      const text = String(row.content ?? '').trim();
      const key = normalizeSuggestionText(text);
      if (!key) continue;
      collectSuggestion(general, key, text, row.createdAt);
      const type = row.repairType?.trim();
      if (!type) continue;
      let bucket = byType.get(type);
      if (!bucket) {
        bucket = new Map();
        byType.set(type, bucket);
      }
      collectSuggestion(bucket, key, text, row.createdAt);
    }

    return {
      general: rankSuggestions(general, limitPerType),
      byType: Object.fromEntries(
        Array.from(byType.entries()).map(([type, bucket]) => [
          type,
          rankSuggestions(bucket, limitPerType),
        ]),
      ) as Record<string, Array<{ text: string; count: number }>>,
      // 聚类键 -> 次数，给「已配置关键词」查真实使用次数用
      keyCountsByType: Object.fromEntries(
        Array.from(byType.entries()).map(([type, bucket]) => [
          type,
          Object.fromEntries(
            Array.from(bucket.entries()).map(([key, item]) => [key, item.count]),
          ),
        ]),
      ) as Record<string, Record<string, number>>,
    };
  }

  /**
   * 从历史维修说明里归纳可复用的短句，按报修类型分桶。
   *
   * 取 repair_content，没有才退回 action_note（小程序端两个字段写的是同一句）。
   * 太长的说明是针对某一单的具体描述，normalizeSuggestionText 会直接过滤掉，
   * 留下的才是「更换水龙头阀芯」这种能反复用的。
   */
  private async summarizeActionNotes(tenantId: number, limitPerType = MAX_ACTION_SUGGESTIONS) {
    const textExpr =
      "COALESCE(NULLIF(BTRIM(wo.repair_content), ''), NULLIF(BTRIM(wo.action_note), ''))";
    const rows = await this.workOrderRepo
      .createQueryBuilder('wo')
      .innerJoin(RepairRequest, 'req', 'req.id = wo.request_id AND req.tenant_id = wo.tenant_id')
      .select(textExpr, 'text')
      .addSelect('req.repair_type', 'type')
      .addSelect('wo.completed_at', 'at')
      .where('wo.tenant_id = :tenantId', { tenantId })
      .andWhere(`${textExpr} IS NOT NULL`)
      .orderBy('wo.id', 'DESC')
      .limit(SUGGESTION_SCAN_LIMIT)
      .getRawMany<{ text: string; type: string | null; at: Date | null }>();

    const byType = new Map<string, SuggestionBucket>();
    const general: SuggestionBucket = new Map();
    for (const row of rows) {
      const text = String(row.text ?? '').trim();
      const key = normalizeSuggestionText(text);
      if (!key) continue;
      collectSuggestion(general, key, text, row.at);
      const type = row.type?.trim();
      if (!type) continue;
      let bucket = byType.get(type);
      if (!bucket) {
        bucket = new Map();
        byType.set(type, bucket);
      }
      collectSuggestion(bucket, key, text, row.at);
    }

    return {
      general: rankSuggestions(general, limitPerType),
      byType: Object.fromEntries(
        Array.from(byType.entries()).map(([type, bucket]) => [
          type,
          rankSuggestions(bucket, limitPerType),
        ]),
      ) as Record<string, Array<{ text: string; count: number }>>,
    };
  }

  private async listFrequentRepairText(
    tenantId: number,
    column: 'address_text' | 'content',
    limit: number,
  ) {
    const textExpr = `BTRIM(request.${column})`;
    const rows = await this.repairRequestRepo
      .createQueryBuilder('request')
      .select(textExpr, 'text')
      .addSelect('COUNT(*)', 'count')
      .where('request.tenant_id = :tenantId', { tenantId })
      .andWhere(`NULLIF(${textExpr}, '') IS NOT NULL`)
      .groupBy(textExpr)
      .orderBy('COUNT(*)', 'DESC')
      .addOrderBy('MAX(request.created_at)', 'DESC')
      .limit(limit)
      .getRawMany<{ text: string; count: string }>();

    return rows.map((row) => ({ text: row.text, count: Number(row.count) }));
  }

  /**
   * 工单号：RX-YYYYMMDD-XXXX，尾号 4 位随机。
   *
   * 用随机尾号而不是当日自增：自增会把「今天第几单」直接暴露给业主和外部，
   * 也让人能靠改一位数字猜到别人的单号。
   *
   * 字符集排除手写/口述易混的一组（0/O、1/I/L、2/Z、5/S、8/B），
   * 业主在电话里报单号、维修工抄在纸上都不会错位；25^4 ≈ 39 万组合，
   * 同日撞号的概率极低，撞了就重取。
   *
   * 历史上还出现过 REP20260809001 / WO-20260707-000001 / REP-… 三种写法，
   * 启动时由 renumberLegacyOrderNos() 统一重编成这一种。
   */
  private static readonly ORDER_NO_ALPHABET = '34679ACDEFGHJKMNPQRTUVWXY';
  private static readonly ORDER_NO_PREFIX = 'RX';
  /** 合规单号的样子，迁移与自检都以它为准 */
  private static readonly ORDER_NO_RE = /^RX-\d{8}-[34679ACDEFGHJKMNPQRTUVWXY]{4}$/;

  private async nextOrderNo(manager: EntityManager, at: Date = new Date()): Promise<string> {
    const prefix = `${RepairsService.ORDER_NO_PREFIX}-${this.ymd(at)}-`;

    // 同日取号串行化：随机也可能撞，撞了要在同一把锁里看到对方已占的号
    await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `work-order-no:${prefix}`,
    ]);

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const candidate = `${prefix}${this.randomOrderSuffix(4)}`;
      const hit: Array<{ id: number }> = await manager.query(
        'SELECT id FROM work_orders WHERE order_no = $1 LIMIT 1',
        [candidate],
      );
      if (!hit.length) return candidate;
    }
    // 连撞 10 次基本只可能是当天单量逼近字符空间；加一位继续，别把报修卡死
    return `${prefix}${this.randomOrderSuffix(5)}`;
  }

  private ymd(at: Date): string {
    return `${at.getFullYear()}${String(at.getMonth() + 1).padStart(2, '0')}${String(
      at.getDate(),
    ).padStart(2, '0')}`;
  }

  /**
   * 把不符合新规则的历史单号统一重编（启动时跑一次，幂等）。
   *
   * 日期段取工单自己的创建日，不是迁移当天 —— 单号还得能反映这单是哪天报的。
   * 已经合规的单不动，所以重复启动不会一直换号。
   */
  async renumberLegacyOrderNos(): Promise<{ scanned: number; renumbered: number }> {
    const legacy = await this.workOrderRepo
      .createQueryBuilder('wo')
      .select(['wo.id', 'wo.orderNo', 'wo.createdAt'])
      .orderBy('wo.id', 'ASC')
      .getMany();
    const stale = legacy.filter((item) => !RepairsService.ORDER_NO_RE.test(item.orderNo));
    if (!stale.length) return { scanned: legacy.length, renumbered: 0 };

    let renumbered = 0;
    for (const workOrder of stale) {
      await this.dataSource.transaction(async (manager) => {
        const createdAt = workOrder.createdAt ? new Date(workOrder.createdAt) : new Date();
        const orderNo = await this.nextOrderNo(
          manager,
          isNaN(createdAt.getTime()) ? new Date() : createdAt,
        );
        await manager.update(WorkOrder, { id: workOrder.id }, { orderNo });
        renumbered += 1;
      });
    }
    this.logger.log(
      `工单号迁移完成：扫描 ${legacy.length} 条，重编 ${renumbered} 条（新规则 RX-YYYYMMDD-XXXX）`,
    );
    return { scanned: legacy.length, renumbered };
  }

  private randomOrderSuffix(length: number): string {
    const alphabet = RepairsService.ORDER_NO_ALPHABET;
    // crypto 取随机，Math.random 在同一毫秒并发下更容易撞
    const bytes = randomBytes(length);
    let out = '';
    for (let i = 0; i < length; i += 1) {
      out += alphabet[bytes[i] % alphabet.length];
    }
    return out;
  }

  /**
   * 采购申请号。同一张工单可能缺料好几轮（第一次报的料不对、到货后又发现少件），
   * 单号里带上第几次，否则办公室会看到两张一模一样的 PR-20260809-000123。
   */
  private async buildPurchaseRequestNo(
    manager: EntityManager,
    tenantId: number,
    workOrderId: number,
  ): Promise<string> {
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const seq = await manager.count(PurchaseRequest, { where: { tenantId, workOrderId } });
    const base = `PR-${yyyy}${mm}${dd}-${String(workOrderId).padStart(6, '0')}`;
    return seq > 0 ? `${base}-${seq + 1}` : base;
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

  private averageUnitCost(allocations: LotAllocation[], qty: number): number {
    if (!qty) return 0;
    const total = allocations.reduce((sum, item) => sum + item.amountCents, 0);
    return Math.round(total / qty);
  }

  private async lockWorkOrder(manager, id: number, tenantId: number) {
    const workOrder = await manager.findOne(WorkOrder, {
      where: { id, tenantId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!workOrder) throw new NotFoundException('work order not found');
    return workOrder;
  }

  private ensureAssigneeOrAdmin(workOrder: WorkOrder, user: AuthUser) {
    if (user.role === UserRole.TECHNICIAN && workOrder.assigneeId !== user.id) {
      throw new ForbiddenException('work order is not assigned to current user');
    }
  }

  private writeLog(
    manager,
    workOrder: WorkOrder,
    fromStatus: WorkOrderStatus | null,
    action: string,
    operatorId: number | null,
    note?: string | null,
  ) {
    return manager.save(
      WorkOrderLog,
      manager.create(WorkOrderLog, {
        tenantId: workOrder.tenantId,
        workOrderId: workOrder.id,
        fromStatus,
        toStatus: workOrder.status,
        action,
        operatorId,
        note: note ?? null,
        createdBy: operatorId,
        updatedBy: operatorId,
      }),
    );
  }

  private resolveTenantId(user: AuthUser, requestedTenantId?: number): number {
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
    throw new ForbiddenException('账号还没有归属物业，请先认证房屋或扫楼栋码报修');
  }
}
