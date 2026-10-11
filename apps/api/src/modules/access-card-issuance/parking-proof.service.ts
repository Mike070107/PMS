import { BadRequestException, GoneException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomBytes } from 'node:crypto';
import * as QRCode from 'qrcode';
import { Repository } from 'typeorm';
import { AuthUser } from '../../common/current-user.decorator';
import { ParkingProofUpload, TenantConfig } from '../../entities';
import { detectUploadContentType } from '../upload/upload.controller';
import { ObjectStorageService } from '../upload/object-storage.service';
import { CreateParkingProofUploadDto } from './dto';
import { DEFAULT_PARKING_RATES, normalizeParkingRates } from './parking-family';

// 亲情车资料二维码给住户留出完整的一小时上传窗口；状态接口仍会在提交后继续保留审核凭证。
const TTL_MS = 60 * 60 * 1000;

@Injectable()
export class ParkingProofService {
  constructor(
    @InjectRepository(ParkingProofUpload)
    private readonly repo: Repository<ParkingProofUpload>,
    private readonly storage: ObjectStorageService,
    private readonly config: ConfigService,
    @InjectRepository(TenantConfig) private readonly configRepo: Repository<TenantConfig>,
  ) {}

  async create(dto: CreateParkingProofUploadDto, user: AuthUser) {
    if (!user.tenantId) throw new BadRequestException('当前账号没有物业公司范围');
    const plate = dto.plate.trim().toUpperCase().replace(/\s+/g, '');
    const previous = await this.repo.findOne({ where: { tenantId: user.tenantId, plate }, order: { createdAt: 'DESC' } });
    const token = randomBytes(24).toString('base64url');
    const expiresAt = new Date(Date.now() + TTL_MS);
    const row = await this.repo.save(this.repo.create({
      tenantId: user.tenantId,
      tokenHash: this.hash(token),
      plate,
      ownerId: dto.ownerId?.trim() || null,
      requestedBy: user.id,
      expiresAt,
      openedAt: null,
      submittedAt: null,
      objectKey: null,
      fileName: null,
      contentType: null,
      createdBy: user.id,
      updatedBy: user.id,
      reviewStatus: previous?.reviewStatus === 'approved' ? 'approved' : 'pending', reviewReason: null, reviewedAt: previous?.reviewedAt ?? null, reviewedBy: previous?.reviewedBy ?? null, registrationId: previous?.registrationId ?? null, files: [],
    }));
    const base = String(this.config.get('APP_PUBLIC_BASE_URL') || '').replace(/\/+$/, '');
    const url = `${base}/parking-proof/${token}`;
    return {
      id: row.id,
      plate,
      url,
      qrDataUrl: await QRCode.toDataURL(url, { width: 520, margin: 1, errorCorrectionLevel: 'M' }),
      expiresAt: expiresAt.toISOString(),
      status: 'waiting',
    };
  }

  async status(id: number, user: AuthUser) {
    if (!user.tenantId) throw new BadRequestException('当前账号没有物业公司范围');
    const row = await this.repo.findOne({ where: { id, tenantId: user.tenantId } });
    if (!row) throw new NotFoundException('证明材料上传任务不存在');
    return this.view(row);
  }

  async latestByPlate(plateValue: string, user: AuthUser) {
    if (!user.tenantId) throw new BadRequestException('当前账号没有物业公司范围');
    const plate = plateValue.trim().toUpperCase().replace(/\s+/g, '');
    if (!plate) throw new BadRequestException('车牌不能为空');
    const row = await this.repo.findOne({
      where: { tenantId: user.tenantId, plate },
      order: { createdAt: 'DESC' },
    });
    return row ? this.view(row) : null;
  }

  async rates(user: AuthUser) {
    if (!user.tenantId) throw new BadRequestException('当前账号没有物业公司范围');
    const row = await this.configRepo.findOne({ where: { tenantId: user.tenantId, key: 'parking_fee_rates' } });
    return row?.value ?? DEFAULT_PARKING_RATES;
  }

