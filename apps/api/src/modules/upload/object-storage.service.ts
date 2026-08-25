import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client } from 'minio';
import { extname } from 'path';
import { nanoid } from 'nanoid';
import type { Readable } from 'stream';

export interface StoredObject {
  bucket: string;
  objectKey: string;
  /** 对象在 COS 上的规范地址。桶是私有的，浏览器/小程序直接取会 403，只作内部记录 */
  publicUrl: string;
  /** 可直接放进 <img>/<image> 的地址：走 API 代理读私有桶 */
  fileUrl: string;
}

export interface ReadObject {
  stream: Readable;
  contentType?: string;
  contentLength?: number;
}

@Injectable()
export class ObjectStorageService {
  private readonly logger = new Logger(ObjectStorageService.name);
  private readonly client: Client | null;
  private readonly bucket: string;
  private readonly publicBaseUrl: string;
  /** 代理读取的前缀，如 https://prsznh.cn/api/v1/upload/file */
  private readonly fileEndpoint: string;
  /** 对外主机名，如 https://prsznh.cn；用于把存量的相对代理路径补成绝对地址 */
  private readonly appBaseUrl: string;

  constructor(private readonly config: ConfigService) {
    this.bucket = this.config.get<string>('COS_BUCKET') || this.config.get<string>('MINIO_BUCKET', '');
    this.publicBaseUrl = this.trimRightSlash(
      this.config.get<string>('COS_PUBLIC_BASE_URL') ||
        this.config.get<string>('MINIO_PUBLIC_BASE_URL', ''),
    );
    // 桶是私有的（对象直连 403），照片一律经 GET /upload/file?key= 代理读。
    // 小程序 <image> 拿不到相对路径，所以这里必须是绝对地址；没配就退化成相对路径，
    // 同域的后台仍能显示，小程序会显示不出来 —— 部署时务必配上 APP_PUBLIC_BASE_URL。
    const appBase = this.trimRightSlash(this.config.get<string>('APP_PUBLIC_BASE_URL', ''));
    this.appBaseUrl = appBase;
    const prefix = this.trimRightSlash(
      this.config.get<string>('API_GLOBAL_PREFIX', 'api/v1'),
    ).replace(/^\/+/, '');
    this.fileEndpoint = `${appBase}/${prefix}/upload/file`;

    const secretId =
      this.config.get<string>('COS_SECRET_ID') ||
      this.config.get<string>('MINIO_ACCESS_KEY', '');
    const secretKey =
      this.config.get<string>('COS_SECRET_KEY') ||
      this.config.get<string>('MINIO_SECRET_KEY', '');
    const region = this.config.get<string>('COS_REGION', 'ap-shanghai');
    const endpoint = this.normalizeEndpoint(
      this.config.get<string>('COS_ENDPOINT') ||
        this.config.get<string>('MINIO_ENDPOINT') ||
        `cos.${region}.myqcloud.com`,
    );
    const useSSL = this.config.get<string>('MINIO_USE_SSL')
      ? this.config.get<string>('MINIO_USE_SSL') === 'true'
      : true;
    const port = parseInt(
      this.config.get<string>('COS_PORT') ||
        this.config.get<string>('MINIO_PORT') ||
        (useSSL ? '443' : '80'),
      10,
    );

    this.client =
      this.bucket && secretId && secretKey
        ? new Client({
            endPoint: endpoint,
            port,
            useSSL,
            accessKey: secretId,
            secretKey,
            region,
            pathStyle: false,
          })
        : null;
  }

  isConfigured(): boolean {
    return Boolean(this.client && this.bucket && this.publicBaseUrl);
  }

  /** objectKey → 可展示地址（经 API 代理读私有桶） */
  fileUrl(objectKey: string): string {
    return `${this.fileEndpoint}?key=${encodeURIComponent(objectKey.replace(/^\/+/, ''))}`;
  }

