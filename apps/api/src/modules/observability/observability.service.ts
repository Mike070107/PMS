import { Injectable, NotFoundException, Optional } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, LessThan, MoreThan, Repository } from 'typeorm';
import * as os from 'node:os';
import type { Request } from 'express';
import { AuthUser } from '../../common/current-user.decorator';
import { Community, LoginAttempt, RequestMetric, SystemLog, User } from '../../entities';
import { AccessService } from '../access/access.service';
import { NotificationsService } from '../notifications/notifications.service';
import { LOGIN_REASON_TEXT, loginAccountKey, loginFailureReasonOf, loginMethodOfAction, maskAccount } from '../telemetry/login-attempt.util';
import { businessActionCodesByArea, listBusinessActions, resolveBusinessAction } from './business-action';
import { buildApiErrorAlert } from './alert-presentation';
import { auditClassPredicate, presentOperation, safeLogPath, redactSensitiveLog } from './log-presentation';
import { safeFeedbackAttachments } from './feedback-attachment';
import {
  ClientErrorDto,
  FeedbackStatusDto,
  IntroViewDto,
  IntroViewQueryDto,
  PageViewDto,
  SystemLogQueryDto,
  UserFeedbackDto,
} from './dto';

export interface DetectedAlert {
  id: number;
  tenantId: number;
  fingerprint: string;
  title: string;
  message: string;
  source: string;
  requestPath?: string | null;
  statusCode?: number | null;
  reason?: string | null;
}

interface RequestCapture {
  tenantId: number | null;
  source: string;
  method: string;
  path: string;
  statusCode: number;
  durationMs: number;
  actorUserId: number | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  errorMessage?: string | null;
  body?: unknown;
  result?: unknown;
}

@Injectable()
export class ObservabilityService {
  /** 公开汇报页按 IP 做轻量去抖，防止刷新/脚本连点把打开次数刷爆 */
  private readonly introViewLastAt = new Map<string, number>();

  constructor(
    @InjectRepository(SystemLog) private readonly logRepo: Repository<SystemLog>,
    @InjectRepository(RequestMetric) private readonly metricRepo: Repository<RequestMetric>,
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    @InjectRepository(Community) private readonly communityRepo: Repository<Community>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly access: AccessService,
    private readonly notifications: NotificationsService,
    @Optional() @InjectRepository(LoginAttempt) private readonly loginAttemptRepo?: Repository<LoginAttempt>,
  ) {}

  /** 指标和审计是旁路：任何写入失败都不能影响业务请求。 */
  async captureRequest(input: RequestCapture) {
    try {
      await this.metricRepo.save(this.metricRepo.create({
        tenantId: input.tenantId,
        source: clip(input.source, 30),
        method: clip(input.method, 10),
        path: normalizePath(input.path),
        statusCode: input.statusCode,
        durationMs: Math.max(0, Math.round(input.durationMs)),
        actorUserId: input.actorUserId,
        createdBy: input.actorUserId,
        updatedBy: input.actorUserId,
      }));

      if (input.statusCode >= 500) {
        await this.saveLog({
          tenantId: input.tenantId,
          category: 'error',
          level: 'error',
          source: input.source,
          action: 'api_error',
          success: false,
          actorUserId: input.actorUserId,
          ipAddress: input.ipAddress,
          userAgent: input.userAgent,
          requestMethod: input.method,
          requestPath: input.path,
          statusCode: input.statusCode,
          durationMs: input.durationMs,
          message: input.errorMessage || `API 返回 ${input.statusCode}`,
          detail: null,
        });
      }
    } catch {
      /* 旁路失败不阻断主流程 */
    }
  }

  async recordOperation(input: RequestCapture) {
    try {
      const business = resolveBusinessAction(
        input.method,
        input.path,
        input.body,
        input.result,
      );
      await this.saveLog({
        tenantId: input.tenantId,
        category: 'operation',
        level: input.statusCode >= 400 ? 'warning' : 'info',
        source: input.source,
        action: business.code,
        success: input.statusCode < 400,
        actorUserId: input.actorUserId,
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
        requestMethod: input.method,
        requestPath: input.path,
        statusCode: input.statusCode,
        durationMs: input.durationMs,
        message:
          input.statusCode < 400
            ? business.label
            : `${business.label.replace(/（(?:通过|拒绝)）/g, '')}请求失败（HTTP ${input.statusCode}）`,
        detail: {
          operationLabel: business.label,
          businessArea: business.area,
          objectType: business.objectType || null,
          objectId: business.objectId || null,
          ...(business.detail || {}),
          // 操作日志不采集异常自由文本，避免把审批原因或敏感表单内容带入审计。
        },
      });
    } catch {
      /* 旁路失败不阻断主流程 */
    }
  }

