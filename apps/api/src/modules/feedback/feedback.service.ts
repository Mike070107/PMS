import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, MoreThanOrEqual, Repository } from 'typeorm';
import type { Request } from 'express';
import { AuthUser } from '../../common/current-user.decorator';
import { Notification, SystemLog, User, UserFeedback } from '../../entities';
import type { UserFeedbackAttachment, UserFeedbackContext, UserFeedbackKind, UserFeedbackSource, UserFeedbackStatus } from '../../entities/user-feedback.entity';
import {
  CreateUserFeedbackDto,
  FEEDBACK_MAX_ATTACHMENTS,
  FEEDBACK_MAX_ATTACHMENT_BYTES,
  ListUserFeedbackDto,
  UpdateUserFeedbackDto,
} from './dto';
import { NotificationsService, type TemplateFields } from '../notifications/notifications.service';
import { AccessService } from '../access/access.service';
import { ObjectStorageService } from '../upload/object-storage.service';

const logger = new Logger('FeedbackService');
/** 与历史上 observability 的反馈通知共用 eventKey，便于消息中心聚合；合并窗口为「同一自然分钟」。 */
const FEEDBACK_EVENT_KEY = 'user_feedback';
const ALLOWED_ATTACHMENT_MIME = /^(image\/|video\/|application\/pdf$)/i;

function feedbackKind(value: unknown): UserFeedbackKind {
  return value === 'error' ? 'error' : 'suggestion';
}

function feedbackStatus(value: unknown): UserFeedbackStatus {
  return value === 'handled' ? 'handled' : 'pending';
}

/** 历史 system_logs 的 source 是 admin-web/miniapp-*，统一接口输出 web/miniapp-*。 */
function feedbackSource(value: unknown): UserFeedbackSource {
  const raw = String(value || '').toLowerCase();
  if (raw === 'web' || raw === 'admin-web') return 'web';
  if (raw === 'miniapp-owner') return 'miniapp-owner';
  return 'miniapp-staff';
}

function sourceFromRequest(explicit: unknown, req: Request): UserFeedbackSource {
  if (explicit === 'web' || explicit === 'miniapp-staff' || explicit === 'miniapp-owner') return explicit;
  const header = String(req.headers?.['x-client-source'] || '').toLowerCase();
  if (header === 'admin-web') return 'web';
  if (header === 'miniapp-staff' || header === 'miniapp-owner') return header;
  const appType = String((req.body as any)?.appType || '');
  if (appType === 'owner') return 'miniapp-owner';
  // /feedback 历史只有员工端小程序在用；拿不到来源时按员工端处理，不丢反馈。
  return 'miniapp-staff';
}

@Injectable()
export class FeedbackService {
  constructor(
    @InjectRepository(UserFeedback)
    private readonly feedbackRepo: Repository<UserFeedback>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(Notification)
    private readonly notificationRepo: Repository<Notification>,
    @InjectRepository(SystemLog)
    private readonly logRepo: Repository<SystemLog>,
    private readonly notifications: NotificationsService,
    private readonly access: AccessService,
    private readonly storage: ObjectStorageService,
  ) {}

