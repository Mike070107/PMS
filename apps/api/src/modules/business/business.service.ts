import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, In, IsNull, Repository } from 'typeorm';
import { AuthUser } from '../../common/current-user.decorator';
import { ResolvedAccess } from '../access/access.service';
import { scopeCommunityIds } from '../access/scope.util';
import { addNaturalOrderBy } from '../../common/natural-order';
import {
  BusinessBillingUnit,
  BusinessServiceType,
  BusinessTransactionStatus,
  UserRole,
} from '../../common/enums';
import {
  AccessCard,
  BusinessLog,
  BusinessRule,
  BusinessTransaction,
  Building,
  Community,
  House,
  ParkingVehicle,
  User,
} from '../../entities';
import {
  BusinessRuleQueryDto,
  BusinessSearchDto,
  CompleteBusinessDto,
  EstimateBusinessDto,
  UpsertBusinessRuleDto,
} from './dto';

@Injectable()
export class BusinessService {
  constructor(
    @InjectRepository(BusinessRule)
    private readonly ruleRepo: Repository<BusinessRule>,
    @InjectRepository(ParkingVehicle)
    private readonly vehicleRepo: Repository<ParkingVehicle>,
    @InjectRepository(AccessCard)
    private readonly cardRepo: Repository<AccessCard>,
    @InjectRepository(BusinessTransaction)
    private readonly txnRepo: Repository<BusinessTransaction>,
    @InjectRepository(BusinessLog)
    private readonly logRepo: Repository<BusinessLog>,
    @InjectRepository(House)
    private readonly houseRepo: Repository<House>,
    @InjectRepository(Building)
    private readonly buildingRepo: Repository<Building>,
    @InjectRepository(Community)
    private readonly communityRepo: Repository<Community>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
  ) {}

  async listRules(query: BusinessRuleQueryDto, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    await this.ensureDefaultRules(tenantId, user.id);
    const scope = scopeCommunityIds(access);
    if (scope && !scope.length) return [];
    const baseWhere = {
      tenantId,
      ...(query.serviceType ? { serviceType: query.serviceType } : {}),
    };
    // 受限角色能看到：公司通用规则（对他的小区同样生效）+ 绑定在他范围内小区的规则
    return this.ruleRepo.find({
      where: scope
        ? [
            { ...baseWhere, communityId: IsNull() },
            { ...baseWhere, communityId: In(scope) },
          ]
        : baseWhere,
      order: { serviceType: 'ASC', id: 'ASC' },
    });
  }

  async createRule(dto: UpsertBusinessRuleDto, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    this.assertRuleShape(dto);
    const communityId = await this.assertRuleCommunity(
      dto.communityId ?? null,
      tenantId,
      access,
    );
    const rule = this.ruleRepo.create({
      tenantId,
      serviceType: dto.serviceType,
      name: dto.name,
      communityId,
      billingUnit: dto.billingUnit,
      unitPriceCents: dto.unitPriceCents,
      config: dto.config ?? {},
      enabled: dto.enabled ?? true,
      createdBy: user.id,
      updatedBy: user.id,
    });
    return this.ruleRepo.save(rule);
  }

  async updateRule(
    id: number,
    dto: UpsertBusinessRuleDto,
    user: AuthUser,
    access?: ResolvedAccess,
  ) {
    const tenantId = this.requireTenant(user);
    this.assertRuleShape(dto);
    const rule = await this.ruleRepo.findOne({ where: { id, tenantId } });
    if (!rule) throw new NotFoundException('rule not found');
    const scope = scopeCommunityIds(access);
    // 公司通用规则改动影响全公司，受限角色不能碰；绑定小区的规则也必须在自己范围内
    if (scope && (rule.communityId == null || !scope.includes(rule.communityId))) {
      throw new ForbiddenException('该规则不在你的管理范围内，请联系全公司范围的管理员修改');
    }
    const communityId = await this.assertRuleCommunity(
      dto.communityId ?? null,
      tenantId,
      access,
    );
    Object.assign(rule, {
      serviceType: dto.serviceType,
      name: dto.name,
      communityId,
      billingUnit: dto.billingUnit,
      unitPriceCents: dto.unitPriceCents,
      config: dto.config ?? {},
      enabled: dto.enabled ?? true,
      updatedBy: user.id,
    });
    return this.ruleRepo.save(rule);
  }

