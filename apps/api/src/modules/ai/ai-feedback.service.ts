import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AiAssistFeedback } from '../../entities';
import { ExtractSamplesService } from './extract-samples.service';

export interface AiFeedbackInput {
  kind: 'repair' | 'completion';
  workOrderId?: number | null;
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

  list(tenantId: number, kind?: string, status?: string) {
    return this.repo.find({
      where: {
        tenantId,
        ...(kind === 'repair' || kind === 'completion' ? { kind } : {}),
        ...(status === 'pending' || status === 'confirmed' || status === 'promoted' || status === 'ignored'
          ? { status }
          : {}),
      },
      order: { updatedAt: 'DESC' },
      take: 100,
    });
  }

  async promote(tenantId: number, userId: number, id: number) {
    const row = await this.findOne(tenantId, id);
    if (row.status !== 'pending') throw new BadRequestException('只有待审核的纠错可以收为样例');
    if (Object.keys(row.fieldDiff).every((key) => key === 'feeRuleCode' || key === 'feeCents')) {
      throw new BadRequestException('这次只修改了收费，请调整维修收费规则后忽略本条');
    }
    await this.samples.create(tenantId, userId, {
      kind: row.kind,
      text: row.sourceText,
      expected: sampleExpected(row.kind, row.finalValue),
      note: `由工单 #${row.workOrderId ?? '-'} 的人工纠错审核收录`,
    });
    row.status = 'promoted';
    row.updatedBy = userId;
    await this.repo.save(row);
    return row;
  }

  async ignore(tenantId: number, userId: number, id: number) {
    const row = await this.findOne(tenantId, id);
    row.status = 'ignored';
    row.updatedBy = userId;
    return this.repo.save(row);
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
