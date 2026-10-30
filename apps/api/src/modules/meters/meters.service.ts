import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, LessThan, Repository } from 'typeorm';
import { nanoid } from 'nanoid';
import QRCode from 'qrcode';
import type { AuthUser } from '../../common/current-user.decorator';
import { UserRole } from '../../common/enums';
import {
  Building,
  Community,
  House,
  Meter,
  MeterCharge,
  MeterOcrSample,
  MeterReading,
  User,
  type MeterReadingAnomaly,
  type MeterType,
} from '../../entities';
import { ResolvedAccess } from '../access/access.service';
import { WechatService } from '../auth/wechat.service';
import { ObjectStorageService } from '../upload/object-storage.service';
import { MeterOcrService } from './meter-ocr.service';
import {
  amountCentsOf,
  computeUsage,
  dateOf,
  periodOf,
  round3,
  yuanToCents,
} from './meter-billing.util';
import { formatReadingValue, normalizeMeterNo } from './meter-ocr.util';
import type {
  AdjustChargeDto,
  ChargeQueryDto,
  CreateMeterDto,
  CreateReadingDto,
  MeterQueryDto,
  MeterSummaryQueryDto,
  OcrQueryDto,
  OcrSampleQueryDto,
  PayChargeDto,
  ReadingQueryDto,
  ReviewReadingDto,
  UpdateMeterDto,
  UpdateOcrSampleDto,
  UpdateReadingDto,
} from './dto';

const TYPE_META: Record<MeterType, { label: string; unit: string; integerDigits: number; decimalDigits: number }> = {
  water: { label: '水表', unit: 'm³', integerDigits: 5, decimalDigits: 0 },
  electricity: { label: '电表', unit: 'kWh', integerDigits: 6, decimalDigits: 2 },
  gas: { label: '燃气表', unit: 'm³', integerDigits: 8, decimalDigits: 2 },
  heat: { label: '热量表', unit: 'GJ', integerDigits: 6, decimalDigits: 2 },
};

const ANOMALY_LABELS: Record<MeterReadingAnomaly, string> = {
  low_confidence: '识别置信度低',
  meter_no_mismatch: '表号不一致',
  rollover: '表计归零',
  zero_usage: '本次零用量',
  high_usage: '用量突增',
  backdated: '补录历史时间',
  no_location: '无现场定位',
  photo_missing: '未留原图',
};

const PHOTO_KEY_RE = /^uploads\/[A-Za-z0-9/_\-.]+$/;

@Injectable()
export class MetersService {
  constructor(
    @InjectRepository(Meter) private readonly meterRepo: Repository<Meter>,
    @InjectRepository(MeterReading) private readonly readingRepo: Repository<MeterReading>,
    @InjectRepository(MeterCharge) private readonly chargeRepo: Repository<MeterCharge>,
    @InjectRepository(MeterOcrSample) private readonly sampleRepo: Repository<MeterOcrSample>,
    @InjectRepository(Community) private readonly communityRepo: Repository<Community>,
    @InjectRepository(House) private readonly houseRepo: Repository<House>,
    @InjectRepository(Building) private readonly buildingRepo: Repository<Building>,
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    private readonly dataSource: DataSource,
    private readonly storage: ObjectStorageService,
    private readonly ocr: MeterOcrService,
    private readonly wechat: WechatService,
  ) {}

  // ---------------------------------------------------------------- 档案

  async listMeters(query: MeterQueryDto, user: AuthUser, access: ResolvedAccess) {
    const tenantId = this.resolveTenantId(user);
    const where: string[] = ['m.tenant_id = $1'];
    const params: unknown[] = [tenantId];
    const push = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };

    if (query.meterType) where.push(`m.meter_type = ${push(query.meterType)}`);
    if (query.status) where.push(`m.status = ${push(query.status)}`);
    if (query.communityId) where.push(`m.community_id = ${push(query.communityId)}`);
    if (query.keyword?.trim()) {
      const kw = `%${query.keyword.trim()}%`;
      const p = push(kw);
      where.push(`(m.meter_no ILIKE ${p} OR m.name ILIKE ${p} OR m.install_address ILIKE ${p} OR m.owner_name ILIKE ${p} OR m.owner_phone ILIKE ${p} OR h.room_no ILIKE ${p})`);
    }
    this.applyCommunityScope(where, params, access, 'm.community_id');
    if (query.due) {
      const start = this.monthStart(periodOf(new Date()));
      where.push(`m.status = 'active'`);
      where.push(`(m.last_reading_at IS NULL OR m.last_reading_at < ${push(start)})`);
    }