  /**
   * 提交反馈：
   * - 新客户端：kind/attachments/context/source；附件必须是本系统 /upload/file 且服务端实测 ≤20MB、≤5 个。
   * - 旧客户端（员工端小程序旧版本）：只传 content/imageUrls/videoUrl/videoDurationSeconds，仍可提交；
   *   老字段原样入库，同时折叠进统一 attachments 视图（无大小/类型元数据）。
   * 提交后通知有 logs:view 的管理员；同一自然分钟内的多条合并成一条，避免刷屏。
   */
  async create(dto: CreateUserFeedbackDto, auth: AuthUser, req: Request) {
    const tenantId = this.requireTenant(auth);
    const content = String(dto.content || '').trim();
    if (!content) throw new BadRequestException('请填写意见或建议');
    if (!!dto.videoUrl !== !!dto.videoDurationSeconds) {
      throw new BadRequestException('视频地址与时长必须同时提交');
    }
    const attachments = await this.validateAttachments(dto.attachments, dto.imageUrls, dto.videoUrl, req);
    const user = await this.userRepo.findOne({
      where: { id: auth.id, tenantId },
      select: ['id', 'name', 'phone'],
    });
    const row = this.feedbackRepo.create({
      tenantId,
      userId: auth.id,
      userName: user?.name ?? null,
      userPhone: user?.phone ?? null,
      content,
      kind: dto.kind ?? 'suggestion',
      imageUrls: dto.imageUrls ?? [],
      videoUrl: dto.videoUrl || null,
      videoDurationSeconds: dto.videoDurationSeconds ?? null,
      attachments,
      context: this.sanitizeContext(dto.context, req),
      source: sourceFromRequest(dto.source, req),
      status: 'pending',
      createdBy: auth.id,
      updatedBy: auth.id,
    });
    const saved = await this.feedbackRepo.save(row);
    await this.notifyAdmins(saved as UserFeedback);
    return {
      id: saved.id,
      createdAt: saved.createdAt,
      kind: saved.kind,
      source: saved.source,
      status: saved.status,
    };
  }

