import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { nanoid } from 'nanoid';
import { In, Repository } from 'typeorm';
import { AuthUser } from '../../common/current-user.decorator';
import { QrGranularity, UserRole } from '../../common/enums';
import { ResolvedAccess } from '../access/access.service';
import { scopeCommunityIds } from '../access/scope.util';
import { compareBuildingLike } from '../../common/natural-order';
import { Building, Community, QrCode } from '../../entities';
import { WechatService, type WxEnvVersion } from '../auth/wechat.service';
import { ObjectStorageService } from '../upload/object-storage.service';
import {
  BackfillBuildingQrDto,
  BuildingQrQueryDto,
  CreateQrCodeDto,
  RegenerateQrDto,
} from './dto';

/** 单次批量生成的默认张数：171 个楼栋分批跑，避免打满 nginx 60s 读超时 */
const DEFAULT_BATCH_LIMIT = 40;
const MAX_BATCH_LIMIT = 100;
/** 微信 getUnlimited 有频率限制，串行偏慢、并发过高会 45009，取中间值 */
const IMAGE_CONCURRENCY = 3;

export interface BuildingQrRow {
  buildingId: number;
  communityId: number;
  communityName: string;
  lane: string | null;
  buildingNo: string;
  buildingText: string;
  qr: {
    id: number;
    token: string;
    caption: string | null;
    imageUrl: string | null;
    envVersion: string | null;
    targetPage: string | null;
    generatedAt: Date | null;
    lastError: string | null;
    enabled: boolean;
  } | null;
}

@Injectable()
export class QrService {
  private readonly logger = new Logger(QrService.name);

  constructor(
    @InjectRepository(QrCode)
    private readonly qrRepo: Repository<QrCode>,
    @InjectRepository(Community)
    private readonly communityRepo: Repository<Community>,
    @InjectRepository(Building)
    private readonly buildingRepo: Repository<Building>,
    private readonly config: ConfigService,
    private readonly storage: ObjectStorageService,
    private readonly wechat: WechatService,
  ) {}

  // ---------------- 查询 ----------------

  /**
   * 后台「楼栋码」主列表：每个楼栋一行，带上它的码和生成状态。
   * 没有码的楼栋也会出现（qr = null），批量补齐就是按这个口径补。
   */
  async listBuildingCodes(
    query: BuildingQrQueryDto,
    user: AuthUser,
    access?: ResolvedAccess,
  ): Promise<BuildingQrRow[]> {
    const tenantId = this.resolveTenantId(user, query.tenantId);
    const scope = scopeCommunityIds(access);
    if (scope) {
      if (!scope.length) return [];
      if (query.communityId && !scope.includes(query.communityId)) return [];
    }
    const buildings = (
      await this.buildingRepo.find({
        where: query.communityId
          ? { tenantId, communityId: query.communityId }
          : scope
            ? { tenantId, communityId: In(scope) }
            : { tenantId },
      })
    ).sort((a, b) => a.communityId - b.communityId || compareBuildingLike(a, b));
    if (!buildings.length) return [];

    const communityNames = await this.communityNameMap(
      tenantId,
      buildings.map((item) => item.communityId),
    );
    const codes = await this.qrRepo.find({
      where: {
        tenantId,
        granularity: QrGranularity.BUILDING,
        buildingId: In(buildings.map((item) => item.id)),
      },
      order: { id: 'ASC' },
    });
    const codeByBuilding = this.currentCodeByBuilding(codes);

    return buildings.map((building) => {
      const code = codeByBuilding.get(building.id) ?? null;
      return {
        buildingId: building.id,
        communityId: building.communityId,
        communityName: communityNames.get(building.communityId) ?? '',
        lane: building.lane,
        buildingNo: building.buildingNo,
        buildingText: this.buildingText(building),
        qr: code
          ? {
              id: code.id,
              token: code.token,
              caption: code.caption,
              // 存量记录里是 COS 直连地址（私有桶 → 403），读取时统一翻成代理地址
              imageUrl: this.storage.toDisplayUrl(code.imageUrl) || null,
              envVersion: code.envVersion,
              targetPage: code.targetPage,
              generatedAt: code.generatedAt,
              lastError: code.lastError,
              enabled: code.enabled,
            }
          : null,
      };
    });
  }

  /** 扫码解析：token 可能是裸 token，也可能是旧版普通二维码里的整条 URL */
  async resolve(rawToken: string) {
    const token = this.normalizeToken(rawToken);
    const qr = await this.qrRepo.findOne({ where: { token } });
    if (!qr || !qr.enabled) throw new NotFoundException('二维码无效或已停用');

    const [community, building] = await Promise.all([
      this.communityRepo.findOne({
        where: { id: qr.communityId, tenantId: qr.tenantId },
      }),
      qr.buildingId
        ? this.buildingRepo.findOne({
            where: { id: qr.buildingId, tenantId: qr.tenantId },
          })
        : Promise.resolve(null),
    ]);

    return {
      token: qr.token,
      tenantId: qr.tenantId,
      granularity: qr.granularity,
      placeNote: qr.placeNote,
      caption: qr.caption,
      community,
      building,
    };
  }