  /** 规则绑定小区的合法性：小区须属于本公司；受限角色必须绑且只能绑自己范围内的小区 */
  private async assertRuleCommunity(
    communityId: number | null,
    tenantId: number,
    access?: ResolvedAccess,
  ): Promise<number | null> {
    if (communityId != null) {
      const community = await this.communityRepo.findOne({
        where: { id: communityId, tenantId },
      });
      if (!community) throw new BadRequestException('适用小区不存在');
    }
    const scope = scopeCommunityIds(access);
    if (scope && (communityId == null || !scope.includes(communityId))) {
      throw new ForbiddenException('受限角色只能维护绑定在自己管理范围内小区的规则');
    }
    return communityId;
  }

  async search(query: BusinessSearchDto, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    const scope = scopeCommunityIds(access);
    if (scope && !scope.length) {
      return { houses: [], vehicles: [], accessCards: [] };
    }
    const q = (query.q || '').trim();
    const houseQb = this.houseRepo
      .createQueryBuilder('h')
      .leftJoin(Building, 'b', 'b.id = h.building_id AND b.tenant_id = h.tenant_id')
      .leftJoin(Community, 'c', 'c.id = b.community_id AND c.tenant_id = b.tenant_id')
      .leftJoin(User, 'u', 'u.house_id = h.id AND u.tenant_id = h.tenant_id AND u.role = :role', {
        role: UserRole.OWNER,
      })
      .where('h.tenant_id = :tenantId', { tenantId })
      .andWhere(
        q
          ? new Brackets((sub) => {
              sub
                .where('h.room_no ILIKE :kw', { kw: `%${q}%` })
                .orWhere('b.building_no ILIKE :kw', { kw: `%${q}%` })
                .orWhere('b.lane ILIKE :kw', { kw: `%${q}%` })
                .orWhere('u.name ILIKE :kw', { kw: `%${q}%` })
                .orWhere('u.phone ILIKE :kw', { kw: `%${q}%` });
            })
          : '1=1',
      )
      .select([
        'h.id AS id',
        'h.room_no AS "roomNo"',
        'h.area_sqm AS "areaSqm"',
        'b.lane AS lane',
        'b.building_no AS "buildingNo"',
        'b.community_id AS "communityId"',
        'c.name AS "communityName"',
        'u.id AS "ownerId"',
        'u.name AS "ownerName"',
        'u.phone AS "ownerPhone"',
      ])
      .orderBy('c.id', 'ASC')
      .limit(20);
    if (scope) houseQb.andWhere('b.community_id IN (:...scope)', { scope });
    // 房产列表一律按「弄 → 号 → 室」自然序，不按建库顺序
    addNaturalOrderBy(houseQb, 'b.lane');
    addNaturalOrderBy(houseQb, 'b.building_no');
    addNaturalOrderBy(houseQb, 'h.room_no');
    const houseRows = await houseQb.getRawMany<any>();

    // 车辆/门禁卡自身没有小区字段，范围过滤通过所挂房号的小区实现
    const scopedByHouse = (qb: any, alias: string) => {
      if (!scope) return qb;
      return qb
        .innerJoin(House, 'sh', `sh.id = ${alias}.house_id AND sh.tenant_id = ${alias}.tenant_id`)
        .innerJoin(Building, 'sb', 'sb.id = sh.building_id AND sb.tenant_id = sh.tenant_id')
        .andWhere('sb.community_id IN (:...scope)', { scope });
    };
    const vehicles = await scopedByHouse(
      this.vehicleRepo
        .createQueryBuilder('v')
        .where('v.tenant_id = :tenantId', { tenantId }),
      'v',
    )
      .orderBy('v.id', 'DESC')
      .take(50)
      .getMany();
    const cards = await scopedByHouse(
      this.cardRepo
        .createQueryBuilder('ac')
        .where('ac.tenant_id = :tenantId', { tenantId }),
      'ac',
    )
      .orderBy('ac.id', 'DESC')
      .take(100)
      .getMany();

    const filteredVehicles = q
      ? vehicles.filter((v) => v.plateNo.toLowerCase().includes(q.toLowerCase()))
      : vehicles.slice(0, 20);
    const filteredCards = q
      ? cards.filter((c) => c.cardNo.toLowerCase().includes(q.toLowerCase()))
      : cards.slice(0, 20);

    return {
      houses: houseRows.map((r) => ({
        id: Number(r.id),
        roomNo: r.roomNo,
        areaSqm: r.areaSqm,
        lane: r.lane,
        buildingNo: r.buildingNo,
        communityId: r.communityId != null ? Number(r.communityId) : null,
        communityName: r.communityName,
        owner: r.ownerId
          ? { id: Number(r.ownerId), name: r.ownerName, phone: r.ownerPhone }
          : null,
      })),
      vehicles: filteredVehicles,
      accessCards: filteredCards,
    };
  }

