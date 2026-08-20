import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import { AuthUser } from '../../common/current-user.decorator';
import { Community, ManagementOffice, RoleScope } from '../../entities';
import { SaveOfficeDto } from './dto';

@Injectable()
export class OfficesService {
  constructor(
    @InjectRepository(ManagementOffice)
    private readonly officeRepo: Repository<ManagementOffice>,
    @InjectRepository(Community)
    private readonly communityRepo: Repository<Community>,
    @InjectRepository(RoleScope)
    private readonly roleScopeRepo: Repository<RoleScope>,
  ) {}

  async list(user: AuthUser) {
    const tenantId = this.requireTenant(user);
    const [offices, tops] = await Promise.all([
      this.officeRepo.find({ where: { tenantId }, order: { id: 'ASC' } }),
      this.communityRepo.find({
        where: { tenantId, parentId: IsNull() },
        order: { id: 'ASC' },
      }),
    ]);
    return {
      offices: offices.map((o) => ({
        id: o.id,
        name: o.name,
        remark: o.remark,
        enabled: o.enabled,
        communities: tops
          .filter((c) => c.officeId === o.id)
          .map((c) => ({ id: c.id, name: c.name })),
      })),
      /** 尚未划入任何管理处的顶层小区，页面上提示分配 */
      unassigned: tops
        .filter((c) => !c.officeId)
        .map((c) => ({ id: c.id, name: c.name })),
    };
  }

  async create(dto: SaveOfficeDto, user: AuthUser) {
    const tenantId = this.requireTenant(user);
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
    return { id: office.id };
  }

  async update(id: number, dto: SaveOfficeDto, user: AuthUser) {
    const tenantId = this.requireTenant(user);
    const office = await this.officeRepo.findOne({ where: { id, tenantId } });
    if (!office) throw new NotFoundException('管理处不存在');
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

  async remove(id: number, user: AuthUser) {
    const tenantId = this.requireTenant(user);
    const office = await this.officeRepo.findOne({ where: { id, tenantId } });
    if (!office) throw new NotFoundException('管理处不存在');
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
