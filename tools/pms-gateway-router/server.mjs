import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

const listenHost = process.env.GATEWAY_ROUTER_HOST || '127.0.0.1';
const listenPort = Number(process.env.GATEWAY_ROUTER_PORT || 4190);
const apiBase = (process.env.PMS_API_INTERNAL_URL || 'http://127.0.0.1:4000/api/v1').replace(/\/$/, '');
const publicApiBase = (process.env.PMS_PUBLIC_API_URL || 'https://prsznh.cn/api/v1').replace(/\/$/, '');
const sessionCookie = '__Secure-pms_gateway';
const routerSecret = process.env.LAN_GATEWAY_ROUTER_SECRET || '';

const server = http.createServer(async (request, response) => {
  if (request.url === '/_pms_gateway/healthz') return json(response, 200, { ok: true });
  try {
    const hostname = normalizeHostname(request.headers.host);
    const route = await authorize(hostname, request.headers.cookie);
    proxyHttp(request, response, hostname, route);
  } catch (error) {
    handleError(request, response, error);
  }
});

server.on('upgrade', async (request, socket, head) => {
  try {
    const hostname = normalizeHostname(request.headers.host);
    const route = await authorize(hostname, request.headers.cookie);
    proxyUpgrade(request, socket, head, hostname, route);
  } catch (error) {
    const status = Number(error.status || 502);
    socket.end(`HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : 'Bad Gateway'}\r\nConnection: close\r\n\r\n`);
  }
});

if (process.env.NODE_ENV !== 'test') {
  server.listen(listenPort, listenHost, () => {
    process.stdout.write(`PMS gateway router listening on http://${listenHost}:${listenPort}\n`);
  });
}

async function authorize(hostname, cookie) {
  const url = `${apiBase}/gateway-access/verify?hostname=${encodeURIComponent(hostname)}`;
  const { status, body } = await requestJson(url, {
    ...(cookie ? { cookie } : {}),
    'x-pms-gateway-router-secret': routerSecret,
  }, 5000);
  if (status < 200 || status >= 300) {
    const error = new Error(body.message || '网关授权失败');
    error.status = status;
    throw error;
  }
  return body;
}

function requestJson(value, headers = {}, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const url = new URL(value);
    const transport = url.protocol === 'https:' ? https : http;
    const request = transport.request(url, { method: 'GET', headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body = {};
        try { body = text ? JSON.parse(text) : {}; } catch { /* API errors still retain the HTTP status. */ }
        resolve({ status: response.statusCode || 502, body });
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error('PMS 授权服务响应超时')));
    request.on('error', reject);
    request.end();
  });
}

function proxyHttp(request, response, hostname, route) {
  const upstream = new URL(route.upstream);
  const headers = forwardedHeaders(request.headers, hostname, request.socket.remoteAddress);
  const proxy = http.request({ hostname: upstream.hostname, port: upstream.port, method: request.method, path: applicationRequestPath(request.url), headers }, (upstreamResponse) => {
    const responseHeaders = { ...upstreamResponse.headers };
    rewriteLocation(responseHeaders, hostname, route.originHost);
    rewriteCookies(responseHeaders, hostname);
    response.writeHead(upstreamResponse.statusCode || 502, responseHeaders);
    upstreamResponse.pipe(response);
  });
  proxy.setTimeout(300_000, () => proxy.destroy(new Error('内网站点响应超时')));
  proxy.on('error', (error) => errorPage(response, 502, '内网应用暂时无法访问', error.message));
  request.pipe(proxy);
}

function proxyUpgrade(request, socket, head, hostname, route) {
  const upstream = new URL(route.upstream);
  const target = net.connect(Number(upstream.port), upstream.hostname, () => {
    const headers = forwardedHeaders(request.headers, hostname, request.socket.remoteAddress);
    const lines = [`${request.method} ${applicationRequestPath(request.url)} HTTP/${request.httpVersion}`];
    for (const [name, value] of Object.entries(headers)) {
      if (Array.isArray(value)) for (const item of value) lines.push(`${name}: ${item}`);
      else if (value !== undefined) lines.push(`${name}: ${value}`);
    }
    target.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head?.length) target.write(head);
    socket.pipe(target).pipe(socket);
  });
  target.setTimeout(300_000);
  target.on('error', () => socket.destroy());
  socket.on('error', () => target.destroy());
}

