import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Post,
  Query,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ObjectStorageService } from './object-storage.service';

@Controller('upload')
export class UploadController {
  constructor(private readonly storage: ObjectStorageService) {}

  @Post()
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 50 * 1024 * 1024 } }))
  async upload(@UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new BadRequestException('file is required');
    const detectedType = detectUploadContentType(file.buffer);
    if (!detectedType) {
      throw new BadRequestException('只支持 JPG/PNG/GIF/WebP/HEIC 图片、MP4/MOV 视频或 PDF');
    }
    const stored = await this.storage.putBuffer(
      file.buffer,
      // 浏览器报上来的 mimetype 可以伪造；对象元数据必须用文件签名识别出的安全类型。
      detectedType,
      'uploads',
      file.originalname,
    );
    // COS 桶是私有的，直连地址会 403。这里返回的 publicUrl/displayUrl 都是代理地址，
    // 前端把它写进 attachments 就能直接显示；COS 规范地址另放 cosUrl，只作排障参考。
    return {
      bucket: stored.bucket,
      objectKey: stored.objectKey,
      publicUrl: stored.fileUrl,
      displayUrl: stored.fileUrl,
      cosUrl: stored.publicUrl,
    };
  }

  @Get('file')
  async file(@Query('key') key: string, @Res() res: Response) {
    const objectKey = this.validateObjectKey(key);
    try {
      const object = await this.storage.getObject(objectKey);
      const contentType = safeStoredContentType(object.contentType);
      res.setHeader('Content-Type', contentType);
      if (object.contentLength) res.setHeader('Content-Length', String(object.contentLength));
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader(
        'Content-Disposition',
        contentType === 'application/octet-stream' ? 'attachment' : 'inline',
      );
      // 二维码会覆盖固定 key，不能缓存一年；普通上传是随机 key，可以长期缓存。
      res.setHeader(
        'Cache-Control',
        objectKey.startsWith('qr-codes/')
          ? 'public, max-age=300, must-revalidate'
          : 'public, max-age=31536000, immutable',
      );
      object.stream.pipe(res);
    } catch {
      throw new NotFoundException('file not found');
    }
  }

  private validateObjectKey(key?: string) {
    if (!key || key.length > 512 || key.startsWith('/') || key.includes('..') || key.includes('\\')) {
      throw new BadRequestException('invalid file key');
    }
    if (!/^[a-zA-Z0-9/_\-.]+$/.test(key)) {
      throw new BadRequestException('invalid file key');
    }
    return key;
  }
}

const SAFE_STORED_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/heic',
  'image/heif',
  'video/mp4',
  'video/quicktime',
  'application/pdf',
]);

/** 读取历史对象时也不信任元数据；旧的 text/html / SVG 一律作为下载流，不能同源执行。 */
export function safeStoredContentType(value?: string): string {
  const type = String(value || '').split(';')[0].trim().toLowerCase();
  return SAFE_STORED_TYPES.has(type) ? type : 'application/octet-stream';
}

/** 用文件签名判断允许类型，防止把 HTML/SVG 伪装成图片上传后从同源地址执行。 */
export function detectUploadContentType(buffer: Buffer): string | null {
  if (!buffer?.length) return null;
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return 'image/png';
  }
  const head6 = buffer.subarray(0, 6).toString('ascii');
  if (head6 === 'GIF87a' || head6 === 'GIF89a') return 'image/gif';
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  if (buffer.length >= 5 && buffer.subarray(0, 5).toString('ascii') === '%PDF-') {
    return 'application/pdf';
  }
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = buffer.subarray(8, 12).toString('ascii').toLowerCase();
    if (['heic', 'heix', 'hevc', 'hevx'].includes(brand)) return 'image/heic';
    if (['mif1', 'msf1'].includes(brand)) return 'image/heif';
    if (brand === 'qt  ') return 'video/quicktime';
    return 'video/mp4';
  }
  return null;
}
