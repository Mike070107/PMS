import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

process.env.NODE_ENV = 'test';
const { applicationRequestPath, browserSessionScript, forwardedHeaders, injectBrowserSession, normalizeHostname, requestJson, rewriteCookies, rewriteLocation, stripGatewayCookie } = await import('./server.mjs');

test('requestJson works without fetch or WebAssembly', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalWebAssembly = globalThis.WebAssembly;
  globalThis.fetch = undefined;
  globalThis.WebAssembly = undefined;
  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.WebAssembly = originalWebAssembly;
  });

  const server = http.createServer((request, response) => {
    assert.equal(request.headers.cookie, '__Secure-pms_gateway=session');
    response.writeHead(401, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ message: '请先扫码授权' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const address = server.address();
  const result = await requestJson(
    `http://127.0.0.1:${address.port}/verify`,
    { cookie: '__Secure-pms_gateway=session' },
  );
  assert.deepEqual(result, { status: 401, body: { message: '请先扫码授权' } });
});

test('only registered zone-shaped hostnames reach routing', () => {
  assert.equal(normalizeHostname('CaiWu.prsznh.cn:443'), 'caiwu.prsznh.cn');
  assert.throws(() => normalizeHostname('prsznh.cn'));
  assert.throws(() => normalizeHostname('caiwu.example.com'));
});

test('preserves an application redirect to the root after login', () => {
  // The property application starts at /login, but successful login navigates
  // to /. The gateway must pass that path through instead of sending it back.
  assert.equal(applicationRequestPath('/'), '/');
  assert.equal(applicationRequestPath('/dashboard?tab=home'), '/dashboard?tab=home');
});

test('gateway cookie is never forwarded to the intranet origin', () => {
  assert.equal(stripGatewayCookie('sid=abc; __Secure-pms_gateway=secret; theme=light'), 'sid=abc; theme=light');
});

test('the public host is preserved for browser-origin application sessions', () => {
  const headers = forwardedHeaders({
    host: 'wyglxt.prsznh.cn',
    cookie: '__Secure-pms_gateway=session; app_session=origin-session',
    origin: 'https://wyglxt.prsznh.cn',
  }, 'wyglxt.prsznh.cn', '127.0.0.1');
  assert.equal(headers.host, 'wyglxt.prsznh.cn');
  assert.equal(headers['x-forwarded-host'], 'wyglxt.prsznh.cn');
  assert.equal(headers['x-forwarded-proto'], 'https');
  assert.equal(headers.origin, 'https://wyglxt.prsznh.cn');
  assert.equal(headers.cookie, 'app_session=origin-session');
});

test('server-side target authorization overrides browser input and router secrets never reach the origin', () => {
  const headers = forwardedHeaders({
    host: 'wyglxt.prsznh.cn',
    authorization: 'Bearer browser-forged-token',
    'x-pms-gateway-router-secret': 'private-router-secret',
  }, 'wyglxt.prsznh.cn', '127.0.0.1', { authorization: 'Bearer target-token' });
  assert.equal(headers.authorization, 'Bearer target-token');
  assert.equal(headers['x-pms-gateway-router-secret'], undefined);
});

test('browser bootstrap contains only a harmless placeholder token and escaped profile JSON', () => {
  const script = browserSessionScript({
    token: 'placeholder.jwt.signature',
    user: { username: '</script><script>bad()</script>', role: '操作员' },
  });
  assert.match(script, /placeholder\.jwt\.signature/);
  assert.doesNotMatch(script, /<\/script><script>bad/);
  assert.match(script, /\\u003c\/script>/);
  const html = injectBrowserSession('<html><head><title>Target</title></head><body></body></html>', {
    token: 'placeholder.jwt.signature',
    user: { username: 'remote-user' },
  });
  assert.ok(html.indexOf('sessionStorage.setItem') < html.indexOf('</head>'));
});

test('origin redirects and cookie domains are rewritten to the public host', () => {
  const headers = { location: 'http://192.168.1.20:8050/login' };
  rewriteLocation(headers, 'caiwu.prsznh.cn', '192.168.1.20:8050');
  assert.equal(headers.location, 'https://caiwu.prsznh.cn/login');
  const cookieHeaders = { 'set-cookie': ['sid=1; Domain=192.168.1.20; Path=/'] };
  rewriteCookies(cookieHeaders, 'caiwu.prsznh.cn');
  assert.match(cookieHeaders['set-cookie'][0], /Domain=caiwu\.prsznh\.cn/);
});
