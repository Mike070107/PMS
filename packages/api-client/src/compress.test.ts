import assert from 'node:assert/strict';
import test from 'node:test';
import { compressImageIfNeeded, compressMediaIfNeeded } from './compress';

function fixture(options: { bigger?: boolean; fail?: boolean } = {}) {
  const calls: any[] = []; const previous = (globalThis as any).wx;
  const sizes: Record<string, number> = { 'large.mp4': 60 * 1024 * 1024, 'photo.jpg': 2_000_000, 'small.png': 4000, 'tmp_extless_image': 2_000_000, 'video.mp4': 8_000_000, 'tmp_extless_video': 8_000_000, 'compressed.jpg': options.bigger ? 3_000_000 : 200_000, 'compressed.mp4': options.bigger ? 9_000_000 : 1_000_000 };
  (globalThis as any).wx = {
    getFileSystemManager: () => ({ getFileInfo: ({ filePath, success }: any) => success({ size: sizes[filePath] || 0 }) }),
    getImageInfo: ({ src, success, fail }: any) => src === 'tmp_extless_image' ? success({ width: 1600, height: 1200, type: 'jpeg' }) : fail({}),
    getVideoInfo: ({ src, success, fail }: any) => src === 'tmp_extless_video' ? success({ duration: 15, size: 8_000_000 }) : fail({}),
    compressImage: (o: any) => { calls.push(['image', o.quality]); options.fail ? o.fail({}) : o.success({ tempFilePath: 'compressed.jpg' }); },
    compressVideo: (o: any) => { calls.push(['video', o.quality]); options.fail ? o.fail({}) : o.success({ tempFilePath: 'compressed.mp4' }); },
  };
  return { calls, close: () => { if (previous === undefined) delete (globalThis as any).wx; else (globalThis as any).wx = previous; } };
}

test('大图统一压缩、小图不动、无扩展微信临时图片也识别', async () => {
  const f = fixture(); try {
    assert.equal(await compressImageIfNeeded('photo.jpg'), 'compressed.jpg');
    assert.equal(await compressImageIfNeeded('small.png'), 'small.png');
    assert.equal(await compressMediaIfNeeded('tmp_extless_image'), 'compressed.jpg');
    assert.deepEqual(f.calls, [['image', 80], ['image', 80]]);
  } finally { f.close(); }
});
test('视频走独立medium压缩，不送compressImage；无扩展视频可识别', async () => {
  const f = fixture(); try {
    assert.equal(await compressMediaIfNeeded('video.mp4'), 'compressed.mp4');
    assert.equal(await compressMediaIfNeeded('tmp_extless_video'), 'compressed.mp4');
    assert.deepEqual(f.calls, [['video', 'medium'], ['video', 'medium']]);
  } finally { f.close(); }
});
for (const options of [{ bigger: true }, { fail: true }]) test(`压缩变大或失败安全回退:${JSON.stringify(options)}`, async () => {
  const f = fixture(options); try {
    assert.equal(await compressMediaIfNeeded('photo.jpg'), 'photo.jpg');
    assert.equal(await compressMediaIfNeeded('video.mp4'), 'video.mp4');
  } finally { f.close(); }
});
test('文档、GIF、空路径不转码，无微信环境原样返回', async () => {
  const f = fixture(); try {
    for (const p of ['statement.pdf', 'photo.gif', 'animated.webp', 'animated.png', 'data.xlsx', '']) assert.equal(await compressMediaIfNeeded(p), p);
    assert.deepEqual(f.calls, []);
  } finally { f.close(); }
  const previous = (globalThis as any).wx; delete (globalThis as any).wx;
  try { assert.equal(await compressMediaIfNeeded('photo.jpg'), 'photo.jpg'); } finally { (globalThis as any).wx = previous; }
});
test('大视频先独立压缩；原生压缩失败且仍超50MB时明确报错，不浪费网络上传', async () => {
  const f = fixture();
  try { assert.equal(await compressMediaIfNeeded('large.mp4'), 'compressed.mp4'); }
  finally { f.close(); }
  const failed = fixture({ fail: true });
  try { await assert.rejects(compressMediaIfNeeded('large.mp4'), /超过50MB/); }
  finally { failed.close(); }
});