    const page = Math.max(1, Math.round(query.page || 1));
    const pageSize = Math.min(200, Math.max(1, Math.round(query.pageSize || 50)));
    const offset = (page - 1) * pageSize;
    const from = `
      FROM meters m
      LEFT JOIN communities c ON c.id = m.community_id
      LEFT JOIN houses h ON h.id = m.house_id
      LEFT JOIN buildings b ON b.id = h.building_id
      WHERE ${where.join(' AND ')}
    `;
    const countRows = await this.dataSource.query(`SELECT count(*)::int AS total ${from}`, params);
    const rows = await this.dataSource.query(
      `SELECT m.*, c.name AS community_name, h.room_no, b.building_no,
        (SELECT count(*)::int FROM meter_readings r WHERE r.meter_id = m.id AND r.status = 'confirmed') AS reading_count,
        (SELECT COALESCE(sum(cg.receivable_cents - cg.paid_cents), 0)::int FROM meter_charges cg
           WHERE cg.meter_id = m.id AND cg.status IN ('unpaid', 'partial')) AS unpaid_cents,
        (SELECT r.usage_value FROM meter_readings r WHERE r.meter_id = m.id AND r.status = 'confirmed'
           ORDER BY r.read_at DESC, r.id DESC LIMIT 1) AS last_usage
       ${from}
       ORDER BY c.name NULLS LAST, b.building_no NULLS LAST, m.sort_order, m.id
       LIMIT ${pageSize} OFFSET ${offset}`,
      params,
    );
    const summary = await this.dataSource.query(
      `SELECT count(*)::int AS total,
         count(*) FILTER (WHERE m.meter_type = 'water')::int AS water,
         count(*) FILTER (WHERE m.meter_type = 'electricity')::int AS electricity,
         count(*) FILTER (WHERE m.meter_type = 'gas')::int AS gas,
         count(*) FILTER (WHERE m.meter_type = 'heat')::int AS heat
       ${from}`,
      params,
    );
    return {
      rows: rows.map((row: any) => this.mapMeter(row)),
      total: countRows[0]?.total ?? 0,
      page,
      pageSize,
      summary: summary[0] ?? { total: 0, water: 0, electricity: 0, gas: 0, heat: 0 },
    };
  }

  async meterDetail(id: number, user: AuthUser, access: ResolvedAccess) {
    const tenantId = this.resolveTenantId(user);
    const meter = await this.findMeter(id, tenantId);
    this.assertMeterScope(meter, access);
    const [readings, charges, stats] = await Promise.all([
      this.dataSource.query(
        `SELECT r.*, cg.id AS charge_id, cg.status AS charge_status, cg.receivable_cents, cg.paid_cents
         FROM meter_readings r LEFT JOIN meter_charges cg ON cg.reading_id = r.id
         WHERE r.meter_id = $1 AND r.tenant_id = $2 ORDER BY r.read_at DESC, r.id DESC LIMIT 30`,
        [id, tenantId],
      ),
      this.dataSource.query(
        `SELECT * FROM meter_charges WHERE meter_id = $1 AND tenant_id = $2 ORDER BY period DESC, id DESC LIMIT 24`,
        [id, tenantId],
      ),
      this.dataSource.query(
        `SELECT
           COALESCE(sum(r.usage_value) FILTER (WHERE r.status = 'confirmed' AND r.read_at >= date_trunc('year', now())), 0) AS year_usage,
           count(*) FILTER (WHERE r.status = 'confirmed')::int AS reading_count,
           COALESCE(sum(cg.receivable_cents - cg.paid_cents) FILTER (WHERE cg.status IN ('unpaid', 'partial')), 0)::int AS unpaid_cents
         FROM meter_readings r LEFT JOIN meter_charges cg ON cg.reading_id = r.id
         WHERE r.meter_id = $1 AND r.tenant_id = $2`,
        [id, tenantId],
      ),
    ]);
    const view = this.mapMeter({
      ...meter,
      community_name: meter.communityId
        ? (await this.communityRepo.findOne({ where: { id: meter.communityId, tenantId } }))?.name
        : null,
    });
    return {
      meter: view,
      readings: readings.map((row: any) => this.mapReading(row, meter)),
      charges: charges.map((row: any) => this.mapCharge(row, meter)),
      stats: {
        yearUsage: Number(stats[0]?.year_usage || 0),
        readingCount: Number(stats[0]?.reading_count || 0),
        unpaidCents: Number(stats[0]?.unpaid_cents || 0),
      },
      qrPayload: this.qrPayload(meter),
    };
  }

  async createMeter(dto: CreateMeterDto, user: AuthUser, access: ResolvedAccess) {
    const tenantId = this.resolveTenantId(user);
    const meta = TYPE_META[dto.meterType];
    const house = dto.houseId ? await this.assertHouse(dto.houseId, tenantId) : null;
    const houseBuilding = house ? await this.buildingRepo.findOne({ where: { id: house.buildingId, tenantId } }) : null;
    const communityId = dto.communityId ?? houseBuilding?.communityId ?? null;
    if (communityId) {
      await this.assertCommunity(communityId, tenantId);
      this.assertCommunityScope(communityId, access);
    }
    const meterNo = dto.meterNo.trim();
    const exists = await this.meterRepo.findOne({ where: { tenantId, meterType: dto.meterType, meterNo } });
    if (exists) throw new ConflictException(`表号 ${meterNo} 已存在（${meta.label}）`);

    const now = new Date();
    const initialReading = dto.initialReading === undefined ? null : round3(dto.initialReading);
    const initialReadingAt = dto.initialReadingAt
      ? this.parseDate(dto.initialReadingAt)
      : initialReading !== null
        ? now
        : null;
    const meter = this.meterRepo.create({
      tenantId,
      meterNo,
      meterType: dto.meterType,
      name: dto.name?.trim() || null,
      spec: dto.spec?.trim() || null,
      manufacturer: dto.manufacturer?.trim() || null,
      model: dto.model?.trim() || null,
      multiplier: String(dto.multiplier ?? 1),
      integerDigits: dto.integerDigits ?? meta.integerDigits,
      decimalDigits: dto.decimalDigits ?? meta.decimalDigits,
      unit: dto.unit?.trim() || meta.unit,
      communityId,
      houseId: house?.id ?? null,
      installAddress: dto.installAddress?.trim() || null,
      latitude: dto.latitude === undefined ? null : String(dto.latitude),
      longitude: dto.longitude === undefined ? null : String(dto.longitude),
      ownerName: dto.ownerName?.trim() || null,
      ownerPhone: dto.ownerPhone?.trim() || null,
      unitPriceCents: Math.max(0, Math.round(dto.unitPriceCents ?? 0)),
      billingEnabled: dto.billingEnabled ?? true,
      initialReading: initialReading === null ? null : initialReading.toFixed(3),
      initialReadingAt,
      lastReadingValue: null,
      lastReadingAt: null,
      status: dto.status ?? 'active',
      qrToken: nanoid(18),
      photoKey: this.photoKeyOf(dto.photoUrl, dto.photoKey),
      photoUrl: dto.photoUrl ? this.storage.toDisplayUrl(dto.photoUrl) : null,
      sortOrder: dto.sortOrder ?? 0,
      remark: dto.remark?.trim() || null,
      createdBy: user.id,
      updatedBy: user.id,
    });
    try {
      await this.meterRepo.save(meter);
    } catch (error: any) {
      if (String(error?.code) === '23505') throw new ConflictException(`表号 ${meterNo} 已存在`);
      throw error;
    }
    return this.meterDetail(meter.id, user, access);
  }

  async updateMeter(id: number, dto: UpdateMeterDto, user: AuthUser, access: ResolvedAccess) {
    const tenantId = this.resolveTenantId(user);
    const meter = await this.findMeter(id, tenantId);
    this.assertMeterScope(meter, access);

    if (dto.meterNo !== undefined) {
      const meterNo = dto.meterNo.trim();
      if (!meterNo) throw new BadRequestException('表号不能为空');
      meter.meterNo = meterNo;
    }
    if (dto.meterType !== undefined) meter.meterType = dto.meterType;
    if (dto.meterNo !== undefined || dto.meterType !== undefined) {
      const duplicate = await this.meterRepo.findOne({
        where: { tenantId, meterType: meter.meterType, meterNo: meter.meterNo },
      });
      if (duplicate && duplicate.id !== id) {
        throw new ConflictException(`表号 ${meter.meterNo} 已存在`);
      }
    }

    if (dto.communityId !== undefined) {
      if (dto.communityId === 0) meter.communityId = null;
      else {
        await this.assertCommunity(dto.communityId, tenantId);
        this.assertCommunityScope(dto.communityId, access);
        meter.communityId = dto.communityId;
      }
    }
    if (dto.houseId !== undefined) {
      if (dto.houseId === 0) meter.houseId = null;
      else {
        const house = await this.assertHouse(dto.houseId, tenantId);
        meter.houseId = house.id;
        if (dto.communityId === undefined) {
          const building = await this.buildingRepo.findOne({ where: { id: house.buildingId, tenantId } });
          if (building) {
            this.assertCommunityScope(building.communityId, access);
            meter.communityId = building.communityId;
          }
        }
      }
    }

    const textFields: Array<keyof UpdateMeterDto> = [
      'name', 'spec', 'manufacturer', 'model', 'unit', 'installAddress', 'ownerName', 'ownerPhone', 'remark',
    ];
    for (const field of textFields) {
      const value = dto[field];
      if (value === undefined) continue;
      (meter as unknown as Record<string, unknown>)[field] = String(value).trim() || null;
    }
    if (dto.multiplier !== undefined) meter.multiplier = String(dto.multiplier);
    if (dto.integerDigits !== undefined) meter.integerDigits = dto.integerDigits;
    if (dto.decimalDigits !== undefined) meter.decimalDigits = dto.decimalDigits;
    if (dto.latitude !== undefined) meter.latitude = String(dto.latitude);
    if (dto.longitude !== undefined) meter.longitude = String(dto.longitude);
    if (dto.unitPriceCents !== undefined) meter.unitPriceCents = Math.max(0, Math.round(dto.unitPriceCents));
    if (dto.billingEnabled !== undefined) meter.billingEnabled = dto.billingEnabled;
    if (dto.status !== undefined) meter.status = dto.status;
    if (dto.sortOrder !== undefined) meter.sortOrder = dto.sortOrder;
    if (dto.initialReading !== undefined) {
      meter.initialReading = round3(dto.initialReading).toFixed(3);
      meter.initialReadingAt = dto.initialReadingAt ? this.parseDate(dto.initialReadingAt) : meter.initialReadingAt ?? new Date();
    } else if (dto.initialReadingAt !== undefined) {
      meter.initialReadingAt = this.parseDate(dto.initialReadingAt);
    }
    if (dto.photoUrl !== undefined) {
      meter.photoUrl = dto.photoUrl ? this.storage.toDisplayUrl(dto.photoUrl) : null;
      meter.photoKey = this.photoKeyOf(dto.photoUrl, dto.photoKey);
    }
    meter.updatedBy = user.id;
    try {
      await this.meterRepo.save(meter);
    } catch (error: any) {
      if (String(error?.code) === '23505') throw new ConflictException('表号已存在');
      throw error;
    }
    return this.meterDetail(id, user, access);
  }

  async deleteMeter(id: number, user: AuthUser, access: ResolvedAccess) {
    const tenantId = this.resolveTenantId(user);
    const meter = await this.findMeter(id, tenantId);
    this.assertMeterScope(meter, access);
    const [readings, charges] = await Promise.all([
      this.readingRepo.count({ where: { tenantId, meterId: id } }),
      this.chargeRepo.count({ where: { tenantId, meterId: id } }),
    ]);
    if (readings || charges) {
      throw new BadRequestException('这块表已有抄表/账单记录，不能删除；请改成「停用」保留历史');
    }
    await this.meterRepo.delete({ id, tenantId });
    return { ok: true };
  }

  async lookup(rawCode: string, user: AuthUser, access: ResolvedAccess) {
    const tenantId = this.resolveTenantId(user);
    const code = String(rawCode || '').trim();
    if (!code) throw new BadRequestException('缺少表二维码/表号');
    const token = code.replace(/^PMSMETER:/i, '').trim();
    let rows = await this.meterRepo.find({ where: { tenantId, qrToken: token } });
    if (!rows.length) {
      rows = await this.meterRepo.find({ where: { tenantId, meterNo: code } });
    }
    const scoped = rows.filter((meter) => this.inScope(meter, access));
    return { rows: scoped.map((meter) => this.mapMeter(meter)) };
  }

  async qrCode(id: number, user: AuthUser, access: ResolvedAccess) {
    const tenantId = this.resolveTenantId(user);
    const meter = await this.findMeter(id, tenantId);
    this.assertMeterScope(meter, access);
    const payload = this.qrPayload(meter);
    const dataUrl = await QRCode.toDataURL(payload, {
      width: 360,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#1f334a', light: '#ffffff' },
    });

    // 小程序码：微信扫一扫直接打开员工端抄表页；scene 只放 qrToken，页面自己查表。
    let wxaCodeDataUrl = '';
    let wxaCodeEnv = '';
    let wxaCodeError = '';
    if (this.wechat.isConfigured('staff')) {
      for (const env of ['release', 'trial'] as const) {
        try {
          const buffer = await this.wechat.getUnlimitedWxaCode(
            {
              scene: `m=${meter.qrToken}`,
              page: 'pages/meter-read/meter-read',
              width: 430,
              envVersion: env,
              checkPath: env === 'release',
            },
            'staff',
          );
          const mime = buffer[0] === 0xff && buffer[1] === 0xd8 ? 'image/jpeg' : 'image/png';
          wxaCodeDataUrl = `data:${mime};base64,${buffer.toString('base64')}`;
          wxaCodeEnv = env;
          wxaCodeError = '';
          break;
        } catch (error) {
          wxaCodeError = error instanceof Error ? error.message : '生成小程序码失败';
        }
      }
    } else {
      wxaCodeError = '未配置员工端微信 AppID/Secret，暂时只能使用普通二维码';
    }

    return {
      payload,
      dataUrl,
      meterNo: meter.meterNo,
      wxaCodeDataUrl,
      wxaCodeEnv,
      wxaCodeError,
    };
  }

  // ---------------------------------------------------------------- 识别

  async recognize(id: number, dto: OcrQueryDto, user: AuthUser, access: ResolvedAccess) {
    const tenantId = this.resolveTenantId(user);
    const meter = await this.findMeter(id, tenantId);
    this.assertMeterScope(meter, access);
    return this.ocr.recognize(meter, dto.imageKey, dto.crop, user);
  }

  async ocrHealth() {
    return this.ocr.health();
  }

  // ---------------------------------------------------------------- 抄表

  async createReading(id: number, dto: CreateReadingDto, user: AuthUser, access: ResolvedAccess) {
    const tenantId = this.resolveTenantId(user);
    if (dto.clientRequestId) {
      const existing = await this.readingRepo.findOne({
        where: { tenantId, clientRequestId: dto.clientRequestId },
      });
      if (existing) {
        const meter = await this.findMeter(existing.meterId, tenantId);
        this.assertMeterScope(meter, access);
        return this.readingResult(existing, meter);
      }
    }
    const operatorName = await this.operatorName(user.id, tenantId);
    const result = await this.dataSource.transaction(async (manager) => {
      const locked = await manager.query(
        `SELECT id FROM meters WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
        [id, tenantId],
      );
      if (!locked.length) throw new NotFoundException('仪表不存在');
      const meter = await manager.findOne(Meter, { where: { id, tenantId } });
      if (!meter) throw new NotFoundException('仪表不存在');
      this.assertMeterScope(meter, access);
      if (meter.status !== 'active') throw new BadRequestException('仪表已停用，不能继续抄表');

      const readAt = dto.readAt ? this.parseDate(dto.readAt) : new Date();
      if (readAt.getTime() > Date.now() + 10 * 60 * 1000) {
        throw new BadRequestException('抄表时间不能晚于当前时间');
      }
      if (readAt.getTime() < Date.now() - 180 * 24 * 3600 * 1000) {
        throw new BadRequestException('抄表时间超过 180 天，请核对手机时间');
      }
      const last = await manager.findOne(MeterReading, {
        where: { tenantId, meterId: meter.id, status: 'confirmed' },
        order: { readAt: 'DESC', id: 'DESC' },
      });
      const pending = await manager.findOne(MeterReading, {
        where: { tenantId, meterId: meter.id, status: 'pending' },
        order: { readAt: 'DESC', id: 'DESC' },
      });
      if (pending) {
        throw new BadRequestException('这块表已有待复核的抄表记录，请先复核后再抄下一次');
      }
      if (last && readAt.getTime() < last.readAt.getTime()) {
        throw new BadRequestException(
          `这次拍照时间早于最近一次抄表（${this.formatDateTime(last.readAt)}），请按顺序补录，或让管理员在后台修正`,
        );
      }

      const previousValue = last
        ? Number(last.readingValue)
        : meter.initialReading !== null &&
            (!meter.initialReadingAt || meter.initialReadingAt.getTime() <= readAt.getTime())
          ? Number(meter.initialReading)
          : null;
      const readingValue = round3(dto.readingValue);
      const usageResult = computeUsage(
        readingValue,
        previousValue,
        Number(meter.multiplier),
        meter.integerDigits,
      );
      if (usageResult.error) throw new BadRequestException(usageResult.error);

      const anomalies: MeterReadingAnomaly[] = [];
      if (dto.ocr?.status === 'failed') anomalies.push('low_confidence');
      else if (dto.ocr?.confidence !== undefined && dto.ocr.confidence < 75) anomalies.push('low_confidence');
      if (dto.ocr?.meterNo && normalizeMeterNo(dto.ocr.meterNo) !== normalizeMeterNo(meter.meterNo)) {
        anomalies.push('meter_no_mismatch');
      }
      if (usageResult.rollover) anomalies.push('rollover');
      if (usageResult.usage !== null && Math.abs(usageResult.usage) < 0.0005) anomalies.push('zero_usage');
      if (dto.source !== 'manual' && !dto.photoKey && !dto.photoUrl) anomalies.push('photo_missing');
      if (dto.latitude === undefined || dto.longitude === undefined) anomalies.push('no_location');
      if (Date.now() - readAt.getTime() > 24 * 3600 * 1000) anomalies.push('backdated');
      if (usageResult.usage !== null && usageResult.usage > 0) {
        const recent = await manager.find(MeterReading, {
          where: { tenantId, meterId: meter.id, status: 'confirmed' },
          order: { readAt: 'DESC', id: 'DESC' },
          take: 6,
        });
        const usages = recent
          .map((row) => Number(row.usageValue))
          .filter((value) => Number.isFinite(value) && value > 0);
        if (usages.length) {
          const avg = usages.reduce((sum, value) => sum + value, 0) / usages.length;
          if (avg > 0 && usageResult.usage > Math.max(avg * 3, avg + 10)) anomalies.push('high_usage');
        }
      }

      const photoKey = this.photoKeyOf(dto.photoUrl, dto.photoKey);
      const reading = manager.create(MeterReading, {
        tenantId,
        meterId: meter.id,
        meterNoSnapshot: meter.meterNo,
        readingValue: readingValue.toFixed(3),
        previousValue: previousValue === null ? null : previousValue.toFixed(3),
        usageValue: usageResult.usage === null ? null : usageResult.usage.toFixed(3),
        readAt,
        source: dto.source ?? 'photo',
        photoKey,
        photoUrl: dto.photoUrl
          ? this.storage.toDisplayUrl(dto.photoUrl)
          : photoKey || null,
        photoWidth: dto.photoWidth ?? null,
        photoHeight: dto.photoHeight ?? null,
        roi: dto.roi ?? null,
        ocrStatus: dto.ocr?.status ?? (dto.ocr ? 'success' : 'skipped'),
        ocrProvider: dto.ocr?.provider ?? null,
        ocrConfidence: dto.ocr?.confidence === undefined ? null : String(dto.ocr.confidence),
        ocrText: dto.ocr?.text ?? null,
        ocrMeterNo: dto.ocr?.meterNo ?? null,
        ocrRaw: dto.ocr?.raw ?? null,
        orientation: dto.ocr?.orientation ?? 0,
        status: 'pending',
        anomalyFlags: [...new Set(anomalies)],
        latitude: dto.latitude === undefined ? null : String(dto.latitude),
        longitude: dto.longitude === undefined ? null : String(dto.longitude),
        gpsAccuracy: dto.accuracy === undefined ? null : String(dto.accuracy),
        operatorId: user.id,
        operatorName,
        clientRequestId: dto.clientRequestId ?? null,
        note: dto.note?.trim() || null,
        createdBy: user.id,
        updatedBy: user.id,
      });
      const saved = await manager.save(reading);
      // 待复核：先不动表头最近读数，也不出账；复核通过后再更新表头并生成账单。
      return { reading: saved, charge: null as MeterCharge | null, meter };
    });
    return this.readingResult(result.reading, result.meter, result.charge ?? undefined);
  }

  async listReadings(query: ReadingQueryDto, user: AuthUser, access: ResolvedAccess) {
    const tenantId = this.resolveTenantId(user);
    const where: string[] = ['r.tenant_id = $1'];
    const params: unknown[] = [tenantId];
    const push = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    if (query.meterId) where.push(`r.meter_id = ${push(query.meterId)}`);
    if (query.meterType) where.push(`m.meter_type = ${push(query.meterType)}`);
    if (query.status) where.push(`r.status = ${push(query.status)}`);
    if (query.dateFrom) where.push(`r.read_at >= ${push(this.dayStart(query.dateFrom))}`);
    if (query.dateTo) {
      const to = this.dayStart(query.dateTo);
      where.push(`r.read_at < ${push(new Date(to.getTime() + 24 * 3600 * 1000))}`);
    }
    if (query.keyword?.trim()) {
      const kw = `%${query.keyword.trim()}%`;
      const p = push(kw);
      where.push(`(r.meter_no_snapshot ILIKE ${p} OR m.name ILIKE ${p} OR m.install_address ILIKE ${p} OR r.operator_name ILIKE ${p})`);
    }
    if (query.anomalyOnly) where.push(`jsonb_array_length(r.anomaly_flags) > 0`);
    this.applyCommunityScope(where, params, access, 'm.community_id');
    const page = Math.max(1, Math.round(query.page || 1));
    const pageSize = Math.min(200, Math.max(1, Math.round(query.pageSize || 30)));
    const offset = (page - 1) * pageSize;
    const from = `
      FROM meter_readings r
      JOIN meters m ON m.id = r.meter_id
      LEFT JOIN meter_charges cg ON cg.reading_id = r.id
      WHERE ${where.join(' AND ')}
    `;
    const count = await this.dataSource.query(`SELECT count(*)::int AS total ${from}`, params);
    const rows = await this.dataSource.query(
      `SELECT r.*, m.meter_type, m.name AS meter_name, m.install_address, m.unit, m.community_id,
         cg.id AS charge_id, cg.status AS charge_status, cg.receivable_cents, cg.paid_cents
       ${from}
       ORDER BY r.read_at DESC, r.id DESC LIMIT ${pageSize} OFFSET ${offset}`,
      params,
    );
    return {
      rows: rows.map((row: any) => this.mapReading(row)),
      total: count[0]?.total ?? 0,
      page,
      pageSize,
    };
  }

  async readingDetail(id: number, user: AuthUser, access: ResolvedAccess) {
    const tenantId = this.resolveTenantId(user);
    const reading = await this.readingRepo.findOne({ where: { id, tenantId } });
    if (!reading) throw new NotFoundException('抄表记录不存在');
    const meter = await this.findMeter(reading.meterId, tenantId);
    this.assertMeterScope(meter, access);
    return this.readingResult(reading, meter);
  }

  async updateReading(id: number, dto: UpdateReadingDto, user: AuthUser, access: ResolvedAccess) {
    const tenantId = this.resolveTenantId(user);
    const reading = await this.readingRepo.findOne({ where: { id, tenantId } });
    if (!reading) throw new NotFoundException('抄表记录不存在');
    const meter = await this.findMeter(reading.meterId, tenantId);
    this.assertMeterScope(meter, access);
    if (reading.status === 'void' && dto.status !== 'void' && dto.status !== undefined) {
      throw new BadRequestException('已作废的记录不能恢复，请重新抄表');
    }
    const latest = await this.latestReading(meter.id, tenantId);
    if (latest && latest.id !== reading.id) {
      throw new BadRequestException('只能修正最近一次抄表；改历史读数会让后面每一条用量都对不上');
    }

    const charge = await this.chargeRepo.findOne({ where: { tenantId, readingId: reading.id } });
    if (dto.status === 'void') {
      if (charge && (charge.paidCents > 0 || charge.status === 'paid')) {
        throw new BadRequestException('这张抄表已收款，不能直接作废；请先处理账单');
      }
      reading.status = 'void';
      reading.reviewedBy = user.id;
      reading.reviewedAt = new Date();
      reading.reviewNote = dto.reviewNote?.trim() || reading.reviewNote;
      await this.readingRepo.save(reading);
      if (charge) {
        charge.status = 'void';
        charge.updatedBy = user.id;
        await this.chargeRepo.save(charge);
      }
      await this.refreshMeterLast(meter);
      return this.readingResult(reading, meter);    }

    const predictedBefore = reading.readingValue;
    const correctedValue = dto.readingValue === undefined ? null : round3(dto.readingValue);
    const valueChanged = correctedValue !== null && Math.abs(correctedValue - Number(reading.readingValue)) > 0.0005;

    if (dto.readingValue !== undefined) {
      if (charge && (charge.paidCents > 0 || charge.status === 'paid')) {
        throw new BadRequestException('这张抄表已收款，改读数前请先处理账单');
      }
      const value = round3(dto.readingValue);
      const usageResult = computeUsage(value, reading.previousValue === null ? null : Number(reading.previousValue), Number(meter.multiplier), meter.integerDigits);
      if (usageResult.error) throw new BadRequestException(usageResult.error);
      reading.readingValue = value.toFixed(3);
      reading.usageValue = usageResult.usage === null ? null : usageResult.usage.toFixed(3);
      const flags = new Set(reading.anomalyFlags || []);
      flags.delete('zero_usage');
      if (usageResult.usage !== null && Math.abs(usageResult.usage) < 0.0005) flags.add('zero_usage');
      reading.anomalyFlags = [...flags];
      if (charge && usageResult.usage !== null) {
        const amount = amountCentsOf(usageResult.usage, charge.unitPriceCents);
        charge.usageValue = usageResult.usage.toFixed(3);
        charge.amountCents = amount;
        charge.receivableCents = amount + charge.adjustmentCents;
        if (charge.status !== 'void') {
          charge.status = charge.paidCents > 0 ? (charge.paidCents >= charge.receivableCents ? 'paid' : 'partial') : 'unpaid';
        }
        charge.updatedBy = user.id;
        await this.chargeRepo.save(charge);
      }
    }
    reading.reviewedBy = user.id;
    reading.reviewedAt = new Date();
    if (dto.note !== undefined) reading.note = dto.note.trim() || null;
    if (dto.reviewNote !== undefined) reading.reviewNote = dto.reviewNote.trim() || null;
    if (dto.status !== undefined) reading.status = dto.status;
    reading.updatedBy = user.id;
    await this.readingRepo.save(reading);
    if (valueChanged) {
      await this.upsertOcrSample(reading, meter, predictedBefore, reading.readingValue, user);
    }
    await this.refreshMeterLast(meter);
    return this.readingResult(reading, meter);
  }

  /**
   * 复核待处理抄表：修正读数 → 确认 → 更新表头 → 生成/重算账单。
   * 只有 pending 能走这里；已确认的记录仍按 admin 的 updateReading 修正。
   */
  async reviewReading(id: number, dto: ReviewReadingDto, user: AuthUser, access: ResolvedAccess) {
    const tenantId = this.resolveTenantId(user);
    const before = await this.readingRepo.findOne({ where: { id, tenantId } });
    if (!before) throw new NotFoundException('抄表记录不存在');
    const beforeMeter = await this.findMeter(before.meterId, tenantId);
    this.assertMeterScope(beforeMeter, access);
    if (before.status === 'void') throw new BadRequestException('已作废的记录不能复核');
    if (before.status === 'confirmed') throw new BadRequestException('这条已经复核过了');

    const result = await this.dataSource.transaction(async (manager) => {
      const locked = await manager.query(
        `SELECT id FROM meter_readings WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
        [id, tenantId],
      );
      if (!locked.length) throw new NotFoundException('抄表记录不存在');
      const reading = await manager.findOne(MeterReading, { where: { id, tenantId } });
      if (!reading) throw new NotFoundException('抄表记录不存在');
      const meter = await manager.findOne(Meter, { where: { id: reading.meterId, tenantId } });
      if (!meter) throw new NotFoundException('仪表不存在');

      const value = round3(dto.readingValue === undefined ? Number(reading.readingValue) : dto.readingValue);
      const previous = await manager.findOne(MeterReading, {
        where: { tenantId, meterId: meter.id, status: 'confirmed', readAt: LessThan(reading.readAt) },
        order: { readAt: 'DESC', id: 'DESC' },
      });
      const previousValue = previous
        ? Number(previous.readingValue)
        : meter.initialReading !== null && (!meter.initialReadingAt || meter.initialReadingAt <= reading.readAt)
          ? Number(meter.initialReading)
          : null;
      const usageResult = computeUsage(value, previousValue, Number(meter.multiplier), meter.integerDigits);
      if (usageResult.error) throw new BadRequestException(usageResult.error);

      const predictedBefore = reading.readingValue;
      reading.readingValue = value.toFixed(3);
      reading.previousValue = previousValue === null ? null : previousValue.toFixed(3);
      reading.usageValue = usageResult.usage === null ? null : usageResult.usage.toFixed(3);
      reading.status = 'confirmed';
      reading.reviewedBy = user.id;
      reading.reviewedAt = new Date();
      if (dto.reviewNote !== undefined) reading.reviewNote = dto.reviewNote.trim() || null;
      const flags = new Set(reading.anomalyFlags || []);
      if (usageResult.usage !== null && Math.abs(usageResult.usage) < 0.0005) flags.add('zero_usage');
      else flags.delete('zero_usage');
      reading.anomalyFlags = [...flags];
      reading.updatedBy = user.id;
      await manager.save(reading);

      if (!meter.lastReadingAt || reading.readAt.getTime() >= meter.lastReadingAt.getTime()) {
        meter.lastReadingValue = reading.readingValue;
        meter.lastReadingAt = reading.readAt;
        meter.updatedBy = user.id;
        await manager.save(meter);
      }

      let charge = await manager.findOne(MeterCharge, { where: { tenantId, readingId: reading.id } });
      if (
        meter.billingEnabled &&
        meter.unitPriceCents > 0 &&
        usageResult.usage !== null &&
        usageResult.usage > 0
      ) {
        const amount = amountCentsOf(usageResult.usage, meter.unitPriceCents);
        if (amount > 2_000_000_000) throw new BadRequestException('本次金额过大，请检查单价和读数');
        if (amount > 0) {
          if (!charge) {
            charge = manager.create(MeterCharge, {
              tenantId,
              meterId: meter.id,
              readingId: reading.id,
              meterNoSnapshot: meter.meterNo,
              ownerNameSnapshot: meter.ownerName,
              period: periodOf(reading.readAt),
              usageValue: usageResult.usage.toFixed(3),
              unitPriceCents: meter.unitPriceCents,
              amountCents: amount,
              adjustmentCents: 0,
              receivableCents: amount,
              paidCents: 0,
              status: 'unpaid',
              dueDate: this.dueDateOf(periodOf(reading.readAt)),
              note: null,
              createdBy: user.id,
              updatedBy: user.id,
            });
          } else {
            charge.usageValue = usageResult.usage.toFixed(3);
            charge.amountCents = amount;
            charge.receivableCents = amount + charge.adjustmentCents;
            charge.updatedBy = user.id;
          }
          charge = await manager.save(charge);
        }
      }
      return { reading, meter, charge, predictedBefore };
    });

    if (Math.abs(Number(result.predictedBefore) - Number(result.reading.readingValue)) > 0.0005) {
      await this.upsertOcrSample(result.reading, result.meter, result.predictedBefore, result.reading.readingValue, user);
    }
    return this.readingResult(result.reading, result.meter, result.charge ?? undefined);
  }

  // ---------------------------------------------------------------- 识别纠错样本

  /**
   * 人工把读数从识别值改成确认值时自动落一条样本。只标记 candidate，
   * 不会立刻改线上模型；训练页再逐条确认是否进入训练集。
   */
  private async upsertOcrSample(
    reading: MeterReading,
    meter: Meter,
    predictedValue: string,
    correctedValue: string,
    user: AuthUser,
  ) {
    const existing = reading.id
      ? await this.sampleRepo.findOne({ where: { tenantId: reading.tenantId, readingId: reading.id } })
      : null;
    const sample = existing ?? this.sampleRepo.create({
      tenantId: reading.tenantId,
      meterId: meter.id,
      readingId: reading.id,
      meterNoSnapshot: meter.meterNo,
      meterType: meter.meterType,
      integerDigits: meter.integerDigits,
      decimalDigits: meter.decimalDigits,
      photoKey: reading.photoKey,
      photoUrl: reading.photoUrl,
      roi: reading.roi,
      orientation: reading.orientation ?? 0,
      ocrProvider: reading.ocrProvider,
      ocrText: reading.ocrText,
      confidence: reading.ocrConfidence,
      predictedValue,
      predictedDigits: String(predictedValue).replace('.', ''),
      status: 'candidate',
      source: 'review',
      correctedBy: user.id,
      correctedAt: new Date(),
      createdBy: user.id,
      updatedBy: user.id,
    });
    sample.correctedValue = correctedValue;
    sample.correctedDigits = String(correctedValue).replace('.', '');
    sample.status = 'candidate';
    sample.correctedBy = user.id;
    sample.correctedAt = new Date();
    sample.updatedBy = user.id;
    sample.roi = reading.roi;
    sample.orientation = reading.orientation ?? 0;
    sample.photoKey = reading.photoKey;
    sample.photoUrl = reading.photoUrl;
    sample.ocrText = reading.ocrText;
    sample.ocrProvider = reading.ocrProvider;
    sample.confidence = reading.ocrConfidence;
    try {
      await this.sampleRepo.save(sample);
    } catch (error: any) {
      // 并发复核同一张记录时唯一索引会拦一次，下一次保存会把纠正值补齐
      if (String(error?.code) !== '23505') throw error;
    }  }

  async listOcrSamples(query: OcrSampleQueryDto, user: AuthUser, access: ResolvedAccess) {
    const tenantId = this.resolveTenantId(user);
    const where: string[] = ['s.tenant_id = $1'];
    const params: unknown[] = [tenantId];
    const push = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    if (query.status) where.push(`s.status = ${push(query.status)}`);
    if (query.meterType) where.push(`m.meter_type = ${push(query.meterType)}`);
    if (query.keyword?.trim()) {
      const kw = `%${query.keyword.trim()}%`;
      const p = push(kw);
      where.push(`(s.meter_no_snapshot ILIKE ${p} OR m.name ILIKE ${p} OR m.install_address ILIKE ${p})`);
    }
    this.applyCommunityScope(where, params, access, 'm.community_id');
    const page = Math.max(1, Math.round(query.page || 1));
    const pageSize = Math.min(200, Math.max(1, Math.round(query.pageSize || 30)));
    const offset = (page - 1) * pageSize;
    const from = `
      FROM meter_ocr_samples s
      JOIN meters m ON m.id = s.meter_id
      WHERE ${where.join(' AND ')}
    `;
    const [count, rows] = await Promise.all([
      this.dataSource.query(`SELECT count(*)::int AS total ${from}`, params),
      this.dataSource.query(
        `SELECT s.*, m.meter_type, m.name AS meter_name, m.install_address, m.community_id
         ${from}
         ORDER BY s.id DESC LIMIT ${pageSize} OFFSET ${offset}`,
        params,
      ),
    ]);
    return {
      rows: rows.map((row: any) => this.mapOcrSample(row)),
      total: count[0]?.total ?? 0,
      page,
      pageSize,
    };
  }

  async updateOcrSample(id: number, dto: UpdateOcrSampleDto, user: AuthUser, access: ResolvedAccess) {
    const tenantId = this.resolveTenantId(user);
    const sample = await this.sampleRepo.findOne({ where: { id, tenantId } });
    if (!sample) throw new NotFoundException('识别样本不存在');
    const meter = await this.findMeter(sample.meterId, tenantId);
    this.assertMeterScope(meter, access);
    sample.status = dto.status;
    if (dto.note !== undefined) sample.note = dto.note.trim() || null;
    sample.updatedBy = user.id;
    await this.sampleRepo.save(sample);
    return this.mapOcrSample({ ...sample, meter_type: meter.meterType, meter_name: meter.name, install_address: meter.installAddress });
  }

  private mapOcrSample(row: any) {
    return {
      id: row.id,
      meterId: row.meterId ?? row.meter_id,
      readingId: row.readingId ?? row.reading_id,
      meterNo: row.meterNoSnapshot ?? row.meter_no_snapshot,
      meterName: row.meter_name || '',
      meterType: row.meter_type,
      integerDigits: Number(row.integerDigits ?? row.integer_digits ?? 0),
      decimalDigits: Number(row.decimalDigits ?? row.decimal_digits ?? 0),
      photoUrl: this.storage.toDisplayUrl(row.photoUrl || row.photo_url || row.photoKey || row.photo_key),
      roi: row.roi ?? null,
      orientation: Number(row.orientation ?? 0),
      ocrProvider: row.ocrProvider ?? row.ocr_provider ?? '',
      ocrText: row.ocrText ?? row.ocr_text ?? '',
      confidence: row.confidence ?? null,
      predictedValue: row.predictedValue ?? row.predicted_value ?? null,
      correctedValue: row.correctedValue ?? row.corrected_value ?? null,
      status: row.status,
      source: row.source,
      note: row.note || '',
      correctedAt: row.correctedAt ?? row.corrected_at ?? null,
      createdAt: row.createdAt ?? row.created_at,
    };
  }

  // ---------------------------------------------------------------- 账单

  async listCharges(query: ChargeQueryDto, user: AuthUser, access: ResolvedAccess) {
    const tenantId = this.resolveTenantId(user);
    const where: string[] = ['cg.tenant_id = $1'];
    const params: unknown[] = [tenantId];
    const push = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    if (query.meterType) where.push(`m.meter_type = ${push(query.meterType)}`);
    if (query.status) where.push(`cg.status = ${push(query.status)}`);
    if (query.period) where.push(`cg.period = ${push(query.period)}`);
    if (query.dateFrom) where.push(`cg.created_at >= ${push(this.dayStart(query.dateFrom))}`);
    if (query.dateTo) {
      const to = this.dayStart(query.dateTo);
      where.push(`cg.created_at < ${push(new Date(to.getTime() + 24 * 3600 * 1000))}`);
    }
    if (query.keyword?.trim()) {
      const kw = `%${query.keyword.trim()}%`;
      const p = push(kw);
      where.push(`(cg.meter_no_snapshot ILIKE ${p} OR cg.owner_name_snapshot ILIKE ${p} OR m.name ILIKE ${p} OR cg.receipt_no ILIKE ${p})`);
    }
    this.applyCommunityScope(where, params, access, 'm.community_id');
    const page = Math.max(1, Math.round(query.page || 1));
    const pageSize = Math.min(200, Math.max(1, Math.round(query.pageSize || 50)));
    const offset = (page - 1) * pageSize;
    const from = `
      FROM meter_charges cg
      JOIN meters m ON m.id = cg.meter_id
      WHERE ${where.join(' AND ')}
    `;
    const [count, totals, rows] = await Promise.all([
      this.dataSource.query(`SELECT count(*)::int AS total ${from}`, params),
      this.dataSource.query(
        `SELECT COALESCE(sum(cg.receivable_cents) FILTER (WHERE cg.status <> 'void'), 0)::int AS receivable,
           COALESCE(sum(cg.paid_cents) FILTER (WHERE cg.status <> 'void'), 0)::int AS paid,
           COALESCE(sum(cg.receivable_cents - cg.paid_cents) FILTER (WHERE cg.status IN ('unpaid', 'partial')), 0)::int AS outstanding
         ${from}`,
        params,
      ),
      this.dataSource.query(
        `SELECT cg.*, m.meter_type, m.name AS meter_name, m.unit, m.install_address
         ${from}
         ORDER BY cg.period DESC, cg.id DESC LIMIT ${pageSize} OFFSET ${offset}`,
        params,
      ),
    ]);
    return {
      rows: rows.map((row: any) => this.mapCharge(row)),
      total: count[0]?.total ?? 0,
      page,
      pageSize,
      totals: totals[0] ?? { receivable: 0, paid: 0, outstanding: 0 },
    };
  }

  async payCharge(id: number, dto: PayChargeDto, user: AuthUser, access: ResolvedAccess) {
    const tenantId = this.resolveTenantId(user);
    const result = await this.dataSource.transaction(async (manager) => {
      const locked = await manager.query(
        `SELECT id FROM meter_charges WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
        [id, tenantId],
      );
      if (!locked.length) throw new NotFoundException('账单不存在');
      const charge = await manager.findOne(MeterCharge, { where: { id, tenantId } });
      if (!charge) throw new NotFoundException('账单不存在');
      const meter = await manager.findOne(Meter, { where: { id: charge.meterId, tenantId } });
      if (!meter) throw new NotFoundException('仪表不存在');
      this.assertMeterScope(meter, access);
      if (charge.status === 'void') throw new BadRequestException('账单已作废');
      if (charge.status === 'paid') throw new BadRequestException('账单已结清');
      const remaining = charge.receivableCents - charge.paidCents;
      if (remaining <= 0) throw new BadRequestException('账单没有待收金额');
      const amount = Math.round(dto.amountCents ?? remaining);
      if (amount <= 0) throw new BadRequestException('收款金额必须大于 0');
      if (amount > remaining) throw new BadRequestException(`收款金额超过待收 ${(remaining / 100).toFixed(2)} 元`);
      charge.paidCents += amount;
      charge.status = charge.paidCents >= charge.receivableCents ? 'paid' : 'partial';
      charge.paidAt = dto.paidAt ? this.parseDate(dto.paidAt) : new Date();
      charge.paymentMethod = dto.method?.trim() || charge.paymentMethod || 'cash';
      charge.receiptNo = dto.receiptNo?.trim() || charge.receiptNo;
      if (dto.note) charge.note = [charge.note, dto.note.trim()].filter(Boolean).join('；').slice(0, 1000);
      charge.updatedBy = user.id;
      return { charge: await manager.save(charge), meter };
    });
    return this.mapCharge(result.charge, result.meter);
  }

  async adjustCharge(id: number, dto: AdjustChargeDto, user: AuthUser, access: ResolvedAccess) {
    const tenantId = this.resolveTenantId(user);
    const charge = await this.chargeRepo.findOne({ where: { id, tenantId } });
    if (!charge) throw new NotFoundException('账单不存在');
    const meter = await this.findMeter(charge.meterId, tenantId);
    this.assertMeterScope(meter, access);
    if (charge.status === 'paid' || charge.status === 'void') throw new BadRequestException('已结清或已作废的账单不能调整');
    const receivable = charge.amountCents + Math.round(dto.adjustmentCents);
    if (receivable < 0) throw new BadRequestException('调整后应收不能为负');
    if (receivable < charge.paidCents) throw new BadRequestException('调整后应收不能小于已收金额');
    charge.adjustmentCents = Math.round(dto.adjustmentCents);
    charge.receivableCents = receivable;
    charge.status = charge.paidCents >= receivable ? 'paid' : charge.paidCents > 0 ? 'partial' : 'unpaid';
    charge.note = dto.note ? `${charge.note ? `${charge.note}；` : ''}${dto.note}` : charge.note;
    charge.updatedBy = user.id;
    await this.chargeRepo.save(charge);
    return this.mapCharge(charge, meter);
  }

  async voidCharge(id: number, user: AuthUser, access: ResolvedAccess) {
    const tenantId = this.resolveTenantId(user);
    const charge = await this.chargeRepo.findOne({ where: { id, tenantId } });
    if (!charge) throw new NotFoundException('账单不存在');
    const meter = await this.findMeter(charge.meterId, tenantId);
    this.assertMeterScope(meter, access);
    if (charge.paidCents > 0) throw new BadRequestException('已有收款，不能作废；请先退款/红冲');
    charge.status = 'void';
    charge.updatedBy = user.id;
    await this.chargeRepo.save(charge);
    return this.mapCharge(charge, meter);
  }

  // ---------------------------------------------------------------- 汇总

  async summary(query: MeterSummaryQueryDto, user: AuthUser, access: ResolvedAccess) {
    const tenantId = this.resolveTenantId(user);
    const period = query.period || periodOf(new Date());
    if (!/^\d{4}-\d{2}$/.test(period)) throw new BadRequestException('账期格式应为 YYYY-MM');
    const start = this.monthStart(period);
    const end = this.monthStart(this.nextPeriod(period));
    const scope: string[] = [];
    const params: unknown[] = [tenantId, start, end];
    this.applyCommunityScope(scope, params, access, 'm.community_id');
    const scopeSql = scope.length ? ` AND ${scope.join(' AND ')}` : '';
    const meterParams: unknown[] = [tenantId, start];
    const meterScope: string[] = [];
    this.applyCommunityScope(meterScope, meterParams, access, 'm.community_id');
    const meterScopeSql = meterScope.length ? ` AND ${meterScope.join(' AND ')}` : '';
    const chargeParams: unknown[] = [tenantId, period];
    const chargeScope: string[] = [];
    this.applyCommunityScope(chargeScope, chargeParams, access, 'm.community_id');
    const chargeScopeSql = chargeScope.length ? ` AND ${chargeScope.join(' AND ')}` : '';
    const [meterStats, readingStats, usageStats, chargeStats] = await Promise.all([
      this.dataSource.query(
        `SELECT count(*)::int AS total,
           count(*) FILTER (WHERE status = 'active')::int AS active,
           count(*) FILTER (WHERE status = 'active' AND (last_reading_at IS NULL OR last_reading_at < $2))::int AS due
         FROM meters m WHERE m.tenant_id = $1${meterScopeSql}`,
        meterParams,
      ),
      this.dataSource.query(
        `SELECT count(*)::int AS readings,
           count(DISTINCT r.meter_id)::int AS meters_read
         FROM meter_readings r JOIN meters m ON m.id = r.meter_id
         WHERE r.tenant_id = $1 AND r.status = 'confirmed' AND r.read_at >= $2 AND r.read_at < $3${scopeSql}`,
        params,
      ),
      this.dataSource.query(
        `SELECT m.meter_type, COALESCE(sum(r.usage_value), 0) AS usage, m.unit
         FROM meter_readings r JOIN meters m ON m.id = r.meter_id
         WHERE r.tenant_id = $1 AND r.status = 'confirmed' AND r.read_at >= $2 AND r.read_at < $3${scopeSql}
         GROUP BY m.meter_type, m.unit`,
        params,
      ),
      this.dataSource.query(
        `SELECT COALESCE(sum(cg.receivable_cents) FILTER (WHERE cg.status <> 'void'), 0)::int AS receivable,
           COALESCE(sum(cg.paid_cents) FILTER (WHERE cg.status <> 'void'), 0)::int AS paid,
           COALESCE(sum(cg.receivable_cents - cg.paid_cents) FILTER (WHERE cg.status IN ('unpaid', 'partial')), 0)::int AS outstanding,
           count(*) FILTER (WHERE cg.status IN ('unpaid', 'partial'))::int AS unpaid_count
         FROM meter_charges cg JOIN meters m ON m.id = cg.meter_id
         WHERE cg.tenant_id = $1 AND cg.period = $2${chargeScopeSql}`,
        chargeParams,
      ),
    ]);
    return {
      period,
      meters: meterStats[0] ?? { total: 0, active: 0, due: 0 },
      readings: readingStats[0] ?? { readings: 0, meters_read: 0 },
      usage: (usageStats as any[]).map((row) => ({
        meterType: row.meter_type as MeterType,
        label: TYPE_META[row.meter_type as MeterType]?.label || row.meter_type,
        usage: Number(row.usage || 0),
        unit: row.unit,
      })),
      charges: chargeStats[0] ?? { receivable: 0, paid: 0, outstanding: 0, unpaid_count: 0 },
    };
  }

  // ---------------------------------------------------------------- 内部

  private async findMeter(id: number, tenantId: number): Promise<Meter> {
    const meter = await this.meterRepo.findOne({ where: { id, tenantId } });
    if (!meter) throw new NotFoundException('仪表不存在');
    return meter;
  }

  private resolveTenantId(user: AuthUser): number {
    if (user.tenantId) return user.tenantId;
    if (user.role === UserRole.SUPERADMIN) throw new BadRequestException('平台账号请先选择物业公司');
    throw new ForbiddenException('缺少公司范围');
  }

  private applyCommunityScope(
    where: string[],
    params: unknown[],
    access: ResolvedAccess,
    column: string,
  ) {
    if (access.scopeAll || access.communityIds === null) return;
    if (!access.communityIds.length) {
      where.push('1 = 0');
      return;
    }
    params.push(access.communityIds);
    where.push(`${column} = ANY($${params.length}::int[])`);
  }

  private assertMeterScope(meter: Meter, access: ResolvedAccess) {
    if (!this.inScope(meter, access)) throw new ForbiddenException('没有这块表的数据权限');
  }

  private assertCommunityScope(communityId: number, access: ResolvedAccess) {
    if (access.scopeAll || access.communityIds === null) return;
    if (!access.communityIds.includes(communityId)) throw new ForbiddenException('没有该小区的数据权限');
  }

  private inScope(meter: Meter, access: ResolvedAccess): boolean {
    if (access.scopeAll || access.communityIds === null) return true;
    return meter.communityId !== null && access.communityIds.includes(meter.communityId);
  }

  private async assertCommunity(id: number, tenantId: number) {
    const community = await this.communityRepo.findOne({ where: { id, tenantId } });
    if (!community) throw new BadRequestException('小区不存在或不属于当前公司');
    return community;
  }

  private async assertHouse(id: number, tenantId: number) {
    const house = await this.houseRepo.findOne({ where: { id, tenantId } });
    if (!house) throw new BadRequestException('房号不存在或不属于当前公司');
    return house;
  }

  private async operatorName(userId: number, tenantId: number): Promise<string | null> {
    const user = await this.userRepo.findOne({ where: { id: userId, tenantId } });
    return user?.name || null;
  }

  private async latestReading(meterId: number, tenantId: number) {
    return this.readingRepo.findOne({
      where: { tenantId, meterId, status: 'confirmed' },
      order: { readAt: 'DESC', id: 'DESC' },
    });
  }

  private async refreshMeterLast(meter: Meter) {
    const last = await this.latestReading(meter.id, meter.tenantId);
    meter.lastReadingValue = last?.readingValue ?? null;
    meter.lastReadingAt = last?.readAt ?? null;
    await this.meterRepo.save(meter);
  }

  private async readingResult(reading: MeterReading, meter: Meter, explicitCharge?: MeterCharge) {
    const charge =
      explicitCharge ??
      (await this.chargeRepo.findOne({ where: { tenantId: reading.tenantId, readingId: reading.id } }));
    return {
      reading: this.mapReading(
        {
          ...reading,
          meter_type: meter.meterType,
          unit: meter.unit,
          install_address: meter.installAddress,
          charge_id: charge?.id ?? null,
          charge_status: charge?.status ?? null,
          receivable_cents: charge?.receivableCents ?? null,
          paid_cents: charge?.paidCents ?? null,
        },
        meter,
      ),
      charge: charge ? this.mapCharge(charge, meter) : null,
      meter: this.mapMeter(meter),
      usageLabel:
        reading.usageValue === null
          ? '首次抄表'
          : `${Number(reading.usageValue).toFixed(3).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')} ${meter.unit}`,
    };
  }

  private mapMeter(row: any) {
    const type = row.meterType ?? row.meter_type;
    const meta = TYPE_META[type as MeterType] || TYPE_META.water;
    const lastValue = row.lastReadingValue ?? row.last_reading_value;
    const hasLast = lastValue !== null && lastValue !== undefined && lastValue !== '';
    return {
      id: row.id,
      meterNo: row.meterNo ?? row.meter_no,
      meterType: type as MeterType,
      meterTypeLabel: meta.label,
      name: row.name || '',
      spec: row.spec || '',
      manufacturer: row.manufacturer || '',
      model: row.model || '',
      multiplier: Number(row.multiplier ?? 1),
      integerDigits: Number(row.integerDigits ?? row.integer_digits ?? meta.integerDigits),
      decimalDigits: Number(row.decimalDigits ?? row.decimal_digits ?? meta.decimalDigits),
      unit: row.unit || meta.unit,
      communityId: row.communityId ?? row.community_id ?? null,
      communityName: row.community_name || row.communityName || '',
      houseId: row.houseId ?? row.house_id ?? null,
      houseLabel: [row.building_no, row.room_no].filter(Boolean).join('-'),
      installAddress: row.installAddress ?? row.install_address ?? '',
      latitude: row.latitude === null || row.latitude === undefined ? null : Number(row.latitude),
      longitude: row.longitude === null || row.longitude === undefined ? null : Number(row.longitude),
      ownerName: row.ownerName ?? row.owner_name ?? '',
      ownerPhone: row.ownerPhone ?? row.owner_phone ?? '',
      unitPriceCents: Number(row.unitPriceCents ?? row.unit_price_cents ?? 0),
      unitPriceYuan: Number(row.unitPriceCents ?? row.unit_price_cents ?? 0) / 100,
      billingEnabled: row.billingEnabled ?? row.billing_enabled ?? true,
      initialReading: row.initialReading ?? row.initial_reading ?? null,
      initialReadingAt: row.initialReadingAt ?? row.initial_reading_at ?? null,
      lastReadingValue: hasLast ? Number(lastValue) : null,
      lastReadingValueText: hasLast
        ? formatReadingValue(
            lastValue,
            Number(row.integerDigits ?? row.integer_digits ?? meta.integerDigits),
            Number(row.decimalDigits ?? row.decimal_digits ?? meta.decimalDigits),
          )
        : '',
      lastReadingAt: row.lastReadingAt ?? row.last_reading_at ?? null,
      lastUsage: row.last_usage === null || row.last_usage === undefined ? null : Number(row.last_usage),
      readingCount: Number(row.reading_count ?? row.readingCount ?? 0),
      unpaidCents: Number(row.unpaid_cents ?? row.unpaidCents ?? 0),
      status: row.status || 'active',
      photoUrl: this.storage.toDisplayUrl(row.photoUrl || row.photo_url || row.photoKey || row.photo_key),
      remark: row.remark || '',
      qrToken: row.qrToken ?? row.qr_token,
      createdAt: row.createdAt ?? row.created_at,
      updatedAt: row.updatedAt ?? row.updated_at,
    };
  }

  private mapReading(row: any, meter?: Meter) {
    const type = row.meter_type || meter?.meterType || 'water';
    const meta = TYPE_META[type as MeterType] || TYPE_META.water;
    const intDigits = meter?.integerDigits ?? meta.integerDigits;
    const decDigits = meter?.decimalDigits ?? meta.decimalDigits;
    const flags: MeterReadingAnomaly[] = Array.isArray(row.anomalyFlags)
      ? row.anomalyFlags
      : Array.isArray(row.anomaly_flags)
        ? row.anomaly_flags
        : [];
    const value = Number(row.readingValue ?? row.reading_value);
    return {
      id: row.id,
      meterId: row.meterId ?? row.meter_id,
      meterNo: row.meterNoSnapshot ?? row.meter_no_snapshot,
      meterName: row.meter_name || meter?.name || '',
      meterType: type as MeterType,
      meterTypeLabel: meta.label,
      unit: row.unit || meter?.unit || meta.unit,
      readingValue: value,
      readingValueText: formatReadingValue(value, intDigits, decDigits),
      previousValue:
        row.previousValue === null || row.previousValue === undefined
          ? row.previous_value === null || row.previous_value === undefined
            ? null
            : Number(row.previous_value)
          : Number(row.previousValue),
      usageValue:
        row.usageValue === null || row.usageValue === undefined
          ? row.usage_value === null || row.usage_value === undefined
            ? null
            : Number(row.usage_value)
          : Number(row.usageValue),
      readAt: row.readAt ?? row.read_at,
      createdAt: row.createdAt ?? row.created_at,
      source: row.source,
      photoUrl: this.storage.toDisplayUrl(row.photoUrl || row.photo_url || row.photoKey || row.photo_key),
      photoKey: row.photoKey ?? row.photo_key,
      photoWidth: row.photoWidth ?? row.photo_width ?? null,
      photoHeight: row.photoHeight ?? row.photo_height ?? null,
      roi: row.roi ?? null,
      ocrStatus: row.ocrStatus ?? row.ocr_status,
      ocrProvider: row.ocrProvider ?? row.ocr_provider,
      ocrConfidence: row.ocrConfidence ?? row.ocr_confidence,
      ocrText: row.ocrText ?? row.ocr_text,
      ocrMeterNo: row.ocrMeterNo ?? row.ocr_meter_no,
      orientation: Number(row.orientation ?? 0),
      status: row.status,
      anomalyFlags: flags,
      anomalyLabels: flags.map((flag) => ANOMALY_LABELS[flag] || flag),
      latitude: row.latitude === null || row.latitude === undefined ? null : Number(row.latitude),
      longitude: row.longitude === null || row.longitude === undefined ? null : Number(row.longitude),
      gpsAccuracy: row.gpsAccuracy ?? row.gps_accuracy,
      operatorId: row.operatorId ?? row.operator_id,
      operatorName: row.operatorName ?? row.operator_name,
      note: row.note || '',
      reviewNote: row.reviewNote ?? row.review_note ?? '',
      reviewedAt: row.reviewedAt ?? row.reviewed_at ?? null,
      chargeId: row.charge_id ?? row.chargeId ?? null,
      chargeStatus: row.charge_status ?? row.chargeStatus ?? null,
      receivableCents: row.receivable_cents ?? row.receivableCents ?? null,
      paidCents: row.paid_cents ?? row.paidCents ?? null,
    };
  }

  private mapCharge(row: any, meter?: Meter) {
    const type = row.meter_type || meter?.meterType || 'water';
    const meta = TYPE_META[type as MeterType] || TYPE_META.water;
    return {
      id: row.id,
      meterId: row.meterId ?? row.meter_id,
      readingId: row.readingId ?? row.reading_id,
      meterNo: row.meterNoSnapshot ?? row.meter_no_snapshot,
      meterName: row.meter_name || meter?.name || '',
      meterType: type as MeterType,
      meterTypeLabel: meta.label,
      ownerName: row.ownerNameSnapshot ?? row.owner_name_snapshot ?? '',
      period: row.period,
      usageValue: Number(row.usageValue ?? row.usage_value),
      unit: row.unit || meter?.unit || meta.unit,
      unitPriceCents: Number(row.unitPriceCents ?? row.unit_price_cents),
      amountCents: Number(row.amountCents ?? row.amount_cents),
      adjustmentCents: Number(row.adjustmentCents ?? row.adjustment_cents ?? 0),
      receivableCents: Number(row.receivableCents ?? row.receivable_cents),
      paidCents: Number(row.paidCents ?? row.paid_cents ?? 0),
      outstandingCents: Number(row.receivableCents ?? row.receivable_cents) - Number(row.paidCents ?? row.paid_cents ?? 0),
      status: row.status,
      dueDate: row.dueDate ?? row.due_date ?? null,
      paidAt: row.paidAt ?? row.paid_at ?? null,
      paymentMethod: row.paymentMethod ?? row.payment_method ?? '',
      receiptNo: row.receiptNo ?? row.receipt_no ?? '',
      note: row.note || '',
      createdAt: row.createdAt ?? row.created_at,
    };
  }

  private photoKeyOf(url?: string | null, key?: string | null): string | null {
    if (key && PHOTO_KEY_RE.test(key)) return key;
    if (!url) return null;
    try {
      const parsed = new URL(url, 'https://placeholder.local');
      const fromQuery = parsed.searchParams.get('key');
      if (fromQuery && PHOTO_KEY_RE.test(fromQuery)) return fromQuery;
      const bare = url.replace(/^\/+/, '');
      if (PHOTO_KEY_RE.test(bare)) return bare;
    } catch {
      const bare = url.replace(/^\/+/, '');
      if (PHOTO_KEY_RE.test(bare)) return bare;
    }
    return null;
  }

  private parseDate(value: string): Date {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) throw new BadRequestException('时间格式不正确');
    return date;
  }

  /** 日期筛选按北京时间自然日：2026-10-01 指当天 00:00(+08)，不是 UTC 零点 */
  private dayStart(value: string): Date {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      const date = new Date(`${value}T00:00:00+08:00`);
      if (!Number.isNaN(date.getTime())) return date;
    }
    return this.parseDate(value);
  }

  private monthStart(period: string): string {
    return `${period}-01T00:00:00+08:00`;
  }

  private nextPeriod(period: string): string {
    const [year, month] = period.split('-').map(Number);
    const next = month === 12 ? { y: year + 1, m: 1 } : { y: year, m: month + 1 };
    return `${next.y}-${String(next.m).padStart(2, '0')}`;
  }

  private dueDateOf(period: string): string {
    const [year, month] = period.split('-').map(Number);
    const next = month === 12 ? { y: year + 1, m: 1 } : { y: year, m: month + 1 };
    return `${next.y}-${String(next.m).padStart(2, '0')}-15`;
  }

  private formatDateTime(date: Date): string {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(date);
  }

  private qrPayload(meter: Meter): string {
    return `PMSMETER:${meter.qrToken}`;
  }

  /** 给后台「抄表员今日记录」等场景用的日期，避免页面自己算时区 */
  today(): string {
    return dateOf(new Date());
  }
}
