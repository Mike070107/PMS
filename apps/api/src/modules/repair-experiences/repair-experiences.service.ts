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
  User,
} from '../../entities';
import { AccessService, ResolvedAccess } from '../access/access.service';
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
    private readonly accessService: AccessService,
  ) {}

  async access(user: AuthUser) {
    const allowed = await this.allowedNotebooks(user);
    return {
      canView: allowed.length > 0,
      canEdit: allowed.some((item) => item.canEdit),
      notebookCount: allowed.length,
    };
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
      blocks: note.blocks || [],
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
    const result = new Map<string, AllowedNotebook>();
    for (const rule of officeRules) {
      const officeId = rule.officeId as number;
      if (!officeNames.has(officeId)) continue;
      const auto = ruleAssigneeIds(rule).includes(user.id);
      const viaRole = explicitView && scopedOfficeIds.has(officeId);
      if (!auto && !viaRole) continue;
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
