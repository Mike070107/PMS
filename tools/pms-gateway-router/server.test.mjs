import assert from 'node:assert/strict';
import test from 'node:test';

process.env.NODE_ENV = 'test';
const { normalizeHostname, rewriteCookies, rewriteLocation, stripGatewayCookie } = await import('./server.mjs');

test('only registered zone-shaped hostnames reach routing', () => {
  assert.equal(normalizeHostname('CaiWu.prsznh.cn:443'), 'caiwu.prsznh.cn');
  assert.throws(() => normalizeHostname('prsznh.cn'));
  assert.throws(() => normalizeHostname('caiwu.example.com'));
});

test('gateway cookie is never forwarded to the intranet origin', () => {
  assert.equal(stripGatewayCookie('sid=abc; __Secure-pms_gateway=secret; theme=light'), 'sid=abc; theme=light');
});

test('origin redirects and cookie domains are rewritten to the public host', () => {
  const headers = { location: 'http://192.168.1.20:8050/login' };
  rewriteLocation(headers, 'caiwu.prsznh.cn', '192.168.1.20:8050');
  assert.equal(headers.location, 'https://caiwu.prsznh.cn/login');
  const cookieHeaders = { 'set-cookie': ['sid=1; Domain=192.168.1.20; Path=/'] };
  rewriteCookies(cookieHeaders, 'caiwu.prsznh.cn');
  assert.match(cookieHeaders['set-cookie'][0], /Domain=caiwu\.prsznh\.cn/);
});
