export type CollectionTargetRow = {
  communityId: number;
  communityName: string;
  year: number;
  annualCents: number;
  monthCents: (number | null)[];
};

export type CollectionTargetInput = {
  communityId: number;
  year: number;
  annualCents: number;
  monthCents?: (number | null)[];
};

export type TargetDataSource = { query(sql: string, params?: unknown[]): Promise<any[]> };

/** 月度数组统一补足 12 项；未填保持 null。 */
export function normalizeMonthCents(value: unknown): (number | null)[] {
  const source = Array.isArray(value) ? value : [];
  const result: (number | null)[] = [];
  for (let i = 0; i < 12; i += 1) {
    const n = source[i];
    result.push(n === null || n === undefined ? null : Number(n));
  }
  return result;
}

export function targetWarnings(annualCents: number, monthCents: (number | null)[]): string[] {
  const sum = monthCents.reduce<number>((total, value) => total + (value ?? 0), 0);
  if (sum === annualCents) return [];
  const text = (value: number) => value.toLocaleString('zh-CN');
  return [`月度合计 ${text(sum)} 与年度指标 ${text(annualCents)} 不一致`];
}

/** 供 MIS 直连/镜像大屏共用：只读目标表，不碰 MIS。 */
export async function loadCollectionTargets(ds: TargetDataSource, tenantId: number, communityIds: number[], year: number): Promise<CollectionTargetRow[]> {
  if (!communityIds.length) return [];
  const rows: any[] = await ds.query(
    `SELECT t.community_id AS "communityId",c.name AS "communityName",t.year,t.annual_cents AS "annualCents",t.month_cents AS "monthCents"
       FROM collection_targets t JOIN communities c ON c.id=t.community_id
      WHERE t.tenant_id=$1 AND t.year=$2 AND t.community_id = ANY($3::int[])`,
    [tenantId, year, communityIds],
  );
  return rows.map((row) => ({
    communityId: Number(row.communityId), communityName: String(row.communityName || ''),
    year: Number(row.year), annualCents: Number(row.annualCents || 0), monthCents: normalizeMonthCents(row.monthCents),
  }));
}
