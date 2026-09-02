import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { AuthUser } from '../../common/current-user.decorator';
import { Community, ManagementOffice, RepairTypeRule, RoleScope, Warehouse } from '../../entities';
import { WarehouseType } from '../../common/enums';
import { ensureOfficeRepairRules } from '../repairs/repair-rule-template';
import { ResolvedAccess } from '../access/access.service';
import { scopeCommunityIds } from '../access/scope.util';
import { SaveOfficeDto } from './dto';

@Injectable()
export class OfficesService {
  constructor(
    @InjectRepository(ManagementOffice)
    private readonly officeRepo: Repository<ManagementOffice>,
    @InjectRepository(RepairTypeRule)
    private readonly repairTypeRuleRepo: Repository<RepairTypeRule>,
    @InjectRepository(Warehouse)
    private readonly warehouseRepo: Repository<Warehouse>,
    @InjectRepository(Community)
    private readonly communityRepo: Repository<Community>,
    @InjectRepository(RoleScope)
    private readonly roleScopeRepo: Repository<RoleScope>,
  ) {}

  async list(user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    const [offices, communities] = await Promise.all([
      this.officeRepo.find({ where: { tenantId }, order: { id: 'ASC' } }),
      this.communityRepo.find({
        where: { tenantId },
        order: { id: 'ASC' },
      }),
    ]);
    const tops = communities.filter((item) => item.parentId === null);
    const scope = scopeCommunityIds(access);
    const visibleOfficeIds = this.officeIdsInScope(scope, communities);
    const visibleOffices = visibleOfficeIds
      ? offices.filter((office) => visibleOfficeIds.has(office.id))
      : offices;
    return {
      offices: visibleOffices.map((o) => ({
        id: o.id,
        name: o.name,
        remark: o.remark,
        enabled: o.enabled,
        communities: tops
          .filter(
            (c) =>
              c.officeId === o.id && (!scope || scope.includes(c.id)),
          )
          .map((c) => ({ id: c.id, name: c.name })),
      })),
      /** 尚未划入任何管理处的顶层小区，页面上提示分配 */
      unassigned: tops
        .filter((c) => !c.officeId && (!scope || scope.includes(c.id)))
        .map((c) => ({ id: c.id, name: c.name })),
    };
  }

  async create(dto: SaveOfficeDto, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    if (scopeCommunityIds(access)) {
      throw new ForbiddenException('只有全公司数据范围的账号能新建管理处');
    }
    await this.ensureNameFree(tenantId, dto.name);
    const office = await this.officeRepo.save(
      this.officeRepo.create({
        tenantId,
        name: dto.name.trim(),
        remark: dto.remark ?? null,
        enabled: dto.enabled ?? true,
        createdBy: user.id,
        updatedBy: user.id,
      }),
    );
    if (dto.communityIds !== undefined) {
      await this.assignCommunities(office, dto.communityIds, user.id);
    }
    // 新建管理处时把配套一起建好（2026-08-27 要求）：
    //   · 报修类型配置：从公司默认模板复制一套挂在这个管理处下
    //   · 仓库档案：一个和管理处同名的「管理处仓」（已有同名仓就把它挂过来）
    // 失败不回滚管理处本身 —— 管理处是主，配套随时能在各自页面补
    try {
      await ensureOfficeRepairRules(this.repairTypeRuleRepo, tenantId, office.id, user.id);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn(`管理处 ${office.id} 复制报修类型模板失败：${(error as Error)?.message}`);
    }
    try {
      await this.ensureOfficeWarehouse(tenantId, office, user.id);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn(`管理处 ${office.id} 建同名仓库失败：${(error as Error)?.message}`);
    }
    return { id: office.id };
  }

  /** 同名仓已存在就挂到这个管理处（没挂过的话），否则新建一个管理处仓 */
  private async ensureOfficeWarehouse(tenantId: number, office: ManagementOffice, operatorId: number) {
    const existing = await this.warehouseRepo.findOne({ where: { tenantId, name: office.name } });
    if (existing) {
      if (!existing.officeId) {
        existing.officeId = office.id;
        existing.updatedBy = operatorId;
        await this.warehouseRepo.save(existing);
      }
      return existing;
    }
    return this.warehouseRepo.save(
      this.warehouseRepo.create({
        tenantId,
        name: office.name,
        type: WarehouseType.OFFICE,
        communityId: null,
        officeId: office.id,
        enabled: true,
        createdBy: operatorId,
        updatedBy: operatorId,
      }),
    );
  }

  async update(id: number, dto: SaveOfficeDto, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    const office = await this.officeRepo.findOne({ where: { id, tenantId } });
    if (!office) throw new NotFoundException('管理处不存在');
    await this.assertOfficeInScope(tenantId, id, access);
    this.assertCommunityIdsInScope(dto.communityIds, access);
    if (dto.name.trim() !== office.name) {
      await this.ensureNameFree(tenantId, dto.name);
    }
    office.name = dto.name.trim();
    office.remark = dto.remark ?? null;
    if (dto.enabled !== undefined) office.enabled = dto.enabled;
    office.updatedBy = user.id;
    await this.officeRepo.save(office);
    if (dto.communityIds !== undefined) {
      await this.assignCommunities(office, dto.communityIds, user.id);
    }
    return { id: office.id };
  }

