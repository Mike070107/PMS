import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import { AuthUser } from '../../common/current-user.decorator';
import { DictType, UserRole, WorkOrderStatus } from '../../common/enums';
import {
  Community,
  DictItem,
  Material,
  ManagementOffice,
  RepairTypeRule,
  StaffProfile,
  User,
  Warehouse,
} from '../../entities';
import { AccessService, ResolvedAccess } from '../access/access.service';
import { scopeCommunityIds } from '../access/scope.util';
import { resolveRepairTypeLabel } from '../repairs/repair-type-labels';
import { isSafetyStockWarning, resolveStockValue, resolveUnitCost } from '../inventory/stock-ledger';
import {
  MaterialUsageGroupBy,
  MaterialUsageReportDto,
  ReportOptionsDto,
  ReportRangeDto,
  StaffReportDto,
  StockReportDto,
  WorkOrderGroupBy,
  WorkOrderReportDto,
} from './dto';

/**
 * 报表查询。全部按 SQL 聚合出结果，不把整表拉到内存再算：
 * 工单几千上万条时，逐条 find 再 reduce 会把接口拖到几秒。
 *
 * 口径（页面上的说明文字和这里保持一致，改一处要改两处）：
 * - 工单统计 / 人员统计：按**工单创建时间**落在区间内的工单算。
 *   「完成」= 已完成（业主验收或自动验收），「待验收」单独列；
 *   「超时」= 有截止时刻、未撤单，且完成时刻（未完成的按现在）晚于截止。
 *   平均完成时长 = 完工时刻 − 创建时刻，只算已完工的单。
 *   材料成本 = 该单从库存领用材料的 FIFO 成本合计（work_order_materials），
 *   维修工手填、没走库存的材料没有成本，不计入。
 * - 库存清单：按仓 × 材料一行；单位成本 = 该仓该材料剩余批次的加权成本，
 *   没有批次记录的老库存按 SKU 默认成本；金额 = 数量 × 单位成本。
 *   「库存预警」和「库存与采购」页同一口径：安全库存 > 0，且数量 ≤ 安全库存。
 * - 材料使用：按领料记录（完工时自动出库）统计，时间取出库时刻。
 *
 * 所有时间按 Asia/Shanghai 取整天（服务器时区是 UTC，直接 ::date 会差 8 小时）。
 */
const TZ = 'Asia/Shanghai';
const DETAIL_ROW_LIMIT = 5000;

const STATUS_LABELS: Record<string, string> = {
  [WorkOrderStatus.CREATED]: '待派单',
  [WorkOrderStatus.DISPATCHED]: '已派单',
  [WorkOrderStatus.IN_PROGRESS]: '维修中',
  [WorkOrderStatus.WAITING_MATERIAL]: '等待材料',
  [WorkOrderStatus.DONE_PENDING_REVIEW]: '待验收',
  [WorkOrderStatus.COMPLETED]: '已完成',
  [WorkOrderStatus.CANCELLED]: '已撤单',
  [WorkOrderStatus.VOIDED]: '已作废',
};

interface DateRange {
  from: string;
  to: string;
  fromTs: Date;
  toTs: Date;
}

export interface WorkOrderAggRow {
  key: string | null;
  total: number;
  completed: number;
  pendingReview: number;
  cancelled: number;
  active: number;
  overdue: number;
  avgHours: number | null;
  feeCents: number;
  materialCostCents: number;
  avgRating: number | null;
  ratingCount: number;
}

