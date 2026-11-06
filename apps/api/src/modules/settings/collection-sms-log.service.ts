import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MisCollectionSms } from '../../entities/mis-collection-sms.entity';

export interface SmsLogRow {
  houseKey: string;
  phoneTail: string;
  content: string;
  segmentCount: number;
  status: 'queued' | 'submitted' | 'delivered' | 'failed';
  bizId?: string | null;
  error?: string | null;
}

/**
 * 催缴短信发送记录与回执。
 *
 * 只做记账，不发短信：发送由调用方（批次接口）完成，这里保证
 * 「谁发了、发到哪个尾号、运营商回执是什么」可追溯。
 */
@Injectable()
export class CollectionSmsLogService {
  constructor(
    @InjectRepository(MisCollectionSms)
    private readonly repo: Repository<MisCollectionSms>,
  ) {}

  /** 一次发送后批量落库；返回写入条数 */
  async record(tenantId: number, batchId: number, rows: SmsLogRow[], operatorId?: number): Promise<number> {
    if (!rows.length) return 0;
    const entities = rows.map((row) =>
      this.repo.create({
        tenantId,
        batchId,
        houseKey: row.houseKey,
        phoneTail: row.phoneTail,
        content: row.content,
        status: row.status,
        bizId: row.bizId ?? null,
        error: row.error ?? null,
        segmentCount: row.segmentCount,
        submittedAt: row.status === 'queued' ? null : new Date(),
        deliveredAt: null,
        createdBy: operatorId ?? null,
        updatedBy: operatorId ?? null,
      }),
    );
    await this.repo.save(entities);
    return entities.length;
  }

  async byBatch(tenantId: number, batchId: number) {
    return this.repo.find({ where: { tenantId, batchId }, order: { id: 'ASC' } });
  }

  /**
   * 运营商回执：按 BizId 定位，推进状态。
   * 找不到就返回 false，让回调方知道这条没落库（可重试）。
   */
  async handleReceipt(payload: {
    bizId: string;
    status: 'delivered' | 'failed' | 'undelivered';
    error?: string;
  }): Promise<{ ok: boolean; status?: string }> {
    const row = await this.repo.findOne({ where: { bizId: payload.bizId } });
    if (!row) return { ok: false };

    const status = payload.status === 'delivered' ? 'delivered' : 'failed';
    await this.repo.update(
      { id: row.id },
      {
        status,
        deliveredAt: status === 'delivered' ? new Date() : row.deliveredAt,
        error: status === 'failed' ? (payload.error ?? '回执失败').slice(0, 180) : row.error,
      },
    );
    return { ok: true, status };
  }

  /** 批次发送统计：提交/送达/失败/计费条数 */
  async stats(tenantId: number, batchId: number) {
    const rows = await this.byBatch(tenantId, batchId);
    return {
      total: rows.length,
      submitted: rows.filter((r) => r.status === 'submitted').length,
      delivered: rows.filter((r) => r.status === 'delivered').length,
      failed: rows.filter((r) => r.status === 'failed').length,
      segments: rows.reduce((sum, r) => sum + r.segmentCount, 0),
    };
  }
}
