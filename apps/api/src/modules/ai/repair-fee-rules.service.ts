import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { ManagementOffice, RepairFeeRule } from '../../entities';

export interface RepairFeeRuleInput {
  code: string;
  name: string;
  repairType?: string | null;
  officeId?: number | null;
  keywords?: string[];
  feeCents: number;
  enabled?: boolean;
}

@Injectable()
export class RepairFeeRulesService {
  constructor(
    @InjectRepository(RepairFeeRule)
    private readonly repo: Repository<RepairFeeRule>,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  list(tenantId: number, enabledOnly = false) {
    return this.repo.find({
      where: { tenantId, ...(enabledOnly ? { enabled: true } : {}) },
      order: { id: 'ASC' },
    });
  }

  async create(tenantId: number, userId: number, input: RepairFeeRuleInput) {
    await this.assertOffice(tenantId, input.officeId);
    try {
      return await this.repo.save(
        this.repo.create({
          tenantId,
          ...normalizeRule(input),
          createdBy: userId,
          updatedBy: userId,
        }),
      );
    } catch (error: any) {
      if (error?.code === '23505') throw new ConflictException('维修收费规则编码不能重复');
      throw error;
    }
  }

  async update(tenantId: number, userId: number, id: number, input: RepairFeeRuleInput) {
    const row = await this.repo.findOne({ where: { tenantId, id } });
    if (!row) throw new NotFoundException('维修收费规则不存在');
    await this.assertOffice(tenantId, input.officeId);
    Object.assign(row, normalizeRule(input), { updatedBy: userId });
    try {
      return await this.repo.save(row);
    } catch (error: any) {
      if (error?.code === '23505') throw new ConflictException('维修收费规则编码不能重复');
      throw error;
    }
  }

  async remove(tenantId: number, id: number) {
    const row = await this.repo.findOne({ where: { tenantId, id } });
    if (!row) throw new NotFoundException('维修收费规则不存在');
    await this.repo.remove(row);
    return { ok: true as const };
  }

  private async assertOffice(tenantId: number, officeId?: number | null) {
    if (!officeId) return;
    const exists = await this.dataSource.getRepository(ManagementOffice).exist({
      where: { tenantId, id: officeId, enabled: true },
    });
    if (!exists) throw new BadRequestException('适用管理处不存在或已停用');
  }
}

function normalizeRule(input: RepairFeeRuleInput) {
  return {
    code: input.code.trim(),
    name: input.name.trim(),
    repairType: input.repairType?.trim() || null,
    officeId: input.officeId || null,
    keywords: [...new Set((input.keywords || []).map((item) => item.trim()).filter(Boolean))].slice(0, 30),
    feeCents: Math.max(0, Math.round(input.feeCents)),
    enabled: input.enabled !== false,
  };
}