  async saveRates(value: Record<string, Record<string, number>>, user: AuthUser) {
    if (!user.tenantId) throw new BadRequestException('当前账号没有物业公司范围');
    const rates = normalizeParkingRates(value);
    await this.configRepo.upsert({ tenantId: user.tenantId, key: 'parking_fee_rates', value: rates, updatedBy: user.id }, ['tenantId', 'key']);
    return rates;
  }

  async session(token: string) {
    const row = await this.byToken(token);
    if (!row.openedAt) {
      row.openedAt = new Date();
      await this.repo.save(row);
    }
    return this.view(row);
  }

  async submit(token: string, input?: Express.Multer.File | Express.Multer.File[]) {
    const row = await this.byToken(token);
    if (row.submittedAt) throw new BadRequestException('证明材料已经上传，请关闭此页面');
    const files = Array.isArray(input) ? input : input ? [input] : [];
    if (!files.length || files.length > 10) throw new BadRequestException('请选择 1 至 10 份证明材料');
    const types = files.map((file) => detectUploadContentType(file.buffer));
    if (types.some((type) => !type || (!type.startsWith('image/') && type !== 'application/pdf'))) {
      throw new BadRequestException('只支持 JPG、PNG、GIF、WebP、HEIC 图片或 PDF');
    }
    // 串行锁防同一二维码并发重复提交；对象存储失败不会标为已提交。
    await this.repo.manager.transaction(async (manager) => {
      const repo = manager.getRepository(ParkingProofUpload);
      const locked = await repo.findOne({ where: { id: row.id }, lock: { mode: 'pessimistic_write' } });
      if (!locked || locked.submittedAt) throw new BadRequestException('证明材料已经上传');
      if (locked.expiresAt.getTime() <= Date.now()) throw new GoneException('上传链接已过期，请联系办公室重新生成');
      locked.files = [];
      for (let index = 0; index < files.length; index++) {
        const file = files[index];
        const contentType = types[index]!;
        const stored = await this.storage.putBuffer(file.buffer, contentType, 'parking-proofs', file.originalname);
        locked.files.push({ objectKey: stored.objectKey, fileName: file.originalname.slice(0, 255), contentType });
      }
      Object.assign(locked, locked.files[0], { submittedAt: new Date() });
      Object.assign(row, await repo.save(locked));
    });
    return this.view(row);
  }

  private async byToken(token: string) {
    if (!/^[A-Za-z0-9_-]{20,80}$/.test(token || '')) throw new BadRequestException('上传链接无效');
    const row = await this.repo.findOne({ where: { tokenHash: this.hash(token) } });
    if (!row) throw new NotFoundException('上传链接不存在');
    if (row.expiresAt.getTime() <= Date.now() && !row.submittedAt) throw new GoneException('上传链接已过期，请联系办公室重新生成');
    return row;
  }

  private view(row: ParkingProofUpload) {
    return {
      id: row.id,
      plate: row.plate,
      expiresAt: row.expiresAt.toISOString(),
      openedAt: row.openedAt?.toISOString() || null,
      submittedAt: row.submittedAt?.toISOString() || null,
      status: row.submittedAt ? 'submitted' : row.openedAt ? 'opened' : 'waiting',
      fileName: row.fileName,
      fileUrl: row.objectKey ? `/api/v1/upload/file?key=${encodeURIComponent(row.objectKey)}` : null,
      files: (row.files?.length ? row.files : row.objectKey ? [{ objectKey: row.objectKey, fileName: row.fileName, contentType: row.contentType }] : []).map((file) => ({ fileName: file.fileName, contentType: file.contentType, fileUrl: `/api/v1/upload/file?key=${encodeURIComponent(file.objectKey)}` })),
      reviewStatus: row.reviewStatus || 'pending', reviewReason: row.reviewReason, reviewedAt: row.reviewedAt?.toISOString() || null,
      registrationId: row.registrationId,
    };
  }

  private hash(value: string) {
    return createHash('sha256').update(value).digest('hex');
  }
}
