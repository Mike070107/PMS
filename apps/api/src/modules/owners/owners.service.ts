import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, In, IsNull, Repository } from 'typeorm';
import { AuthUser } from '../../common/current-user.decorator';
import { AuditStatus, UserRole, UserStatus } from '../../common/enums';
import { ResolvedAccess } from '../access/access.service';
import { scopeCommunityIds } from '../access/scope.util';
import {
  Building,
  Community,
  House,
  User,
  UserAudit,
} from '../../entities';
import {
  ApproveAuditDto,
  ListAuditsQueryDto,
  RegisterOwnerDto,
  RejectAuditDto,
} from './dto';

/** 去重且过滤空值，用于批量查关联表 */
function unique(ids: Array<number | null | undefined>): number[] {
  return Array.from(new Set(ids.filter((id): id is number => !!id)));
}

@Injectable()
export class OwnersService {
  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(UserAudit)
    private readonly auditRepo: Repository<UserAudit>,
    @InjectRepository(Community)
    private readonly communityRepo: Repository<Community>,
    @InjectRepository(Building)
    private readonly buildingRepo: Repository<Building>,
    @InjectRepository(House)
    private readonly houseRepo: Repository<House>,
  ) {}

  async register(dto: RegisterOwnerDto) {
    if (!dto.wxOpenid && !dto.wxUnionid && !dto.phone) {
      throw new BadRequestException('wxOpenid, wxUnionid or phone is required');
    }

    const community = await this.communityRepo.findOne({
      where: { id: dto.communityId, tenantId: dto.tenantId, enabled: true },
    });
    if (!community) throw new NotFoundException('community not found');

    if (dto.buildingId) {
      const building = await this.buildingRepo.findOne({
        where: {
          id: dto.buildingId,
          tenantId: dto.tenantId,
          communityId: dto.communityId,
        },
      });
      if (!building) throw new NotFoundException('building not found');
    }

    if (dto.houseId) {
      const house = await this.houseRepo.findOne({
        where: { id: dto.houseId, tenantId: dto.tenantId },
      });
      if (!house) throw new NotFoundException('house not found');
    }

    const user = await this.findOrCreateOwner(dto);
    const existingPending = await this.auditRepo.findOne({
      where: {
        tenantId: dto.tenantId,
        userId: user.id,
        status: AuditStatus.PENDING,
      },
      order: { id: 'DESC' },
    });
    if (existingPending) {
      return { user, audit: existingPending };
    }

    const audit = this.auditRepo.create({
      tenantId: dto.tenantId,
      userId: user.id,
      communityId: dto.communityId,
      buildingId: dto.buildingId ?? null,
      houseId: dto.houseId ?? null,
      rawAddress: dto.rawAddress ?? null,
      applicantName: dto.name ?? user.name,
      applicantPhone: dto.phone ?? user.phone,
      status: AuditStatus.PENDING,
      rejectReason: null,
      reviewedBy: null,
      reviewedAt: null,
      createdBy: user.id,
      updatedBy: user.id,
    });

    return { user, audit: await this.auditRepo.save(audit) };
  }

  /**
   * 审核列表：直接把姓名/电话/地址拼好给后台。
   * 原来只返回 audits 原始行，后台表格拿 name/phone/address 全是空的，
   * 审核的人根本看不出这条申请是谁、哪一户。
   */
  async listAudits(query: ListAuditsQueryDto, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    const status = this.parseAuditStatus(query.status);
    const scope = scopeCommunityIds(access);
    if (scope && !scope.length) return [];
    const where: FindOptionsWhere<UserAudit> = status ? { tenantId, status } : { tenantId };
    if (scope) where.communityId = In(scope);
    const audits = await this.auditRepo.find({
      where,
      order: { id: 'DESC' },
      take: 100,
    });
    if (!audits.length) return [];

    const communityIds = unique(audits.map((item) => item.communityId));
    const buildingIds = unique(audits.map((item) => item.buildingId));
    const houseIds = unique(audits.map((item) => item.houseId));
    const userIds = unique(audits.map((item) => item.userId));

    const [communities, buildings, houses, users] = await Promise.all([
      communityIds.length
        ? this.communityRepo.find({ where: { id: In(communityIds) } })
        : [],
      buildingIds.length
        ? this.buildingRepo.find({ where: { tenantId, id: In(buildingIds) } })
        : [],
      houseIds.length
        ? this.houseRepo.find({ where: { tenantId, id: In(houseIds) } })
        : [],
      userIds.length ? this.userRepo.find({ where: { id: In(userIds) } }) : [],
    ]);

    const communityById = new Map(communities.map((item) => [item.id, item] as const));
    const buildingById = new Map(buildings.map((item) => [item.id, item] as const));
    const houseById = new Map(houses.map((item) => [item.id, item] as const));
    const userById = new Map(users.map((item) => [item.id, item] as const));

    return audits.map((audit) => {
      const community = communityById.get(audit.communityId);
      const building = audit.buildingId ? buildingById.get(audit.buildingId) : null;
      const house = audit.houseId ? houseById.get(audit.houseId) : null;
      const owner = userById.get(audit.userId);
      const buildingText = building
        ? `${building.lane ? building.lane + '弄' : ''}${building.buildingNo}号`
        : '';
      // 房号：审核通过后以正式房产为准，审核中用业主自填的原始文本
      const roomNo = house?.roomNo ?? audit.rawAddress ?? '';

      return {
        id: audit.id,
        userId: audit.userId,
        // 业主没填真名时退回微信昵称，至少让审核的人能对上人
        name: audit.applicantName || owner?.name || owner?.wxNickname || '',
        phone: audit.applicantPhone || owner?.phone || '',
        // 门牌各段连写不留空格：枫桦景苑二期 228弄26号101室
        address: [community?.name, `${buildingText}${roomNo ? `${roomNo}室` : ''}`]
          .filter(Boolean)
          .join(' '),
        communityId: audit.communityId,
        communityName: community?.name ?? '',
        buildingId: audit.buildingId,
        buildingText,
        houseId: audit.houseId,
        roomNo,
        status: audit.status,
        rejectReason: audit.rejectReason,
        createdAt: audit.createdAt,
        reviewedAt: audit.reviewedAt,
      };
    });
  }

  async approve(auditId: number, dto: ApproveAuditDto, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    const audit = await this.auditRepo.findOne({
      where: { id: auditId, tenantId },
    });
    if (!audit) throw new NotFoundException('audit not found');
    this.assertAuditInScope(audit, access);
    if (audit.status !== AuditStatus.PENDING) {
      throw new BadRequestException('audit is already reviewed');
    }

    const house = await this.resolveHouseForApproval(audit, dto, tenantId, user.id);
    const owner = await this.userRepo.findOne({
      where: { id: audit.userId, tenantId },
    });
    if (!owner) throw new NotFoundException('owner not found');

    owner.houseId = house.id;
    owner.status = UserStatus.ACTIVE;
    owner.updatedBy = user.id;

    audit.houseId = house.id;
    audit.buildingId = house.buildingId;
    audit.status = AuditStatus.APPROVED;
    audit.reviewedBy = user.id;
    audit.reviewedAt = new Date();
    audit.updatedBy = user.id;

    await this.userRepo.save(owner);
    return this.auditRepo.save(audit);
  }

  async reject(auditId: number, dto: RejectAuditDto, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    const audit = await this.auditRepo.findOne({
      where: { id: auditId, tenantId },
    });
    if (!audit) throw new NotFoundException('audit not found');
    this.assertAuditInScope(audit, access);
    if (audit.status !== AuditStatus.PENDING) {
      throw new BadRequestException('audit is already reviewed');
    }

    audit.status = AuditStatus.REJECTED;
    audit.rejectReason = dto.reason;
    audit.reviewedBy = user.id;
    audit.reviewedAt = new Date();
    audit.updatedBy = user.id;
    return this.auditRepo.save(audit);
  }

  /**
   * 撤销审核：把已通过/已驳回的申请退回「待审核」，让人重新审。
   * 点错了「通过」会把房子绑到业主账号上、点错「驳回」会把原因推给业主看，
   * 两种都得能收回。通过的还要把绑定解开 —— 但只解本次审核绑上的那套房
   * （owner.houseId 仍等于 audit.houseId 时），别把之后另外绑上的房也一起摘掉。
   */
  async revert(auditId: number, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    const audit = await this.auditRepo.findOne({
      where: { id: auditId, tenantId },
    });
    if (!audit) throw new NotFoundException('audit not found');
    this.assertAuditInScope(audit, access);
    if (audit.status === AuditStatus.PENDING) {
      throw new BadRequestException('该申请还在待审核，无需撤销');
    }
    // 业主已经另交了一份新申请：撤旧的会让两份同时待审，直接审新的即可
    const newer = await this.auditRepo.findOne({
      where: { tenantId, userId: audit.userId, status: AuditStatus.PENDING },
    });
    if (newer && newer.id !== audit.id) {
      throw new BadRequestException('该业主已提交了新的申请，请直接审核新申请');
    }

    if (audit.status === AuditStatus.APPROVED && audit.houseId) {
      const owner = await this.userRepo.findOne({
        where: { id: audit.userId, tenantId },
      });
      if (owner && owner.houseId === audit.houseId) {
        owner.houseId = null;
        owner.updatedBy = user.id;
        await this.userRepo.save(owner);
      }
    }

    audit.status = AuditStatus.PENDING;
    audit.rejectReason = null;
    audit.reviewedBy = null;
    audit.reviewedAt = null;
    audit.updatedBy = user.id;
    return this.auditRepo.save(audit);
  }

  private async findOrCreateOwner(dto: RegisterOwnerDto): Promise<User> {
    const candidates: FindOptionsWhere<User>[] = [
      dto.wxUnionid ? { tenantId: dto.tenantId, wxUnionid: dto.wxUnionid } : null,
      dto.wxOpenid ? { tenantId: dto.tenantId, wxOpenid: dto.wxOpenid } : null,
      dto.phone ? { tenantId: dto.tenantId, phone: dto.phone } : null,
    ].filter(Boolean) as FindOptionsWhere<User>[];

    for (const where of candidates) {
      const existing = await this.userRepo.findOne({ where });
      if (existing) {
        existing.wxOpenid = existing.wxOpenid ?? dto.wxOpenid ?? null;
        existing.wxUnionid = existing.wxUnionid ?? dto.wxUnionid ?? null;
        existing.phone = existing.phone ?? dto.phone ?? null;
        existing.name = dto.name ?? existing.name;
        return this.userRepo.save(existing);
      }
    }

    return this.userRepo.save(
      this.userRepo.create({
        tenantId: dto.tenantId,
        wxOpenid: dto.wxOpenid ?? null,
        wxUnionid: dto.wxUnionid ?? null,
        name: dto.name ?? null,
        phone: dto.phone ?? null,
        wxNickname: null,
        passwordHash: null,
        loginAccount: null,
        role: UserRole.OWNER,
        houseId: null,
        status: UserStatus.ACTIVE,
        createdBy: null,
        updatedBy: null,
      }),
    );
  }

  private async resolveHouseForApproval(
    audit: UserAudit,
    dto: ApproveAuditDto,
    tenantId: number,
    reviewerId: number,
  ): Promise<House> {
    const houseId = dto.houseId ?? audit.houseId;
    if (houseId) {
      const house = await this.houseRepo.findOne({
        where: { id: houseId, tenantId },
      });
      if (!house) throw new NotFoundException('house not found');
      return house;
    }

    const buildingId = dto.buildingId ?? audit.buildingId;
    // 房号默认用业主入驻时自填的原始文本 —— 后台点「通过」时不该被迫再输一遍
    const roomNo = (dto.roomNo ?? audit.rawAddress ?? '').trim();
    if (!buildingId) {
      throw new BadRequestException('这条申请没有楼栋信息，请补选楼栋后再通过');
    }
    if (!roomNo) {
      throw new BadRequestException('这条申请没有房号，请补填房号后再通过');
    }

    const building = await this.buildingRepo.findOne({
      where: { id: buildingId, tenantId, communityId: audit.communityId },
    });
    if (!building) throw new NotFoundException('楼栋不存在或不属于该小区');

    const existing = await this.houseRepo.findOne({
      where: {
        tenantId,
        buildingId,
        unitId: dto.unitId ?? IsNull(),
        roomNo,
      },
    });
    if (existing) return existing;

    return this.houseRepo.save(
      this.houseRepo.create({
        tenantId,
        buildingId,
        unitId: dto.unitId ?? null,
        roomNo,
        createdBy: reviewerId,
        updatedBy: reviewerId,
      }),
    );
  }

  private requireTenant(user: AuthUser): number {
    if (!user.tenantId) {
      throw new ForbiddenException('当前账号未归属物业，无法处理入驻审核');
    }
    return user.tenantId;
  }

  /** 受限角色只能处理自己范围内小区的入驻申请 */
  private assertAuditInScope(audit: UserAudit, access?: ResolvedAccess) {
    const scope = scopeCommunityIds(access);
    if (scope && !scope.includes(audit.communityId)) {
      throw new NotFoundException('audit not found');
    }
  }

  private parseAuditStatus(status?: string): AuditStatus | undefined {
    if (!status) return undefined;
    if (!Object.values(AuditStatus).includes(status as AuditStatus)) {
      throw new BadRequestException('invalid audit status');
    }
    return status as AuditStatus;
  }
}