  async remove(id: number, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    const office = await this.officeRepo.findOne({ where: { id, tenantId } });
    if (!office) throw new NotFoundException('管理处不存在');
    await this.assertOfficeInScope(tenantId, id, access);
    const communityCount = await this.communityRepo.count({
      where: { tenantId, officeId: id },
    });
    if (communityCount > 0) {
      throw new BadRequestException(
        `该管理处下还有 ${communityCount} 个小区，请先转移或移出`,
      );
    }
    const scopeCount = await this.roleScopeRepo.count({
      where: { officeId: id },
    });
    if (scopeCount > 0) {
      throw new BadRequestException('仍有角色的数据范围指向该管理处，请先调整角色');
    }
    await this.officeRepo.delete({ id, tenantId });
    return { ok: true };
  }

  private officeIdsInScope(
    scope: number[] | null,
    communities: Array<Pick<Community, 'id' | 'parentId' | 'officeId'>>,
  ): Set<number> | null {
    if (!scope) return null;
    const byId = new Map(communities.map((item) => [item.id, item]));
    const officeIds = new Set<number>();
    for (const id of scope) {
      const item = byId.get(id);
      const officeId =
        item?.officeId ??
        (item?.parentId ? byId.get(item.parentId)?.officeId : null);
      if (officeId) officeIds.add(officeId);
    }
    return officeIds;
  }

  private async assertOfficeInScope(
    tenantId: number,
    officeId: number,
    access?: ResolvedAccess,
  ) {
    const scope = scopeCommunityIds(access);
    if (!scope) return;
    if (!scope.length) throw new NotFoundException('管理处不存在');
    const communities = await this.communityRepo.find({
      where: { tenantId },
      select: ['id', 'parentId', 'officeId'],
    });
    const topIds = communities
      .filter((item) => item.officeId === officeId)
      .map((item) => item.id);
    const officeCommunityIds = new Set(topIds);
    communities
      .filter((item) => item.parentId != null && topIds.includes(item.parentId))
      .forEach((item) => officeCommunityIds.add(item.id));
    if (
      !officeCommunityIds.size ||
      [...officeCommunityIds].some((id) => !scope.includes(id))
    ) {
      throw new NotFoundException('管理处不存在');
    }
  }

  private assertCommunityIdsInScope(
    communityIds: number[] | undefined,
    access?: ResolvedAccess,
  ) {
    if (communityIds === undefined) return;
    const scope = scopeCommunityIds(access);
    if (scope && communityIds.some((id) => !scope.includes(id))) {
      throw new ForbiddenException('所选小区超出你的数据范围');
    }
  }

  /**
   * 整份覆盖管理处的小区清单：传入的顶层小区划归本处，
   * 原本属于本处但不在清单里的移出（office_id 置空）。
   */
  private async assignCommunities(
    office: ManagementOffice,
    communityIds: number[],
    operatorId: number,
  ) {
    const ids = [...new Set(communityIds)];
    if (ids.length) {
      const found = await this.communityRepo.find({
        where: { id: In(ids), tenantId: office.tenantId },
        select: ['id', 'parentId', 'officeId'],
      });
      if (found.length !== ids.length) throw new BadRequestException('小区不存在');
      if (found.some((c) => c.parentId !== null)) {
        throw new BadRequestException('只能划分顶层小区（分期跟随其顶层小区）');
      }
      const taken = found.filter((c) => c.officeId && c.officeId !== office.id);
      if (taken.length) {
        throw new BadRequestException(
          '所选小区已属于其他管理处，请先在原管理处移出',
        );
      }
      await this.communityRepo.update(
        { id: In(ids), tenantId: office.tenantId },
        { officeId: office.id, updatedBy: operatorId },
      );
    }
    await this.communityRepo
      .createQueryBuilder()
      .update()
      .set({ officeId: null, updatedBy: operatorId })
      .where('tenant_id = :tenantId AND office_id = :officeId', {
        tenantId: office.tenantId,
        officeId: office.id,
      })
      .andWhere(ids.length ? 'id NOT IN (:...ids)' : '1=1', { ids })
      .execute();
  }

  private async ensureNameFree(tenantId: number, name: string) {
    const existing = await this.officeRepo.findOne({
      where: { tenantId, name: name.trim() },
    });
    if (existing) throw new BadRequestException('管理处名称已存在');
  }

  private requireTenant(user: AuthUser): number {
    if (!user.tenantId) {
      throw new ForbiddenException('tenant scope is required');
    }
    return user.tenantId;
  }
}
