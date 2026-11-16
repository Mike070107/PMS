import assert from 'node:assert/strict';
import test from 'node:test';
import { configure, uploadBlobTo, uploadFile, uploadFileTo } from './request';

function setup(handler: typeof fetch, token = () => 'fixture-token') {
  const previous = globalThis.fetch; let cleared = 0;
  globalThis.fetch = handler;
  configure({ baseURL: 'https://fixture.invalid/api/', getToken: token,
    getExtraHeaders: () => ({ 'x-acting-tenant-id': '42', 'Content-Type': 'application/json' }),
    onUnauthorized: () => { cleared++; } });
  return { close: () => { globalThis.fetch = previous; }, cleared: () => cleared };
}

test('Web业务上传沿用baseURL/token/租户头，保留原始字节并让FormData生成边界，解包回执', async () => {
  const bytes = new Uint8Array([0, 2, 4, 255]); let calls = 0;
  const f = setup((async (url: any, opts: any) => {
    calls++; assert.equal(url, 'https://fixture.invalid/api/repair-experiences/assets');
    assert.equal(opts.method, 'POST'); assert.equal(opts.credentials, 'include');
    assert.equal(opts.headers.Authorization, 'Bearer fixture-token');
    assert.equal(opts.headers['x-acting-tenant-id'], '42'); assert.equal(opts.headers['Content-Type'], undefined);
    assert.ok(opts.body instanceof FormData);
    const file = opts.body.get('file') as File; assert.equal(file.name, '现场.png');
    assert.deepEqual(new Uint8Array(await file.arrayBuffer()), bytes);
    return new Response(JSON.stringify({ code: 0, data: { objectKey: 'protected/fixture.webp' } }));
  }) as any);
  try { assert.deepEqual(await uploadBlobTo(new Blob([bytes]), '/repair-experiences/assets', '现场.png'), { objectKey: 'protected/fixture.webp' }); assert.equal(calls, 1); }
  finally { f.close(); }
});

test('上传失败不重试，保留Nest数组错误和业务错误；异常成功回执不得当上传成功', async () => {
  for (const [status, body, expected] of [
    [413, '{"message":["图片太大","上限50MB"]}', /图片太大；上限50MB/],
    [200, '{"code":1001,"message":"无上传权限"}', /无上传权限/],
    [200, '<html>bad gateway</html>', /上传返回格式异常/],
  ] as const) {
    let calls = 0; const f = setup((async () => { calls++; return new Response(body, { status }); }) as any);
    try { await assert.rejects(uploadBlobTo(new Blob(['x']), '/assets'), expected); assert.equal(calls, 1); }
    finally { f.close(); }
  }
});

test('上传迟到401不清新账号会话，当前账号401仍正确失效', async () => {
  let token = 'A'; let finish!: (r: Response) => void;
  const f = setup((() => new Promise<Response>(resolve => { finish = resolve; })) as any, () => token);
  try {
    const first = uploadBlobTo(new Blob(['x']), '/assets'); token = 'B';
    finish(new Response('{"message":"expired"}', { status: 401 }));
    await assert.rejects(first, /expired/); assert.equal(f.cleared(), 0);
    const second = uploadBlobTo(new Blob(['x']), '/assets');
    finish(new Response('{}', { status: 401 }));
    await assert.rejects(second); assert.equal(f.cleared(), 1);
  } finally { f.close(); }
});

test('网络错误与超时明确失败且不自动重传POST', async () => {
  let calls = 0;
  const f = setup((async () => { calls++; throw new Error('network offline'); }) as any);
  try { await assert.rejects(uploadBlobTo(new Blob(['x']), '/assets'), /network offline/); assert.equal(calls, 1); }
  finally { f.close(); }
  const t = setup(((_url: any, opts: any) => new Promise((_resolve, reject) => {
    opts.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  })) as any);
  try { await assert.rejects(uploadBlobTo(new Blob(['x']), '/assets', 'x.png', 10), /上传超时/); }
  finally { t.close(); }
});

test('小程序压缩期间切账号或代管租户必须终止，不把旧图片传到新身份', async () => {
  const previous = (globalThis as any).wx;
  try {
    for (const switchKind of ['account', 'tenant']) {
      let token = 'A'; let tenant = '42'; let uploads = 0; let release!: (r: any) => void; let first = true;
      let enteredResolve!: () => void; const entered = new Promise<void>(resolve => { enteredResolve = resolve; });
      configure({ baseURL: 'https://fixture.invalid/api', getToken: () => token,
        getExtraHeaders: () => ({ 'x-acting-tenant-id': tenant }) });
      (globalThis as any).wx = { request() {}, uploadFile() { uploads++; throw Error('不应发出跨身份上传'); }, getFileSystemManager: () => ({ getFileInfo(opts: any) {
        if (first) { first = false; release = opts.success; enteredResolve(); } else opts.success({ size: 100 });
      } }) };
      const running = uploadFile('photo.jpg'); await entered;
      if (switchKind === 'account') token = 'B'; else tenant = '43';
      release({ size: 100 });
      await assert.rejects(running, /身份或租户已变更/); assert.equal(uploads, 0);
    }
  } finally { (globalThis as any).wx = previous; }
});

test('小程序业务上传保留原文件/租户头与multipart边界，迟到401不清新会话', async () => {
  const previous = (globalThis as any).wx; let token = 'A'; let cleared = 0; let finish!: (r: any) => void; let sent: any;
  configure({ baseURL: 'https://fixture.invalid/api', getToken: () => token,
    getExtraHeaders: () => ({ 'x-acting-tenant-id': '42', 'content-type': 'application/json' }),
    onUnauthorized: () => { cleared++; } });
  (globalThis as any).wx = { request() {}, compressImage() { throw Error('business bytes must not be recoded'); },
    uploadFile(opts: any) { sent = opts; finish = opts.success; } };
  try {
    const first = uploadFileTo('original-business.csv', '/imports');
    assert.equal(sent.filePath, 'original-business.csv'); assert.equal(sent.header['x-acting-tenant-id'], '42');
    assert.equal(sent.header['content-type'], undefined);
    token = 'B'; finish({ statusCode: 401, data: '{}' }); await assert.rejects(first); assert.equal(cleared, 0);
    const second = uploadFileTo('original-business.csv', '/imports');
    finish({ statusCode: 401, data: '{}' }); await assert.rejects(second); assert.equal(cleared, 1);
  } finally { (globalThis as any).wx = previous; }
});
