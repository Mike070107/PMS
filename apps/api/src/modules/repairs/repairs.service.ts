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
  Raw,
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
import { RepairTextAiService } from '../ai/repair-text.ai';
import { AiFeedbackService } from '../ai/ai-feedback.service';
import { classifyPublicAreaText } from './repair-public-area.util';
import { formatAddressLine } from '../../common/address-line.util';
import { detectUrgency } from '../../common/repair-urgency.util';
import { repairTypeAndSlaLockReason } from '../../common/work-order-stage';
import {
  compareNameAlphabetically,
  compareWorkOrderPriority,
} from '../../common/list-order';
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
  MaintenanceOrder,
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
  WorkOrderCompletionBatch,
  WorkOrderLog,
  WorkOrderMaterial,
  WorkOrderMaterialAllocation,
  type SuggestionScope,
  type WorkOrderSnapshot,
} from '../../entities';
import {
  AssignWorkOrderDto,
  AddWorkOrderProgressDto,
  CancelWorkOrderDto,
  CompleteWorkOrderDto,
  CreateRepairRequestDto,
  DeleteWorkOrderDto,
  MaterialUsageDto,
  NeedMaterialDto,
  ParseRepairAddressDto,
  RequestWorkOrderTransferDto,
  ReviewWorkOrderDto,
  RollbackWorkOrderDto,
  UpdateMissingMaterialsDto,
  UpdateOfficeSuggestionSettingsDto,
  UpdateWorkOrderRepairTypeDto,
  UpdateWorkOrderSlaDto,
  UpsertRepairTypeRuleDto,
  WorkOrdersQueryDto,
  VoidWorkOrderDto,
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
  refreshMaterialReferenceCost,
  restoreStockLots,
} from '../inventory/stock-ledger';
import { ObjectStorageService } from '../upload/object-storage.service';
import { buildTypeKeywords, classifyByKeywords } from './repair-classify.util';
import {
  assertWorkOrderTransition,
  resolveRollback,
  workOrderStatusLabel,
  type RollbackResolution,
} from './work-order-state-machine';
import { nextPurchaseRequestNo } from '../inventory/purchase-request-no.util';
import { nextPurchaseStatus, pendingStepFor } from '../inventory/purchase-flow';
import {
  DEFAULT_REPAIR_TYPES,
  LEGACY_REPAIR_TYPE_MAP,
  resolveRepairTypeLabel,
} from './repair-type-labels';
import { MAINTENANCE_STATUS } from '../../entities/maintenance-order.entity';

/** 撤回预览里的一行退料 */
export interface RollbackMaterialLine {
  usageId: number;
  materialId: number;
  name: string;
  qty: number;
  warehouseId: number;
  warehouseName: string;
}

/**
 * 一次撤回会发生什么。预览接口和执行逻辑共用同一份判定，
 * 前端不许再自己推导「将退回哪个状态」——那份硬编码在旁路节点上必然出错。
 */
export interface RollbackPlan {
  allowed: boolean;
  blockedReason?: string;
  /** 被撤销的业务动作 */
  action?: string;
  actionLabel?: string;
  sourceLogId?: number;
  fromStatus: WorkOrderStatus;
  fromStatusLabel: string;
  targetStatus?: WorkOrderStatus;
  targetStatusLabel?: string;
  restoreAssigneeId?: number | null;
  restoreAssigneeName?: string | null;
  restoreRepairType?: string | null;
  willReturnMaterials: boolean;
  materialLines: RollbackMaterialLine[];
  materialTotalQty: number;
  completionBatchId?: number | null;
  completionBatchVersion?: number | null;
  purchaseRequests: Array<{
    id: number;
    requestNo: string;
    status: PurchaseRequestStatus;
    willReject: boolean;
  }>;
  maintenanceOrder: { id: number; willVoid: boolean } | null;
  reviewWillReverse: boolean;
  /** false = 老日志没有快照，只能恢复状态，界面上要提示人工核对 */
  usedSnapshot: boolean;
}

/** 轨迹和撤回弹窗里显示的动作名；界面上不许出现 need_material 这种编码 */
const ROLLBACK_ACTION_LABELS: Record<string, string> = {
  assign: '派单',
  auto_dispatch: '自动派单',
  accept: '接单',
  claim: '接单',
  complete: '完工提交',
  need_material: '提报缺料',
  transfer_request: '转单',
  review: '验收',
  auto_review_complete: '系统自动完成',
  cancel: '撤销工单',
};

/** 工单池只包含尚未开工、可以被主动接单的状态。 */
const CLAIMABLE_WORK_ORDER_STATUSES: WorkOrderStatus[] = [
  WorkOrderStatus.CREATED,
  WorkOrderStatus.WAITING_MATERIAL,
];

/**
 * 「已完结」那一档的终态：待验收 / 已完成 / 已撤单。
 * 作废单另有「已作废」入口，不混进来。和员工端 utils/order-status.ts 的
 * ACTIVE_STATUSES 是同一条线的两边：那边列「还要动手的」，这边列「已经结束的」。
 */
