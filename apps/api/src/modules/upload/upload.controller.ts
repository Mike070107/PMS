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
    const stored = await this.storage.putBuffer(
      file.buffer,
      file.mimetype || 'application/octet-stream',
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
      if (object.contentType) res.setHeader('Content-Type', object.contentType);
      if (object.contentLength) res.setHeader('Content-Length', String(object.contentLength));
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
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