  async estimate(dto: EstimateBusinessDto, user: AuthUser) {
    const tenantId = this.requireTenant(user);
    const rule = await this.findRule(tenantId, dto.ruleId, dto.serviceType);
    if (dto.serviceType === BusinessServiceType.PARKING_MONTHLY) {
      return this.estimateParking(rule, dto, tenantId);
    }
    if (dto.serviceType === BusinessServiceType.ACCESS_CARD) {
      return this.estimateAccessCard(rule, dto);
    }
    throw new BadRequestException('unsupported service type');
  }

  async complete(dto: CompleteBusinessDto, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    const estimate = await this.estimate(dto, user);
    const rule = await this.findRule(tenantId, dto.ruleId, dto.serviceType);
    const house = dto.houseId
      ? await this.houseRepo.findOne({ where: { id: dto.houseId, tenantId } })
      : null;
    if (dto.houseId && !house) throw new NotFoundException('house not found');

    // 房号 → 小区：落到流水上供范围过滤，同时校验经办权限与规则适用性
    let communityId: number | null = null;
    if (house) {
      const building = await this.buildingRepo.findOne({
        where: { id: house.buildingId, tenantId },
      });
      communityId = building?.communityId ?? null;
    }
    const scope = scopeCommunityIds(access);
    if (scope && (communityId == null || !scope.includes(communityId))) {
      throw new ForbiddenException('该房号不在你的管理范围内');
    }
    if (rule.communityId != null && rule.communityId !== communityId) {
      throw new BadRequestException('该收费规则不适用于所选房号的小区，请换用对应小区的规则');
    }

    let targetType: string | null = null;
    let targetId: number | null = null;
    const snapshot: Record<string, unknown> = { estimate, ruleName: rule.name };

    if (dto.serviceType === BusinessServiceType.PARKING_MONTHLY) {
      const vehicle = await this.upsertVehicle(dto, tenantId, user.id, estimate.endDate);
      targetType = 'parking_vehicle';
      targetId = vehicle.id;
      snapshot.vehicle = { id: vehicle.id, plateNo: vehicle.plateNo, validUntil: vehicle.validUntil };
    } else if (dto.serviceType === BusinessServiceType.ACCESS_CARD) {
      const created = await this.issueAccessCards(dto, tenantId, user.id);
      targetType = 'access_card_batch';
      targetId = created[0]?.id ?? null;
      snapshot.cards = created.map((c) => ({ id: c.id, cardNo: c.cardNo }));
    }

    const txn = await this.txnRepo.save(
      this.txnRepo.create({
        tenantId,
        txnNo: this.makeTxnNo(dto.serviceType),
        serviceType: dto.serviceType,
        status: BusinessTransactionStatus.PAID,
        ruleId: rule.id,
        communityId,
        houseId: dto.houseId ?? null,
        ownerId: dto.ownerId ?? null,
        targetType,
        targetId,
        quantity: estimate.quantity,
        startDate: estimate.startDate,
        endDate: estimate.endDate,
        amountCents: estimate.amountCents,
        paymentMethod: dto.paymentMethod ?? 'cash',
        externalSyncStatus: 'mocked',
        invoiceStatus: 'pending',
        remark: dto.remark ?? null,
        snapshot,
        createdBy: user.id,
        updatedBy: user.id,
      }),
    );

    await this.logRepo.save([
      this.logRepo.create({
        tenantId,
        transactionId: txn.id,
        action: 'payment_confirmed',
        detail: { amountCents: txn.amountCents, paymentMethod: txn.paymentMethod },
        createdBy: user.id,
        updatedBy: user.id,
      }),
      this.logRepo.create({
        tenantId,
        transactionId: txn.id,
        action: 'external_sync_reserved',
        detail: { serviceType: dto.serviceType, targetType, targetId },
        createdBy: user.id,
        updatedBy: user.id,
      }),
      this.logRepo.create({
        tenantId,
        transactionId: txn.id,
        action: 'invoice_reserved',
        detail: { status: 'pending' },
        createdBy: user.id,
        updatedBy: user.id,
      }),
    ]);

    return txn;
  }

