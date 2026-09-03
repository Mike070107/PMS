import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { AuthUser } from '../../common/current-user.decorator';
import { AiAssistFeedback, WorkOrder } from '../../entities';
import { ResolvedAccess } from '../access/access.service';
import { scopeCommunityIds } from '../access/scope.util';
import { ExtractSamplesService } from './extract-samples.service';

export interface AiFeedbackInput {
  kind: 'repair' | 'completion';
  workOrderId?: number | null;
  /** 完工类反馈所属的完工提交批次；该批次被撤回时这条样例一起失效 */
  completionBatchId?: number | null;
  sourceText: string;
  draft: Record<string, unknown>;
  finalValue: Record<string, unknown>;
  model?: string | null;
  userId?: number | null;
}

@Injectable()
export class AiFeedbackService {
  constructor(
    @InjectRepository(AiAssistFeedback)
    private readonly repo: Repository<AiAssistFeedback>,
    @InjectRepository(WorkOrder)
    private readonly workOrderRepo: Repository<WorkOrder>,
    private readonly samples: ExtractSamplesService,
  ) {}

  async record(tenantId: number, input: AiFeedbackInput): Promise<AiAssistFeedback | null> {
    const sourceText = input.sourceText.trim();
    if (!sourceText || !Object.keys(input.draft || {}).length) return null;
    const draft = sanitizeFields(input.kind, input.draft);
    const finalValue = sanitizeFields(input.kind, input.finalValue);
    if (!Object.keys(draft).length) return null;
    const fieldDiff = diffFields(draft, finalValue);
    return this.repo.save(
      this.repo.create({
        tenantId,
        kind: input.kind,
        workOrderId: input.workOrderId ?? null,
        completionBatchId: input.completionBatchId ?? null,
        sourceText,
        draft,
        finalValue,
        fieldDiff,
        status: Object.keys(fieldDiff).length ? 'pending' : 'confirmed',
        model: input.model ?? null,
        promptVersion: '2026-09-02',
        createdBy: input.userId ?? null,
        updatedBy: input.userId ?? null,
      }),
    );
  }

  async list(
    tenantId: number,
    user: AuthUser,
    access?: ResolvedAccess,
    kind?: string,
    status?: string,
  ) {
    const rows = await this.repo.find({
      where: {
        tenantId,
        ...(kind === 'repair' || kind === 'completion' ? { kind } : {}),
        ...(['pending', 'confirmed', 'promoted', 'ignored', 'reversed'].includes(status ?? '')
          ? { status: status as AiAssistFeedback['status'] }
          : {}),
      },
      order: { updatedAt: 'DESC' },
      take: 100,
    });
    return this.filterByAccess(tenantId, rows, user, access);
  }

  async promote(
    tenantId: number,
    user: AuthUser,
    access: ResolvedAccess | undefined,
    id: number,
  ) {
    const row = await this.findOne(tenantId, id);
    await this.assertVisible(tenantId, row, user, access);
    if (row.status !== 'pending') throw new BadRequestException('只有待审核的纠错可以收为样例');
    if (Object.keys(row.fieldDiff).every((key) => key === 'feeRuleCode' || key === 'feeCents')) {
      throw new BadRequestException('这次只修改了收费，请调整维修收费规则后忽略本条');
    }
    await this.samples.create(tenantId, user.id, {
      kind: row.kind,
      text: row.sourceText,
      expected: sampleExpected(row.kind, row.finalValue),
      note: `由工单 #${row.workOrderId ?? '-'} 的人工纠错审核收录`,
    });
    row.status = 'promoted';
    row.updatedBy = user.id;
    await this.repo.save(row);
    return row;
  }

  async ignore(
    tenantId: number,
    user: AuthUser,
    access: ResolvedAccess | undefined,
    id: number,
  ) {
    const row = await this.findOne(tenantId, id);
    await this.assertVisible(tenantId, row, user, access);
    row.status = 'ignored';
    row.updatedBy = user.id;
    return this.repo.save(row);
  }

  private async filterByAccess(
    tenantId: number,
    rows: AiAssistFeedback[],
    user: AuthUser,
    access?: ResolvedAccess,
  ) {
    const scope = scopeCommunityIds(access);
    if (!scope) return rows;
    if (!scope.length || !rows.length) return [];
    const workOrderIds = [
      ...new Set(rows.map((row) => row.workOrderId).filter((id): id is number => !!id)),
    ];
    const workOrders = workOrderIds.length
      ? await this.workOrderRepo.find({
          where: { tenantId, id: In(workOrderIds) },
          select: ['id', 'communityId'],
        })
      : [];
    const visibleIds = new Set(
      workOrders
        .filter((workOrder) => scope.includes(workOrder.communityId))
        .map((workOrder) => workOrder.id),
    );
    return rows.filter((row) =>
      row.workOrderId ? visibleIds.has(row.workOrderId) : row.createdBy === user.id,
    );
  }

  private async assertVisible(
    tenantId: number,
    row: AiAssistFeedback,
    user: AuthUser,
    access?: ResolvedAccess,
  ) {
    if (!(await this.filterByAccess(tenantId, [row], user, access)).length) {
      throw new NotFoundException('AI 纠错记录不存在');
    }
  }

  private async findOne(tenantId: number, id: number) {
    const row = await this.repo.findOne({ where: { tenantId, id } });
    if (!row) throw new NotFoundException('AI 纠错记录不存在');
    return row;
  }
}

export function diffFields(
  draft: Record<string, unknown>,
  finalValue: Record<string, unknown>,
): Record<string, { before: unknown; after: unknown }> {
  const out: Record<string, { before: unknown; after: unknown }> = {};
  for (const key of Object.keys(draft)) {
    if (!(key in finalValue)) continue;
    if (stable(draft[key]) !== stable(finalValue[key])) {
      out[key] = { before: draft[key] ?? null, after: finalValue[key] ?? null };
    }
  }
  return out;
}

function stable(value: unknown): string {
  if (typeof value === 'string') return value.trim().replace(/[，,；;。\s]+/g, '');
  if (Array.isArray(value)) return JSON.stringify(value.map(stable).sort());
  return JSON.stringify(value ?? null);
}

function sampleExpected(kind: string, value: Record<string, unknown>) {
  const keys =
    kind === 'completion'
      ? ['actionNote', 'faultLocation', 'faultSymptom', 'materials']
      : ['addressText', 'description', 'contactName', 'phone', 'urgent', 'publicArea', 'repairType'];
  return Object.fromEntries(keys.filter((key) => key in value).map((key) => [key, value[key]]));
}

function sanitizeFields(kind: 'repair' | 'completion', input: Record<string, unknown>) {
  const keys = kind === 'completion'
    ? ['actionNote', 'faultLocation', 'faultSymptom', 'materials', 'feeRuleCode', 'feeCents']
    : ['addressText', 'description', 'contactName', 'phone', 'urgent', 'publicArea', 'repairType'];
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (!(key in (input || {}))) continue;
    const value = input[key];
    if (value === null) out[key] = null;
    else if (typeof value === 'string') out[key] = value.trim().slice(0, 1000);
    else if (typeof value === 'boolean') out[key] = value;
    else if (key === 'feeCents' && typeof value === 'number' && Number.isFinite(value)) {
      out[key] = Math.max(0, Math.round(value));
    }
    else if (Array.isArray(value)) {
      out[key] = value.slice(0, 10).map((item) => String(item).trim().slice(0, 120)).filter(Boolean);
    }
  }
  return out;
}