  /**
   * 统一列表（读时合并，不迁移旧数据）：
   * 1) user_feedback：本表（新/老字段都在这里）；
   * 2) system_logs(category='feedback', action='user_feedback')：历史「异常反馈」tab 的数据。
   * 合并规则见 docs 注释/汇报：kind error ← error|data_issue，其余归 suggestion；
   * status pending ← new|processing，handled ← resolved|ignored；source admin-web → web。
   * 旧记录 id 以 `log-<id>` 返回，PATCH 时同样接受该格式。
   */
  async list(query: ListUserFeedbackDto, auth: AuthUser) {
    const tenantId = this.requireTenant(auth);
    const page = query.page ?? 1, pageSize = query.pageSize ?? 20;
    this.assertRange(query.from, query.to);
    const params: Array<string | number | Date> = [tenantId];
    const add = (value: string | number | Date) => {
      params.push(value);
      return `$${params.length}`;
    };
    const unifiedWhere = ['f.tenant_id = $1'];
    const legacyWhere = ["l.tenant_id = $1", "l.category = 'feedback'", "l.action = 'user_feedback'"];
    if (query.kind) {
      const placeholder = add(query.kind);
      unifiedWhere.push(`f.kind = ${placeholder}`);
      legacyWhere.push(
        query.kind === 'error'
          ? "(l.detail->>'feedbackType') IN ('error','data_issue')"
          : "COALESCE(l.detail->>'feedbackType','') NOT IN ('error','data_issue')",
      );
    }
    if (query.status) {
      const placeholder = add(query.status);
      unifiedWhere.push(`f.status = ${placeholder}`);
      legacyWhere.push(
        query.status === 'pending'
          ? "COALESCE(l.detail->>'feedbackStatus','new') IN ('new','processing')"
          : "(l.detail->>'feedbackStatus') IN ('resolved','ignored')",
      );
    }
    if (query.from) {
      const placeholder = add(this.chinaDayStart(query.from));
      unifiedWhere.push(`f.created_at >= ${placeholder}`);
      legacyWhere.push(`l.created_at >= ${placeholder}`);
    }
    if (query.to) {
      const placeholder = add(this.chinaDayEndExclusive(query.to));
      unifiedWhere.push(`f.created_at < ${placeholder}`);
      legacyWhere.push(`l.created_at < ${placeholder}`);
    }
    const countRaw: any = await this.feedbackRepo.manager.query(
      `SELECT (SELECT count(*)::int FROM user_feedback f WHERE ${unifiedWhere.join(' AND ')}) +
              (SELECT count(*)::int FROM system_logs l WHERE ${legacyWhere.join(' AND ')}) AS total`,
      params,
    );
    const total = Number((Array.isArray(countRaw) ? countRaw[0] : countRaw?.rows?.[0])?.total ?? 0);
    const offset = (page - 1) * pageSize;
    const rowsRaw: any = await this.feedbackRepo.manager.query(
      `SELECT * FROM (
         SELECT 'unified'::text AS origin, f.id AS ref_id, f.kind::text AS kind,
                f.user_name, f.user_phone, f.created_at, f.content::text AS content,
                f.attachments, f.context AS context_json, f.source::text AS source,
                f.status::text AS status, f.user_id AS actor_user_id, f.image_urls,
                f.video_url, NULL::varchar(500) AS user_agent, NULL::varchar(300) AS request_path
           FROM user_feedback f WHERE ${unifiedWhere.join(' AND ')}
         UNION ALL
         SELECT 'legacy'::text, l.id,
                CASE WHEN (l.detail->>'feedbackType') IN ('error','data_issue') THEN 'error' ELSE 'suggestion' END,
                NULL::varchar(60), NULL::varchar(30), l.created_at, l.message::text,
                NULL::jsonb, l.detail::jsonb, l.source::text,
                COALESCE(l.detail->>'feedbackStatus','new')::text, l.actor_user_id,
                NULL::jsonb, NULL::varchar(1024), l.user_agent, l.request_path
           FROM system_logs l WHERE ${legacyWhere.join(' AND ')}
       ) merged
       ORDER BY created_at DESC, origin DESC, ref_id DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, offset],
    );
    const rawRows: any[] = Array.isArray(rowsRaw) ? rowsRaw : rowsRaw?.rows || [];
    // 历史反馈只存了 actor id，姓名/电话按当前账号补（新反馈写的是提交时快照）。
    const legacyActorIds = [...new Set(
      rawRows
        .filter((row) => row.origin === 'legacy')
        .map((row) => Number(row.actor_user_id))
        .filter((id) => Number.isInteger(id) && id > 0),
    )];
    const legacyUsers = legacyActorIds.length
      ? await this.userRepo.find({ where: { tenantId, id: In(legacyActorIds) }, select: ['id', 'name', 'phone'] })
      : [];
    const userMap = new Map(legacyUsers.map((user) => [user.id, user]));
    return { total, page, pageSize, rows: rawRows.map((row) => this.toRow(row, userMap)) };
  }

  /** 标记已处理/撤回。支持统一表 id 与历史 `log-<id>`。 */
  async update(id: string, dto: UpdateUserFeedbackDto, auth: AuthUser) {
    const tenantId = this.requireTenant(auth);
    const status: UserFeedbackStatus = dto.status ?? 'handled';
    if (/^log-\d+$/.test(id)) {
      const logId = Number(id.slice(4));
      const log = await this.logRepo.findOne({ where: { id: logId, tenantId, category: 'feedback' } });
      if (!log) throw new NotFoundException('反馈记录不存在');
      const detail = { ...(log.detail || {}) } as Record<string, unknown>;
      const history = Array.isArray(detail.history) ? detail.history.slice(-19) : [];
      history.push({ status: status === 'handled' ? 'resolved' : 'new', at: new Date().toISOString(), by: auth.id });
      log.detail = { ...detail, feedbackStatus: status === 'handled' ? 'resolved' : 'new', history };
      log.success = status === 'handled';
      log.updatedBy = auth.id;
      await this.logRepo.save(log);
      return { ok: true, id, status };
    }
    if (!/^\d+$/.test(id)) throw new BadRequestException('反馈 ID 不合法');
    const row = await this.feedbackRepo.findOne({ where: { id: Number(id), tenantId } });
    if (!row) throw new NotFoundException('反馈记录不存在');
    row.status = status;
    row.updatedBy = auth.id;
    await this.feedbackRepo.save(row);
    return { ok: true, id: Number(id), status };
  }

  /** 附件：新字段严格校验（数量/URL/真实大小/类型），旧字段只做结构兼容。 */
  private async validateAttachments(
    value: CreateUserFeedbackDto['attachments'],
    legacyImages: string[] | undefined,
    legacyVideo: string | undefined,
    req: Request,
  ): Promise<UserFeedbackAttachment[]> {
    const legacyUrls = [...(legacyImages || []), ...(legacyVideo ? [legacyVideo] : [])]
      .map((url) => String(url || '').trim())
      .filter(Boolean);
    const attachments: UserFeedbackAttachment[] = [];
    for (const item of value || []) {
      if (!item?.url) throw new BadRequestException('附件地址不能为空');
      if (item.size !== undefined && item.size > FEEDBACK_MAX_ATTACHMENT_BYTES) {
        throw new BadRequestException(`单个附件不能超过 20MB（${item.name || '未命名附件'}）`);
      }
      const { url, objectKey } = this.attachmentTarget(item.url, req);
      if (attachments.some((one) => one.url === url)) throw new BadRequestException('附件重复，请勿重复上传同一文件');
      let stat: { contentType?: string; size: number };
      try {
        stat = await this.storage.statObject(objectKey);
      } catch {
        throw new BadRequestException('附件无法校验，请重新上传后再提交');
      }
      if (stat.size > FEEDBACK_MAX_ATTACHMENT_BYTES) {
        throw new BadRequestException(`单个附件不能超过 20MB（${item.name || '未命名附件'} 实测 ${(stat.size / 1024 / 1024).toFixed(1)}MB）`);
      }
      const actualMime = String(stat.contentType || '').toLowerCase();
      const declaredMime = String(item.mime || '').toLowerCase();
      const mime = declaredMime || actualMime;
      if (!ALLOWED_ATTACHMENT_MIME.test(mime)) {
        throw new BadRequestException('附件仅支持图片、视频或 PDF');
      }
      if (actualMime && ALLOWED_ATTACHMENT_MIME.test(actualMime) && declaredMime && actualMime.split('/')[0] !== declaredMime.split('/')[0]) {
        throw new BadRequestException('附件类型与文件实际内容不一致');
      }
      attachments.push({
        url,
        name: item.name ? String(item.name).slice(0, 120) : null,
        size: stat.size,
        mime: mime.slice(0, 100),
      });
    }
    if (attachments.length + legacyUrls.length > FEEDBACK_MAX_ATTACHMENTS) {
      throw new BadRequestException(`附件最多 ${FEEDBACK_MAX_ATTACHMENTS} 个`);
    }
    // 旧字段没有大小/类型元数据，按兼容处理：只保证 URL 是字符串，不阻止历史客户端提交。
    for (const url of legacyUrls) {
      attachments.push({ url: url.slice(0, 1024), name: null, size: null, mime: null });
    }
    return attachments;
  }

  /** 只接受本系统 /upload/file?key=uploads/... 的地址（与 observability 的历史规则一致）。 */
  private attachmentTarget(value: string, req: Request) {
    const url = String(value || '').trim();
    if (!url || url.length > 1024) throw new BadRequestException('附件地址无效');
    let parsed: URL;
    try {
      parsed = new URL(url, 'https://feedback.local');
    } catch {
      throw new BadRequestException('附件地址无效');
    }
    const key = parsed.searchParams.get('key') || '';
    const relative = url.startsWith('/');
    if (
      (!relative && parsed.host !== req.get('host'))
      || !parsed.pathname.endsWith('/upload/file')
      || !key.startsWith('uploads/')
    ) {
      throw new BadRequestException('反馈附件必须先通过系统上传');
    }
    return { url, objectKey: key };
  }

  private sanitizeContext(value: CreateUserFeedbackDto['context'], req: Request): UserFeedbackContext | null {
    const context: UserFeedbackContext = {};
    const page = String(value?.page || '').trim();
    if (page) context.page = page.slice(0, 300);
    const userAgent = String(value?.userAgent || req.headers?.['user-agent'] || '').trim();
    if (userAgent) context.userAgent = userAgent.slice(0, 300);
    const appVersion = String(value?.appVersion || '').trim();
    if (appVersion) context.appVersion = appVersion.slice(0, 80);
    const recentErrors = (value?.recentErrors || []).slice(0, 10).map((error) => ({
      at: String(error.at || '').slice(0, 40),
      message: String(error.message || '').slice(0, 500),
      ...(error.stack ? { stack: String(error.stack).slice(0, 2000) } : {}),
    })).filter((error) => error.message);
    if (recentErrors.length) context.recentErrors = recentErrors;
    return Object.keys(context).length ? context : null;
  }

  /** 通知有 logs:view 的管理员；同一自然分钟内合并成一条（只推一次微信，后续只更新站内信）。 */
  private async notifyAdmins(row: UserFeedback) {
    try {
      const receiverIds = (await this.access.userIdsWithPermission(row.tenantId, 'logs', 'view'))
        .filter((id) => id !== row.userId);
      if (!receiverIds.length) return;
      const kindLabel = row.kind === 'error' ? '异常反馈' : '意见与建议';
      const summary = row.content.replace(/\s+/g, ' ').slice(0, 60);
      const submitter = row.userName || `用户#${row.userId}`;
      const needsErrorCheck = row.kind === 'error' || !!row.context?.recentErrors?.length;
      const minuteStart = new Date();
      minuteStart.setSeconds(0, 0);
      for (const receiverId of receiverIds) {
        const existing = await this.notificationRepo.findOne({
          where: { tenantId: row.tenantId, receiverId, eventKey: FEEDBACK_EVENT_KEY, createdAt: MoreThanOrEqual(minuteStart) },
          order: { id: 'DESC' },
        });
        if (existing) {
          const payload = (existing.payload || {}) as Record<string, any>;
          const count = (Number(payload.count) || 1) + 1;
          const mergedNeedsErrorCheck = Boolean(payload.needsErrorCheck) || needsErrorCheck;
          const feedbackIds = Array.isArray(payload.feedbackIds) ? payload.feedbackIds.map(Number).filter(Number.isInteger) : [];
          const items = Array.isArray(payload.items) ? payload.items.slice(-4) : [];
          existing.payload = {
            ...payload,
            count,
            latestId: row.id,
            feedbackIds: [...new Set([...feedbackIds, row.id])],
            items: [...items, { id: row.id, kind: row.kind, submitter, summary }],
            kind: row.kind,
            kindLabel,
            submitter,
            summary,
            needsErrorCheck: mergedNeedsErrorCheck,
            page: '/logs',
          };
          existing.title = this.feedbackTitle(kindLabel, submitter, summary, count, mergedNeedsErrorCheck);
          existing.readAt = null;
          await this.notificationRepo.save(existing);
          continue;
        }
        const fields: TemplateFields = {
          orderNo: `FB-${row.id}`,
          type: kindLabel,
          status: needsErrorCheck ? `新${kindLabel}·需看报错` : `新${kindLabel}`,
          statusShort: '新反馈',
          content: `${submitter}${needsErrorCheck ? '（需看报错）' : ''}：${summary}`,
          assignee: '',
          address: summary,
          reporter: submitter,
          time: this.nowText(),
          reportedAt: this.nowText(),
          dueAt: this.nowText(),
        };
        await this.notifications.notifyUser({
          tenantId: row.tenantId,
          receiverId,
          eventKey: FEEDBACK_EVENT_KEY,
          title: this.feedbackTitle(kindLabel, submitter, summary, 1, needsErrorCheck),
          payload: {
            feedbackId: row.id,
            feedbackIds: [row.id],
            kind: row.kind,
            kindLabel,
            submitter,
            summary,
            needsErrorCheck,
            count: 1,
            page: '/logs',
          },
          page: '/pages/messages/messages',
          serviceAccountFields: fields,
        });
      }
    } catch (error) {
      // 通知是旁路：失败只留痕，不让反馈提交失败。
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      logger.warn(`反馈通知发送失败 tenantId=${row.tenantId} feedbackId=${row.id} error=${message.slice(0, 200)}`);
    }
  }