  listTransactions(user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    const scope = scopeCommunityIds(access);
    if (scope && !scope.length) return Promise.resolve([]);
    return this.txnRepo.find({
      // 受限角色看不到 community_id 为空的历史流水（回填后仅剩没挂房号的单）
      where: scope ? { tenantId, communityId: In(scope) } : { tenantId },
      order: { id: 'DESC' },
      take: 100,
    });
  }

  private estimateParking(rule: BusinessRule, dto: EstimateBusinessDto, tenantId: number) {
    if (rule.billingUnit !== BusinessBillingUnit.MONTH) {
      throw new BadRequestException('停车月租规则必须按月计费');
    }
    const quantity = dto.months ?? this.monthsBetween(dto.startDate, dto.endDate);
    if (!quantity || quantity < 1) throw new BadRequestException('请选择缴费月数');
    const startDate = dto.startDate ?? this.today();
    const endDate = dto.endDate ?? this.addMonths(startDate, quantity);
    return {
      serviceType: dto.serviceType,
      ruleId: rule.id,
      unitPriceCents: rule.unitPriceCents,
      quantity,
      startDate,
      endDate,
      amountCents: rule.unitPriceCents * quantity,
      summary: `停车月租 ${quantity} 个月`,
      tenantId,
    };
  }

  private estimateAccessCard(rule: BusinessRule, dto: EstimateBusinessDto) {
    if (rule.billingUnit !== BusinessBillingUnit.CARD) {
      throw new BadRequestException('门禁卡规则必须按张计费');
    }
    const quantity = dto.quantity ?? 1;
    return {
      serviceType: dto.serviceType,
      ruleId: rule.id,
      unitPriceCents: rule.unitPriceCents,
      quantity,
      startDate: null,
      endDate: null,
      amountCents: rule.unitPriceCents * quantity,
      summary: `门禁卡 ${quantity} 张`,
    };
  }

  private async upsertVehicle(
    dto: CompleteBusinessDto,
    tenantId: number,
    operatorId: number,
    validUntil: string | null,
  ) {
    if (!dto.vehicleId && !dto.plateNo) {
      throw new BadRequestException('请填写车牌号');
    }
    if (!dto.houseId) throw new BadRequestException('请选择业主房号');
    let vehicle = dto.vehicleId
      ? await this.vehicleRepo.findOne({ where: { id: dto.vehicleId, tenantId } })
      : null;
    if (!vehicle && dto.plateNo) {
      vehicle = await this.vehicleRepo.findOne({
        where: { tenantId, plateNo: dto.plateNo.toUpperCase() },
      });
    }
    if (!vehicle) {
      vehicle = this.vehicleRepo.create({
        tenantId,
        plateNo: dto.plateNo!.toUpperCase(),
        houseId: dto.houseId,
        ownerId: dto.ownerId ?? null,
        validUntil,
        externalRef: null,
        status: 'active',
        createdBy: operatorId,
        updatedBy: operatorId,
      });
    } else {
      vehicle.houseId = dto.houseId;
      vehicle.ownerId = dto.ownerId ?? vehicle.ownerId;
      vehicle.validUntil = validUntil;
      vehicle.updatedBy = operatorId;
    }
    return this.vehicleRepo.save(vehicle);
  }

