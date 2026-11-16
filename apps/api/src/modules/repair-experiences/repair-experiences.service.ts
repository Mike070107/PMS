import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import sanitizeHtml from 'sanitize-html';
import { AuthUser } from '../../common/current-user.decorator';
import {
  Community,
  ManagementOffice,
  RepairExperienceFavorite,
  RepairExperienceNote,
  RepairTypeRule,
  StaffProfile,
  User,
} from '../../entities';

/**
 * 「本管理处公共」笔记本的 repairType 编码（与 packages/shared-types 的 OFFICE_PUBLIC_REPAIR_TYPE
 * 同值；API 不依赖 shared-types，这里各写一份，改一处两边一起改）。
 * 同一管理处数据范围内的人都能看、都能写，不按工种收窄 —— 2026-09-04 要求。
 */
export const OFFICE_PUBLIC_REPAIR_TYPE = '_office';
export const OFFICE_PUBLIC_REPAIR_TYPE_LABEL = '本管理处公共';
import { AccessService, ResolvedAccess } from '../access/access.service';
import { ObjectStorageService } from '../upload/object-storage.service';
import { ruleAssigneeIds } from '../repairs/repair-rule-template';
import { ExperienceLibraryQueryDto, SaveRepairExperienceNoteDto } from './dto';
import { compressUploadedImage } from '../upload/image-compression';
import { canonicalUploadFilename, detectUploadContentType } from '../upload/upload.controller';
import { cleanExperienceDocumentHtml, experienceDocumentBudget } from './repair-experience-document-html';

type ExperienceContext = {
  tenantId: number; userId: number; canCreate: boolean; member: boolean;
  notebooks: AllowedNotebook[];
  communities: Array<{ id: number; name: string; officeId: number; officeName: string; repairTypes: Array<{ value: string; label: string }> }>;
  allCommunities: Community[];
  skills: Set<string>;
};

interface AllowedNotebook {
  officeId: number;
  officeName: string;
  repairType: string;
  repairTypeLabel: string;
  canEdit: boolean;
  /** 本管理处公共笔记本：不对应报修类型，管理处范围内都能看、都能写 */
  isPublic: boolean;
}

type ExperienceBlock = RepairExperienceNote['blocks'][number];
type NoteSummary = {
  id: number; officeId: number; repairType: string; title: string; preview: string;
  imageCount: number; revision: number; updatedAt: string; updatedByName: string;
  favorite: boolean;
};

@Injectable()
export class RepairExperiencesService {
  constructor(
    @InjectRepository(RepairExperienceNote)
    private readonly noteRepo: Repository<RepairExperienceNote>,
    @InjectRepository(RepairExperienceFavorite)
    private readonly favoriteRepo: Repository<RepairExperienceFavorite>,
    @InjectRepository(RepairTypeRule)
    private readonly ruleRepo: Repository<RepairTypeRule>,
    @InjectRepository(ManagementOffice)
    private readonly officeRepo: Repository<ManagementOffice>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(StaffProfile)
    private readonly staffProfileRepo: Repository<StaffProfile>,
    private readonly accessService: AccessService,
    private readonly storage: ObjectStorageService,
    @InjectRepository(Community)
    private readonly communityRepo: Repository<Community>,
    private readonly config: ConfigService,
  ) {}

  /**
   * 图片地址下发前补成绝对地址。
   *
   * 后台网页写进库的是**相对**代理路径（web 的 API_BASE_URL 默认就是 `/api/v1`，
   * 同域浏览器照常显示），小程序的 `<image>` 和 `wx.previewImage` 都不认相对路径 ——
   * 表现就是「图片空白、点开一直转圈」（2026-09-04 反馈，笔记 #1 存的就是
   * `/api/v1/upload/file?key=...`）。工单附件早就走 storage.toDisplayUrls 了，
   * 经验笔记漏了这一道。在读取时补，存量数据不用改。
   */
  private withDisplayUrls(note: RepairExperienceNote): ExperienceBlock[] {
    const display = (url: string) => {
      const key = this.assetKey(url);
      return key ? this.signedAsset(key, note.tenantId, note.createdBy || 0, note).displayUrl : this.storage.toDisplayUrl(url);
    };
    return (note.blocks || []).map((block) => {
      if (block.type === 'image') return { ...block, url: display(block.url || '') };
      if (block.type === 'document' && block.html) {
        return { ...block, html: block.html.replace(/((?:\bsrc|\bhref)=["'])([^"']+)(["'])/gi, (_match, before, url, after) => `${before}${display(url.replace(/&amp;/g, '&')).replace(/&/g, '&amp;')}${after}`) };
      }
      return block;
    });
  }

  async access(user: AuthUser) {
    const context = await this.context(user);
    return {
      canView: context.member, canEdit: context.canCreate, canCreate: context.canCreate,
      notebookCount: context.notebooks.length,
      emptyReason: context.member ? null : await this.emptyReason(user),
    };
  }

