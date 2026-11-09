import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { AuthUser } from '../../common/current-user.decorator';
import { Community } from '../../entities';
import { ResolvedAccess } from '../access/access.service';
import { scopeCommunityIds } from '../access/scope.util';
import {
  BuildingLedgerQueryDto,
  OwnerLedgerQueryDto,
  PropertySummaryQueryDto,
} from './dto';
import { escapeLikePattern, ledgerAddress, naturalCompare, roundArea } from './ledger.util';
import {
  filterRequestedOffices,
  resolveStatisticsOffices,
  STATISTICS_NATURE_OPTIONS,
  STATISTICS_OFFICE_NAMES,
  statisticsNatureName,
  type StatisticsOffice,
} from './statistics.util';

const MIRROR_UNAVAILABLE_MESSAGE =
  'MIS 镜像尚未同步或没有房产/住户数据，请管理员先执行镜像重灌后再查看台账报表';

interface LedgerMirrorState {
  buildingCount: number;
  roomCount: number;
  ownerCount: number;
  dataAsOf: string | null;
}

const LIKE_ESCAPE_SQL = `ESCAPE '\\'`;

/**
 * P3-A 基础台账报表：房产汇总 / 住户台账 / 楼房台账。
 *
 * 数据只来自已镜像的 mis_mirror_building / room / owner（不访问 MIS、不写库）。
 * 面积 numeric 保留 2 位小数；金额字段不涉及。未镜像时 available:false + message，不伪造 0。
 * 台账行数不大（楼 207 / 房 2,346 / 业主 2,080），筛选后在内存自然排序 + 分页，totals 不受分页影响。
 */
