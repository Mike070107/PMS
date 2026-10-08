import assert from 'node:assert/strict';
import test from 'node:test';
import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { OidcController } from './oidc.controller';
import { OidcService } from './oidc.service';

function fixture() {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const values: Record<string, string> = {
    EXTERNAL_OIDC_ISSUER: 'https://prsznh.cn/api/v1/auth/oidc',
    EXTERNAL_OIDC_CLIENT_ID: 'cloudflare-access',
    EXTERNAL_OIDC_CLIENT_SECRET: 'test-secret',
    EXTERNAL_OIDC_REDIRECT_URIS: 'https://team.cloudflareaccess.com/cdn-cgi/access/callback',
    EXTERNAL_OIDC_PRIVATE_KEY_B64: Buffer.from(privatePem).toString('base64'),
  };
  const rows: any[] = [];
  const repo = {
    create: (value: any) => value,
    save: async (value: any) => {
      const row = { id: rows.length + 1, ...value };
      rows.push(row);
      return row;
    },
    findOne: async ({ where }: any) => rows.find((row) => row.codeHash === where.codeHash) ?? null,
    update: async ({ id }: any, patch: any) => {
      const row = rows.find((item) => item.id === id);
      if (!row || row.consumedAt) return { affected: 0 };
      Object.assign(row, patch);
      return { affected: 1 };
    },
  };
  const config = { get: (key: string, fallback = '') => values[key] ?? fallback } as ConfigService;
  const checkedApps: any[] = [];
  const auth = {
    requireExternalAccessUser: async (_userId: number, required?: any) => {
      checkedApps.push(required);
      return ({
      user: { id: 42, tenantId: 7, name: '财务人员' },
      appSlugs: ['caiwu', 'warehouse-report'],
      });
    },
  };
  const service = new OidcService(repo as any, config, auth as any);
  return { service, checkedApps };
}

test('authorize only accepts the registered client, callback and openid scope', () => {
  const { service } = fixture();
  const request = service.validateAuthorizeQuery({
    response_type: 'code',
    client_id: 'cloudflare-access',
    redirect_uri: 'https://team.cloudflareaccess.com/cdn-cgi/access/callback',
    scope: 'openid email profile',
    state: 'opaque-state',
  });
  assert.equal(request.clientId, 'cloudflare-access');
  assert.throws(
    () => service.validateAuthorizeQuery({
      response_type: 'code',
      client_id: 'cloudflare-access',
      redirect_uri: 'https://evil.example/callback',
      scope: 'openid',
      state: 'x',
    }),
    /redirect_uri/,
  );
});

test('authorize accepts Cloudflare Access long opaque state while keeping a size bound', () => {
  const { service } = fixture();
  const cloudflareState = `signature.${'x'.repeat(1800)}`;
  const request = service.validateAuthorizeQuery({
    response_type: 'code',
    client_id: 'cloudflare-access',
    redirect_uri: 'https://team.cloudflareaccess.com/cdn-cgi/access/callback',
    scope: 'openid email profile',
    state: cloudflareState,
  });
  assert.equal(request.state, cloudflareState);

  assert.throws(
    () => service.validateAuthorizeQuery({
      response_type: 'code',
      client_id: 'cloudflare-access',
      redirect_uri: 'https://team.cloudflareaccess.com/cdn-cgi/access/callback',
      scope: 'openid',
      state: 'x'.repeat(4097),
    }),
    /state/,
  );
});

test('authorization code is one-time, app-bound and the signed token carries app grants', async () => {
  const { service, checkedApps } = fixture();
  const request = service.validateAuthorizeQuery({
    response_type: 'code',
    client_id: 'cloudflare-access',
    redirect_uri: 'https://team.cloudflareaccess.com/cdn-cgi/access/callback',
    scope: 'openid email profile',
    state: 'opaque-state',
    nonce: 'nonce-1',
  });
  request.requiredAppId = 8;
  request.requiredAppSlug = 'caiwu';
  request.requiredAppName = '用友财务系统';
  request.requiredAppHostname = 'caiwu.prsznh.cn';
  const redirect = new URL(await service.createAuthorizationCode(42, request));
  const code = redirect.searchParams.get('code')!;
  const token = await service.exchangeToken({
    grant_type: 'authorization_code',
    code,
    redirect_uri: request.redirectUri,
    client_id: request.clientId,
    client_secret: 'test-secret',
  });

  const [encodedHeader, encodedBody, signature] = token.id_token.split('.');
  const claims = JSON.parse(Buffer.from(encodedBody, 'base64url').toString('utf8'));
  assert.deepEqual(claims.external_apps, ['caiwu', 'warehouse-report']);
  assert.deepEqual(checkedApps, [
    { appId: 8, appSlug: '用友财务系统' },
    { appId: 8, appSlug: 'caiwu' },
  ]);
  assert.equal(claims.nonce, 'nonce-1');
  const jwk = service.jwks().keys[0];
  assert.equal(
    verify(
      'RSA-SHA256',
      Buffer.from(`${encodedHeader}.${encodedBody}`),
      createPublicKey({ key: jwk, format: 'jwk' }),
      Buffer.from(signature, 'base64url'),
    ),
    true,
  );
  assert.deepEqual(service.userinfo(`Bearer ${token.access_token}`), {
    sub: 'pms:user:42',
    email: 'pms-u42@auth.prsznh.cn',
    email_verified: true,
    name: '财务人员',
    external_apps: ['caiwu', 'warehouse-report'],
    tenant_id: 7,
  });
  assert.throws(() => service.userinfo('Bearer not-a-jwt'), /access token/);
  await assert.rejects(
    service.exchangeToken({
      grant_type: 'authorization_code',
      code,
      redirect_uri: request.redirectUri,
      client_id: request.clientId,
      client_secret: 'test-secret',
    }),
    /无效或已使用/,
  );
});

test('discovery advertises the standards-compatible userinfo endpoint', () => {
  const { service } = fixture();
  assert.equal(
    service.metadata().userinfo_endpoint,
    'https://prsznh.cn/api/v1/auth/oidc/userinfo',
  );
});

test('external login is a standalone QR page and redirects directly to the target flow', () => {
  const controller = new OidcController({} as any, {} as any);
  const html = (controller as any).renderLoginPage(
    'one-time-ticket',
    'data:image/png;base64,AA==',
    'csp-nonce',
    '用友财务系统',
    'caiwu.prsznh.cn',
  ) as string;
  assert.match(html, /用友财务系统/);
  assert.match(html, /caiwu\.prsznh\.cn/);
  assert.doesNotMatch(html, /核对码|4821/);
  assert.match(html, /location\.replace\(d\.redirectTo\)/);
  assert.doesNotMatch(html, /管理后台登录|系统设置|工单管理/);
});