  /**
   * 要不要按工种收窄，收窄成哪几个工种。返回 null = 看全部工种。
   *
   * **「办公室」只认派单台编辑权和企业/平台管理员**，故意不认 `work-orders·edit` ——
   * 这家公司的「XX管理处维修工」角色模板里就带着 work-orders 编辑权（2026-09-04 实测：
   * 角色 39 继承模板 2，work-orders can_edit=true），按 canDispatch 那套口径会把维修工
   * 判成办公室，工种过滤整个失效。
   *
   * 另一道保险是「配了工种就按工种收窄」：维修工档案里一定有工种，办公室/经理通常没有。
   * 两条合起来，权限怎么配都不至于把电工的界面塞成 36 本。
   */
  private async skillFilterFor(
    user: AuthUser,
    access: ResolvedAccess,
  ): Promise<Set<string> | null> {
    if (access.isPlatformAdmin || access.isTenantAdmin) return null;
    if (access.pages['app:dispatch']?.edit) return null;
    const profile = await this.staffProfileRepo.findOne({
      where: { tenantId: this.tenantId(user), userId: user.id },
      select: ['userId', 'skills'],
    });
    const skills = (profile?.skills ?? []).filter(Boolean);
    // 一个工种都没配：维持原样看全部（别把人的界面弄成全空），空态里会提示去配工种
    return skills.length ? new Set(skills) : null;
  }

  /**
   * 一本笔记本都看不到时，告诉他到底缺什么。
   *
   * 最常见的是「员工档案里没配工种」—— 维修工现在只能看自己工种那几本，
   * 档案空着就一本都没有。给个空页面让人以为功能坏了，比说清原因糟糕得多。
   */
  private async emptyReason(user: AuthUser): Promise<string | null> {
    const access = await this.accessService.getAccess(user);
    if (!this.accessService.hasPermission(access, ['experience-notes', 'app:experience-notes'], 'view')) {
      return '你的角色还没有「维修经验」的查看权限，请让管理员在「业务角色」里勾上。';
    }
    const profile = await this.staffProfileRepo.findOne({
      where: { tenantId: this.tenantId(user), userId: user.id },
      select: ['userId', 'skills'],
    });
    if (!profile?.skills?.length) {
      return '你的员工档案里还没有配工种，请办公室在「用户管理」里给你配上（如电、水）。';
    }
    return '你所在管理处这几个工种还没有建笔记本，等办公室配好报修类型后就会出现。';
  }

  /** 兼容旧分组入口，也必须先在SQL中应用同一ACL和关键词。 */
  async list(user: AuthUser, q?: string) {
    const context = await this.context(user);
    const notes = await this.visibleQuery(context, { q }).getMany();
    const summaries = await this.summaries(notes, user, context);
    const groups = context.notebooks.map((item) => ({ ...item, notes: [] as any[] }));
    for (const summary of summaries) {
      let group = groups.find((g) => g.officeId === summary.officeId && g.repairType === summary.repairType);
      if (!group) {
        group = { officeId: summary.officeId, officeName: '文档', repairType: summary.repairType,
          repairTypeLabel: '文档', canEdit: summary.canEdit, isPublic: false, notes: [] };
        groups.push(group);
      }
      group.notes.push(summary);
    }
    return groups;
  }