  // ---------------- 生成 ----------------

  /** 后台手工生成单张码（小区码走这里；楼栋码一般由新建楼栋/批量补齐自动生成） */
  async create(dto: CreateQrCodeDto, user: AuthUser) {
    const tenantId = this.resolveTenantId(user, dto.tenantId);
    const community = await this.communityRepo.findOne({
      where: { id: dto.communityId, tenantId },
    });
    if (!community) throw new NotFoundException('小区不存在');

    let building: Building | null = null;
    if (dto.granularity === QrGranularity.BUILDING) {
      if (!dto.buildingId) throw new BadRequestException('楼栋码必须指定楼栋');
      building = await this.buildingRepo.findOne({
        where: { id: dto.buildingId, tenantId, communityId: dto.communityId },
      });
      if (!building) throw new NotFoundException('楼栋不存在');

      // 楼栋码保持一栋一码：已有就复用，只补图，避免贴出去两张不同的码
      const existing = await this.findBuildingQr(tenantId, building.id);
      if (existing) {
        if (dto.placeNote !== undefined) existing.placeNote = dto.placeNote ?? null;
        existing.updatedBy = user.id;
        await this.qrRepo.save(existing);
        return this.withRelations(
          await this.generateImage(existing, { throwOnError: true }),
          community,
          building,
        );
      }
    }

    const saved = await this.qrRepo.save(
      this.qrRepo.create({
        tenantId,
        token: nanoid(16),
        granularity: dto.granularity,
        communityId: dto.communityId,
        buildingId: building?.id ?? null,
        placeNote: dto.placeNote ?? null,
        caption: this.buildCaption(community.name, building),
        enabled: true,
        createdBy: user.id,
        updatedBy: user.id,
      }),
    );
    return this.withRelations(
      await this.generateImage(saved, { throwOnError: true }),
      community,
      building,
    );
  }

  /**
   * 新建楼栋时自动建码。幂等：已有就原样返回。
   * 供 PropertiesService 调用 —— 任何失败都只记日志，绝不阻塞楼栋创建。
   */
  async ensureBuildingQr(
    tenantId: number,
    buildingId: number,
    operatorId: number | null,
    options: { withImage?: boolean } = {},
  ): Promise<QrCode | null> {
    try {
      const existing = await this.findBuildingQr(tenantId, buildingId);
      if (existing) {
        if (options.withImage !== false && !existing.imageUrl) {
          return this.generateImage(existing);
        }
        return existing;
      }

      const building = await this.buildingRepo.findOne({
        where: { id: buildingId, tenantId },
      });
      if (!building) return null;
      const community = await this.communityRepo.findOne({
        where: { id: building.communityId, tenantId },
      });

      const saved = await this.qrRepo.save(
        this.qrRepo.create({
          tenantId,
          token: nanoid(16),
          granularity: QrGranularity.BUILDING,
          communityId: building.communityId,
          buildingId: building.id,
          placeNote: null,
          caption: this.buildCaption(community?.name ?? '', building),
          enabled: true,
          createdBy: operatorId,
          updatedBy: operatorId,
        }),
      );
      if (options.withImage === false) return saved;
      return this.generateImage(saved);
    } catch (error) {
      this.logger.warn(
        `楼栋 #${buildingId} 自动建码失败（不影响楼栋创建）：${(error as Error).message}`,
      );
      return null;
    }
  }