  private async issueAccessCards(dto: CompleteBusinessDto, tenantId: number, operatorId: number) {
    if (!dto.houseId) throw new BadRequestException('请选择业主房号');
    const quantity = dto.quantity ?? 1;
    const rows: AccessCard[] = [];
    for (let i = 0; i < quantity; i += 1) {
      rows.push(
        this.cardRepo.create({
          tenantId,
          cardNo: `AC${Date.now()}${String(i + 1).padStart(2, '0')}`,
          houseId: dto.houseId,
          ownerId: dto.ownerId ?? null,
          cardType: 'standard',
          externalRef: null,
          status: 'active',
          createdBy: operatorId,
          updatedBy: operatorId,
        }),
      );
    }
    return this.cardRepo.save(rows);
  }

  private async findRule(tenantId: number, ruleId: number, serviceType: BusinessServiceType) {
    const rule = await this.ruleRepo.findOne({
      where: { id: ruleId, tenantId, serviceType, enabled: true },
    });
    if (!rule) throw new NotFoundException('收费规则不存在或已停用');
    return rule;
  }

  private async ensureDefaultRules(tenantId: number, operatorId: number) {
    const count = await this.ruleRepo.count({ where: { tenantId } });
    if (count > 0) return;
    await this.ruleRepo.save([
      this.ruleRepo.create({
        tenantId,
        serviceType: BusinessServiceType.PARKING_MONTHLY,
        name: '停车月租标准价',
        communityId: null,
        billingUnit: BusinessBillingUnit.MONTH,
        unitPriceCents: 15000,
        config: { invoiceItem: '停车服务费' },
        enabled: true,
        createdBy: operatorId,
        updatedBy: operatorId,
      }),
      this.ruleRepo.create({
        tenantId,
        serviceType: BusinessServiceType.ACCESS_CARD,
        name: '门禁卡标准价',
        communityId: null,
        billingUnit: BusinessBillingUnit.CARD,
        unitPriceCents: 2000,
        config: { invoiceItem: '门禁卡工本费', maxCardsPerHouse: 6 },
        enabled: true,
        createdBy: operatorId,
        updatedBy: operatorId,
      }),
    ]);
  }

  private assertRuleShape(dto: UpsertBusinessRuleDto) {
    if (
      dto.serviceType === BusinessServiceType.PARKING_MONTHLY &&
      dto.billingUnit !== BusinessBillingUnit.MONTH
    ) {
      throw new BadRequestException('停车月租必须按月计费');
    }
    if (
      dto.serviceType === BusinessServiceType.ACCESS_CARD &&
      dto.billingUnit !== BusinessBillingUnit.CARD
    ) {
      throw new BadRequestException('门禁卡必须按张计费');
    }
  }

  private monthsBetween(start?: string, end?: string): number {
    if (!start || !end) return 0;
    const a = new Date(start);
    const b = new Date(end);
    if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime()) || b <= a) return 0;
    const days = Math.ceil((b.getTime() - a.getTime()) / 86400000);
    return Math.max(1, Math.ceil(days / 31));
  }

  private addMonths(date: string, months: number): string {
    const d = new Date(`${date}T00:00:00+08:00`);
    d.setMonth(d.getMonth() + months);
    return d.toISOString().slice(0, 10);
  }

  private today(): string {
    return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  }

  private makeTxnNo(serviceType: BusinessServiceType): string {
    const prefix = serviceType === BusinessServiceType.PARKING_MONTHLY ? 'PK' : 'AC';
    const stamp = new Date(Date.now() + 8 * 3600000)
      .toISOString()
      .replace(/\D/g, '')
      .slice(0, 14);
    return `${prefix}${stamp}${Math.floor(Math.random() * 9000 + 1000)}`;
  }

  private requireTenant(user: AuthUser): number {
    if (!user.tenantId) {
      throw new ForbiddenException('tenant scope is required');
    }
    return user.tenantId;
  }
}
