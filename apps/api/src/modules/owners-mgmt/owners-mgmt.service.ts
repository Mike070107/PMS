import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, DataSource, In, Repository } from 'typeorm';
import { AuthUser } from '../../common/current-user.decorator';
import { OwnerSource, UserRole, UserStatus } from '../../common/enums';
import { HouseIndex } from '../../common/house-index';
import { ResolvedAccess } from '../access/access.service';
import { scopeCommunityIds } from '../access/scope.util';
import { Building, Community, House, User } from '../../entities';
import {
  CreateOwnerDto,
  ImportOwnersDto,
  ListOwnersQueryDto,
  UpdateOwnerDto,
} from './dto';

@Injectable()
export class OwnersMgmtService {
  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(House)
    private readonly houseRepo: Repository<House>,
    private readonly dataSource: DataSource,
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
        'u.contact_note AS "contactNote"',
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
      // 未绑房号的业主没有可判断的管理处归属，只能由全公司范围账号处理。
      qb.andWhere('c.id IN (:...scopeIds)', { scopeIds: scope });
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
      // 手机号之外的联系方式（老档案的固话、第二个号码），打不通手机时还有个号可以试
      contactNote: r.contactNote ?? null,
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

  async create(dto: CreateOwnerDto, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    if (!dto.phone) throw new BadRequestException('phone is required');
    await this.assertHouseInScope(tenantId, dto.houseId ?? null, access);

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
        contactNote: dto.contactNote ?? null,
        legacyRef: null,
        createdBy: user.id,
        updatedBy: user.id,
      }),
    );
    return this.fetchOne(owner.id, tenantId);
  }

  async update(
    id: number,
    dto: UpdateOwnerDto,
    user: AuthUser,
    access?: ResolvedAccess,
  ) {
    const tenantId = this.requireTenant(user);
    const owner = await this.userRepo.findOne({
      where: { id, tenantId, role: UserRole.OWNER },
    });
    if (!owner) throw new NotFoundException('owner not found');
    await this.assertHouseInScope(tenantId, owner.houseId, access);

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
    if (dto.contactNote !== undefined) owner.contactNote = dto.contactNote || null;
    if (dto.houseId !== undefined) {
      if (dto.houseId === null) {
        if (scopeCommunityIds(access)) {
          throw new ForbiddenException('受限账号不能把业主改成无管理处归属');
        }
        owner.houseId = null;
      } else {
        await this.assertHouseInScope(tenantId, dto.houseId, access);
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

  async remove(id: number, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    const owner = await this.userRepo.findOne({
      where: { id, tenantId, role: UserRole.OWNER },
    });
    if (!owner) throw new NotFoundException('owner not found');
    await this.assertHouseInScope(tenantId, owner.houseId, access);
    // 软停用：保留历史工单/审计链路
    owner.status = UserStatus.DISABLED;
    owner.updatedBy = user.id;
    await this.userRepo.save(owner);
    return { ok: true };
  }

  /**
   * 业主档案批量导入（老系统迁移用），按 legacyRef 幂等：同一份数据重跑只更新、不建重。
   *
   * 三条必须守住的规矩，都是为了「导进来的档案能直接打电话、能直接登录」：
   * 1. **一户一个在册业主**：房号已经绑了别人（且不是本条 legacyRef），这一条不抢绑，
   *    退回 conflicts 让人工判断谁才是现在的业主。老库里同一室多业主的只有 1 户，
   *    自动挑一个反而会把维修电话打给已经搬走的人。
   * 2. **手机号全公司唯一**：号码已经属于另一条档案时，这条不写 phone，
   *    把号码原样塞进 contactNote 并记一条 conflict —— 数据不丢，也不会两个人抢同一个登录身份。
   * 3. **认不出手机号的联系方式不当手机号用**：固话、「13xxxx袁」这种脏数据一律进 contactNote，
   *    phone 留空。宁可空着让人补，也不能让业主端拿一个错号码去匹配房屋。
   */
  async importOwners(
    dto: ImportOwnersDto,
    user: AuthUser,
    access?: ResolvedAccess,
  ) {
    const tenantId = this.requireTenant(user);
    if (scopeCommunityIds(access)) {
      throw new ForbiddenException('批量导入只能由全公司数据范围的账号执行');
    }
    const rows = dto.rows ?? [];
    if (!rows.length) throw new BadRequestException('没有要导入的数据');

    return this.dataSource.transaction(async (manager) => {
      const index = await HouseIndex.load(manager, tenantId);
      const result = {
        created: 0,
        updated: 0,
        unmatched: [] as string[],
        conflicts: [] as string[],
      };

      const refs = rows.map((r) => r.legacyRef);
      const existing = await manager.find(User, {
        where: { tenantId, role: UserRole.OWNER, legacyRef: In(refs) },
      });
      const byRef = new Map(existing.map((u) => [u.legacyRef as string, u]));

      // 已被占用的房号 / 已被占用的手机号：一次查完，逐行判断时不再打库
      const occupiedHouse = new Map<number, User>();
      const occupiedPhone = new Map<string, User>();
      const owners = await manager.find(User, {
        where: { tenantId, role: UserRole.OWNER },
      });
      for (const owner of owners) {
        if (owner.houseId && owner.status === UserStatus.ACTIVE) {
          occupiedHouse.set(owner.houseId, owner);
        }
        if (owner.phone) occupiedPhone.set(owner.phone, owner);
      }

      const toSave: User[] = [];
      for (const row of rows) {
        const house = index.resolve({
          houseId: row.houseId,
          communityName: row.communityName,
          lane: row.lane,
          buildingNo: row.buildingNo,
          roomNo: row.roomNo,
        });
        if (!house) {
          if (result.unmatched.length < 200) {
            result.unmatched.push(
              `${HouseIndex.describe({
                houseId: row.houseId,
                communityName: row.communityName,
                lane: row.lane,
                buildingNo: row.buildingNo,
                roomNo: row.roomNo,
              })}（${row.name}）`,
            );
          }
          continue;
        }

        const found = byRef.get(row.legacyRef);

        // 房号占用检查：被别人占着就不抢
        const houseOwner = occupiedHouse.get(house.id);
        let houseId: number | null = house.id;
        if (houseOwner && houseOwner.legacyRef !== row.legacyRef) {
          houseId = null;
          if (result.conflicts.length < 200) {
            result.conflicts.push(
              `${house.communityName} ${house.buildingNo}号${house.roomNo}：已绑定「${
                houseOwner.name || houseOwner.phone || '#' + houseOwner.id
              }」，${row.name} 未绑定房产`,
            );
          }
        }

        // 手机号唯一性检查：被别人用了就不写 phone，号码留在备注里
        let phone = this.normalizePhone(row.phone);
        let contactNote = row.contactNote?.trim() || null;
        if (phone) {
          const phoneOwner = occupiedPhone.get(phone);
          if (phoneOwner && phoneOwner.legacyRef !== row.legacyRef) {
            if (result.conflicts.length < 200) {
              result.conflicts.push(
                `手机号 ${phone} 已登记在「${
                  phoneOwner.name || '#' + phoneOwner.id
                }」名下，${row.name} 的号码已转存到备注`,
              );
            }
            contactNote = [contactNote, `手机 ${phone}（与其他档案重复，未启用）`]
              .filter(Boolean)
              .join('；');
            phone = null;
          }
        }

        if (found) {
          found.name = row.name;
          found.phone = phone;
          found.contactNote = contactNote;
          if (houseId) found.houseId = houseId;
          found.updatedBy = user.id;
          toSave.push(found);
          result.updated += 1;
        } else {
          const created = manager.create(User, {
            tenantId,
            wxOpenid: null,
            wxUnionid: null,
            name: row.name,
            phone,
            wxNickname: null,
            passwordHash: null,
            loginAccount: null,
            role: UserRole.OWNER,
            houseId,
            status: UserStatus.ACTIVE,
            source: OwnerSource.LEGACY_IMPORT,
            contactNote,
            legacyRef: row.legacyRef,
            createdBy: user.id,
            updatedBy: user.id,
          });
          toSave.push(created);
          result.created += 1;
        }

        // 本批次内部也要互斥，否则同一手机号/同一房号的两行会一起写进去
        if (houseId) {
          occupiedHouse.set(houseId, {
            ...(found ?? ({} as User)),
            id: found?.id ?? 0,
            name: row.name,
            phone,
            legacyRef: row.legacyRef,
          } as User);
        }
        if (phone) {
          occupiedPhone.set(phone, {
            id: found?.id ?? 0,
            name: row.name,
            legacyRef: row.legacyRef,
          } as User);
        }
      }

      if (toSave.length) await manager.save(toSave, { chunk: 500 });
      return result;
    });
  }

  private async assertHouseInScope(
    tenantId: number,
    houseId: number | null,
    access?: ResolvedAccess,
  ) {
    const scope = scopeCommunityIds(access);
    if (!scope) return;
    if (!houseId) {
      throw new ForbiddenException('受限账号只能维护已归属本管理处房屋的业主');
    }
    const house = await this.houseRepo.findOne({ where: { id: houseId, tenantId } });
    if (!house) throw new NotFoundException('house not found');
    const building = await this.dataSource.getRepository(Building).findOne({
      where: { id: house.buildingId, tenantId },
      select: ['id', 'communityId'],
    });
    if (!building || !scope.includes(building.communityId)) {
      throw new NotFoundException('owner not found');
    }
  }

  /** 认得出来才当手机号：11 位 1[3-9] 开头。其余（固话、带汉字的）一律不进 phone 字段 */
  private normalizePhone(raw?: string | null): string | null {
    const value = (raw ?? '').replace(/[\s-]/g, '');
    return /^1[3-9]\d{9}$/.test(value) ? value : null;
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