  async library(user: AuthUser, query: ExperienceLibraryQueryDto = {}) {
    const context = await this.context(user);
    const page = Number(query.page || 1), pageSize = Number(query.pageSize || 20);
    if (!Number.isSafeInteger(page) || page < 1 || page > 100000 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new BadRequestException('分页参数无效');
    const [notes, total] = await this.visibleQuery(context, query).skip((page - 1) * pageSize).take(pageSize).getManyAndCount();
    return { items: await this.summaries(notes, user, context), total, page, pageSize };
  }

  async sharingOptions(user: AuthUser) {
    const context = await this.context(user);
    return { canCreate: context.canCreate, communities: context.communities };
  }

  private async context(user: AuthUser): Promise<ExperienceContext> {
    const tenantId = this.tenantId(user);
    const [access, notebooks, profile, allCommunities, offices, rules] = await Promise.all([
      this.accessService.getAccess(user), this.allowedNotebooks(user),
      this.staffProfileRepo.findOne({ where: { tenantId, userId: user.id }, select: ['skills'] }),
      this.communityRepo.find({ where: { tenantId, enabled: true }, order: { id: 'ASC' } }),
      this.officeRepo.find({ where: { tenantId, enabled: true } }),
      this.ruleRepo.find({ where: { tenantId, enabled: true }, order: { sortOrder: 'ASC', id: 'ASC' } }),
    ]);
    const member = this.accessService.hasPermission(access, ['experience-notes', 'app:experience-notes'], 'view') || notebooks.length > 0;
    const officeMap = new Map(offices.map((o) => [o.id, o]));
    const communityMap = new Map(allCommunities.map((c) => [c.id, c]));
    const officeOf = (c: Community): number => {
      const seen = new Set<number>(); let current: Community | undefined = c;
      while (current && !seen.has(current.id)) {
        seen.add(current.id); if (current.officeId) return current.officeId;
        current = current.parentId ? communityMap.get(current.parentId) : undefined;
      }
      return 0;
    };
    const communities = (member ? allCommunities : []).filter((c) => access.scopeAll || access.communityIds?.includes(c.id)).map((c) => {
      const officeId = officeOf(c);
      const types = new Map<string, string>();
      for (const rule of rules.filter((r) => !r.officeId || r.officeId === officeId)) types.set(rule.repairType, rule.label);
      return { id: c.id, name: c.name, officeId, officeName: officeMap.get(officeId)?.name || '未划分管理处',
        repairTypes: [...types].filter(([value]) => value !== OFFICE_PUBLIC_REPAIR_TYPE).map(([value, label]) => ({ value, label })) };
    });
    return { tenantId, userId: user.id, member, canCreate: member, notebooks, communities, allCommunities,
      skills: new Set((profile?.skills || []).filter(Boolean)) };
  }

  /** SQL ACL comes before filtering, counting and pagination; no whole-tenant bodies are loaded. */
  private visibleQuery(context: ExperienceContext, query: ExperienceLibraryQueryDto) {
    const qb = this.noteRepo.createQueryBuilder('n').where('n.tenant_id = :tenantId AND n.deleted_at IS NULL', { tenantId: context.tenantId });
    const acl: string[] = ["(n.visibility <> 'legacy' AND n.created_by = :userId)"];
    const args: Record<string, any> = { userId: context.userId };
    const legacy = context.notebooks.map((book, i) => {
      args[`o${i}`] = book.officeId; args[`r${i}`] = book.repairType;
      return `(n.office_id = :o${i} AND n.repair_type = :r${i})`;
    });
    if (legacy.length) acl.push(`(n.visibility = 'legacy' AND (${legacy.join(' OR ')}))`);
    if (context.member && context.communities.length) {
      const communityAcl = context.communities.map((c, i) => {
        args[`c${i}`] = JSON.stringify([c.id]); return `n.community_ids @> :c${i}::jsonb`;
      });
      let skill = `n.repair_types = '[]'::jsonb`;
      if (context.skills.size) { args.skills = [...context.skills]; skill += ' OR n.repair_types ?| ARRAY[:...skills]::text[]'; }
      acl.push(`(n.visibility = 'published' AND (${communityAcl.join(' OR ')}) AND (${skill}))`);
    }
    qb.andWhere(`(${acl.join(' OR ')})`, args);
    const keyword = String(query.q || '').trim();
    if (keyword.length > 200) throw new BadRequestException('关键词最多200字');
    if (keyword) qb.andWhere("(n.title ILIKE :keyword ESCAPE '\\' OR n.search_text ILIKE :keyword ESCAPE '\\')", { keyword: `%${keyword.replace(/[\\%_]/g, '\\$&')}%` });
    if (query.view === 'mine') qb.andWhere('n.created_by = :userId');
    if (query.view === 'private') qb.andWhere("n.visibility = 'private' AND n.created_by = :userId");
    if (query.view === 'favorites') qb.andWhere('EXISTS (SELECT 1 FROM repair_experience_favorites f WHERE f.tenant_id = n.tenant_id AND f.note_id = n.id AND f.user_id = :userId)');
    if (query.communityId) qb.andWhere('n.community_ids @> :filterCommunity::jsonb', { filterCommunity: JSON.stringify([Number(query.communityId)]) });
    if (query.repairType) qb.andWhere("(n.repair_types ? :filterType OR (n.visibility = 'legacy' AND n.repair_type = :filterType))", { filterType: query.repairType });
    return qb.orderBy('n.updated_at', 'DESC').addOrderBy('n.id', 'DESC');
  }

  private rights(note: RepairExperienceNote, context: ExperienceContext) {
    const isOwner = note.createdBy === context.userId;
    const legacy = context.notebooks.find((b) => b.officeId === note.officeId && b.repairType === note.repairType);
    const published = note.visibility === 'published' && context.member &&
      note.communityIds.some((id) => context.communities.some((c) => c.id === id)) &&
      (!note.repairTypes.length || note.repairTypes.some((type) => context.skills.has(type)));
    const canView = !note.deletedAt && (note.visibility === 'legacy' ? !!legacy : (isOwner || published));
    return { isOwner, canManage: isOwner, canView,
      canEdit: !!canView && (note.visibility === 'legacy' ? !!legacy?.canEdit : (isOwner || note.allowEdit)),
      canDelete: !!canView && (isOwner || (note.visibility !== 'legacy' && note.allowDelete)) };
  }

  private async summaries(notes: RepairExperienceNote[], user: AuthUser, context: ExperienceContext) {
    const [names, favorites] = await Promise.all([this.userNames(notes.flatMap((n) => [n.createdBy, n.updatedBy])), this.favoriteIds(user)]);
    return notes.map((note) => this.fullSummary(note, names, favorites, context));
  }

  private fullSummary(note: RepairExperienceNote, names: Map<number, string>, favorites: Set<number>, context: ExperienceContext) {
    const rights = this.rights(note, context);
    const typeLabels = new Map(context.communities.flatMap((c) => c.repairTypes.map((t) => [t.value, t.label] as const)));
    return { ...this.summary(note, names, favorites), visibility: note.visibility,
      communityIds: note.communityIds, communityNames: note.communityIds.map((id) => context.allCommunities.find((c) => c.id === id)?.name || `小区${id}`),
      repairTypes: note.repairTypes, repairTypeLabels: note.repairTypes.map((t) => typeLabels.get(t) || t),
      allowEdit: note.allowEdit, allowDelete: note.allowDelete, isOwner: rights.isOwner, canManage: rights.canManage,
      canEdit: rights.canEdit, canDelete: rights.canDelete,
      createdByName: note.createdBy ? names.get(note.createdBy) || '员工' : '系统' };
  }

  /** 收藏 / 取消收藏。能看到那篇才能收藏，否则收藏列表就成了绕过范围的口子 */
  async setFavorite(id: number, user: AuthUser, on: boolean) {
    const context = await this.context(user);
    await this.noteRepo.manager.transaction(async (manager) => {
      const note = await manager.getRepository(RepairExperienceNote).findOne({ where: { id, tenantId: context.tenantId, deletedAt: IsNull() }, lock: { mode: 'pessimistic_write' } });
      if (!note || !this.rights(note, context).canView) throw new NotFoundException('维修经验笔记不存在或无权查看');
      const repo = manager.getRepository(RepairExperienceFavorite);
      const where = { tenantId: context.tenantId, userId: user.id, noteId: id };
      if (on) await repo.upsert({ ...where, createdBy: user.id, updatedBy: user.id }, ['tenantId', 'userId', 'noteId']);
      else await repo.delete(where);
    });
    return { favorite: on };
  }

  private async favoriteIds(user: AuthUser): Promise<Set<number>> {
    const rows = await this.favoriteRepo.find({
      where: { tenantId: this.tenantId(user), userId: user.id },
      select: ['noteId'],
    });
    return new Set(rows.map((row) => row.noteId));
  }

  async detail(id: number, user: AuthUser) {
    const note = await this.find(id, user);
    const context = await this.context(user);
    if (!this.rights(note, context).canView) throw new NotFoundException('维修经验笔记不存在或无权查看');
    const names = await this.userNames([note.createdBy, note.updatedBy]);
    const favorites = await this.favoriteIds(user);
    const legacy = context.notebooks.find((b) => b.officeId === note.officeId && b.repairType === note.repairType);
    return {
      ...this.fullSummary(note, names, favorites, context), blocks: this.withDisplayUrls(note),
      createdAt: note.createdAt.toISOString(), officeName: legacy?.officeName || (note.visibility === 'private' ? '我的私密文档' : '共享文档'),
      repairTypeLabel: legacy?.repairTypeLabel || (!note.repairTypes.length ? '不限工种' : note.repairTypes.join('、')),
    };
  }

  async create(dto: SaveRepairExperienceNoteDto, user: AuthUser) {
    const context = await this.context(user);
    if (!context.canCreate) throw new ForbiddenException('没有维修经验文档创建权限');
    const sharing = this.sharing(dto, context);
    const blocks = this.secureBlocks(this.cleanBlocks(dto.blocks), sharing.visibility, user);
    const title = this.cleanTitle(dto.title);
    const note = this.noteRepo.create({ ...sharing, tenantId: context.tenantId, title, blocks,
      searchText: this.searchText(blocks), revision: 1, deletedAt: null, createdBy: user.id, updatedBy: user.id });
    const saved = await this.noteRepo.save(note);
    return this.detail(saved.id, user);
  }

  async update(id: number, dto: SaveRepairExperienceNoteDto, user: AuthUser) {
    const note = await this.find(id, user);
    const context = await this.context(user);
    const rights = this.rights(note, context);
    if (!rights.canView) throw new NotFoundException('维修经验笔记不存在或无权查看');
    if (!rights.canEdit) throw new ForbiddenException('作者未授权编辑此文档');
    this.checkRevision(dto.revision, note.revision);
    let sharing = { visibility: note.visibility, communityIds: note.communityIds, repairTypes: note.repairTypes,
      allowEdit: note.allowEdit, allowDelete: note.allowDelete, officeId: note.officeId, repairType: note.repairType };
    const change = (key: string) => dto[key] !== undefined && JSON.stringify(dto[key]) !== JSON.stringify(note[key]);
    const changedSharing = ['visibility', 'communityIds', 'repairTypes', 'allowEdit', 'allowDelete', 'officeId', 'repairType'].some(change);
    if (!rights.canManage && changedSharing) throw new ForbiddenException('只有作者能更改发布范围及编辑、删除授权');
    if (rights.canManage && (note.visibility !== 'legacy' || dto.visibility !== undefined)) {
      sharing = this.sharing({ ...dto, visibility: dto.visibility || (note.visibility === 'published' ? 'published' : 'private'),
        communityIds: dto.communityIds ?? note.communityIds, repairTypes: dto.repairTypes ?? note.repairTypes,
        allowEdit: dto.allowEdit ?? note.allowEdit, allowDelete: dto.allowDelete ?? note.allowDelete }, context);
    } else if (note.visibility === 'legacy' && changedSharing) {
      throw new BadRequestException('旧笔记本范围保持不变；作者可明确转换为私密或发布文档');
    }
    const blocks = this.secureBlocks(this.cleanBlocks(dto.blocks), sharing.visibility, user, note);
    const result = await this.noteRepo.createQueryBuilder().update().set({ ...sharing, title: this.cleanTitle(dto.title), blocks,
      searchText: this.searchText(blocks), revision: () => 'revision + 1', updatedBy: user.id })
      .where('id = :id AND tenant_id = :tenantId AND revision = :revision AND deleted_at IS NULL', { id, tenantId: context.tenantId, revision: dto.revision }).execute();
    if (result.affected !== 1) throw new ConflictException('文档已更新或撤销授权，请重新打开后编辑');
    return this.detail(id, user);
  }

  async remove(id: number, revision: number, user: AuthUser) {
    const context = await this.context(user);
    await this.noteRepo.manager.transaction(async (manager) => {
      const repo = manager.getRepository(RepairExperienceNote);
      const note = await repo.findOne({ where: { id, tenantId: context.tenantId, deletedAt: IsNull() }, lock: { mode: 'pessimistic_write' } });
      if (!note || !this.rights(note, context).canView) throw new NotFoundException('维修经验笔记不存在或无权查看');
      if (!this.rights(note, context).canDelete) throw new ForbiddenException('作者未授权删除此文档');
      this.checkRevision(revision, note.revision);
      await repo.update({ id, tenantId: context.tenantId, revision }, { deletedAt: new Date(), revision: revision + 1, updatedBy: user.id });
      await manager.getRepository(RepairExperienceFavorite).delete({ tenantId: context.tenantId, noteId: id });
    });
    return { deleted: true };
  }

  private cleanTitle(value: string) {
    const title = String(value || '').trim();
    if (!title || title.length > 160) throw new BadRequestException('请填写1–160字标题');
    return title;
  }

  private checkRevision(revision: number | undefined, expected: number) {
    if (revision === undefined || !Number.isSafeInteger(revision) || revision < 1) throw new BadRequestException('请携带文档revision版本');
    if (revision !== expected) throw new ConflictException('这篇文档刚被更新，请重新打开后编辑');
  }

  private sharing(dto: SaveRepairExperienceNoteDto, context: ExperienceContext) {
    const visibility = dto.visibility || 'private';
    if (!['private', 'published'].includes(visibility)) throw new BadRequestException('无效文档可见性');
    const communityIds = [...new Set(dto.communityIds || [])];
    const repairTypes = [...new Set(dto.repairTypes || [])];
    if (visibility === 'published' && !communityIds.length) throw new BadRequestException('发布文档请先选择小区');
    const chosen = communityIds.map((id) => context.communities.find((c) => c.id === id));
    if (chosen.some((c) => !c)) throw new ForbiddenException('发布范围不能超出本人可访问小区');
    if (repairTypes.some((type) => !type || type === OFFICE_PUBLIC_REPAIR_TYPE || chosen.some((c) => !c?.repairTypes.some((t) => t.value === type)))) throw new BadRequestException('请先选择小区，再选择各小区均可用的工种；空工种表示不限');
    if (repairTypes.length && !chosen.length) throw new BadRequestException('请先选择小区再选择工种');
    return { visibility: visibility as 'private' | 'published', communityIds, repairTypes,
      allowEdit: dto.allowEdit ?? false, allowDelete: dto.allowDelete ?? false,
      officeId: chosen[0]?.officeId || 0, repairType: repairTypes[0] || OFFICE_PUBLIC_REPAIR_TYPE };
  }

  private searchText(blocks: ExperienceBlock[]) {
    return blocks.map((b) => [b.text, b.caption, b.type === 'document' ? this.documentText(b.html) : ''].filter(Boolean).join(' ')).join(' ');
  }

  private async find(id: number, user: AuthUser) {
    const note = await this.noteRepo.findOne({ where: { id, tenantId: this.tenantId(user), deletedAt: IsNull() } });
    if (!note) throw new NotFoundException('维修经验笔记不存在');
    return note;
  }

  private assetKey(value?: string): string | null {
    const url = String(value || '').replace(/&amp;/g, '&');
    let key = url;
    if (!key.startsWith('protected/repair-experiences/')) {
      try { key = new URL(url, 'https://relative.invalid').searchParams.get('key') || ''; } catch { return null; }
    }
    return /^protected\/repair-experiences\/[1-9]\d*\/[1-9]\d*\/\d{4}\/\d{2}\/\d{2}\/[a-zA-Z0-9_\-.]+$/.test(key) && !key.includes('..') ? key : null;
  }

  private assetKeys(blocks: ExperienceBlock[]) {
    const keys = new Set<string>();
    for (const block of blocks || []) {
      if (block.type === 'image') { const key = this.assetKey(block.url); if (key) keys.add(key); }
      if (block.type === 'document') {
        for (const match of (block.html || '').matchAll(/(?:\bsrc|\bhref)=["']([^"']+)["']/gi)) {
          const key = this.assetKey(match[1]); if (key) keys.add(key);
        }
      }
    }
    return keys;
  }

  /** Persist canonical key URLs, not expiring bearer tokens. Public history cannot become private by copying URLs. */
  private secureBlocks(blocks: ExperienceBlock[], visibility: string, user: AuthUser, old?: RepairExperienceNote) {
    const oldKeys = this.assetKeys(old?.blocks || []);
    const normalize = (url: string, image: boolean) => {
      const raw = url.replace(/&amp;/g, '&');
      const key = this.assetKey(raw);
      if (key) {
        if (!key.startsWith(`protected/repair-experiences/${this.tenantId(user)}/`)) throw new ForbiddenException('附件不属于当前公司');
        if (!key.startsWith(`protected/repair-experiences/${this.tenantId(user)}/${user.id}/`) && !oldKeys.has(key)) throw new ForbiddenException('不能关联他人未授权附件，请重新上传');
        return `/api/v1/repair-experiences/assets/view?key=${encodeURIComponent(key)}`;
      }
      if (visibility !== 'legacy' && (image || /\/upload\/file\?|^(uploads|protected)\//i.test(raw))) {
        throw new BadRequestException('私密/发布文档图片须重新使用安全上传；旧公开链接及缓存无法撤回，请确认历史公开风险');
      }
      return raw;
    };
    return blocks.map((block) => {
      if (block.type === 'image') return { ...block, url: normalize(block.url || '', true) };
      if (block.type === 'document') return { ...block, html: (block.html || '').replace(/(<(img|a)\b[^>]*?\b(?:src|href)=["'])([^"']+)(["'])/gi,
        (_m, before, tag, url, after) => `${before}${normalize(url, tag.toLowerCase() === 'img').replace(/&/g, '&amp;')}${after}`) };
      return block;
    });
  }

  private assetSignature(key: string, tenantId: number, ownerId: number, noteId: number, revision: number, expires: number) {
    const secret = this.config.get<string>('JWT_SECRET');
    if (!secret || secret === 'change-me-in-prod' || secret.length < 32) throw new ServiceUnavailableException('安全附件签名密钥未配置，请联系管理员');
    return createHmac('sha256', `${secret}:experience-assets:v1`).update(JSON.stringify([key, tenantId, ownerId, noteId, revision, expires])).digest('hex');
  }

  private signedAsset(key: string, tenantId: number, ownerId: number, note?: RepairExperienceNote) {
    const expires = Math.floor(Date.now() / 1000) + 120;
    const noteId = note?.id || 0, revision = note?.revision || 0;
    const signature = this.assetSignature(key, tenantId, ownerId, noteId, revision, expires);
    const prefix = this.config.get<string>('API_GLOBAL_PREFIX', 'api/v1').replace(/^\/+|\/+$/g, '');
    const base = this.config.get<string>('APP_PUBLIC_BASE_URL', '').replace(/\/+$/, '');
    const params = new URLSearchParams({ key, tenantId: String(tenantId), ownerId: String(ownerId), noteId: String(noteId), revision: String(revision), expires: String(expires), signature });
    return { displayUrl: `${base}/${prefix}/repair-experiences/assets/view?${params}`, expiresAt: new Date(expires * 1000).toISOString() };
  }

  async uploadAsset(file: Express.Multer.File | undefined, user: AuthUser) {
    const context = await this.context(user);
    if (!context.canCreate) throw new ForbiddenException('没有维修经验附件上传权限');
    if (!file?.buffer?.length || file.buffer.length > 50 * 1024 * 1024) throw new BadRequestException('请选择50MB以内的图片');
    const detected = detectUploadContentType(file.buffer);
    if (!detected?.startsWith('image/')) throw new BadRequestException('经验文档仅支持JPG/PNG/GIF/WebP/HEIC图片安全上传');
    // Fail before writing an object if signing cannot work in this deployment.
    this.assetSignature('configuration-check', context.tenantId, user.id, 0, 0, 0);
    const image = await compressUploadedImage(file.buffer, detected, canonicalUploadFilename(file.originalname, detected));
    const stored = await this.storage.putBuffer(image.buffer, image.contentType, `protected/repair-experiences/${context.tenantId}/${user.id}`, image.filename);
    const signed = this.signedAsset(stored.objectKey, context.tenantId, user.id);
    return { objectKey: stored.objectKey, ...signed, publicUrl: signed.displayUrl };
  }

  /** Anonymous image consumer: the short-lived, revision-bound capability is the credential. */
  async readAsset(query: Record<string, string>) {
    const key = this.assetKey(query.key);
    const tenantId = Number(query.tenantId), ownerId = Number(query.ownerId), noteId = Number(query.noteId), revision = Number(query.revision), expires = Number(query.expires);
    const now = Math.floor(Date.now() / 1000);
    const invalid = () => new NotFoundException('附件不存在或链接已过期，请重新打开文档');
    if (['key', 'tenantId', 'ownerId', 'noteId', 'revision', 'expires', 'signature'].some((field) => typeof query[field] !== 'string')) throw invalid();
    if (!key || ![tenantId, ownerId, noteId, revision, expires].every(Number.isSafeInteger) || tenantId < 1 || ownerId < 1 || noteId < 0 || revision < 0 || expires < now || expires > now + 120 || !/^[a-f0-9]{64}$/.test(query.signature || '')) throw invalid();
    if (!key.startsWith(`protected/repair-experiences/${tenantId}/`)) throw invalid();
    const signature = this.assetSignature(key, tenantId, ownerId, noteId, revision, expires);
    if (!timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(query.signature, 'hex'))) throw invalid();
    if (noteId) {
      const note = await this.noteRepo.findOne({ where: { id: noteId, tenantId, deletedAt: IsNull(), revision } });
      if (!note || note.createdBy !== ownerId || !this.assetKeys(note.blocks).has(key)) throw invalid();
    } else if (revision !== 0 || !key.startsWith(`protected/repair-experiences/${tenantId}/${ownerId}/`)) throw invalid();
    try { return await this.storage.getObject(key); } catch { throw invalid(); }
  }

  private async requireNotebook(user: AuthUser, officeId: number, repairType: string, edit: boolean) {
    const row = (await this.allowedNotebooks(user)).find(
      (item) => item.officeId === officeId && item.repairType === repairType,
    );
    if (!row || (edit && !row.canEdit)) {
      throw new ForbiddenException(edit ? '你没有编辑这个维修经验笔记本的权限' : '你没有查看这个维修经验笔记本的权限');
    }
    return row;
  }

  private async allowedNotebooks(user: AuthUser): Promise<AllowedNotebook[]> {
    const tenantId = this.tenantId(user);
    const access = await this.accessService.getAccess(user);
    const explicitView = this.accessService.hasPermission(
      access,
      ['experience-notes', 'app:experience-notes'],
      'view',
    );
    const explicitEdit = this.accessService.hasPermission(
      access,
      ['experience-notes', 'app:experience-notes'],
      'edit',
    );
    const rules = await this.ruleRepo.find({
      where: { tenantId, enabled: true },
      order: { officeId: 'ASC', sortOrder: 'ASC', id: 'ASC' },
    });
    const officeRules = rules.filter((rule) => !!rule.officeId);
    if (!officeRules.length) return [];
    const officeIds = [...new Set(officeRules.map((rule) => rule.officeId as number))];
    const offices = await this.officeRepo.find({ where: { tenantId, id: In(officeIds), enabled: true } });
    const officeNames = new Map(offices.map((office) => [office.id, office.name]));
    const scopedOfficeIds = explicitView ? await this.scopedOffices(tenantId, officeIds, access) : new Set<number>();

    /**
     * 办公室/管理员看**本管理处全部工种**；维修工只看**自己工种**那几本。
     *
     * 不这么收窄的话，一个电工只要有查看权就会看到 4 个管理处 × 9 个工种 = 36 本笔记本，
     * 一屏铺开谁都扫不过来（2026-09-04 反馈）。折叠只是把它收起来，没解决「不该给他看这么多」。
     *
     * 工种取员工档案里的 skills —— 和派单匹配用的是**同一份数据**（见
     * RepairsService.listTechnicians 的 skills.includes(skillScope)），值就是 repairType 编码。
     * 「办公室」沿用项目里既有的 canDispatch 口径（派单权或后台工单管理权，加企业/平台管理员），
     * 别再另立一套判定。
     */
    const mySkills = await this.skillFilterFor(user, access);

    const result = new Map<string, AllowedNotebook>();
    for (const rule of officeRules) {
      const officeId = rule.officeId as number;
      if (!officeNames.has(officeId)) continue;
      // 被设成这个类型的默认维修工 = 他真的在接这类单，无论档案里配没配工种都该看得到
      const auto = ruleAssigneeIds(rule).includes(user.id);
      const viaRole = explicitView && scopedOfficeIds.has(officeId);
      if (!auto && !viaRole) continue;
      if (!auto && mySkills && !mySkills.has(rule.repairType)) continue;
      const key = this.key(officeId, rule.repairType);
      const existing = result.get(key);
      result.set(key, {
        officeId,
        officeName: officeNames.get(officeId) || `管理处 ${officeId}`,
        repairType: rule.repairType,
        repairTypeLabel: rule.label,
        canEdit: !!(auto || (viaRole && explicitEdit) || existing?.canEdit),
        isPublic: false,
      });
    }

    /**
     * 每个看得到任何一本的管理处，再给一本「本管理处公共」（2026-09-04 要求）：
     * 不按工种收窄，管理处范围内的人都能看；范围内的维修工（任一类型规则里列了他的）
     * 和带编辑权的角色都能写。跨管理处仍然看不到 —— 公共的是「这个管理处」的公共。
     */
    const visibleOffices = new Set([...result.values()].map((item) => item.officeId));
    for (const officeId of officeIds) {
      if (!officeNames.has(officeId)) continue;
      const viaRole = explicitView && scopedOfficeIds.has(officeId);
      const autoInOffice = officeRules.some(
        (rule) => rule.officeId === officeId && ruleAssigneeIds(rule).includes(user.id),
      );
      if (!viaRole && !autoInOffice && !visibleOffices.has(officeId)) continue;
      result.set(this.key(officeId, OFFICE_PUBLIC_REPAIR_TYPE), {
        officeId,
        officeName: officeNames.get(officeId) || `管理处 ${officeId}`,
        repairType: OFFICE_PUBLIC_REPAIR_TYPE,
        repairTypeLabel: OFFICE_PUBLIC_REPAIR_TYPE_LABEL,
        canEdit: autoInOffice || (viaRole && explicitEdit),
        isPublic: true,
      });
    }
    // 同一管理处内公共本排最前，其余按类型名
    return [...result.values()].sort(
      (a, b) =>
        a.officeName.localeCompare(b.officeName, 'zh-Hans-CN') ||
        Number(b.isPublic) - Number(a.isPublic) ||
        a.repairTypeLabel.localeCompare(b.repairTypeLabel, 'zh-Hans-CN'),
    );
  }

  private async scopedOffices(tenantId: number, officeIds: number[], access: ResolvedAccess) {
    if (access.scopeAll) return new Set(officeIds);
    const allowedCommunities = new Set(access.communityIds || []);
    const matches = await Promise.all(
      officeIds.map(async (officeId) => ({
        officeId,
        communities: await this.accessService.officeCommunityIds(tenantId, officeId),
      })),
    );
    return new Set(matches.filter((item) => item.communities.some((id) => allowedCommunities.has(id))).map((item) => item.officeId));
  }

  private cleanBlocks(blocks: SaveRepairExperienceNoteDto['blocks']): ExperienceBlock[] {
    const documentBudget = experienceDocumentBudget();
    return blocks.map((block, index) => {
      const id = String(block.id || `block-${Date.now()}-${index}`).slice(0, 80);
      if (block.type === 'image') {
        const url = String(block.url || '').trim();
        if (!url || !/^(https?:\/\/|\/|uploads\/)/i.test(url)) {
          throw new BadRequestException(`第 ${index + 1} 个图片地址无效`);
        }
        return { id, type: 'image', url, caption: String(block.caption || '').trim().slice(0, 300) };
      }
      if (block.type === 'document') {
        const html = this.cleanDocumentHtml(String(block.html || ''), documentBudget);
        if (!this.documentText(html) && !/<img\b[^>]*\bsrc=|<table\b/i.test(html)) throw new BadRequestException('文档正文还是空的');
        return { id, type: 'document', html };
      }
      if (block.type === 'divider') return { id, type: 'divider' };
      const text = String(block.text || '').trim();
      if (!text) throw new BadRequestException(`第 ${index + 1} 个内容块还是空的`);
      return {
        id,
        type: block.type,
        text,
        ...(block.type === 'checklist' ? { checked: !!block.checked } : {}),
      };
    });
  }

  private summary(
    note: RepairExperienceNote,
    names: Map<number, string>,
    favorites: Set<number>,
  ): NoteSummary {
    const preview = (note.blocks || [])
      .filter((block) => block.type === 'document' ? !!block.html : block.type !== 'image' && !!block.text)
      .map((block) => block.type === 'document' ? this.documentText(block.html) : block.text)
      .join(' ')
      .slice(0, 100);
    return {
      id: note.id,
      officeId: note.officeId,
      repairType: note.repairType,
      title: note.title,
      preview,
      imageCount: (note.blocks || []).reduce((count, block) => count + (block.type === 'image' ? 1 : block.type === 'document' ? (block.html?.match(/<img\b/gi)?.length || 0) : 0), 0),
      revision: note.revision,
      updatedAt: note.updatedAt.toISOString(),
      updatedByName: note.updatedBy ? names.get(note.updatedBy) || '员工' : '系统',
      favorite: favorites.has(note.id),
    };
  }

  private async userNames(ids: Array<number | null>) {
    const unique = [...new Set(ids.filter((id): id is number => !!id))];
    if (!unique.length) return new Map<number, string>();
    const users = await this.userRepo.find({ where: { id: In(unique) }, select: ['id', 'name'] });
    return new Map(users.map((user) => [user.id, user.name || `员工 ${user.id}`]));
  }

  private key(officeId: number, repairType: string) {
    return `${officeId}:${repairType}`;
  }

  private cleanDocumentHtml(value: string, budget = experienceDocumentBudget()) {
    return cleanExperienceDocumentHtml(value, budget);
  }

  private documentText(html?: string) {
    const spaced = String(html || '').replace(/<\/(?:p|div|h[1-6]|li|blockquote|aside|figcaption|td|th|tr|table)>|<br\s*\/?>/gi, ' ');
    return sanitizeHtml(spaced, { allowedTags: [], allowedAttributes: {} })
      .replace(/\s+/g, ' ')
      .trim();
  }

  private tenantId(user: AuthUser) {
    if (!user.tenantId) throw new ForbiddenException('请先进入物业公司视角');
    return user.tenantId;
  }
}
