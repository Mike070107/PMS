import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { AuthUser } from '../../common/current-user.decorator';
import {
  ManagementOffice,
  RepairExperienceNote,
  RepairTypeRule,
  StaffProfile,
  User,
} from '../../entities';
import { AccessService, ResolvedAccess } from '../access/access.service';
import { ObjectStorageService } from '../upload/object-storage.service';
import { ruleAssigneeIds } from '../repairs/repair-rule-template';
import { SaveRepairExperienceNoteDto } from './dto';

interface AllowedNotebook {
  officeId: number;
  officeName: string;
  repairType: string;
  repairTypeLabel: string;
  canEdit: boolean;
}

type ExperienceBlock = RepairExperienceNote['blocks'][number];
type NoteSummary = {
  id: number; officeId: number; repairType: string; title: string; preview: string;
  imageCount: number; revision: number; updatedAt: string; updatedByName: string;
};

@Injectable()
export class RepairExperiencesService {
  constructor(
    @InjectRepository(RepairExperienceNote)
    private readonly noteRepo: Repository<RepairExperienceNote>,
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
  private withDisplayUrls(blocks: ExperienceBlock[] | null | undefined): ExperienceBlock[] {
    return (blocks || []).map((block) =>
      block.type === 'image' ? { ...block, url: this.storage.toDisplayUrl(block.url) } : block,
    );
  }

  async access(user: AuthUser) {
    const allowed = await this.allowedNotebooks(user);
    return {
      canView: allowed.length > 0,
      canEdit: allowed.some((item) => item.canEdit),
      notebookCount: allowed.length,
      emptyReason: allowed.length ? null : await this.emptyReason(user),
    };
  }

  /**
   * 一本笔记本都看不到时，告诉他到底缺什么。
   *
   * 最常见的是「员工档案里没配工种」—— 维修工现在只能看自己工种那几本，
   * 档案空着就一本都没有。给个空页面让人以为功能坏了，比说清原因糟糕得多。
   */
  private async emptyReason(user: AuthUser): Promise<string | null> {
    const access = await this.accessService.getAccess(user);
    const isOffice =
      access.isPlatformAdmin ||
      access.isTenantAdmin ||
      !!access.pages['app:dispatch']?.edit ||
      !!access.pages['work-orders']?.edit;
    if (isOffice) return null;
    if (!this.accessService.hasPermission(access, ['experience-notes', 'app:experience-notes'], 'view')) {
      return '你的角色还没有「维修经验」的查看权限，请让管理员在「业务角色」里勾上。';
    }
    const profile = await this.staffProfileRepo.findOne({
      where: { tenantId: this.tenantId(user), userId: user.id },
      select: ['userId', 'skills'],
    });
    if (!profile?.skills?.length) {
      return '你的员工档案里还没有配工种，所以看不到任何笔记本。请办公室在「用户管理」里给你配上工种（如电、水），配好后这里就会出现对应工种的笔记本。';
    }
    return '你所在管理处这几个工种还没有建笔记本，等办公室配好报修类型后就会出现。';
  }

  async list(user: AuthUser) {
    const allowed = await this.allowedNotebooks(user);
    if (!allowed.length) return [];
    const tenantId = this.tenantId(user);
    const notes = await this.noteRepo.find({
      where: { tenantId },
      order: { updatedAt: 'DESC', id: 'DESC' },
    });
    const visibleKeys = new Set(allowed.map((item) => this.key(item.officeId, item.repairType)));
    const visibleNotes = notes.filter((note) => visibleKeys.has(this.key(note.officeId, note.repairType)));
    const names = await this.userNames(visibleNotes.flatMap((note) => [note.createdBy, note.updatedBy]));
    const byKey = new Map<string, NoteSummary[]>();
    for (const note of visibleNotes) {
      const key = this.key(note.officeId, note.repairType);
      const rows = byKey.get(key) || [];
      rows.push(this.summary(note, names));
      byKey.set(key, rows);
    }
    return allowed.map((item) => ({
      ...item,
      notes: byKey.get(this.key(item.officeId, item.repairType)) || [],
    }));
  }

  async detail(id: number, user: AuthUser) {
    const note = await this.find(id, user);
    const allowed = await this.requireNotebook(user, note.officeId, note.repairType, false);
    const names = await this.userNames([note.createdBy, note.updatedBy]);
    return {
      ...this.summary(note, names),
      blocks: this.withDisplayUrls(note.blocks),
      createdAt: note.createdAt.toISOString(),
      createdByName: note.createdBy ? names.get(note.createdBy) || '员工' : '系统',
      canEdit: allowed.canEdit,
      officeName: allowed.officeName,
      repairTypeLabel: allowed.repairTypeLabel,
    };
  }

  async create(dto: SaveRepairExperienceNoteDto, user: AuthUser) {
    await this.requireNotebook(user, dto.officeId, dto.repairType, true);
    const note = this.noteRepo.create({
      tenantId: this.tenantId(user),
      officeId: dto.officeId,
      repairType: dto.repairType,
      title: dto.title.trim(),
      blocks: this.cleanBlocks(dto.blocks),
      revision: 1,
      createdBy: user.id,
      updatedBy: user.id,
    });
    const saved = await this.noteRepo.save(note);
    return this.detail(saved.id, user);
  }

  async update(id: number, dto: SaveRepairExperienceNoteDto, user: AuthUser) {
    const note = await this.find(id, user);
    await this.requireNotebook(user, note.officeId, note.repairType, true);
    if (dto.officeId !== note.officeId || dto.repairType !== note.repairType) {
      throw new BadRequestException('笔记所属管理处和报修类别不能修改');
    }
    if (dto.revision !== note.revision) {
      throw new ConflictException('这篇笔记刚被别人更新，请返回列表重新打开后再编辑');
    }
    note.title = dto.title.trim();
    note.blocks = this.cleanBlocks(dto.blocks);
    note.revision += 1;
    note.updatedBy = user.id;
    await this.noteRepo.save(note);
    return this.detail(note.id, user);
  }

  private async find(id: number, user: AuthUser) {
    const note = await this.noteRepo.findOne({ where: { id, tenantId: this.tenantId(user) } });
    if (!note) throw new NotFoundException('维修经验笔记不存在');
    return note;
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
    const isOffice =
      access.isPlatformAdmin ||
      access.isTenantAdmin ||
      !!access.pages['app:dispatch']?.edit ||
      !!access.pages['work-orders']?.edit;
    const mySkills = isOffice
      ? null
      : new Set(
          (
            await this.staffProfileRepo.findOne({
              where: { tenantId, userId: user.id },
              select: ['userId', 'skills'],
            })
          )?.skills ?? [],
        );

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
      });
    }
    return [...result.values()].sort(
      (a, b) => a.officeName.localeCompare(b.officeName, 'zh-Hans-CN') || a.repairTypeLabel.localeCompare(b.repairTypeLabel, 'zh-Hans-CN'),
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
    return blocks.map((block, index) => {
      const id = String(block.id || `block-${Date.now()}-${index}`).slice(0, 80);
      if (block.type === 'image') {
        const url = String(block.url || '').trim();
        if (!url || !/^(https?:\/\/|\/|uploads\/)/i.test(url)) {
          throw new BadRequestException(`第 ${index + 1} 个图片地址无效`);
        }
        return { id, type: 'image', url, caption: String(block.caption || '').trim().slice(0, 300) };
      }
      const text = String(block.text || '').trim();
      if (!text) throw new BadRequestException(`第 ${index + 1} 个内容块还是空的`);
      return { id, type: block.type, text };
    });
  }

  private summary(note: RepairExperienceNote, names: Map<number, string>): NoteSummary {
    const preview = (note.blocks || [])
      .filter((block) => block.type !== 'image' && block.text)
      .map((block) => block.text)
      .join(' ')
      .slice(0, 100);
    return {
      id: note.id,
      officeId: note.officeId,
      repairType: note.repairType,
      title: note.title,
      preview,
      imageCount: (note.blocks || []).filter((block) => block.type === 'image').length,
      revision: note.revision,
      updatedAt: note.updatedAt.toISOString(),
      updatedByName: note.updatedBy ? names.get(note.updatedBy) || '员工' : '系统',
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

  private tenantId(user: AuthUser) {
    if (!user.tenantId) throw new ForbiddenException('请先进入物业公司视角');
    return user.tenantId;
  }
}