  async recordLogin(input: {
    tenantId: number | null;
    source: string;
    action: string;
    success: boolean;
    actorUserId: number | null;
    account?: string | null;
    ipAddress?: string | null;
    userAgent?: string | null;
    statusCode: number;
    durationMs: number;
    message?: string | null;
    /** 密码登录由 AuthService 同步落 login_attempts（防爆破计数需要即时可见），拦截器不再重复写。 */
    skipAttempt?: boolean;
  }) {
    let tenantId = input.tenantId;
    let actorUserId = input.actorUserId;
    let actorName: string | null = null;
    if ((!tenantId || !actorUserId) && input.account) {
      const user = await this.userRepo.findOne({
        where: { loginAccount: input.account },
        select: ['id', 'tenantId', 'name'],
      }).catch(() => null);
      tenantId = tenantId ?? user?.tenantId ?? null;
      actorUserId = actorUserId ?? user?.id ?? null;
      actorName = user?.name ?? null;
    }
    if (actorUserId && !actorName) {
      const where: Record<string, unknown> = { id: actorUserId };
      if (tenantId) where.tenantId = tenantId;
      const user = await this.userRepo.findOne({ where, select: ['name'] }).catch(() => null);
      actorName = user?.name ?? null;
    }
    const accountMasked = input.account ? maskAccount(input.account) : null;
    await this.saveLog({
      tenantId,
      category: 'login',
      level: input.success ? 'info' : 'warning',
      source: input.source,
      action: input.action,
      success: input.success,
      actorUserId,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
      requestMethod: 'POST',
      requestPath: '/auth/login',
      statusCode: input.statusCode,
      durationMs: input.durationMs,
      message: input.success ? '登录成功' : input.message || '登录失败',
      detail: accountMasked ? { account: accountMasked } : null,
    }).catch(() => undefined);
    // 登录尝试是旁路：失败也不能影响登录响应；不落明文账号、不落密码。
    const failedReason = input.success ? null : loginFailureReasonOf(input.action, input.message);
    if (this.loginAttemptRepo && !input.skipAttempt) {
      void this.loginAttemptRepo.save(this.loginAttemptRepo.create({
        tenantId: tenantId ?? null,
        userId: actorUserId ?? null,
        userName: actorName,
        accountMasked,
        accountKey: input.account ? loginAccountKey(input.account) : null,
        ip: clipNullable(input.ipAddress, 64),
        userAgent: clipNullable(input.userAgent, 200),
        method: loginMethodOfAction(input.action),
        status: input.success ? 'success' : 'failed',
        reason: failedReason,
        message: failedReason ? LOGIN_REASON_TEXT[failedReason] : '登录成功',
      })).catch(() => undefined);
    }
  }

  async recordPageView(user: AuthUser, dto: PageViewDto, req: Request) {
    await this.saveLog({
      tenantId: user.tenantId,
      category: 'usage',
      level: 'info',
      source: sourceFromRequest(req),
      action: 'page_view',
      success: true,
      actorUserId: user.id,
      ipAddress: clientIp(req),
      userAgent: req.headers['user-agent'],
      requestMethod: null,
      requestPath: dto.path,
      statusCode: null,
      durationMs: null,
      message: dto.title || dto.path,
      detail: null,
    });
    return { ok: true };
  }

  /**
   * 公开汇报页（/intro/）访问记录。页面不登录，所以租户留空，按全站口径统计。
   * 2 秒内同一 IP 只记一次；不记录任何查询参数原文，只保存入口标记。
   */
  async recordIntroView(dto: IntroViewDto, req: Request) {
    const ip = introClientIp(req) || 'unknown';
    const now = Date.now();
    if (now - (this.introViewLastAt.get(ip) || 0) < 2000) return { ok: true, deduped: true };
    this.introViewLastAt.set(ip, now);
    if (this.introViewLastAt.size > 2000) {
      for (const [key, at] of this.introViewLastAt) {
        if (now - at > 10 * 60 * 1000) this.introViewLastAt.delete(key);
      }
    }
    await this.saveLog({
      tenantId: null,
      category: 'usage',
      level: 'info',
      source: 'intro-page',
      action: 'intro_page_view',
      success: true,
      ipAddress: ip,
      userAgent: req.headers['user-agent'],
      requestMethod: 'POST',
      requestPath: dto.path || '/intro/',
      message: dto.title || 'PMS 系统介绍页',
      detail: {
        referrer: dto.referrer?.slice(0, 500) || null,
        entry: dto.entry?.slice(0, 60) || null,
      },
    });
    return { ok: true };
  }