function forwardedHeaders(original, publicHost, remoteAddress) {
  const headers = { ...original };
  // The browser's Origin is the public hostname. Preserving that Host through
  // the tunnel keeps host-bound sessions and JWT generation in the same
  // browser origin as the application page, while the TCP destination remains
  // the private origin selected by `route.upstream`.
  headers.host = publicHost;
  headers['x-forwarded-host'] = publicHost;
  headers['x-forwarded-proto'] = 'https';
  headers['x-real-ip'] = remoteAddress || '';
  headers.cookie = stripGatewayCookie(original.cookie);
  delete headers['x-pms-gateway-router-secret'];
  delete headers['content-length'];
  if (!headers.cookie) delete headers.cookie;
  return headers;
}

function stripGatewayCookie(value = '') {
  return String(value).split(';').map((part) => part.trim()).filter((part) => part && !part.startsWith(`${sessionCookie}=`)).join('; ');
}

function rewriteLocation(headers, publicHost, originHost) {
  const location = headers.location;
  if (!location) return;
  try {
    const url = new URL(location);
    if (url.host.toLowerCase() === String(originHost).toLowerCase()) {
      url.protocol = 'https:'; url.hostname = publicHost; url.port = ''; headers.location = url.toString();
    }
  } catch { /* relative redirect remains valid */ }
}

function rewriteCookies(headers, publicHost) {
  if (!headers['set-cookie']) return;
  headers['set-cookie'] = headers['set-cookie'].map((cookie) => cookie.replace(/;\s*Domain=[^;]+/ig, `; Domain=${publicHost}`));
}

function handleError(request, response, error) {
  const status = Number(error.status || 502);
  if (status === 401 || status === 403) {
    const hostname = normalizeHostname(request.headers.host);
    const returnTo = `https://${hostname}${request.url || '/'}`;
    response.writeHead(302, { location: `${publicApiBase}/gateway-access/start?hostname=${encodeURIComponent(hostname)}&returnTo=${encodeURIComponent(returnTo)}`, 'cache-control': 'no-store' });
    return response.end();
  }
  errorPage(response, status === 404 ? 404 : 503, status === 404 ? '没有这个内网应用' : '内网应用暂时不可用', error.message);
}

function normalizeHostname(value) {
  const hostname = String(value || '').trim().toLowerCase().split(':')[0];
  if (!/^[a-z0-9][a-z0-9-]*\.prsznh\.cn$/.test(hostname)) throw Object.assign(new Error('域名无效'), { status: 404 });
  return hostname;
}

// The configured entry path is only the initial launch URL. After an
// application signs in, it may deliberately redirect from /login to /. Never
// rewrite that navigation back to the launch path or the user enters a login
// loop.
function applicationRequestPath(value) {
  return String(value || '/');
}

function errorPage(response, status, title, detail) {
  if (response.headersSent) return response.destroy();
  const reference = Math.random().toString(36).slice(2, 10).toUpperCase();
  response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  response.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f2f7f6;color:#163a3b;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}.card{width:min(520px,calc(100% - 32px));padding:32px;background:#fff;border:1px solid #dce8e6;border-radius:18px;box-shadow:0 18px 50px rgba(15,118,110,.1)}h1{font-size:24px}p{color:#5f7475;line-height:1.7}.ref{font-family:Consolas,monospace;color:#0f766e}</style><main class="card"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail || '请稍后重试，或联系 PMS 管理员查看发布状态。')}</p><p class="ref">查询编号 ${reference}</p></main></html>`);
}

function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] || char);
}

export { applicationRequestPath, forwardedHeaders, normalizeHostname, requestJson, rewriteCookies, rewriteLocation, stripGatewayCookie };
