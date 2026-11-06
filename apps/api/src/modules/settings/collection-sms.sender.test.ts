import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildAliyunSmsQuery,
  percentEncode,
  renderSmsContent,
  smsSegments,
} from './collection-sms.sender';

const base = {
  accessKeyId: 'test-key-id',
  accessKeySecret: 'test-secret',
  phone: '13800000001',
  signName: '永德路228弄物业',
  templateCode: 'SMS_512532842',
  templateParam: { address: '20号601室', period: '2025.12-2026.11', amount: '1922.40' },
  timestamp: '2026-11-06T01:00:00Z',
  nonce: 'fixed-nonce-0001',
};

test('RFC3986 编码：空格/星号/波浪号', () => {
  assert.equal(percentEncode('a b'), 'a%20b');
  assert.equal(percentEncode('a*b'), 'a%2Ab');
  assert.equal(percentEncode('a~b'), 'a~b');
  assert.equal(percentEncode('中'), '%E4%B8%AD');
});

test('签名确定：同参数同签名，换密钥就变', () => {
  const a = buildAliyunSmsQuery(base);
  const b = buildAliyunSmsQuery(base);
  assert.equal(a.signature, b.signature);
  assert.match(a.signature, /^[A-Za-z0-9+/]{27}=$/);
  const c = buildAliyunSmsQuery({ ...base, accessKeySecret: 'other-secret' });
  assert.notEqual(a.signature, c.signature);
  assert.match(a.url, /Signature=/);
});

test('参数按 key 排序且业务参数齐全', () => {
  const { url, params } = buildAliyunSmsQuery(base);
  assert.equal(params.Action, 'SendSms');
  assert.equal(params.PhoneNumbers, '13800000001');
  assert.equal(params.TemplateParam, JSON.stringify(base.templateParam));
  const canonical = url.split('?')[1].split('&').filter((p) => !p.startsWith('Signature='));
  const keys = canonical.map((p) => decodeURIComponent(p.split('=')[0]));
  assert.deepEqual(keys, [...keys].sort());
  assert.ok(keys.includes('PhoneNumbers') && keys.includes('TemplateCode') && keys.includes('SignName'));
});

test('模板渲染四个变量，未知变量原样保留', () => {
  const out = renderSmsContent('尊敬的业主，截至${date}，${address}的${period}物业费${amount}元待缴。${unknown}', {
    date: '2026-11-06',
    address: '20号601室',
    period: '2025.12-2026.11',
    amount: '1922.40',
  });
  assert.equal(out, '尊敬的业主，截至2026-11-06，20号601室的2025.12-2026.11物业费1922.40元待缴。${unknown}');
});

test('计费条数：70 字一条，超出 67 字拼接', () => {
  assert.equal(smsSegments('字'.repeat(70)), 1);
  assert.equal(smsSegments('字'.repeat(71)), 2);
  assert.equal(smsSegments('字'.repeat(135)), 3);
});
