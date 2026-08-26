import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, In, Repository } from 'typeorm';
import { AuthUser } from '../../common/current-user.decorator';
import { OwnerSource, UserRole, UserStatus } from '../../common/enums';
import { ResolvedAccess } from '../access/access.service';
import { scopeCommunityIds } from '../access/scope.util';
import { Building, Community, House, User } from '../../entities';
import { CreateOwnerDto, ListOwnersQueryDto, UpdateOwnerDto } from './dto';

@Injectable()
export class OwnersMgmtService {
  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(House)
    private readonly houseRepo: Repository<House>,
  ) {}

  async list(query: ListOwnersQueryDto, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    const scope = scopeCommunityIds(access);
    if (scope && !scope.length) return [];
    const qb = this.userRepo
      .createQueryBuilder('u')
      .leftJoin(House, 'h', 'h.id = u.house_id AND h.tenant_id = u.tenant_id')
      .leftJoin(Building, 'b', 'b.id = h.building_id AND b.tenant_id = h.tenant_id')
      .leftJoin(
        Community,
        'c',
        'c.id = b.community_id AND c.tenant_id = b.tenant_id',
      )
      .where('u.tenant_id = :tenantId', { tenantId })
      // 业主档案只管普通小程序用户；保安/居委会/业委会/物业工作人员是「工作人员」，
      // 统一在「用户管理」里维护（那边填同一手机号即可把业主账号就地转成工作人员）。
      // 两页各管一类人，同一个人才不会出现两条档案（2026-08-21 定）。
      .andWhere('u.role = :ownerRole', { ownerRole: UserRole.OWNER })
      .select([
        'u.id AS id',
        'u.name AS name',
        'u.phone AS phone',
        'u.status AS status',
        'u.role AS role',
        'u.source AS source',
        'u.house_id AS "houseId"',
        'h.room_no AS "roomNo"',
        'h.area_sqm AS "areaSqm"',
        'b.lane AS lane',
        'b.building_no AS "buildingNo"',
        'c.id AS "communityId"',
        'c.name AS "communityName"',
      ])
      .orderBy('u.id', 'DESC')
      .limit(500);

    if (scope) {
      // 未绑房号的业主没有小区归属，仍然要能被范围内的管理员处理，所以放行 NULL
      qb.andWhere('(c.id IN (:...scopeIds) OR c.id IS NULL)', { scopeIds: scope });
    }
    if (query.communityId) {
      qb.andWhere('c.id = :cid', { cid: query.communityId });
    }
    if (query.status) {
      qb.andWhere('u.status = :st', { st: query.status });
    }
    if (query.unbound) {
      qb.andWhere('u.house_id IS NULL');
    }
    if (query.q) {
      qb.andWhere(
        new Brackets((sub) => {
          sub
            .where('u.name ILIKE :kw', { kw: `%${query.q}%` })
            .orWhere('u.phone ILIKE :kw', { kw: `%${query.q}%` })
            .orWhere('h.room_no ILIKE :kw', { kw: `%${query.q}%` })
            .orWhere('b.lane ILIKE :kw', { kw: `%${query.q}%` })
            .orWhere('b.building_no ILIKE :kw', { kw: `%${query.q}%` });
        }),
      );
    }

    // 这里只查 role=owner（业主端小程序用户），不再回显代报身份和代报授权 ——
    // 保安/居委会那套 2026-08-24 整体挪到员工端，归「用户管理」维护
    const rows = await qb.getRawMany<any>();

    return rows.map((r) => ({
      id: Number(r.id),
      name: r.name,
      phone: r.phone,
      status: r.status,
      // 这条档案是怎么来的：报修登记来的是系统顺手记的，还没人核实过
      source: r.source ?? null,
      houseId: r.houseId ? Number(r.houseId) : null,
      house: r.houseId
        ? {
            id: Number(r.houseId),
            roomNo: r.roomNo,
            areaSqm: r.areaSqm,
            lane: r.lane,
            buildingNo: r.buildingNo,
            communityId: r.communityId ? Number(r.communityId) : null,
            communityName: r.communityName,
          }
        : null,
    }));
  }

  async create(dto: CreateOwnerDto, user: AuthUser) {
    const tenantId = this.requireTenant(user);
    if (!dto.phone) throw new BadRequestException('phone is required');

    const dup = await this.userRepo.findOne({
      where: { tenantId, phone: dto.phone, role: UserRole.OWNER },
    });
    if (dup) throw new BadRequestException('该手机号已存在业主档案');

    if (dto.houseId) {
      await this.assertHouseAvailable(tenantId, dto.houseId, null);
    }

    const owner = await this.userRepo.save(
      this.userRepo.create({
        tenantId,
        wxOpenid: null,
        wxUnionid: null,
        name: dto.name,
        phone: dto.phone,
        wxNickname: null,
        passwordHash: null,
        loginAccount: null,
        role: UserRole.OWNER,
        houseId: dto.houseId ?? null,
        status: UserStatus.ACTIVE,
        source: OwnerSource.MANUAL,
        createdBy: user.id,
        updatedBy: user.id,
      }),
    );
    return this.fetchOne(owner.id, tenantId);
  }

  async update(id: number, dto: UpdateOwnerDto, user: AuthUser) {
    const tenantId = this.requireTenant(user);
    const owner = await this.userRepo.findOne({
      where: { id, tenantId, role: UserRole.OWNER },
    });
    if (!owner) throw new NotFoundException('owner not found');

    if (dto.phone && dto.phone !== owner.phone) {
      const dup = await this.userRepo.findOne({
        where: { tenantId, phone: dto.phone, role: UserRole.OWNER },
      });
      if (dup && dup.id !== id) {
        throw new BadRequestException('该手机号已存在业主档案');
      }
      owner.phone = dto.phone;
    }
    if (dto.name !== undefined) owner.name = dto.name;
    if (dto.status !== undefined) owner.status = dto.status;
    if (dto.houseId !== undefined) {
      if (dto.houseId === null) {
        owner.houseId = null;
      } else {
        await this.assertHouseAvailable(tenantId, dto.houseId, id);
        owner.houseId = dto.houseId;
      }
    }
    // 身份转换（业主 → 保安/居委会/业委会/物业工作人员）不在业主档案做：
    // 去「用户管理」新增工作人员并填同一手机号，会就地转换、不建重复档案。
    // 这里改身份曾直接把账号踢出所有业主端接口（当时接口只放行 OWNER），已废弃。
    owner.updatedBy = user.id;
    await this.userRepo.save(owner);
    return this.fetchOne(id, tenantId);
  }

  async remove(id: number, user: AuthUser) {
    const tenantId = this.requireTenant(user);
    const owner = await this.userRepo.findOne({
      where: { id, tenantId, role: UserRole.OWNER },
    });
    if (!owner) throw new NotFoundException('owner not found');
    // 软停用：保留历史工单/审计链路
    owner.status = UserStatus.DISABLED;
    owner.updatedBy = user.id;
    await this.userRepo.save(owner);
    return { ok: true };
  }

  private async assertHouseAvailable(
    tenantId: number,
    houseId: number,
    ignoreOwnerId: number | null,
  ) {
    const house = await this.houseRepo.findOne({
      where: { id: houseId, tenantId },
    });
    if (!house) throw new NotFoundException('house not found');

    const occupied = await this.userRepo
      .createQueryBuilder('u')
      .where('u.tenant_id = :tenantId', { tenantId })
      .andWhere('u.role = :role', { role: UserRole.OWNER })
      .andWhere('u.house_id = :hid', { hid: houseId })
      .andWhere('u.status = :st', { st: UserStatus.ACTIVE })
      .andWhere(ignoreOwnerId ? 'u.id <> :ignoreId' : '1=1', {
        ignoreId: ignoreOwnerId ?? 0,
      })
      .getOne();
    if (occupied) {
      throw new BadRequestException(
        `该房产已绑定业主 ${occupied.name || '#' + occupied.id}`,
      );
    }
  }

  private async fetchOne(id: number, tenantId: number) {
    const rows = await this.list({} as ListOwnersQueryDto, {
      id: 0,
      tenantId,
      // 内部复用 list 拿单条：这里的 role 只用于「不是业主端」这一层判断
      role: UserRole.STAFF,
    } as AuthUser);
    return rows.find((r) => r.id === id) ?? null;
  }

  private requireTenant(user: AuthUser): number {
    if (!user.tenantId) {
      throw new ForbiddenException('tenant scope is required');
    }
    return user.tenantId;
  }
}