  /** 站内信标题/微信字段都带「类型 + 提交人 + 摘要 + 是否需要看报错」，一眼能判断优先级。 */
  private feedbackTitle(kindLabel: string, submitter: string, summary: string, count: number, needsErrorCheck: boolean) {
    const flag = needsErrorCheck ? '（需看报错）' : '';
    const title = count > 1
      ? `收到 ${count} 条反馈${needsErrorCheck ? '（含需看报错）' : ''}（最新：${submitter} - ${summary}）`
      : `收到${kindLabel}${flag}：${submitter} - ${summary}`;
    return title.slice(0, 160);
  }

  private toRow(row: any, legacyUsers: Map<number, User>) {
    const createdAt = row.created_at instanceof Date
      ? row.created_at.toISOString()
      : new Date(String(row.created_at)).toISOString();
    if (row.origin === 'unified') {
      return {
        id: Number(row.ref_id),
        kind: feedbackKind(row.kind),
        userName: row.user_name ?? null,
        userPhone: row.user_phone ?? null,
        createdAt,
        content: String(row.content || ''),
        attachments: this.unifiedAttachments(row),
        context: row.context_json ?? null,
        /** 前端日志表直接展示用；与 context.recentErrors 同源，免去再解一层。 */
        recentErrors: Array.isArray(row.context_json?.recentErrors) ? row.context_json.recentErrors : [],
        source: feedbackSource(row.source),
        status: feedbackStatus(row.status),
        origin: 'unified' as const,
      };
    }
    const detail = (row.context_json || {}) as Record<string, any>;
    const actor = Number(row.actor_user_id) > 0 ? legacyUsers.get(Number(row.actor_user_id)) : undefined;
    const legacyAttachments = Array.isArray(detail.attachments)
      ? detail.attachments
          .map((item: any) => ({ url: String(item?.url || ''), name: null, size: null, mime: null }))
          .filter((item: any) => item.url)
      : [];
    const errors = detail.errorMessage
      ? [{ at: createdAt, message: String(detail.errorMessage).slice(0, 500) }]
      : [];
    return {
      id: `log-${row.ref_id}`,
      kind: feedbackKind(row.kind),
      userName: actor?.name ?? null,
      userPhone: actor?.phone ?? null,
      createdAt,
      content: String(row.content || ''),
      attachments: legacyAttachments,
      context: {
        page: detail.pageTitle || row.request_path || undefined,
        userAgent: row.user_agent || undefined,
        recentErrors: errors,
        appVersion: detail.version || undefined,
      },
      recentErrors: errors,
      source: feedbackSource(row.source),
      status: ['resolved', 'ignored'].includes(String(row.status)) ? 'handled' : 'pending',
      origin: 'legacy' as const,
    };
  }

