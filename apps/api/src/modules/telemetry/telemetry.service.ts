import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Request } from 'express';
import { Repository } from 'typeorm';
import { AuthUser } from '../../common/current-user.decorator';
import { LoginAttempt } from '../../entities/login-attempt.entity';
import { PageView } from '../../entities/page-view.entity';
import { User } from '../../entities/user.entity';
import { LOGIN_REASON_TEXT, type LoginFailureReason } from './login-attempt.util';
import { pageKey, pageName } from './page-meta';
import { LoginHistoryQueryDto, PAGE_VIEW_SOURCES, PageUsageDrilldownQueryDto, PageUsageQueryDto, PageViewsDto, type PageViewSource } from './telemetry.dto';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 366;

function clientIp(req: Request): string | null {
  const forwarded = req.headers['x-forwarded-for'];
  const raw = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim() || req.ip;
  return raw ? String(raw).slice(0, 64) : null;
}

function clip(value: unknown, max: number): string | null {
  const text = String(value ?? '').trim();
  return text ? text.slice(0, max) : null;
}

function shanghaiDate(value: Date): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(value);
}

function shanghaiIso(value: Date | string): string {
  const date = new Date(value);
  const base = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
  return base.replace(' ', 'T') + '+08:00';
}

/** 页面路径归一：去 query/hash 与末尾斜杠；/login、/intro 等静态页不记。 */
function normalizeViewPath(raw: unknown): string | null {
  let path = String(raw ?? '').trim().split(/[?#]/)[0];
  if (!path.startsWith('/')) return null;
  path = path.replace(/\/+$/, '') || '/';
  if (path === '/login' || path === '/intro' || path.startsWith('/intro/')) return null;
  return path.slice(0, 300);
}

/** 来源归一：只认三种白名单取值；返回 null 表示「不是合法来源」。 */
function normalizeViewSource(value: unknown): PageViewSource | null {
  const text = String(value ?? '').trim().toLowerCase();
  return (PAGE_VIEW_SOURCES as readonly string[]).includes(text) ? (text as PageViewSource) : null;
}

/** x-client-source 请求头 → page_views.source：小程序两端直接对应，网页/未知一律 web。 */
function sourceFromHeader(req: Request): PageViewSource {
  const header = String(req.headers['x-client-source'] || '').trim().toLowerCase();
  return header === 'miniapp-staff' || header === 'miniapp-owner' ? header : 'web';
}

@Injectable()
export class TelemetryService {
  constructor(
    @InjectRepository(PageView) private readonly views: Repository<PageView>,
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(LoginAttempt) private readonly attempts: Repository<LoginAttempt>,
  ) {}

  private async userName(tenantId: number, userId: number): Promise<string> {
    const user = await this.users.findOne({ where: { id: userId, tenantId }, select: ['name'] }).catch(() => null);
    return clip(user?.name, 60) || `用户#${userId}`;
  }

  async recordPageViews(user: AuthUser, dto: PageViewsDto, req: Request) {
    if (!user.tenantId) throw new BadRequestException('请先选择公司');
    const views = Array.isArray(dto.views) ? dto.views : [];
    if (views.length > 50) throw new BadRequestException('单次最多上报50条页面访问');
    const now = Date.now();
    const headerSource = sourceFromHeader(req);
    const rows: Array<{ path: string; pageKey: string | null; source: PageViewSource; createdAt: Date }> = [];
    let skipped = 0;
    for (const item of views) {
      const path = normalizeViewPath(item.path);
      if (!path) { skipped += 1; continue; }
      // 显式来源必须在 DTO 白名单内；这里不静默纠正，直接拒绝脏数据。
      const explicitSource = item.source == null ? null : normalizeViewSource(item.source);
      if (item.source != null && !explicitSource) throw new BadRequestException('页面来源不合法');
      let at = now;
      const parsed = item.at ? Date.parse(item.at) : NaN;
      if (Number.isFinite(parsed) && Math.abs(parsed - now) <= 5 * 60 * 1000) at = parsed;
      // 秒级截断：与唯一索引共同保证同用户+路径+同秒只落一条。
      const createdAt = new Date(Math.floor(at / 1000) * 1000);
      rows.push({ path, pageKey: pageKey(path, item.pageKey), source: explicitSource ?? headerSource, createdAt });
    }
    if (!rows.length) return { ok: true, received: views.length, recorded: 0, deduped: 0, skipped };
    const tenantId = user.tenantId;
    const userName = await this.userName(tenantId, user.id);
    const userAgent = clip(req.headers['user-agent'], 200);
    const ip = clientIp(req);
    const params: unknown[] = [];
    const values = rows.map((row) => {
      const offset = params.length;
      params.push(tenantId, user.id, userName, row.path, row.pageKey, row.source, row.createdAt, ip, userAgent);
      return `($${offset + 1},$${offset + 2},$${offset + 3},$${offset + 4},$${offset + 5},$${offset + 6},$${offset + 7},$${offset + 8},$${offset + 9})`;
    });
    const inserted: Array<{ id: number }> = await this.views.query(
      `INSERT INTO page_views (tenant_id,user_id,user_name,path,page_key,source,created_at,ip,user_agent)
       VALUES ${values.join(',')}
       ON CONFLICT (tenant_id,user_id,path,created_at) DO NOTHING
       RETURNING id`,
      params,
    );
    return { ok: true, received: views.length, recorded: inserted.length, deduped: rows.length - inserted.length, skipped };
  }

  private range(from: string, to: string): { start: Date; end: Date } {
    if (!DATE_RE.test(from) || !DATE_RE.test(to)) throw new BadRequestException('日期格式应为YYYY-MM-DD');
    const start = new Date(`${from}T00:00:00+08:00`);
    const endDay = new Date(`${to}T00:00:00+08:00`);
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(endDay.getTime()) || shanghaiDate(start) !== from || shanghaiDate(endDay) !== to) {
      throw new BadRequestException('日期不合法');
    }
    if (from > to) throw new BadRequestException('开始日期不能晚于结束日期');
    const end = new Date(endDay.getTime() + 86400000);
    if (end.getTime() - start.getTime() > MAX_RANGE_DAYS * 86400000) throw new BadRequestException('时间范围不能超过一年');
    return { start, end };
  }

  /** 下钻的 from/to 允许省略：缺省近 7 天（含今天），仍按北京时间自然日校验。 */
  private rangeWithDefaults(from?: string, to?: string): { start: Date; end: Date } {
    const toDate = String(to ?? '').trim() || shanghaiDate(new Date());
    let fromDate = String(from ?? '').trim();
    if (!fromDate) {
      const endDay = new Date(`${toDate}T00:00:00+08:00`);
      if (!Number.isFinite(endDay.getTime())) throw new BadRequestException('日期不合法');
      fromDate = shanghaiDate(new Date(endDay.getTime() - 6 * 86400000));
    }
    return this.range(fromDate, toDate);
  }

  private async countValue(sql: string, params: unknown[]): Promise<number> {
    const rows: Array<{ n: number }> = await this.views.query(sql, params);
    return Number(rows?.[0]?.n || 0);
  }

  /**
   * 使用统计下钻（复用 page_views）：
   * - events（默认）：逐条访问记录，按时间倒序；
   * - users：按用户聚合（views + 最近一次 lastAt）；
   * - pages：按页面聚合（views + 最近一次 lastAt）。
   * path / userId 都是可选过滤；分页作用于返回的明细或聚合行，total 为对应总数。
   */
  async pageUsageDrilldown(user: AuthUser, query: PageUsageDrilldownQueryDto) {
    if (!user.tenantId) throw new BadRequestException('请先选择公司');
    const groupBy = query.groupBy ?? 'events';
    if (groupBy !== 'events' && groupBy !== 'users' && groupBy !== 'pages') {
      throw new BadRequestException('groupBy 只支持 events/users/pages');
    }
    const page = query.page ?? 1;
    if (!Number.isInteger(page) || page < 1) throw new BadRequestException('页码必须从 1 开始');
    const pageSize = query.pageSize ?? 20;
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new BadRequestException('每页条数必须是 1–100 的整数');
    const { start, end } = this.rangeWithDefaults(query.from, query.to);
    const params: unknown[] = [user.tenantId, start, end];
    const filters = ['tenant_id=$1', 'created_at>=$2', 'created_at<$3'];
    const rawPath = String(query.path ?? '').trim();
    if (rawPath) {
      const path = normalizeViewPath(rawPath);
      if (!path) throw new BadRequestException('页面路径不合法');
      params.push(path);
      filters.push(`path=$${params.length}`);
    }
    if (query.userId != null) {
      if (!Number.isInteger(query.userId) || query.userId < 1) throw new BadRequestException('用户ID不合法');
      params.push(query.userId);
      filters.push(`user_id=$${params.length}`);
    }
    if (query.source != null) {
      const source = normalizeViewSource(query.source);
      if (!source) throw new BadRequestException('来源不合法');
      params.push(source);
      filters.push(`source=$${params.length}`);
    }
    const where = filters.join(' AND ');
    const limitSql = `LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    const pageParams = [...params, pageSize, (page - 1) * pageSize];

    if (groupBy === 'users') {
      const total = await this.countValue(`SELECT COUNT(DISTINCT user_id)::int AS n FROM page_views WHERE ${where}`, params);
      const rows: Array<{ userId: number; userName: string | null; views: number; lastAt: Date }> = await this.views.query(
        `SELECT user_id AS "userId", MAX(user_name) AS "userName", COUNT(*)::int AS views, MAX(created_at) AS "lastAt"
           FROM page_views WHERE ${where}
          GROUP BY user_id
          ORDER BY views DESC, "userId" ASC
          ${limitSql}`,
        pageParams,
      );
      return {
        total,
        page,
        pageSize,
        rows: rows.map((row) => ({
          userId: Number(row.userId),
          userName: clip(row.userName, 60) || `用户#${Number(row.userId)}`,
          views: Number(row.views),
          lastAt: shanghaiIso(row.lastAt),
        })),
      };
    }

    if (groupBy === 'pages') {
      const total = await this.countValue(`SELECT COUNT(DISTINCT path)::int AS n FROM page_views WHERE ${where}`, params);
      const rows: Array<{ path: string; views: number; lastAt: Date }> = await this.views.query(
        `SELECT path, COUNT(*)::int AS views, MAX(created_at) AS "lastAt"
           FROM page_views WHERE ${where}
          GROUP BY path
          ORDER BY views DESC, path ASC
          ${limitSql}`,
        pageParams,
      );
      return {
        total,
        page,
        pageSize,
        rows: rows.map((row) => ({ path: row.path, pageName: pageName(row.path), views: Number(row.views), lastAt: shanghaiIso(row.lastAt) })),
      };
    }

    const total = await this.countValue(`SELECT COUNT(*)::int AS n FROM page_views WHERE ${where}`, params);
    const rows: Array<{ at: Date; userId: number; userName: string | null; path: string; ip: string | null; source: string | null }> = await this.views.query(
      `SELECT created_at AS "at", user_id AS "userId", user_name AS "userName", path, ip, source
         FROM page_views WHERE ${where}
        ORDER BY created_at DESC, id DESC
        ${limitSql}`,
      pageParams,
    );
    return {
      total,
      page,
      pageSize,
      rows: rows.map((row) => ({
        at: shanghaiIso(row.at),
        userId: Number(row.userId),
        userName: clip(row.userName, 60) || '未知用户',
        path: row.path,
        pageName: pageName(row.path),
        ip: row.ip || null,
        source: normalizeViewSource(row.source) ?? 'web',
      })),
    };
  }

  async pageUsage(user: AuthUser, query: PageUsageQueryDto) {
    if (!user.tenantId) throw new BadRequestException('请先选择公司');
    const { start, end } = this.range(query.from, query.to);
    const tenantId = user.tenantId;
    const params = [tenantId, start, end];
    const totals = (await this.views.query(
      `SELECT COUNT(*)::int AS "totalViews", COUNT(DISTINCT user_id)::int AS "uniqueUsers"
       FROM page_views WHERE tenant_id=$1 AND created_at>=$2 AND created_at<$3`,
      params,
    ))[0] || { totalViews: 0, uniqueUsers: 0 };
    const daysRaw: Array<{ day: string; views: number; users: number }> = await this.views.query(
      `SELECT TO_CHAR(created_at AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD') AS day,
              COUNT(*)::int AS views, COUNT(DISTINCT user_id)::int AS users
       FROM page_views WHERE tenant_id=$1 AND created_at>=$2 AND created_at<$3
       GROUP BY 1 ORDER BY 1`,
      params,
    );
    const daysBySourceRaw: Array<{ day: string; source: string | null; views: number; users: number }> = await this.views.query(
      `SELECT TO_CHAR(created_at AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD') AS day,
              source, COUNT(*)::int AS views, COUNT(DISTINCT user_id)::int AS users
         FROM page_views WHERE tenant_id=$1 AND created_at>=$2 AND created_at<$3
        GROUP BY 1, source ORDER BY 1, source`,
      params,
    );
    const bySourceRaw: Array<{ source: string | null; views: number; users: number }> = await this.views.query(
      `SELECT source, COUNT(*)::int AS views, COUNT(DISTINCT user_id)::int AS users
         FROM page_views WHERE tenant_id=$1 AND created_at>=$2 AND created_at<$3
        GROUP BY source`,
      params,
    );
    // 三个来源固定顺序返回（0 也返回），前端画来源分布/堆叠趋势时结构稳定。
    const sourceBreakdown = (rows: Array<{ source: string | null; views: number; users: number }>) =>
      PAGE_VIEW_SOURCES.map((source) => {
        const hit = rows.find((row) => (normalizeViewSource(row.source) ?? 'web') === source);
        return { source, views: Number(hit?.views || 0), users: Number(hit?.users || 0) };
      });
    const daySourceMap = new Map<string, Array<{ source: string | null; views: number; users: number }>>();
    for (const row of daysBySourceRaw) {
      const list = daySourceMap.get(row.day) || [];
      list.push(row);
      daySourceMap.set(row.day, list);
    }
    const days = daysRaw.map((row) => ({
      day: row.day,
      views: Number(row.views),
      users: Number(row.users),
      bySource: sourceBreakdown(daySourceMap.get(row.day) || []),
    }));
    const bySource = sourceBreakdown(bySourceRaw);
    // 登录次数：口径与 login-history 一致（本租户 + 未知账号的失败尝试）。
    const loginTotals = (await this.attempts.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE status='success')::int AS success,
              COUNT(*) FILTER (WHERE status='failed')::int AS failed,
              COUNT(DISTINCT user_id)::int AS "uniqueUsers"
         FROM login_attempts
        WHERE (tenant_id=$1 OR (tenant_id IS NULL AND status='failed'))
          AND created_at>=$2 AND created_at<$3`,
      params,
    ))[0] || {};
    const logins = {
      total: Number(loginTotals.total || 0),
      success: Number(loginTotals.success || 0),
      failed: Number(loginTotals.failed || 0),
      uniqueUsers: Number(loginTotals.uniqueUsers || 0),
    };
    const topPagesRaw: Array<{ path: string; views: number; users: number }> = await this.views.query(
      `SELECT path, COUNT(*)::int AS views, COUNT(DISTINCT user_id)::int AS users
       FROM page_views WHERE tenant_id=$1 AND created_at>=$2 AND created_at<$3
       GROUP BY path ORDER BY views DESC, path ASC LIMIT 20`,
      params,
    );
    const topPages = topPagesRaw.map((row) => ({ path: row.path, name: pageName(row.path), views: Number(row.views), users: Number(row.users) }));
    const topUsersRaw: Array<{ userId: number; name: string; views: number; pages: number; topPage: string }> = await this.views.query(
      `WITH scoped AS (
         SELECT user_id, path, user_name FROM page_views
          WHERE tenant_id=$1 AND created_at>=$2 AND created_at<$3
       ), user_totals AS (
         SELECT user_id, MAX(user_name) AS name, COUNT(*)::int AS views, COUNT(DISTINCT path)::int AS pages
           FROM scoped GROUP BY user_id ORDER BY views DESC, user_id ASC LIMIT 20
       ), page_counts AS (
         SELECT user_id, path, COUNT(*)::int AS views FROM scoped GROUP BY user_id, path
       ), top_page AS (
         SELECT user_id, path, ROW_NUMBER() OVER(PARTITION BY user_id ORDER BY views DESC, path ASC) AS rn FROM page_counts
       )
       SELECT ut.user_id AS "userId", COALESCE(MAX(ut.name),'未知用户') AS name, MAX(ut.views)::int AS views, MAX(ut.pages)::int AS pages, MAX(tp.path) AS "topPage"
         FROM user_totals ut LEFT JOIN top_page tp ON tp.user_id=ut.user_id AND tp.rn=1
        GROUP BY ut.user_id, tp.path
        ORDER BY views DESC, "userId" ASC
        LIMIT 20`,
      params,
    );
    const topUsers = topUsersRaw.map((row) => ({
      userId: Number(row.userId),
      name: String(row.name || '未知用户'),
      views: Number(row.views),
      pages: Number(row.pages),
      topPage: row.topPage || '',
      topPageName: row.topPage ? pageName(row.topPage) : '',
    }));
    return { totalViews: Number(totals.totalViews || 0), uniqueUsers: Number(totals.uniqueUsers || 0), days, topPages, topUsers, bySource, logins };
  }

  async loginHistory(user: AuthUser, query: LoginHistoryQueryDto) {
    if (!user.tenantId) throw new BadRequestException('请先选择公司');
    const { start, end } = this.range(query.from, query.to);
    const status = query.status ?? 'all';
    const limit = query.limit ?? 50;
    const params: unknown[] = [user.tenantId, start, end];
    let statusSql = '';
    if (status !== 'all') { params.push(status); statusSql = ` AND status=$${params.length}`; }
    params.push(limit);
    // 未知账号失败时 tenant_id 为空，仍要让管理员在日志中看到未授权尝试。
    const rows = await this.attempts.query(
      `SELECT created_at AS "at", user_id AS "userId", user_name AS name, account_masked AS "accountMasked",
              ip, user_agent AS "userAgent", method, status, reason, message
         FROM login_attempts
        WHERE (tenant_id=$1 OR (tenant_id IS NULL AND status='failed'))
          AND created_at>=$2 AND created_at<$3${statusSql}
        ORDER BY created_at DESC, id DESC
        LIMIT $${params.length}`,
      params,
    );
    return rows.map((row: any) => ({
      userId: row.userId == null ? null : Number(row.userId),
      name: row.name || '未知用户',
      at: shanghaiIso(row.at),
      ip: row.ip || null,
      userAgent: row.userAgent || null,
      method: row.method,
      status: row.status,
      reason: row.reason || null,
      reasonText: row.reason ? (LOGIN_REASON_TEXT[row.reason as LoginFailureReason] || row.message || '登录失败') : null,
      accountMasked: row.accountMasked || null,
    }));
  }
}
