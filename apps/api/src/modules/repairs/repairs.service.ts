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
  MoreThan,
  Not,
  Repository,
} from 'typeorm';
import { AuthUser } from '../../common/current-user.decorator';
import { AccessService, ResolvedAccess } from '../access/access.service';
import { scopeCommunityIds } from '../access/scope.util';
import { NotificationsService } from '../notifications/notifications.service';
import { SettingsService } from '../settings/settings.service';
import {
  NotifyChannel,
  NotifyStatus,
  OwnerSource,
  OWNER_APP_ROLES,
  STAFF_APP_ROLES,
  RepairSource,
  REPAIR_SOURCE_LABELS,
  USER_ROLE_LABELS,
  PurchaseRequestStatus,
  StockMovementType,
  UserRole,
  UserStatus,
  WarehouseType,
  WorkOrderStatus,
} from '../../common/enums';
import { formatAddressLine } from '../../common/address-line.util';
import { detectUrgency } from '../../common/repair-urgency.util';
import { repairTypeAndSlaLockReason } from '../../common/work-order-stage';
import {
  ensureOfficeRepairRules,
  ruleAssigneeIds,
  toRuleView,
  toRuleViews,
  type RepairTypeRuleView,
} from './repair-rule-template';
import {
  Building,
  Community,
  CommunitySpot,
  House,
  ManagementOffice,
  Notification,
  PurchaseRequest,
  RepairRequest,
  RepairTypeCorrection,
  RepairTypeRule,
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
  type SuggestionScope,
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
  UpdateOfficeSuggestionSettingsDto,
  UpdateWorkOrderRepairTypeDto,
  UpdateWorkOrderSlaDto,
  UpsertRepairTypeRuleDto,
  WorkOrdersQueryDto,
} from './dto';
import {
  correctCommunityNameInText,
  extractAddressCandidate,
  matchCommunityByName,
  matchSpotsInText,
  extractKeywordCandidates,
  sameNo,
  tokenizeAddress,
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
  extractContentGist,
  extractSpot,
  findSpotWord,
  type SuggestionBucket,
} from './repair-suggestions.util';
import {
  applyStockDelta,
  averageUnitCost,
  consumeStockLots,
  restoreStockLots,
} from '../inventory/stock-ledger';
import { ObjectStorageService } from '../upload/object-storage.service';
import { buildTypeKeywords, classifyByKeywords } from './repair-classify.util';
import { assertWorkOrderTransition } from './work-order-state-machine';
import {
  DEFAULT_REPAIR_TYPES,
  LEGACY_REPAIR_TYPE_MAP,
  resolveRepairTypeLabel,
} from './repair-type-labels';

/** 撤单快选原因 */
const CANCEL_REASONS: Record<string, string> = {
  wrong_info: '填错了',
  duplicate: '重复提交',
  self_resolved: '已自行解决',
  owner_cancel: '业主取消',
  other: '其他',
};

@Injectable()
export class RepairsService implements OnModuleInit {
  private readonly logger = new Logger(RepairsService.name);