  /**
   * 把任何历史写法的附件地址收敛成可展示地址。
   * 库里存量数据是 COS 直连地址（私有桶 → 403，前端表现为黑屏/灰图），
   * 读取时统一翻译成代理地址，不用改历史数据。
   */
  toDisplayUrl(url?: string | null): string {
    if (!url) return '';
    const value = String(url).trim();
    if (!value) return '';
    // 已经是代理地址。但可能是**相对**的：早期部署没配 APP_PUBLIC_BASE_URL 时，
    // fileEndpoint 退化成 /api/v1/upload/file，这个相对路径被写进了库
    // （materials.photo_url、attachments 里都有存量）。
    // 小程序的 <image src="/api/v1/..."> 会去本地包里找，结果是一张全白的图 ——
    // 「铁井盖」那张就是这么白的。这里补回主机名，历史数据不用改。
    if (value.includes('/upload/file?key=')) {
      return value.startsWith('/') ? `${this.appBaseUrl}${value}` : value;
    }
    // COS 直连地址 → 取 objectKey 转代理
    if (this.publicBaseUrl && value.startsWith(this.publicBaseUrl + '/')) {
      return this.fileUrl(value.slice(this.publicBaseUrl.length + 1).split('?')[0]);
    }
    // 裸 objectKey（uploads/... 或 qr-codes/...）
    if (/^(uploads|qr-codes)\//.test(value)) return this.fileUrl(value);
    // 外部地址（http/https）原样返回，别把不认识的东西改坏
    return value;
  }

  /** 批量版本，供 attachments/resultAttachments 使用 */
  toDisplayUrls(urls?: string[] | null): string[] {
    if (!Array.isArray(urls)) return [];
    return urls.map((url) => this.toDisplayUrl(url)).filter(Boolean);
  }

  async putBuffer(
    buffer: Buffer,
    contentType: string,
    folder = 'uploads',
    originalName?: string,
  ): Promise<StoredObject> {
    if (!this.client || !this.bucket || !this.publicBaseUrl) {
      throw new Error('COS storage is not configured');
    }

    const objectKey = this.buildObjectKey(folder, originalName);
    await this.client.putObject(this.bucket, objectKey, buffer, buffer.length, {
      'Content-Type': contentType,
    });

    return {
      bucket: this.bucket,
      objectKey,
      publicUrl: `${this.publicBaseUrl}/${objectKey}`,
      fileUrl: this.fileUrl(objectKey),
    };
  }

  /**
   * 写到指定 objectKey（覆盖同名对象）。
   * 用于二维码这类「同一实体重新生成要覆盖旧图、URL 保持不变」的场景 ——
   * 走 putBuffer 的随机 key 会每次留下一张废图，且已印出去的链接会失效。
   */
  async putBufferAtKey(
    objectKey: string,
    buffer: Buffer,
    contentType: string,
  ): Promise<StoredObject> {
    if (!this.client || !this.bucket || !this.publicBaseUrl) {
      throw new Error('COS storage is not configured');
    }
    const key = objectKey.replace(/^\/+/, '');
    await this.client.putObject(this.bucket, key, buffer, buffer.length, {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=300',
    });
    return {
      bucket: this.bucket,
      objectKey: key,
      publicUrl: `${this.publicBaseUrl}/${key}`,
      fileUrl: this.fileUrl(key),
    };
  }

  async tryPutBuffer(
    buffer: Buffer,
    contentType: string,
    folder: string,
    originalName?: string,
  ): Promise<StoredObject | null> {
    if (!this.isConfigured()) return null;
    try {
      return await this.putBuffer(buffer, contentType, folder, originalName);
    } catch (error) {
      this.logger.warn(
        `COS upload failed: ${error instanceof Error ? error.message : error}`,
      );
      return null;
    }
  }

  async getObject(objectKey: string): Promise<ReadObject> {
    if (!this.client || !this.bucket) {
      throw new Error('COS storage is not configured');
    }

    const stat = await this.client.statObject(this.bucket, objectKey);
    const stream = await this.client.getObject(this.bucket, objectKey);
    return {
      stream,
      contentType: stat.metaData?.['content-type'],
      contentLength: stat.size,
    };
  }

  private buildObjectKey(folder: string, originalName?: string): string {
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const ext = this.safeExt(originalName);
    return `${folder}/${yyyy}/${mm}/${dd}/${nanoid(20)}${ext}`;
  }

  private safeExt(originalName?: string): string {
    if (!originalName) return '';
    const ext = extname(originalName).toLowerCase();
    return /^[a-z0-9.]{1,12}$/.test(ext) ? ext : '';
  }

  private trimRightSlash(value: string): string {
    return value.replace(/\/+$/, '');
  }

  private normalizeEndpoint(value: string): string {
    return value.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  }
}