  /**
   * 批量补齐楼栋码。分批跑：一次请求最多处理 limit 张图，返回 remaining 让前端接着调，
   * 既能显示真实进度，也不会把单次请求拖到网关超时。
   */
  async backfillBuildings(dto: BackfillBuildingQrDto, user: AuthUser) {
    const tenantId = this.resolveTenantId(user, dto.tenantId);
    const limit = Math.min(dto.limit ?? DEFAULT_BATCH_LIMIT, MAX_BATCH_LIMIT);

    const buildings = await this.buildingRepo.find({
      where: dto.communityId
        ? { tenantId, communityId: dto.communityId }
        : { tenantId },
      order: { id: 'ASC' },
    });
    if (!buildings.length) {
      return { totalBuildings: 0, created: 0, generated: 0, failed: [], remaining: 0 };
    }

    const communityNames = await this.communityNameMap(
      tenantId,
      buildings.map((item) => item.communityId),
    );
    const existing = await this.qrRepo.find({
      where: {
        tenantId,
        granularity: QrGranularity.BUILDING,
        buildingId: In(buildings.map((item) => item.id)),
      },
      order: { id: 'ASC' },
    });
    // 和列表页取的必须是同一张，否则会出现「补的是这张、页面上显示的是那张」
    const byBuilding = this.currentCodeByBuilding(existing);

    // 1) 先把缺的行补出来（纯数据库，很快，全部一次做完）
    let created = 0;
    const missingRows = buildings.filter((item) => !byBuilding.has(item.id));
    for (const building of missingRows) {
      const saved = await this.qrRepo.save(
        this.qrRepo.create({
          tenantId,
          token: nanoid(16),
          granularity: QrGranularity.BUILDING,
          communityId: building.communityId,
          buildingId: building.id,
          placeNote: null,
          caption: this.buildCaption(
            communityNames.get(building.communityId) ?? '',
            building,
          ),
          enabled: true,
          createdBy: user.id,
          updatedBy: user.id,
        }),
      );
      byBuilding.set(building.id, saved);
      created += 1;
    }

    // 2) 再补图。force = 连已有图的也重画（改了落地页/版本时用）
    const pending = buildings
      .map((item) => byBuilding.get(item.id))
      .filter((code): code is QrCode => !!code)
      .filter((code) => (dto.force ? true : !code.imageUrl));

    const batch = pending.slice(0, limit);
    const failed: Array<{ buildingId: number; buildingText: string; reason: string }> = [];
    let generated = 0;

    await this.mapWithConcurrency(batch, IMAGE_CONCURRENCY, async (code) => {
      const done = await this.generateImage(code);
      if (done.imageUrl && !done.lastError) {
        generated += 1;
        return;
      }
      const building = buildings.find((item) => item.id === code.buildingId);
      failed.push({
        buildingId: code.buildingId as number,
        buildingText: building ? this.buildingText(building) : '未知楼栋',
        reason: done.lastError || '未知错误',
      });
    });

    return {
      totalBuildings: buildings.length,
      created,
      generated,
      failed,
      remaining: Math.max(pending.length - batch.length, 0),
    };
  }

  /** 重新生成指定码的图片（改了文案/落地页/版本，或上次失败后重试） */
  async regenerate(dto: RegenerateQrDto, user: AuthUser) {
    const tenantId = this.resolveTenantId(user, dto.tenantId);
    const ids = dto.ids?.length ? dto.ids : [];
    const buildingIds = dto.buildingIds?.length ? dto.buildingIds : [];
    if (!ids.length && !buildingIds.length) {
      throw new BadRequestException('请指定要重新生成的二维码');
    }

    const codes = await this.qrRepo.find({
      where: [
        ...(ids.length ? [{ tenantId, id: In(ids) }] : []),
        ...(buildingIds.length ? [{ tenantId, buildingId: In(buildingIds) }] : []),
      ],
      order: { id: 'ASC' },
    });
    if (!codes.length) throw new NotFoundException('没有找到对应的二维码');

    const failed: Array<{ id: number; reason: string }> = [];
    let generated = 0;
    await this.mapWithConcurrency(codes, IMAGE_CONCURRENCY, async (code) => {
      if (dto.refreshCaption) {
        const [community, building] = await Promise.all([
          this.communityRepo.findOne({ where: { id: code.communityId, tenantId } }),
          code.buildingId
            ? this.buildingRepo.findOne({ where: { id: code.buildingId, tenantId } })
            : Promise.resolve(null),
        ]);
        code.caption = this.buildCaption(community?.name ?? '', building ?? null);
      }
      code.updatedBy = user.id;
      const done = await this.generateImage(code);
      if (done.imageUrl && !done.lastError) generated += 1;
      else failed.push({ id: code.id, reason: done.lastError || '未知错误' });
    });

    return { total: codes.length, generated, failed };
  }

  // ---------------- 内部 ----------------

  /**
   * 生成并上传小程序码。默认不抛错：把失败原因写进 last_error 由后台展示，
   * 这样批量补齐里一张失败不会掀翻整批。
   */
  private async generateImage(
    qr: QrCode,
    options: { throwOnError?: boolean } = {},
  ): Promise<QrCode> {
    const page = this.entryPage();
    const envVersion = this.envVersion();
    try {
      const png = await this.wechat.getUnlimitedWxaCode(
        { scene: qr.token, page, width: 430, envVersion },
        'owner',
      );
      const stored = await this.storage.putBufferAtKey(
        `qr-codes/wxa/${qr.token}.png`,
        png,
        'image/png',
      );
      qr.imageUrl = stored.fileUrl;
      qr.targetPage = page;
      qr.envVersion = envVersion;
      qr.generatedAt = new Date();
      qr.lastError = null;
      return this.qrRepo.save(qr);
    } catch (error) {
      const reason = (error as Error).message || '生成失败';
      qr.lastError = reason.slice(0, 300);
      await this.qrRepo.save(qr);
      this.logger.warn(`二维码 #${qr.id}(${qr.token}) 生成失败：${reason}`);
      if (options.throwOnError) throw error;
      return qr;
    }
  }