  constructor(
    private readonly accessService: AccessService,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    @InjectRepository(Community)
    private readonly communityRepo: Repository<Community>,
    @InjectRepository(Building)
    private readonly buildingRepo: Repository<Building>,
    @InjectRepository(House)
    private readonly houseRepo: Repository<House>,
    @InjectRepository(CommunitySpot)
    private readonly spotRepo: Repository<CommunitySpot>,
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

  /**
   * 报修类型规则按管理处分套：officeId 为空 = 公司默认模板；
   * 管理处第一次打开配置页时从模板复制一份（懒复制），之后各改各的、互不影响。
   *
   * 关键词是例外：不复制、按模板叠加下发（见 toRuleViews）。返回的
   * contentSuggestions 是**生效关键词**，另外带 templateSuggestions / extraSuggestions /
   * mutedSuggestions 三层来源给配置页分开显示。
   */
  async listRepairTypeRules(user: AuthUser, officeId?: number | null) {
    const tenantId = this.resolveTenantId(user);
    await this.ensureDefaultRepairTypeRules(tenantId, user.id);
    const templates = await this.templateRules(tenantId);
    // 老数据只有 assignee_id 一个人，读出来统一补成数组，后台页只认 assigneeIds
    const decorate = (rules: RepairTypeRule[]) =>
      toRuleViews(rules, templates).map((rule) => ({
        ...rule,
        assigneeIds: ruleAssigneeIds(rule),
      }));
    if (!officeId) return decorate(templates);
    await this.assertOffice(tenantId, officeId);
    // 没有自己那套就从总公司复制（新建管理处时已经同步建过，这里是兜底）
    return decorate(
      await ensureOfficeRepairRules(this.repairTypeRuleRepo, tenantId, officeId, user.id),
    );
  }

  /** 公司模板那一套（office_id 为空）：关键词的唯一真源，各管理处那套都靠它叠出来 */
  private templateRules(tenantId: number) {
    return this.repairTypeRuleRepo.find({
      where: { tenantId, officeId: IsNull() },
      order: { sortOrder: 'ASC', id: 'ASC' },
    });
  }

  /**
   * 报修类型配置弹窗的管理处 Tab 列表：按本人范围算，刚新建的管理处不用重新登录就能看到。
   * 顺带把每个管理处的「猜你想输」口径开关一起给出去，配置页顶部直接能改。
   */
  async listRuleOffices(user: AuthUser) {
    const visible = await this.accessService.listVisibleOffices(user);
    if (!visible.length) return [];
    const tenantId = this.resolveTenantId(user);
    const rows = await this.dataSource.getRepository(ManagementOffice).find({
      where: { tenantId, id: In(visible.map((office) => office.id)) },
      select: ['id', 'suggestionScope', 'suggestionFeedback'],
    });
    const settingById = new Map(rows.map((row) => [row.id, row] as const));
    return visible.map((office) => ({
      ...office,
      suggestionScope: settingById.get(office.id)?.suggestionScope ?? 'office_first',
      suggestionFeedback: settingById.get(office.id)?.suggestionFeedback ?? true,
    }));
  }

  /** 改某个管理处的「猜你想输」口径：按谁的历史排序、本处高频词要不要进公司候选池 */
  async updateOfficeSuggestionSettings(
    officeId: number,
    dto: UpdateOfficeSuggestionSettingsDto,
    user: AuthUser,
  ) {
    const tenantId = this.resolveTenantId(user);
    const office = await this.assertOffice(tenantId, officeId);
    if (dto.suggestionScope !== undefined) office.suggestionScope = dto.suggestionScope;
    if (dto.suggestionFeedback !== undefined) office.suggestionFeedback = dto.suggestionFeedback;
    office.updatedBy = user.id;
    await this.dataSource.getRepository(ManagementOffice).save(office);
    return {
      id: office.id,
      name: office.name,
      suggestionScope: office.suggestionScope,
      suggestionFeedback: office.suggestionFeedback,
    };
  }

  async createRepairTypeRule(dto: UpsertRepairTypeRuleDto, user: AuthUser) {
    const tenantId = this.resolveTenantId(user);
    const officeId = dto.officeId ?? null;
    if (officeId) await this.assertOffice(tenantId, officeId);
    const assigneeIds = this.dtoAssigneeIds(dto);
    for (const id of assigneeIds) await this.assertAssignee(tenantId, id, officeId);
    const existing = await this.repairTypeRuleRepo.findOne({
      where: { tenantId, officeId: officeId ?? IsNull(), repairType: dto.repairType },
    });
    if (existing) throw new BadRequestException('该报修类型规则已存在');
    const words = this.dtoSuggestions(dto, officeId, SEED_CONTENT_SUGGESTIONS[dto.repairType] ?? []);
    await this.assertNoKeywordConflict(tenantId, officeId, dto.repairType, words.own);
    const sortOrder = dto.sortOrder ?? (await this.nextRepairTypeSortOrder(tenantId, officeId));
    return this.repairTypeRuleRepo.save(
      this.repairTypeRuleRepo.create({
        tenantId,
        officeId,
        repairType: dto.repairType,
        label: dto.label,
        // assignee_id 只留第一个人做兼容，真正生效的是 assignee_ids
        assigneeId: assigneeIds[0] ?? null,
        assigneeIds,
        slaHours: dto.slaHours ?? null,
        sortOrder,
        enabled: dto.enabled ?? true,
        contentSuggestions: words.template,
        extraSuggestions: words.extra,
        mutedSuggestions: words.muted,
        createdBy: user.id,
        updatedBy: user.id,
      }),
    );
  }

  /**
   * 后台提交的关键词落到哪一列：公司模板行写 content_suggestions（全公司生效），
   * 管理处行写 extra_suggestions（本处增补）+ muted_suggestions（本处停用的模板词）。
   *
   * 老后台只会传 contentSuggestions —— 在管理处那一页把它当成本处增补收下，
   * 不然老页面一保存就会把一整套模板词写死进这个管理处。
   */
  private dtoSuggestions(
    dto: UpsertRepairTypeRuleDto,
    officeId: number | null,
    fallback: string[] = [],
  ): { template: string[]; extra: string[]; muted: string[]; own: string[] } {
    if (officeId === null) {
      const template = normalizeSuggestionList(dto.contentSuggestions ?? fallback);
      return { template, extra: [], muted: [], own: template };
    }
    const extra = normalizeSuggestionList(dto.extraSuggestions ?? dto.contentSuggestions ?? []);
    return {
      template: [],
      extra,
      muted: normalizeSuggestionList(dto.mutedSuggestions ?? []),
      own: extra,
    };
  }

  /**
   * 关键词撞车校验：同一套（公司模板 / 某个管理处）里，一个词只能属于一个报修类型。
   *
   * 为什么必须硬拦：classifyByKeywords 按「命中词的字数总和」打分，两个类型配了同一个词时
   * 分数会打平，最后由 sortOrder 靠前的那个悄悄赢走 —— 配置的人完全看不出发生了什么，
   * 只会觉得「系统判得不准」。
   *
   * 只拦**完全相同**的词。包含关系（「漏水」vs「厨房漏水」）不拦：真实词库里这种交叉大量存在，
   * 硬拦会让人根本配不下去，而它们靠字数打分本来就分得开。
   */
  private async assertNoKeywordConflict(
    tenantId: number,
    officeId: number | null,
    repairType: string,
    words: string[],
    excludeRuleId: number | null = null,
  ) {
    const wanted = words.map((word) => word.trim()).filter(Boolean);
    if (!wanted.length) return;

    const all = await this.repairTypeRuleRepo.find({ where: { tenantId } });
    const templateByType = new Map(
      all.filter((rule) => rule.officeId === null).map((rule) => [rule.repairType, rule] as const),
    );
    /** 一套规则里「词 -> 占用它的类型名」；同编码的那条就是正在编辑的自己，跳过 */
    const ownerOf = (rules: RepairTypeRule[]) => {
      const owner = new Map<string, string>();
      for (const rule of rules) {
        // 正在编辑的那条自己不算撞车。按 id 排除，别只按编码 ——
        // 改编码的同时改关键词时，按编码排除会把自己当成「另一个类型」拦下来
        if (excludeRuleId !== null && rule.id === excludeRuleId) continue;
        if (rule.repairType === repairType) continue;
        for (const word of toRuleView(rule, templateByType).contentSuggestions) {
          if (!owner.has(word)) owner.set(word, rule.label);
        }
      }
      return owner;
    };

    const sameSet = ownerOf(all.filter((rule) => (rule.officeId ?? null) === officeId));
    for (const word of wanted) {
      const label = sameSet.get(word);
      if (label) {
        throw new BadRequestException(
          `「${word}」已经是「${label}」的关键词，同一个词只能属于一个报修类型 —— ` +
            `留着两边都有，系统只会按排序挑一个，判得准不准全看运气。` +
            `请先去「${label}」里删掉它，或者在这里换个说法。`,
        );
      }
    }

    // 改公司模板时，还要看会不会和某个管理处的本处词撞上：模板是下发给所有管理处的，
    // 那边撞了同样会判错，而且当事人在公司这一页根本看不到。
    if (officeId !== null) return;
    const officeIds = Array.from(
      new Set(all.map((rule) => rule.officeId).filter((id): id is number => id !== null)),
    );
    if (!officeIds.length) return;
    const offices = await this.dataSource
      .getRepository(ManagementOffice)
      .find({ where: { tenantId, id: In(officeIds) }, select: ['id', 'name'] });
    const officeName = new Map(offices.map((office) => [office.id, office.name] as const));
    for (const id of officeIds) {
      const owner = ownerOf(all.filter((rule) => rule.officeId === id));
      for (const word of wanted) {
        const label = owner.get(word);
        if (!label) continue;
        const name = officeName.get(id) ?? `管理处 #${id}`;
        throw new BadRequestException(
          `「${word}」在「${name}」已经是「${label}」的本处关键词，加进公司模板会和那边撞车。` +
            `请先去「${name}」那一页把它删掉，再回来加。`,
        );
      }
    }
  }

  async updateRepairTypeRule(id: number, dto: UpsertRepairTypeRuleDto, user: AuthUser) {
    const tenantId = this.resolveTenantId(user);
    const rule = await this.repairTypeRuleRepo.findOne({ where: { id, tenantId } });
    if (!rule) throw new NotFoundException('repair type rule not found');
    // 归属的管理处不能改：要挪去别的管理处就到那一页新建
    const assigneeIds = this.dtoAssigneeIds(dto);
    for (const id of assigneeIds) await this.assertAssignee(tenantId, id, rule.officeId);
    const dup = await this.repairTypeRuleRepo.findOne({
      where: { tenantId, officeId: rule.officeId ?? IsNull(), repairType: dto.repairType },
    });
    if (dup && dup.id !== id) throw new BadRequestException('该报修类型规则已存在');
    const touchesKeywords =
      dto.contentSuggestions !== undefined ||
      dto.extraSuggestions !== undefined ||
      dto.mutedSuggestions !== undefined;
    if (touchesKeywords) {
      const words = this.dtoSuggestions(dto, rule.officeId);
      /*
       * 只拦**这次新加的词**，不拦本来就在的。
       *
       * 老数据里早就有撞车（吴泾的「门锁打不开」同时挂在门窗和智能化下，
       * 「楼道灯不亮」同时挂在电和公共设施下）。按整份词去校验的话，
       * 这两个类型连改个完成时限都保存不了 —— 报错还指着一个跟这次修改无关的词。
       * 已经存在的撞车由配置页顶部那条横幅列出来请人处理，不堵住其它修改。
       */
      const before = rule.officeId === null ? rule.contentSuggestions ?? [] : rule.extraSuggestions ?? [];
      const added = words.own.filter((word) => !before.includes(word));
      await this.assertNoKeywordConflict(tenantId, rule.officeId, dto.repairType, added, rule.id);
      if (rule.officeId === null) {
        rule.contentSuggestions = words.template;
      } else {
        // 管理处行的 content_suggestions 迁移后就该一直是空的：本处的词走 extra/muted，
        // 模板词是继承来的。老后台把生效词整份回传时，dtoSuggestions 已经把它收成 extra 了。
        rule.contentSuggestions = [];
        rule.extraSuggestions = words.extra;
        if (dto.mutedSuggestions !== undefined) rule.mutedSuggestions = words.muted;
      }
    }
    rule.repairType = dto.repairType;
    rule.label = dto.label;
    rule.assigneeId = assigneeIds[0] ?? null;
    rule.assigneeIds = assigneeIds;
    rule.slaHours = dto.slaHours ?? null;
    rule.sortOrder = dto.sortOrder ?? rule.sortOrder;
    rule.enabled = dto.enabled ?? true;
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
    return this.listRepairTypeRules(user, ruleById.get(ids[0])?.officeId ?? null);
  }

  /** 报修类型的对外精简版：只给编码、名称和关键词，不含派单规则 */
  async listPublicRepairTypes(user: AuthUser, communityId?: number | null) {
    const tenantId = this.resolveTenantId(user);
    await this.ensureDefaultRepairTypeRules(tenantId, user.id);
    // 带小区就给该小区所属管理处那套（管理处可以有自己的类型/关键词），不带就是公司默认
    const rules = (await this.rulesForCommunity(tenantId, communityId)).filter((rule) => rule.enabled);
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

    // 关键词要按模板叠加算，管理处那些行自己那一列是空的
    const rules = await this.repairTypeRuleRepo.find({ where: { tenantId } });
    const views = toRuleViews(rules, rules.filter((rule) => rule.officeId === null));
    const keywordsByType = new Map(
      views.map((rule) => [rule.repairType, buildTypeKeywords(rule)] as const),
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

  async listRepairSuggestions(
    user: AuthUser,
    opts?: { officeId?: number | null; communityId?: number | null },
  ) {
    const tenantId = this.resolveTenantId(user);
    const scope = await this.suggestionScope(tenantId, opts);
    // 本公司的小区名：抽位置/内容时先把它们剥掉（「枫桦景苑二期」这种名字光靠模式认不全）
    const communities = await this.communityRepo.find({
      where: { tenantId },
      select: ['id', 'name', 'parentId', 'officeId'],
    });
    const knownPlaces = communities.map((c) => c.name).filter(Boolean);
    const [locations, companyStats, officeStats, rules] = await Promise.all([
      this.summarizeSpots(tenantId, knownPlaces, 8, scope.officeCommunityIds),
      this.summarizeRepairContents(tenantId, knownPlaces, 8, scope.companyCommunityIds),
      scope.officeCommunityIds
        ? this.summarizeRepairContents(tenantId, knownPlaces, 8, scope.officeCommunityIds)
        : Promise.resolve(null),
      this.repairTypeRuleRepo.find({ where: { tenantId } }),
    ]);

    // 本处优先：本处有数据的词排前面，不够 8 条用全公司的补齐。
    // 新管理处一条报修都没有，纯本处口径会是一片空白 —— 那比不分口径还难用。
    const useOfficeFirst = officeStats && scope.scope === 'office_first';
    const primary = scope.scope === 'company' || !officeStats ? companyStats : officeStats;
    const contentsByType: Record<string, Array<{ text: string; count: number }>> = {};
    for (const type of new Set([
      ...Object.keys(primary.byType),
      ...Object.keys(companyStats.byType),
    ])) {
      const rows = [...(primary.byType[type] ?? [])];
      if (useOfficeFirst) {
        const seen = new Set(rows.map((item) => normalizeSuggestionText(item.text)));
        for (const item of companyStats.byType[type] ?? []) {
          if (rows.length >= 8) break;
          const key = normalizeSuggestionText(item.text);
          if (!key || seen.has(key)) continue;
          seen.add(key);
          rows.push(item);
        }
      }
      contentsByType[type] = rows;
    }

    /**
     * 每个关键词被真实用了多少次，供后台「按使用次数排序」。
     * 一个类型的词可能来自模板，也可能来自各管理处的本处增补 —— 这里按类型把它们并起来算，
     * 哪一页打开都查得到次数。
     */
    const views = toRuleViews(rules, rules.filter((rule) => rule.officeId === null));
    const wordsByType = new Map<string, Set<string>>();
    for (const rule of views) {
      const bucket = wordsByType.get(rule.repairType) ?? new Set<string>();
      for (const word of rule.contentSuggestions ?? []) bucket.add(word);
      wordsByType.set(rule.repairType, bucket);
    }
    const usageFrom = (counts: Record<string, Record<string, number>>) => {
      const out: Record<string, Record<string, number>> = {};
      for (const [type, words] of wordsByType) {
        const byKey = counts[type];
        const usage: Record<string, number> = {};
        for (const word of words) {
          const key = normalizeSuggestionText(word);
          usage[word] = (key && byKey?.[key]) || 0;
        }
        out[type] = usage;
      }
      return out;
    };

    return {
      locations,
      contents: (primary.general.length ? primary : companyStats).general,
      contentsByType,
      // 当前口径下的次数（本处口径时就是本处的），配置页的「按使用次数排序」按它来
      keywordUsageByType: usageFrom(
        (officeStats && scope.scope !== 'company' ? officeStats : companyStats).keyCountsByType,
      ),
      // 全公司次数单独给一份：配置页上显示成「本处 3 次 · 全公司 12 次」，
      // 判断一个本地词值不值得收编进模板全看这两个数的差
      companyKeywordUsageByType: usageFrom(companyStats.keyCountsByType),
      scope: scope.scope,
      officeId: scope.officeId,
      officeScoped: Boolean(officeStats),
    };
  }

  /**
   * 「猜你想输」这次按谁的历史算。
   *
   * - officeCommunityIds：本处口径的小区（不传管理处 / 该管理处没有小区时为 null，表示不分口径）
   * - companyCommunityIds：全公司口径的小区，**不含**关掉了「回流公司候选池」的管理处 ——
   *   那个开关的意思就是「本处的话术别铺到全公司去」，统计口径上必须真的排除掉，
   *   不然开关就是个摆设。收（用全公司数据兜底）和送（把本处数据交出去）是两回事，
   *   关掉的管理处照样能用全公司的词兜底。
   */
  private async suggestionScope(
    tenantId: number,
    opts?: { officeId?: number | null; communityId?: number | null },
  ): Promise<{
    scope: SuggestionScope;
    officeId: number | null;
    officeCommunityIds: number[] | null;
    companyCommunityIds: number[] | null;
  }> {
    const officeId =
      opts?.officeId ??
      (opts?.communityId
        ? await this.accessService.officeIdOfCommunity(tenantId, opts.communityId)
        : null);
    const offices = await this.dataSource.getRepository(ManagementOffice).find({
      where: { tenantId },
      select: ['id', 'suggestionScope', 'suggestionFeedback'],
    });
    const communities = await this.communityRepo.find({
      where: { tenantId },
      select: ['id', 'parentId', 'officeId'],
    });
    const officeOf = new Map<number, number | null>();
    const byId = new Map(communities.map((c) => [c.id, c] as const));
    for (const community of communities) {
      const own = community.officeId ?? null;
      // 分期跟随顶层小区（和 AccessService.officeIdOfCommunity 同一套口径）
      const inherited = own ?? (community.parentId ? byId.get(community.parentId)?.officeId ?? null : null);
      officeOf.set(community.id, inherited);
    }

    const muted = new Set(
      offices.filter((office) => !office.suggestionFeedback).map((office) => office.id),
    );
    const companyCommunityIds = muted.size
      ? communities
          .filter((c) => {
            const owner = officeOf.get(c.id);
            return !owner || !muted.has(owner);
          })
          .map((c) => c.id)
      : null;

    if (!officeId) {
      return { scope: 'company', officeId: null, officeCommunityIds: null, companyCommunityIds };
    }
    const officeCommunityIds = communities
      .filter((c) => officeOf.get(c.id) === officeId)
      .map((c) => c.id);
    const setting = offices.find((office) => office.id === officeId);
    return {
      scope: setting?.suggestionScope ?? 'office_first',
      officeId,
      officeCommunityIds: officeCommunityIds.length ? officeCommunityIds : null,
      companyCommunityIds,
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
    if (await this.isSelfScoped(user, access)) {
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
      // 维修工的池子只看和自己类型相关的单：他在哪些类型里被配成了默认维修工，就看哪些类型。
      // 一个类型都没配到的人不过滤（老配置也得能用）；派单台（能派单的人）看全部
      if (!(await this.canDispatch(user, access))) {
        const types = await this.technicianTypes(tenantId, user.id);
        if (types.length) where.skill = In(types);
      }
    } else if (query.scope === 'reported') {
      // 「我报的」= 我替住户/巡查提交的单，不管派给了谁。
      // 维修工替人报的单被自动派给了别人，在手和池子里都看不到，就像单子消失了一样
      // （2026-08-28 反馈：孔赟报的智能化单按类型规则派给了叶双，他自己哪儿都找不到）
      const myRequestIds = await this.repairRequestRepo.find({
        where: { tenantId, submittedBy: user.id },
        select: ['id'],
        order: { id: 'DESC' },
        take: 200,
      });
      if (!myRequestIds.length) return [];
      where.requestId = In(myRequestIds.map((item) => item.id));
    } else if (query.scope === 'mine' || !(await this.canDispatch(user, access))) {
      // 「在手工单」= 派到我头上的单，对谁都是这个意思。
      // 原来这一档只认 TECHNICIAN，办公室带 scope=mine 会掉进无过滤分支，
      // 把全公司的工单当成「我手上的」列出来。
      // 维修工不带 scope 时仍然默认只看自己的单 —— 这条不能丢，丢了就是越权看全公司。
      where.assigneeId = user.id;
    }

    const wheres = await this.keywordWheres(tenantId, where, query.q);

    const workOrders = await this.workOrderRepo.find({
      where: wheres.length === 1 ? wheres[0] : wheres,
      order: { id: 'DESC' },
      take: 100,
    });
    const requestIds = workOrders.map((item) => item.requestId);
    if (!requestIds.length) return workOrders;

    const requests = await this.repairRequestRepo.find({
      where: { tenantId, id: In(requestIds) },
      select: ['id', 'repairType', 'houseId', 'buildingId', 'communityId', 'addressText', 'content', 'contactName', 'reporterRole', 'source', 'urgent'],
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
    // 卡片地址要带小区名，还要按「这个小区有几个弄」决定弄号省不省
    const communityById = await this.communityAddressInfo(
      tenantId,
      workOrders.map((item) => item.communityId),
    );
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
    const rows = workOrders.map((item) => {
      const repairType = requestById.get(item.requestId)?.repairType ?? item.skill;
      return {
        ...item,
        repairType,
        // 报修时就说了「急修」的单：卡片和后台列表挂红色「紧急」标
        urgent: requestById.get(item.requestId)?.urgent ?? false,
        // 租户自建的类型（menjing、duijiang…）在端上查不到中文，卡片会直接显示编码，
        // 所以中文名由后端给：租户配的 label 优先，回退到内置类型表
        repairTypeLabel: this.repairTypeLabel(repairType, typeLabels),
        summaryAddress: this.buildRequestAddressSummary(
          requestById.get(item.requestId),
          houseById,
          buildingById,
          communityById,
        ),
        summaryContent: requestById.get(item.requestId)?.content ?? '',
        assigneeName: item.assigneeId
          ? assigneeNameById.get(item.assigneeId) ?? `#${item.assigneeId}`
          : null,
        // 报修人：工单池卡片要有这一条（2026-08-27 要求）。存的是建单时落库的联系人，
        // 代报的带上身份（保安 / 居委），让人一眼分清是不是业主本人报的
        contactName: requestById.get(item.requestId)?.contactName ?? null,
        reporterRoleLabel: (() => {
          const role = requestById.get(item.requestId)?.reporterRole;
          return role ? USER_ROLE_LABELS[role] ?? role : null;
        })(),
        source: requestById.get(item.requestId)?.source ?? null,
        sourceLabel: (() => {
          const src = requestById.get(item.requestId)?.source;
          return src ? REPAIR_SOURCE_LABELS[src] ?? src : null;
        })(),
      };
    });
    // 工单池是「先到先接」，急单排在第 20 条等于没标 —— 只有池子这一档提前。
    // 「在手工单」「后台全部」维持时间倒序：那两处人是按时间找单的，抽一条到顶更难找
    if (query.scope === 'pool') {
      rows.sort((a, b) => Number(b.urgent) - Number(a.urgent));
    }
    return rows;
  }

  /**
   * 派单台的维修工清单（含在手单数）。
   *
   * 为什么不复用 GET /staff：那是「用户管理」页的权限，办公室的角色未必勾了 ——
   * 派单是工单页的事，权限就该按工单页算。返回的字段也只够派单用（姓名/电话/工种/在手几单），
   * 不下发账号、微信绑定这些跟派单无关的信息。
   */
  async listDispatchTechnicians(
    user: AuthUser,
    access?: ResolvedAccess,
    officeScope?: number | null,
  ) {
    const tenantId = this.resolveTenantId(user);
    // 「谁能接单」= 他绑的角色里勾了「工单池 · 接单」。
    // 以前这里按 role='technician' 查人，于是「谁是维修工」在库里有两套说法
    const acceptorIds = await this.accessService.userIdsWithPermission(
      tenantId,
      'app:pool',
      'edit',
    );
    if (!acceptorIds.length) return [];
    let technicians = await this.userRepo.find({
      where: { id: In(acceptorIds), tenantId, status: UserStatus.ACTIVE },
      select: ['id', 'name', 'phone'],
      order: { id: 'ASC' },
    });
    if (!technicians.length) return [];
    // 报修类型配置选默认维修工：只列范围覆盖该管理处的人（officeScope=null 表示公司默认，只列全公司范围的）
    const coverage =
      officeScope !== undefined
        ? await this.accessService.filterUsersCoveringOffice(
            tenantId,
            technicians.map((item) => item.id),
            officeScope,
          )
        : null;
    if (coverage) technicians = technicians.filter((item) => coverage.has(item.id));
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
      /** 按管理处筛过时带上：all = 全公司范围，office = 只覆盖这个管理处 */
      scope: coverage?.get(item.id) ?? null,
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
  /**
   * 这张工单能领哪些料。
   *
   * 仓库按工单所在的小区 / 管理处自动匹配：同小区仓 > 同管理处仓（仓挂在该管理处下任一小区）
   * > 公司总仓（不挂小区）。以前是后台按「小区 + 报修类型」一格一格配（repair_type_warehouses），
   * 几十个格子总有漏配的，维修工那边就是「未配领料仓库」（2026-08-27 改）。
   * 匹配不到（仓都挂在别的管理处名下）时端上给「去建仓」的提示，同时留「换仓库」让维修工手动挑。
   *
   * 库存为 0 的材料也返回（标 qty=0）：现场需要它但仓里没有，正是要走缺料登记的场景，
   * 列表里看不到反而让人以为「这东西系统里不存在」。
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

    // 同小区仓 0 > 同管理处仓 1 > 公司总仓（不挂小区）2 > 别的管理处的仓 3；同级按 id
    const officeId = await this.accessService.officeIdOfCommunity(tenantId, workOrder.communityId);
    const officeCommunities = new Set(
      officeId ? await this.accessService.officeCommunityIds(tenantId, officeId) : [],
    );
    // 工单所在管理处没有仓时，退到维修工自己所属管理处的仓（角色范围 → 管理处 → 仓的 office_id），
    // 再退公司级（既不挂小区也不挂管理处）
    const mine = await this.accessService.userOfficeIds(tenantId, user.id);
    const myOffices = new Set(mine.officeIds);
    // 仓库挂了管理处就以管理处为准：小区和管理处对不上的仓（录错了小区）不能靠小区匹配成「同小区仓」
    const officeConsistent = (item: Warehouse) => !item.officeId || !officeId || item.officeId === officeId;
    const rank = (item: Warehouse) =>
      item.communityId === workOrder.communityId && officeConsistent(item)
        ? 0
        : (officeId && item.officeId === officeId) ||
            (item.communityId && officeCommunities.has(item.communityId) && officeConsistent(item))
          ? 1
          : item.officeId && myOffices.has(item.officeId)
            ? 2
            : !item.communityId && !item.officeId
              ? 3
              : 4;
    // 管理处范围的维修工只看得到本单所在管理处 / 自己管理处的仓（rank ≤ 2），公司级总仓和别家的仓
    // 连「换仓库」里都不列 —— 和员工端库存页 /warehouses?scope=mine 同一条规则；全公司范围的人不限
    const candidates = all
      .filter((item) => mine.all || rank(item) <= 2)
      .sort((a, b) => rank(a) - rank(b) || a.id - b.id);
    const mapped = candidates.find((item) => rank(item) <= 3) ?? null;
    const byRank = ['community', 'office', 'staff_office', 'company'] as const;
    const mappedBy = mapped ? byRank[rank(mapped) as 0 | 1 | 2 | 3] : null;

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
      /** 有没有自动匹配到仓；没有时端上给「去建仓」的提示（字段名沿用，老版本小程序还在读） */
      configured: !!mapped,
      /** 匹配到的是哪一级的仓：同小区 / 同管理处 / 公司总仓 */
      mappedBy,
      warehouses: candidates.map((item) => ({
        id: item.id,
        name: item.name,
        type: item.type,
        /** 就是本单自动匹配到的那个仓 */
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
    return resolveRepairTypeLabel(repairType, labels);
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

    // 带关键词时看板只数命中的单：和列表同一套匹配（见 keywordWheres），
    // 否则搜「198」列表两条、看板还是全公司的数，用的人会以为搜索没生效
    let byStatus: Partial<Record<WorkOrderStatus, number>>;
    if (query.q?.trim()) {
      const where: FindOptionsWhere<WorkOrder> = { tenantId };
      if (scope) where.communityId = In(scope);
      if (query.communityId) where.communityId = query.communityId;
      const wheres = await this.keywordWheres(tenantId, where, query.q);
      const matched = await this.workOrderRepo.find({
        where: wheres.length === 1 ? wheres[0] : wheres,
        select: ['id', 'status'],
      });
      byStatus = matched.reduce((acc, item) => {
        acc[item.status] = (acc[item.status] ?? 0) + 1;
        return acc;
      }, {} as Partial<Record<WorkOrderStatus, number>>);
    } else {
      const rows = await qb.groupBy('wo.status').getRawMany<{ status: WorkOrderStatus; count: string }>();
      byStatus = rows.reduce((acc, item) => {
        acc[item.status] = Number(item.count);
        return acc;
      }, {} as Partial<Record<WorkOrderStatus, number>>);
    }
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

  /**
   * 关键词 → 工单查询条件（列表和状态看板共用，口径必须一致）。
   * 一个框查四样：
   *   · 单号：orderNo 模糊
   *   · 地址：先按「弄/号/室」切成段（198/47/201、198弄47号201室 都行），
   *     每段按顺序模糊匹配 楼栋(弄/号)+房号；只敲「198」就是「地址里带 198 的楼栋」全部命中
   *   · 具体位置 / 故障描述：报修表上的自由文本模糊
   *   · 维修工：按姓名找到人，再按 assigneeId 命中
   * 命中一条都没有时必须返回只有单号条件的 where —— 没有约束会把全部工单列出来，看着像「搜索没生效」。
   */
  private async keywordWheres(
    tenantId: number,
    where: FindOptionsWhere<WorkOrder>,
    q: string | undefined,
  ): Promise<FindOptionsWhere<WorkOrder>[]> {
    const keyword = q?.trim();
    if (!keyword) return [where];
    const like = `%${keyword}%`;

    const [textHits, addressRequestIds, technicians] = await Promise.all([
      this.repairRequestRepo.find({
        where: [
          { tenantId, addressText: ILike(like) },
          { tenantId, content: ILike(like) },
        ],
        select: ['id'],
        take: 300,
      }),
      this.requestIdsByAddressTokens(tenantId, keyword),
      this.userRepo.find({ where: { tenantId, name: ILike(like) }, select: ['id'], take: 50 }),
    ]);

    const wheres: FindOptionsWhere<WorkOrder>[] = [{ ...where, orderNo: ILike(like) }];
    const requestIds = Array.from(new Set([...textHits.map((item) => item.id), ...addressRequestIds]));
    if (requestIds.length) wheres.push({ ...where, requestId: In(requestIds) });
    // 维修工本人只看自己的单（where 已带 assigneeId），这时按姓名找别人没有意义，也不能放开
    if (technicians.length && where.assigneeId === undefined) {
      wheres.push({ ...where, assigneeId: In(technicians.map((item) => item.id)) });
    }
    return wheres;
  }

  /** 「198/47/201」→ 命中的 requestId：三段及以上按房号找，两段以内按楼栋找（公区报修只挂楼栋） */
  private async requestIdsByAddressTokens(tenantId: number, keyword: string): Promise<number[]> {
    const tokens = tokenizeAddress(keyword).slice(0, 4);
    if (!tokens.length) return [];
    const pattern = `%${tokens.join('%')}%`;

    const houses = await this.dataSource
      .getRepository(House)
      .createQueryBuilder('h')
      .innerJoin(Building, 'b', 'b.id = h.buildingId AND b.tenantId = :tenantId', { tenantId })
      .select(['h.id', 'h.buildingId'])
      .where('h.tenantId = :tenantId', { tenantId })
      .andWhere(
        "((COALESCE(b.lane, '') || '/' || b.buildingNo || '/' || h.roomNo) ILIKE :pattern OR COALESCE(h.fullAddress, '') ILIKE :pattern)",
        { pattern },
      )
      .take(500)
      .getMany();
    const houseIds = houses.map((item) => item.id);

    let buildingIds: number[] = [];
    if (tokens.length <= 2) {
      const buildings = await this.dataSource
        .getRepository(Building)
        .createQueryBuilder('b')
        .select(['b.id'])
        .where('b.tenantId = :tenantId', { tenantId })
        .andWhere("(COALESCE(b.lane, '') || '/' || b.buildingNo) ILIKE :pattern", { pattern })
        .take(200)
        .getMany();
      buildingIds = buildings.map((item) => item.id);
    }
    if (!houseIds.length && !buildingIds.length) return [];

    const conditions: FindOptionsWhere<RepairRequest>[] = [];
    if (houseIds.length) conditions.push({ tenantId, houseId: In(houseIds) });
    if (buildingIds.length) conditions.push({ tenantId, buildingId: In(buildingIds) });
    const requests = await this.repairRequestRepo.find({
      where: conditions,
      select: ['id'],
      order: { id: 'DESC' },
      take: 300,
    });
    return requests.map((item) => item.id);
  }

  /**
   * 列表卡片上那一行地址：`枫桦景苑一期17号201室`。
   *
   * 带小区名 —— 只写「17号201室」，跨小区的列表里根本不知道是哪儿（2026-08-31 要求：
   * 卡片上地址独占一行，不再有下面那行小字）。
   * 弄号该不该留交给 formatAddressLine 判断（小区名里已经写了它、或者这个小区就一个弄
   * 就是废话；有好几个弄的小区一个都不能省）—— 规则和取舍见 common/address-line.util.ts。
   */
  private buildRequestAddressSummary(
    request:
      | Pick<RepairRequest, 'addressText' | 'houseId' | 'buildingId' | 'communityId'>
      | undefined,
    houseById: Map<number, Pick<House, 'id' | 'buildingId' | 'roomNo' | 'fullAddress'>>,
    buildingById: Map<number, Pick<Building, 'id' | 'lane' | 'buildingNo'>>,
    communityById?: Map<number, { name: string; laneCount: number }>,
  ) {
    if (!request) return '';
    const house = request.houseId ? houseById.get(request.houseId) : undefined;
    const buildingId = house?.buildingId ?? request.buildingId ?? undefined;
    const building = buildingId ? buildingById.get(buildingId) : undefined;
    const community = request.communityId ? communityById?.get(request.communityId) : undefined;
    if (community && building) {
      return formatAddressLine(community, building, house?.roomNo);
    }
    /**
     * 没传 communityById 的调用方（同楼栋历史报修：一屏里全是同一栋楼的单，
     * 再写一遍小区名是废话），以及落不到楼栋的单（公共区域、只填了自由文本），
     * 都保持原来的写法：楼栋房号优先，没有才回退到自由文本。
     */
    const parts = [
      building?.lane ? `${building.lane}弄` : '',
      building?.buildingNo ? `${building.buildingNo}号` : '',
      house?.roomNo ? `${house.roomNo}室` : '',
    ];
    return parts.filter(Boolean).join('') || request.addressText || community?.name || '';
  }

  /**
   * 这批小区的名字 + 有几个不同的「弄」。
   * 弄数量用来判断弄号是不是废话 —— 只有一个弄的小区，说了小区名就等于说了弄号。
   */
  private async communityAddressInfo(
    tenantId: number,
    communityIds: Array<number | null | undefined>,
  ): Promise<Map<number, { name: string; laneCount: number }>> {
    const ids = Array.from(new Set(communityIds.filter((id): id is number => !!id)));
    if (!ids.length) return new Map();
    const [communities, laneRows] = await Promise.all([
      this.communityRepo.find({ where: { tenantId, id: In(ids) }, select: ['id', 'name'] }),
      this.dataSource
        .getRepository(Building)
        .createQueryBuilder('b')
        .select('b.community_id', 'communityId')
        .addSelect('COUNT(DISTINCT b.lane)', 'laneCount')
        .where('b.tenant_id = :tenantId', { tenantId })
        .andWhere('b.community_id IN (:...ids)', { ids })
        .andWhere("COALESCE(b.lane, '') <> ''")
        .groupBy('b.community_id')
        .getRawMany<{ communityId: number; laneCount: string }>(),
    ]);
    const laneCountById = new Map(
      laneRows.map((row) => [Number(row.communityId), Number(row.laneCount)]),
    );
    return new Map(
      communities.map((item) => [
        item.id,
        { name: item.name, laneCount: laneCountById.get(item.id) ?? 0 },
      ]),
    );
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
    if ((await this.isSelfScoped(user, access)) && request?.submittedBy !== user.id) {
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

    // 进度里「员工小程序提交」要写清是哪位同事提交的：巡查顺手报的单，办公室和维修工
    // 得知道该找谁问现场情况（2026-08-27 要求）。业主提交的不动，报修人一栏已经有名字
    const submitter =
      request?.source === RepairSource.STAFF_MINIAPP && request.submittedBy
        ? await this.userRepo.findOne({
            where: { id: request.submittedBy, tenantId },
            select: ['id', 'name'],
          })
        : null;
    const staffSourceLabel = REPAIR_SOURCE_LABELS[RepairSource.STAFF_MINIAPP];
    const withSubmitter = (log: WorkOrderLog) => {
      const note = this.displayLogNote(log.note);
      const isCreate = log.action === 'create' || log.action === 'create_auto_assign';
      if (!submitter || !isCreate || !note?.startsWith(staffSourceLabel)) return note;
      return `${submitter.name || `#${submitter.id}`} 在${note}`;
    };

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
      logs: logs.map((log) => ({ ...log, note: withSubmitter(log) })),
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
    if (!(await this.accessService.userHasPermission(tenantId, assignee.id, 'app:pool', 'edit'))) {
      throw new BadRequestException(
        '这个人的角色没有勾「工单池 · 接单」，派给他他也接不了',
      );
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
      // 换了负责人就重新计时：上一个人没接单的催单记录，不该算在新人头上
      workOrder.escalatedAt = null;
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
        // 能不能从池子里领单，controller 上的 app:pool·接单 已经卡过了
        workOrder.assigneeId = user.id;
        workOrder.dispatchedAt = workOrder.dispatchedAt ?? new Date();
      } else {
        assertWorkOrderTransition(
          workOrder.status,
          WorkOrderStatus.IN_PROGRESS,
          'accept',
          'only dispatched work order can be accepted',
        );
        if (!(await this.canDispatch(user)) && workOrder.assigneeId !== user.id) {
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
      await this.ensureAssigneeOrAdmin(workOrder, user);

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
          note: item.note?.trim() || undefined,
        })).filter((item) => item.name || item.materialId) ?? workOrder.usedMaterials;
      workOrder.resultAttachments =
        dto.resultAttachments ?? workOrder.resultAttachments;
      workOrder.feeCents = dto.feeCents ?? workOrder.feeCents;
      workOrder.updatedBy = user.id;
      const saved = await manager.save(WorkOrder, workOrder);

      const inventoryMaterials = dto.materials?.filter((item) => item.materialId && item.warehouseId) ?? [];
      if (inventoryMaterials.length) {
        // 同一单已经记过用料（将来若允许退回重做）：先把上次扣的批次和数量原样冲回并留流水，
        // 再按这次提交的重新扣。以前这里只删记录不还库存，会双扣。
        const existingRows = await manager.find(WorkOrderMaterial, {
          where: { tenantId, workOrderId: saved.id },
        });
        if (existingRows.length) {
          const previousAllocations = await manager.find(WorkOrderMaterialAllocation, {
            where: { tenantId, workOrderMaterialId: In(existingRows.map((row) => row.id)) },
          });
          await restoreStockLots(manager, previousAllocations, user.id);
          for (const row of existingRows) {
            await applyStockDelta(manager, {
              tenantId,
              warehouseId: row.warehouseId,
              materialId: row.materialId,
              deltaQty: Number(row.qty),
              type: StockMovementType.ADJUST,
              unitCostCents: row.unitCostCents,
              refType: 'work_order',
              refId: saved.id,
              operatorId: user.id,
              note: `重新提交完工，冲回工单 ${saved.id} 上次领料`,
            });
          }
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
          const allocations = await consumeStockLots(manager, {
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
              unitCostCents: averageUnitCost(allocations, item.qty),
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
          await applyStockDelta(manager, {
            tenantId,
            warehouseId: item.warehouseId!,
            materialId: item.materialId!,
            deltaQty: -item.qty,
            type: StockMovementType.OUTBOUND,
            unitCostCents: averageUnitCost(allocations, item.qty),
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
      await this.ensureAssigneeOrAdmin(workOrder, user);

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

      // 通知负责派单的人有新的缺料申请待汇总（谁能派单就通知谁）
      const dispatcherIds = await this.accessService.userIdsWithPermission(
        tenantId,
        'app:dispatch',
        'edit',
      );
      const officeUsers = dispatcherIds.length
        ? await manager.find(User, {
            where: { id: In(dispatcherIds), tenantId, status: UserStatus.ACTIVE },
            select: ['id'],
          })
        : [];
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
        (await this.isSelfScoped(user)) &&
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
      if (await this.isSelfScoped(user)) {
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
      if (await this.isSelfScoped(user)) {
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

      // 第一次催办找派单的人，再催就往上找有审批权的（通常是经理）
      const isFirst = urgeCount === 0;
      const targetIds = await this.accessService.userIdsWithPermission(
        tenantId,
        isFirst ? 'app:dispatch' : 'app:approve-manager',
        'edit',
      );
      const receivers = await manager.find(User, {
        where: { id: In(targetIds.length ? targetIds : [-1]), tenantId, status: UserStatus.ACTIVE },
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
        // 只给语义字段，具体填到模板哪个 thing/time 由 notifications 按模板真实字段决定
        templateFields: {
          orderNo: workOrder.orderNo,
          type: typeLabel,
          status: assigneeName ? `已派单给${assigneeName}` : '已派单',
          statusShort: '已派单',
          content: request.content?.trim() || '',
          assignee: assigneeName || '物业维修工',
          address: request.addressText?.trim() || '',
          reporter: request.contactName?.trim() || '',
          time: when,
          reportedAt: this.formatWhen(new Date(workOrder.createdAt)),
          dueAt: this.formatDue(workOrder),
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
      templateFields: {
        orderNo: workOrder.orderNo,
        type: typeLabel,
        status: '已修好，待验收',
        statusShort: '待验收',
        content: request.content?.trim() || '',
        assignee: assigneeName || '物业维修工',
        address: request.addressText?.trim() || '',
        reporter: request.contactName?.trim() || '',
        time: when,
        reportedAt: this.formatWhen(new Date(workOrder.createdAt)),
        dueAt: this.formatDue(workOrder),
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
  /**
   * 新单进池子时通知类型里配的每一位维修工：站内信 + 微信订阅消息（模板和派单那条同一个）。
   * 点通知进详情页，详情页上就能接单；先接到的人拿走，其他人再点开会看到「已被 xx 接走」。
   *
   * **这个类型一个默认维修工都没配时，退一步通知能派单的人**（2026-08-31 加）：
   * 报修类型配置里绝大多数类型的「默认维修工」是空的，候选人算出来就是空数组，
   * 于是这个方法整个 for 循环空转 —— 新单一条通知都不发，而维修工的工单池又按
   * 「他被配进了哪些类型」过滤，这单对谁都不显示。等于业主报了修，没有一个人知道。
   * 办公室本来就该知道有新单进来，也是唯一能把它派出去的人，所以由他们兜这一手。
   */
  private async notifyCandidatesOnCreate(
    workOrder: WorkOrder,
    candidates: User[],
    submittedBy: number | null,
  ): Promise<void> {
    const request = await this.repairRequestRepo.findOne({
      where: { id: workOrder.requestId, tenantId: workOrder.tenantId },
    });
    // 走 findTypeRule 而不是直接按 repairType 查一行：类型规则按管理处分套，
    // 不带小区去找会拿到别的管理处（或公司模板）那条，类型名就显示成别人改过的叫法
    const rule = await this.findTypeRule(
      request?.repairType ?? undefined,
      workOrder.tenantId,
      workOrder.communityId,
    );
    const typeLabel = rule?.label || '报修';
    // 紧急写进标题第一格：站内信列表和微信订阅消息都只露出开头那几个字
    const urgentTag = request?.urgent ? '【紧急】' : '';
    const address = request?.addressText?.trim() || '（未填地址）';
    const content = request?.content?.trim() || '';
    const deadline = workOrder.slaDueAt
      ? `，${this.formatWhenShort(new Date(workOrder.slaDueAt))} 前完成`
      : '';
    const when = this.formatWhen(new Date());

    // 没有候选维修工就退给能派单的人。两拨人不叠加：配了维修工时办公室不再收，
    // 否则每来一单办公室都跟着响一次，真正要盯的「没人接的单」反而淹了
    const unassigned = !candidates.length;
    const receivers = unassigned
      ? await this.dispatchersToNotify(workOrder.tenantId, submittedBy)
      : candidates;
    if (!receivers.length) {
      // 兜底的兜底：连能派单的人都没有（角色没配全）。不出声的话，这单谁都不知道，
      // 而现场只会以为是「提醒又不灵了」——留一行日志，下次排查一眼看得到
      this.logger.warn(
        `新工单 ${workOrder.orderNo} 没有任何人可通知：类型「${request?.repairType || '未判定'}」` +
          `没配默认维修工，本公司也没有带「派单台 · 派单」权限的在职账号`,
      );
      return;
    }

    for (const receiver of receivers) {
      await this.notifications.notifyUser({
        tenantId: workOrder.tenantId,
        receiverId: receiver.id,
        eventKey: unassigned ? 'order_pool_unassigned' : 'order_pool_new',
        // 标题要写清该干什么：待派的单点进去是派单，待接的单点进去是接单，
        // 两种情况下这条提醒推给的是不同的人，措辞一样只会让人点开才知道要干嘛
        title: unassigned
          ? `${urgentTag}新工单待派：${typeLabel} · ${address}${deadline}`
          : `${urgentTag}新工单待接：${typeLabel} · ${address}${deadline}`,
        payload: { workOrderId: workOrder.id, orderNo: workOrder.orderNo, content },
        page: `pages/order-detail/order-detail?id=${workOrder.id}`,
        template: 'orderAssigned',
        templateFields: {
          orderNo: workOrder.orderNo,
          type: typeLabel,
          status: request?.urgent
            ? '紧急，请优先处理'
            : unassigned
              ? '新工单待派单'
              : '新工单待接单',
          statusShort: request?.urgent ? '紧急待派' : unassigned ? '待派单' : '待接单',
          content,
          assignee: '',
          address,
          reporter: request?.contactName?.trim() || '',
          time: when,
          reportedAt: this.formatWhen(new Date(workOrder.createdAt)),
          dueAt: this.formatDue(workOrder),
        },
      });
    }
  }

  /**
   * 能派单、且现在还在职的人。报单的人自己排除掉 —— 他刚点完提交，
   * 屏幕上就是「提交成功」，再推一条「有新工单」纯属噪音。
   */
  private async dispatchersToNotify(tenantId: number, exceptUserId: number | null): Promise<User[]> {
    const ids = (
      await this.accessService.userIdsWithPermission(tenantId, 'app:dispatch', 'edit')
    ).filter((id) => id !== exceptUserId);
    if (!ids.length) return [];
    return this.userRepo.find({ where: { id: In(ids), tenantId, status: UserStatus.ACTIVE } });
  }

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
      templateFields: {
        orderNo: workOrder.orderNo,
        type: typeLabel,
        status: '新工单待处理',
        statusShort: '待处理',
        content,
        assignee: '',
        address,
        reporter: request?.contactName?.trim() || '',
        time: this.formatWhen(new Date()),
        reportedAt: this.formatWhen(new Date(workOrder.createdAt)),
        dueAt: this.formatDue(workOrder),
      },
    });
  }

  /**
   * 派单后迟迟没人接单 → 催维修工一次 + 告诉办公室。定时任务每 10 分钟调一次。
   *
   * 为什么要有这一层：任何一条推送都可能被漏看（微信订阅额度用完、手机静音、人在忙）。
   * 与其指望「通知一定送达」，不如让**漏看一条不再是终点** —— 到点没接单就再催一次，
   * 同时让办公室看见「这单还没人接」，人能兜住机器兜不住的部分。
   *
   * 只催一次（escalatedAt 打标记）：每 10 分钟催一轮的话，同一张单会把维修工和
   * 办公室一起刷屏，最后谁都不看了。
   */
  async escalateStaleDispatchesAllTenants(): Promise<number> {
    // 派给了人还没接（dispatched）、和进了池子没人接（created）都要催 ——
    // 新单默认进池子不指派（见 createRepairAndWorkOrder），只盯 dispatched 的话这个功能等于没有
    const dispatched = await this.workOrderRepo.find({
      where: {
        status: In([WorkOrderStatus.CREATED, WorkOrderStatus.DISPATCHED]),
        escalatedAt: IsNull(),
      },
      select: ['id', 'tenantId', 'orderNo', 'requestId', 'communityId', 'assigneeId', 'status', 'createdAt', 'dispatchedAt', 'slaDueAt'],
      take: 500,
    });
    if (!dispatched.length) return 0;

    const tenantIds = [...new Set(dispatched.map((item) => item.tenantId))];
    const settingByTenant = new Map(
      await Promise.all(
        tenantIds.map(
          async (tenantId) =>
            [
              tenantId,
              (await this.settings.getSettingsByTenant(tenantId)).dispatchEscalation,
            ] as const,
        ),
      ),
    );

    const now = Date.now();
    // 只看最近一天派出去的单。
    // 上线那一刻，库里所有存量「已派单未接」的单 escalatedAt 都是空的 ——
    // 不设这道下限，第一轮定时任务会把积压了几个月的单一次性全催一遍，
    // 维修工和办公室同时被几十条消息刷屏。而且一张压了三天的单，
    // 再提醒一句「派单 60 分钟还没接」也已经没有意义了。
    const oldestDispatchedAt = now - 24 * 60 * 60 * 1000;
    const targets = dispatched.filter((item) => {
      const setting = settingByTenant.get(item.tenantId);
      if (!setting?.enabled) return false; // 该租户关掉了
      // 催办时段之外一条都不发。跳过而不是标记，窗口一开这些单照样会被催到
      if (!SettingsService.withinWindow(setting)) return false;
      // 派出去的从派单时刻算起；还在池子里的从建单时刻算起
      const since = item.assigneeId ? item.dispatchedAt : item.createdAt;
      if (!since) return false;
      const at = since.getTime();
      if (at < oldestDispatchedAt) return false;
      return at <= now - setting.acceptMinutes * 60 * 1000;
    });
    if (!targets.length) return 0;

    let done = 0;
    for (const workOrder of targets) {
      try {
        await this.escalateOne(
          workOrder,
          settingByTenant.get(workOrder.tenantId)?.acceptMinutes ?? 0,
        );
        done += 1;
      } catch (err) {
        // 一张单催失败不该让整轮停下
        this.logger.warn(
          `工单 ${workOrder.orderNo} 催单失败：${err instanceof Error ? err.message : err}`,
        );
      }
    }
    return done;
  }

  /**
   * 「催这单」该发给谁：派出去了就是那一位维修工，还在池子里就是这个类型配的每一位。
   * 自动催接单和办公室手动催修共用 —— 两处各写一套，改了一处另一处必然走偏。
   */
  private async urgeReceivers(
    workOrder: WorkOrder,
    repairType: string | null,
  ): Promise<number[]> {
    if (workOrder.assigneeId) return [workOrder.assigneeId];
    const candidates = await this.ruleCandidates(
      workOrder.tenantId,
      await this.findTypeRule(repairType ?? undefined, workOrder.tenantId, workOrder.communityId),
    );
    return candidates.map((c) => c.id);
  }

  /**
   * 办公室在工单详情里点「发送催单通知」：催维修工在要求完成截止日期前修完。
   *
   * 和定时的「超时没人接单」不是一回事：那个催的是**接单**、由系统按时限自动发；
   * 这个催的是**修完**、由人按当下情况发，所以不看催办时段、也不看那个开关 ——
   * 人主动点的，就该发出去。
   *
   * 5 分钟内不重复发：连点会把维修工的微信订阅额度烧光（一次同意只能推一条）。
   */
  async urgeRepair(id: number, user: AuthUser, access: ResolvedAccess) {
    const tenantId = this.resolveTenantId(user);
    const workOrder = await this.workOrderRepo.findOne({ where: { id, tenantId } });
    if (!workOrder) throw new NotFoundException('work order not found');
    if (
      workOrder.status === WorkOrderStatus.COMPLETED ||
      workOrder.status === WorkOrderStatus.CANCELLED
    ) {
      throw new BadRequestException('这单已经结束了，不用催');
    }
    // 数据范围受限的人只能催自己范围内的单，和改截止时间一个口径
    const scope = this.scopeIds(access);
    if (scope && !scope.includes(workOrder.communityId)) {
      throw new NotFoundException('work order not found');
    }

    const logRepo = this.dataSource.getRepository(WorkOrderLog);
    const recent = await logRepo.findOne({
      where: {
        workOrderId: id,
        action: 'urge_repair',
        createdAt: MoreThan(new Date(Date.now() - 5 * 60 * 1000)),
      },
      order: { id: 'DESC' },
    });
    if (recent) {
      throw new BadRequestException('刚催过（5 分钟内只发一条），别把维修工的提醒额度用光');
    }

    const request = await this.repairRequestRepo.findOne({
      where: { id: workOrder.requestId, tenantId },
      select: ['id', 'repairType', 'addressText', 'content', 'contactName'],
    });
    const rule = request?.repairType
      ? await this.repairTypeRuleRepo.findOne({ where: { tenantId, repairType: request.repairType } })
      : null;
    const typeLabel = rule?.label || '报修';
    const address = request?.addressText?.trim() || '（未填地址）';
    const due = workOrder.slaDueAt
      ? `，${this.formatWhenShort(new Date(workOrder.slaDueAt))} 前完成`
      : '';
    const page = `pages/order-detail/order-detail?id=${workOrder.id}`;
    // 状态词进 phrase 那一格，只收 5 个以内纯汉字
    const statusShort =
      workOrder.status === WorkOrderStatus.IN_PROGRESS
        ? '维修中'
        : workOrder.status === WorkOrderStatus.WAITING_MATERIAL
          ? '等材料'
          : '待接单';

    const receivers = await this.urgeReceivers(workOrder, request?.repairType ?? null);
    for (const receiverId of receivers) {
      await this.notifications.notifyUser({
        tenantId,
        receiverId,
        eventKey: 'order_urge_repair',
        title: `办公室催单：${typeLabel} · ${address}${due}`,
        payload: { workOrderId: workOrder.id, orderNo: workOrder.orderNo },
        page,
        template: 'orderUrge',
        templateFields: {
          orderNo: workOrder.orderNo,
          type: typeLabel,
          status: '办公室催单',
          statusShort,
          content: `办公室催单：${request?.content?.trim() || typeLabel}`,
          assignee: '',
          address,
          reporter: request?.contactName?.trim() || '',
          time: this.formatWhen(new Date()),
          reportedAt: this.formatWhen(new Date(workOrder.createdAt)),
          dueAt: this.formatDue(workOrder),
        },
      });
    }

    await logRepo.save(
      logRepo.create({
        tenantId,
        workOrderId: workOrder.id,
        fromStatus: workOrder.status,
        toStatus: workOrder.status,
        action: 'urge_repair',
        operatorId: user.id,
        note: receivers.length
          ? `办公室催单，已提醒 ${receivers.length} 人${due ? `（要求${due.replace('，', '')}）` : ''}`
          : '办公室催单，但这单还没有人可催（没派单、类型也没配默认维修工）',
        createdBy: user.id,
        updatedBy: user.id,
      }),
    );

    return { ok: true as const, notified: receivers.length };
  }

  private async escalateOne(workOrder: WorkOrder, minutes: number) {
    // 先打标记再发通知：反过来的话，通知发出去、打标记失败，下一轮会再催一次
    await this.workOrderRepo.update({ id: workOrder.id }, { escalatedAt: new Date() });

    const request = await this.repairRequestRepo.findOne({
      where: { id: workOrder.requestId, tenantId: workOrder.tenantId },
      select: ['id', 'repairType', 'addressText', 'content', 'contactName'],
    });
    const rule = request?.repairType
      ? await this.repairTypeRuleRepo.findOne({
          where: { tenantId: workOrder.tenantId, repairType: request.repairType },
        })
      : null;
    const typeLabel = rule?.label || '报修';
    const address = request?.addressText?.trim() || '（未填地址）';
    const pooled = !workOrder.assigneeId;
    const waited = pooled
      ? `进工单池 ${minutes} 分钟还没人接`
      : `已派单 ${minutes} 分钟还没接`;
    const page = `pages/order-detail/order-detail?id=${workOrder.id}`;

    // 1) 再催一次该接这单的人
    const receivers = await this.urgeReceivers(workOrder, request?.repairType ?? null);
    for (const receiverId of receivers) {
      await this.notifications.notifyUser({
        tenantId: workOrder.tenantId,
        receiverId,
        eventKey: 'order_accept_overdue',
        title: `还没接单：${typeLabel} · ${address}（${waited}）`,
        payload: { workOrderId: workOrder.id, orderNo: workOrder.orderNo },
        page,
        template: 'orderOverdue',
        templateFields: {
          orderNo: workOrder.orderNo,
          type: typeLabel,
          status: waited,
          statusShort: '待接单',
          // 前缀不能省：物业选的公共模板（物业报修提醒）没有「状态」这一格，
          // 不标一下的话，催办消息和新工单消息在微信里长得一模一样，维修工分不出这是催他
          content: `超时未接：${request?.content?.trim() || typeLabel}`,
          assignee: '',
          address,
          reporter: request?.contactName?.trim() || '',
          time: this.formatWhen(new Date()),
          reportedAt: this.formatWhen(new Date(workOrder.createdAt)),
          dueAt: this.formatDue(workOrder),
        },
      });
    }

    // 2) 告诉「能派单的人」这单卡住了。
    //    收件人按权限找（app:dispatch·派单），不按身份 —— 谁是办公室由角色矩阵说了算。
    //    一个都没有就不发：宁可不发，也不要退到租户超管那里把他的消息列表塞满，
    //    他不是处理派单的人。
    const assignee = workOrder.assigneeId
      ? await this.userRepo.findOne({
          where: { id: workOrder.assigneeId, tenantId: workOrder.tenantId },
          select: ['id', 'name'],
        })
      : null;
    const dispatcherIds = await this.accessService.userIdsWithPermission(
      workOrder.tenantId,
      'app:dispatch',
      'edit',
    );
    const watchers = dispatcherIds.length
      ? await this.userRepo.find({
          where: {
            id: In(dispatcherIds),
            tenantId: workOrder.tenantId,
            status: UserStatus.ACTIVE,
          },
          select: ['id'],
          take: 20,
        })
      : [];
    for (const watcher of watchers) {
      await this.notifications.notifyUser({
        tenantId: workOrder.tenantId,
        receiverId: watcher.id,
        eventKey: 'order_accept_overdue_office',
        title: `${pooled ? '还没人接单' : `${assignee?.name || '维修工'}还没接单`}：${typeLabel} · ${address}（${waited}）`,
        payload: { workOrderId: workOrder.id, orderNo: workOrder.orderNo },
        page,
      });
    }

    // 3) 进度时间轴上留一条，办公室点进详情能看到催过了
    await this.dataSource.getRepository(WorkOrderLog).save(
      this.dataSource.getRepository(WorkOrderLog).create({
        tenantId: workOrder.tenantId,
        workOrderId: workOrder.id,
        fromStatus: workOrder.status,
        toStatus: workOrder.status,
        action: 'escalate',
        operatorId: null,
        note: `${waited}，系统已再次提醒维修工并通知办公室`,
        createdBy: null,
        updatedBy: null,
      }),
    );
  }

  /** 列表标题里的短日期：「8月26日 18:00」，年份靠上下文 */
  private formatWhenShort(d: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  /**
   * 「截止时间」那一格：工单的要求完成截止日期。
   * 没设过截止的单退回当前时刻 —— 微信 time 类型不收空串，也不收「未设置」这种字，
   * 填当下读起来就是「该完成了」，比整条消息被拒收强。
   */
  private formatDue(workOrder: { slaDueAt?: Date | string | null }): string {
    return workOrder.slaDueAt
      ? this.formatWhen(new Date(workOrder.slaDueAt))
      : this.formatWhen(new Date());
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
    // 端上判不出类型（或压根是老版本没判）时服务端再判一次，判不出**落「其它」**。
    //
    // 这里原来写的是 `|| undefined`，和上面这句注释说的不是一回事，后果实测过
    // （2026-08-31 用户反馈「新工单怎么没有微信提醒了」）：类型为空 → findTypeRule
    // 返回 null → 一个候选维修工都算不出来 → 谁都不通知；而且维修工的工单池按
    // 「他被配进了哪些类型」过滤（technicianTypes），skill 为 NULL 的单对谁都不显示。
    // 单子就这么静悄悄躺在库里，只有办公室在后台翻才看得见。
    // 「其它」至少是个能挂人、能过滤、能在后台看出来的归属。
    const repairType =
      dto.repairType || (await this.guessRepairType(dto.content, tenantId, dto.communityId)) || 'other';
    // 类型规则只用来定时限和「该通知谁」：匹配到的维修工都收到通知、都在自己的工单池里看到，
    // 谁先接单归谁。原来是自动派给规则里唯一那个人（2026-08-28 之前），别的同类型维修工既没通知
    // 也看不到单，报单的人自己也找不到
    const typeRule = await this.findTypeRule(repairType, tenantId, dto.communityId);
    const candidates = await this.ruleCandidates(tenantId, typeRule);
    // 「这个要急修」以前只躺在描述文本里，派单的人得逐条读才看得见。
    // 端上认出来会带 urgent 上来（人当场点掉就是 false，听端上的）；
    // 不带这个字段的（老版本小程序、后台录入）在这里用同一份口径兜一次底，
    // 报修的每个入口一个都不漏 —— 判定见 common/repair-urgency.util
    const urgency = detectUrgency(dto.content);
    const urgent = dto.urgent ?? urgency.urgent;
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
          urgent,
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
          assigneeId: null,
          skill: repairType ?? null,
          status: WorkOrderStatus.CREATED,
          dispatchedAt: null,
          acceptedAt: null,
          completedAt: null,
          // 办公室录入时明确勾了截止时间就用它；没勾才落到类型规则里的默认时限。
          // 截止时间是内部管理承诺，业主端提交的这个字段不认
          slaDueAt:
            dto.slaDueAt && source !== RepairSource.OWNER_MINIAPP
              ? new Date(dto.slaDueAt)
              : typeRule?.slaHours
                ? new Date(Date.now() + typeRule.slaHours * 60 * 60 * 1000)
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
          action: 'create',
          operatorId: submittedBy,
          // 业主在小程序进度里能看到这一条，写中文，别把枚举值透出去。
          // 紧急要写明凭什么标的：只写「已按紧急处理」，报单的人会以为是物业定的，
          // 标错了也不知道该改哪句话
          note: [
            sourceLabel,
            urgent
              ? urgency.matched
                ? `已按紧急处理（描述里说了「${urgency.matched}」）`
                : '已按紧急处理'
              : '',
            // 没有候选人时也要写一句：进度里空着，办公室只会以为系统没动作。
            // 写的是系统做了什么（转成待派单），不是「谁收到了」—— 送达结果这里还不知道
            candidates.length
              ? `已通知维修工 ${candidates.map((c) => c.name || `#${c.id}`).join('、')}`
              : '这个类型还没配默认维修工，已转办公室派单',
          ]
            .filter(Boolean)
            .join('；'),
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

    // 类型里配的维修工每人一条「新工单」：站内信一定写，微信订阅消息尽力而为。
    // 通知失败只记日志，不能让报修提交失败（notifyUser 内部已兜住）
    if (candidates.length) {
      await this.notifyCandidatesOnCreate(created.workOrder, candidates, submittedBy);
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
    // 只替住户报修的人（保安、居委会…）只能报授权小区里的地址；
    // 物业内部人员（能看工单池/派单台的）不受这条限制
    if (user.role !== UserRole.OWNER && (await this.isSelfScoped(user))) {
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
  async parseRepairAddress(
    dto: ParseRepairAddressDto,
    user: AuthUser,
    access?: ResolvedAccess,
  ) {
    const tenantId = this.resolveTenantId(user);
    const candidate = extractAddressCandidate(dto.text);

    const communities = await this.communityRepo.find({
      where: { tenantId, enabled: true },
    });
    const parentIds = new Set(
      communities.map((c) => c.parentId).filter((id): id is number => !!id),
    );
    // 分组节点（「枫桦景苑」）不挂楼栋，候选只在叶子（分期或独立小区）里找
    let leaves = communities.filter((c) => !parentIds.has(c.id));
    // 数据范围收窄：枫桦景苑管理处的人报修，不该认到别的管理处的小区去。
    // 只在拿得到明确清单时收窄 —— scopeCommunityIds 返回 null 表示全公司范围或
    // 走业务身份的小程序请求，那种情况下按原样在全租户里找。
    const scope = scopeCommunityIds(access);
    if (scope?.length) leaves = leaves.filter((c) => scope.includes(c.id));
    if (!leaves.length) return { matched: false as const };

    // 上下文小区：端上传了就用它；业主没传就用他自己认证的那套房所在小区 ——
    // 随手拍不带 communityId，光靠「2号」这种孤零零的门牌会按 id 顺序撞到一期去
    // （2026-08-31 线上实测：二期的人报「监控室2号」认成了枫桦景苑一期 198弄2号）。
    const contextId = dto.communityId ?? (await this.ownCommunityId(tenantId, user));
    const context = contextId
      ? communities.find((c) => c.id === contextId) ?? null
      : null;
    const contextGroupId = context ? context.parentId ?? context.id : null;
    const nameById = new Map(communities.map((c) => [c.id, c.name] as const));

    // 「一期」优先解释成报修人所在分组里的分期；整个租户都没有这个分期时当没说
    let phaseLeaves: Community[] = [];
    if (candidate?.phase) {
      phaseLeaves = leaves.filter((c) => {
        const groupName = c.parentId ? nameById.get(c.parentId) ?? '' : '';
        const shortName =
          groupName && c.name.startsWith(groupName)
            ? c.name.slice(groupName.length)
            : c.name;
        return shortName === candidate.phase || c.name.endsWith(candidate.phase!);
      });
    }
    // 说了小区名就先按名字收敛：「吴泾新村3号102」不必再靠分期。
    // 撞不上库里的名字（语音把「枫桦」听成「风华」）就当没说过，退回按分期/号定位 ——
    // 名字是锦上添花，绝不能因为名字没对上就认不出地址。
    const nameLeaves = matchCommunityByName(candidate?.namePrefix, leaves);
    let pool: Community[];
    if (nameLeaves.length && phaseLeaves.length) {
      const phaseIds = new Set(phaseLeaves.map((c) => c.id));
      const both = nameLeaves.filter((c) => phaseIds.has(c.id));
      // 名字和分期对不上（说「吴泾新村一期」而库里吴泾新村没分期）：以分期为准，
      // 分期是数字，听错的概率比名字低
      pool = both.length ? both : phaseLeaves;
    } else if (nameLeaves.length) {
      pool = nameLeaves;
    } else {
      pool = phaseLeaves.length ? phaseLeaves : leaves;
    }
    const ranked = [...pool].sort((a, b) => {
      const rank = (c: Community) =>
        c.id === context?.id
          ? 0
          : contextGroupId !== null && c.parentId === contextGroupId
            ? 1
            : 2;
      return rank(a) - rank(b) || a.id - b.id;
    });

    // ---- 公区点位优先 ----
    // 监控室、门卫室、水泵房这些地方没有房号，靠数字永远认不出来；点位名是人自己
    // 在后台登记的，比「2号」这种数字可靠，所以先按名字认，认到就不再走门牌号那条路。
    const spot = await this.pickCommunitySpot(tenantId, dto.text, ranked);
    if (spot) {
      const community = ranked.find((c) => c.id === spot.communityId)!;
      const building = spot.buildingId
        ? await this.buildingRepo.findOne({
            where: { tenantId, id: spot.buildingId },
          })
        : null;
      const spotBuildingText = building
        ? `${building.lane ? building.lane + '弄' : ''}${building.buildingNo}号`
        : '';
      return {
        matched: true as const,
        level: building ? ('building' as const) : ('community' as const),
        communityId: community.id,
        communityName: community.name,
        buildingId: building?.id ?? null,
        buildingText: spotBuildingText,
        houseId: null,
        roomNo: null,
        spotName: spot.name,
        // 点位名本身就是「具体在哪」，不再缀「公共区域」占位
        addressText: [community.name, spotBuildingText, spot.name]
          .filter(Boolean)
          .join(' '),
        matchedText: spot.name,
        correctedText: null,
      };
    }

    if (!candidate) return { matched: false as const };

    // 只说了分期没说楼栋：定位到小区级就够了（「二期大门坏了」）
    if (!candidate.buildingNo) {
      // 只说位置不说楼栋（「二期大门坏了」「吴泾新村门口路灯不亮」）：
      // 分期或小区名认出唯一一个才算数，认出一堆等于没认出来
      if (!phaseLeaves.length && nameLeaves.length !== 1) {
        return { matched: false as const };
      }
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
        spotName: null,
        // 没有室号就是公区单，文案里写明白，派单的人一眼看出不是入户维修
        addressText: `${community.name} 公共区域`,
        matchedText: candidate.matchedText,
        matchedRaw: candidate.matchedRaw,
        correctedText: correctCommunityNameInText(
          dto.text,
          candidate,
          community.name,
          !!candidate.phase,
        ),
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
    /**
     * 这一行地址要走和工单卡片同一套去重：小区名叫「永北5511弄」时，
     * 再拼一遍 buildingText 就成了「永北5511弄 5511弄236号」（2026-09-01 反馈）。
     * 规则见 common/address-line.util.ts —— 弄号只在小区有好几个弄时才留。
     */
    const communityLine = formatAddressLine(
      (await this.communityAddressInfo(tenantId, [pickedCommunity.id])).get(pickedCommunity.id) ?? {
        name: pickedCommunity.name,
        laneCount: 0,
      },
      picked,
      house?.roomNo,
    );
    return {
      matched: true as const,
      level: houseId ? ('house' as const) : ('building' as const),
      communityId: pickedCommunity.id,
      communityName: pickedCommunity.name,
      buildingId: picked.id,
      buildingText,
      houseId,
      roomNo: house?.roomNo ?? null,
      spotName: null,
      // 连楼里哪个位置都没说的按公区单写，派单的人一眼看出不是入户维修
      addressText: roomText ? communityLine : `${communityLine} 公共区域`,
      matchedText: candidate.matchedText,
      /**
       * 地址在原话里占的那一段。端上剥故障描述要用它 ——
       * 用归一化的 matchedText 剥，小区名会剩在描述里
       */
      matchedRaw: candidate.matchedRaw,
      /**
       * 语音把小区名听成同音字时的正名版本（「风华一期17号」→「枫桦景苑一期17号」）；
       * 没什么好改的就是 null。端上拿它替换描述框里的文字。
       * 只有靠分期 / 弄这类**数字**定位到的小区才纠 —— 光靠门牌号撞出来的小区
       * 本来就可能撞到别家去，那种情况下改名字等于把错误坐实。
       */
      correctedText: correctCommunityNameInText(
        dto.text,
        candidate,
        pickedCommunity.name,
        !!(candidate.phase || candidate.lane),
      ),
    };
  }

  /**
   * 描述里认到哪个公区点位。
   *
   * 同名点位可能挂在好几个小区（每个小区都有门卫室），按 ranked 的顺序收敛 ——
   * ranked 第一档是报修人所在小区、第二档是同一个分组里的其它分期。
   * 排第一的没有比第二名更近（并列）时一律放弃：认成隔壁小区的门卫室，
   * 维修工照样白跑一趟，还不如不认、让人自己选位置。
   */
  private async pickCommunitySpot(
    tenantId: number,
    text: string,
    ranked: Community[],
  ): Promise<CommunitySpot | null> {
    if (!ranked.length) return null;
    const spots = await this.spotRepo.find({
      where: { tenantId, communityId: In(ranked.map((c) => c.id)), enabled: true },
    });
    if (!spots.length) return null;
    const hits = matchSpotsInText(text, spots);
    if (!hits.length) return null;
    const rankOf = new Map(ranked.map((c, index) => [c.id, index] as const));
    const sorted = [...hits].sort(
      (a, b) =>
        (rankOf.get(a.communityId) ?? 0) - (rankOf.get(b.communityId) ?? 0) ||
        a.id - b.id,
    );
    if (sorted.length === 1) return sorted[0];
    const first = rankOf.get(sorted[0].communityId) ?? 0;
    const second = rankOf.get(sorted[1].communityId) ?? 0;
    return first < second ? sorted[0] : null;
  }

  /**
   * 业主自己认证的那套房在哪个小区。随手拍不传 communityId 时用它兜底，
   * 免得「2号」这种孤零零的门牌按小区 id 顺序撞到别的小区去。
   * 员工/办公室账号没有 houseId，返回 null，由数据范围那一层收窄。
   */
  private async ownCommunityId(
    tenantId: number,
    user: AuthUser,
  ): Promise<number | null> {
    const self = await this.userRepo.findOne({
      where: { id: user.id, tenantId },
      select: ['id', 'houseId'],
    });
    if (!self?.houseId) return null;
    const house = await this.houseRepo.findOne({
      where: { tenantId, id: self.houseId },
      select: ['id', 'buildingId'],
    });
    if (!house) return null;
    const building = await this.buildingRepo.findOne({
      where: { tenantId, id: house.buildingId },
      select: ['id', 'communityId'],
    });
    return building?.communityId ?? null;
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
    // 开工后类型锁定：维修工已经按这个类型领料/派工，事后更正只会让轨迹对不上（后台详情同步置灰）
    const lockReason = repairTypeAndSlaLockReason(workOrder.status);
    if (lockReason) {
      throw new BadRequestException(`${lockReason}工单类型`);
    }
    const request = await this.repairRequestRepo.findOne({
      where: { id: workOrder.requestId, tenantId },
    });

    // 更正和学关键词都落在这单所属管理处那套规则上（没有自己那套就是公司默认）
    const rules = await this.rulesForCommunity(tenantId, workOrder.communityId);
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
        await this.learnKeywordsIntoRule(manager, target, learned, user.id);
        if (fromRule && fromRule.id !== target.id) {
          await this.unlearnKeywordsFromRule(manager, fromRule, learned, user.id);
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
   * 更正工单类型时，把关键词学进新类型。
   *
   * 落到哪一列取决于这条规则归谁：公司模板行写 content_suggestions（全公司立刻生效），
   * 管理处行写 extra_suggestions —— 现场一次更正只代表这个管理处的叫法，
   * 直接改模板等于替全公司做主。要收编成全公司通用词，去配置页的总公司那一页点一下。
   *
   * 传进来的是 rulesForCommunity 给的**副本**（contentSuggestions 已经掺了模板词），
   * 所以这里按 id 重新查实体再改，绝不能拿副本直接 save。
   */
  private async learnKeywordsIntoRule(
    manager: EntityManager,
    view: RepairTypeRuleView,
    learned: string[],
    operatorId: number,
  ) {
    const rule = await manager.findOne(RepairTypeRule, { where: { id: view.id } });
    if (!rule) return;
    // 学到的词插到最前面：这就是刚被误判的场景，下次要立刻生效
    if (rule.officeId === null) {
      rule.contentSuggestions = normalizeSuggestionList([
        ...learned,
        ...(rule.contentSuggestions ?? []),
      ]);
    } else {
      rule.extraSuggestions = normalizeSuggestionList([
        ...learned,
        ...(rule.extraSuggestions ?? []),
      ]);
      // 本处之前停用过这个词，现在人工把它判到这个类型上，等于要它回来
      rule.mutedSuggestions = (rule.mutedSuggestions ?? []).filter(
        (word) => !learned.includes(word),
      );
    }
    rule.updatedBy = operatorId;
    await manager.save(RepairTypeRule, rule);
  }

  /**
   * 从原类型里摘掉刚被学走的词，否则下次两边照旧五五开。
   *
   * 词是本处自己加的就直接删；是从公司模板继承来的就只在本处停用 ——
   * 模板是全公司共用的，不能因为一个管理处改了一单，就替所有管理处把词删掉。
   */
  private async unlearnKeywordsFromRule(
    manager: EntityManager,
    view: RepairTypeRuleView,
    learned: string[],
    operatorId: number,
  ) {
    const rule = await manager.findOne(RepairTypeRule, { where: { id: view.id } });
    if (!rule) return;
    let dirty = false;
    if (rule.officeId === null) {
      const remaining = (rule.contentSuggestions ?? []).filter((word) => !learned.includes(word));
      if (remaining.length !== (rule.contentSuggestions ?? []).length) {
        rule.contentSuggestions = remaining;
        dirty = true;
      }
    } else {
      const remaining = (rule.extraSuggestions ?? []).filter((word) => !learned.includes(word));
      if (remaining.length !== (rule.extraSuggestions ?? []).length) {
        rule.extraSuggestions = remaining;
        dirty = true;
      }
      const inherited = view.templateSuggestions.filter((word) => learned.includes(word));
      if (inherited.length) {
        rule.mutedSuggestions = Array.from(
          new Set([...(rule.mutedSuggestions ?? []), ...inherited]),
        );
        dirty = true;
      }
    }
    if (!dirty) return;
    rule.updatedBy = operatorId;
    await manager.save(RepairTypeRule, rule);
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
    // 开工后就不给改了：截止时间是排班依据，中途改等于把已排好的班打乱（后台详情同步置灰）
    const lockReason = repairTypeAndSlaLockReason(workOrder.status);
    if (lockReason) {
      throw new BadRequestException(`${lockReason}截止时间`);
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
      ? (await this.rulesForCommunity(tenantId, workOrder.communityId)).find(
          (rule) => rule.repairType === fromType,
        ) ?? null
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
  private async guessRepairType(
    content: string,
    tenantId: number,
    communityId?: number | null,
  ): Promise<string | null> {
    if (!content?.trim()) return null;
    const rules = (await this.rulesForCommunity(tenantId, communityId)).filter((rule) => rule.enabled);
    return classifyByKeywords(
      content,
      rules.map((rule) => ({
        repairType: rule.repairType,
        keywords: buildTypeKeywords(rule),
      })),
    );
  }

  /** 报修小区适用的那套规则里，这个类型的一条（停用的不算） */
  private async findTypeRule(
    repairType: string | undefined,
    tenantId: number,
    communityId?: number | null,
  ): Promise<RepairTypeRule | null> {
    if (!repairType) return null;
    return (
      (await this.rulesForCommunity(tenantId, communityId)).find(
        (item) => item.repairType === repairType && item.enabled,
      ) ?? null
    );
  }

  /**
   * 规则里配的默认维修工中，现在真能接单的那些：在职、角色勾了「工单池 · 接单」。
   * 配置之后被停用 / 改了角色的人自动剔除，不用回头改规则。
   */
  private async ruleCandidates(tenantId: number, rule: RepairTypeRule | null): Promise<User[]> {
    const ids = rule ? ruleAssigneeIds(rule) : [];
    if (!ids.length) return [];
    const users = await this.userRepo.find({ where: { id: In(ids), tenantId } });
    const picked: User[] = [];
    for (const id of ids) {
      const user = users.find((u) => u.id === id);
      if (!user || user.status !== UserStatus.ACTIVE) continue;
      if (!(await this.accessService.userHasPermission(tenantId, user.id, 'app:pool', 'edit'))) continue;
      picked.push(user);
    }
    return picked;
  }

  /** 后台提交的默认维修工：新字段优先，老字段兜底；去重、去空 */
  private dtoAssigneeIds(dto: UpsertRepairTypeRuleDto): number[] {
    const raw = dto.assigneeIds ?? (dto.assigneeId ? [dto.assigneeId] : []);
    return Array.from(new Set(raw.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0)));
  }

  /**
   * 这个维修工被配进了哪些类型（任意管理处那套都算）。工单池按它过滤。
   * 规则表一个公司就几十行，直接全拉；别为这个再建表
   */
  private async technicianTypes(tenantId: number, userId: number): Promise<string[]> {
    const rules = await this.repairTypeRuleRepo.find({ where: { tenantId, enabled: true } });
    return Array.from(
      new Set(rules.filter((rule) => ruleAssigneeIds(rule).includes(userId)).map((rule) => rule.repairType)),
    );
  }

  /** 工单池角标：和 scope=pool 同一套口径（未指派、未完结、按维修工类型过滤） */
  async poolCount(user: AuthUser, access: ResolvedAccess): Promise<{ count: number }> {
    const tenantId = this.resolveTenantId(user);
    const where: FindOptionsWhere<WorkOrder> = {
      tenantId,
      assigneeId: IsNull(),
      status: In([
        WorkOrderStatus.CREATED,
        WorkOrderStatus.DISPATCHED,
        WorkOrderStatus.WAITING_MATERIAL,
      ]),
    };
    if (!(await this.canDispatch(user, access))) {
      const types = await this.technicianTypes(tenantId, user.id);
      if (types.length) where.skill = In(types);
    }
    return { count: await this.workOrderRepo.count({ where }) };
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

    /*
     * 关键词分层的数据兜底（2026-08-31）。
     *
     * 线上 DB_SYNCHRONIZE=true，migrations 表压根不存在、迁移文件不会执行：
     * extra_suggestions / muted_suggestions 两列会被 synchronize 建出来，
     * 但 RepairKeywordTemplate 迁移里的**数据拆分不会跑**。不在这里补的话，
     * 各管理处早先攒的词还躺在 content_suggestions 里，而新代码只读 extra + 模板，
     * 等于那些词凭空消失 —— 猜你想输和类型判定会同时失灵。
     *
     * 幂等：拆完 content_suggestions 就空了，之后再也不进这个分支。
     * 跑过迁移的环境（本地 dev）到这里也已经是空的，不会重复拆。
     */
    const templateWords = new Map(
      existing
        .filter((rule) => rule.officeId === null)
        .map((rule) => [rule.repairType, rule.contentSuggestions ?? []] as const),
    );
    const needSplit = existing.filter(
      (rule) => rule.officeId !== null && (rule.contentSuggestions?.length ?? 0) > 0,
    );
    if (needSplit.length) {
      for (const rule of needSplit) {
        const template = templateWords.get(rule.repairType) ?? [];
        const own = rule.contentSuggestions ?? [];
        rule.extraSuggestions = Array.from(
          new Set([
            ...(rule.extraSuggestions ?? []),
            ...own.filter((word) => !template.includes(word)),
          ]),
        );
        // 模板里有、本处当初删掉的词：继续保持停用，别趁这次改造悄悄塞回去
        rule.mutedSuggestions = Array.from(
          new Set([
            ...(rule.mutedSuggestions ?? []),
            ...template.filter((word) => !own.includes(word)),
          ]),
        );
        rule.contentSuggestions = [];
        rule.updatedBy = operatorId;
      }
      await this.repairTypeRuleRepo.save(needSplit);
      this.logger.log(`报修关键词分层：拆开了 ${needSplit.length} 条管理处规则`);
    }

    // 懒补种子关键词：老租户的规则建于「猜你想输」可配置之前，content_suggestions 是空的。
    // 只填空，不覆盖租户已经维护过的词。
    // **只补公司模板行**：关键词改成模板叠加之后，管理处那些行的这一列本来就该一直是空的
    // （见 RepairTypeRule.contentSuggestions），照着补会把一整套种子词写死进每个管理处，
    // 模板从此改不动它们。
    const needSeed = existing.filter(
      (rule) =>
        rule.officeId === null &&
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

    // 仅首次初始化时播种公司默认模板；之后由租户自行增删，删除的类型不再自动补回
    if (existing.some((rule) => rule.officeId === null)) return;
    await this.repairTypeRuleRepo.save(
      DEFAULT_REPAIR_TYPES.map((item, index) =>
        this.repairTypeRuleRepo.create({
          tenantId,
          officeId: null,
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

  /**
   * 报修小区 → 所属管理处那套规则；管理处没有自己的一套（从没打开过配置页）就用公司默认。
   * 自动派单、类型判定、更正学词、业主端类型列表全走这一个口子，别各自查表。
   */
  private async rulesForCommunity(
    tenantId: number,
    communityId?: number | null,
  ): Promise<RepairTypeRuleView[]> {
    const templates = await this.templateRules(tenantId);
    const officeId = communityId
      ? await this.accessService.officeIdOfCommunity(tenantId, communityId)
      : null;
    if (officeId) {
      const own = await this.repairTypeRuleRepo.find({
        where: { tenantId, officeId },
        order: { sortOrder: 'ASC', id: 'ASC' },
      });
      // 关键词按模板叠加算出来。注意返回的是**副本**，contentSuggestions 已经掺了模板词，
      // 谁要落库必须按 id 重新查实体（见 learnKeywordsIntoRule）
      if (own.length) return toRuleViews(own, templates);
    }
    return toRuleViews(templates, templates);
  }

  private async assertOffice(tenantId: number, officeId: number) {
    const office = await this.dataSource
      .getRepository(ManagementOffice)
      .findOne({ where: { id: officeId, tenantId } });
    if (!office) throw new NotFoundException('管理处不存在');
    return office;
  }

  /**
   * 派单 / 设默认维修工前校验这个人真的能接单。
   * officeId 不传 = 只看能不能接单（派单用）；传了 = 还要看数据范围：
   * null（公司默认模板）只能选全公司范围的人，管理处那套要求范围覆盖该管理处。
   */
  private async assertAssignee(
    tenantId: number,
    assigneeId: number | null,
    officeId?: number | null,
  ) {
    if (!assigneeId) return;
    const assignee = await this.userRepo.findOne({ where: { id: assigneeId, tenantId } });
    if (!assignee || assignee.status !== UserStatus.ACTIVE) {
      throw new NotFoundException('assignee not found');
    }
    if (!(await this.accessService.userHasPermission(tenantId, assignee.id, 'app:pool', 'edit'))) {
      throw new BadRequestException(
        '这个人的角色没有勾「工单池 · 接单」，派给他他也接不了',
      );
    }
    if (officeId === undefined) return;
    const coverage = await this.accessService.filterUsersCoveringOffice(
      tenantId,
      [assignee.id],
      officeId,
    );
    const level = coverage.get(assignee.id);
    const name = assignee.name || `#${assignee.id}`;
    if (officeId === null && level !== 'all') {
      throw new BadRequestException(
        `${name} 是管理处专属维修工，公司默认模板只能选全公司范围的人；请到对应管理处那一页去选`,
      );
    }
    if (officeId !== null && !level) {
      const office = await this.assertOffice(tenantId, officeId);
      throw new BadRequestException(
        `${name} 的角色范围不含「${office.name}」，不能选为这个管理处的默认维修工`,
      );
    }
  }

  private async nextRepairTypeSortOrder(tenantId: number, officeId: number | null) {
    const row = await this.repairTypeRuleRepo
      .createQueryBuilder('rule')
      .select('COALESCE(MAX(rule.sort_order), 0)', 'max')
      .where('rule.tenant_id = :tenantId', { tenantId })
      .andWhere(officeId ? 'rule.office_id = :officeId' : 'rule.office_id IS NULL', { officeId })
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
  private async summarizeRepairContents(
    tenantId: number,
    knownPlaces: string[] = [],
    limitPerType = 8,
    communityIds?: number[] | null,
  ) {
    const rows = await this.repairRequestRepo.find({
      where: communityIds?.length
        ? { tenantId, communityId: In(communityIds) }
        : { tenantId },
      select: ['repairType', 'content', 'createdAt'],
      order: { id: 'DESC' },
      take: SUGGESTION_SCAN_LIMIT,
    });

    const byType = new Map<string, SuggestionBucket>();
    const general: SuggestionBucket = new Map();
    for (const row of rows) {
      // 原话先抽成「大门关不上」这种关键信息，门牌、人名、语气词不进标签（见 extractContentGist）
      const text = extractContentGist(String(row.content ?? ''), knownPlaces);
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

  /**
   * 「具体位置」的猜你想输：从历史地址里抽位置本身，再从报修原话里认场所词。
   * 地址原来是整条贴出来的（「枫桦景苑二期/228弄2号 大门」），门牌在房号那一栏已经填过，
   * 这里只该出「大门」。
   */
  private async summarizeSpots(
    tenantId: number,
    knownPlaces: string[],
    limit: number,
    communityIds?: number[] | null,
  ) {
    const rows = await this.repairRequestRepo.find({
      where: communityIds?.length
        ? { tenantId, communityId: In(communityIds) }
        : { tenantId },
      select: ['addressText', 'content', 'createdAt'],
      order: { id: 'DESC' },
      take: SUGGESTION_SCAN_LIMIT,
    });
    const bucket: SuggestionBucket = new Map();
    for (const row of rows) {
      const spot = extractSpot(String(row.addressText ?? ''), knownPlaces) || findSpotWord(String(row.content ?? ''));
      const key = normalizeSuggestionText(spot);
      if (!key) continue;
      collectSuggestion(bucket, key, spot, row.createdAt);
    }
    return rankSuggestions(bucket, limit);
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

  private async lockWorkOrder(manager, id: number, tenantId: number) {
    const workOrder = await manager.findOne(WorkOrder, {
      where: { id, tenantId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!workOrder) throw new NotFoundException('work order not found');
    return workOrder;
  }

  /** 单不在自己手上就不许动 —— 能派单的人（办公室/经理）不受此限 */
  private async ensureAssigneeOrAdmin(workOrder: WorkOrder, user: AuthUser) {
    if (!(await this.canDispatch(user)) && workOrder.assigneeId !== user.id) {
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

  /**
   * 只能看/操作自己提的那些单。
   *
   * 业主天然如此。员工侧看的是「有没有工单池 / 派单台 / 后台工单管理的查看权」——
   * 一个都没有，说明他只是替住户报修的人（保安、居委会、业委会…），
   * 不该看到别人的单。以前这里写死一份 SELF_SCOPED_ROLES 身份名单，
   * 新增一种代报身份忘了加进去，就会掉进「无过滤」分支 = 泄露全租户工单。
   */
  private async isSelfScoped(user: AuthUser, access?: ResolvedAccess): Promise<boolean> {
    if (user.role === UserRole.OWNER) return true;
    if (user.role === UserRole.SUPERADMIN) return false;
    const resolved = access ?? (await this.accessService.getAccess(user));
    if (resolved.isPlatformAdmin || resolved.isTenantAdmin) return false;
    const pages = resolved.pages;
    return !(
      pages['app:pool']?.view ||
      pages['app:dispatch']?.view ||
      pages['work-orders']?.view
    );
  }

  /** 能不能派单（决定「在手工单」默认口径、能不能操作别人手上的单） */
  private async canDispatch(user: AuthUser, access?: ResolvedAccess): Promise<boolean> {
    if (user.role === UserRole.OWNER) return false;
    const resolved = access ?? (await this.accessService.getAccess(user));
    if (resolved.isPlatformAdmin || resolved.isTenantAdmin) return true;
    return !!(resolved.pages['app:dispatch']?.edit || resolved.pages['work-orders']?.edit);
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
