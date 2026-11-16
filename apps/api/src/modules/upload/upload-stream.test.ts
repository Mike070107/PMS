import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';
import { UploadController } from './upload.controller';

function fixture() {
  const source = new Readable({ read() {} });
  const chunks: Buffer[] = [];
  const headers: Record<string, string> = {};
  const response = Object.assign(new Writable({ write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } }), {
    setHeader(name: string, value: string) { headers[name] = value; },
  });
  const controller = new UploadController({ async getObject() { return { stream: source, contentType: 'image/webp', contentLength: 4 }; } } as any);
  return { source, response, controller, chunks, headers };
}

test('通用媒体代理：异步存储流错误被处理并关闭响应，不能变成API未捕获error', async (t) => {
  const { source, response, controller } = fixture();
  t.after(() => { source.destroy(); response.destroy(); });
  await controller.file('uploads/fixture.webp', response as any);
  assert.ok(source.listenerCount('error') > 0, 'pipe本身不会监听源Readable错误');
  const closed = once(response, 'close');
  source.destroy(new Error('isolated storage socket reset'));
  await closed;
  assert.equal(response.destroyed, true);
});

test('通用媒体代理：客户端断开会取消上游读取，不能让COS流继续消耗资源', async (t) => {
  const { source, response, controller } = fixture();
  t.after(() => { source.destroy(); response.destroy(); });
  await controller.file('uploads/fixture.webp', response as any);
  const closed = once(response, 'close');
  response.destroy();
  await closed;
  assert.equal(source.destroyed, true);
});

test('通用媒体代理：正常流仍完整输出且保持MIME、nosniff与缓存响应头', async (t) => {
  const { source, response, controller, chunks, headers } = fixture();
  t.after(() => { source.destroy(); response.destroy(); });
  await controller.file('uploads/fixture.webp', response as any);
  const finished = once(response, 'finish');
  source.push(Buffer.from('RIFF')); source.push(null);
  await finished;
  assert.equal(Buffer.concat(chunks).toString(), 'RIFF');
  assert.equal(headers['Content-Type'], 'image/webp');
  assert.equal(headers['Content-Length'], '4');
  assert.equal(headers['X-Content-Type-Options'], 'nosniff');
  assert.match(headers['Cache-Control'], /immutable/);
});