/** 参数化 SQL 的小助手：把 where 片段和 $n 参数一起攒 */
class SqlParams {
  readonly values: unknown[] = [];
  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

function num(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** 今天（上海时区）的 YYYY-MM-DD */
function todayInTz(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function shiftDate(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

@Injectable()
export class ReportsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly accessService: AccessService,
  ) {}

  // ---------------------------------------------------------------- 工单

  async workOrders(query: WorkOrderReportDto, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.resolveTenantId(user, query.tenantId);
    const range = this.resolveRange(query);
    const scope = this.scopeIds(access);
    const groupBy: WorkOrderGroupBy = query.groupBy ?? 'day';
    const empty = { range: this.rangeView(range), groupBy, summary: this.emptyAgg(), rows: [] };
    if (scope && !scope.length) return empty;
    if (query.communityId && scope && !scope.includes(query.communityId)) return empty;

    const [summaryRows, groupRows] = await Promise.all([
      this.aggregateWorkOrders(tenantId, range, scope, query, null),
      this.aggregateWorkOrders(tenantId, range, scope, query, groupBy),
    ]);
    const labels = await this.labelsFor(tenantId, groupBy, groupRows.map((r) => r.key));
    const rows = groupRows.map((r) => ({
      ...r,
      key: r.key ?? '',
      label: labels(r.key),
    }));
    if (groupBy === 'day') rows.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return {
      range: this.rangeView(range),
      groupBy,
      summary: summaryRows[0] ? this.stripKey(summaryRows[0]) : this.emptyAgg(),
      rows,
    };
  }

  private async aggregateWorkOrders(
    tenantId: number,
    range: DateRange,
    scope: number[] | null,
    query: { communityId?: number; assigneeId?: number },
    groupBy: WorkOrderGroupBy | null,
  ): Promise<WorkOrderAggRow[]> {
    const p = new SqlParams();
    const where: string[] = [
      `wo.tenant_id = ${p.add(tenantId)}`,
      `wo.deleted_at IS NULL`,
      `wo.status <> 'voided'`,
      `wo.created_at >= ${p.add(range.fromTs)}`,
      `wo.created_at < ${p.add(range.toTs)}`,
    ];
    if (query.communityId) where.push(`wo.community_id = ${p.add(query.communityId)}`);
    else if (scope) where.push(`wo.community_id = ANY(${p.add(scope)})`);
    if (query.assigneeId) where.push(`wo.assignee_id = ${p.add(query.assigneeId)}`);

    const keyExpr = this.workOrderKeyExpr(groupBy);
    const sql = `
      WITH base AS (
        SELECT wo.id, wo.status, wo.assignee_id, wo.community_id, wo.created_at, wo.completed_at,
               wo.sla_due_at, wo.fee_cents,
               COALESCE(rr.repair_type, wo.skill) AS repair_type,
               COALESCE(wm.cost_cents, 0) AS material_cost_cents,
               rv.rating
        FROM work_orders wo
        LEFT JOIN repair_requests rr ON rr.id = wo.request_id
        LEFT JOIN (
          SELECT work_order_id, SUM(total_cost_cents) AS cost_cents
          FROM work_order_materials WHERE tenant_id = $1 GROUP BY work_order_id
        ) wm ON wm.work_order_id = wo.id
        LEFT JOIN (
          SELECT work_order_id, AVG(rating) AS rating
          FROM reviews WHERE tenant_id = $1 GROUP BY work_order_id
        ) rv ON rv.work_order_id = wo.id
        WHERE ${where.join(' AND ')}
      )
      SELECT ${keyExpr} AS key,
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
        COUNT(*) FILTER (WHERE status = 'done_pending_review')::int AS pending_review,
        COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
        COUNT(*) FILTER (WHERE status IN ('created','dispatched','in_progress','waiting_material'))::int AS active,
        COUNT(*) FILTER (
          WHERE sla_due_at IS NOT NULL AND status <> 'cancelled'
            AND COALESCE(completed_at, NOW()) > sla_due_at
        )::int AS overdue,
        AVG(EXTRACT(EPOCH FROM (completed_at - created_at)) / 3600)
          FILTER (WHERE completed_at IS NOT NULL) AS avg_hours,
        COALESCE(SUM(fee_cents), 0)::bigint AS fee_cents,
        COALESCE(SUM(material_cost_cents), 0)::bigint AS material_cost_cents,
        AVG(rating) AS avg_rating,
        COUNT(rating)::int AS rating_count
      FROM base
      GROUP BY 1
      ORDER BY total DESC, 1
    `;
    const rows: Record<string, unknown>[] = await this.dataSource.query(sql, p.values);
    return rows.map((r) => ({
      key: r.key === null || r.key === undefined ? null : String(r.key),
      total: num(r.total),
      completed: num(r.completed),
      pendingReview: num(r.pending_review),
      cancelled: num(r.cancelled),
      active: num(r.active),
      overdue: num(r.overdue),
      avgHours: numOrNull(r.avg_hours),
      feeCents: num(r.fee_cents),
      materialCostCents: num(r.material_cost_cents),
      avgRating: numOrNull(r.avg_rating),
      ratingCount: num(r.rating_count),
    }));
  }

  private workOrderKeyExpr(groupBy: WorkOrderGroupBy | null): string {
    switch (groupBy) {
      case 'day':
        return `to_char(created_at AT TIME ZONE '${TZ}', 'YYYY-MM-DD')`;
      case 'assignee':
        return `assignee_id::text`;
      case 'community':
        return `community_id::text`;
      case 'repairType':
        return `repair_type`;
      case 'status':
        return `status`;
      default:
        return `'all'`;
    }
  }

  private emptyAgg(): Omit<WorkOrderAggRow, 'key'> {
    return {
      total: 0,
      completed: 0,
      pendingReview: 0,
      cancelled: 0,
      active: 0,
      overdue: 0,
      avgHours: null,
      feeCents: 0,
      materialCostCents: 0,
      avgRating: null,
      ratingCount: 0,
    };
  }

  private stripKey(row: WorkOrderAggRow): Omit<WorkOrderAggRow, 'key'> {
    const { key: _key, ...rest } = row;
    return rest;
  }

  /** 分组 key → 显示名（人名 / 小区名 / 类型中文 / 状态中文；按天直接用日期） */
  private async labelsFor(
    tenantId: number,
    groupBy: WorkOrderGroupBy | MaterialUsageGroupBy,
    keys: Array<string | null>,
  ): Promise<(key: string | null) => string> {
    const ids = keys.filter((k): k is string => !!k && /^\d+$/.test(k)).map(Number);
    switch (groupBy) {
      case 'assignee': {
        const users = ids.length
          ? await this.dataSource.getRepository(User).find({
              where: { tenantId, id: In(ids) },
              select: ['id', 'name', 'loginAccount'],
            })
          : [];
        const map = new Map(users.map((u) => [String(u.id), u.name || u.loginAccount || '未命名员工']));
        return (key) => (key ? map.get(key) ?? '未知维修工' : '未派单');
      }
      case 'community': {
        const list = ids.length
          ? await this.dataSource.getRepository(Community).find({
              where: { tenantId, id: In(ids) },
              select: ['id', 'name'],
            })
          : [];
        const map = new Map(list.map((c) => [String(c.id), c.name]));
        return (key) => (key ? map.get(key) ?? '未知小区' : '未指定小区');
      }
      case 'repairType': {
        const rules = await this.dataSource.getRepository(RepairTypeRule).find({
          where: { tenantId },
          select: ['repairType', 'label'],
        });
        const tenantLabels = new Map(rules.map((r) => [r.repairType, r.label]));
        return (key) => resolveRepairTypeLabel(key, tenantLabels);
      }
      case 'status':
        return (key) => (key ? STATUS_LABELS[key] ?? key : '-');
      case 'material': {
        const list = ids.length
          ? await this.dataSource.getRepository(Material).find({
              where: { tenantId, id: In(ids) },
              select: ['id', 'code', 'name', 'spec'],
            })
          : [];
        const map = new Map(
          list.map((m) => [String(m.id), `${m.name}${m.spec ? ` ${m.spec}` : ''}`]),
        );
        return (key) => (key ? map.get(key) ?? '未知材料' : '-');
      }
      case 'warehouse': {
        const list = ids.length
          ? await this.dataSource.getRepository(Warehouse).find({
              where: { tenantId, id: In(ids) },
              select: ['id', 'name'],
            })
          : [];
        const map = new Map(list.map((w) => [String(w.id), w.name]));
        return (key) => (key ? map.get(key) ?? '未知仓库' : '-');
      }
      default:
        return (key) => key ?? '-';
    }
  }

  // ---------------------------------------------------------------- 人员

  /**
   * 人员统计 = 工单统计按维修工分组 + 「现在手上有几单」+ 在岗/工种。
   * 能接单的人（角色勾了「工单池 · 接单」）即使区间内一单没有也列出来，
   * 经理要看的正是「谁闲着」。
   */
  async staff(query: StaffReportDto, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.resolveTenantId(user, query.tenantId);
    const range = this.resolveRange(query);
    const scope = this.scopeIds(access);
    const scopedOut = (scope && !scope.length) || (query.communityId && scope && !scope.includes(query.communityId));

    const agg = scopedOut
      ? []
      : await this.aggregateWorkOrders(tenantId, range, scope, query, 'assignee');
    const aggByUser = new Map(agg.filter((r) => r.key).map((r) => [Number(r.key), r]));

    // 区间内完工数（按完工时刻算，和「处理工单数」按创建时刻不是一个口径，页面上分开标）
    const p = new SqlParams();
    const completedWhere = [
      `wo.tenant_id = ${p.add(tenantId)}`,
      `wo.deleted_at IS NULL`,
      `wo.status <> 'voided'`,
      `wo.assignee_id IS NOT NULL`,
      `wo.completed_at >= ${p.add(range.fromTs)}`,
      `wo.completed_at < ${p.add(range.toTs)}`,
      `wo.status IN ('done_pending_review','completed')`,
    ];
    if (query.communityId) completedWhere.push(`wo.community_id = ${p.add(query.communityId)}`);
    else if (scope) completedWhere.push(`wo.community_id = ANY(${p.add(scope)})`);
    const completedRows: Array<{ assignee_id: number; n: number }> = scopedOut
      ? []
      : await this.dataSource.query(
          `SELECT wo.assignee_id, COUNT(*)::int AS n FROM work_orders wo
           WHERE ${completedWhere.join(' AND ')} GROUP BY wo.assignee_id`,
          p.values,
        );
    const completedByUser = new Map(completedRows.map((r) => [Number(r.assignee_id), num(r.n)]));

    // 现在手上的单（不看区间）
    const p2 = new SqlParams();
    const activeWhere = [
      `wo.tenant_id = ${p2.add(tenantId)}`,
      `wo.deleted_at IS NULL`,
      `wo.status <> 'voided'`,
      `wo.assignee_id IS NOT NULL`,
      `wo.status IN ('dispatched','in_progress')`,
    ];
    if (query.communityId) activeWhere.push(`wo.community_id = ${p2.add(query.communityId)}`);
    else if (scope) activeWhere.push(`wo.community_id = ANY(${p2.add(scope)})`);
    const activeRows: Array<{ assignee_id: number; n: number }> = scopedOut
      ? []
      : await this.dataSource.query(
          `SELECT wo.assignee_id, COUNT(*)::int AS n FROM work_orders wo
           WHERE ${activeWhere.join(' AND ')} GROUP BY wo.assignee_id`,
          p2.values,
        );
    const activeByUser = new Map(activeRows.map((r) => [Number(r.assignee_id), num(r.n)]));

    const technicianIds = await this.accessService.userIdsWithPermission(tenantId, 'app:pool', 'edit');
    const userIds = [
      ...new Set([...technicianIds, ...aggByUser.keys(), ...completedByUser.keys(), ...activeByUser.keys()]),
    ];
    if (!userIds.length) {
      return { range: this.rangeView(range), summary: this.emptyAgg(), rows: [] };
    }
    const [users, profiles] = await Promise.all([
      this.dataSource.getRepository(User).find({
        where: { tenantId, id: In(userIds) },
        select: ['id', 'name', 'loginAccount', 'phone', 'status'],
      }),
      this.dataSource.getRepository(StaffProfile).find({
        where: { tenantId, userId: In(userIds) },
      }),
    ]);
    const profileByUser = new Map(profiles.map((pf) => [pf.userId, pf]));
    const skillLabel = await this.skillLabelResolver(tenantId);
    const rows = users
      .map((u) => {
        const a = aggByUser.get(u.id) ?? { ...this.emptyAgg(), key: String(u.id) };
        const profile = profileByUser.get(u.id);
        return {
          userId: u.id,
          name: u.name || u.loginAccount || '未命名员工',
          phone: u.phone,
          accountStatus: u.status,
          onDuty: profile?.onDuty ?? true,
          skills: profile?.skills ?? [],
          skillLabels: (profile?.skills ?? []).map(skillLabel),
          canTakeOrders: technicianIds.includes(u.id),
          total: a.total,
          completed: a.completed,
          pendingReview: a.pendingReview,
          cancelled: a.cancelled,
          active: a.active,
          overdue: a.overdue,
          avgHours: a.avgHours,
          feeCents: a.feeCents,
          materialCostCents: a.materialCostCents,
          avgRating: a.avgRating,
          ratingCount: a.ratingCount,
          completedInRange: completedByUser.get(u.id) ?? 0,
          activeNow: activeByUser.get(u.id) ?? 0,
        };
      })
      .sort((x, y) => y.total - x.total || y.completedInRange - x.completedInRange || x.userId - y.userId);

    const summary = scopedOut
      ? this.emptyAgg()
      : (await this.aggregateWorkOrders(tenantId, range, scope, { ...query, assigneeId: undefined }, null))[0];
    return {
      range: this.rangeView(range),
      summary: summary ? this.stripKey(summary as WorkOrderAggRow) : this.emptyAgg(),
      staffCount: rows.length,
      completedInRange: [...completedByUser.values()].reduce((s, n) => s + n, 0),
      activeNow: [...activeByUser.values()].reduce((s, n) => s + n, 0),
      rows,
    };
  }

  /**
   * 工种编码 → 中文。工种编码和报修类型编码是同一套（water / electric / smart…），
   * 租户字典（dict_items type=skill）优先，其次租户报修类型配置的叫法，最后内置表。
   */
  private async skillLabelResolver(tenantId: number): Promise<(code: string) => string> {
    const [dict, rules] = await Promise.all([
      this.dataSource
        .getRepository(DictItem)
        .createQueryBuilder('d')
        .where('d.type = :type', { type: DictType.SKILL })
        .andWhere('(d.tenant_id IS NULL OR d.tenant_id = :tenantId)', { tenantId })
        .getMany(),
      this.dataSource.getRepository(RepairTypeRule).find({
        where: { tenantId },
        select: ['repairType', 'label'],
      }),
    ]);
    const tenantLabels = new Map(rules.map((r) => [r.repairType, r.label]));
    const dictLabels = new Map<string, string>();
    // 平台预置先放，租户同 code 覆盖
    for (const item of dict.filter((d) => d.tenantId === null)) dictLabels.set(item.code, item.label);
    for (const item of dict.filter((d) => d.tenantId !== null)) dictLabels.set(item.code, item.label);
    return (code) => dictLabels.get(code) || resolveRepairTypeLabel(code, tenantLabels);
  }

  // ---------------------------------------------------------------- 库存

  async stock(query: StockReportDto, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.resolveTenantId(user, query.tenantId);
    const warehouseIds = await this.scopedWarehouseIds(tenantId, access);
    const emptyResult = {
      summary: { skuCount: 0, warehouseCount: 0, lowCount: 0, totalQtyRows: 0, totalAmountCents: 0 },
      byWarehouse: [],
      rows: [],
    };
    if (warehouseIds && !warehouseIds.length) return emptyResult;
    if (query.warehouseId && warehouseIds && !warehouseIds.includes(query.warehouseId)) return emptyResult;

    const p = new SqlParams();
    const where = [`s.tenant_id = ${p.add(tenantId)}`];
    if (query.warehouseId) where.push(`s.warehouse_id = ${p.add(query.warehouseId)}`);
    else if (warehouseIds) where.push(`s.warehouse_id = ANY(${p.add(warehouseIds)})`);
    if (query.category) where.push(`m.category = ${p.add(query.category)}`);
    if (query.q?.trim()) {
      const kw = p.add(`%${query.q.trim()}%`);
      where.push(`(m.name ILIKE ${kw} OR m.code ILIKE ${kw} OR COALESCE(m.spec, '') ILIKE ${kw})`);
    }
    const sql = `
      SELECT s.id, s.warehouse_id, s.material_id, s.qty, s.safety_qty,
             m.code, m.name, m.spec, m.category, m.unit, m.default_cost_cents, m.enabled,
             w.name AS warehouse_name, w.type AS warehouse_type, w.office_id, w.community_id,
             l.remaining_qty AS lot_qty, l.lot_value_cents
      FROM stocks s
      JOIN materials m ON m.id = s.material_id
      JOIN warehouses w ON w.id = s.warehouse_id
      LEFT JOIN (
        SELECT warehouse_id, material_id,
               SUM(remaining_qty) AS remaining_qty,
               SUM(remaining_qty * unit_cost_cents) AS lot_value_cents
        FROM stock_lots WHERE tenant_id = $1 AND remaining_qty > 0
        GROUP BY warehouse_id, material_id
      ) l ON l.warehouse_id = s.warehouse_id AND l.material_id = s.material_id
      WHERE ${where.join(' AND ')}
      ORDER BY w.id, m.category NULLS LAST, m.code
    `;
    const raw: Record<string, unknown>[] = await this.dataSource.query(sql, p.values);
    let rows = raw.map((r) => {
      const qty = num(r.qty);
      const safetyQty = num(r.safety_qty);
      const lotQty = num(r.lot_qty);
      const unitCostCents = resolveUnitCost(lotQty, num(r.lot_value_cents), num(r.default_cost_cents));
      return {
        stockId: num(r.id),
        warehouseId: num(r.warehouse_id),
        warehouseName: String(r.warehouse_name ?? ''),
        warehouseType: String(r.warehouse_type ?? ''),
        officeId: numOrNull(r.office_id),
        materialId: num(r.material_id),
        code: String(r.code ?? ''),
        name: String(r.name ?? ''),
        spec: (r.spec as string | null) ?? null,
        category: (r.category as string | null) ?? null,
        unit: String(r.unit ?? ''),
        enabled: r.enabled !== false,
        qty,
        safetyQty,
        low: isSafetyStockWarning(qty, safetyQty),
        unitCostCents,
        /** 成本来源：lot = 批次加权；default = SKU 默认成本（老库存没批次） */
        costSource: lotQty > 0 ? 'lot' : 'default',
        // 金额从批次原值加总；均价只做展示（round 后乘回会差几分钱，客户对不上账）
        amountCents: resolveStockValue(qty, lotQty, num(r.lot_value_cents), num(r.default_cost_cents)),
      };
    });
    if (query.onlyLow === '1') rows = rows.filter((r) => r.low);

    const byWarehouseMap = new Map<number, { warehouseId: number; warehouseName: string; skuCount: number; lowCount: number; amountCents: number }>();
    for (const r of rows) {
      const cur = byWarehouseMap.get(r.warehouseId) ?? {
        warehouseId: r.warehouseId,
        warehouseName: r.warehouseName,
        skuCount: 0,
        lowCount: 0,
        amountCents: 0,
      };
      cur.skuCount += 1;
      if (r.low) cur.lowCount += 1;
      cur.amountCents += r.amountCents;
      byWarehouseMap.set(r.warehouseId, cur);
    }
    return {
      summary: {
        skuCount: rows.length,
        warehouseCount: byWarehouseMap.size,
        lowCount: rows.filter((r) => r.low).length,
        totalQtyRows: rows.filter((r) => r.qty > 0).length,
        totalAmountCents: rows.reduce((s, r) => s + r.amountCents, 0),
      },
      byWarehouse: [...byWarehouseMap.values()].sort((a, b) => b.amountCents - a.amountCents),
      rows,
    };
  }

  /**
   * 受限角色能看的仓：小区在范围内的小区仓 + 范围内小区所属管理处的管理处仓。
   * 全公司范围返回 null（不过滤）。和员工端「scope=mine」按角色范围对应管理处是同一个思路。
   */
  private async scopedWarehouseIds(tenantId: number, access?: ResolvedAccess): Promise<number[] | null> {
    const scope = this.scopeIds(access);
    if (!scope) return null;
    if (!scope.length) return [];
    const communities = await this.dataSource.getRepository(Community).find({
      where: { tenantId, id: In(scope) },
      select: ['id', 'officeId', 'parentId'],
    });
    const parentIds = communities.filter((c) => !c.officeId && c.parentId).map((c) => c.parentId as number);
    const parents = parentIds.length
      ? await this.dataSource.getRepository(Community).find({
          where: { tenantId, id: In(parentIds) },
          select: ['id', 'officeId'],
        })
      : [];
    const officeIds = new Set<number>();
    for (const c of communities) {
      const oid = c.officeId ?? parents.find((pp) => pp.id === c.parentId)?.officeId ?? null;
      if (oid) officeIds.add(oid);
    }
    const warehouses = await this.dataSource.getRepository(Warehouse).find({
      where: { tenantId },
      select: ['id', 'communityId', 'officeId'],
    });
    return warehouses
      .filter(
        (w) =>
          (w.communityId && scope.includes(w.communityId)) || (w.officeId && officeIds.has(w.officeId)),
      )
      .map((w) => w.id);
  }

  // ---------------------------------------------------------------- 材料使用

  async materialUsage(query: MaterialUsageReportDto, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.resolveTenantId(user, query.tenantId);
    const range = this.resolveRange(query);
    const scope = this.scopeIds(access);
    const groupBy: MaterialUsageGroupBy = query.groupBy ?? 'detail';
    const emptySummary = { lines: 0, orders: 0, qty: 0, amountCents: 0 };
    const empty = { range: this.rangeView(range), groupBy, summary: emptySummary, rows: [], truncated: false };
    if (scope && !scope.length) return empty;
    if (query.communityId && scope && !scope.includes(query.communityId)) return empty;

    const buildWhere = (p: SqlParams) => {
      const where = [
        `wm.tenant_id = ${p.add(tenantId)}`,
        `wo.deleted_at IS NULL`,
        `wo.status <> 'voided'`,
        `wm.created_at >= ${p.add(range.fromTs)}`,
        `wm.created_at < ${p.add(range.toTs)}`,
      ];
      if (query.communityId) where.push(`wo.community_id = ${p.add(query.communityId)}`);
      else if (scope) where.push(`wo.community_id = ANY(${p.add(scope)})`);
      if (query.assigneeId) where.push(`wo.assignee_id = ${p.add(query.assigneeId)}`);
      if (query.materialId) where.push(`wm.material_id = ${p.add(query.materialId)}`);
      if (query.warehouseId) where.push(`wm.warehouse_id = ${p.add(query.warehouseId)}`);
      return where.join(' AND ');
    };

    const ps = new SqlParams();
    const summaryRows: Record<string, unknown>[] = await this.dataSource.query(
      `SELECT COUNT(*)::int AS lines, COUNT(DISTINCT wm.work_order_id)::int AS orders,
              COALESCE(SUM(wm.qty), 0) AS qty, COALESCE(SUM(wm.total_cost_cents), 0)::bigint AS amount_cents
       FROM work_order_materials wm
       JOIN work_orders wo ON wo.id = wm.work_order_id
       WHERE ${buildWhere(ps)}`,
      ps.values,
    );
    const s = summaryRows[0] ?? {};
    const summary = {
      lines: num(s.lines),
      orders: num(s.orders),
      qty: num(s.qty),
      amountCents: num(s.amount_cents),
    };

    if (groupBy === 'detail') {
      const p = new SqlParams();
      const whereSql = buildWhere(p);
      const limit = p.add(DETAIL_ROW_LIMIT + 1);
      const raw: Record<string, unknown>[] = await this.dataSource.query(
        `SELECT wm.id, wm.created_at, wm.work_order_id, wo.order_no, wo.status, wo.assignee_id, wo.community_id,
                wm.material_id, m.code, m.name, m.spec, m.unit, m.category,
                wm.warehouse_id, w.name AS warehouse_name,
                wm.qty, wm.unit_cost_cents, wm.total_cost_cents,
                u.name AS assignee_name, u.login_account AS assignee_account, c.name AS community_name
         FROM work_order_materials wm
         JOIN work_orders wo ON wo.id = wm.work_order_id
         JOIN materials m ON m.id = wm.material_id
         LEFT JOIN warehouses w ON w.id = wm.warehouse_id
         LEFT JOIN users u ON u.id = wo.assignee_id
         LEFT JOIN communities c ON c.id = wo.community_id
         WHERE ${whereSql}
         ORDER BY wm.created_at DESC, wm.id DESC
         LIMIT ${limit}`,
        p.values,
      );
      const truncated = raw.length > DETAIL_ROW_LIMIT;
      const rows = raw.slice(0, DETAIL_ROW_LIMIT).map((r) => ({
        id: num(r.id),
        usedAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
        workOrderId: num(r.work_order_id),
        orderNo: String(r.order_no ?? ''),
        status: String(r.status ?? ''),
        statusLabel: STATUS_LABELS[String(r.status ?? '')] ?? String(r.status ?? ''),
        assigneeId: numOrNull(r.assignee_id),
        assigneeName: (r.assignee_name as string | null) || (r.assignee_account as string | null) || (r.assignee_id ? '未知维修工' : '未派单'),
        communityId: numOrNull(r.community_id),
        communityName: (r.community_name as string | null) ?? '',
        materialId: num(r.material_id),
        code: String(r.code ?? ''),
        name: String(r.name ?? ''),
        spec: (r.spec as string | null) ?? null,
        category: (r.category as string | null) ?? null,
        unit: String(r.unit ?? ''),
        warehouseId: numOrNull(r.warehouse_id),
        warehouseName: (r.warehouse_name as string | null) ?? '',
        qty: num(r.qty),
        unitCostCents: num(r.unit_cost_cents),
        amountCents: num(r.total_cost_cents),
      }));
      return { range: this.rangeView(range), groupBy, summary, rows, truncated };
    }

    const p = new SqlParams();
    const whereSql = buildWhere(p);
    const keyExpr = this.materialUsageKeyExpr(groupBy);
    const raw: Record<string, unknown>[] = await this.dataSource.query(
      `SELECT ${keyExpr} AS key,
              COUNT(*)::int AS lines, COUNT(DISTINCT wm.work_order_id)::int AS orders,
              COALESCE(SUM(wm.qty), 0) AS qty, COALESCE(SUM(wm.total_cost_cents), 0)::bigint AS amount_cents,
              MAX(m.unit) AS unit, MAX(m.code) AS code, MAX(m.spec) AS spec, MAX(m.category) AS category
       FROM work_order_materials wm
       JOIN work_orders wo ON wo.id = wm.work_order_id
       JOIN materials m ON m.id = wm.material_id
       WHERE ${whereSql}
       GROUP BY 1
       ORDER BY amount_cents DESC, 1`,
      p.values,
    );
    const keys = raw.map((r) => (r.key === null || r.key === undefined ? null : String(r.key)));
    const labels = await this.labelsFor(tenantId, groupBy, keys);
    const rows = raw.map((r, i) => ({
      key: keys[i] ?? '',
      label: labels(keys[i]),
      lines: num(r.lines),
      orders: num(r.orders),
      // 数量只有按材料分组时才有意义（同一材料同一单位）；其它分组混单位，页面不展示
      qty: groupBy === 'material' ? num(r.qty) : null,
      unit: groupBy === 'material' ? String(r.unit ?? '') : null,
      code: groupBy === 'material' ? String(r.code ?? '') : null,
      spec: groupBy === 'material' ? ((r.spec as string | null) ?? null) : null,
      category: groupBy === 'material' ? ((r.category as string | null) ?? null) : null,
      amountCents: num(r.amount_cents),
    }));
    if (groupBy === 'day') rows.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return { range: this.rangeView(range), groupBy, summary, rows, truncated: false };
  }

  private materialUsageKeyExpr(groupBy: MaterialUsageGroupBy): string {
    switch (groupBy) {
      case 'day':
        return `to_char(wm.created_at AT TIME ZONE '${TZ}', 'YYYY-MM-DD')`;
      case 'assignee':
        return `wo.assignee_id::text`;
      case 'material':
        return `wm.material_id::text`;
      case 'warehouse':
        return `wm.warehouse_id::text`;
      case 'community':
        return `wo.community_id::text`;
      default:
        return `'all'`;
    }
  }

  // ---------------------------------------------------------------- 筛选项

  /**
   * 报表页的下拉数据：小区、仓库、维修工、材料。单独出一份是因为报表页的人
   * 不一定有「用户管理」「库存与采购」的页面权限，直接调那些接口会 403。
   * 只给 id + 名字这类展示字段，不带成本、手机号。
   */
  async options(query: ReportOptionsDto, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.resolveTenantId(user, query.tenantId);
    const scope = this.scopeIds(access);
    const warehouseIds = await this.scopedWarehouseIds(tenantId, access);
    const [communities, warehouses, materials, technicianIds, offices] = await Promise.all([
      this.dataSource.getRepository(Community).find({
        where: scope ? { tenantId, id: In(scope.length ? scope : [-1]) } : { tenantId },
        select: ['id', 'name', 'parentId', 'officeId', 'enabled'],
        order: { id: 'ASC' },
      }),
      this.dataSource.getRepository(Warehouse).find({
        where: warehouseIds ? { tenantId, id: In(warehouseIds.length ? warehouseIds : [-1]) } : { tenantId },
        select: ['id', 'name', 'type', 'officeId', 'communityId', 'enabled'],
        order: { id: 'ASC' },
      }),
      this.dataSource.getRepository(Material).find({
        where: { tenantId },
        select: ['id', 'code', 'name', 'spec', 'unit', 'category', 'enabled'],
        order: { category: 'ASC', code: 'ASC' },
      }),
      this.accessService.userIdsWithPermission(tenantId, 'app:pool', 'edit'),
      this.dataSource.getRepository(ManagementOffice).find({
        where: { tenantId },
        select: ['id', 'name', 'enabled'],
        order: { id: 'ASC' },
      }),
    ]);
    // 维修工 + 历史上被派过单的人（离职/改角色后名字还要能选出来看历史）
    const assigneeRows: Array<{ assignee_id: number }> = await this.dataSource.query(
      `SELECT DISTINCT assignee_id FROM work_orders WHERE tenant_id = $1 AND deleted_at IS NULL AND status <> 'voided' AND assignee_id IS NOT NULL`,
      [tenantId],
    );
    const staffIds = [...new Set([...technicianIds, ...assigneeRows.map((r) => Number(r.assignee_id))])];
    const staff = staffIds.length
      ? await this.dataSource.getRepository(User).find({
          where: { tenantId, id: In(staffIds), role: UserRole.STAFF },
          select: ['id', 'name', 'loginAccount', 'status'],
          order: { id: 'ASC' },
        })
      : [];
    const categories = [...new Set(materials.map((m) => m.category).filter((c): c is string => !!c))];
    return {
      communities,
      offices,
      warehouses,
      staff: staff.map((u) => ({
        id: u.id,
        name: u.name || u.loginAccount || '未命名员工',
        status: u.status,
        canTakeOrders: technicianIds.includes(u.id),
      })),
      materials,
      categories,
      today: todayInTz(),
    };
  }

  // ---------------------------------------------------------------- 公共

  private resolveRange(query: ReportRangeDto): DateRange {
    const today = todayInTz();
    const to = query.to ?? today;
    const from = query.from ?? shiftDate(to, -29);
    if (from > to) throw new BadRequestException('起始日期不能晚于截止日期');
    // 最长两年，防止一次把全表拉出来
    if (shiftDate(from, 366 * 2) < to) throw new BadRequestException('查询区间最长两年');
    const fromTs = new Date(`${from}T00:00:00+08:00`);
    const toTs = new Date(`${shiftDate(to, 1)}T00:00:00+08:00`);
    if (Number.isNaN(fromTs.getTime()) || Number.isNaN(toTs.getTime())) {
      throw new BadRequestException('日期格式不正确');
    }
    return { from, to, fromTs, toTs };
  }

  private rangeView(range: DateRange) {
    return { from: range.from, to: range.to };
  }

  private scopeIds(access?: ResolvedAccess): number[] | null {
    return scopeCommunityIds(access);
  }

  private resolveTenantId(user: AuthUser, requestedTenantId?: number): number {
    if (user.tenantId) {
      if (requestedTenantId && requestedTenantId !== user.tenantId) {
        throw new ForbiddenException('tenant mismatch');
      }
      return user.tenantId;
    }
    if (user.role === UserRole.SUPERADMIN) {
      if (!requestedTenantId) {
        throw new BadRequestException('tenantId is required for superadmin');
      }
      return requestedTenantId;
    }
    throw new ForbiddenException('tenant scope is required');
  }
}
