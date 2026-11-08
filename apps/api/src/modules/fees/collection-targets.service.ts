import { BadRequestException, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CollectionTargetRow, normalizeCommunityIds, normalizeMonthCents, targetWarnings } from './collection-targets.util';
import { UpsertCollectionTargetDto } from './collection-targets.dto';

@Injectable()
export class CollectionTargetsService {
  constructor(private readonly dataSource: DataSource) {}

  private async names(ids: number[]): Promise<string[]> {
    if (!ids.length) return [];
    const rows: any[] = await this.dataSource.query(`SELECT id,name FROM communities WHERE id = ANY($1::int[])`, [ids]);
    const byId = new Map(rows.map((row) => [Number(row.id), String(row.name || '')]));
    return ids.map((id) => byId.get(id) || String(id));
  }

  async list(tenantId: number, year: number) {
    const rows: any[] = await this.dataSource.query(
      `SELECT t.id,t.community_ids AS "communityIds",t.year,t.annual_cents AS "annualCents",t.month_cents AS "monthCents"
         FROM collection_targets t WHERE t.tenant_id=$1 AND t.year=$2 ORDER BY t.id`,
      [tenantId, year],
    );
    const allIds = [...new Set(rows.flatMap((row) => normalizeCommunityIds(row.communityIds)))];
    const names = await this.names(allIds);
    const nameMap = new Map(allIds.map((id, index) => [id, names[index]]));
    return rows.map((row) => {
      const communityIds = normalizeCommunityIds(row.communityIds);
      return {
        id: Number(row.id), communityIds, communityNames: communityIds.map((id) => nameMap.get(id) || String(id)),
        year: Number(row.year), annualCents: Number(row.annualCents || 0), monthCents: normalizeMonthCents(row.monthCents),
      };
    });
  }

  async upsert(tenantId: number, userId: number, dto: UpsertCollectionTargetDto) {
    const communityIds = normalizeCommunityIds(dto.communityIds);
    if (!communityIds.length) throw new BadRequestException('请至少选择一个小区的指标组');
    const communities: any[] = await this.dataSource.query(
      `SELECT id,name FROM communities WHERE id = ANY($1::int[]) AND tenant_id=$2 AND enabled=true`,
      [communityIds, tenantId],
    );
    if (communities.length !== communityIds.length) throw new BadRequestException('指标组包含不存在或已停用的小区');
    const existing: any[] = await this.dataSource.query(
      `SELECT id,community_ids AS "communityIds" FROM collection_targets WHERE tenant_id=$1 AND year=$2`,
      [tenantId, dto.year],
    );
    const wanted = new Set(communityIds);
    let targetId: number | null = null;
    for (const row of existing) {
      const ids = normalizeCommunityIds(row.communityIds);
      const overlap = ids.filter((id) => wanted.has(id));
      if (overlap.length === ids.length && ids.length === communityIds.length) targetId = Number(row.id);
      else if (overlap.length) throw new BadRequestException(`小区组与已有指标重叠：${overlap.join(',')}`);
    }
    const monthCents = normalizeMonthCents(dto.monthCents);
    const saved: any[] = targetId
      ? await this.dataSource.query(
        `UPDATE collection_targets SET annual_cents=$1,month_cents=$2::jsonb,community_ids=$3::int[],updated_by=$4,updated_at=now() WHERE id=$5 RETURNING id,community_ids AS "communityIds",year,annual_cents AS "annualCents",month_cents AS "monthCents"`,
        [dto.annualCents, JSON.stringify(monthCents), communityIds, userId, targetId],
      )
      : await this.dataSource.query(
        `INSERT INTO collection_targets(tenant_id,community_id,community_ids,year,annual_cents,month_cents,created_by,updated_by,updated_at)
         VALUES($1,$2,$3::int[],$4,$5,$6::jsonb,$7,$7,now())
         RETURNING id,community_ids AS "communityIds",year,annual_cents AS "annualCents",month_cents AS "monthCents"`,
        [tenantId, communityIds[0], communityIds, dto.year, dto.annualCents, JSON.stringify(monthCents), userId],
      );
    const savedRow = saved[0];
    const savedIds = normalizeCommunityIds(savedRow?.communityIds);
    return {
      id: Number(savedRow?.id), communityIds: savedIds, communityNames: await this.names(savedIds),
      year: dto.year, annualCents: Number(savedRow?.annualCents || dto.annualCents), monthCents: normalizeMonthCents(savedRow?.monthCents),
      warnings: targetWarnings(dto.annualCents, monthCents),
    };
  }

  async remove(tenantId: number, id: number) {
    const result: any[] = await this.dataSource.query(`DELETE FROM collection_targets WHERE tenant_id=$1 AND id=$2 RETURNING id`, [tenantId, id]);
    return { deleted: result.length };
  }

  async clearYear(tenantId: number, year: number) {
    const result: any[] = await this.dataSource.query(`DELETE FROM collection_targets WHERE tenant_id=$1 AND year=$2 RETURNING id`, [tenantId, year]);
    return { deleted: result.length };
  }
}