  /** 日志页「汇报页访问」页签：总打开、今日打开、独立 IP、最近打开、趋势和明细 */
  async introViewOverview(query: IntroViewQueryDto) {
    const todayStart = new Date(shanghaiDay(new Date()) + 'T00:00:00+08:00');
    const days: Array<{ date: string; count: number }> = [];
    for (let i = query.days - 1; i >= 0; i--) {
      days.push({ date: shanghaiDay(new Date(Date.now() - i * 24 * 3600 * 1000)), count: 0 });
    }
    const daysStart = new Date(days[0].date + 'T00:00:00+08:00');
    const [summary] = await this.dataSource.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE created_at >= $1)::int AS today,
              COUNT(DISTINCT ip_address)::int AS "uniqueIps",
              MAX(created_at) AS "lastViewedAt"
         FROM system_logs
        WHERE category = 'usage' AND action = 'intro_page_view'`,
      [todayStart],
    );
    const dailyRows: Array<{ date: string; count: number }> = await this.dataSource.query(
      `SELECT to_char(created_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD') AS date,
              COUNT(*)::int AS count
         FROM system_logs
        WHERE category = 'usage' AND action = 'intro_page_view' AND created_at >= $1
        GROUP BY 1 ORDER BY 1`,
      [daysStart],
    );
    const dailyMap = new Map(dailyRows.map((row) => [row.date, Number(row.count)]));
    for (const day of days) day.count = dailyMap.get(day.date) || 0;

    const qb = this.logRepo.createQueryBuilder('log')
      .where('log.category = :category', { category: 'usage' })
      .andWhere('log.action = :action', { action: 'intro_page_view' });
    const total = Number(summary?.total || 0);
    const rows = total === 0 ? [] : await qb.clone()
      .orderBy('log.createdAt', 'DESC')
      .skip((query.page - 1) * query.pageSize)
      .take(query.pageSize)
      .getMany();

    return {
      summary: {
        total,
        today: Number(summary?.today || 0),
        uniqueIps: Number(summary?.uniqueIps || 0),
        lastViewedAt: summary?.lastViewedAt || null,
      },
      daily: days,
      list: rows.map((row) => {
        const detail = (row.detail || {}) as Record<string, unknown>;
        return {
          id: row.id,
          viewedAt: row.createdAt,
          ip: row.ipAddress,
          path: row.requestPath,
          userAgent: row.userAgent,
          referrer: typeof detail.referrer === 'string' ? detail.referrer : null,
          entry: typeof detail.entry === 'string' ? detail.entry : null,
        };
      }),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async recordClientError(user: AuthUser, dto: ClientErrorDto, req: Request) {
    await this.saveLog({
      tenantId: user.tenantId,
      category: 'error',
      level: 'error',
      source: dto.source,
      action: 'client_exception',
      success: false,
      actorUserId: user.id,
      ipAddress: clientIp(req),
      userAgent: req.headers['user-agent'],
      requestMethod: null,
      requestPath: dto.route || null,
      statusCode: null,
      durationMs: null,
      message: dto.message,
      detail: { stack: dto.stack || null, version: dto.version || null },
    });
    return { ok: true };
  }

  /** 用户主动反馈：自动带当前页面和最近错误，并通知有日志查看权的管理员。 */
  async recordUserFeedback(user: AuthUser, dto: UserFeedbackDto, req: Request) {
    const tenantId = requireTenant(user);
    const source = sourceFromRequest(req);
    const attachments = safeFeedbackAttachments(dto.attachments, req);
    const saved = await this.saveLog({
      tenantId,
      category: 'feedback',
      level: dto.type === 'error' || dto.type === 'data_issue' ? 'warning' : 'info',
      source,
      action: 'user_feedback',
      success: false,
      actorUserId: user.id,
      ipAddress: clientIp(req),
      userAgent: req.headers['user-agent'],
      requestMethod: null,
      requestPath: dto.route || null,
      statusCode: null,
      durationMs: null,
      message: dto.message,
      detail: {
        feedbackType: dto.type,
        feedbackStatus: 'new',
        pageTitle: dto.pageTitle || null,
        version: dto.version || null,
        errorMessage: dto.errorMessage || null,
        context: safeFeedbackContext(dto.context),
        attachments,
        history: [{ status: 'new', at: new Date().toISOString(), by: user.id }],
      },
    });

    const receivers = await this.access.userIdsWithPermission(tenantId, 'logs', 'view');
    await Promise.all(
      receivers
        .filter((id) => id !== user.id)
        .map((receiverId) =>
          this.notifications.notifyUser({
            tenantId,
            receiverId,
            eventKey: 'user_feedback',
            title: '收到用户异常反馈',
            payload: { feedbackId: saved.id, source, route: dto.route || '', attachmentCount: attachments.length },
            page: '/pages/messages/messages',
          }),
        ),
    );
    return { ok: true, id: saved.id };
  }

  async updateFeedbackStatus(id: number, dto: FeedbackStatusDto, user: AuthUser) {
    const tenantId = requireTenant(user);
    const row = await this.logRepo.findOne({ where: { id, tenantId, category: 'feedback' } });
    if (!row) throw new NotFoundException('反馈记录不存在');
    const detail = { ...(row.detail || {}) } as Record<string, any>;
    const history = Array.isArray(detail.history) ? detail.history.slice(-19) : [];
    history.push({ status: dto.status, note: dto.note?.trim() || null, at: new Date().toISOString(), by: user.id });
    row.detail = { ...detail, feedbackStatus: dto.status, handlingNote: dto.note?.trim() || null, history };
    row.success = dto.status === 'resolved';
    row.updatedBy = user.id;
    return this.logRepo.save(row);
  }

  /** null = 不按小区筛；[] = 条件成立但一个小区都没有 */
  private async resolveLogCommunityIds(tenantId: number, query: SystemLogQueryDto) {
    if (query.communityId) return [query.communityId];
    if (!query.officeId) return null;
    const rows = await this.communityRepo.find({
      where: { tenantId, officeId: query.officeId },
      select: ['id'],
    });
    return rows.map((row) => row.id);
  }

  /** 筛选下拉的数据源：业务模块 → 具体操作 */
  logFilterOptions() {
    return { areas: listBusinessActions() };
  }

  async list(user: AuthUser, query: SystemLogQueryDto) {
    const tenantId = requireTenant(user);
    const qb = this.logRepo.createQueryBuilder('log').where('log.tenant_id = :tenantId', { tenantId });
    if (query.auditClass) {
      const filter = auditClassPredicate(query.auditClass);
      qb.andWhere(filter.sql, filter.params);
    }
    if (query.category) qb.andWhere('log.category = :category', { category: query.category });
    if (query.level) qb.andWhere('log.level = :level', { level: query.level });
    if (query.source) qb.andWhere('log.source = :source', { source: query.source });
    if (query.success) qb.andWhere('log.success = :success', { success: query.success === 'true' });
    if (query.feedbackStatus) {
      qb.andWhere("log.detail ->> 'feedbackStatus' = :feedbackStatus", {
        feedbackStatus: query.feedbackStatus,
      });
    }
    if (query.action) qb.andWhere('log.action = :action', { action: query.action });
    else if (query.area) {
      // 老日志的 detail 里没有 businessArea，靠 action code 兜一层，否则按模块筛会漏早期记录
      const codes = businessActionCodesByArea(query.area);
      if (codes.length) {
        qb.andWhere("(log.detail ->> 'businessArea' = :area OR log.action IN (:...areaCodes))", {
          area: query.area,
          areaCodes: codes,
        });
      } else {
        qb.andWhere("log.detail ->> 'businessArea' = :area", { area: query.area });
      }
    }
    const communityIds = await this.resolveLogCommunityIds(tenantId, query);
    if (communityIds) {
      if (!communityIds.length) qb.andWhere('1 = 0');
      else {
        qb.andWhere("log.detail ->> 'communityId' IN (:...communityIds)", {
          communityIds: communityIds.map((id) => String(id)),
        });
      }
    }
    if (query.from) qb.andWhere('log.created_at >= :from', { from: new Date(query.from) });
    if (query.to) qb.andWhere('log.created_at <= :to', { to: new Date(query.to) });
    if (query.keyword?.trim()) {
      qb.andWhere('(log.message ILIKE :q OR log.action ILIKE :q OR log.request_path ILIKE :q)', {
        q: `%${query.keyword.trim()}%`,
      });
    }
    const page = query.page || 1;
    const pageSize = query.pageSize || 30;
    const [rows, total] = await qb.orderBy('log.id', 'DESC').skip((page - 1) * pageSize).take(pageSize).getManyAndCount();
    const userIds = [...new Set(rows.map((row) => row.actorUserId).filter((id): id is number => !!id))];
    const users = userIds.length
      ? await this.userRepo.createQueryBuilder('user').select(['user.id', 'user.name', 'user.loginAccount']).where('user.id IN (:...ids)', { ids: userIds }).getMany()
      : [];
    const userById = new Map(users.map((row) => [row.id, row]));
    return {
      list: rows.map((row) => {
        const presentation = presentOperation(row);
        return {
          ...row,
          requestPath: row.requestPath ? safeLogPath(row.requestPath) : row.requestPath,
          presentation,
          detail: presentation
            ? {
                ...(row.detail || {}),
                operationLabel: presentation.actionLabel,
                businessArea: presentation.moduleLabel,
                objectType: presentation.objectType,
                objectId: presentation.objectId,
              }
            : row.detail,
          ...(redactSensitiveLog(row) || {}),
          actorName: row.actorUserId
            ? userById.get(row.actorUserId)?.name || userById.get(row.actorUserId)?.loginAccount || `用户 #${row.actorUserId}`
            : '系统',
        };
      }),
      total,
      page,
      pageSize,
    };
  }

  async overview(user: AuthUser) {
    const tenantId = requireTenant(user);
    const since = new Date(Date.now() - 24 * 3600 * 1000);
    const since7d = new Date(Date.now() - 7 * 24 * 3600 * 1000);
    const started = Date.now();
    let dbStatus: 'up' | 'down' = 'up';
    try { await this.dataSource.query('SELECT 1'); } catch { dbStatus = 'down'; }
    const dbLatencyMs = Date.now() - started;

    const [summary, sources, routes, pages, hours, logCounts, operations] = await Promise.all([
      this.metricRepo.createQueryBuilder('m')
        .select('COUNT(*)', 'requests')
        .addSelect('COUNT(*) FILTER (WHERE m.status_code >= 500)', 'errors')
        .addSelect('COUNT(*) FILTER (WHERE m.duration_ms >= 2000)', 'slowRequests')
        .addSelect('COALESCE(ROUND(AVG(m.duration_ms)), 0)', 'avgDurationMs')
        .addSelect('COALESCE(MAX(m.duration_ms), 0)', 'maxDurationMs')
        .addSelect('COUNT(DISTINCT m.actor_user_id)', 'activeUsers')
        .where('m.tenant_id = :tenantId AND m.created_at >= :since', { tenantId, since })
        .getRawOne(),
      this.metricRepo.createQueryBuilder('m')
        .select('m.source', 'source').addSelect('COUNT(*)', 'requests')
        .addSelect('COUNT(*) FILTER (WHERE m.status_code >= 500)', 'errors')
        .addSelect('COALESCE(ROUND(AVG(m.duration_ms)), 0)', 'avgDurationMs')
        .where('m.tenant_id = :tenantId AND m.created_at >= :since', { tenantId, since })
        .groupBy('m.source').orderBy('COUNT(*)', 'DESC').getRawMany(),
      this.metricRepo.createQueryBuilder('m')
        .select('m.path', 'path').addSelect('COUNT(*)', 'requests')
        .addSelect('COALESCE(ROUND(AVG(m.duration_ms)), 0)', 'avgDurationMs')
        .where('m.tenant_id = :tenantId AND m.created_at >= :since', { tenantId, since })
        .groupBy('m.path').orderBy('COUNT(*)', 'DESC').limit(10).getRawMany(),
      this.logRepo.createQueryBuilder('log')
        .select('log.request_path', 'path').addSelect('COUNT(*)', 'views')
        .addSelect('COUNT(DISTINCT log.actor_user_id)', 'users')
        .where("log.tenant_id = :tenantId AND log.category = 'usage' AND log.created_at >= :since7d", { tenantId, since7d })
        .groupBy('log.request_path').orderBy('COUNT(*)', 'DESC').limit(10).getRawMany(),
      this.metricRepo.createQueryBuilder('m')
        .select("date_trunc('hour', m.created_at)", 'hour').addSelect('COUNT(*)', 'requests')
        .addSelect('COUNT(*) FILTER (WHERE m.status_code >= 500)', 'errors')
        .addSelect('COALESCE(ROUND(AVG(m.duration_ms)), 0)', 'avgDurationMs')
        .where('m.tenant_id = :tenantId AND m.created_at >= :since', { tenantId, since })
        .groupBy("date_trunc('hour', m.created_at)").orderBy("date_trunc('hour', m.created_at)", 'ASC').getRawMany(),
      this.logRepo.createQueryBuilder('log')
        .select('log.category', 'category').addSelect('COUNT(*)', 'count')
        .where('log.tenant_id = :tenantId AND log.created_at >= :since', { tenantId, since })
        .groupBy('log.category').getRawMany(),
      this.logRepo.createQueryBuilder('log')
        .select('log.action', 'action')
        .addSelect("COALESCE(log.detail->>'operationLabel', log.message)", 'label')
        .addSelect("COALESCE(log.detail->>'businessArea', '其他')", 'area')
        .addSelect('COUNT(*)', 'uses')
        .addSelect('COUNT(DISTINCT log.actor_user_id)', 'users')
        .addSelect('COUNT(*) FILTER (WHERE log.success = false)', 'failures')
        .where("log.tenant_id = :tenantId AND log.category = 'operation' AND log.created_at >= :since30d", {
          tenantId,
          since30d: new Date(Date.now() - 30 * 24 * 3600 * 1000),
        })
        .groupBy('log.action')
        .addGroupBy("COALESCE(log.detail->>'operationLabel', log.message)")
        .addGroupBy("COALESCE(log.detail->>'businessArea', '其他')")
        .orderBy('COUNT(*)', 'DESC')
        .limit(12)
        .getRawMany(),
    ]);

    const memory = process.memoryUsage();
    return {
      periodHours: 24,
      summary: numericRow(summary),
      sources: sources.map(numericRow),
      routes: routes.map(numericRow),
      pages: pages.map(numericRow),
      hours: hours.map(numericRow),
      logCounts: Object.fromEntries(logCounts.map((row) => [row.category, Number(row.count || 0)])),
      operations: operations.map(numericRow),
      runtime: {
        status: dbStatus === 'up' ? 'healthy' : 'unhealthy',
        dbStatus,
        dbLatencyMs,
        uptimeSeconds: Math.round(process.uptime()),
        processRssMb: mb(memory.rss),
        processHeapMb: mb(memory.heapUsed),
        serverFreeMemoryMb: mb(os.freemem()),
        serverTotalMemoryMb: mb(os.totalmem()),
        loadAverage: os.loadavg().map((value) => Number(value.toFixed(2))),
        cpuCount: os.cpus().length,
      },
    };
  }

  /** 每 5 分钟聚合一次，达到阈值且不在冷却期才生成告警。 */
  async detectAlerts(): Promise<DetectedAlert[]> {
    const since = new Date(Date.now() - 10 * 60 * 1000);
    const metricGroups = await this.metricRepo.createQueryBuilder('m')
      .select('m.tenant_id', 'tenantId').addSelect('m.source', 'source')
      .addSelect('COUNT(*)', 'requests')
      .addSelect('COUNT(*) FILTER (WHERE m.status_code >= 500)', 'errors')
      .addSelect('COUNT(*) FILTER (WHERE m.duration_ms >= 2000)', 'slowRequests')
      .addSelect('COALESCE(ROUND(AVG(m.duration_ms)), 0)', 'avgDurationMs')
      .where('m.tenant_id IS NOT NULL AND m.created_at >= :since', { since })
      .groupBy('m.tenant_id').addGroupBy('m.source').getRawMany();
    const clientGroups = await this.logRepo.createQueryBuilder('log')
      .select('log.tenant_id', 'tenantId').addSelect('log.source', 'source').addSelect('COUNT(*)', 'errors')
      .where("log.tenant_id IS NOT NULL AND log.category = 'error' AND log.action = 'client_exception' AND log.created_at >= :since", { since })
      .groupBy('log.tenant_id').addGroupBy('log.source').getRawMany();
    const apiErrorDetails = await this.logRepo.createQueryBuilder('log')
      .select('log.tenant_id', 'tenantId').addSelect('log.source', 'source')
      .addSelect('log.request_path', 'requestPath').addSelect('log.status_code', 'statusCode')
      .addSelect('log.message', 'reason').addSelect('COUNT(*)', 'errors')
      .where("log.tenant_id IS NOT NULL AND log.category = 'error' AND log.action = 'api_error' AND log.created_at >= :since", { since })
      .groupBy('log.tenant_id').addGroupBy('log.source').addGroupBy('log.request_path')
      .addGroupBy('log.status_code').addGroupBy('log.message')
      .orderBy('COUNT(*)', 'DESC').addOrderBy('MAX(log.created_at)', 'DESC')
      .getRawMany();
    const apiErrorDetailBySource = new Map<string, any>();
    for (const detail of apiErrorDetails) {
      const key = `${detail.tenantId}:${detail.source}`;
      if (!apiErrorDetailBySource.has(key)) apiErrorDetailBySource.set(key, detail);
    }

    const candidates: Array<Omit<DetectedAlert, 'id'>> = [];
    for (const row of metricGroups) {
      const tenantId = Number(row.tenantId);
      const requests = Number(row.requests || 0);
      const errors = Number(row.errors || 0);
      const slow = Number(row.slowRequests || 0);
      const avg = Number(row.avgDurationMs || 0);
      if (errors >= 3) {
        const detail = apiErrorDetailBySource.get(`${tenantId}:${row.source}`);
        const presentation = buildApiErrorAlert({
          source: row.source,
          errors,
          requests,
          path: detail?.requestPath,
          statusCode: Number(detail?.statusCode) || null,
          reason: detail?.reason,
        });
        candidates.push({
          tenantId,
          source: row.source,
          fingerprint: `api-errors:${tenantId}:${row.source}`,
          ...presentation,
          requestPath: detail?.requestPath ?? null,
          statusCode: Number(detail?.statusCode) || null,
          reason: detail?.reason ?? null,
        });
      }
      if ((slow >= 5 || avg >= 2000) && requests >= 10) candidates.push({ tenantId, source: row.source, fingerprint: `slow:${tenantId}:${row.source}`, title: '访问响应明显变慢', message: `最近10分钟 ${row.source} 平均响应 ${avg}ms，慢请求 ${slow} 次` });
    }
    for (const row of clientGroups) {
      const tenantId = Number(row.tenantId);
      const errors = Number(row.errors || 0);
      if (errors >= 3) candidates.push({ tenantId, source: row.source, fingerprint: `client-errors:${tenantId}:${row.source}`, title: `${sourceLabel(row.source)}异常集中出现`, message: `最近10分钟收到 ${errors} 次未捕获异常，请到日志管理查看详情` });
    }

    const emitted: DetectedAlert[] = [];
    const cooldown = new Date(Date.now() - 6 * 60 * 60 * 1000);
    const activeFingerprints = new Set(candidates.map((item) => item.fingerprint));
    // 找出 6 小时内发出过、但本轮已不再达到阈值的告警：写一条恢复标记后，下一次再触发可立即提醒。
    const recentAlerts = await this.logRepo.createQueryBuilder('log')
      .select('log.tenant_id', 'tenantId').addSelect('log.fingerprint', 'fingerprint').addSelect('MAX(log.created_at)', 'lastAt')
      .where("log.category = 'alert' AND log.action = 'system_alert' AND log.fingerprint IS NOT NULL AND log.created_at >= :since", { since: cooldown })
      .groupBy('log.tenant_id').addGroupBy('log.fingerprint')
      .getRawMany();
    for (const row of recentAlerts) {
      if (activeFingerprints.has(row.fingerprint)) continue;
      const lastAlertAt = new Date(row.lastAt);
      const recovered = await this.logRepo.findOne({ where: { fingerprint: row.fingerprint, action: 'system_alert_recovered', createdAt: MoreThan(lastAlertAt) } });
      if (!recovered) {
        await this.saveLog({
          tenantId: Number(row.tenantId), category: 'alert', level: 'info', source: 'observability',
          action: 'system_alert_recovered', success: true, actorUserId: null, requestMethod: null,
          requestPath: null, statusCode: null, durationMs: null, message: '告警已恢复',
          detail: { title: '告警已恢复' }, fingerprint: row.fingerprint,
        }).catch(() => undefined);
      }
    }
    for (const item of candidates) {
      const lastAlert = await this.logRepo.findOne({ where: { fingerprint: item.fingerprint, action: 'system_alert' }, order: { createdAt: 'DESC' } });
      if (lastAlert && lastAlert.createdAt > cooldown) {
        const lastRecovery = await this.logRepo.findOne({ where: { fingerprint: item.fingerprint, action: 'system_alert_recovered' }, order: { createdAt: 'DESC' } });
        // 只有恢复标记晚于上一次告警时才重置冷却；仍在持续中的告警 6 小时内不重复建单/发微信。
        if (!lastRecovery || lastRecovery.createdAt <= lastAlert.createdAt) continue;
      }
      const saved = await this.saveLog({
        tenantId: item.tenantId, category: 'alert', level: 'error', source: item.source,
        action: 'system_alert', success: false, actorUserId: null, requestMethod: null,
        requestPath: null, statusCode: null, durationMs: null, message: item.message,
        detail: {
          title: item.title,
          requestPath: item.requestPath ?? null,
          statusCode: item.statusCode ?? null,
          reason: item.reason ?? null,
        },
        fingerprint: item.fingerprint,
      });
      emitted.push({ ...item, id: saved.id });
    }
    return emitted;
  }

  async purgeExpired() {
    const metricBefore = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    const logBefore = new Date(Date.now() - 180 * 24 * 3600 * 1000);
    const [metrics, logs] = await Promise.all([
      this.metricRepo.delete({ createdAt: LessThan(metricBefore) }),
      this.logRepo.delete({ createdAt: LessThan(logBefore) }),
    ]);
    return { metrics: metrics.affected || 0, logs: logs.affected || 0 };
  }

  private saveLog(input: Partial<SystemLog> & Pick<SystemLog, 'category' | 'level' | 'source' | 'action' | 'success' | 'message'>) {
    return this.logRepo.save(this.logRepo.create({
      tenantId: input.tenantId ?? null,
      category: input.category,
      level: input.level,
      source: clip(input.source, 30),
      action: clip(input.action, 100),
      success: input.success,
      actorUserId: input.actorUserId ?? null,
      ipAddress: clipNullable(input.ipAddress, 64),
      userAgent: clipNullable(input.userAgent, 500),
      requestMethod: clipNullable(input.requestMethod, 10),
      requestPath: clipNullable(input.requestPath ? normalizePath(input.requestPath) : null, 300),
      statusCode: input.statusCode ?? null,
      durationMs: input.durationMs == null ? null : Math.max(0, Math.round(input.durationMs)),
      message: clip(input.message, 500),
      detail: input.detail ?? null,
      fingerprint: clipNullable(input.fingerprint, 120),
      createdBy: input.actorUserId ?? null,
      updatedBy: input.actorUserId ?? null,
    }));
  }
}