@Injectable()
export class LedgerStatisticsService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(Community) private readonly communityRepo: Repository<Community>,
  ) {}

  /** GET /statistics/property-summary：按管理处汇总楼栋/房屋/业主/面积/各性质房屋数。 */
  async propertySummary(query: PropertySummaryQueryDto, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    const selected = await this.selectedOffices(tenantId, access, query.officeCodes);
    const filters = { officeCodes: selected.map((office) => office.officeCode) };
    const state = await this.ledgerMirrorState(tenantId);
    const base = { filters, dataAsOf: state.dataAsOf };
    if (state.buildingCount === 0 && state.roomCount === 0 && state.ownerCount === 0) {
      return {
        ...base, rows: [], total: null, natures: STATISTICS_NATURE_OPTIONS,
        available: false, message: MIRROR_UNAVAILABLE_MESSAGE,
      };
    }
    if (!selected.length) {
      return {
        ...base, rows: [],
        total: { buildingCount: 0, roomCount: 0, ownerCount: 0, totalAreaSqm: 0 },
        natures: STATISTICS_NATURE_OPTIONS, available: true, message: null,
      };
    }
    const officeCodeParams = selected.map((office) => office.officeCode);
    const [buildingRows, roomRows, ownerRows, natureRows] = await Promise.all([
      this.dataSource.query(
        `SELECT office_code AS "officeCode", COUNT(*)::int AS "buildingCount"
           FROM mis_mirror_building GROUP BY office_code`,
      ),
      this.dataSource.query(
        `SELECT b.office_code AS "officeCode", COUNT(r.s_id)::int AS "roomCount",
                COALESCE(SUM(r.area_sqm),0)::float8 AS "totalAreaSqm"
           FROM mis_mirror_building b
           LEFT JOIN mis_mirror_room r ON r.l_id = b.l_id
          GROUP BY b.office_code`,
      ),
      this.dataSource.query(
        `SELECT b.office_code AS "officeCode", COUNT(o.zh_id)::int AS "ownerCount"
           FROM mis_mirror_owner o
           LEFT JOIN mis_mirror_room r ON r.s_id = o.s_id
           LEFT JOIN mis_mirror_building b ON b.l_id = r.l_id
          WHERE b.office_code IS NOT NULL
          GROUP BY b.office_code`,
      ),
      this.dataSource.query(
        `SELECT b.office_code AS "officeCode",
                COALESCE(NULLIF(TRIM(r.nature),''),'unknown') AS "nature",
                COUNT(*)::int AS "roomCount"
           FROM mis_mirror_room r
           INNER JOIN mis_mirror_building b ON b.l_id = r.l_id
          GROUP BY b.office_code, COALESCE(NULLIF(TRIM(r.nature),''),'unknown')`,
      ),
    ]);
    const buildingsByOffice = new Map<string, number>(buildingRows.map((row: any) => [String(row.officeCode), Number(row.buildingCount)] as [string, number]));
    const roomsByOffice = new Map<string, any>(roomRows.map((row: any) => [String(row.officeCode), row] as [string, any]));
    const ownersByOffice = new Map<string, number>(ownerRows.map((row: any) => [String(row.officeCode), Number(row.ownerCount)] as [string, number]));
    const natureByOffice = new Map<string, Record<string, number>>();
    for (const row of natureRows) {
      const officeCode = String(row.officeCode);
      const bucket = natureByOffice.get(officeCode) ?? {};
      bucket[String(row.nature)] = Number(row.roomCount);
      natureByOffice.set(officeCode, bucket);
    }
    const rows = selected.map((office) => {
      const roomRow = roomsByOffice.get(office.officeCode);
      const natureCounts: Record<string, number> = {};
      for (const nature of STATISTICS_NATURE_OPTIONS) {
        const count = natureByOffice.get(office.officeCode)?.[nature.code] ?? 0;
        if (count > 0) natureCounts[nature.code] = count;
      }
      return {
        officeCode: office.officeCode,
        officeName: office.officeName,
        buildingCount: buildingsByOffice.get(office.officeCode) ?? 0,
        roomCount: roomRow?.roomCount == null ? 0 : Number(roomRow.roomCount),
        ownerCount: ownersByOffice.get(office.officeCode) ?? 0,
        totalAreaSqm: roundArea(Number(roomRow?.totalAreaSqm ?? 0)),
        natureCounts,
      };
    });
    const total = {
      buildingCount: rows.reduce((sum, row) => sum + row.buildingCount, 0),
      roomCount: rows.reduce((sum, row) => sum + row.roomCount, 0),
      ownerCount: rows.reduce((sum, row) => sum + row.ownerCount, 0),
      totalAreaSqm: roundArea(rows.reduce((sum, row) => sum + row.totalAreaSqm, 0)),
    };
    return { ...base, rows, total, natures: STATISTICS_NATURE_OPTIONS, available: true, message: null };
  }

  /** GET /statistics/owner-ledger：一行=一条业主记录 × 其房 × 楼。 */
  async ownerLedger(query: OwnerLedgerQueryDto, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    const limit = query.limit ?? 200;
    const offset = query.offset ?? 0;
    const selected = await this.selectedOffices(tenantId, access, query.officeCodes);
    const scope = scopeCommunityIds(access);
    const filters = {
      officeCodes: selected.map((office) => office.officeCode),
      natures: query.natures ?? null,
      keyword: query.keyword ?? null,
      limit,
      offset,
    };
    const state = await this.ledgerMirrorState(tenantId);
    const base = { filters, limit, offset, dataAsOf: state.dataAsOf };
    if (state.buildingCount === 0 && state.roomCount === 0 && state.ownerCount === 0) {
      return {
        ...base, rows: [], count: null, totals: null,
        available: false, message: MIRROR_UNAVAILABLE_MESSAGE,
      };
    }
    if (!selected.length) {
      return {
        ...base, rows: [], count: 0,
        totals: { rows: 0, roomCount: 0, totalAreaSqm: 0 },
        available: true, message: null,
      };
    }
    const params: unknown[] = [];
    const add = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    const where: string[] = [];
    const includeUnmatched = scope === null && !query.officeCodes?.length;
    const officeCodesSql = selected.map((office) => add(office.officeCode)).join(',');
    where.push(includeUnmatched
      ? `(b.office_code IN (${officeCodesSql}) OR b.office_code IS NULL)`
      : `b.office_code IN (${officeCodesSql})`);
    if (query.natures?.length) where.push(`TRIM(r.nature) IN (${query.natures.map(add).join(',')})`);
    if (query.keyword) {
      const pattern = `%${escapeLikePattern(query.keyword.trim())}%`;
      const keywordParam = add(pattern);
      where.push(`(
        CONCAT(COALESCE(b.road,''), CASE WHEN COALESCE(b.lane,'') <> '' THEN CONCAT(b.lane,'弄') ELSE '' END,
               CASE WHEN COALESCE(b.building_no,'') <> '' THEN CONCAT(b.building_no,'号') ELSE '' END,
               COALESCE(r.room_no,'')) ILIKE ${keywordParam} ${LIKE_ESCAPE_SQL}
        OR COALESCE(r.room_no,'') ILIKE ${keywordParam} ${LIKE_ESCAPE_SQL}
        OR COALESCE(o.name,'') ILIKE ${keywordParam} ${LIKE_ESCAPE_SQL}
        OR COALESCE(o.mobile,'') ILIKE ${keywordParam} ${LIKE_ESCAPE_SQL}
        OR COALESCE(o.phone2,'') ILIKE ${keywordParam} ${LIKE_ESCAPE_SQL}
      )`);
    }
    const raw: any[] = await this.dataSource.query(
      `SELECT o.zh_id AS "zhId", o.s_id AS "sId", o.name AS "ownerName", o.mobile, o.phone2,
              r.room_no AS "roomNo", NULLIF(TRIM(r.nature),'') AS "natureCode", r.area_sqm::float8 AS "areaSqm",
              b.office_code AS "officeCode", b.road, b.lane, b.building_no AS "buildingNo"
         FROM mis_mirror_owner o
         LEFT JOIN mis_mirror_room r ON r.s_id = o.s_id
         LEFT JOIN mis_mirror_building b ON b.l_id = r.l_id
        WHERE ${where.join(' AND ')}`,
      params,
    );
    const all = raw.map((row) => {
      const officeCode = row.officeCode == null ? null : String(row.officeCode);
      return {
        zhId: Number(row.zhId),
        sId: row.sId == null ? null : Number(row.sId),
        officeCode,
        officeName: officeCode == null ? null : (STATISTICS_OFFICE_NAMES[officeCode] ?? `管理处${officeCode}`),
        address: ledgerAddress(row.road, row.lane, row.buildingNo, row.roomNo),
        road: row.road == null ? null : String(row.road),
        lane: row.lane == null ? null : String(row.lane),
        buildingNo: row.buildingNo == null ? null : String(row.buildingNo),
        roomNo: row.roomNo == null ? null : String(row.roomNo),
        natureCode: row.natureCode == null ? null : String(row.natureCode),
        natureName: row.natureCode == null ? null : statisticsNatureName(String(row.natureCode)),
        areaSqm: row.areaSqm == null ? null : roundArea(Number(row.areaSqm)),
        ownerName: row.ownerName == null ? null : String(row.ownerName),
        mobile: row.mobile == null ? null : String(row.mobile),
        phone2: row.phone2 == null ? null : String(row.phone2),
      };
    });
    all.sort((left, right) =>
      naturalCompare(left.officeCode, right.officeCode)
      || naturalCompare(left.buildingNo, right.buildingNo)
      || naturalCompare(left.roomNo, right.roomNo)
      || naturalCompare(left.ownerName, right.ownerName)
      || left.zhId - right.zhId);
    const roomsWithOwner = new Set<number>();
    const roomArea = new Map<number, number>();
    for (const row of all) {
      if (row.sId == null) continue;
      roomsWithOwner.add(row.sId);
      if (row.areaSqm != null) roomArea.set(row.sId, row.areaSqm);
    }
    const totals = {
      rows: all.length,
      roomCount: roomsWithOwner.size,
      totalAreaSqm: roundArea([...roomArea.values()].reduce((sum, value) => sum + value, 0)),
    };
    const rows = all.slice(offset, offset + limit).map(({ zhId, ...rest }) => ({ ...rest, zhId }));
    return { ...base, rows, count: all.length, totals, available: true, message: null };
  }

  /** GET /statistics/building-ledger：一行=一栋楼（房间数/面积/业主记录数）。 */
  async buildingLedger(query: BuildingLedgerQueryDto, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.requireTenant(user);
    const limit = query.limit ?? 200;
    const offset = query.offset ?? 0;
    const selected = await this.selectedOffices(tenantId, access, query.officeCodes);
    const filters = {
      officeCodes: selected.map((office) => office.officeCode),
      keyword: query.keyword ?? null,
      limit,
      offset,
    };
    const state = await this.ledgerMirrorState(tenantId);
    const base = { filters, limit, offset, dataAsOf: state.dataAsOf };
    if (state.buildingCount === 0 && state.roomCount === 0 && state.ownerCount === 0) {
      return {
        ...base, rows: [], count: null,
        totals: null, available: false, message: MIRROR_UNAVAILABLE_MESSAGE,
      };
    }
    if (!selected.length) {
      return {
        ...base, rows: [], count: 0,
        totals: { buildingCount: 0, roomCount: 0, totalAreaSqm: 0, ownerCount: 0 },
        available: true, message: null,
      };
    }
    const params: unknown[] = [];
    const add = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    const where: string[] = [`b.office_code IN (${selected.map((office) => add(office.officeCode)).join(',')})`];
    if (query.keyword) {
      const pattern = `%${escapeLikePattern(query.keyword.trim())}%`;
      const keywordParam = add(pattern);
      where.push(`(
        COALESCE(b.road,'') ILIKE ${keywordParam} ${LIKE_ESCAPE_SQL}
        OR COALESCE(b.lane,'') ILIKE ${keywordParam} ${LIKE_ESCAPE_SQL}
        OR COALESCE(b.building_no,'') ILIKE ${keywordParam} ${LIKE_ESCAPE_SQL}
      )`);
    }
    const raw: any[] = await this.dataSource.query(
      `SELECT b.l_id AS "lId", b.office_code AS "officeCode", b.road, b.lane, b.building_no AS "buildingNo",
              COALESCE(rc."roomCount",0)::int AS "roomCount",
              COALESCE(rc."areaSqm",0)::float8 AS "areaSqm",
              COALESCE(oc."ownerCount",0)::int AS "ownerCount"
         FROM mis_mirror_building b
         LEFT JOIN (
           SELECT l_id, COUNT(*)::int AS "roomCount", SUM(area_sqm)::float8 AS "areaSqm"
             FROM mis_mirror_room GROUP BY l_id
         ) rc ON rc.l_id = b.l_id
         LEFT JOIN (
           SELECT r.l_id, COUNT(o.zh_id)::int AS "ownerCount"
             FROM mis_mirror_owner o
             INNER JOIN mis_mirror_room r ON r.s_id = o.s_id
            GROUP BY r.l_id
         ) oc ON oc.l_id = b.l_id
        WHERE ${where.join(' AND ')}`,
      params,
    );
    const all = raw.map((row) => {
      const officeCode = String(row.officeCode);
      return {
        lId: Number(row.lId),
        officeCode,
        officeName: STATISTICS_OFFICE_NAMES[officeCode] ?? `管理处${officeCode}`,
        road: row.road == null ? null : String(row.road),
        lane: row.lane == null ? null : String(row.lane),
        buildingNo: row.buildingNo == null ? null : String(row.buildingNo),
        roomCount: Number(row.roomCount || 0),
        areaSqm: roundArea(Number(row.areaSqm || 0)),
        ownerCount: Number(row.ownerCount || 0),
      };
    });
    all.sort((left, right) =>
      naturalCompare(left.officeCode, right.officeCode)
      || naturalCompare(left.lane, right.lane)
      || naturalCompare(left.buildingNo, right.buildingNo)
      || left.lId - right.lId);
    const totals = {
      buildingCount: all.length,
      roomCount: all.reduce((sum, row) => sum + row.roomCount, 0),
      totalAreaSqm: roundArea(all.reduce((sum, row) => sum + row.areaSqm, 0)),
      ownerCount: all.reduce((sum, row) => sum + row.ownerCount, 0),
    };
    const rows = all.slice(offset, offset + limit);
    return { ...base, rows, count: all.length, totals, available: true, message: null };
  }

  private requireTenant(user: AuthUser): number {
    if (!user.tenantId) throw new ForbiddenException('tenant scope is required');
    return user.tenantId;
  }

  private async loadCommunities(tenantId: number): Promise<Array<{ id: number; name: string }>> {
    const rows = await this.communityRepo.find({ where: { tenantId } }).catch(() => []);
    return rows.map((community) => ({ id: community.id, name: community.name }));
  }

  private async selectedOffices(
    tenantId: number,
    access: ResolvedAccess | undefined,
    requested?: string[],
  ): Promise<StatisticsOffice[]> {
    const communities = await this.loadCommunities(tenantId);
    return filterRequestedOffices(resolveStatisticsOffices(communities, scopeCommunityIds(access)), requested);
  }

  /** 房产/住户镜像水位：楼/房/业主行数 + 最近同步时间。 */
  private async ledgerMirrorState(tenantId: number): Promise<LedgerMirrorState> {
    const rows: any[] = await this.dataSource
      .query(
        `SELECT
           (SELECT COUNT(*)::int FROM mis_mirror_building) AS "buildingCount",
           (SELECT COUNT(*)::int FROM mis_mirror_room) AS "roomCount",
           (SELECT COUNT(*)::int FROM mis_mirror_owner) AS "ownerCount",
           (SELECT last_success_at FROM mis_sync_state WHERE tenant_id = $1 AND source_table = 'bill' LIMIT 1) AS "lastSuccessAt",
           (SELECT MAX(synced_at) FROM mis_mirror_building) AS "maxSyncedAt"`,
        [tenantId],
      )
      .catch(() => []);
    const row = rows[0] ?? {};
    const syncedAt = row.lastSuccessAt ?? row.maxSyncedAt ?? null;
    return {
      buildingCount: Number(row.buildingCount ?? 0),
      roomCount: Number(row.roomCount ?? 0),
      ownerCount: Number(row.ownerCount ?? 0),
      dataAsOf: syncedAt ? new Date(syncedAt).toISOString() : null,
    };
  }
}
