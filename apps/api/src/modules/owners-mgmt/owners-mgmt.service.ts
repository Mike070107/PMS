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
import { Building, Community, House, ParkingHistory, RepairRequest, User } from '../../entities';
import {
  CreateOwnerDto,
  ImportOwnersDto,
  ListOwnersQueryDto,
  UpdateOwnerDto,
  OwnerPropertyDto,
  OwnerPhoneEventDto,
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
      .leftJoin(`(SELECT tenant_id, owner_id, house_id, building_id FROM owner_property_links
        UNION SELECT tenant_id, id AS owner_id, house_id, owner_building_id AS building_id FROM users
        WHERE house_id IS NOT NULL OR owner_building_id IS NOT NULL)`, 'op', 'op.owner_id = u.id AND op.tenant_id = u.tenant_id')
      .leftJoin(House, 'h', 'h.id = op.house_id AND h.tenant_id = u.tenant_id')
      .leftJoin(Building, 'b', 'b.id = COALESCE(op.building_id, h.building_id) AND b.tenant_id = u.tenant_id')
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
        'u.contact_phones AS "contactPhones"',
        'u.status AS status',
        'u.role AS role',
        'u.source AS source',
        'u.contact_note AS "contactNote"',
        'op.house_id AS "houseId"',
        'op.building_id AS "ownerBuildingId"',
        'h.room_no AS "roomNo"',
        'h.area_sqm AS "areaSqm"',
        'b.lane AS lane',
        'b.building_no AS "buildingNo"',
        'c.id AS "communityId"',
        'c.name AS "communityName"',
      ])
      .distinctOn(['u.id'])
      .orderBy('u.id', 'DESC')
      .limit(500);

    if (scope) {
      // 未绑房号的业主没有可判断的管理处归属，只能由全公司范围账号处理。
      qb.andWhere('c.id IN (:...scopeIds)', { scopeIds: scope });
    }
    if (query.communityId) {
      qb.andWhere('c.id = :cid', { cid: query.communityId });
    }
    if (query.id) qb.andWhere('u.id = :ownerId', { ownerId: query.id });
    if (query.houseId) qb.andWhere('op.house_id = :houseId', { houseId: query.houseId });
    if (query.buildingId) qb.andWhere('b.id = :buildingId', { buildingId: query.buildingId });
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
            .orWhere('CAST(u.contact_phones AS text) ILIKE :kw', { kw: `%${query.q}%` })
            .orWhere('h.room_no ILIKE :kw', { kw: `%${query.q}%` })
            .orWhere('b.lane ILIKE :kw', { kw: `%${query.q}%` })
            .orWhere('b.building_no ILIKE :kw', { kw: `%${query.q}%` });
        }),
      );
    }

    // 这里只查 role=owner（业主端小程序用户），不再回显代报身份和代报授权 ——
    // 保安/居委会那套 2026-08-24 整体挪到员工端，归「用户管理」维护
    const rows = await qb.getRawMany<any>();

    // 「已核实/活跃」= 这户在系统里有过真实交互。用报修记录做信号：
    // 批量取每户最近一条未删除报修（内容摘要 + 时间），前端据此标「已核实」并显示最近交互。
    const houseIds = Array.from(
      new Set(rows.map((r) => r.houseId).filter(Boolean).map(Number)),
    );
    const lastByHouse = new Map<number, { at: Date; content: string | null }>();
    if (houseIds.length) {
      const reps = await this.userRepo.manager
        .createQueryBuilder(RepairRequest, 'req')
        .select(['req.house_id AS "houseId"', 'req.created_at AS "at"', 'req.content AS content'])
        .where('req.tenant_id = :tenantId', { tenantId })
        .andWhere('req.house_id IN (:...ids)', { ids: houseIds })
        .distinctOn(['req.house_id'])
        .orderBy('req.house_id', 'ASC')
        .addOrderBy('req.created_at', 'DESC')
        .getRawMany<{ houseId: string; at: string; content: string | null }>();
      for (const x of reps) {
        lastByHouse.set(Number(x.houseId), { at: new Date(x.at), content: x.content });
      }
    }

    const ownerIds = rows.map(r => Number(r.id));
    const activity = rows.length ? await this.dataSource.query(`SELECT owner_id,phone,status,last_used_at,last_contacted_at,last_attempted_at,last_result FROM owner_phone_activity WHERE tenant_id=$1 AND owner_id=ANY($2::int[])`, [tenantId, ownerIds]) : [];
    const phones = Array.from(new Set(rows.flatMap(r => this.phones(r.phone, r.contactPhones))));
    // Historical repair intake is real usage evidence, including a contact first registered by that repair.
    const repairUsage = phones.length ? await this.dataSource.query(`SELECT contact_phone AS phone,MAX(created_at) AS last_used_at FROM repair_requests WHERE tenant_id=$1 AND contact_phone=ANY($2::text[]) GROUP BY contact_phone`, [tenantId, phones]) : [];
    const properties = rows.length ? await this.dataSource.query(`SELECT DISTINCT p.owner_id,p.house_id,p.building_id,c.name AS community_name,b.building_no,h.room_no
      FROM (SELECT tenant_id,owner_id,house_id,building_id FROM owner_property_links
        UNION SELECT tenant_id,id,house_id,owner_building_id FROM users WHERE house_id IS NOT NULL OR owner_building_id IS NOT NULL) p
      LEFT JOIN houses h ON h.id=p.house_id AND h.tenant_id=p.tenant_id
      JOIN buildings b ON b.id=COALESCE(p.building_id,h.building_id) AND b.tenant_id=p.tenant_id
      JOIN communities c ON c.id=b.community_id AND c.tenant_id=p.tenant_id
      WHERE p.tenant_id=$1 AND p.owner_id=ANY($2::int[]) ${scope ? 'AND c.id=ANY($3::int[])' : ''}`, scope ? [tenantId, ownerIds, scope] : [tenantId, ownerIds]) : [];
    return rows.map((r) => ({
      id: Number(r.id),
      name: r.name,
      phone: r.phone,
      contactPhones: r.contactPhones ?? (r.phone ? [r.phone] : []),
      phoneActivity: this.phones(r.phone, r.contactPhones).map(phone => {
        const a = activity.find((a: any) => Number(a.owner_id) === Number(r.id) && a.phone === phone);
        const repairAt = repairUsage.find((p: any) => p.phone === phone)?.last_used_at;
        const used = [a?.last_used_at, repairAt].filter(Boolean).sort((x, y) => Date.parse(y) - Date.parse(x))[0] ?? null;
        return { phone, status: a?.status ?? 'unknown', ...a, last_used_at: used };
      }),
      properties: properties.filter((p: any) => Number(p.owner_id) === Number(r.id)),
      status: r.status,
      // 这条档案是怎么来的：报修登记来的是系统顺手记的，还没人核实过
      source: r.source ?? null,
      // 手机号之外的联系方式（老档案的固话、第二个号码），打不通手机时还有个号可以试
      contactNote: r.contactNote ?? null,
      houseId: r.houseId ? Number(r.houseId) : null,
      ownerBuildingId: r.ownerBuildingId ? Number(r.ownerBuildingId) : null,
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
      // 最近交互（报修）：有则前端标「已核实」并显示；无则该档案还没人用过
      lastInteraction:
        r.houseId && lastByHouse.has(Number(r.houseId))
          ? {
              kind: 'repair' as const,
              at: lastByHouse.get(Number(r.houseId))!.at,
              label: (lastByHouse.get(Number(r.houseId))!.content || '报修').trim().slice(0, 24),
            }
          : null,
    }));
  }

  async create(dto: CreateOwnerDto, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    if (!dto.phone) throw new BadRequestException('phone is required');
    await this.assertOwnerPlace(tenantId, dto.houseId ?? null, dto.ownerBuildingId ?? null, access);

    const dup = await this.userRepo.findOne({
      where: { tenantId, phone: dto.phone, role: UserRole.OWNER },
    });
    if (dup) throw new BadRequestException('该手机号已存在业主档案');

    if (dto.houseId) {
      await this.assertHouseAvailable(tenantId, dto.houseId, null);
    }

    const owner = await this.dataSource.transaction(async manager => {
      const created = await manager.save(User, manager.create(User, {
        tenantId,
        wxOpenid: null,
        wxUnionid: null,
        name: dto.name,
        phone: dto.phone,
        contactPhones: this.phones(dto.phone, dto.contactPhones),
        wxNickname: null,
        passwordHash: null,
        loginAccount: null,
        role: UserRole.OWNER,
        houseId: dto.houseId ?? null,
        ownerBuildingId: dto.ownerBuildingId ?? null,
        status: UserStatus.ACTIVE,
        source: OwnerSource.MANUAL,
        contactNote: dto.contactNote ?? null,
        legacyRef: null,
        createdBy: user.id,
        updatedBy: user.id,
      }));
      if (dto.houseId || dto.ownerBuildingId) await manager.query(`INSERT INTO owner_property_links(tenant_id,owner_id,house_id,building_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [tenantId, created.id, dto.houseId ?? null, dto.ownerBuildingId ?? null]);
      return created;
    });
    return this.fetchOne(owner.id, tenantId, access);
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
    await this.assertOwnerInScope(tenantId, id, access);
    const before = {
      name: owner.name,
      phone: owner.phone,
      contactPhones: owner.contactPhones,
      contactNote: owner.contactNote,
      houseId: owner.houseId,
      ownerBuildingId: owner.ownerBuildingId,
      status: owner.status,
    };

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
    if (dto.contactPhones !== undefined || dto.phone !== undefined) owner.contactPhones = this.phones(owner.phone, dto.contactPhones ?? owner.contactPhones);
    if (dto.status !== undefined) { await this.assertFullOwnerScope(tenantId, id, access); owner.status = dto.status; }
    if (dto.contactNote !== undefined) owner.contactNote = dto.contactNote || null;
    if (dto.houseId !== undefined || dto.ownerBuildingId !== undefined) {
      const houseId = dto.houseId !== undefined ? dto.houseId : owner.houseId;
      const buildingId = dto.ownerBuildingId !== undefined ? dto.ownerBuildingId : owner.ownerBuildingId;
      await this.assertOwnerPlace(tenantId, houseId, buildingId, access);
      owner.houseId = houseId;
      owner.ownerBuildingId = buildingId;
    }
    // 身份转换（业主 → 保安/居委会/业委会/物业工作人员）不在业主档案做：
    // 去「用户管理」新增工作人员并填同一手机号，会就地转换、不建重复档案。
    // 这里改身份曾直接把账号踢出所有业主端接口（当时接口只放行 OWNER），已废弃。
    owner.updatedBy = user.id;
    const labels: Record<keyof typeof before, string> = {
      name: '姓名', phone: '电话', contactPhones: '联系电话', contactNote: '其他联系方式', houseId: '绑定房产', ownerBuildingId: '所属商铺', status: '状态',
    };
    const changes = (Object.keys(before) as Array<keyof typeof before>)
      .filter((field) => before[field] !== owner[field])
      .map((field) => ({
        field,
        label: labels[field],
        before: before[field] === null ? null : String(before[field]),
        after: owner[field] === null ? null : String(owner[field]),
      }));
    await this.dataSource.transaction(async (manager) => {
      if (before.houseId || before.ownerBuildingId) await manager.query(`INSERT INTO owner_property_links(tenant_id,owner_id,house_id,building_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [tenantId, id, before.houseId ?? null, before.ownerBuildingId ?? null]);
      if (owner.houseId || owner.ownerBuildingId) await manager.query(`INSERT INTO owner_property_links(tenant_id,owner_id,house_id,building_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [tenantId, id, owner.houseId ?? null, owner.ownerBuildingId ?? null]);
      await manager.save(User, owner);
      if (changes.length) {
        await manager.save(ParkingHistory, manager.create(ParkingHistory, {
          tenantId,
          eventType: 'owner_info_update',
          source: 'pms',
          database: null,
          sourceRecordId: null,
          pmsUserId: owner.id,
          externalOwnerId: null,
          plateBefore: null,
          plateAfter: null,
          summary: `更新业主资料：${changes.map((item) => item.label).join('、')}`,
          changes,
          operatorUserId: user.id,
          detectedByQueryId: null,
          occurredAt: new Date(),
          timeBasis: 'operation',
          createdBy: user.id,
          updatedBy: user.id,
        }));
      }
    });
    return this.fetchOne(id, tenantId, access);
  }

  async remove(id: number, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    const owner = await this.userRepo.findOne({
      where: { id, tenantId, role: UserRole.OWNER },
    });
    if (!owner) throw new NotFoundException('owner not found');
    await this.assertOwnerInScope(tenantId, id, access);
    // 软停用：保留历史工单/审计链路
    await this.assertFullOwnerScope(tenantId, id, access);
    owner.status = UserStatus.DISABLED;
    owner.updatedBy = user.id;
    await this.userRepo.save(owner);
    return { ok: true };
  }

  /**
   * 业主档案批量导入（老系统迁移用），按 legacyRef 幂等：同一份数据重跑只更新、不建重。
   *
   * 三条必须守住的规矩，都是为了「导进来的档案能直接打电话、能直接登录」：
   * 1. **一户多个在册业主**：按每条 legacyRef 独立建档，不因房号相同丢掉关联。
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
      const occupiedPhone = new Map<string, User>();
      const owners = await manager.find(User, {
        where: { tenantId, role: UserRole.OWNER },
      });
      for (const owner of owners) {
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

        const houseId = house.id;

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

        // 同一手机号不能成为两个登录身份，房号不互斥。
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

  private phones(primary: string | null, values: string[] = []) {
    return Array.from(new Set([primary, ...values].map(v => v?.trim()).filter((v): v is string => !!v)));
  }

  async recordPhoneContact(id: number, dto: OwnerPhoneEventDto, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    await this.assertOwnerInScope(tenantId, id, access);
    const owner = await this.userRepo.findOne({ where: { id, tenantId, role: UserRole.OWNER } });
    if (!owner || !this.phones(owner.phone, owner.contactPhones).includes(dto.phone.trim())) throw new BadRequestException('该电话不在此业主档案中');
    const phone = dto.phone.trim();
    await this.dataSource.transaction(async manager => {
      await manager.query(`INSERT INTO owner_phone_events(tenant_id,owner_id,phone,result,note,operator_id) VALUES($1,$2,$3,$4,$5,$6)`, [tenantId,id,phone,dto.result,dto.note ?? null,user.id]);
      await manager.query(`INSERT INTO owner_phone_activity(tenant_id,owner_id,phone,status,last_contacted_at,last_attempted_at,last_result,updated_by)
        VALUES($1,$2,$3,$4::varchar,CASE WHEN $4::varchar='connected' THEN now() END,now(),$4::varchar,$5)
        ON CONFLICT(tenant_id,owner_id,phone) DO UPDATE SET status=EXCLUDED.status,
        last_contacted_at=CASE WHEN EXCLUDED.status='connected' THEN EXCLUDED.last_contacted_at ELSE owner_phone_activity.last_contacted_at END,
        last_attempted_at=EXCLUDED.last_attempted_at,last_result=EXCLUDED.last_result,updated_by=EXCLUDED.updated_by`, [tenantId,id,phone,dto.result,user.id]);
    });
    return { ok: true };
  }

  private async assertOwnerInScope(tenantId: number, id: number, access?: ResolvedAccess) {
    if (!scopeCommunityIds(access)) return;
    const visible = await this.list({ id }, { tenantId } as AuthUser, access);
    if (!visible.some(r => r.id === id)) throw new ForbiddenException('业主不在授权范围');
  }

  private async assertFullOwnerScope(tenantId: number, id: number, access?: ResolvedAccess) {
    const scope = scopeCommunityIds(access);
    if (!scope) return;
    const outside = await this.dataSource.query(`SELECT 1 FROM (
      SELECT tenant_id,owner_id,house_id,building_id FROM owner_property_links
      UNION SELECT tenant_id,id,house_id,owner_building_id FROM users WHERE house_id IS NOT NULL OR owner_building_id IS NOT NULL
      ) p LEFT JOIN houses h ON h.id=p.house_id AND h.tenant_id=p.tenant_id
      JOIN buildings b ON b.id=COALESCE(p.building_id,h.building_id) AND b.tenant_id=p.tenant_id
      WHERE p.tenant_id=$1 AND p.owner_id=$2 AND NOT(b.community_id=ANY($3::int[])) LIMIT 1`, [tenantId,id,scope]);
    if (outside.length) throw new ForbiddenException('该业主还有授权范围外的房产，只能解除当前房产关联，不能停用或恢复整份档案');
  }

  async linkProperty(id: number, dto: OwnerPropertyDto, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    if ((!dto.houseId && !dto.ownerBuildingId) || (dto.houseId && dto.ownerBuildingId)) throw new BadRequestException('请选择一个房号或商铺');
    const owner = await this.userRepo.findOne({ where: { id, tenantId, role: UserRole.OWNER } });
    if (!owner) throw new NotFoundException('owner not found');
    await this.assertOwnerInScope(tenantId, id, access);
    await this.assertOwnerPlace(tenantId, dto.houseId ?? null, dto.ownerBuildingId, access);
    await this.dataSource.query(`INSERT INTO owner_property_links(tenant_id,owner_id,house_id,building_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [tenantId, id, dto.houseId ?? null, dto.ownerBuildingId ?? null]);
    return { ok: true };
  }

  async unlinkProperty(id: number, dto: OwnerPropertyDto, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    if ((!dto.houseId && !dto.ownerBuildingId) || (dto.houseId && dto.ownerBuildingId)) throw new BadRequestException('请选择一个房号或商铺');
    await this.assertOwnerInScope(tenantId, id, access);
    await this.assertOwnerPlace(tenantId, dto.houseId ?? null, dto.ownerBuildingId, access);
    await this.dataSource.transaction(async manager => {
      const owner = await manager.findOne(User, { where: { id, tenantId, role: UserRole.OWNER }, lock: { mode: 'pessimistic_write' } });
      if (!owner) throw new NotFoundException('owner not found');
      await manager.query(`DELETE FROM owner_property_links WHERE tenant_id=$1 AND owner_id=$2 AND (house_id=$3 OR building_id=$4)`, [tenantId, id, dto.houseId ?? null, dto.ownerBuildingId ?? null]);
      if (dto.houseId && owner.houseId === dto.houseId || dto.ownerBuildingId && owner.ownerBuildingId === dto.ownerBuildingId) {
        const [next] = await manager.query(`SELECT house_id,building_id FROM owner_property_links WHERE tenant_id=$1 AND owner_id=$2 ORDER BY id LIMIT 1`, [tenantId, id]);
        owner.houseId = next?.house_id ?? null; owner.ownerBuildingId = next?.building_id ?? null;
        owner.updatedBy = user.id;
        await manager.save(User, owner);
      }
    });
    return { ok: true };
  }

  private async assertOwnerPlace(tenantId: number, houseId: number | null, buildingId: number | null | undefined, access?: ResolvedAccess) {
    if (houseId && buildingId) throw new BadRequestException('房号和商铺不能同时绑定');
    if (buildingId) {
      const building = await this.dataSource.getRepository(Building).findOne({ where: { id: buildingId, tenantId } });
      if (!building || building.buildingType !== 'shop') throw new BadRequestException('请选择本公司的商铺');
      const scope = scopeCommunityIds(access);
      if (scope && !scope.includes(building.communityId)) throw new ForbiddenException('商铺不在授权范围');
      return;
    }
    if (houseId) await this.assertHouseAvailable(tenantId, houseId, null);
    await this.assertHouseInScope(tenantId, houseId, access);
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

    // 房号允许多个业主；手机号仍唯一，不能复用他人的登录身份。
  }

  private async fetchOne(id: number, tenantId: number, access?: ResolvedAccess) {
    const rows = await this.list({ id } as ListOwnersQueryDto, {
      id: 0,
      tenantId,
      // 内部复用 list 拿单条：这里的 role 只用于「不是业主端」这一层判断
      role: UserRole.STAFF,
    } as AuthUser, access);
    return rows.find((r) => r.id === id) ?? null;
  }

  private requireTenant(user: AuthUser): number {
    if (!user.tenantId) {
      throw new ForbiddenException('tenant scope is required');
    }
    return user.tenantId;
  }
}
