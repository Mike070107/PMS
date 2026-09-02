import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, LessThan, MoreThan, Repository } from 'typeorm';
import * as os from 'node:os';
import type { Request } from 'express';
import { AuthUser } from '../../common/current-user.decorator';
import { RequestMetric, SystemLog, User } from '../../entities';
import { AccessService } from '../access/access.service';
import { NotificationsService } from '../notifications/notifications.service';
import { resolveBusinessAction } from './business-action';
import { safeFeedbackAttachments } from './feedback-attachment';
import {
  ClientErrorDto,
  FeedbackStatusDto,
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
  constructor(
    @InjectRepository(SystemLog) private readonly logRepo: Repository<SystemLog>,
    @InjectRepository(RequestMetric) private readonly metricRepo: Repository<RequestMetric>,
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly access: AccessService,
    private readonly notifications: NotificationsService,
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
            : `${business.label}失败：${input.errorMessage || '未知原因'}`,
        detail: {
          operationLabel: business.label,
          businessArea: business.area,
          objectType: business.objectType || null,
          objectId: business.objectId || null,
          ...(business.detail || {}),
          ...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
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
  }) {
    let tenantId = input.tenantId;
    let actorUserId = input.actorUserId;
    if ((!tenantId || !actorUserId) && input.account) {
      const user = await this.userRepo.findOne({
        where: { loginAccount: input.account },
        select: ['id', 'tenantId'],
      }).catch(() => null);
      tenantId = tenantId ?? user?.tenantId ?? null;
      actorUserId = actorUserId ?? user?.id ?? null;
    }
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
      detail: input.account ? { account: clip(input.account, 60) } : null,
    }).catch(() => undefined);
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

  async list(user: AuthUser, query: SystemLogQueryDto) {
    const tenantId = requireTenant(user);
    const qb = this.logRepo.createQueryBuilder('log').where('log.tenant_id = :tenantId', { tenantId });
    if (query.category) qb.andWhere('log.category = :category', { category: query.category });
    if (query.level) qb.andWhere('log.level = :level', { level: query.level });
    if (query.source) qb.andWhere('log.source = :source', { source: query.source });
    if (query.success) qb.andWhere('log.success = :success', { success: query.success === 'true' });
    if (query.feedbackStatus) {
      qb.andWhere("log.detail ->> 'feedbackStatus' = :feedbackStatus", {
        feedbackStatus: query.feedbackStatus,
      });
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
        const legacyBusiness = row.category === 'operation' && !row.detail?.operationLabel
          ? resolveBusinessAction(row.requestMethod || row.action.split(' ')[0] || '', row.requestPath || row.action.replace(/^\w+\s+/, ''))
          : null;
        return {
          ...row,
          detail: legacyBusiness
            ? {
                ...(row.detail || {}),
                operationLabel: legacyBusiness.label,
                businessArea: legacyBusiness.area,
                objectType: legacyBusiness.objectType || null,
                objectId: legacyBusiness.objectId || null,
              }
            : row.detail,
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

    const candidates: Array<Omit<DetectedAlert, 'id'>> = [];
    for (const row of metricGroups) {
      const tenantId = Number(row.tenantId);
      const requests = Number(row.requests || 0);
      const errors = Number(row.errors || 0);
      const slow = Number(row.slowRequests || 0);
      const avg = Number(row.avgDurationMs || 0);
      if (errors >= 3) candidates.push({ tenantId, source: row.source, fingerprint: `api-errors:${tenantId}:${row.source}`, title: '接口异常率升高', message: `最近10分钟 ${row.source} 出现 ${errors} 次服务异常（共 ${requests} 次请求）` });
      if ((slow >= 5 || avg >= 2000) && requests >= 10) candidates.push({ tenantId, source: row.source, fingerprint: `slow:${tenantId}:${row.source}`, title: '访问响应明显变慢', message: `最近10分钟 ${row.source} 平均响应 ${avg}ms，慢请求 ${slow} 次` });
    }
    for (const row of clientGroups) {
      const tenantId = Number(row.tenantId);
      const errors = Number(row.errors || 0);
      if (errors >= 3) candidates.push({ tenantId, source: row.source, fingerprint: `client-errors:${tenantId}:${row.source}`, title: `${sourceLabel(row.source)}异常集中出现`, message: `最近10分钟收到 ${errors} 次未捕获异常，请到日志管理查看详情` });
    }

    const emitted: DetectedAlert[] = [];
    const cooldown = new Date(Date.now() - 60 * 60 * 1000);
    for (const item of candidates) {
      const duplicate = await this.logRepo.findOne({ where: { fingerprint: item.fingerprint, createdAt: MoreThan(cooldown) } });
      if (duplicate) continue;
      const saved = await this.saveLog({
        tenantId: item.tenantId, category: 'alert', level: 'error', source: item.source,
        action: 'system_alert', success: false, actorUserId: null, requestMethod: null,
        requestPath: null, statusCode: null, durationMs: null, message: item.message,
        detail: { title: item.title }, fingerprint: item.fingerprint,
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

function requireTenant(user: AuthUser) {
  if (!user.tenantId) throw new Error('当前未进入物业公司视角');
  return user.tenantId;
}

function normalizePath(value: string) {
  const path = String(value || '/').split('?')[0];
  return clip(path.replace(/\/+$/, '') || '/', 240);
}

function clip(value: unknown, length: number) { return String(value ?? '').slice(0, length); }
function clipNullable(value: unknown, length: number): string | null { const text = String(value ?? '').trim(); return text ? text.slice(0, length) : null; }
function mb(bytes: number) { return Number((bytes / 1024 / 1024).toFixed(1)); }
function numericRow(row: any) { return Object.fromEntries(Object.entries(row || {}).map(([key, value]) => [key, /^-?\d+(\.\d+)?$/.test(String(value)) ? Number(value) : value])); }
function sourceLabel(source: string) { return ({ 'admin-web': '管理后台', 'miniapp-staff': '员工端小程序', 'miniapp-owner': '业主端小程序' } as Record<string, string>)[source] || source; }