const FINISHED_WORK_ORDER_STATUSES: WorkOrderStatus[] = [
  WorkOrderStatus.DONE_PENDING_REVIEW,
  WorkOrderStatus.COMPLETED,
  WorkOrderStatus.CANCELLED,
];

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
    /** 一句话报修的语义整理。没配大模型时它一律返回 null，整条链路退回规则 */
    private readonly repairTextAi: RepairTextAiService,
    private readonly aiFeedback: AiFeedbackService,
  ) {}

  /**
   * 启动时把历史工单号统一成新规则。放在启动里而不是留个手工接口：
   * 手工的那种迟早忘了跑，列表里就一直两种格式混排。已合规的单不动，重启也不会反复换号。
   */
  async onModuleInit() {
    try {
      await this.recoverLegacyVoidedWorkOrders();
      await this.renumberLegacyOrderNos();
      await this.backfillCompletionBatches();
    } catch (error) {
      // 迁移失败不能拦住服务启动 —— 报修比单号好看重要
      this.logger.error(
        `工单号迁移失败：${error instanceof Error ? error.message : error}`,
      );
    }
  }

  /**
   * 存量用料补上「完工批次」归属。和迁移 1789088400000 的 SQL 同一口径。
   *
   * 为什么要在服务里再做一遍：线上 DB_SYNCHRONIZE=true，`migrations` 表根本不存在，
   * **migration 文件一句都不会跑**。新列会被 synchronize 建出来、默认值填上，
   * 但 UPDATE / INSERT 不执行 —— 结果是所有历史待验收工单都查不到有效完工批次，
   * 撤回完工时静默地不退料，退回旧的错误行为，而且没有任何报错（2026-08-31 踩过同类坑）。
   *
   * 幂等：只处理 completion_batch_id IS NULL 的行，且工单还没有批次时才建。
   * **不动任何库存数量**；对不上的记录由 tools/work-order-material-audit.mjs 出清单，人工核对。
   */
  private async backfillCompletionBatches(): Promise<void> {
    const pending: Array<{ n: string }> = await this.dataSource.query(
      `SELECT COUNT(*)::text AS n FROM work_order_materials WHERE completion_batch_id IS NULL`,
    );
    if (!Number(pending[0]?.n ?? 0)) return;

    await this.dataSource.query(
      `UPDATE work_order_materials SET source_action = 'legacy_issue' WHERE completion_batch_id IS NULL`,
    );
    await this.dataSource.query(`
      INSERT INTO work_order_completion_batches (
        tenant_id, work_order_id, version_no, status, from_status,
        submitted_by, submitted_at, snapshot, created_by, updated_by
      )
      SELECT wo.tenant_id, wo.id, 1, 'active', NULL,
             wo.updated_by, COALESCE(wo.completed_at, wo.updated_at),
             jsonb_build_object(
               'legacy', true,
               'faultLocation', wo.fault_location,
               'faultSymptom', wo.fault_symptom,
               'repairContent', wo.repair_content,
               'actionTags', wo.action_tags,
               'actionNote', wo.action_note,
               'resultAttachments', wo.result_attachments,
               'feeCents', wo.fee_cents,
               'materials', COALESCE(
                 (SELECT jsonb_agg(jsonb_build_object(
                           'materialId', m.material_id,
                           'warehouseId', m.warehouse_id,
                           'qty', m.qty
                         ))
                    FROM work_order_materials m
                   WHERE m.tenant_id = wo.tenant_id AND m.work_order_id = wo.id),
                 '[]'::jsonb)
             ),
             wo.updated_by, wo.updated_by
        FROM work_orders wo
       WHERE wo.status IN ('done_pending_review', 'completed')
         AND NOT EXISTS (
           SELECT 1 FROM work_order_completion_batches b
            WHERE b.tenant_id = wo.tenant_id AND b.work_order_id = wo.id
         )
    `);
    const linked = await this.dataSource.query(`
      UPDATE work_order_materials m
         SET completion_batch_id = b.id
        FROM work_order_completion_batches b
       WHERE b.tenant_id = m.tenant_id
         AND b.work_order_id = m.work_order_id
         AND m.completion_batch_id IS NULL
      RETURNING m.id
    `);
    this.logger.log(
      `完工批次补迁移完成：${Array.isArray(linked) ? linked.length : 0} 条历史用料已归入兼容批次（库存数量未改动）`,
    );
  }

  /**
   * 报修类型规则按管理处分套：officeId 为空 = 公司默认模板；
   * 管理处第一次打开配置页时从模板复制一份（懒复制），之后各改各的、互不影响。
   *
   * 关键词是例外：不复制、按模板叠加下发（见 toRuleViews）。返回的
   * contentSuggestions 是**生效关键词**，另外带 templateSuggestions / extraSuggestions /
   * mutedSuggestions 三层来源给配置页分开显示。
   */
  async listRepairTypeRules(
    user: AuthUser,
    officeId?: number | null,
    access?: ResolvedAccess,
  ) {
    const tenantId = this.resolveTenantId(user);
    await this.assertRuleOfficeInScope(tenantId, officeId ?? null, access);
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
    access?: ResolvedAccess,
  ) {
    const tenantId = this.resolveTenantId(user);
    await this.assertRuleOfficeInScope(tenantId, officeId, access);
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

  async createRepairTypeRule(
    dto: UpsertRepairTypeRuleDto,
    user: AuthUser,
    access?: ResolvedAccess,
  ) {
    const tenantId = this.resolveTenantId(user);
    const officeId = dto.officeId ?? null;
    await this.assertRuleOfficeInScope(tenantId, officeId, access);
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
        const name = officeName.get(id) ?? '未知管理处';
        throw new BadRequestException(
          `「${word}」在「${name}」已经是「${label}」的本处关键词，加进公司模板会和那边撞车。` +
            `请先去「${name}」那一页把它删掉，再回来加。`,
        );
      }
    }
  }

  async updateRepairTypeRule(
    id: number,
    dto: UpsertRepairTypeRuleDto,
    user: AuthUser,
    access?: ResolvedAccess,
  ) {
    const tenantId = this.resolveTenantId(user);
    const rule = await this.repairTypeRuleRepo.findOne({ where: { id, tenantId } });
    if (!rule) throw new NotFoundException('repair type rule not found');
    await this.assertRuleOfficeInScope(tenantId, rule.officeId, access);
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

  async deleteRepairTypeRule(id: number, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.resolveTenantId(user);
    const rule = await this.repairTypeRuleRepo.findOne({ where: { id, tenantId } });
    if (!rule) throw new NotFoundException('repair type rule not found');
    await this.assertRuleOfficeInScope(tenantId, rule.officeId, access);
    await this.repairTypeRuleRepo.remove(rule);
    return { ok: true };
  }

  async reorderRepairTypeRules(
    ids: number[],
    user: AuthUser,
    access?: ResolvedAccess,
  ) {
    const tenantId = this.resolveTenantId(user);
    if (!ids.length) return this.listRepairTypeRules(user, null, access);

    const rules = await this.repairTypeRuleRepo.find({ where: { tenantId } });
    const ruleById = new Map(rules.map((rule) => [rule.id, rule]));
    for (const id of ids) {
      if (!ruleById.has(id)) throw new NotFoundException('repair type rule not found');
    }
    const officeIds = new Set(ids.map((id) => ruleById.get(id)?.officeId ?? null));
    if (officeIds.size !== 1) {
      throw new BadRequestException('只能调整同一个管理处内的报修类型顺序');
    }
    const officeId = [...officeIds][0];
    await this.assertRuleOfficeInScope(tenantId, officeId, access);

    ids.forEach((id, index) => {
      const rule = ruleById.get(id)!;
      rule.sortOrder = (index + 1) * 10;
      rule.updatedBy = user.id;
    });
    await this.repairTypeRuleRepo.save(ids.map((id) => ruleById.get(id)!));
    return this.listRepairTypeRules(user, officeId, access);
  }

  /**
   * 旧版把“作废”实现成了软删除。新口径要求作废单仍能在调度台筛选，
   * 因此启动时把历史软删除记录恢复为明确的 voided 状态。
   */
  private async recoverLegacyVoidedWorkOrders() {
    await this.dataSource.transaction(async (manager) => {
      await manager.query(
        `UPDATE repair_requests rr
            SET deleted_at = NULL
          WHERE rr.deleted_at IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM work_orders wo
               WHERE wo.request_id = rr.id
                 AND wo.tenant_id = rr.tenant_id
                 AND wo.deleted_at IS NOT NULL
            )`,
      );
      await manager.query(
        `UPDATE work_orders
            SET status = $1, deleted_at = NULL
          WHERE deleted_at IS NOT NULL`,
        [WorkOrderStatus.VOIDED],
      );
    });
  }

  private async assertRuleOfficeInScope(
    tenantId: number,
    officeId: number | null,
    access?: ResolvedAccess,
  ) {
    const scope = scopeCommunityIds(access);
    if (!scope) return;
    if (!officeId) {
      throw new ForbiddenException('全公司报修类型模板只能由全公司数据范围的账号维护');
    }
    const ids = await this.accessService.officeCommunityIds(tenantId, officeId);
    if (!ids.length || ids.some((id) => !scope.includes(id))) {
      throw new NotFoundException('管理处不存在');
    }
  }

  /** 报修类型的对外精简版：只给编码、名称和关键词，不含派单规则 */
  async listPublicRepairTypes(
    user: AuthUser,
    communityId?: number | null,
    access?: ResolvedAccess,
  ) {
    const tenantId = this.resolveTenantId(user);
    const allowed = scopeCommunityIds(access);
    if (communityId && allowed && !allowed.includes(communityId)) {
      throw new NotFoundException('community not found');
    }
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
        configuredKeywords: rule.contentSuggestions ?? [],
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
    const corrections = await this.dataSource
      .getRepository(RepairTypeCorrection)
      .createQueryBuilder('correction')
      .innerJoin(WorkOrder, 'wo', 'wo.id = correction.work_order_id AND wo.tenant_id = correction.tenant_id')
      .where('correction.tenant_id = :tenantId', { tenantId })
      .andWhere('wo.status <> :voided', { voided: WorkOrderStatus.VOIDED })
      .orderBy('correction.id', 'DESC')
      .take(500)
      .getMany();
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
    access?: ResolvedAccess,
  ) {
    const tenantId = this.resolveTenantId(user);
    let scope = await this.suggestionScope(tenantId, opts);
    const allowed = scopeCommunityIds(access);
    if (allowed) {
      const restrict = (ids: number[] | null) =>
        ids ? ids.filter((id) => allowed.includes(id)) : [...allowed];
      scope = {
        ...scope,
        companyCommunityIds: restrict(scope.companyCommunityIds),
        officeCommunityIds: restrict(scope.officeCommunityIds),
      };
    }
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

  async submitOwnerRepair(
    dto: CreateRepairRequestDto,
    user: AuthUser,
    access?: ResolvedAccess,
  ) {
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

    // 员工端的报修入口也必须服从角色的数据范围。此前这里只校验租户，
    // 导致维修工可通过手改 communityId 把单报到同公司其它管理处。
    const scope = scopeCommunityIds(access);
    if (scope && !scope.includes(dto.communityId)) {
      throw new ForbiddenException('该小区不在你的管理范围内');
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
    let whereVariants: FindOptionsWhere<WorkOrder>[] = [where];
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
    } else {
      // 作废单只在明确选择“已作废”时出现，避免混入日常调度和各端默认列表。
      where.status = Not(WorkOrderStatus.VOIDED);
    }

    // 列表接口被多个小程序页面复用，Guard 只能判断「拥有其中任意一格」，
    // 具体 scope 仍必须在这里逐档校验。否则同时拥有「在手工单 + 我的报修」的人
    // 可以手改 scope=pool 绕过工单池权限，拆权限反而扩大了可见范围。
    if (user.role !== UserRole.OWNER) {
      const resolved = access ?? (await this.accessService.getAccess(user));
      const privileged =
        resolved.isPlatformAdmin ||
        resolved.isTenantAdmin ||
        !!resolved.pages['work-orders']?.view;
      if (!privileged) {
        const allowed =
          query.scope === 'reported'
            ? !!resolved.pages['app:my-repairs']?.view
            : query.scope === 'pool'
              ? !!(
                  resolved.pages['app:pool']?.view ||
                  resolved.pages['app:dispatch']?.view
                )
              : query.scope === 'dispatch'
                ? !!resolved.pages['app:dispatch']?.view
              : query.scope === 'mine'
                ? !!resolved.pages['app:my-orders']?.view
                : query.scope === 'all'
                  ? !!resolved.pages['app:dispatch']?.view
                  : query.scope === 'done'
                    // 已完结：有工单池 / 派单台 / 在手工单任一格的人都能看（范围在下面按人收敛）；
                    // 只报修的人没有这一档，他看「我报的」
                    ? !!(
                        resolved.pages['app:pool']?.view ||
                        resolved.pages['app:dispatch']?.view ||
                        resolved.pages['app:my-orders']?.view
                      )
                    : true;
        if (!allowed) throw new ForbiddenException('没有查看这类工单的权限');
      }
    }

    // 小程序角色按人收敛可见范围，后台角色维持全租户。
    // 业主端身份不止 OWNER：保安/居委/业委/物业工作人员也在业主端提单，
    // 漏了他们要么 403、要么（更糟）落到无过滤分支看到全租户的单
    if (user.role === UserRole.OWNER) {
      const myRequestIds = await this.repairRequestRepo.find({
        where: { tenantId, submittedBy: user.id },
        select: ['id'],
        order: { id: 'DESC' },
        take: 200,
      });
      if (!myRequestIds.length) return [];
      where.requestId = In(myRequestIds.map((item) => item.id));
    } else if (query.scope === 'mine') {
      // 「在手工单」是一个明确的人身范围：无论这个人是否同时拥有派单台、后台工单管理、
      // 企业管理员等更宽权限，只要请求 scope=mine，就只能返回 assignee_id=本人。
      // 这档必须放在其它角色/权限分流之前，避免宽权限把“我的”解释成“我能管理的”。
      where.assigneeId = user.id;
      if (!query.status) {
        where.status = Not(In([WorkOrderStatus.CREATED, WorkOrderStatus.DISPATCHED, WorkOrderStatus.VOIDED]));
      }
    } else if (query.scope === 'done') {
      // 「已完结」= 已经结束的单（待验收 / 已完成 / 已撤单）。谁能看多宽（2026-09-04 定）：
      //   · 办公室（派单台 / 后台工单管理 / 企业管理员）= 管理处数据范围内的全部；
      //   · 维修工 = 自己这一类别的单：类型规则里把他列为默认维修工的那些类型（skill），
      //     再加上派给他 / 候选里有他的单。不能只给「自己修的」—— 那样办公室看不到
      //     本管理处的已完工单，电工也看不到别的电工修过的单，经验没法互通。
      //   · 「在手工单」（scope=mine）仍然只认 assignee 本人，那是人身范围，不动。
      if (
        query.status &&
        !FINISHED_WORK_ORDER_STATUSES.includes(query.status as WorkOrderStatus)
      ) {
        return [];
      }
      if (!query.status) where.status = In(FINISHED_WORK_ORDER_STATUSES);
      const resolved = access ?? (await this.accessService.getAccess(user));
      if (!this.canSeeWholeScope(resolved)) {
        const myTypes = await this.repairTypesAssignedTo(tenantId, user.id);
        const base = { ...where };
        whereVariants = [
          { ...base, assigneeId: user.id },
          {
            ...base,
            candidateIds: Raw((alias) => `${alias} @> CAST(:me AS jsonb)`, {
              me: JSON.stringify([user.id]),
            }),
          },
          ...(myTypes.length ? [{ ...base, skill: In(myTypes) }] : []),
        ];
      }
    } else if (await this.isSelfScoped(user, access)) {
      const myRequestIds = await this.repairRequestRepo.find({
        where: { tenantId, submittedBy: user.id },
        select: ['id'],
        order: { id: 'DESC' },
        take: 200,
      });
      if (!myRequestIds.length) return [];
      where.requestId = In(myRequestIds.map((item) => item.id));
    } else if (query.scope === 'dispatch') {
      // 派单台只处理“没有任何去向”的新单。报修类型已经匹配出候选维修工并发过通知的，
      // candidate_ids 非空，直接留在维修工工单池等待抢单，不再让办公室重复派一次。
      if (query.status && query.status !== WorkOrderStatus.CREATED) return [];
      where.assigneeId = IsNull();
      where.candidateIds = Raw((alias) => `jsonb_array_length(${alias}) = 0`);
      where.status = WorkOrderStatus.CREATED;
    } else if (query.scope === 'pool') {
      // scope=pool 是一个待接池：公开待接单 + 定向派给当前人的待接单。
      // 定向派单在本人点击“接单”之前不能提前进入“在手工单”。
      if (
        query.status &&
        ![
          ...CLAIMABLE_WORK_ORDER_STATUSES,
          WorkOrderStatus.DISPATCHED,
        ].includes(query.status as WorkOrderStatus)
      ) {
        return [];
      }
      // 工单池和用户是否同时拥有派单权限无关；两格权限同时勾选时也不能串台。
      // 可见小区仍由 access 的 community scope 限制，不会跨管理处。
      if (query.status === WorkOrderStatus.DISPATCHED) {
        where.status = WorkOrderStatus.DISPATCHED;
        where.assigneeId = user.id;
      } else if (!query.status) {
        // TypeORM 的 where 数组表达 OR：公开池不限制负责人；定向待接只允许本人看。
        const base = { ...where };
        whereVariants = [
          { ...base, status: In(CLAIMABLE_WORK_ORDER_STATUSES) },
          { ...base, status: WorkOrderStatus.DISPATCHED, assigneeId: user.id },
        ];
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
    } else if (!(await this.canDispatch(user, access))) {
      // 「在手工单」= 派到我头上的单，对谁都是这个意思。
      // 原来这一档只认 TECHNICIAN，办公室带 scope=mine 会掉进无过滤分支，
      // 把全公司的工单当成「我手上的」列出来。
      // 维修工不带 scope 时仍然默认只看自己的单 —— 这条不能丢，丢了就是越权看全公司。
      where.assigneeId = user.id;
      // “在手工单”只放真正已经接下、正在处理或已处理过的单；尚未接的定向派单
      // 留在工单池。scope=mine 仍保留已完结状态，供“已完结”页复用。
      if (!query.status) {
        where.status = Not(In([WorkOrderStatus.CREATED, WorkOrderStatus.DISPATCHED, WorkOrderStatus.VOIDED]));
      }
    }

    const wheres = (
      await Promise.all(whereVariants.map((variant) => this.keywordWheres(tenantId, variant, query.q)))
    ).flat();

    const workOrderWhere = wheres.length === 1 ? wheres[0] : wheres;
    // 必须在数据库取前 100 条之前完成优先级排序。以前先拿最新 100 条、回来后才
    // 把急单提到前面，会漏掉更早的急单，也会让同组的新单排在老单前面。
    // 单测里的轻量仓库桩只有 find；生产仓库走带报修表联查的完整排序。
    // 「已完结」是终态清单，最近结束的排前面 —— 沿用「先报先修」的升序会让 100 条截断
    // 只剩最老的那批，最近修完的一张都看不到。
    const finishedFirst = query.scope === 'done';
    const workOrders = typeof (this.workOrderRepo as any).createQueryBuilder === 'function'
      ? await (() => {
          const qb = this.workOrderRepo
            .createQueryBuilder('wo')
            .innerJoin(
              RepairRequest,
              'request',
              'request.id = wo.requestId AND request.tenantId = wo.tenantId',
            )
            .setFindOptions({ where: workOrderWhere })
            // TypeORM 在 join + take 场景会包一层 DISTINCT 子查询。排序字段如果
            // 没进入内层 SELECT，外层会引用不存在的 request_urgent / request_created_at。
            .addSelect(['request.urgent', 'request.createdAt']);
          if (finishedFirst) {
            qb.orderBy('wo.completedAt', 'DESC', 'NULLS LAST').addOrderBy('wo.id', 'DESC');
          } else {
            qb.orderBy('request.urgent', 'DESC')
              .addOrderBy('request.createdAt', 'ASC')
              .addOrderBy('wo.id', 'ASC');
          }
          return qb.take(100).getMany();
        })()
      : await this.workOrderRepo.find({
          where: workOrderWhere,
          order: { id: finishedFirst ? 'DESC' : 'ASC' },
          take: 100,
        });
    const requestIds = workOrders.map((item) => item.requestId);
    if (!requestIds.length) return workOrders;

    const requests = await this.repairRequestRepo.find({
      where: { tenantId, id: In(requestIds) },
      select: ['id', 'repairType', 'houseId', 'buildingId', 'communityId', 'addressText', 'content', 'attachments', 'contactName', 'reporterRole', 'source', 'urgent', 'submittedBy', 'createdAt'],
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
    const submitterIds = Array.from(
      new Set(requests.map((item) => item.submittedBy).filter((id): id is number => !!id)),
    );
    const submitters = submitterIds.length
      ? await this.userRepo.find({
          where: { tenantId, id: In(submitterIds) },
          select: ['id', 'name', 'wxNickname'],
        })
      : [];
    const submitterNameById = new Map(
      submitters.map((item) => [item.id, item.name || item.wxNickname || '未记录姓名']),
    );
    const rows = workOrders.map((item) => {
      const repairType = requestById.get(item.requestId)?.repairType ?? item.skill;
      return {
        ...item,
        // 列表上的“报修时间”以报修表提交时间为准，不拿稍后生成工单的时间代替。
        createdAt: requestById.get(item.requestId)?.createdAt ?? item.createdAt,
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
        /**
         * 报修时拍的照片，卡片上直接给缩略图（2026-09-01 要求）。
         *
         * 只挑图片、最多 4 张：卡片是用来扫的，视频没有封面帧、在列表里只能是个黑块，
         * 留给详情页。photoCount 给的是**图片总数**，卡片上「+N」按它算。
         */
        photos: pickPhotos(requestById.get(item.requestId)?.attachments),
        photoCount: countPhotos(requestById.get(item.requestId)?.attachments),
        assigneeName: item.assigneeId
          ? assigneeNameById.get(item.assigneeId) ?? '未知维修工'
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
        submittedByName: (() => {
          const id = requestById.get(item.requestId)?.submittedBy;
          return id ? submitterNameById.get(id) ?? '未记录姓名' : null;
        })(),
      };
    });
    // 工单池、在手工单和 Web 调度台统一：紧急 / 超时风险优先，
    // 同一天内再按完整地址自然排序，让同小区、同楼栋的工单相邻，减少往返。
    // 数据库先保证紧急与老单进入前 100 条；地址和 SLA 需要关联数据齐全后在这里精排。
    rows.sort(compareWorkOrderPriority);
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
    communityScope?: number,
    skillScope?: string,
  ) {
    const tenantId = this.resolveTenantId(user);
    if (officeScope === undefined && communityScope) {
      officeScope = await this.accessService.officeIdOfCommunity(tenantId, communityScope);
    }
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

    let result = technicians.map((item) => ({
      id: item.id,
      name: item.name || '未命名员工',
      phone: item.phone ?? null,
      skills: skillsByUser.get(item.id) ?? [],
      openCount: openCount.get(item.id) ?? 0,
      /** 按管理处筛过时带上：all = 全公司范围，office = 只覆盖这个管理处 */
      scope: coverage?.get(item.id) ?? null,
    }));
    if (skillScope) {
      const rule = await this.findTypeRule(skillScope, tenantId, communityScope);
      const configuredIds = new Set(rule ? ruleAssigneeIds(rule) : []);
      result = result.filter(
        (item) => item.skills.includes(skillScope) || configuredIds.has(item.id),
      );
    }
    return result;
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
  async listWorkOrderStockOptions(
    id: number,
    user: AuthUser,
    access?: ResolvedAccess,
    warehouseId?: number,
  ) {
    const tenantId = this.resolveTenantId(user);
    const workOrder = await this.workOrderRepo.findOne({ where: { id, tenantId } });
    if (!workOrder) throw new NotFoundException('work order not found');
    this.assertWorkOrderScope(workOrder, access);

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
    const extraWarehouseIds = new Set(
      await this.accessService.extraWarehouseIdsOfUser(tenantId, user.id),
    );
    const smartWarehouseId = await this.accessService.smartWarehouseIdOfUser(tenantId, user.id);
    const candidates = all
      .filter((item) => mine.all || rank(item) <= 2 || extraWarehouseIds.has(item.id))
      .sort(
        (a, b) =>
          Number(b.id === smartWarehouseId) - Number(a.id === smartWarehouseId) ||
          rank(a) - rank(b) ||
          a.id - b.id,
      );
    // 智能化维修工首次打开优先选专属仓；仓不存在/被停用时才退回原来的管理处匹配规则。
    const smartWarehouse = smartWarehouseId
      ? candidates.find((item) => item.id === smartWarehouseId) ?? null
      : null;
    const mapped = smartWarehouse ?? candidates.find((item) => rank(item) <= 3) ?? null;
    const byRank = ['community', 'office', 'staff_office', 'company'] as const;
    const mappedBy = smartWarehouse
      ? 'staff_skill'
      : mapped
        ? byRank[rank(mapped) as 0 | 1 | 2 | 3]
        : null;

    const stockRepo = this.dataSource.getRepository(Stock);
    const allStocks = candidates.length
      ? await stockRepo.find({
          where: { tenantId, warehouseId: In(candidates.map((item) => item.id)) },
        })
      : [];
    const stockedWarehouses = new Set(
      allStocks.filter((row) => Number(row.qty) > 0).map((row) => row.warehouseId),
    );

    // 智能化维修工首次打开默认专属仓；手动换仓后仍尊重端上传来的 warehouseId。
    const warehouse = warehouseId
      ? candidates.find((item) => item.id === warehouseId) ?? null
      : mapped;

    const materials = await this.dataSource.getRepository(Material).find({
      where: { tenantId, enabled: true },
    });
    materials.sort((a, b) => compareNameAlphabetically(a.name, b.name) || a.id - b.id);
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
        // 多图一起给：点开大图要能左右滑着看完（正面/侧面/铭牌/包装）
        photoUrls: (item.photoUrls || [])
          .map((url) => this.storage.toDisplayUrl(url) || '')
          .filter(Boolean),
        aliases: item.aliases || [],
        qty: qtyByMaterial.get(item.id) ?? 0,
      })),
    };
  }

  /** 材料 id → 「名称（型号）」。查不到就让调用方兜「未知材料」，别把 id 当名字 */
  private async materialNamesByIds(
    manager: EntityManager,
    tenantId: number,
    materialIds: number[],
  ): Promise<Map<number, string>> {
    const ids = [...new Set(materialIds)];
    if (!ids.length) return new Map();
    const rows = await manager.find(Material, { where: { tenantId, id: In(ids) } });
    return new Map(
      rows.map((m) => [m.id, m.spec ? `${m.name}（${m.spec}）` : m.name]),
    );
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
        select: ['id', 'status', 'assigneeId', 'candidateIds'],
      });
      byStatus = matched.reduce((acc, item) => {
        // 调度台的 CREATED 数字表达“办公室还要派多少单”，不是所有正在等接单的新单。
        if (
          item.status === WorkOrderStatus.CREATED &&
          (item.assigneeId || item.candidateIds?.length)
        ) return acc;
        acc[item.status] = (acc[item.status] ?? 0) + 1;
        return acc;
      }, {} as Partial<Record<WorkOrderStatus, number>>);
    } else {
      const rows = await qb.groupBy('wo.status').getRawMany<{ status: WorkOrderStatus; count: string }>();
      byStatus = rows.reduce((acc, item) => {
        acc[item.status] = Number(item.count);
        return acc;
      }, {} as Partial<Record<WorkOrderStatus, number>>);
      // CREATED 里有两种业务含义：候选维修工非空的是“待接单”，不再进入办公室派单台。
      const pendingDispatch = this.workOrderRepo
        .createQueryBuilder('wo')
        .where('wo.tenant_id = :tenantId', { tenantId })
        .andWhere('wo.status = :created', { created: WorkOrderStatus.CREATED })
        .andWhere('wo.assignee_id IS NULL')
        .andWhere("jsonb_array_length(wo.candidate_ids) = 0");
      if (scope) pendingDispatch.andWhere('wo.community_id IN (:...scope)', { scope });
      if (query.communityId) {
        pendingDispatch.andWhere('wo.community_id = :communityId', { communityId: query.communityId });
      }
      byStatus[WorkOrderStatus.CREATED] = await pendingDispatch.getCount();
    }
    // 已作废数量供单独筛选展示，但不计入正常工单总数和经营口径。
    const total = Object.entries(byStatus).reduce(
      (sum, [status, count]) => status === WorkOrderStatus.VOIDED ? sum : sum + (count || 0),
      0,
    );
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
      where: { tenantId, requestId: In(requestIds), status: Not(WorkOrderStatus.VOIDED) },
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

    return requests.filter((request) => workOrderByRequestId.has(request.id)).map((request) => {
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
    const operatorIds = Array.from(
      new Set(logs.map((log) => log.operatorId).filter((operatorId): operatorId is number => !!operatorId)),
    );
    const operators = operatorIds.length
      ? await this.userRepo.find({
          where: { tenantId, id: In(operatorIds) },
          select: ['id', 'name', 'wxNickname'],
        })
      : [];
    const operatorNameById = new Map(
      operators.map((operator) => [operator.id, operator.name || operator.wxNickname || '未记录姓名']),
    );
    // 详情权限按「这张单与本人是什么关系」校验：
    // - 我的报修：必须是本人提交；
    // - 在手工单：必须派给本人；
    // - 工单池/派单台/后台工单管理：沿用其较宽的查看范围（仍受上面小区范围约束）。
    if (user.role === UserRole.OWNER) {
      if (request?.submittedBy !== user.id) throw new NotFoundException('work order not found');
    } else {
      const resolved = access ?? (await this.accessService.getAccess(user));
      const broad =
        resolved.isPlatformAdmin ||
        resolved.isTenantAdmin ||
        !!resolved.pages['work-orders']?.view ||
        !!resolved.pages['app:pool']?.view ||
        !!resolved.pages['app:dispatch']?.view;
      const assignedToMe =
        !!resolved.pages['app:my-orders']?.view && workOrder.assigneeId === user.id;
      const reportedByMe =
        !!resolved.pages['app:my-repairs']?.view && request?.submittedBy === user.id;
      if (!broad && !assignedToMe && !reportedByMe) {
        throw new NotFoundException('work order not found');
      }
    }
    // 他既然点开了这张单，指向它的未读站内信（新工单 / 派单 / 催单 / 缺料待办…）就算看过了，
    // 消息中心不再显示未读（2026-09-06 Mike）。权限校验过了才标，失败不影响详情返回。
    void this.notifications.markReadByRef(user, { workOrderId: id });
    // 先做完工单关系权限校验再读领料，不让无权用户借用料查询探测工单是否存在。
    const materialUsages = await this.dataSource.query(
      `SELECT wom.id,
              wom.material_id AS "materialId",
              wom.warehouse_id AS "warehouseId",
              wom.qty,
              wom.created_at AS "createdAt",
              m.name,
              m.spec,
              m.unit,
              w.name AS "warehouseName"
         FROM work_order_materials wom
         JOIN materials m ON m.id = wom.material_id AND m.tenant_id = wom.tenant_id
         JOIN warehouses w ON w.id = wom.warehouse_id AND w.tenant_id = wom.tenant_id
        WHERE wom.tenant_id = $1 AND wom.work_order_id = $2
          AND wom.status = 'active'
        ORDER BY wom.id ASC`,
      [tenantId, id],
    );
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
      return `${submitter.name || '未命名员工'} 在${note}`;
    };

    /**
     * 完工被撤回后，把上一次提交的内容当草稿带回来（照片、备注、收费、材料清单）。
     *
     * 不带回来的话维修工要把整张表重填一遍，实测的结果是他随手提交一个空的，
     * 把原来的完工照片和说明全冲掉。材料只是草稿：**重新提交时才会再次扣库**。
     */
    const latestBatch = await this.dataSource.getRepository(WorkOrderCompletionBatch).findOne({
      where: { tenantId, workOrderId: id },
      order: { versionNo: 'DESC' },
    });
    const completionDraft =
      latestBatch &&
      latestBatch.status === 'reversed' &&
      [WorkOrderStatus.IN_PROGRESS, WorkOrderStatus.WAITING_MATERIAL].includes(workOrder.status)
        ? {
            fromBatchId: latestBatch.id,
            fromBatchVersion: latestBatch.versionNo,
            reversedAt: latestBatch.reversedAt,
            reverseReason: latestBatch.reverseReason,
            notice: '上一次完工用料已退回库存。下面是原用料草稿，重新提交后才会再次扣库。',
            ...latestBatch.snapshot,
            resultAttachments: this.storage.toDisplayUrls(
              latestBatch.snapshot?.resultAttachments ?? [],
            ),
          }
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
          ? assignee?.name || '未知维修工'
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
      logs: logs.map((log) => ({
        ...log,
        operatorName: log.operatorId ? operatorNameById.get(log.operatorId) ?? '未知操作人' : null,
        note: withSubmitter(log),
        attachments: this.storage.toDisplayUrls(log.attachments || []),
      })),
      materialUsages: (materialUsages as Array<Record<string, unknown>>).map((row) => ({
        ...row,
        id: Number(row.id),
        materialId: Number(row.materialId),
        warehouseId: Number(row.warehouseId),
        qty: Number(row.qty),
      })),
      completionDraft,
    };
  }

  /** 办公室/管理员作废工单：退料、排除统计，但完整记录仍可筛选和查看。 */
  async voidWorkOrder(
    id: number,
    dto: VoidWorkOrderDto,
    user: AuthUser,
    access?: ResolvedAccess,
  ) {
    const reason = dto.reason?.trim();
    if (!reason || reason.length < 2) {
      throw new BadRequestException('请填写至少 2 个字的作废原因');
    }
    if (dto.confirmReversal !== true) {
      throw new BadRequestException('请确认退回用料并从统计中排除该工单');
    }
    if (!(await this.canVoid(user, access))) {
      throw new ForbiddenException('你的账号没有作废工单的权限，请管理员在「业务角色」里勾上「作废工单」');
    }

    const tenantId = this.resolveTenantId(user);
    return this.dataSource.transaction(async (manager) => {
      const workOrder = await this.lockWorkOrder(manager, id, tenantId);
      this.assertWorkOrderScope(workOrder, access);
      if (workOrder.status === WorkOrderStatus.VOIDED) {
        throw new BadRequestException('该工单已经作废');
      }
      const fromStatus = workOrder.status;
      const repairRequest = await manager.findOne(RepairRequest, {
        where: { tenantId, id: workOrder.requestId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!repairRequest) throw new NotFoundException('repair request not found');

      const maintenanceOrder = await manager
        .createQueryBuilder(MaintenanceOrder, 'mo')
        .setLock('pessimistic_write')
        .where('mo.tenant_id = :tenantId AND mo.work_order_id = :id', { tenantId, id })
        .andWhere("mo.status <> 'void'")
        .orderBy('mo.id', 'DESC')
        .getOne();
      if (maintenanceOrder && maintenanceOrder.status !== MAINTENANCE_STATUS.FILLING) {
        throw new BadRequestException('该工单的养护单已进入签字流程，请先在养护单页面作废');
      }

      const usages = await manager.find(WorkOrderMaterial, {
        where: { tenantId, workOrderId: id, status: 'active' },
        order: { id: 'ASC' },
        lock: { mode: 'pessimistic_write' },
      });
      const allocationByUsage = new Map<number, WorkOrderMaterialAllocation[]>();
      for (const usage of usages) {
        const allocations = await manager.find(WorkOrderMaterialAllocation, {
          where: { tenantId, workOrderMaterialId: usage.id },
          order: { id: 'ASC' },
        });
        const allocatedQty = allocations.reduce((sum, item) => sum + Number(item.qty), 0);
        if (Math.abs(allocatedQty - Number(usage.qty)) > 0.005) {
          throw new BadRequestException(
            `用料 #${usage.id} 的批次记录不完整，已停止删除以免库存错账，请联系管理员核对`,
          );
        }
        const lotIds = [...new Set(allocations.map((item) => item.stockLotId))];
        const lotCount = lotIds.length
          ? await manager.count(StockLot, { where: { tenantId, id: In(lotIds) } })
          : 0;
        if (lotCount !== lotIds.length) {
          throw new BadRequestException(
            `用料 #${usage.id} 的原库存批次不存在，已停止删除以免库存错账，请联系管理员核对`,
          );
        }
        allocationByUsage.set(usage.id, allocations);
      }

      workOrder.voidedBy = user.id;
      workOrder.voidReason = reason;
      workOrder.voidSnapshot = {
        voidedAt: new Date().toISOString(),
        status: workOrder.status,
        assigneeId: workOrder.assigneeId,
        feeCents: workOrder.feeCents,
        usedMaterials: workOrder.usedMaterials ?? [],
        missingMaterials: workOrder.missingMaterials ?? [],
        actionTags: workOrder.actionTags ?? [],
        actionNote: workOrder.actionNote,
        faultLocation: workOrder.faultLocation,
        faultSymptom: workOrder.faultSymptom,
        repairContent: workOrder.repairContent,
        repairRequest: {
          id: repairRequest.id,
          source: repairRequest.source,
          communityId: repairRequest.communityId,
          buildingId: repairRequest.buildingId,
          houseId: repairRequest.houseId,
          addressText: repairRequest.addressText,
          contactName: repairRequest.contactName,
          contactPhone: repairRequest.contactPhone,
          repairType: repairRequest.repairType,
          content: repairRequest.content,
          urgent: repairRequest.urgent,
          attachments: repairRequest.attachments,
          submittedBy: repairRequest.submittedBy,
        },
        materialUsages: usages.map((usage) => ({
          id: usage.id,
          materialId: usage.materialId,
          warehouseId: usage.warehouseId,
          qty: Number(usage.qty),
          unitCostCents: usage.unitCostCents,
          totalCostCents: usage.totalCostCents,
          allocations: (allocationByUsage.get(usage.id) ?? []).map((item) => ({
            stockLotId: item.stockLotId,
            qty: Number(item.qty),
            unitCostCents: item.unitCostCents,
            amountCents: item.amountCents,
          })),
        })),
      };
      workOrder.status = WorkOrderStatus.VOIDED;
      workOrder.updatedBy = user.id;
      await manager.save(WorkOrder, workOrder);

      const touchedMaterialIds = new Set<number>();
      let returnedQty = 0;
      for (const usage of usages) {
        const allocations = allocationByUsage.get(usage.id) ?? [];
        await restoreStockLots(manager, allocations, user.id);
        const { movement } = await applyStockDelta(manager, {
          tenantId,
          warehouseId: usage.warehouseId,
          materialId: usage.materialId,
          deltaQty: Number(usage.qty),
          type: StockMovementType.RETURN,
          unitCostCents: usage.unitCostCents,
          refType: 'work_order_void_return',
          refId: usage.id,
          operatorId: user.id,
          note: `作废工单退料：${workOrder.orderNo}`,
          reversalOfMovementId: usage.issueMovementId ?? null,
        });
        // 退料只标冲销、不删记录：原 FIFO 成本、原仓、原数量是成本报表还原历史的唯一依据，
        // 删掉之后「这单当初到底扣了哪批货」再也答不出来（2026-09-03 改为软冲销）。
        usage.status = 'reversed';
        usage.reversedAt = new Date();
        usage.reversedBy = user.id;
        usage.reverseReason = `作废工单：${reason}`.slice(0, 500);
        usage.reversalMovementId = movement.id;
        usage.updatedBy = user.id;
        await manager.save(WorkOrderMaterial, usage);
        touchedMaterialIds.add(usage.materialId);
        returnedQty += Number(usage.qty);
      }
      for (const materialId of touchedMaterialIds) {
        await refreshMaterialReferenceCost(manager, tenantId, materialId, user.id);
      }

      if (maintenanceOrder?.status === MAINTENANCE_STATUS.FILLING) {
        maintenanceOrder.status = MAINTENANCE_STATUS.VOID;
        maintenanceOrder.updatedBy = user.id;
        await manager.save(MaintenanceOrder, maintenanceOrder);
      }

      // 采购申请可能已经审批甚至下单，不能跟着删除；只解除“由这张工单发起”的关系。
      // 它仍作为独立采购单据保留，是否继续采购由采购流程自身决定。
      const purchaseIdRows: Array<{ id: number }> = await manager.query(
        `SELECT id FROM purchase_requests
          WHERE tenant_id = $1
            AND (work_order_id = $2 OR items @> $3::jsonb)`,
        [tenantId, id, JSON.stringify([{ sourceWorkOrderId: id }])],
      );
      const purchaseRequests = purchaseIdRows.length
        ? await manager.find(PurchaseRequest, {
            where: { tenantId, id: In(purchaseIdRows.map((item) => Number(item.id))) },
          })
        : [];
      for (const request of purchaseRequests) {
        const direct = request.workOrderId === id;
        request.workOrderId = direct ? null : request.workOrderId;
        request.items = (request.items ?? []).map((item) =>
          item.sourceWorkOrderId === id || (direct && item.sourceWorkOrderId == null)
            ? { ...item, sourceWorkOrderId: null }
            : item,
        );
        request.updatedBy = user.id;
      }
      if (purchaseRequests.length) await manager.save(PurchaseRequest, purchaseRequests);

      // 待审核/已确认的 AI 纠错不再进入后续学习；已正式采纳的样例保留人工审核结果。
      await manager.query(
        `UPDATE ai_assist_feedback
            SET status = 'ignored', updated_by = $1, updated_at = NOW()
          WHERE tenant_id = $2 AND work_order_id = $3
            AND status IN ('pending', 'confirmed')`,
        [user.id, tenantId, id],
      );

      const note = [
        `管理员作废：${reason}`,
        usages.length ? `退回 ${usages.length} 条用料，共 ${Number(returnedQty.toFixed(2))}` : '无库存用料',
        workOrder.feeCents ? `原登记收费 ¥${(workOrder.feeCents / 100).toFixed(2)} 已从统计排除` : '无登记收费',
        maintenanceOrder?.status === MAINTENANCE_STATUS.VOID ? '草稿养护单已同步作废' : null,
        purchaseRequests.length ? `已解除 ${purchaseRequests.length} 张采购申请的工单关联` : null,
      ].filter(Boolean).join('；');
      await this.writeLog(manager, workOrder, fromStatus, 'void', user.id, note);

      return {
        id: workOrder.id,
        orderNo: workOrder.orderNo,
        returnedMaterialLines: usages.length,
        returnedQty: Number(returnedQty.toFixed(2)),
        excludedFeeCents: workOrder.feeCents,
        voidedMaintenanceOrder: !!maintenanceOrder,
        detachedPurchaseRequests: purchaseRequests.length,
        status: WorkOrderStatus.VOIDED,
      };
    });
  }

  /**
   * 系统管理员永久删除工单。业务记录不可恢复；若尚未作废则先原批次退料。
   * 库存流水仍保留，避免删除工单后库存账出现无法解释的数量变化。
   */
  async deleteWorkOrder(
    id: number,
    dto: DeleteWorkOrderDto,
    user: AuthUser,
    access?: ResolvedAccess,
  ) {
    const reason = dto.reason?.trim();
    if (!reason || reason.length < 2) {
      throw new BadRequestException('请填写至少 2 个字的永久删除原因');
    }
    if (dto.confirmation !== '永久删除') {
      throw new BadRequestException('请输入“永久删除”完成确认');
    }
    if (!access?.isTenantAdmin && !access?.isPlatformAdmin) {
      throw new ForbiddenException('只有系统管理员可以永久删除工单');
    }

    const tenantId = this.resolveTenantId(user);
    return this.dataSource.transaction(async (manager) => {
      const workOrder = await this.lockWorkOrder(manager, id, tenantId);
      this.assertWorkOrderScope(workOrder, access);

      // 已经冲销过的用料库存早就退回去了，再退一次就是凭空多货；这里只处理仍有效的行。
      const usages = await manager.find(WorkOrderMaterial, {
        where: { tenantId, workOrderId: id, status: 'active' },
        order: { id: 'ASC' },
        lock: { mode: 'pessimistic_write' },
      });
      const touchedMaterialIds = new Set<number>();
      let returnedQty = 0;
      for (const usage of usages) {
        const allocations = await manager.find(WorkOrderMaterialAllocation, {
          where: { tenantId, workOrderMaterialId: usage.id },
          order: { id: 'ASC' },
        });
        const allocatedQty = allocations.reduce((sum, item) => sum + Number(item.qty), 0);
        if (Math.abs(allocatedQty - Number(usage.qty)) > 0.005) {
          throw new BadRequestException(
            `用料 #${usage.id} 的批次记录不完整，已停止永久删除以免库存错账`,
          );
        }
        const lotIds = [...new Set(allocations.map((item) => item.stockLotId))];
        const lotCount = lotIds.length
          ? await manager.count(StockLot, { where: { tenantId, id: In(lotIds) } })
          : 0;
        if (lotCount !== lotIds.length) {
          throw new BadRequestException(
            `用料 #${usage.id} 的原库存批次不存在，已停止永久删除以免库存错账`,
          );
        }
        await restoreStockLots(manager, allocations, user.id);
        await applyStockDelta(manager, {
          tenantId,
          warehouseId: usage.warehouseId,
          materialId: usage.materialId,
          deltaQty: Number(usage.qty),
          type: StockMovementType.RETURN,
          unitCostCents: usage.unitCostCents,
          refType: 'work_order_delete_return',
          refId: usage.id,
          operatorId: user.id,
          note: `永久删除工单退料：${workOrder.orderNo}`,
        });
        touchedMaterialIds.add(usage.materialId);
        returnedQty += Number(usage.qty);
      }
      // 永久删除是唯一真的抹掉历史的入口：连已冲销的用料和完工批次一起清干净，
      // 否则会留下指向不存在工单的孤儿行。
      await manager.query(
        `DELETE FROM work_order_material_allocations
          WHERE tenant_id = $1
            AND work_order_material_id IN (
              SELECT id FROM work_order_materials WHERE tenant_id = $1 AND work_order_id = $2
            )`,
        [tenantId, id],
      );
      await manager.delete(WorkOrderMaterial, { tenantId, workOrderId: id });
      await manager.delete(WorkOrderCompletionBatch, { tenantId, workOrderId: id });
      for (const materialId of touchedMaterialIds) {
        await refreshMaterialReferenceCost(manager, tenantId, materialId, user.id);
      }

      const purchaseIdRows: Array<{ id: number }> = await manager.query(
        `SELECT id FROM purchase_requests
          WHERE tenant_id = $1
            AND (work_order_id = $2 OR items @> $3::jsonb)`,
        [tenantId, id, JSON.stringify([{ sourceWorkOrderId: id }])],
      );
      const purchaseRequests = purchaseIdRows.length
        ? await manager.find(PurchaseRequest, {
            where: { tenantId, id: In(purchaseIdRows.map((item) => Number(item.id))) },
          })
        : [];
      for (const request of purchaseRequests) {
        const direct = request.workOrderId === id;
        request.workOrderId = direct ? null : request.workOrderId;
        request.items = (request.items ?? []).map((item) =>
          item.sourceWorkOrderId === id || (direct && item.sourceWorkOrderId == null)
            ? { ...item, sourceWorkOrderId: null }
            : item,
        );
        request.updatedBy = user.id;
      }
      if (purchaseRequests.length) await manager.save(PurchaseRequest, purchaseRequests);

      const maintenanceRows: Array<{ id: number }> = await manager.query(
        `SELECT id FROM maintenance_orders WHERE tenant_id = $1 AND work_order_id = $2`,
        [tenantId, id],
      );
      if (maintenanceRows.length) {
        await manager.query(
          `DELETE FROM maintenance_sign_sessions
            WHERE tenant_id = $1 AND maintenance_order_id = ANY($2::int[])`,
          [tenantId, maintenanceRows.map((row) => Number(row.id))],
        );
        await manager.query(
          `DELETE FROM maintenance_orders WHERE tenant_id = $1 AND work_order_id = $2`,
          [tenantId, id],
        );
      }
      await manager.delete(Review, { tenantId, workOrderId: id });
      await manager.delete(RepairTypeCorrection, { tenantId, workOrderId: id });
      await manager.query(
        `DELETE FROM ai_assist_feedback WHERE tenant_id = $1 AND work_order_id = $2`,
        [tenantId, id],
      );
      await manager.delete(WorkOrderLog, { tenantId, workOrderId: id });
      await manager.delete(WorkOrder, { tenantId, id });
      await manager.delete(RepairRequest, { tenantId, id: workOrder.requestId });

      this.logger.warn(
        `工单 ${workOrder.orderNo} 已由管理员 #${user.id} 永久删除；原因：${reason}`,
      );
      return {
        id,
        orderNo: workOrder.orderNo,
        returnedMaterialLines: usages.length,
        returnedQty: Number(returnedQty.toFixed(2)),
        detachedPurchaseRequests: purchaseRequests.length,
        permanentlyDeleted: true,
      };
    });
  }

  /**
   * 删除工单上一条已领用料：按原 FIFO 分摊退回原批次，同时回补库存并留退料流水。
   * 只有等料/维修中的单允许改；已提交完工的历史成本不能被事后悄悄改掉。
   */
  async removeWorkOrderMaterial(
    workOrderId: number,
    usageId: number,
    user: AuthUser,
    access?: ResolvedAccess,
  ) {
    const tenantId = this.resolveTenantId(user);
    return this.dataSource.transaction(async (manager) => {
      const workOrder = await this.lockWorkOrder(manager, workOrderId, tenantId);
      this.assertWorkOrderScope(workOrder, access);
      if (![WorkOrderStatus.IN_PROGRESS, WorkOrderStatus.WAITING_MATERIAL].includes(workOrder.status)) {
        throw new BadRequestException('当前工单状态不能删除用料');
      }
      await this.ensureAssigneeOrAdmin(workOrder, user);
      const usage = await manager.findOne(WorkOrderMaterial, {
        where: { id: usageId, tenantId, workOrderId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!usage) throw new NotFoundException('工单用料不存在');
      if (usage.status !== 'active') {
        throw new BadRequestException('该用料已经退过库，请刷新后再试');
      }
      const problem = await this.checkUsageReturnable(manager, tenantId, usage);
      if (problem) throw new BadRequestException(problem);
      const allocations = await manager.find(WorkOrderMaterialAllocation, {
        where: { tenantId, workOrderMaterialId: usage.id },
      });
      await restoreStockLots(manager, allocations, user.id);
      const { movement } = await applyStockDelta(manager, {
        tenantId,
        warehouseId: usage.warehouseId,
        materialId: usage.materialId,
        deltaQty: Number(usage.qty),
        type: StockMovementType.RETURN,
        unitCostCents: usage.unitCostCents,
        refType: 'work_order_material_return',
        refId: usage.id,
        operatorId: user.id,
        note: `删除工单用料，退回 ${workOrder.orderNo}`,
        reversalOfMovementId: usage.issueMovementId ?? null,
      });
      usage.status = 'reversed';
      usage.reversedAt = new Date();
      usage.reversedBy = user.id;
      usage.reverseReason = '维修工删除用料';
      usage.reversalMovementId = movement.id;
      usage.updatedBy = user.id;
      await manager.save(WorkOrderMaterial, usage);
      const snapshot = [...(workOrder.usedMaterials || [])];
      const index = snapshot.findIndex(
        (item) => item.materialId === usage.materialId && Number(item.qty) === Number(usage.qty),
      );
      if (index >= 0) snapshot.splice(index, 1);
      workOrder.usedMaterials = snapshot;
      workOrder.updatedBy = user.id;
      await manager.save(WorkOrder, workOrder);
      await refreshMaterialReferenceCost(manager, tenantId, usage.materialId, user.id);
      await this.writeLog(
        manager,
        workOrder,
        workOrder.status,
        'return_material',
        user.id,
        `已删除用料并退库：材料 #${usage.materialId} ×${Number(usage.qty)}`,
      );
      return { ok: true };
    });
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
    const target = await this.workOrderRepo.findOne({
      where: { id, tenantId },
      select: ['id', 'communityId'],
    });
    if (!target) throw new NotFoundException('work order not found');
    const scope = this.scopeIds(access);
    if (scope && !scope.includes(target.communityId)) {
      throw new NotFoundException('work order not found');
    }
    const officeId = await this.accessService.officeIdOfCommunity(tenantId, target.communityId);
    await this.assertAssignee(tenantId, dto.assigneeId, officeId ?? undefined);
    const assignee = await this.userRepo.findOne({ where: { id: dto.assigneeId, tenantId } });

    const saved = await this.dataSource.transaction(async (manager) => {
      const workOrder = await this.lockWorkOrder(manager, id, tenantId);
      const fromStatus = workOrder.status;
      assertWorkOrderTransition(
        fromStatus,
        WorkOrderStatus.DISPATCHED,
        'assign',
        '当前状态不能派单：已完工/已验收/已撤单的单请先撤回上一步',
      );
      // 派单可能发生在待派单/已派单/维修中/等待材料四种节点上，换人派单前后状态还一样。
      // 撤回要恢复的是「上一位维修工 + 上一个节点」，只能靠这张快照。
      const beforeSnapshot = await this.captureWorkOrderSnapshot(manager, workOrder);

      workOrder.assigneeId = dto.assigneeId;
      workOrder.candidateIds = [dto.assigneeId];
      workOrder.skill = dto.skill ?? workOrder.skill;
      workOrder.status = WorkOrderStatus.DISPATCHED;
      workOrder.dispatchedAt = new Date();
      // 换了负责人就重新计时：上一个人没接单的催单记录，不该算在新人头上
      workOrder.escalatedAt = null;
      workOrder.slaDueAt = dto.slaHours
        ? new Date(Date.now() + dto.slaHours * 60 * 60 * 1000)
        : workOrder.slaDueAt;
      workOrder.updatedBy = user.id;
      // 转单会把原报修类型清空；办公室重新派单时，所选工种必须同时写回报修单，
      // 否则列表、规则命中和类型统计仍会把它当成“未分类”。
      if (dto.skill?.trim()) {
        const repairRequest = await manager.findOne(RepairRequest, {
          where: { id: workOrder.requestId, tenantId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!repairRequest) throw new NotFoundException('repair request not found');
        repairRequest.repairType = dto.skill.trim();
        repairRequest.updatedBy = user.id;
        await manager.save(RepairRequest, repairRequest);
      }
      const saved = await manager.save(WorkOrder, workOrder);
      await this.writeLog(manager, saved, fromStatus, 'assign', user.id, dto.note, [], {
        beforeSnapshot,
        afterSnapshot: await this.captureWorkOrderSnapshot(manager, saved),
      });
      return saved;
    });

    await this.notifyOwnerOnStatus(saved, 'dispatched', assignee?.name ?? null);
    // 派单不通知维修工，那这单就得等他自己想起来打开小程序看一眼 ——
    // 「已派单」堆在那儿没人动，办公室还以为派出去就完事了
    await this.notifyAssigneeOnDispatch(saved, dto.note ?? null);
    return saved;
  }

  /**
   * 撤回预览与执行共用的判定。
   *
   * **只读**，不写任何数据：预览接口直接返回它，执行时在事务里再算一次并按它落库。
   * 两边算法只有一份，前端弹窗上写的「将退回 3 项材料」和真正发生的事必然一致 ——
   * 以前前端自己硬编码「将退回已派单」，状态一复杂就是错的（2026-09-03）。
   */
  private async buildRollbackPlan(
    manager: EntityManager,
    tenantId: number,
    workOrder: WorkOrder,
  ): Promise<RollbackPlan> {
    const fromStatus = workOrder.status;
    const base: RollbackPlan = {
      allowed: false,
      fromStatus,
      fromStatusLabel: workOrderStatusLabel(fromStatus),
      willReturnMaterials: false,
      materialLines: [],
      materialTotalQty: 0,
      purchaseRequests: [],
      maintenanceOrder: null,
      reviewWillReverse: false,
      usedSnapshot: false,
    };
    if (fromStatus === WorkOrderStatus.VOIDED) {
      return { ...base, blockedReason: '工单已作废，不能撤回；如需恢复请联系系统管理员' };
    }

    const logs = await manager.find(WorkOrderLog, {
      where: { tenantId, workOrderId: workOrder.id },
      order: { id: 'DESC' },
    });
    const { resolution, blockedReason } = resolveRollback(fromStatus, logs);
    if (!resolution) return { ...base, blockedReason };

    const sourceLog = logs.find((log) => log.id === resolution.log.id) as WorkOrderLog;
    const plan: RollbackPlan = {
      ...base,
      action: sourceLog.action,
      actionLabel: ROLLBACK_ACTION_LABELS[sourceLog.action] ?? sourceLog.action,
      sourceLogId: sourceLog.id,
      targetStatus: resolution.targetStatus,
      targetStatusLabel: workOrderStatusLabel(resolution.targetStatus),
      usedSnapshot: resolution.usedSnapshot,
      restoreAssigneeId: resolution.usedSnapshot
        ? sourceLog.beforeSnapshot?.assigneeId ?? null
        : workOrder.assigneeId,
      restoreRepairType: sourceLog.beforeSnapshot?.repairType ?? null,
    };

    // ---- 完工撤回：要退这一次完工扣的料 ----
    // 「已完成 → 待验收」撤的是验收，完工提交仍然有效，绝不能在这一步退料（规则 2.3）。
    if (sourceLog.action === 'complete') {
      const batch = await this.findActiveCompletionBatch(manager, tenantId, workOrder.id);
      if (batch) {
        plan.completionBatchId = batch.id;
        plan.completionBatchVersion = batch.versionNo;
        const usages = await manager.find(WorkOrderMaterial, {
          where: {
            tenantId,
            workOrderId: workOrder.id,
            completionBatchId: batch.id,
            status: 'active',
          },
          order: { id: 'ASC' },
        });
        if (usages.length) {
          const names = await this.materialNamesByIds(
            manager,
            tenantId,
            usages.map((usage) => usage.materialId),
          );
          const warehouses = await manager.find(Warehouse, {
            where: { tenantId, id: In([...new Set(usages.map((u) => u.warehouseId))]) },
            select: ['id', 'name'],
          });
          const warehouseName = new Map(warehouses.map((w) => [w.id, w.name]));
          plan.willReturnMaterials = true;
          plan.materialLines = usages.map((usage) => ({
            usageId: usage.id,
            materialId: usage.materialId,
            name: names.get(usage.materialId) ?? `材料 #${usage.materialId}`,
            qty: Number(usage.qty),
            warehouseId: usage.warehouseId,
            warehouseName: warehouseName.get(usage.warehouseId) ?? '未知仓库',
          }));
          plan.materialTotalQty = Number(
            plan.materialLines.reduce((sum, line) => sum + line.qty, 0).toFixed(2),
          );
          // 批次记录不完整就整单拒绝：宁可不让撤，也不能只加库存总数不还批次，
          // 那样账面数量对得上、批次对不上，下次出库会扣到不存在的批次。
          for (const usage of usages) {
            const problem = await this.checkUsageReturnable(manager, tenantId, usage);
            if (problem) return { ...plan, blockedReason: problem };
          }
        }
      }

      // 已签字的养护单是正式凭据，不能让工单悄悄退回维修中而单据仍显示已查验。
      const maintenanceOrder = await manager
        .createQueryBuilder(MaintenanceOrder, 'mo')
        .where('mo.tenant_id = :tenantId AND mo.work_order_id = :id', {
          tenantId,
          id: workOrder.id,
        })
        .andWhere("mo.status <> 'void'")
        .orderBy('mo.id', 'DESC')
        .getOne();
      if (maintenanceOrder) {
        if (maintenanceOrder.status !== MAINTENANCE_STATUS.FILLING) {
          return {
            ...plan,
            maintenanceOrder: { id: maintenanceOrder.id, willVoid: false },
            blockedReason: '该工单的养护单已进入签字流程，请先作废养护单再撤回工单',
          };
        }
        plan.maintenanceOrder = { id: maintenanceOrder.id, willVoid: true };
      }
    }

    // ---- 撤回缺料：同步处理该工单**全部**还在流程里的采购申请 ----
    if (sourceLog.action === 'need_material') {
      const requests = await this.findWorkOrderPurchaseRequests(manager, tenantId, workOrder.id);
      const handleable = [
        PurchaseRequestStatus.DRAFT,
        PurchaseRequestStatus.OFFICE_REVIEW,
        PurchaseRequestStatus.REJECTED,
      ];
      const blocking = requests.filter((request) => !handleable.includes(request.status));
      plan.purchaseRequests = requests.map((request) => ({
        id: request.id,
        requestNo: request.requestNo,
        status: request.status,
        willReject:
          request.status === PurchaseRequestStatus.DRAFT ||
          request.status === PurchaseRequestStatus.OFFICE_REVIEW,
      }));
      if (blocking.length) {
        return {
          ...plan,
          blockedReason: `采购申请 ${blocking
            .map((request) => request.requestNo)
            .join('、')} 已经进入经理审批、合并或采购环节，请先处理采购申请后再撤回`,
        };
      }
    }

    // ---- 撤回验收：原评价转为已失效，但永久保留 ----
    if (sourceLog.action === 'review' || sourceLog.action === 'auto_review_complete') {
      const count = await manager.count(Review, {
        where: { tenantId, workOrderId: workOrder.id, status: 'active' },
      });
      plan.reviewWillReverse = count > 0;
    }

    plan.allowed = true;
    return plan;
  }

  /** 这条用料能不能安全退回原批次；不能则返回给用户看的原因 */
  private async checkUsageReturnable(
    manager: EntityManager,
    tenantId: number,
    usage: WorkOrderMaterial,
  ): Promise<string | null> {
    if (usage.reversalMovementId) {
      return `用料 #${usage.id} 已经退过料，请刷新后再试`;
    }
    const allocations = await manager.find(WorkOrderMaterialAllocation, {
      where: { tenantId, workOrderMaterialId: usage.id },
    });
    const allocatedQty = allocations.reduce((sum, item) => sum + Number(item.qty), 0);
    if (Math.abs(allocatedQty - Number(usage.qty)) > 0.005) {
      return `用料 #${usage.id} 的批次记录不完整，已停止撤回以免库存错账，请联系管理员核对`;
    }
    const lotIds = [...new Set(allocations.map((item) => item.stockLotId))];
    const lotCount = lotIds.length
      ? await manager.count(StockLot, { where: { tenantId, id: In(lotIds) } })
      : 0;
    if (lotCount !== lotIds.length) {
      return `用料 #${usage.id} 的原库存批次不存在，已停止撤回以免库存错账，请联系管理员核对`;
    }
    return null;
  }

  /** 该工单发起的采购申请：直接挂在工单上的，以及被合并进别的申请单里的行 */
  private async findWorkOrderPurchaseRequests(
    manager: EntityManager,
    tenantId: number,
    workOrderId: number,
  ): Promise<PurchaseRequest[]> {
    const rows: Array<{ id: number }> = await manager.query(
      `SELECT id FROM purchase_requests
        WHERE tenant_id = $1
          AND (work_order_id = $2 OR items @> $3::jsonb)`,
      [tenantId, workOrderId, JSON.stringify([{ sourceWorkOrderId: workOrderId }])],
    );
    if (!rows.length) return [];
    return manager.find(PurchaseRequest, {
      where: { tenantId, id: In(rows.map((row) => Number(row.id))) },
      order: { id: 'DESC' },
    });
  }

  /**
   * 冲销一次完工提交：把这个批次扣的料按原 FIFO 分摊精确退回原仓原批次。
   *
   * 三条铁律：
   * 1. 退的是**批次数量**，不是只把库存总数加回去 —— 只加总数会让批次与实物对不上，
   *    下次出库就会扣到不存在的批次；
   * 2. 原用料记录只标 reversed，绝不删除，原成本/原仓/原数量永久留档；
   * 3. 冲回流水的 reversalOfMovementId 指向原出库流水，靠唯一索引保证一条扣料只退一次。
   */
  private async reverseCompletionBatch(
    manager: EntityManager,
    tenantId: number,
    workOrder: WorkOrder,
    batch: WorkOrderCompletionBatch,
    operatorId: number,
    reason: string,
  ): Promise<{ lines: RollbackMaterialLine[]; totalQty: number }> {
    const usages = await manager.find(WorkOrderMaterial, {
      where: { tenantId, workOrderId: workOrder.id, completionBatchId: batch.id, status: 'active' },
      order: { id: 'ASC' },
      lock: { mode: 'pessimistic_write' },
    });
    const names = usages.length
      ? await this.materialNamesByIds(
          manager,
          tenantId,
          usages.map((usage) => usage.materialId),
        )
      : new Map<number, string>();
    const warehouses = usages.length
      ? await manager.find(Warehouse, {
          where: { tenantId, id: In([...new Set(usages.map((u) => u.warehouseId))]) },
          select: ['id', 'name'],
        })
      : [];
    const warehouseName = new Map(warehouses.map((w) => [w.id, w.name]));

    const lines: RollbackMaterialLine[] = [];
    const touchedMaterialIds = new Set<number>();
    for (const usage of usages) {
      const problem = await this.checkUsageReturnable(manager, tenantId, usage);
      if (problem) throw new BadRequestException(problem);
      const allocations = await manager.find(WorkOrderMaterialAllocation, {
        where: { tenantId, workOrderMaterialId: usage.id },
        order: { id: 'ASC' },
      });
      await restoreStockLots(manager, allocations, operatorId);
      const { movement } = await applyStockDelta(manager, {
        tenantId,
        warehouseId: usage.warehouseId,
        materialId: usage.materialId,
        deltaQty: Number(usage.qty),
        type: StockMovementType.RETURN,
        unitCostCents: usage.unitCostCents,
        refType: 'work_order_rollback_return',
        refId: workOrder.id,
        operatorId,
        note: `工单撤回还料：${workOrder.orderNo}（完工批次 #${batch.versionNo}，原用料 #${usage.id}）`,
        reversalOfMovementId: usage.issueMovementId ?? null,
      });
      usage.status = 'reversed';
      usage.reversedAt = new Date();
      usage.reversedBy = operatorId;
      usage.reverseReason = reason.slice(0, 500);
      usage.reversalMovementId = movement.id;
      usage.updatedBy = operatorId;
      await manager.save(WorkOrderMaterial, usage);
      touchedMaterialIds.add(usage.materialId);
      lines.push({
        usageId: usage.id,
        materialId: usage.materialId,
        name: names.get(usage.materialId) ?? `材料 #${usage.materialId}`,
        qty: Number(usage.qty),
        warehouseId: usage.warehouseId,
        warehouseName: warehouseName.get(usage.warehouseId) ?? '未知仓库',
      });
    }
    for (const materialId of touchedMaterialIds) {
      await refreshMaterialReferenceCost(manager, tenantId, materialId, operatorId);
    }
    return {
      lines,
      totalQty: Number(lines.reduce((sum, line) => sum + line.qty, 0).toFixed(2)),
    };
  }

  /**
   * 撤回预览：告诉前端**这一次**撤回具体会发生什么，由后端算，前端只负责显示。
   * 没有权限或不能撤回时也返回 200，用 allowed=false + blockedReason 说明原因，
   * 让按钮能提前置灰并说清为什么（权限藏起来的功能要说明原因）。
   */
  async previewRollback(id: number, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.resolveTenantId(user);
    const workOrder = await this.workOrderRepo.findOne({ where: { id, tenantId } });
    if (!workOrder) throw new NotFoundException('work order not found');
    this.assertWorkOrderScope(workOrder, access);
    if (!(await this.canRollback(user, access))) {
      return {
        allowed: false,
        blockedReason: '你的账号没有撤回工单的权限，请管理员在「业务角色」里勾上「撤回工单」',
        fromStatus: workOrder.status,
        fromStatusLabel: workOrderStatusLabel(workOrder.status),
        willReturnMaterials: false,
        materialLines: [],
        materialTotalQty: 0,
        purchaseRequests: [],
        maintenanceOrder: null,
        reviewWillReverse: false,
        usedSnapshot: false,
      } satisfies RollbackPlan;
    }
    const plan = await this.buildRollbackPlan(this.dataSource.manager, tenantId, workOrder);
    return this.decorateRollbackPlan(tenantId, plan);
  }

  /** 预览里出现的人名由后端补齐：界面上不许出现「#19」这种 id */
  private async decorateRollbackPlan(tenantId: number, plan: RollbackPlan): Promise<RollbackPlan> {
    if (!plan.restoreAssigneeId) return plan;
    const assignee = await this.userRepo.findOne({
      where: { tenantId, id: plan.restoreAssigneeId },
      select: ['id', 'name'],
    });
    return { ...plan, restoreAssigneeName: assignee?.name ?? '未知维修工' };
  }

  /**
   * 办公室/管理员撤回上一笔业务操作。
   *
   * 这不是覆盖历史：被撤销的动作、本次撤回、退料流水全部留档，只是把工单的
   * **当前状态和关键字段**恢复到那一步之前 —— 恢复依据是当时拍的 before 快照，
   * 不是按当前状态硬编码退一格（同样是「维修中」来路完全不同，硬编码必错）。
   *
   * 撤回完工时还会把这一次扣的料按原 FIFO 批次精确退回，原用料记录标为已冲销，
   * 完工内容留作草稿；维修工改完再次提交时按最终清单重新扣库，净变化和实际用料一致。
   */
  async rollbackWorkOrder(
    id: number,
    dto: RollbackWorkOrderDto,
    user: AuthUser,
    access?: ResolvedAccess,
  ) {
    const reason = dto.reason?.trim();
    if (!reason || reason.length < 2) {
      throw new BadRequestException('请填写至少 2 个字的撤回原因');
    }
    if (!(await this.canRollback(user, access))) {
      throw new ForbiddenException('你的账号没有撤回工单的权限，请管理员在「业务角色」里勾上「撤回工单」');
    }

    const tenantId = this.resolveTenantId(user);
    const result = await this.dataSource.transaction(async (manager) => {
      const workOrder = await this.lockWorkOrder(manager, id, tenantId);
      this.assertWorkOrderScope(workOrder, access);
      const fromStatus = workOrder.status;
      const plan = await this.buildRollbackPlan(manager, tenantId, workOrder);
      if (!plan.allowed || !plan.targetStatus || !plan.sourceLogId) {
        throw new BadRequestException(plan.blockedReason ?? '当前工单不能撤回');
      }
      const sourceLog = await manager.findOne(WorkOrderLog, {
        where: { tenantId, id: plan.sourceLogId },
        lock: { mode: 'pessimistic_write' },
      });
      // 并发下另一个请求可能刚把这一步撤掉了；行锁 + 这个判断保证同一步不会被撤两次。
      if (!sourceLog || sourceLog.revertedByLogId) {
        throw new BadRequestException('这一步已经被撤回过了，请刷新后再试');
      }

      const notes: string[] = [];
      const detail: Record<string, unknown> = {
        rolledBackAction: sourceLog.action,
        rolledBackActionLabel: plan.actionLabel,
        rolledBackLogId: sourceLog.id,
        fromStatus,
        targetStatus: plan.targetStatus,
      };
      let returnedLines: RollbackMaterialLine[] = [];

      // 1) 完工撤回：先退料，再恢复字段
      if (sourceLog.action === 'complete' && plan.completionBatchId) {
        const batch = await manager.findOne(WorkOrderCompletionBatch, {
          where: { tenantId, id: plan.completionBatchId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!batch || batch.status !== 'active') {
          throw new BadRequestException('该次完工已经被撤回，请刷新后再试');
        }
        const returned = await this.reverseCompletionBatch(
          manager,
          tenantId,
          workOrder,
          batch,
          user.id,
          reason,
        );
        returnedLines = returned.lines;
        batch.status = 'reversed';
        batch.reversedBy = user.id;
        batch.reversedAt = new Date();
        batch.reverseReason = reason.slice(0, 500);
        batch.updatedBy = user.id;
        await manager.save(WorkOrderCompletionBatch, batch);
        detail.completionBatchId = batch.id;
        detail.completionBatchVersion = batch.versionNo;
        detail.returnedMaterials = returned.lines;
        detail.returnedQty = returned.totalQty;
        if (returned.lines.length) {
          notes.push(
            `已退回材料 ${returned.lines.length} 项、共 ${returned.totalQty} 件：` +
              returned.lines
                .map((line) => `${line.name} ×${line.qty}（${line.warehouseName}）`)
                .join('、'),
          );
        }
        notes.push('原完工内容和用料已保留为草稿，重新提交完工时才会再次扣库');

        // 这一批 AI 填单样例是被推翻的填写，不能继续当正确答案教模型。
        // 已经人工提升为正式样例的只打「来源已撤回」标记，交管理员复核，不自动删。
        const aiReversed = await manager.query(
          `UPDATE ai_assist_feedback
              SET status = CASE WHEN status = 'promoted' THEN status ELSE 'reversed' END,
                  source_reversed = true,
                  updated_at = now(),
                  updated_by = $3
            WHERE tenant_id = $1 AND completion_batch_id = $2
            RETURNING id`,
          [tenantId, batch.id, user.id],
        );
        if (Array.isArray(aiReversed) && aiReversed.length) {
          detail.aiFeedbackReversed = aiReversed.length;
        }
      }

      // 养护单和有没有用料无关，所以放在批次分支外面：撤回完工时草稿养护单一律同步作废，
      // 否则工单退回维修中了，养护单还停在「填写中」等人签字。
      if (sourceLog.action === 'complete' && plan.maintenanceOrder?.willVoid) {
        await manager.query(
          `UPDATE maintenance_orders SET status = 'void', updated_by = $3, updated_at = now()
            WHERE tenant_id = $1 AND id = $2`,
          [tenantId, plan.maintenanceOrder.id, user.id],
        );
        detail.maintenanceOrderVoided = plan.maintenanceOrder.id;
        notes.push('原草稿养护单已同步作废');
      }

      // 2) 撤回缺料：把还在低阶段的采购申请一起驳回，并关掉它们的待办通知
      if (sourceLog.action === 'need_material' && plan.purchaseRequests.length) {
        const rejected: string[] = [];
        for (const item of plan.purchaseRequests.filter((request) => request.willReject)) {
          const request = await manager.findOne(PurchaseRequest, {
            where: { tenantId, id: item.id },
            lock: { mode: 'pessimistic_write' },
          });
          if (!request) continue;
          request.status = PurchaseRequestStatus.REJECTED;
          request.rejectReason = `工单撤回：${reason}`.slice(0, 255);
          request.updatedBy = user.id;
          await manager.save(PurchaseRequest, request);
          rejected.push(request.requestNo);
        }
        if (rejected.length) {
          detail.rejectedPurchaseRequests = rejected;
          notes.push(`采购申请 ${rejected.join('、')} 已同步驳回`);
        }
      }

      // 3) 撤回验收：原评价转失效但永久保留，评分统计不再算它
      if (plan.reviewWillReverse) {
        const reviews = await manager.find(Review, {
          where: { tenantId, workOrderId: id, status: 'active' },
          order: { id: 'DESC' },
        });
        const latest = reviews[0];
        detail.reversedReviews = reviews.map((review) => ({
          id: review.id,
          rating: review.rating,
          comment: review.comment,
          attachments: review.attachments ?? [],
          autoConfirmed: review.autoConfirmed,
        }));
        notes.push(
          `原验收记录已失效（${latest.rating} 星${latest.comment ? `，${latest.comment}` : ''}），历史仍可查看`,
        );
      }

      // 4) 按快照恢复工单字段
      const beforeRollback = await this.captureWorkOrderSnapshot(manager, workOrder);
      if (sourceLog.beforeSnapshot) {
        this.applyWorkOrderSnapshot(workOrder, sourceLog.beforeSnapshot);
      } else {
        // 老日志没有快照：只做能确定安全的最小恢复（resolveRollback 已经挡掉了
        // 需要恢复负责人/类型的那几种动作）。
        workOrder.status = plan.targetStatus;
        if (sourceLog.action === 'complete') workOrder.completedAt = null;
        if (sourceLog.action === 'accept' || sourceLog.action === 'claim') {
          workOrder.acceptedAt = null;
        }
        notes.push('该节点为改造前记录，仅恢复了状态；请核对负责人与时限');
      }
      workOrder.status = plan.targetStatus;

      // 报修类型/工种在转单时被改过，一并按快照还原（撤回转单）
      if (sourceLog.beforeSnapshot?.repairType !== undefined) {
        const request = await manager.findOne(RepairRequest, {
          where: { tenantId, id: workOrder.requestId },
          lock: { mode: 'pessimistic_write' },
        });
        if (request && request.repairType !== sourceLog.beforeSnapshot.repairType) {
          detail.restoredRepairType = sourceLog.beforeSnapshot.repairType;
          request.repairType = sourceLog.beforeSnapshot.repairType ?? null;
          request.updatedBy = user.id;
          await manager.save(RepairRequest, request);
        }
      }

      // 待验收的自动完成按 completedAt 计时。照搬旧时间的话，老工单一撤回就会被
      // 下一次详情查询立刻自动完成，看起来像按钮没生效（2026-08 实测）。
      if (plan.targetStatus === WorkOrderStatus.DONE_PENDING_REVIEW) {
        workOrder.completedAt = new Date();
        notes.push('待验收时限已从本次撤回重新计算');
      }

      workOrder.updatedBy = user.id;
      const saved = await manager.save(WorkOrder, workOrder);

      const operator = await manager.findOne(User, {
        where: { tenantId, id: user.id },
        select: ['id', 'name'],
      });
      if (plan.restoreAssigneeId) {
        const assignee = await manager.findOne(User, {
          where: { tenantId, id: plan.restoreAssigneeId },
          select: ['id', 'name'],
        });
        detail.restoredAssignee = {
          id: plan.restoreAssigneeId,
          name: assignee?.name ?? '未知维修工',
        };
        if (assignee?.name) notes.push(`维修工恢复为 ${assignee.name}`);
      }

      const rollbackLog = await this.writeLog(
        manager,
        saved,
        fromStatus,
        'rollback',
        user.id,
        [
          `${operator?.name || '办公室'}撤回${plan.actionLabel ? `「${plan.actionLabel}」` : ''}：${workOrderStatusLabel(fromStatus)} → ${workOrderStatusLabel(plan.targetStatus)}`,
          `原因：${reason}`,
          ...notes,
        ]
          .filter(Boolean)
          .join('；'),
        [],
        {
          beforeSnapshot: beforeRollback,
          afterSnapshot: await this.captureWorkOrderSnapshot(manager, saved),
          rolledBackLogId: sourceLog.id,
          rollbackDetail: detail,
        },
      );

      // 被撤销的那一步打上标记：同一步不能撤第二次，连续撤回会自然往前找上一步。
      sourceLog.revertedByLogId = rollbackLog.id;
      await manager.save(WorkOrderLog, sourceLog);

      if (plan.reviewWillReverse) {
        await manager.update(
          Review,
          { tenantId, workOrderId: id, status: 'active' },
          { status: 'reversed', reversedAt: new Date(), reversedByLogId: rollbackLog.id, updatedBy: user.id },
        );
      }
      if (detail.completionBatchId) {
        await manager.update(
          WorkOrderCompletionBatch,
          { tenantId, id: detail.completionBatchId as number },
          { rollbackLogId: rollbackLog.id },
        );
      }

      return { workOrder: saved, plan, detail, returnedLines, rollbackLogId: rollbackLog.id };
    });

    // 事务外做通知：微信侧抖动不能让已经落库的撤回回滚，也不能让前端以为失败去重试。
    await this.notifyAfterRollback(result.workOrder, result.plan, reason);
    return {
      ...result.workOrder,
      rollback: {
        rolledBackAction: result.plan.action,
        rolledBackActionLabel: result.plan.actionLabel,
        fromStatus: result.plan.fromStatus,
        targetStatus: result.plan.targetStatus,
        targetStatusLabel: result.plan.targetStatusLabel,
        returnedMaterials: result.returnedLines,
        returnedQty: Number(
          result.returnedLines.reduce((sum, line) => sum + line.qty, 0).toFixed(2),
        ),
        completionBatchId: result.plan.completionBatchId ?? null,
        rejectedPurchaseRequests: result.detail.rejectedPurchaseRequests ?? [],
        maintenanceOrderVoided: result.detail.maintenanceOrderVoided ?? null,
        reviewReversed: result.plan.reviewWillReverse,
      },
    };
  }

  /**
   * 撤回之后按**目标状态**重新生成待办，并关掉已经失效的旧待办。
   *
   * 不做这一步的话，工单退回维修中了，维修工那边还挂着「请验收」，
   * 办公室这边却没有任何提示 —— 撤回等于只有数据库知道。
   */
  private async notifyAfterRollback(
    workOrder: WorkOrder,
    plan: RollbackPlan,
    reason: string,
  ): Promise<void> {
    try {
      // 失效的旧待办：派单、验收、采购审批的操作入口都不该继续可点
      const staleEvents = ['order_assigned', 'order_review', 'order_transfer_requested'];
      if (plan.action === 'need_material') staleEvents.push('purchase_pending_office');
      await this.notifications.invalidateWorkOrderNotifications(
        workOrder.tenantId,
        workOrder.id,
        staleEvents,
        `工单已撤回${plan.actionLabel ? `「${plan.actionLabel}」` : ''}`,
      );

      const note = `办公室撤回${plan.actionLabel ? `「${plan.actionLabel}」` : '上一步'}：${reason}`;
      switch (workOrder.status) {
        case WorkOrderStatus.DISPATCHED:
        case WorkOrderStatus.IN_PROGRESS:
          await this.notifyAssigneeOnDispatch(workOrder, note);
          break;
        case WorkOrderStatus.DONE_PENDING_REVIEW:
          await this.notifyOwnerOnStatus(workOrder, 'review');
          break;
        case WorkOrderStatus.CREATED:
        case WorkOrderStatus.WAITING_MATERIAL:
          await this.notifyOfficeOnTransfer(workOrder, note, workOrder.updatedBy ?? 0);
          break;
        default:
          break;
      }
    } catch (error) {
      // 撤回本身已经落库成功，通知失败只记日志：不能让前端以为撤回没成功而重复提交。
      this.logger.error(
        `工单 ${workOrder.orderNo} 撤回已完成，但通知发送失败：${(error as Error).message}`,
      );
    }
  }

  async acceptWorkOrder(id: number, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.resolveTenantId(user);
    return this.dataSource.transaction(async (manager) => {
      const workOrder = await this.lockWorkOrder(manager, id, tenantId);
      this.assertWorkOrderScope(workOrder, access);
      // 工单池主动接单只认领公开池里的未派单/等待材料；定向派单只能由被派人接单。
      // controller 已校验 app:pool·edit，这里再校验小区数据范围；行锁保证并发时
      // 只有第一个人能把待接单改成维修中。
      const previousAssigneeId = workOrder.assigneeId;
      const isClaim = previousAssigneeId !== user.id;
      if (isClaim) {
        if (workOrder.status === WorkOrderStatus.DISPATCHED && previousAssigneeId) {
          throw new ForbiddenException('工单已派给其他维修工');
        }
        assertWorkOrderTransition(
          workOrder.status,
          WorkOrderStatus.IN_PROGRESS,
          'claim',
          '这张单现在不能接：它已经不在可接单的状态了，下拉刷新看看最新状态',
        );
      } else {
        assertWorkOrderTransition(
          workOrder.status,
          WorkOrderStatus.IN_PROGRESS,
          'accept',
          '只有派给你的待接单才能确认接单，下拉刷新看看最新状态',
        );
      }

      // 校验全部通过之后才拍快照、才改字段：「维修中」的来路有三种
      // （待派单认领 / 等待材料接回 / 定向派单后接单），撤回要回到真正的那一种。
      const beforeSnapshot = await this.captureWorkOrderSnapshot(manager, workOrder);
      if (isClaim) {
        workOrder.assigneeId = user.id;
        workOrder.candidateIds = [user.id];
        // 被别人主动接走后从现在重新计时，避免旧负责人的催修记录落到新人头上。
        workOrder.dispatchedAt = new Date();
        workOrder.escalatedAt = null;
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
        [],
        {
          beforeSnapshot,
          afterSnapshot: await this.captureWorkOrderSnapshot(manager, saved),
        },
      );
      return saved;
    });
  }

  /** 追加现场/后续处理记录，不改变工单状态。已完工单仅办公室/管理员可补记。 */
  async addWorkOrderProgress(
    id: number,
    dto: AddWorkOrderProgressDto,
    user: AuthUser,
    access?: ResolvedAccess,
  ) {
    const note = dto.note?.trim() || '';
    const attachments = (dto.attachments || []).map((item) => item.trim()).filter(Boolean);
    if (!note && !attachments.length) {
      throw new BadRequestException('请填写进度说明或至少添加一张照片');
    }
    const tenantId = this.resolveTenantId(user);
    return this.dataSource.transaction(async (manager) => {
      const workOrder = await this.lockWorkOrder(manager, id, tenantId);
      this.assertWorkOrderScope(workOrder, access);
      if (![WorkOrderStatus.IN_PROGRESS, WorkOrderStatus.DONE_PENDING_REVIEW, WorkOrderStatus.COMPLETED].includes(workOrder.status)) {
        throw new BadRequestException('只有维修中、待验收或已完成的工单可以添加进度记录');
      }
      if (
        workOrder.status !== WorkOrderStatus.IN_PROGRESS &&
        !(await this.canDispatch(user, access))
      ) {
        throw new ForbiddenException('已完工单只有办公室人员或管理员可以补充进度记录');
      }
      if (workOrder.status === WorkOrderStatus.IN_PROGRESS) {
        await this.ensureAssigneeOrAdmin(workOrder, user);
      }
      return manager.save(
        WorkOrderLog,
        manager.create(WorkOrderLog, {
          tenantId,
          workOrderId: workOrder.id,
          fromStatus: workOrder.status,
          toStatus: workOrder.status,
          action: 'progress',
          operatorId: user.id,
          note: note || null,
          attachments,
          createdBy: user.id,
          updatedBy: user.id,
        }),
      );
    });
  }

  /**
   * 维修工申请转单：清掉旧类型和负责人，回到“待派单”。办公室收到通知后重新选类型、
   * 选择该类型下的维修工并派出；新维修工仍需在工单池确认接单。
   */
  async requestWorkOrderTransfer(
    id: number,
    dto: RequestWorkOrderTransferDto,
    user: AuthUser,
    access?: ResolvedAccess,
  ) {
    const reason = dto.note?.trim();
    if (!reason || reason.length < 2) throw new BadRequestException('请填写转单原因');
    const tenantId = this.resolveTenantId(user);
    const saved = await this.dataSource.transaction(async (manager) => {
      const workOrder = await this.lockWorkOrder(manager, id, tenantId);
      this.assertWorkOrderScope(workOrder, access);
      assertWorkOrderTransition(
        workOrder.status,
        WorkOrderStatus.CREATED,
        'transfer',
        '只有维修中的工单可以申请转单',
      );
      if (workOrder.assigneeId !== user.id && !(await this.canDispatch(user, access))) {
        throw new ForbiddenException('只能转出自己正在维修的工单');
      }
      const request = await manager.findOne(RepairRequest, {
        where: { id: workOrder.requestId, tenantId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!request) throw new NotFoundException('repair request not found');
      const fromStatus = workOrder.status;
      // 转单会把报修类型、工种、负责人、全部计时点一次清空。误转单撤回时要一件件还原，
      // 而转单后状态是「待派单」——没有快照的话根本区分不出它和一张新单（2026-09-03）。
      const beforeSnapshot = await this.captureWorkOrderSnapshot(manager, workOrder);
      request.repairType = null;
      request.updatedBy = user.id;
      workOrder.status = WorkOrderStatus.CREATED;
      workOrder.assigneeId = null;
      workOrder.candidateIds = [];
      workOrder.skill = null;
      workOrder.dispatchedAt = null;
      workOrder.acceptedAt = null;
      workOrder.slaDueAt = null;
      workOrder.escalatedAt = null;
      workOrder.updatedBy = user.id;
      await manager.save(RepairRequest, request);
      const result = await manager.save(WorkOrder, workOrder);
      await this.writeLog(
        manager,
        result,
        fromStatus,
        'transfer_request',
        user.id,
        `维修工申请转单：${reason}；已退回办公室重新分类派单`,
        [],
        {
          beforeSnapshot,
          afterSnapshot: await this.captureWorkOrderSnapshot(manager, result),
        },
      );
      return result;
    });
    try {
      await this.notifyOfficeOnTransfer(saved, reason, user.id);
    } catch (error) {
      // 工单已在事务内成功退回，通知链路抖动不能让前端误以为转单失败而重复提交。
      this.logger.error(`转单 ${saved.orderNo} 已完成，但办公室通知发送失败：${(error as Error).message}`);
    }
    return saved;
  }

  /**
   * 从指定仓库领用工单材料，并同时写 FIFO 分摊、用料明细和库存流水。
   * 完工与「有库存记用料、没库存提报缺料」共用，避免出现两套扣库存口径。
   *
   * 成本一律由后端 FIFO 算出，**绝不采信端上传来的金额**——端上能改的数字进不了成本账。
   * 完工扣的料挂在完工批次上（sourceAction=completion），撤回时按批次精确退回；
   * 缺料流程里的领用不挂批次（legacy_issue），撤回完工不会连它一起退掉。
   */
  private async consumeWorkOrderMaterials(
    manager: EntityManager,
    tenantId: number,
    workOrderId: number,
    items: MaterialUsageDto[],
    operatorId: number,
    options: {
      note: string;
      refType: string;
      batchId?: number | null;
      sourceAction?: 'completion' | 'legacy_issue';
    },
  ) {
    const created: WorkOrderMaterial[] = [];
    for (const item of items) {
      if (!item.materialId || !item.warehouseId) continue;
      if (!(Number(item.qty) > 0)) {
        throw new BadRequestException('用料数量必须大于 0');
      }
      const allocations = await consumeStockLots(manager, {
        tenantId,
        warehouseId: item.warehouseId,
        materialId: item.materialId,
        qty: item.qty,
        operatorId,
      });
      const totalCostCents = allocations.reduce(
        (sum, allocation) => sum + allocation.amountCents,
        0,
      );
      const materialUsage = await manager.save(
        WorkOrderMaterial,
        manager.create(WorkOrderMaterial, {
          tenantId,
          workOrderId,
          materialId: item.materialId,
          warehouseId: item.warehouseId,
          qty: item.qty,
          unitCostCents: averageUnitCost(allocations, item.qty),
          totalCostCents,
          completionBatchId: options.batchId ?? null,
          status: 'active',
          sourceAction: options.sourceAction ?? 'completion',
          createdBy: operatorId,
          updatedBy: operatorId,
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
            createdBy: operatorId,
            updatedBy: operatorId,
          }),
        ),
      );
      const { movement } = await applyStockDelta(manager, {
        tenantId,
        warehouseId: item.warehouseId,
        materialId: item.materialId,
        deltaQty: -item.qty,
        type: StockMovementType.OUTBOUND,
        unitCostCents: averageUnitCost(allocations, item.qty),
        refType: options.refType,
        refId: workOrderId,
        operatorId,
        note: options.note,
      });
      // 记住出库流水 id：撤回退料时新流水的 reversalOfMovementId 指向它，
      // 由唯一索引挡住「同一条扣料被冲销两次」。
      materialUsage.issueMovementId = movement.id;
      await manager.save(WorkOrderMaterial, materialUsage);
      created.push(materialUsage);
    }
    return created;
  }

  /**
   * 同仓同 SKU 的重复行合并成一行。
   *
   * 不合并的话，同一 SKU 会扣两次 FIFO、生成两条用料记录，撤回时看起来像重复退料；
   * 直接报错又会把维修工卡在完工页（他只是分两行填了同一个水龙头）。合并最省事。
   */
  private static mergeMaterialUsageRows(items: MaterialUsageDto[]): MaterialUsageDto[] {
    const merged: MaterialUsageDto[] = [];
    const indexByKey = new Map<string, number>();
    for (const item of items) {
      const key = `${item.materialId ?? 'x'}:${item.warehouseId ?? 'x'}`;
      const qty = Number(item.qty);
      if (!(qty > 0)) throw new BadRequestException('用料数量必须大于 0');
      const existing = indexByKey.get(key);
      if (existing === undefined || !item.materialId || !item.warehouseId) {
        indexByKey.set(key, merged.length);
        merged.push({ ...item, qty });
        continue;
      }
      const row = merged[existing];
      row.qty = Number((Number(row.qty) + qty).toFixed(2));
      const notes = [row.note?.trim(), item.note?.trim()].filter(Boolean);
      row.note = notes.length ? [...new Set(notes)].join('；').slice(0, 120) : row.note;
    }
    return merged;
  }

  /**
   * 提交完工。
   *
   * 完工是**唯一**扣库存的时机：维修过程中选的材料只是草稿，以本次提交的最终清单为准。
   * 一次提交对应一个完工批次（work_order_completion_batches），扣的料全部挂在这个批次上，
   * 撤回时才能精确退回「这一次」扣的料，而不是把缺料阶段领的也一起退掉。
   *
   * 全程一个事务：状态、批次、用料、FIFO 分摊、库存流水任一步失败就整体回滚，
   * 不会出现「状态到了待验收但库存没扣」或反过来的半笔账。
   */
  async completeWorkOrder(
    id: number,
    dto: CompleteWorkOrderDto,
    user: AuthUser,
    access?: ResolvedAccess,
  ) {
    const tenantId = this.resolveTenantId(user);
    const materials = RepairsService.mergeMaterialUsageRows(dto.materials ?? []);
    const inventoryMaterials = materials.filter((item) => item.materialId && item.warehouseId);

    // 仓库权限和缺料提报走同一套判定：先确认端上带回的仓确实在这个人可选范围内，
    // 再进事务动库存，避免伪造 warehouseId 扣到别的管理处的仓。
    for (const warehouseId of [
      ...new Set(inventoryMaterials.map((item) => item.warehouseId as number)),
    ]) {
      const option = await this.listWorkOrderStockOptions(id, user, access, warehouseId);
      if (option.warehouseId !== warehouseId) {
        throw new BadRequestException('完工用料所选仓库不在当前用户可用范围内');
      }
    }

    const idempotencyKey = dto.idempotencyKey?.trim() || null;
    const outcome = await this.dataSource.transaction(async (manager) => {
      const workOrder = await this.lockWorkOrder(manager, id, tenantId);
      this.assertWorkOrderScope(workOrder, access);

      // 幂等闸门放在状态校验**之前**：连点两下时第二次的状态已经是待验收，
      // 先校验状态只会抛「不能完工」，用户以为失败又点一次，反而更乱。
      if (idempotencyKey) {
        const done = await manager.findOne(WorkOrderCompletionBatch, {
          where: { tenantId, workOrderId: id, idempotencyKey },
        });
        if (done) return { workOrder, batch: done, duplicated: true as const };
      }

      /*
       * 这句会原样弹到维修工手机上，所以要说人话、还要说清「现在是什么状态」。
       * 最常见的是重复提交：第一次其实成功了（见幂等令牌），只是提示被微信订阅框吞了。
       */
      assertWorkOrderTransition(
        workOrder.status,
        WorkOrderStatus.DONE_PENDING_REVIEW,
        'complete',
        workOrder.status === WorkOrderStatus.DONE_PENDING_REVIEW
          ? '这张工单已经提交过完工，正在等业主验收，不用再提交一次'
          : workOrder.status === WorkOrderStatus.COMPLETED
            ? '这张工单已经验收完成，不能再提交完工'
            : `当前状态（${workOrderStatusLabel(workOrder.status)}）不能提交完工：请先接单，或材料到位后从工单池接回`,
      );
      await this.ensureAssigneeOrAdmin(workOrder, user);

      const fromStatus = workOrder.status;
      const beforeSnapshot = await this.captureWorkOrderSnapshot(manager, workOrder);

      // 端上从库存选的行本来就带名字；万一只传了 id，去材料库把名字查出来 ——
      // 工单和养护单上印的是给人看的名称，不能落一个 #37（2026-09-01）
      const materialNames = materials.length
        ? await this.materialNamesByIds(
            manager,
            tenantId,
            materials.map((item) => item.materialId).filter((v): v is number => !!v),
          )
        : new Map<number, string>();
      const incomingUsedMaterials = materials
        .map((item) => ({
          materialId: item.materialId,
          name:
            item.name ||
            (item.materialId ? materialNames.get(item.materialId) ?? '未知材料' : ''),
          qty: item.qty,
          unit: item.unit,
          note: item.note?.trim() || undefined,
        }))
        .filter((item) => item.name || item.materialId);

      const lastBatch = await manager.findOne(WorkOrderCompletionBatch, {
        where: { tenantId, workOrderId: id },
        order: { versionNo: 'DESC' },
      });
      const batch = await manager.save(
        WorkOrderCompletionBatch,
        manager.create(WorkOrderCompletionBatch, {
          tenantId,
          workOrderId: id,
          versionNo: (lastBatch?.versionNo ?? 0) + 1,
          status: 'active',
          idempotencyKey,
          fromStatus,
          submittedBy: user.id,
          submittedAt: new Date(),
          snapshot: {
            faultLocation: dto.faultLocation ?? workOrder.faultLocation,
            faultSymptom: dto.faultSymptom ?? workOrder.faultSymptom,
            repairContent: dto.repairContent ?? workOrder.repairContent,
            actionTags: dto.actionTags ?? workOrder.actionTags ?? [],
            actionNote: dto.actionNote ?? workOrder.actionNote,
            resultAttachments: dto.resultAttachments ?? workOrder.resultAttachments ?? [],
            feeCents: dto.feeCents ?? workOrder.feeCents ?? 0,
            // 撤回后这份清单原样回填成可编辑草稿，维修工不用把材料重选一遍
            materials: materials.map((item) => ({
              materialId: item.materialId ?? null,
              warehouseId: item.warehouseId ?? null,
              name:
                item.name ||
                (item.materialId ? materialNames.get(item.materialId) ?? '未知材料' : ''),
              qty: Number(item.qty),
              unit: item.unit,
              note: item.note?.trim() || undefined,
            })),
          },
          createdBy: user.id,
          updatedBy: user.id,
        }),
      );

      workOrder.status = WorkOrderStatus.DONE_PENDING_REVIEW;
      workOrder.completedAt = new Date();
      workOrder.actionTags = dto.actionTags ?? workOrder.actionTags;
      workOrder.actionNote = dto.actionNote ?? workOrder.actionNote;
      workOrder.faultLocation = dto.faultLocation ?? workOrder.faultLocation;
      workOrder.faultSymptom = dto.faultSymptom ?? workOrder.faultSymptom;
      workOrder.repairContent = dto.repairContent ?? workOrder.repairContent;
      // 缺料阶段可能已经领过一部分库存（sourceAction=legacy_issue，不挂完工批次）；
      // 那几行要留着，本次提交的只往后追加，不能整体覆盖。
      const carriedRows = await manager.count(WorkOrderMaterial, {
        where: { tenantId, workOrderId: id, status: 'active', completionBatchId: IsNull() },
      });
      if (incomingUsedMaterials.length) {
        workOrder.usedMaterials = carriedRows
          ? [...(workOrder.usedMaterials || []), ...incomingUsedMaterials]
          : incomingUsedMaterials;
      }
      workOrder.resultAttachments = dto.resultAttachments ?? workOrder.resultAttachments;
      workOrder.feeCents = dto.feeCents ?? workOrder.feeCents;
      workOrder.updatedBy = user.id;
      const saved = await manager.save(WorkOrder, workOrder);

      if (inventoryMaterials.length) {
        await this.consumeWorkOrderMaterials(
          manager,
          tenantId,
          saved.id,
          inventoryMaterials,
          user.id,
          {
            note: `完工领用：${saved.orderNo}（完工批次 #${batch.versionNo}）`,
            refType: 'work_order_complete',
            batchId: batch.id,
            sourceAction: 'completion',
          },
        );
      }

      await this.writeLog(
        manager,
        saved,
        fromStatus,
        'complete',
        user.id,
        dto.actionNote ?? null,
        [],
        {
          beforeSnapshot,
          afterSnapshot: await this.captureWorkOrderSnapshot(manager, saved),
        },
      );
      return { workOrder: saved, batch, duplicated: false as const };
    });

    // 重复提交（连点/重试）不再重复发通知、重复记 AI 样例，直接把上次的结果给回去。
    if (outcome.duplicated) return outcome.workOrder;

    await this.notifyOwnerOnStatus(outcome.workOrder, 'review');
    await this.recordCompletionAiFeedback(
      dto,
      outcome.workOrder,
      tenantId,
      user.id,
      outcome.batch.id,
    );
    return outcome.workOrder;
  }

  /**
   * 缺料登记：工单转「等待材料」并退回工单池，同时生成采购申请进审批流。
   *
   * 退回池子（assigneeId 置空）是有意的：材料短则半天长则一周，人不能被这张单挂着 ——
   * 「我的工单」里只留真正在手上能干的活。材料到货后办公室重新派单，
   * 或者哪个维修工顺路就自己从池子里接回去（见 acceptWorkOrder 的 isClaim 分支）。
   */
  async markNeedMaterial(
    id: number,
    dto: NeedMaterialDto,
    user: AuthUser,
    access?: ResolvedAccess,
  ) {
    const missingMaterials = this.normalizeMissingMaterials(dto.missingMaterials);
    const tenantId = this.resolveTenantId(user);

    // 零库存 SKU 也能从全局基础库选中报缺料。先校验端上带回的仓确实是
    // 这个人在该工单上可选的仓，再在事务里建仓库材料关系，避免伪造 id 污染别的仓。
    const requestedWarehouseIds = [
      ...new Set(
        missingMaterials
          .map((item) => item.warehouseId)
          .filter((warehouseId): warehouseId is number => !!warehouseId),
      ),
    ];
    for (const requestedWarehouseId of requestedWarehouseIds) {
      const option = await this.listWorkOrderStockOptions(
        id,
        user,
        access,
        requestedWarehouseId,
      );
      if (option.warehouseId !== requestedWarehouseId) {
        throw new BadRequestException('缺料所选仓库不在当前用户可用范围内');
      }
    }
    return this.dataSource.transaction(async (manager) => {
      const workOrder = await this.lockWorkOrder(manager, id, tenantId);
      this.assertWorkOrderScope(workOrder, access);
      assertWorkOrderTransition(
        workOrder.status,
        WorkOrderStatus.WAITING_MATERIAL,
        'need_material',
        'work order cannot wait material',
      );
      await this.ensureAssigneeOrAdmin(workOrder, user);

      const fromStatus = workOrder.status;
      // 缺料会把负责人置空退回工单池。撤回时要把人和接单时间原样接回来。
      const beforeSnapshot = await this.captureWorkOrderSnapshot(manager, workOrder);
      workOrder.status = WorkOrderStatus.WAITING_MATERIAL;
      workOrder.missingMaterials = missingMaterials;
      const usedMaterials =
        dto.usedMaterials?.filter((item) => item.materialId && item.warehouseId) ?? [];
      const usedMaterialNames = usedMaterials.length
        ? await this.materialNamesByIds(
            manager,
            tenantId,
            usedMaterials.map((item) => item.materialId).filter((id): id is number => !!id),
          )
        : new Map<number, string>();
      const newlyUsed = usedMaterials
        .map((item) => ({
          materialId: item.materialId,
          name:
            item.name ||
            (item.materialId ? usedMaterialNames.get(item.materialId) ?? '未知材料' : ''),
          qty: item.qty,
          unit: item.unit,
          note: item.note?.trim() || undefined,
        }))
        .filter((item) => item.name || item.materialId);
      if (newlyUsed.length) {
        workOrder.usedMaterials = [...(workOrder.usedMaterials || []), ...newlyUsed];
      }
      workOrder.assigneeId = null;
      workOrder.acceptedAt = null;
      workOrder.updatedBy = user.id;
      const saved = await manager.save(WorkOrder, workOrder);

      // stocks 同时就是「这个仓管理过哪些材料」的清单。只有 SKU 资料、本仓从未入过库时，
      // 建一条 qty=0 的记录；数量用完也不删，所以库存页以后仍能找到它。
      const warehouseMaterials = [
        ...new Map(
          missingMaterials
            .filter(
              (item): item is typeof item & { materialId: number; warehouseId: number } =>
                !!item.materialId && !!item.warehouseId,
            )
            .map((item) => [`${item.warehouseId}:${item.materialId}`, item]),
        ).values(),
      ];
      if (warehouseMaterials.length) {
        await manager
          .createQueryBuilder()
          .insert()
          .into(Stock)
          .values(
            warehouseMaterials.map((item) => ({
              tenantId,
              warehouseId: item.warehouseId,
              materialId: item.materialId,
              qty: 0,
              safetyQty: 0,
              locationId: null,
              createdBy: user.id,
              updatedBy: user.id,
            })),
          )
          .orIgnore()
          .execute();
      }
      // 缺料前的领用不挂完工批次：撤回完工只退「完工那次扣的料」，
      // 不能把维修工早就装上去的这几件也退回仓库。
      await this.consumeWorkOrderMaterials(
        manager,
        tenantId,
        saved.id,
        usedMaterials,
        user.id,
        {
          note: `工单 ${saved.orderNo} 缺料前已领用`,
          refType: 'work_order',
          batchId: null,
          sourceAction: 'legacy_issue',
        },
      );

      // 审批链按后台「采购审批链」配置走：办公室环节关了，缺料申请直接进经理 / 采购 / 通过
      const purchaseFlow = (await this.settings.getSettingsByTenant(tenantId)).purchaseApproval;
      const purchaseStatus = nextPurchaseStatus(
        purchaseFlow,
        'create',
        dto.missingMaterials.reduce((sum, item) => sum + (item.estUnitCostCents ?? 0) * item.qty, 0),
      );
      const pendingStep = pendingStepFor(purchaseStatus) ?? {
        pageKey: 'app:dispatch',
        action: 'edit' as const,
        eventKey: 'purchase_pending_office',
        title: '缺料申请待汇总',
      };
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
          // 默认先进物业办公室汇总合并环节；后台把办公室环节关掉时直接进下一环
          status: purchaseStatus,
          managerId: null,
          managerAt: null,
          purchaserId: null,
          purchaserAt: null,
          rejectReason: null,
          createdBy: user.id,
          updatedBy: user.id,
        }),
      );

      // 通知下一环节的人：默认是负责派单的人（待汇总），办公室环节关了就是经理 / 采购
      const dispatcherIds = await this.accessService.userIdsWithPermission(
        tenantId,
        pendingStep.pageKey,
        pendingStep.action,
      );
      const requestOfficeId = await this.accessService.officeIdOfCommunity(
        tenantId,
        saved.communityId,
      );
      const dispatcherCoverage = await this.accessService.filterUsersCoveringOffice(
        tenantId,
        dispatcherIds,
        requestOfficeId,
      );
      const scopedDispatcherIds = dispatcherIds.filter((id) =>
        dispatcherCoverage.has(id),
      );
      const officeUsers = scopedDispatcherIds.length
        ? await manager.find(User, {
            where: {
              id: In(scopedDispatcherIds),
              tenantId,
              status: UserStatus.ACTIVE,
            },
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
              eventKey: pendingStep.eventKey,
              title: `工单 ${saved.orderNo} ${pendingStep.title}（${purchaseRequest.requestNo}）`,
              // 带上 workOrderId：工单撤回缺料时要按它找到这条待办并标为已失效
              payload: {
                purchaseRequestId: purchaseRequest.id,
                requestNo: purchaseRequest.requestNo,
                workOrderId: saved.id,
              },
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
        [
          newlyUsed.length
            ? `已领用：${newlyUsed.map((item) => `${item.name} ×${item.qty}${item.unit || ''}`).join('、')}`
            : null,
          `缺料：${summary}`,
          dto.note?.trim(),
          '已退回工单池，材料到位后重新派单',
        ]
          .filter(Boolean)
          .join('；'),
        [],
        {
          beforeSnapshot,
          afterSnapshot: await this.captureWorkOrderSnapshot(manager, saved),
        },
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
    access?: ResolvedAccess,
  ) {
    const missingMaterials = this.normalizeMissingMaterials(dto.missingMaterials);
    const tenantId = this.resolveTenantId(user);
    return this.dataSource.transaction(async (manager) => {
      const workOrder = await this.lockWorkOrder(manager, id, tenantId);
      this.assertWorkOrderScope(workOrder, access);
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
    rows: Array<{
      materialId?: number;
      warehouseId?: number;
      name: string;
      qty: number;
      unit?: string;
      spec?: string;
      note?: string;
      photoUrls?: string[];
      estUnitCostCents?: number;
    }>,
  ) {
    const normalized = (rows || [])
      .map((item) => ({
        materialId: item.materialId ?? undefined,
        warehouseId: item.warehouseId ?? undefined,
        name: String(item.name ?? '').trim(),
        qty: Number(item.qty),
        unit: item.unit?.trim() || undefined,
        // 申购新材料带的型号 / 备注 / 样本照片，原样进缺料清单和采购申请明细
        spec: item.spec?.trim() || undefined,
        note: item.note?.trim() || undefined,
        photoUrls: Array.isArray(item.photoUrls)
          ? item.photoUrls.filter((url) => typeof url === 'string' && url.trim()).slice(0, 3)
          : undefined,
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

  async reviewWorkOrder(
    id: number,
    dto: ReviewWorkOrderDto,
    user: AuthUser,
    access?: ResolvedAccess,
  ) {
    const tenantId = this.resolveTenantId(user);
    return this.dataSource.transaction(async (manager) => {
      const workOrder = await this.lockWorkOrder(manager, id, tenantId);
      this.assertWorkOrderScope(workOrder, access);
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

      const beforeSnapshot = await this.captureWorkOrderSnapshot(manager, workOrder);
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
      await this.writeLog(manager, saved, fromStatus, 'review', user.id, null, [], {
        beforeSnapshot,
        afterSnapshot: await this.captureWorkOrderSnapshot(manager, saved),
      });
      return { workOrder: saved, review };
    });
  }

  /** 撤单：业主（限本人提交）与后台均可，需选择原因 */
  async cancelWorkOrder(
    id: number,
    dto: CancelWorkOrderDto,
    user: AuthUser,
    access?: ResolvedAccess,
  ) {
    const reasonLabel = CANCEL_REASONS[dto.reasonCode];
    if (!reasonLabel) throw new BadRequestException('invalid cancel reason');
    if (dto.reasonCode === 'other' && !dto.note?.trim()) {
      throw new BadRequestException('请填写撤单原因');
    }
    const tenantId = this.resolveTenantId(user);
    return this.dataSource.transaction(async (manager) => {
      const workOrder = await this.lockWorkOrder(manager, id, tenantId);
      this.assertWorkOrderScope(workOrder, access);
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
      // 撤单是旁路节点：可以从待派单/已派单/维修中/等待材料任意一处进来，
      // 撤回时必须回到真实的那一处，而不是统一退回「待派单」。
      const beforeSnapshot = await this.captureWorkOrderSnapshot(manager, workOrder);
      workOrder.status = WorkOrderStatus.CANCELLED;
      workOrder.updatedBy = user.id;
      const saved = await manager.save(WorkOrder, workOrder);
      const note = dto.note?.trim()
        ? `${reasonLabel}：${dto.note.trim()}`
        : reasonLabel;
      await this.writeLog(manager, saved, fromStatus, 'cancel', user.id, note, [], {
        beforeSnapshot,
        afterSnapshot: await this.captureWorkOrderSnapshot(manager, saved),
      });
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
    input: {
      contactName?: string | null;
      contactPhone?: string | null;
      houseId?: number | null;
      /** 只留了电话没留姓名时，拿它里面的门牌当联系人标识 */
      addressText?: string | null;
    },
    tenantId: number,
    submittedBy: number | null,
    opts: { submitterIsContact: boolean; allowHouseOwnerFallback: boolean },
  ): Promise<{ name: string | null; phone: string | null }> {
    const name = input.contactName?.trim() || null;
    const phone = input.contactPhone?.trim() || null;
    if (name && phone) return { name, phone };

    /**
     * **姓名和电话必须成对来自同一个人**（2026-09-01 用户反馈）。
     *
     * 原来两个字段各自独立兜底：`name = name || 提交人.name`、`phone = phone || 提交人.phone`。
     * 于是报修人说了别人的电话、没说人名时，落库的是「叶双 / 18201728748」——
     * 名字是登录的那个人，号码是另一个人的。维修工照着打过去会喊错人，
     * 办公室看单也以为是叶双报的。
     *
     * 现在：只要有一半是报修人明确给的，就**不拿另一个人来凑**。
     * 缺的那一半用「门牌」当标识（房号是这一单唯一确定的身份线索），
     * 连门牌都没有才留空 —— 空着至少不会张冠李戴。
     */
    if (name || phone) {
      return { name: name || this.contactLabelFromAddress(input) || null, phone };
    }

    // 两个都没有：整对取同一个人，先提交人后房主，不混着拿
    if (submittedBy && opts.submitterIsContact) {
      const submitter = await this.dataSource.getRepository(User).findOne({
        where: { id: submittedBy },
        select: ['id', 'name', 'phone', 'wxNickname'],
      });
      const submitterName = submitter?.name || submitter?.wxNickname || null;
      if (submitterName || submitter?.phone) {
        return { name: submitterName, phone: submitter?.phone || null };
      }
    }

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
      if (owner?.name || owner?.phone) {
        return { name: owner.name || null, phone: owner.phone || null };
      }
    }
    return { name: null, phone: null };
  }

  /**
   * 只留了电话、没留姓名时拿来当联系人的标识：「278号503室」。
   *
   * 比空着强 —— 维修工一眼知道是哪一户报的；也比硬安一个登录人的名字强 ——
   * 那是张冠李戴。addressText 里已经带了小区名，这里只取门牌那一截。
   */
  private contactLabelFromAddress(input: { addressText?: string | null }): string {
    const text = (input.addressText || '').trim();
    if (!text) return '';
    const matched = /(\d+弄)?\s*\d+号\s*\d*室?/.exec(text);
    return matched ? matched[0].replace(/\s+/g, '') : '';
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
    const rule = await this.findTypeRule(
      request.repairType ?? undefined,
      workOrder.tenantId,
      workOrder.communityId,
    );
    const typeLabel = rule?.label || '报修';
    const page = `pages/order-detail/order-detail?id=${workOrder.id}`;
    const when = this.formatWhen(new Date());

    if (kind === 'dispatched') {
      await this.notifications.notifyUser({
        tenantId: workOrder.tenantId,
        receiverId: request.submittedBy,
        eventKey: 'order_dispatched',
        title: `${typeLabel}已派单${assigneeName ? `给 ${assigneeName}` : ''}，等待维修工接单`,
        payload: { workOrderId: workOrder.id, orderNo: workOrder.orderNo },
        page,
        template: 'orderDispatched',
        // 只给语义字段，具体填到模板哪个 thing/time 由 notifications 按模板真实字段决定
        templateFields: {
          orderNo: workOrder.orderNo,
          type: typeLabel,
          status: assigneeName ? `已派单给${assigneeName}，待接单` : '已派单，待接单',
          statusShort: '待维修工接单',
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
      ? await this.dispatchersToNotify(
          workOrder.tenantId,
          workOrder.communityId,
          submittedBy,
        )
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
            ? unassigned
              ? '紧急新工单，等待办公室派单'
              : '紧急新工单，等待维修工接单'
            : unassigned
              ? '新工单待派单'
              : '新工单待接单',
          statusShort: request?.urgent
            ? unassigned ? '紧急待派' : '紧急待接'
            : unassigned ? '待派单' : '待接单',
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
  private async dispatchersToNotify(
    tenantId: number,
    communityId: number,
    exceptUserId: number | null,
  ): Promise<User[]> {
    const officeId = await this.accessService.officeIdOfCommunity(tenantId, communityId);
    // 没有关联管理处时不能把单广播给全公司办公室，避免跨管理处泄露报修地址与住户信息。
    if (!officeId) return [];

    // 办公室可能只使用 Web，也可能同时使用员工小程序；两种派单入口取并集。
    // 最终再按工单所属管理处的数据范围收窄，超级管理员不再成为唯一兜底收件人。
    const [appDispatcherIds, webDispatcherIds] = await Promise.all([
      this.accessService.userIdsWithPermission(tenantId, 'app:dispatch', 'edit'),
      this.accessService.userIdsWithPermission(tenantId, 'work-orders', 'edit'),
    ]);
    const ids = [...new Set([...appDispatcherIds, ...webDispatcherIds])]
      .filter((id) => id !== exceptUserId);
    if (!ids.length) return [];
    const coverage = await this.accessService.filterUsersCoveringOffice(tenantId, ids, officeId);
    const scopedIds = ids.filter((id) => coverage.has(id));
    if (!scopedIds.length) return [];
    return this.userRepo.find({
      where: { id: In(scopedIds), tenantId, status: UserStatus.ACTIVE },
    });
  }

  /** 转单只通知工单所属管理处、且有派单权限的办公室人员。 */
  private async notifyOfficeOnTransfer(
    workOrder: WorkOrder,
    reason: string,
    requesterId: number,
  ): Promise<void> {
    const [request, requester, officeId] = await Promise.all([
      this.repairRequestRepo.findOne({ where: { id: workOrder.requestId, tenantId: workOrder.tenantId } }),
      this.userRepo.findOne({ where: { id: requesterId, tenantId: workOrder.tenantId }, select: ['id', 'name'] }),
      this.accessService.officeIdOfCommunity(workOrder.tenantId, workOrder.communityId),
    ]);
    // 有些办公室人员只使用网页后台，没有勾员工端“派单台”。两种入口都是合法的
    // 派单人，因此取并集，避免只有超级管理员收到转单提醒。
    const [appDispatcherIds, webDispatcherIds] = await Promise.all([
      this.accessService.userIdsWithPermission(workOrder.tenantId, 'app:dispatch', 'edit'),
      this.accessService.userIdsWithPermission(workOrder.tenantId, 'work-orders', 'edit'),
    ]);
    const dispatcherIds = [...new Set([...appDispatcherIds, ...webDispatcherIds])];
    const coverage = await this.accessService.filterUsersCoveringOffice(
      workOrder.tenantId,
      dispatcherIds,
      officeId,
    );
    const receiverIds = dispatcherIds.filter((id) => id !== requesterId && coverage.has(id));
    const address = request?.addressText?.trim() || '（未填地址）';
    const content = request?.content?.trim() || '';
    if (!receiverIds.length) {
      this.logger.warn(
        `转单 ${workOrder.orderNo} 没有可通知的办公室账号：请检查所属管理处范围及“派单/工单编辑”权限`,
      );
    }
    for (const receiverId of receiverIds) {
      await this.notifications.notifyUser({
        tenantId: workOrder.tenantId,
        receiverId,
        eventKey: 'order_transfer_requested',
        title: `待重新派单：${workOrder.orderNo} · ${address}`,
        payload: { workOrderId: workOrder.id, orderNo: workOrder.orderNo, reason, requesterId },
        page: `pages/order-detail/order-detail?id=${workOrder.id}`,
        template: 'orderAssigned',
        templateFields: {
          orderNo: workOrder.orderNo,
          type: '待重新分类',
          status: `${requester?.name || '维修工'}申请转单`,
          statusShort: '待转派',
          content: reason || content,
          assignee: '',
          address,
          reporter: request?.contactName?.trim() || '',
          time: this.formatWhen(new Date()),
          reportedAt: this.formatWhen(new Date(workOrder.createdAt)),
          dueAt: '',
        },
      });
    }
  }

  private async notifyAssigneeOnDispatch(
    workOrder: WorkOrder,
    note: string | null,
  ): Promise<void> {
    if (!workOrder.assigneeId) return;
    const request = await this.repairRequestRepo.findOne({
      where: { id: workOrder.requestId, tenantId: workOrder.tenantId },
    });
    const rule = await this.findTypeRule(
      request?.repairType ?? undefined,
      workOrder.tenantId,
      workOrder.communityId,
    );
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
      title: `新工单待接：${typeLabel} · ${address}${deadline}`,
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
        status: '办公室已派单，请确认接单',
        statusShort: '待接单',
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
      workOrder.communityId,
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
    // 端上判不出类型（或老版本没判）时服务端再用本管理处的生效关键词判一次。
    // 仍判不出就保持“未识别”，明确进入派单台；不能硬塞进「其它」—— 一旦「其它」
    // 配了默认维修工，真正未识别的单也会绕过办公室直接推给错误的人。
    const repairType =
      dto.repairType?.trim() ||
      (await this.guessRepairType(dto.content, tenantId, dto.communityId)) ||
      null;
    // 类型规则只用来定时限和「该通知谁」：匹配到的维修工都收到通知、都在自己的工单池里看到，
    // 谁先接单归谁。原来是自动派给规则里唯一那个人（2026-08-28 之前），别的同类型维修工既没通知
    // 也看不到单，报单的人自己也找不到
    const typeRule = await this.findTypeRule(repairType ?? undefined, tenantId, dto.communityId);
    const candidates = await this.ruleCandidates(tenantId, typeRule, dto.communityId);
    const configuredAssigneeCount = typeRule ? ruleAssigneeIds(typeRule).length : 0;
    const routingNote = candidates.length
      ? `已进入工单池并通知维修工 ${candidates.map((c) => c.name || '未命名员工').join('、')}`
      : !repairType
        ? '未识别到报修类型，已转办公室派单'
        : !typeRule
          ? '该管理处没有启用此报修类型，已转办公室派单'
          : configuredAssigneeCount === 0
            ? '该管理处的此报修类型未配置默认维修工，已转办公室派单'
            : '已配置的默认维修工当前无接单权限或不在本管理处范围，已转办公室派单';
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
          candidateIds: candidates.map((candidate) => candidate.id),
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
            routingNote,
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
    // 即使类型没配默认维修工也必须调用：notifyCandidatesOnCreate 会退给有「派单台·派单」
    // 权限的办公室人员。旧代码在外层先判断 candidates.length，导致方法里的办公室兜底
    // 永远进不去，新报修就静悄悄躺在池子里。
    await this.notifyCandidatesOnCreate(created.workOrder, candidates, submittedBy);

    await this.recordRepairAiFeedback(dto, created, repairType, urgent, submittedBy);

    return created;
  }

  /** 记录草稿与最终提交的差异；失败只影响学习数据，不影响主业务。 */
  private async recordRepairAiFeedback(
    dto: CreateRepairRequestDto,
    created: { request: RepairRequest; workOrder: WorkOrder },
    repairType: string | null,
    urgent: boolean,
    userId: number | null,
  ) {
    if (!dto.aiAssist) return;
    try {
      const cfg = await this.settings.getAiAssistRaw(created.workOrder.tenantId);
      await this.aiFeedback.record(created.workOrder.tenantId, {
        kind: 'repair',
        workOrderId: created.workOrder.id,
        sourceText: dto.aiAssist.sourceText,
        draft: dto.aiAssist.draft,
        finalValue: {
          description: dto.content,
          // 只拿本次表单真正提交的联系人对比；服务端从登录账号/房屋档案兜出的联系人
          // 不在原话里，拿它教模型会变成“没说人名也要猜一个”。
          contactName: dto.contactName || '',
          phone: dto.contactPhone || '',
          repairType: repairType || '',
          urgent,
        },
        model: cfg.model,
        userId,
      });
    } catch (error) {
      this.logger.warn(
        `AI 报修纠错记录失败（不影响报修）：${error instanceof Error ? error.message : error}`,
      );
    }
  }

  private async recordCompletionAiFeedback(
    dto: CompleteWorkOrderDto,
    workOrder: WorkOrder,
    tenantId: number,
    userId: number,
    completionBatchId?: number | null,
  ) {
    if (!dto.aiAssist) return;
    try {
      const cfg = await this.settings.getAiAssistRaw(tenantId);
      await this.aiFeedback.record(tenantId, {
        kind: 'completion',
        workOrderId: workOrder.id,
        // 挂上完工批次：这次完工被撤回时，这条样例要一起标失效，
        // 否则一份「后来被推翻的填写」会作为正确答案继续教模型。
        completionBatchId: completionBatchId ?? null,
        sourceText: dto.aiAssist.sourceText,
        draft: dto.aiAssist.draft,
        finalValue: {
          actionNote: dto.actionNote || '',
          faultLocation: dto.faultLocation || '',
          faultSymptom: dto.faultSymptom || '',
          materials: (dto.materials || [])
            .map((item) => item.name?.trim().split(/[（(\s]/)[0])
            .filter((item): item is string => !!item),
          feeRuleCode: dto.feeRuleCode || '',
          feeCents: dto.feeCents ?? null,
        },
        model: cfg.model,
        userId,
      });
    } catch (error) {
      this.logger.warn(
        `AI 完工纠错记录失败（不影响完工）：${error instanceof Error ? error.message : error}`,
      );
    }
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
        const beforeSnapshot = await this.captureWorkOrderSnapshot(manager, current);
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
          [],
          {
            beforeSnapshot,
            afterSnapshot: await this.captureWorkOrderSnapshot(manager, saved),
          },
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
  /**
   * 一句话报修的识别入口。**规则和大模型分工，不是二选一**：
   *
   *   · 规则 + 房产库定门牌和电话 —— 模型不知道你的库，它会编一个看着合理的房号，
   *     地址编错的代价是师傅按门牌找过去白跑一趟。
   *   · 模型只做语义：哪一段是地址、故障描述怎么理顺、有没有说人名。
   *     这才是正则永远追不完的地方（今天补了逗号停顿，明天来一句「五千五百十一弄」）。
   *
   * 两条路**并行**跑，模型给的地址只当线索：规则自己撞上库了就不用它；没撞上才拿
   * 模型圈出来的那一段再撞一次 —— 撞不上照样返回未匹配，绝不把模型说的地址直接当结果。
   * 没配大模型 / 调不通 / 超时，ai 为 null，整条链路退回原来的行为。
   */
  async parseRepairAddress(
    dto: ParseRepairAddressDto,
    user: AuthUser,
    access?: ResolvedAccess,
  ) {
    const tenantId = this.resolveTenantId(user);
    const repairTypes = this.listPublicRepairTypes(
      user,
      dto.communityId ?? null,
      access,
    );
    const rank = (level?: string) =>
      level === 'house' ? 3 : level === 'building' ? 2 : level === 'community' ? 1 : 0;
    let ai: Awaited<ReturnType<RepairTextAiService['parse']>> = null;
    let byRule: Awaited<ReturnType<RepairsService['parseAddressByRule']>>;
    if (dto.lite) {
      /**
       * 省钱模式（填表报修边打字边识别）：规则先撞库，撞到楼栋或房号就不调模型 ——
       * 打字的人自己在写描述，用不着模型整理；只有地址没撞上或只到小区才请模型圈地址。
       * 2026-09-05 查费用：这个接口占大模型调用的八成多，大头是打字每停顿一次就调一次。
       */
      byRule = await this.parseAddressByRule(dto, user, access);
      if (!byRule.matched || rank(byRule.level) <= 1) {
        ai = await this.repairTextAi.parse(tenantId, dto.text, await repairTypes);
      }
    } else {
      [ai, byRule] = await Promise.all([
        repairTypes.then((types) => this.repairTextAi.parse(tenantId, dto.text, types)),
        this.parseAddressByRule(dto, user, access),
      ]);
    }
    let result = byRule;
    /**
     * 什么时候拿模型圈的那一段再撞一次：规则没撞上，**或者只撞到小区级**。
     *
     * 只看 matched 不够 —— 「枫桦一期十七号二零一」里规则靠「一期」就撞上了小区，
     * matched=true 但 level='community'，地址落成「枫桦景苑一期 公共区域」，
     * 门牌整个丢了（2026-09-01 线上实测）。模型会把中文数字转成「17号201」，
     * 那一段再走一遍规则就能定位到房号。
     * 重试只做一次，而且**只有撞出更细的粒度才采用** —— 撞不上或更粗就保持原判。
     */
    if (
      (!result.matched || rank(result.level) <= 1) &&
      ai?.addressText &&
      ai.addressText !== dto.text
    ) {
      const retry = await this.parseAddressByRule({ ...dto, text: ai.addressText }, user, access);
      if (retry.matched && rank(retry.level) > rank(result.matched ? result.level : undefined)) {
        result = retry;
      }
    }
    /**
     * 公区报修：报修人会连着**自己的门牌**一起说 ——「5511弄278号503报门口机没有反应」。
     * 503 是他住哪儿，不是坏在哪儿；门口机在单元门口。
     *
     * 不降级的话这单会挂到 503 室头上：统计上算成这一户的户内维修，维修工按 503
     * 敲门也找错地方（该去的是 278 号楼下）。所以撞到房号也要退回楼栋级 +「公共区域」，
     * 而房号不丢 —— 转成 reporterRoomNo 给端上当联系人标识（那户人报的、他的电话）。
     *
     * 谁来判：「楼下门 / 单元门 / 家里」这类明确词由确定规则优先，
     * 文字没说清时才交给 AI。这样同一句话不会因模型偶发输出而反向覆盖明确场景。
     */
    const publicArea = classifyPublicAreaText(dto.text) ?? !!ai?.publicArea;
    const reporterRoomNo = result.matched && result.level === 'house' ? result.roomNo ?? null : null;
    if (publicArea && result.matched && result.level === 'house') {
      result = {
        ...result,
        level: 'building' as const,
        houseId: null,
        roomNo: null,
        // 把地址里的室号摘掉，剩下的就是「小区+楼栋」：永北5511弄278号503室 → 永北5511弄278号
        addressText: `${(result.addressText || '').replace(/\d+室$/, '')} 公共区域`.trim(),
      };
    }
    return {
      ...result,
      /** 这单坏在公共区域（不是某一户里）—— 端上据此提示，也别再追问房号 */
      publicArea,
      /**
       * 报修人自己的房号。公区单降级后房号从地址里拿掉了，但它仍然有用：
       * 端上拿它当联系人标识（「278号503室」），比挂一个对不上号的默认联系人强。
       */
      reporterRoomNo,
      /** 模型整理出来的那几样，端上按需覆盖对应输入框；没开 AI 时不返回这个字段 */
      ai: ai
        ? {
            addressText: ai.addressText || '',
            description: ai.description || '',
            contactName: ai.contactName || '',
            phone: ai.phone || '',
            urgent: !!ai.urgent,
            publicArea: !!ai.publicArea,
            repairType: ai.repairType || '',
            sampleMatched: !!ai.sampleMatched,
          }
        : undefined,
    };
  }

  private async parseAddressByRule(
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
    if (scope) leaves = leaves.filter((c) => scope.includes(c.id));
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
    const targetCandidates = await this.ruleCandidates(tenantId, target, workOrder.communityId);
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
        if (!workOrder.assigneeId) {
          workOrder.candidateIds = targetCandidates.map((candidate) => candidate.id);
        }
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
  private async ruleCandidates(
    tenantId: number,
    rule: RepairTypeRule | null,
    communityId?: number | null,
  ): Promise<User[]> {
    const ids = rule ? ruleAssigneeIds(rule) : [];
    if (!ids.length) return [];
    // 新工单必须先落到管理处，再取该管理处能接单的人。小区没有归属管理处时不使用
    // 公司模板“猜一个人”兜底，直接交给办公室派单，避免跨管理处推送。
    const officeId = communityId
      ? await this.accessService.officeIdOfCommunity(tenantId, communityId)
      : rule?.officeId ?? null;
    if (!officeId) return [];
    const coverage = await this.accessService.filterUsersCoveringOffice(tenantId, ids, officeId);
    const users = await this.userRepo.find({ where: { id: In(ids), tenantId } });
    const picked: User[] = [];
    for (const id of ids) {
      const user = users.find((u) => u.id === id);
      if (!user || user.status !== UserStatus.ACTIVE) continue;
      if (!coverage.has(user.id)) continue;
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

  /** 工单池角标：管理处范围内所有尚可主动接单的工单。 */
  async poolCount(user: AuthUser, access: ResolvedAccess): Promise<{ count: number }> {
    const tenantId = this.resolveTenantId(user);
    const base: FindOptionsWhere<WorkOrder> = {
      tenantId,
    };
    const scope = this.scopeIds(access);
    if (scope) {
      if (!scope.length) return { count: 0 };
      base.communityId = In(scope);
    }
    const hasPool = !!access.pages['app:pool']?.view;
    if ((await this.canDispatch(user, access)) && !hasPool) {
      return {
        count: await this.workOrderRepo.count({
          where: {
            ...base,
            assigneeId: IsNull(),
            status: In(CLAIMABLE_WORK_ORDER_STATUSES),
          },
        }),
      };
    }
    return {
      count: await this.workOrderRepo.count({
        where: [
          { ...base, status: In(CLAIMABLE_WORK_ORDER_STATUSES) },
          { ...base, status: WorkOrderStatus.DISPATCHED, assigneeId: user.id },
        ],
      }),
    };
  }

  /**
   * 底部 tab 角标一次拿齐：工单池 / 派单台 / 在手工单各有几件事。
   *
   * 各格自己的页面加载完会按列表条数设一次；这里是给**任何** tab 页 onShow、
   * 以及接单 / 完工之后立刻同步用的（2026-09-04 反馈：接完单角标还是旧数）。
   * 口径必须和各列表一致，否则角标数和点进去看到的条数对不上：
   *   pool     = scope=pool 默认视图（公开待接 + 派给我的待接）
   *   dispatch = scope=dispatch（没负责人、没候选人的新单）
   *   mine     = 在手工单页列的（派到我头上、正在修 / 等材料）
   * 没权限的那格给 0，端上本来也不显示。
   */
  async badgeCounts(
    user: AuthUser,
    access: ResolvedAccess,
  ): Promise<{ pool: number; dispatch: number; mine: number }> {
    const tenantId = this.resolveTenantId(user);
    const base: FindOptionsWhere<WorkOrder> = { tenantId };
    const scope = this.scopeIds(access);
    if (scope) {
      if (!scope.length) return { pool: 0, dispatch: 0, mine: 0 };
      base.communityId = In(scope);
    }
    const has = (key: string) =>
      access.isPlatformAdmin || access.isTenantAdmin || !!access.pages[key]?.view;
    const [pool, dispatch, mine] = await Promise.all([
      has('app:pool')
        ? this.workOrderRepo.count({
            where: [
              { ...base, status: In(CLAIMABLE_WORK_ORDER_STATUSES) },
              { ...base, status: WorkOrderStatus.DISPATCHED, assigneeId: user.id },
            ],
          })
        : 0,
      has('app:dispatch')
        ? this.workOrderRepo.count({
            where: {
              ...base,
              status: WorkOrderStatus.CREATED,
              assigneeId: IsNull(),
              candidateIds: Raw((alias) => `jsonb_array_length(${alias}) = 0`),
            },
          })
        : 0,
      has('app:my-orders')
        ? this.workOrderRepo.count({
            where: {
              ...base,
              assigneeId: user.id,
              status: In([WorkOrderStatus.IN_PROGRESS, WorkOrderStatus.WAITING_MATERIAL]),
            },
          })
        : 0,
    ]);
    return { pool, dispatch, mine };
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
    const name = assignee.name || '未命名员工';
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
    const repairContentQb = this.repairRequestRepo
      .createQueryBuilder('req')
      .innerJoin(WorkOrder, 'wo', 'wo.request_id = req.id AND wo.tenant_id = req.tenant_id')
      // 必须带上主键：take() + join 会走 TypeORM 的 DISTINCT-alias 分页，
      // 它生成的外层 SQL 引用 distinctAlias.req_id，主键不在 select 里就报
      // 「column distinctAlias.req_id does not exist」——线上 /repair-suggestions 一直 500
      .select(['req.id', 'req.repairType', 'req.content', 'req.createdAt'])
      .where('req.tenant_id = :tenantId', { tenantId })
      .andWhere('wo.status <> :voided', { voided: WorkOrderStatus.VOIDED });
    if (communityIds) {
      repairContentQb.andWhere('req.community_id IN (:...communityIds)', {
        communityIds: communityIds.length ? communityIds : [-1],
      });
    }
    const rows = await repairContentQb
      .orderBy('req.id', 'DESC')
      .take(SUGGESTION_SCAN_LIMIT)
      .getMany();

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
      .andWhere('wo.status <> :voided', { voided: WorkOrderStatus.VOIDED })
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
    const spotQb = this.repairRequestRepo
      .createQueryBuilder('req')
      .innerJoin(WorkOrder, 'wo', 'wo.request_id = req.id AND wo.tenant_id = req.tenant_id')
      // 同上：take() + join 的分页 SQL 要用到主键
      .select(['req.id', 'req.addressText', 'req.content', 'req.createdAt'])
      .where('req.tenant_id = :tenantId', { tenantId })
      .andWhere('wo.status <> :voided', { voided: WorkOrderStatus.VOIDED });
    if (communityIds) {
      spotQb.andWhere('req.community_id IN (:...communityIds)', {
        communityIds: communityIds.length ? communityIds : [-1],
      });
    }
    const rows = await spotQb
      .orderBy('req.id', 'DESC')
      .take(SUGGESTION_SCAN_LIMIT)
      .getMany();
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

  /** 采购申请号改为每日短序号（PR-260902-001），工单来源改在明细行中展示。 */
  private async buildPurchaseRequestNo(
    manager: EntityManager,
    tenantId: number,
    _workOrderId: number,
  ): Promise<string> {
    return nextPurchaseRequestNo(manager, tenantId);
  }

  private async lockWorkOrder(manager, id: number, tenantId: number) {
    const workOrder = await manager.findOne(WorkOrder, {
      where: { id, tenantId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!workOrder) throw new NotFoundException('work order not found');
    return workOrder;
  }

  /** 按 id 操作也必须套同一份管理处/小区范围；越界统一伪装成不存在，避免泄露单号。 */
  private assertWorkOrderScope(workOrder: WorkOrder, access?: ResolvedAccess): void {
    const scope = this.scopeIds(access);
    if (scope && !scope.includes(workOrder.communityId)) {
      throw new NotFoundException('work order not found');
    }
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
    attachments: string[] = [],
    extra?: {
      /** 动作执行**前**的工单快照；撤回时原样写回，是精确撤回的唯一依据 */
      beforeSnapshot?: WorkOrderSnapshot | null;
      afterSnapshot?: WorkOrderSnapshot | null;
      rolledBackLogId?: number | null;
      rollbackDetail?: Record<string, unknown> | null;
    },
  ): Promise<WorkOrderLog> {
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
        attachments,
        beforeSnapshot: extra?.beforeSnapshot ?? null,
        afterSnapshot: extra?.afterSnapshot ?? null,
        rolledBackLogId: extra?.rolledBackLogId ?? null,
        rollbackDetail: extra?.rollbackDetail ?? null,
        createdBy: operatorId,
        updatedBy: operatorId,
      }),
    );
  }

  private static toIso(value: Date | string | null | undefined): string | null {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  /**
   * 工单关键字段快照，写进 work_order_logs.before_snapshot。
   *
   * 为什么每个流转动作都要拍一张：撤回**必须**恢复到真实的上一节点，不能靠当前字段倒推。
   * 「维修中」可能来自待派单主动认领、等待材料接回、或定向派单后接单；
   * 「已派单」可能是首次派单也可能是换人改派——不拍快照就只能猜，猜错就是
   * 把单挂到错的维修工头上、SLA 从错的时刻重算（2026-09-03 撤回改造）。
   *
   * repair_type 存在 repair_requests 上、转单会改它，所以额外读一次报修单。
   */
  private async captureWorkOrderSnapshot(
    manager: EntityManager,
    workOrder: WorkOrder,
  ): Promise<WorkOrderSnapshot> {
    const request = await manager.findOne(RepairRequest, {
      where: { tenantId: workOrder.tenantId, id: workOrder.requestId },
      select: ['id', 'repairType'],
    });
    const activeBatch = await this.findActiveCompletionBatch(
      manager,
      workOrder.tenantId,
      workOrder.id,
    );
    return {
      status: workOrder.status,
      assigneeId: workOrder.assigneeId ?? null,
      candidateIds: [...(workOrder.candidateIds ?? [])],
      skill: workOrder.skill ?? null,
      repairType: request?.repairType ?? null,
      dispatchedAt: RepairsService.toIso(workOrder.dispatchedAt),
      acceptedAt: RepairsService.toIso(workOrder.acceptedAt),
      completedAt: RepairsService.toIso(workOrder.completedAt),
      slaDueAt: RepairsService.toIso(workOrder.slaDueAt),
      escalatedAt: RepairsService.toIso(workOrder.escalatedAt),
      missingMaterials: [...(workOrder.missingMaterials ?? [])],
      usedMaterials: [...(workOrder.usedMaterials ?? [])],
      resultAttachments: [...(workOrder.resultAttachments ?? [])],
      actionTags: [...(workOrder.actionTags ?? [])],
      actionNote: workOrder.actionNote ?? null,
      faultLocation: workOrder.faultLocation ?? null,
      faultSymptom: workOrder.faultSymptom ?? null,
      repairContent: workOrder.repairContent ?? null,
      feeCents: workOrder.feeCents ?? 0,
      activeCompletionBatchId: activeBatch?.id ?? null,
    };
  }

  /**
   * 把快照写回工单实体（不 save，由调用方统一保存）。
   * 只写快照里**明确存在**的键：老日志的快照可能缺字段，用 undefined 覆盖会把好数据抹掉。
   */
  private applyWorkOrderSnapshot(workOrder: WorkOrder, snapshot: WorkOrderSnapshot) {
    const has = (key: keyof WorkOrderSnapshot) => snapshot[key] !== undefined;
    const date = (value?: string | null) => (value ? new Date(value) : null);
    if (has('status')) workOrder.status = snapshot.status as WorkOrderStatus;
    if (has('assigneeId')) workOrder.assigneeId = snapshot.assigneeId ?? null;
    if (has('candidateIds')) workOrder.candidateIds = [...(snapshot.candidateIds ?? [])];
    if (has('skill')) workOrder.skill = snapshot.skill ?? null;
    if (has('dispatchedAt')) workOrder.dispatchedAt = date(snapshot.dispatchedAt);
    if (has('acceptedAt')) workOrder.acceptedAt = date(snapshot.acceptedAt);
    if (has('completedAt')) workOrder.completedAt = date(snapshot.completedAt);
    if (has('slaDueAt')) workOrder.slaDueAt = date(snapshot.slaDueAt);
    if (has('escalatedAt')) workOrder.escalatedAt = date(snapshot.escalatedAt);
    if (has('missingMaterials')) {
      workOrder.missingMaterials = (snapshot.missingMaterials ??
        []) as WorkOrder['missingMaterials'];
    }
    if (has('usedMaterials')) {
      workOrder.usedMaterials = (snapshot.usedMaterials ?? []) as WorkOrder['usedMaterials'];
    }
    if (has('resultAttachments')) workOrder.resultAttachments = [...(snapshot.resultAttachments ?? [])];
    if (has('actionTags')) workOrder.actionTags = [...(snapshot.actionTags ?? [])];
    if (has('actionNote')) workOrder.actionNote = snapshot.actionNote ?? null;
    if (has('faultLocation')) workOrder.faultLocation = snapshot.faultLocation ?? null;
    if (has('faultSymptom')) workOrder.faultSymptom = snapshot.faultSymptom ?? null;
    if (has('repairContent')) workOrder.repairContent = snapshot.repairContent ?? null;
    if (has('feeCents')) workOrder.feeCents = snapshot.feeCents ?? 0;
  }

  private findActiveCompletionBatch(
    manager: EntityManager,
    tenantId: number,
    workOrderId: number,
  ): Promise<WorkOrderCompletionBatch | null> {
    return manager.findOne(WorkOrderCompletionBatch, {
      where: { tenantId, workOrderId, status: 'active' },
      order: { versionNo: 'DESC' },
    });
  }

  /**
   * 只能看/操作自己提的那些单。
   *
   * 业主天然如此。员工侧看的是「有没有工单池 / 派单台 / 在手工单 /
   * 后台工单管理的查看权」——一个都没有，说明他只是替住户报修的人，
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
      pages['app:my-orders']?.view ||
      pages['work-orders']?.view
    );
  }

  /**
   * 看得到管理处数据范围内**所有**工单的人：办公室（派单台）、后台工单管理、企业/平台管理员。
   * 「已完结」那一档按这个判断决定是给整个范围，还是只给自己类别的单。
   */
  private canSeeWholeScope(resolved: ResolvedAccess): boolean {
    return (
      resolved.isPlatformAdmin ||
      resolved.isTenantAdmin ||
      !!resolved.pages['work-orders']?.view ||
      !!resolved.pages['app:dispatch']?.view
    );
  }

  /**
   * 这个人的「工单类别」：类型规则里把他列为默认维修工的那些报修类型。
   * 电工被列在「电相关」规则里，就该看到本管理处所有电相关的单（不止自己修的）。
   */
  private async repairTypesAssignedTo(tenantId: number, userId: number): Promise<string[]> {
    const rules = await this.repairTypeRuleRepo.find({
      where: { tenantId, enabled: true },
      select: ['repairType', 'assigneeId', 'assigneeIds'],
    });
    return Array.from(
      new Set(
        rules
          .filter((rule) => ruleAssigneeIds(rule).includes(userId))
          .map((rule) => rule.repairType),
      ),
    );
  }

  /** 能不能派单（决定「在手工单」默认口径、能不能操作别人手上的单） */
  private async canDispatch(user: AuthUser, access?: ResolvedAccess): Promise<boolean> {
    if (user.role === UserRole.OWNER) return false;
    const resolved = access ?? (await this.accessService.getAccess(user));
    if (resolved.isPlatformAdmin || resolved.isTenantAdmin) return true;
    return !!(resolved.pages['app:dispatch']?.edit || resolved.pages['work-orders']?.edit);
  }

  /**
   * 撤回 / 作废 2026-09-05 从「派单」里拆出来单独授权（Mike：三者要能分别勾）。
   * 后台「工单管理·办理」仍然一并包含；小程序那两格只有「勾中」一档，所以看 view。
   * 存量角色由 AccessService.onModuleInit 按原来的派单权限补齐，不会有人突然撤不了。
   */
  private async canRollback(user: AuthUser, access?: ResolvedAccess): Promise<boolean> {
    if (user.role === UserRole.OWNER) return false;
    const resolved = access ?? (await this.accessService.getAccess(user));
    if (resolved.isPlatformAdmin || resolved.isTenantAdmin) return true;
    return !!(resolved.pages['app:order-rollback']?.view || resolved.pages['work-orders']?.edit);
  }

  private async canVoid(user: AuthUser, access?: ResolvedAccess): Promise<boolean> {
    if (user.role === UserRole.OWNER) return false;
    const resolved = access ?? (await this.accessService.getAccess(user));
    if (resolved.isPlatformAdmin || resolved.isTenantAdmin) return true;
    return !!(resolved.pages['app:order-void']?.view || resolved.pages['work-orders']?.edit);
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
/** 报修附件里挑出图片（视频没封面帧，列表里只会是个黑块，留给详情页） */
const VIDEO_EXT = /\.(mp4|mov|m4v|webm|avi|mkv)(\?|#|$)/i;

function countPhotos(list?: string[] | null): number {
  return Array.isArray(list) ? list.filter((u) => u && !VIDEO_EXT.test(u)).length : 0;
}

/** 卡片上最多摆 4 张，再多用「+N」表示 */
function pickPhotos(list?: string[] | null): string[] {
  return Array.isArray(list) ? list.filter((u) => u && !VIDEO_EXT.test(u)).slice(0, 4) : [];
}
