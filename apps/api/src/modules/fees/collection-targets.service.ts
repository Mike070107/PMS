import { BadRequestException, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CollectionTargetRow, normalizeMonthCents, targetWarnings } from './collection-targets.util';
import { UpsertCollectionTargetDto } from './collection-targets.dto';

@Injectable()
export class CollectionTargetsService {
  constructor(private readonly dataSource: DataSource) {}

  async list(tenantId: number, year: number): Promise<CollectionTargetRow[]> {
    const rows: any[] = await this.dataSource.query(
      `SELECT t.community_id AS "communityId",c.name AS "communityName",t.year,t.annual_cents AS "annualCents",t.month_cents AS "monthCents"
         FROM collection_targets t JOIN communities c ON c.id=t.community_id
        WHERE t.tenant_id=$1 AND t.year=$2 ORDER BY c.name,t.community_id`,
      [tenantId, year],
    );
    return rows.map((row) => ({
      communityId: Number(row.communityId), communityName: String(row.communityName || ''), year: Number(row.year),
      annualCents: Number(row.annualCents || 0), monthCents: normalizeMonthCents(row.monthCents),
    }));
  }

  async upsert(tenantId: number, userId: number, dto: UpsertCollectionTargetDto) {
    const community: any[] = await this.dataSource.query(`SELECT id,name FROM communities WHERE id=$1 AND tenant_id=$2 AND enabled=true LIMIT 1`, [dto.communityId, tenantId]);
    if (!community.length) throw new BadRequestException('小区不存在或已停用');
    const monthCents = normalizeMonthCents(dto.monthCents);
    const saved: any[] = await this.dataSource.query(
      `INSERT INTO collection_targets(tenant_id,community_id,year,annual_cents,month_cents,created_by,updated_by,updated_at)
       VALUES($1,$2,$3,$4,$5::jsonb,$6,$6,now())
       ON CONFLICT (tenant_id,community_id,year) DO UPDATE SET
         annual_cents=EXCLUDED.annual_cents,month_cents=EXCLUDED.month_cents,updated_by=EXCLUDED.updated_by,updated_at=now()
       RETURNING community_id AS "communityId",year,annual_cents AS "annualCents",month_cents AS "monthCents"`,
      [tenantId, dto.communityId, dto.year, dto.annualCents, JSON.stringify(monthCents), userId],
    );
    return {
      communityId: Number(saved[0]?.communityId || dto.communityId), communityName: community[0].name, year: dto.year,
      annualCents: Number(saved[0]?.annualCents || dto.annualCents), monthCents: normalizeMonthCents(saved[0]?.monthCents),
      warnings: targetWarnings(dto.annualCents, monthCents),
    };
  }

  async remove(tenantId: number, communityId: number, year: number) {
    const result: any[] = await this.dataSource.query(
      `DELETE FROM collection_targets WHERE tenant_id=$1 AND community_id=$2 AND year=$3 RETURNING id`,
      [tenantId, communityId, year],
    );
    return { deleted: result.length };
  }
}
