import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { compressUploadedImage } from './image-compression';
import { canonicalUploadFilename, UploadController } from './upload.controller';

function pixels(width: number, height: number) {
  const data = Buffer.alloc(width * height * 4); let seed = 123;
  for (let i = 0; i < data.length; i += 4) {
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
    data[i] = seed & 255; data[i + 1] = (seed >>> 8) & 255; data[i + 2] = (seed >>> 16) & 255; data[i + 3] = 120;
  }
  return { data, raw: { width, height, channels: 4 as const } };
}

test('统一上传路由：PNG真实编码为更小WebP后再存储，MIME/对象后缀同步，不信任客户端MIME', async () => {
  const p = pixels(768, 512); const buffer = await sharp(p.data, { raw: p.raw }).png().toBuffer();
  let stored: any;
  const controller = new UploadController({ async putBuffer(data: Buffer, type: string, folder: string, name: string) {
    stored = { data, type, folder, name }; return { bucket: 'isolated', objectKey: 'uploads/fixture.webp', fileUrl: '/upload/file?key=uploads/fixture.webp', publicUrl: 'isolated' };
  } } as any);
  const response = await controller.upload({ buffer, originalname: '现场照片.png', mimetype: 'text/html' } as any);
  assert.equal(stored.type, 'image/webp'); assert.match(stored.name, /\.webp$/); assert.ok(stored.data.length < buffer.length);
  const meta = await sharp(stored.data).metadata(); assert.equal(meta.format, 'webp'); assert.equal(meta.hasAlpha, true);
  assert.equal(response.publicUrl, '/upload/file?key=uploads/fixture.webp');
});

test('大图限制长边2048，不放大小图，应用EXIF旋转且移除定位/原始元数据', async () => {
  const p = pixels(2600, 600); const buffer = await sharp(p.data, { raw: p.raw }).jpeg({ quality: 100 }).withMetadata({ orientation: 6 }).toBuffer();
  const result = await compressUploadedImage(buffer, 'image/jpeg', '现场.jpg'); const meta = await sharp(result.buffer).metadata();
  assert.equal(meta.format, 'webp'); assert.equal(meta.width, Math.round(600 * 2048 / 2600)); assert.equal(meta.height, 2048);
  assert.equal(meta.exif, undefined); assert.equal(meta.orientation, undefined);
});

test('视频/PDF/GIF、小图及无法解码图片不擅自改字节/改后缀；压缩失败不阻断上传', async () => {
  for (const contentType of ['video/mp4', 'video/quicktime', 'application/pdf', 'image/gif', 'image/jpeg']) {
    const buffer = Buffer.alloc(40000, 10); const result = await compressUploadedImage(buffer, contentType, 'fixture.bin');
    assert.equal(result.buffer, buffer); assert.equal(result.contentType, contentType); assert.equal(result.filename, 'fixture.bin');
  }
  const p = pixels(16, 16); const buffer = await sharp(p.data, { raw: p.raw }).png().toBuffer();
  const result = await compressUploadedImage(buffer, 'image/png', 'tiny.png'); assert.equal(result.buffer, buffer);
});

test('临时文件或伪扩展名的视频按真实签名规范后缀，附件播放器可识别且视频字节不变', async () => {
  for (const [brand, ext] of [['isom', 'mp4'], ['qt  ', 'mov']]) {
    const buffer = Buffer.alloc(40000); buffer.write('ftyp', 4); buffer.write(brand, 8);
    let stored: any;
    const controller = new UploadController({ async putBuffer(data: Buffer, type: string, folder: string, name: string) {
      stored = { data, type, folder, name }; return { fileUrl: 'fixture', publicUrl: 'fixture' };
    } } as any);
    await controller.upload({ buffer, originalname: 'wx_tmp.bad', mimetype: 'image/png' } as any);
    assert.equal(stored.data, buffer); assert.match(stored.name, new RegExp(`\\.${ext}$`));
    assert.equal(stored.type, ext === 'mp4' ? 'video/mp4' : 'video/quicktime');
  }
  assert.equal(canonicalUploadFilename('C:\\camera\\现场.png', 'image/webp'), '现场.webp');
  assert.equal(canonicalUploadFilename(undefined, 'image/png'), 'upload.png');
});

test('匿名通用代理不得读取protected经验图片，也不能借此探测对象是否存在', async () => {
  let reads = 0; const controller = new UploadController({ async getObject() { reads++; throw Error('must not touch storage'); } } as any);
  for (const key of ['protected/repair-experiences/42/9/image.webp', 'protected//repair-experiences/42/9/image.webp', 'protected/other/image.webp']) {
    await assert.rejects(controller.file(key, {} as any), (error: any) => error.getStatus() === 404);
  }
  for (const key of ['./protected/repair-experiences/42/9/image.webp', 'uploads/./photo.webp']) {
    await assert.rejects(controller.file(key, {} as any), (error: any) => error.getStatus() === 400);
  }
  assert.equal(reads, 0);
});

test('APNG帧控制与真实多帧WebP保持原字节，不静默压成首帧', async () => {
  const p = pixels(256, 256);
  const frame2 = Buffer.from(p.data.map(value => 255 - value));
  const animated = await sharp(Buffer.concat([p.data, frame2]), { raw: { ...p.raw, height: 512, pageHeight: 256 } as any })
    .webp({ quality: 100, loop: 0, delay: [100, 100] }).toBuffer();
  assert.equal((await sharp(animated, { animated: true }).metadata()).pages, 2);
  assert.ok(animated.length > 32768);
  assert.equal((await compressUploadedImage(animated, 'image/webp', 'animated.webp')).buffer, animated);
  const apng = Buffer.alloc(40000); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(apng);
  apng.writeUInt32BE(8, 8); apng.write('acTL', 12); apng.writeUInt32BE(2, 16);
  assert.equal((await compressUploadedImage(apng, 'image/png', 'animated.png')).buffer, apng);
});
