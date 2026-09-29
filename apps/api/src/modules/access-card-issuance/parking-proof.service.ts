import { BadRequestException, GoneException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomBytes } from 'node:crypto';
import * as QRCode from 'qrcode';
import { Repository } from 'typeorm';
import { AuthUser } from '../../common/current-user.decorator';
import { ParkingProofUpload } from '../../entities';
import { detectUploadContentType } from '../upload/upload.controller';
import { ObjectStorageService } from '../upload/object-storage.service';
import { CreateParkingProofUploadDto } from './dto';

const TTL_MS = 30 * 60 * 1000;

@Injectable()
export class ParkingProofService {
  constructor(
    @InjectRepository(ParkingProofUpload)
    private readonly repo: Repository<ParkingProofUpload>,
    private readonly storage: ObjectStorageService,
    private readonly config: ConfigService,
  ) {}

  async create(dto: CreateParkingProofUploadDto, user: AuthUser) {
    if (!user.tenantId) throw new BadRequestException('当前账号没有物业公司范围');
    const plate = dto.plate.trim().toUpperCase().replace(/\s+/g, '');
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

  async session(token: string) {
    const row = await this.byToken(token);
    if (!row.openedAt) {
      row.openedAt = new Date();
      await this.repo.save(row);
    }
    return this.view(row);
  }

  async submit(token: string, file?: Express.Multer.File) {
    const row = await this.byToken(token);
    if (row.submittedAt) throw new BadRequestException('证明材料已经上传，请关闭此页面');
    if (!file) throw new BadRequestException('请选择证明材料');
    const contentType = detectUploadContentType(file.buffer);
    if (!contentType || (!contentType.startsWith('image/') && contentType !== 'application/pdf')) {
      throw new BadRequestException('只支持 JPG、PNG、GIF、WebP、HEIC 图片或 PDF');
    }
    const stored = await this.storage.putBuffer(file.buffer, contentType, 'parking-proofs', file.originalname);
    row.objectKey = stored.objectKey;
    row.fileName = file.originalname.slice(0, 255);
    row.contentType = contentType;
    row.submittedAt = new Date();
    await this.repo.save(row);
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
    };
  }

  private hash(value: string) {
    return createHash('sha256').update(value).digest('hex');
  }
}