  /** 新表 attachments 为空时回退旧字段（迁移前的老反馈），保证统一列表不漏附件。 */
  private unifiedAttachments(row: any): UserFeedbackAttachment[] {
    const stored = Array.isArray(row.attachments) ? row.attachments : [];
    if (stored.length) {
      return stored
        .map((item: any) => ({
          url: String(item?.url || ''),
          name: item?.name ? String(item.name) : null,
          size: Number.isFinite(Number(item?.size)) ? Number(item.size) : null,
          mime: item?.mime ? String(item.mime) : null,
        }))
        .filter((item: any) => item.url);
    }
    const legacy = [
      ...(Array.isArray(row.image_urls) ? row.image_urls : []),
      ...(row.video_url ? [row.video_url] : []),
    ].map((url) => String(url || '')).filter(Boolean);
    return legacy.map((url) => ({ url, name: null, size: null, mime: null }));
  }

  private assertRange(from?: string, to?: string) {
    for (const value of [from, to]) {
      if (value && !Number.isFinite(Date.parse(value + 'T00:00:00+08:00'))) {
        throw new BadRequestException('日期范围不合法');
      }
    }
    if (from && to && from > to) throw new BadRequestException('开始日期不能晚于结束日期');
  }

  private chinaDayStart(day: string) {
    return new Date(day + 'T00:00:00+08:00');
  }

  private chinaDayEndExclusive(day: string) {
    return new Date(this.chinaDayStart(day).getTime() + 86_400_000);
  }

  private nowText() {
    const now = new Date();
    const pad = (value: number) => String(value).padStart(2, '0');
    return `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  }

  private requireTenant(auth: AuthUser) {
    if (!auth.tenantId) throw new ForbiddenException('请先选择公司');
    return auth.tenantId;
  }
}
