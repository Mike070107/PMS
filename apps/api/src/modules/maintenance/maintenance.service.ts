import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes } from 'crypto';
import * as QRCode from 'qrcode';
import { DataSource, EntityManager, In, Repository } from 'typeorm';
import { AuthUser } from '../../common/current-user.decorator';
import { UserRole } from '../../common/enums';
import {
  Building,
  Community,
  House,
  MaintenanceOrder,
  MaintenanceSignSession,
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
import { AccessService } from '../access/access.service';
import { NotificationsService } from '../notifications/notifications.service';
import { scopeCommunityIds } from '../access/scope.util';
import { extractSpot } from '../repairs/repair-suggestions.util';
import { resolveRepairTypeLabel } from '../repairs/repair-type-labels';
import { ObjectStorageService } from '../upload/object-storage.service';
import { stripAddrUnit } from './maintenance-address.util';
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

/**
 * 一张纸能放几行 —— 和 MaintenanceSheet.tsx 里的格子数一致（正面 4 行明细、背面 7 行材料）。
 * 服务端只在算「下一张实体联单号」时用它：一张单印了几张纸，号码就往后走几个。
 */
const ITEMS_PER_SHEET = 4;
const MATERIALS_PER_SHEET = 7;

/** 外发链接要留出微信转发和现场查看时间；提交一次后由数据库立即作废。 */
const SIGN_TOKEN_TTL_SEC = 30 * 60;

/** 四个签名位 → 库里的字段和中文名 */
export const SIGN_SLOTS = {
  filler: { field: 'fillerSignUrl', label: '填单人' },
  repairer: { field: 'repairerSignUrl', label: '修理人' },
  owner: { field: 'ownerSignUrl', label: '报修人（户）' },
  inspector: { field: 'inspectorSignUrl', label: '查验员' },
} as const;

export type SignSlotKey = keyof typeof SIGN_SLOTS;

interface SignTokenPayload {
  sid: number;
  moId: number;
  tenantId: number;
  slot: SignSlotKey;
  /** 谁点的「发到手机」——查验签名要记在他名下 */
  uid: number;
  name: string;
  purpose: 'maintenance-sign';
}

/** 单号字符集与工单同一套：去掉了 0/O、1/I、5/S、8/B 这些手写会认错的字 */
const ORDER_NO_ALPHABET = '34679ACDEFGHJKMNPQRTUVWXY';

@Injectable()
export class MaintenanceService implements OnModuleInit {
  private readonly logger = new Logger(MaintenanceService.name);
  constructor(
    private readonly dataSource: DataSource,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    @InjectRepository(MaintenanceOrder)
    private readonly orderRepo: Repository<MaintenanceOrder>,
    @InjectRepository(MaintenanceSignSession)
    private readonly signSessionRepo: Repository<MaintenanceSignSession>,
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
    private readonly accessService: AccessService,
    private readonly notifications: NotificationsService,
  ) {}

  /** 生产环境依靠 synchronize，它不会改已有行里的旧状态，因此启动时幂等迁移。 */
  async onModuleInit() {
    try {
      await this.orderRepo.query(`
        UPDATE maintenance_orders
           SET status = CASE
             WHEN status = 'inspected' OR inspector_sign_url IS NOT NULL THEN 'pending_print'
             WHEN repairer_sign_url IS NOT NULL THEN 'waiting_inspector'
             WHEN filler_sign_url IS NOT NULL THEN 'waiting_repairer'
             ELSE 'filling'
           END,
               updated_at = now()
         WHERE status IN ('draft', 'inspected')
      `);
    } catch (error) {
      this.logger.warn(`养护单旧状态迁移失败：${(error as Error).message}`);
    }
  }

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
    // 点开了就算看过：指向这张养护单的未读站内信（待签字提醒）一并标已读（2026-09-06 Mike）
    void this.notifications.markReadByRef(user, { maintenanceOrderId: id });
    return { ...this.toDetail(row), suggestedPaperNo: await this.suggestPaperNo(tenantId) };
  }

  /** 工单详情页「填养护单」用：这张工单有没有养护单，有就直接打开 */
  async findByWorkOrder(workOrderId: number, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    const row = await this.orderRepo
      .createQueryBuilder('mo')
      .where('mo.tenant_id = :tenantId AND mo.work_order_id = :workOrderId', { tenantId, workOrderId })
      .andWhere("mo.status <> 'void'")
      .orderBy('mo.id', 'DESC')
      .getOne();
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

    const existing = await this.orderRepo
      .createQueryBuilder('mo')
      .where('mo.tenant_id = :tenantId AND mo.work_order_id = :workOrderId', {
        tenantId, workOrderId: workOrder.id,
      })
      .andWhere("mo.status <> 'void'")
      .orderBy('mo.id', 'DESC')
      .getOne();
    if (existing) {
      return { ...this.toDetail(existing), suggestedPaperNo: await this.suggestPaperNo(tenantId) };
    }

    const draft = await this.buildPrefill(tenantId, workOrder, user);
    const saved = await this.dataSource.transaction(async (manager) => {
      draft.orderNo = await this.nextOrderNo(manager);
      return manager.save(MaintenanceOrder, manager.create(MaintenanceOrder, draft));
    });
    return { ...this.toDetail(saved), suggestedPaperNo: await this.suggestPaperNo(tenantId) };
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
    // 只有「填单中」允许改正文：一旦推送，后面每个人签的必须是同一份快照。
    if (row.status !== MAINTENANCE_STATUS.FILLING) {
      throw new BadRequestException('养护单已进入签字流程，如需改正文请先作废后重新开单');
    }

    const text = (v: string | undefined, cur: string | null) =>
      v === undefined ? cur : v.trim() || null;

    // 实体联单号只收数字：连打时要按它逐张 +1，混进字母就加不了
    if (dto.paperNo !== undefined) {
      const paperNo = dto.paperNo.trim();
      if (paperNo && !/^\d+$/.test(paperNo)) {
        throw new BadRequestException('实体单号只能填数字（联单上号码机打的那串）');
      }
      row.paperNo = paperNo || null;
    }
    row.unitName = text(dto.unitName, row.unitName);
    row.reporterName = text(dto.reporterName, row.reporterName);
    const addr = (v: string | undefined, cur: string | null, unit: string) =>
      v === undefined ? cur : stripAddrUnit(v, unit);
    row.addrVillage = addr(dto.addrVillage, row.addrVillage, '村');
    row.addrRoad = addr(dto.addrRoad, row.addrRoad, '路');
    row.addrLane = addr(dto.addrLane, row.addrLane, '弄');
    row.addrBuildingNo = addr(dto.addrBuildingNo, row.addrBuildingNo, '号');
    row.addrRoom = addr(dto.addrRoom, row.addrRoom, '室');
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

  /** 办公室核对完成后发起三段式签字。 */
  async publish(id: number, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    const row = await this.orderRepo.findOne({ where: { id, tenantId } });
    if (!row) throw new NotFoundException('养护单不存在');
    this.assertInScope(row.communityId, access);
    if (row.status !== MAINTENANCE_STATUS.FILLING) {
      throw new BadRequestException('只有填单中的养护单可以推送签名');
    }
    if (!row.fillerId || !row.repairerId) {
      throw new BadRequestException('请先确认填单人和修理人');
    }
    row.status = MAINTENANCE_STATUS.WAITING_FILLER;
    row.updatedBy = user.id;
    const saved = await this.orderRepo.save(row);
    await this.notifyCurrentSigner(saved);
    return this.toDetail(saved);
  }

  /** 真实打印完成后归档。 */
  async markPrinted(id: number, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    const row = await this.orderRepo.findOne({ where: { id, tenantId } });
    if (!row) throw new NotFoundException('养护单不存在');
    this.assertInScope(row.communityId, access);
    if (row.status !== MAINTENANCE_STATUS.PENDING_PRINT) {
      throw new BadRequestException('三方签字完成后才能标记打印完成');
    }
    row.status = MAINTENANCE_STATUS.COMPLETED;
    row.updatedBy = user.id;
    return this.toDetail(await this.orderRepo.save(row));
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
    this.assertExpectedSlot(row, 'inspector');
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
    row.status = MAINTENANCE_STATUS.PENDING_PRINT;
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


  // ==================== 手机签名（扫码到手机上签） ====================

  /**
   * 生成一个 30 分钟有效、只能提交一次的签名链接和二维码。
   *
   * 用的是**另一把密钥**（JWT_SECRET + ':maintenance-sign'）：这样它永远通不过登录态校验，
   * 就算被截走也只能给这一张单的这一个签名位签个字，提交后立即作废。
   * 谁点的这个按钮就把谁记在 token 里 —— 查验签名要落在他名下。
   */
  async createSignToken(
    id: number,
    slot: SignSlotKey,
    user: AuthUser,
    access?: ResolvedAccess,
  ) {
    const tenantId = this.requireTenant(user);
    if (!SIGN_SLOTS[slot]) throw new BadRequestException('签名位不对');
    const row = await this.orderRepo.findOne({ where: { id, tenantId } });
    if (!row) throw new NotFoundException('养护单不存在');
    this.assertInScope(row.communityId, access);
    if (slot === 'owner') {
      if (row.status !== MAINTENANCE_STATUS.FILLING) {
        throw new BadRequestException('报修人验收签名只能在推送三方签字前补录');
      }
    } else {
      this.assertExpectedSlot(row, slot);
    }
    const me = await this.userRepo.findOne({
      where: { id: user.id },
      select: ['id', 'name'],
    });
    const expiresAt = new Date(Date.now() + SIGN_TOKEN_TTL_SEC * 1000);
    const session = await this.signSessionRepo.save(
      this.signSessionRepo.create({
        tenantId,
        maintenanceOrderId: row.id,
        slot,
        requestedBy: user.id,
      signerName:
        slot === 'filler' ? row.fillerName
          : slot === 'repairer' ? row.repairerName
            : me?.name || null,
        expiresAt,
        openedAt: null,
        submittedAt: null,
        createdBy: user.id,
        updatedBy: user.id,
      }),
    );
    const payload: SignTokenPayload = {
      sid: session.id,
      moId: row.id,
      tenantId,
      slot,
      uid:
        slot === 'filler' ? row.fillerId || user.id
          : slot === 'repairer' ? row.repairerId || user.id
            : user.id,
      name:
        slot === 'filler' ? row.fillerName || me?.name || ''
          : slot === 'repairer' ? row.repairerName || me?.name || ''
            : me?.name || '',
      purpose: 'maintenance-sign',
    };
    const token = await this.jwt.signAsync(payload, {
      secret: this.signSecret(),
      expiresIn: SIGN_TOKEN_TTL_SEC,
    });
    const base = this.appBaseUrl();
    const url = `${base}/sign/${token}`;
    const qrDataUrl = await QRCode.toDataURL(url, {
      width: 560,
      margin: 1,
      errorCorrectionLevel: 'M',
    });
    return {
      token,
      url,
      qrDataUrl,
      slot,
      slotLabel: SIGN_SLOTS[slot].label,
      expiresInSec: SIGN_TOKEN_TTL_SEC,
      expiresAt: expiresAt.toISOString(),
    };
  }

  /** 手机打开签名页时先问一句：这是给哪张单、哪个位置签的（链接过期就直接说过期） */
  async getSignSession(token: string) {
    const { payload, session } = await this.verifySignToken(token);
    if (!session.openedAt) {
      session.openedAt = new Date();
      session.updatedBy = payload.uid;
      await this.signSessionRepo.save(session);
    }
    const row = await this.orderRepo.findOne({
      where: { id: payload.moId, tenantId: payload.tenantId },
    });
    if (!row) throw new NotFoundException('养护单不存在');
    if (payload.slot === 'owner') {
      if (row.status !== MAINTENANCE_STATUS.FILLING) {
        throw new BadRequestException('这个签名任务已结束');
      }
    } else {
      this.assertExpectedSlot(row, payload.slot);
    }
    const field = SIGN_SLOTS[payload.slot].field;
    return {
      slot: payload.slot,
      slotLabel: SIGN_SLOTS[payload.slot].label,
      paperNo: row.paperNo,
      orderNo: row.orderNo,
      addressText: this.addressText(row),
      repairItem: row.repairItem,
      unitName: row.unitName,
      /** 已经签过就提示一句，允许重签（现场经常写歪了要重来） */
      signed: !!row[field],
      signerName: payload.name || null,
      /** 公开页只返回这张养护单本身，不带住户手机号、账号等额外资料。 */
      order: this.toDetail(row),
      expiresAt: session.expiresAt,
    };
  }

  /**
   * 手机上提交签名。图片以 data URL 送上来（现场网络差，一次请求搞定，不走两段式上传）。
   * 查验位提交 = 查验通过，和后台点「查验并签名」等效。
   */
  async submitSignature(token: string, imageDataUrl: string) {
    const { payload } = await this.verifySignToken(token);
    const buffer = this.decodePngDataUrl(imageDataUrl);
    const stored = await this.storage.putBuffer(buffer, 'image/png', 'uploads', 'signature.png');
    const url = stored.fileUrl;
    let savedOrder: MaintenanceOrder | null = null;
    await this.dataSource.transaction(async (manager) => {
      const session = await manager.findOne(MaintenanceSignSession, {
        where: { id: payload.sid, tenantId: payload.tenantId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!session || session.maintenanceOrderId !== payload.moId || session.slot !== payload.slot) {
        throw new BadRequestException('签名链接无效');
      }
      if (session.submittedAt) throw new BadRequestException('这个签名链接已经使用过了');
      if (session.expiresAt.getTime() <= Date.now()) {
        throw new BadRequestException('签名链接已过期，请重新生成');
      }
      const row = await manager.findOne(MaintenanceOrder, {
        where: { id: payload.moId, tenantId: payload.tenantId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!row) throw new NotFoundException('养护单不存在');
      if (payload.slot === 'owner') {
        if (row.status !== MAINTENANCE_STATUS.FILLING) {
          throw new BadRequestException('养护单已进入三方签字流程');
        }
        row.ownerSignUrl = url;
      } else {
        this.assertExpectedSlot(row, payload.slot);
        this.applySignedSlot(row, payload.slot, url, payload.uid, payload.name);
      }
      row.updatedBy = payload.uid;
      session.submittedAt = new Date();
      session.updatedBy = payload.uid;
      await manager.save(MaintenanceOrder, row);
      await manager.save(MaintenanceSignSession, session);
      savedOrder = row;
    });
    if (savedOrder) await this.notifyCurrentSigner(savedOrder);
    return { ok: true, slotLabel: SIGN_SLOTS[payload.slot].label };
  }

  // ==================== 员工端内部待签任务（无时效） ====================

  async listSignTasks(user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    const scope = scopeCommunityIds(access);
    if (scope && !scope.length) return [];
    const canInspect = !!access?.pages?.['app:maintenance-inspect']?.view;
    const qb = this.orderRepo
      .createQueryBuilder('mo')
      .where('mo.tenant_id = :tenantId', { tenantId })
      .andWhere(`(
        (mo.status = :wf AND mo.filler_id = :uid)
        OR (mo.status = :wr AND mo.repairer_id = :uid)
        ${canInspect ? 'OR mo.status = :wi' : ''}
      )`, {
        wf: MAINTENANCE_STATUS.WAITING_FILLER,
        wr: MAINTENANCE_STATUS.WAITING_REPAIRER,
        wi: MAINTENANCE_STATUS.WAITING_INSPECTOR,
        uid: user.id,
      });
    if (scope) qb.andWhere('mo.community_id IN (:...scope)', { scope });
    const rows = await qb.orderBy('mo.updated_at', 'DESC').getMany();
    return rows.map((row) => ({
      ...this.toListRow(row),
      slot: this.expectedSlot(row),
      slotLabel: SIGN_SLOTS[this.expectedSlot(row)!]?.label || '',
    }));
  }

  async getInternalSignTask(id: number, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    const row = await this.orderRepo.findOne({ where: { id, tenantId } });
    if (!row) throw new NotFoundException('养护单不存在');
    this.assertInScope(row.communityId, access);
    const slot = this.assertInternalSigner(row, user, access);
    const field = SIGN_SLOTS[slot].field;
    return {
      slot,
      slotLabel: SIGN_SLOTS[slot].label,
      paperNo: row.paperNo,
      orderNo: row.orderNo,
      addressText: this.addressText(row),
      repairItem: row.repairItem,
      unitName: row.unitName,
      signed: !!row[field],
      signerName:
        slot === 'filler' ? row.fillerName
          : slot === 'repairer' ? row.repairerName
            : null,
      external: false,
      expiresAt: null,
      order: this.toDetail(row),
    };
  }

  async submitInternalSignature(
    id: number,
    imageDataUrl: string,
    user: AuthUser,
    access?: ResolvedAccess,
  ) {
    const tenantId = this.requireTenant(user);
    const current = await this.orderRepo.findOne({ where: { id, tenantId } });
    if (!current) throw new NotFoundException('养护单不存在');
    this.assertInScope(current.communityId, access);
    this.assertInternalSigner(current, user, access);
    const buffer = this.decodePngDataUrl(imageDataUrl);
    const stored = await this.storage.putBuffer(buffer, 'image/png', 'uploads', 'signature.png');
    const me = await this.userRepo.findOne({ where: { id: user.id, tenantId }, select: ['name'] });
    let resultStatus = MAINTENANCE_STATUS.WAITING_FILLER as MaintenanceOrder['status'];
    let slotLabel = '';
    let savedOrder: MaintenanceOrder | null = null;
    await this.dataSource.transaction(async (manager) => {
      const row = await manager.findOne(MaintenanceOrder, {
        where: { id, tenantId }, lock: { mode: 'pessimistic_write' },
      });
      if (!row) throw new NotFoundException('养护单不存在');
      this.assertInScope(row.communityId, access);
      const slot = this.assertInternalSigner(row, user, access);
      slotLabel = SIGN_SLOTS[slot].label;
      this.applySignedSlot(row, slot, stored.fileUrl, user.id, me?.name || '');
      row.updatedBy = user.id;
      await manager.save(MaintenanceOrder, row);
      resultStatus = row.status;
      savedOrder = row;
    });
    if (savedOrder) await this.notifyCurrentSigner(savedOrder);
    return { ok: true, slotLabel, status: resultStatus };
  }

  /**
   * 电脑那头轮询这一个接口看进度：等待扫码 → 已打开 → 已签好。
   * 按 token 判，不看单据上那一格有没有值 —— 重签时那一格本来就有签名。
   */
  async getSignStatus(token: string) {
    const { payload, session } = await this.verifySignToken(token, true);
    return {
      slot: payload.slot,
      slotLabel: SIGN_SLOTS[payload.slot].label,
      /** 手机已经打开签名页 */
      opened: !!session.openedAt,
      /** 这一轮签完了（电脑那头据此把签名取回去） */
      submitted: !!session.submittedAt,
    };
  }

  private signSecret(): string {
    return `${this.config.get<string>('JWT_SECRET', 'change-me-in-prod')}:maintenance-sign`;
  }

  /** 后台自己的地址（微信里打开签名页要用绝对地址） */
  private appBaseUrl(): string {
    return (this.config.get<string>('APP_PUBLIC_BASE_URL', '') || '').replace(/\/+$/, '');
  }

  private async verifySignToken(
    token: string,
    allowSubmitted = false,
  ): Promise<{ payload: SignTokenPayload; session: MaintenanceSignSession }> {
    let payload: SignTokenPayload;
    try {
      payload = await this.jwt.verifyAsync<SignTokenPayload>(token, {
        secret: this.signSecret(),
      });
    } catch {
      throw new BadRequestException('签名链接已过期，请回电脑上重新生成二维码');
    }
    if (payload?.purpose !== 'maintenance-sign' || !payload.sid || !SIGN_SLOTS[payload.slot]) {
      throw new BadRequestException('签名链接无效');
    }
    const session = await this.signSessionRepo.findOne({
      where: { id: payload.sid, tenantId: payload.tenantId },
    });
    if (
      !session ||
      session.maintenanceOrderId !== payload.moId ||
      session.slot !== payload.slot
    ) {
      throw new BadRequestException('签名链接无效');
    }
    if (session.expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException('签名链接已过期，请重新生成');
    }
    if (session.submittedAt && !allowSubmitted) {
      throw new BadRequestException('这个签名链接已经使用过了');
    }
    return { payload, session };
  }

  /** data:image/png;base64,... → Buffer。只收 PNG，最大 2MB（签名撑死几十 KB） */
  private decodePngDataUrl(dataUrl: string): Buffer {
    const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec((dataUrl || '').trim());
    if (!match) throw new BadRequestException('签名图片格式不对');
    const buffer = Buffer.from(match[1], 'base64');
    if (!buffer.length) throw new BadRequestException('签名是空的');
    if (buffer.length > 2 * 1024 * 1024) throw new BadRequestException('签名图片太大了');
    return buffer;
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

    const [materials, owner] = await Promise.all([
      this.buildMaterialRows(tenantId, workOrder),
      house
        ? this.userRepo.findOne({
            where: { tenantId, houseId: house.id, role: UserRole.OWNER },
            order: { id: 'ASC' },
            select: ['id', 'name'],
          })
        : Promise.resolve(null),
    ]);
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
      status: MAINTENANCE_STATUS.FILLING,
      unitName: office?.name || topCommunity?.name || null,
      // 按地址从业主档案取姓名，档案没有时才回退到报修联系人。
      reporterName: owner?.name?.trim() || request?.contactName || null,
      // 有门牌的地址不写「村」：小区名在「管房单位」那一格已经有了，
      // 两处写同一个名字既重复，也会把纸上不到 1cm 的格子撑爆。
      // 公区没有门牌，才拿小区名占住这一格，否则地址整行是空的
      addrVillage: stripAddrUnit(isPublicArea ? topCommunity?.name : null, '村'),
      addrRoad: stripAddrUnit(house?.roadName, '路'),
      addrLane: stripAddrUnit(building?.lane, '弄'),
      addrBuildingNo: stripAddrUnit(building?.buildingNo, '号'),
      addrRoom: stripAddrUnit(house?.roomNo, '室'),
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
    // 已冲销的用料（撤回完工退回库存了）不能印到养护单的《材料领耗记录》上
    const usageRows = await this.workOrderMaterialRepo.find({
      where: { tenantId, workOrderId: workOrder.id, status: 'active' },
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
        // 查不到 SKU 就直说，别把 id 印到养护单上（2026-09-01：用户看不懂 #19）
        name: sku?.name || '未知材料',
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

  /** 当前唯一能签的人；后一位绝不能越过前一位。 */
  private expectedSlot(row: MaintenanceOrder): Exclude<SignSlotKey, 'owner'> | null {
    if (row.status === MAINTENANCE_STATUS.WAITING_FILLER) return 'filler';
    if (row.status === MAINTENANCE_STATUS.WAITING_REPAIRER) return 'repairer';
    if (row.status === MAINTENANCE_STATUS.WAITING_INSPECTOR) return 'inspector';
    return null;
  }

  private assertExpectedSlot(row: MaintenanceOrder, slot: SignSlotKey) {
    if (row.status === MAINTENANCE_STATUS.VOID) {
      throw new BadRequestException('这张养护单已作废');
    }
    const expected = this.expectedSlot(row);
    if (!expected) throw new BadRequestException('这张养护单当前没有待签任务');
    if (expected !== slot) {
      throw new BadRequestException(`请先完成${SIGN_SLOTS[expected].label}签字`);
    }
  }

  private assertInternalSigner(
    row: MaintenanceOrder,
    user: AuthUser,
    access?: ResolvedAccess,
  ): Exclude<SignSlotKey, 'owner'> {
    const slot = this.expectedSlot(row);
    if (!slot) throw new BadRequestException('这张养护单当前没有待签任务');
    if (slot === 'filler' && row.fillerId !== user.id) {
      throw new ForbiddenException('这张养护单当前由填单人签字');
    }
    if (slot === 'repairer' && row.repairerId !== user.id) {
      throw new ForbiddenException('这张养护单当前由指定修理人签字');
    }
    if (slot === 'inspector' && !access?.pages?.['app:maintenance-inspect']?.view) {
      throw new ForbiddenException('你的角色没有养护单查验权限');
    }
    return slot;
  }

  private applySignedSlot(
    row: MaintenanceOrder,
    slot: Exclude<SignSlotKey, 'owner'>,
    url: string,
    signerId: number,
    signerName: string,
  ) {
    this.assertExpectedSlot(row, slot);
    if (slot === 'filler') {
      row.fillerSignUrl = url;
      row.fillerId = row.fillerId || signerId;
      row.fillerName = row.fillerName || signerName || null;
      row.status = MAINTENANCE_STATUS.WAITING_REPAIRER;
      return;
    }
    if (slot === 'repairer') {
      row.repairerSignUrl = url;
      row.repairerId = row.repairerId || signerId;
      row.repairerName = row.repairerName || signerName || null;
      row.status = MAINTENANCE_STATUS.WAITING_INSPECTOR;
      return;
    }
    row.inspectorSignUrl = url;
    row.inspectorId = signerId;
    row.inspectorName = signerName || row.inspectorName;
    row.inspectedAt = new Date();
    row.status = MAINTENANCE_STATUS.PENDING_PRINT;
  }

  /** 签字流转后把下一个人叫来；通知失败不影响主流程。 */
  private async notifyCurrentSigner(row: MaintenanceOrder) {
    try {
      const slot = this.expectedSlot(row);
      if (!slot) return;
      let receiverIds: number[] = [];
      if (slot === 'filler' && row.fillerId) receiverIds = [row.fillerId];
      if (slot === 'repairer' && row.repairerId) receiverIds = [row.repairerId];
      if (slot === 'inspector') {
        const candidates = await this.accessService.userIdsWithPermission(
          row.tenantId, 'app:maintenance-inspect', 'view',
        );
        const officeId = await this.accessService.officeIdOfCommunity(row.tenantId, row.communityId);
        const covered = await this.accessService.filterUsersCoveringOffice(row.tenantId, candidates, officeId);
        receiverIds = [...covered.keys()];
      }
      await Promise.all(receiverIds.map((receiverId) => this.notifications.notifyUser({
        tenantId: row.tenantId,
        receiverId,
        eventKey: `maintenance_sign_${slot}`,
        title: `养护单 ${row.paperNo || row.orderNo} 待您签字`,
        payload: { maintenanceOrderId: row.id, slot },
        page: `/pages/maintenance-sign/maintenance-sign?id=${row.id}`,
      })));
    } catch (error) {
      this.logger.warn(`养护单待签通知失败：${(error as Error).message}`);
    }
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

  /**
   * 下一张实体联单的号：库里已用过的最大号 + 1，位数保持不变（0119610 → 0119611）。
   * 联单是一本连号的纸，办公室不会想每次自己数到哪儿了。
   * 一个号都没用过就返回 null，让端上退回「上次填的」或空着。
   */
  private async suggestPaperNo(tenantId: number): Promise<string | null> {
    // 上一张单印了几张纸，号码就往后走几个 —— 两张纸的单只 +1 会和已经打出去的纸撞号
    const rows: Array<{ paper_no: string; sheets: string }> = await this.orderRepo.query(
      `SELECT paper_no,
              GREATEST(
                1,
                CEIL(jsonb_array_length(items)::numeric / $2),
                CEIL(jsonb_array_length(materials)::numeric / $3)
              ) AS sheets
         FROM maintenance_orders
        WHERE tenant_id = $1 AND paper_no ~ '^[0-9]+$'
        ORDER BY length(paper_no) DESC, paper_no DESC
        LIMIT 1`,
      [tenantId, ITEMS_PER_SHEET, MATERIALS_PER_SHEET],
    );
    const last = rows[0]?.paper_no;
    if (!last) return null;
    const sheets = Math.max(1, Number(rows[0]?.sheets) || 1);
    return String(Number(last) + sheets).padStart(last.length, '0');
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