  /**
   * 同一楼栋历史上可能存在多张码（改过、停用过）。
   * 统一口径：只认「最新的那张启用中的码」，全停用就等同于没有码，下次会新建一张。
   * 列表、批量补齐、单栋查询都走这个口径，否则页面显示和实际补的会对不上。
   */
  private currentCodeByBuilding(codes: QrCode[]): Map<number, QrCode> {
    const map = new Map<number, QrCode>();
    for (const code of codes) {
      if (!code.buildingId || !code.enabled) continue;
      const kept = map.get(code.buildingId);
      if (!kept || code.id > kept.id) map.set(code.buildingId, code);
    }
    return map;
  }

  private findBuildingQr(tenantId: number, buildingId: number) {
    return this.qrRepo.findOne({
      where: {
        tenantId,
        buildingId,
        granularity: QrGranularity.BUILDING,
        enabled: true,
      },
      order: { id: 'DESC' },
    });
  }

  private async communityNameMap(tenantId: number, communityIds: number[]) {
    const unique = Array.from(new Set(communityIds));
    if (!unique.length) return new Map<number, string>();
    const rows = await this.communityRepo.find({
      where: { tenantId, id: In(unique) },
    });
    return new Map(rows.map((item) => [item.id, item.name]));
  }

  /** 「228弄3号」/ 无弄时「3号」 */
  private buildingText(building: Building): string {
    return building.lane
      ? `${building.lane}弄${building.buildingNo}号`
      : `${building.buildingNo}号`;
  }

  /** 印在码旁边的文案，生成时定好落库 */
  private buildCaption(communityName: string, building: Building | null): string {
    const place = building
      ? [communityName, this.buildingText(building)].filter(Boolean).join(' ')
      : communityName;
    return `${place} · 扫码报修`.trim();
  }

  /** 扫码进来的落地页；未入驻的引导由小程序端在该页判断后跳入驻页 */
  private entryPage(): string {
    const page = this.config.get<string>(
      'WX_OWNER_QR_PAGE',
      'pages/repair-create/repair-create',
    );
    return page.replace(/^\/+/, '').split('?')[0];
  }

  private envVersion(): WxEnvVersion {
    const value = this.config.get<string>('WX_OWNER_QR_ENV_VERSION', 'release');
    return value === 'trial' || value === 'develop' ? value : 'release';
  }

  /**
   * 兼容旧版普通二维码：里面存的是 `https://.../qr/<token>`，
   * 小程序 wx.scanCode 拿到的是整条 URL，这里统一还原成 token。
   */
  private normalizeToken(raw: string): string {
    const value = (raw || '').trim();
    if (!value) return value;
    const match = value.match(/\/qr\/([A-Za-z0-9_-]{6,32})\/?$/);
    if (match) return match[1];
    if (/^https?:\/\//i.test(value)) {
      const last = value.split(/[?#]/)[0].replace(/\/+$/, '').split('/').pop();
      return last || value;
    }
    return value;
  }

  private async mapWithConcurrency<T>(
    items: T[],
    concurrency: number,
    worker: (item: T) => Promise<void>,
  ): Promise<void> {
    let cursor = 0;
    const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (cursor < items.length) {
        const item = items[cursor++];
        await worker(item);
      }
    });
    await Promise.all(runners);
  }

  private withRelations(qr: QrCode, community: Community, building: Building | null) {
    return {
      ...qr,
      imageUrl: this.storage.toDisplayUrl(qr.imageUrl) || null,
      entryUrl: this.buildEntryUrl(qr.token),
      community,
      building,
    };
  }

  /** 旧版普通二维码里的链接，仅作为兼容展示保留 */
  private buildEntryUrl(token: string): string {
    const baseUrl = this.config.get<string>('OWNER_MINIAPP_QR_BASE_URL', '');
    if (!baseUrl) return `/qr/${token}`;
    return `${baseUrl.replace(/\/+$/, '')}/qr/${token}`;
  }

  private resolveTenantId(user: AuthUser, requestedTenantId?: number): number {
    if (user.tenantId) {
      if (requestedTenantId && requestedTenantId !== user.tenantId) {
        throw new ForbiddenException('租户不匹配');
      }
      return user.tenantId;
    }
    if (user.role === UserRole.SUPERADMIN) {
      if (!requestedTenantId) {
        throw new BadRequestException('superadmin 需要指定 tenantId');
      }
      return requestedTenantId;
    }
    throw new ForbiddenException('缺少租户范围');
  }
}
