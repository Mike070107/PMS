import assert from 'node:assert/strict';
import test from 'node:test';
import { detectUploadContentType, safeStoredContentType } from './upload.controller';

test('上传类型按文件签名识别，不信任伪造扩展名或 mimetype', () => {
  assert.equal(detectUploadContentType(Buffer.from('<html><script>alert(1)</script>')), null);
  assert.equal(
    detectUploadContentType(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0])),
    'image/png',
  );
  assert.equal(detectUploadContentType(Buffer.from('%PDF-1.7\n')), 'application/pdf');
});

test('历史对象的危险 Content-Type 强制改成下载流', () => {
  assert.equal(safeStoredContentType('text/html'), 'application/octet-stream');
  assert.equal(safeStoredContentType('image/svg+xml'), 'application/octet-stream');
  assert.equal(safeStoredContentType('image/jpeg; charset=binary'), 'image/jpeg');
});