function safeFeedbackContext(value?: Record<string, unknown>) {
  if (!value) return null;
  const allowed = ['method', 'url', 'code', 'httpStatus', 'at', 'route', 'orderId', 'stockId', 'warehouseId'];
  return Object.fromEntries(
    allowed
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, typeof value[key] === 'string' ? String(value[key]).slice(0, 300) : value[key]]),
  );
}

export function sourceFromRequest(req: Request): string {
  const explicit = String(req.headers['x-client-source'] || '').trim().toLowerCase();
  if (['admin-web', 'miniapp-staff', 'miniapp-owner'].includes(explicit)) return explicit;
  const appType = String((req.body as any)?.appType || '');
  if (appType === 'staff') return 'miniapp-staff';
  if (appType === 'owner') return 'miniapp-owner';
  return String(req.headers['user-agent'] || '').includes('MicroMessenger') ? 'miniapp' : 'admin-web';
}

export function clientIp(req: Request): string | null {
  const forwarded = req.headers['x-forwarded-for'];
  return clipNullable((Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim() || req.ip, 64);
}

/**
 * 公开页取真实来源 IP：优先 Cloudflare / nginx 注入的头，
 * X-Forwarded-For 取最后一跳（nginx 追加的 $remote_addr），避免客户端自带 XFF 伪装。
 */
export function introClientIp(req: Request): string | null {
  const real = req.headers['x-real-ip'];
  if (real) return clipNullable(Array.isArray(real) ? real[0] : real, 64);
  const cf = req.headers['cf-connecting-ip'];
  if (cf) return clipNullable(Array.isArray(cf) ? cf[0] : cf, 64);
  const forwarded = req.headers['x-forwarded-for'];
  const raw = Array.isArray(forwarded) ? forwarded.join(',') : forwarded;
  const last = raw?.split(',').map((v) => v.trim()).filter(Boolean).pop();
  return clipNullable(last || req.ip, 64);
}

function shanghaiDay(date: Date) {
  return new Date(date.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

function requireTenant(user: AuthUser) {
  if (!user.tenantId) throw new Error('当前未进入物业公司视角');
  return user.tenantId;
}

function normalizePath(value: string) {
  const path = safeLogPath(value);
  return clip(path.replace(/\/+$/, '') || '/', 240);
}

function clip(value: unknown, length: number) { return String(value ?? '').slice(0, length); }
function clipNullable(value: unknown, length: number): string | null { const text = String(value ?? '').trim(); return text ? text.slice(0, length) : null; }
function mb(bytes: number) { return Number((bytes / 1024 / 1024).toFixed(1)); }
function numericRow(row: any) { return Object.fromEntries(Object.entries(row || {}).map(([key, value]) => [key, /^-?\d+(\.\d+)?$/.test(String(value)) ? Number(value) : value])); }
function sourceLabel(source: string) { return ({ 'admin-web': '管理后台', 'miniapp-staff': '员工端小程序', 'miniapp-owner': '业主端小程序' } as Record<string, string>)[source] || source; }
