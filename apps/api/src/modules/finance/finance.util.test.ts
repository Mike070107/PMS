import assert from 'node:assert/strict';
import test from 'node:test';
import { decryptFinanceSecret, encryptFinanceSecret, resolveFinanceKey } from './finance.crypto';
import { extractInvoiceHints, isInvoiceAttachment, isPdfAttachment, sha256 } from './finance.util';

test('邮箱授权码加密后可解密，密文不包含原文', () => {
  const key = resolveFinanceKey('a-test-key-long-enough');
  const secret = 'sixteen-char-code';
  const encrypted = encryptFinanceSecret(secret, key);
  assert.equal(encrypted.includes(secret), false);
  assert.equal(decryptFinanceSecret(encrypted, key), secret);
});

test('识别常见发票附件并提取 XML 线索', () => {
  assert.equal(isInvoiceAttachment('invoice.ofd'), true);
  assert.equal(isInvoiceAttachment('readme.exe'), false);
  const xml = Buffer.from('<InvoiceNo>123456789012</InvoiceNo><InvoiceDate>2026-09-24</InvoiceDate><TotalAmount>128.50</TotalAmount>');
  assert.deepEqual(extractInvoiceHints('invoice.xml', xml), {
    amount: '128.50', invoiceNo: '123456789012', invoiceCode: null, invoiceDate: '2026-09-24',
  });
  assert.equal(sha256(xml), sha256(Buffer.from(xml)));
});

test('QQ 邮箱同步只接收 PDF 附件', () => {
  assert.equal(isPdfAttachment('invoice.PDF', 'application/octet-stream'), true);
  assert.equal(isPdfAttachment('', 'application/pdf'), true);
  assert.equal(isPdfAttachment('invoice.xml', 'application/xml'), false);
  assert.equal(isPdfAttachment('invoice.ofd', 'application/octet-stream'), false);
  assert.equal(isPdfAttachment('invoice.jpg', 'image/jpeg'), false);
});

test('密钥缺失时拒绝保存凭据', () => {
  assert.throws(() => resolveFinanceKey(''), /FINANCE_SECRET_KEY_MISSING/);
});
