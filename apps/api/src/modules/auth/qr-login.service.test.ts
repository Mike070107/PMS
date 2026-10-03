import assert from 'node:assert/strict';
import test from 'node:test';
import { UserRole } from '../../common/enums';
import { WebLoginTicketPurpose, WebLoginTicketStatus } from '../../entities/web-login-ticket.entity';
import { createBrowserBinding } from './qr-login-security';
import { QrLoginService } from './qr-login.service';
import { WechatService } from './wechat.service';

function fixture() {
  const browser = createBrowserBinding();
  const row: any = {
    id: 1,
    ticket: 'ticket-1',
    status: WebLoginTicketStatus.PENDING,
    purpose: WebLoginTicketPurpose.EXTERNAL_ACCESS_OIDC,
    oidcRequest: {
      clientId: 'gateway', redirectUri: 'https://caiwu.prsznh.cn/oauth2/callback', state: 'state',
      requiredAppId: 8, requiredAppSlug: 'caiwu', requiredAppName: '用友财务系统',
      requiredAppHostname: 'caiwu.prsznh.cn',
    },
    userId: null,
    scannedByUserId: null,
    browserSecretHash: browser.hash,
    confirmationCode: '4821',
    clientIp: '203.0.113.9',
    userAgent: 'Browser',
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 120_000),
  };
  const repo = {
    count: async () => 0,
    create: (value: any) => value,
    save: async (value: any) => {
      Object.assign(row, value, { id: row.id, createdAt: new Date() });
      return row;
    },
    findOne: async ({ where }: any) => where.ticket === row.ticket ? row : null,
    update: async (where: any, patch: any) => {
      if (where.id !== row.id || (where.status && where.status !== row.status)) return { affected: 0 };
      if (typeof where.scannedByUserId === 'number' && where.scannedByUserId !== row.scannedByUserId) {
        return { affected: 0 };
      }
      Object.assign(row, patch);
      return { affected: 1 };
    },
  };
  const checked: any[] = [];
  const generatedSchemes: any[] = [];
  const service = new QrLoginService(
    repo as any,
    { findOne: async () => ({ id: 11, name: '叶双', role: UserRole.STAFF }) } as any,
    {} as any,
    {
      generateWxaUrlScheme: async (options: any, appType: string) => {
        generatedSchemes.push({ options, appType });
        return 'weixin://dl/business/?t=launch123';
      },
      getUnlimitedWxaCode: async () => Buffer.from('png'),
    } as any,
    { get: (_key: string, fallback: string) => fallback } as any,
    {
      requireExternalAccessUser: async (userId: number, required: any) => {
        checked.push({ userId, required });
        return { user: { id: userId }, appSlugs: ['caiwu'] };
      },
    } as any,
    { createAuthorizationCode: async () => 'https://caiwu.prsznh.cn/oauth2/callback?code=x' } as any,
  );
  return { service, row, browser, checked, generatedSchemes };
}

const alice: any = { id: 11, role: UserRole.STAFF, tenantId: 7 };
const bob: any = { id: 12, role: UserRole.STAFF, tenantId: 7 };

test('a copied QR ticket cannot be polled from a browser without its private binding', async () => {
  const { service, browser } = fixture();
  await assert.rejects(service.pollExternalOidcStatus('ticket-1', 'wrong-secret', '203.0.113.10'), /浏览器不匹配/);
  assert.equal((await service.pollExternalOidcStatus('ticket-1', browser.secret, '203.0.113.9')).status, 'pending');
});

test('a gateway ticket includes a short-lived same-device WeChat launch scheme', async () => {
  const { service, generatedSchemes } = fixture();
  const result = await service.createTicket('203.0.113.9', 'Mobile Safari', {
    purpose: WebLoginTicketPurpose.EXTERNAL_GATEWAY,
    requiredApp: {
      id: 8,
      slug: 'caiwu',
      name: '用友财务系统',
      publicHostname: 'caiwu.prsznh.cn',
    } as any,
  });

  assert.equal(result.launchScheme, 'weixin://dl/business/?t=launch123');
  assert.equal(generatedSchemes.length, 1);
  assert.equal(generatedSchemes[0].appType, 'staff');
  assert.equal(generatedSchemes[0].options.path, 'pages/web-login/web-login');
  assert.equal(generatedSchemes[0].options.query, `ticket=${result.ticket}`);
  assert.ok(generatedSchemes[0].options.expiresAt instanceof Date);
  assert.ok(generatedSchemes[0].options.expiresAt.getTime() > Date.now());
  assert.ok(generatedSchemes[0].options.expiresAt.getTime() <= Date.now() + result.expiresIn * 1000);
});

test('WeChat launch schemes are temporary, target the confirmation page and reject arbitrary redirects', async () => {
  const service = new WechatService({} as any);
  const requests: any[] = [];
  (service as any).accessToken = async () => 'access-token';
  (service as any).post = async (path: string, body: any) => {
    requests.push({ path, body });
    return { errcode: 0, openlink: 'weixin://dl/business/?t=launch123' };
  };
  const expiresAt = new Date(Date.now() + 120_000);
  assert.equal(
    await service.generateWxaUrlScheme({
      path: '/pages/web-login/web-login',
      query: 'ticket=AbC123',
      envVersion: 'release',
      expiresAt,
    }, 'staff'),
    'weixin://dl/business/?t=launch123',
  );
  assert.equal(requests[0].path, '/wxa/generatescheme?access_token=access-token');
  assert.deepEqual(requests[0].body, {
    jump_wxa: {
      path: 'pages/web-login/web-login',
      query: 'ticket=AbC123',
      env_version: 'release',
    },
    is_expire: true,
    expire_type: 0,
    expire_time: Math.floor(expiresAt.getTime() / 1000),
  });

  (service as any).post = async () => ({ errcode: 0, openlink: 'https://evil.example/' });
  await assert.rejects(
    service.generateWxaUrlScheme({ path: 'pages/web-login/web-login', expiresAt }, 'staff'),
    /无法识别/,
  );
});

test('only the first scanner can confirm and confirmation checks the exact app grant', async () => {
  const { service, row, checked } = fixture();
  const info = await service.markScanned('ticket-1', alice);
  assert.equal(info.applicationHostname, 'caiwu.prsznh.cn');
  assert.equal(info.confirmationCode, '4821');
  await assert.rejects(service.markScanned('ticket-1', bob), /另一位员工/);
  await service.confirm('ticket-1', alice);
  assert.equal(row.status, WebLoginTicketStatus.CONFIRMED);
  assert.equal(row.userId, alice.id);
  assert.deepEqual(checked, [{ userId: 11, required: { appId: 8, appSlug: '用友财务系统' } }]);
  await assert.rejects(service.confirm('ticket-1', bob), /另一位员工/);
});

test('a concurrent losing scan reloads the database winner instead of claiming locally', async () => {
  const { service, row } = fixture();
  (service as any).ticketRepo.update = async () => {
    row.status = WebLoginTicketStatus.SCANNED;
    row.scannedByUserId = bob.id;
    return { affected: 0 };
  };
  await assert.rejects(service.markScanned('ticket-1', alice), /另一位员工/);
  assert.equal(row.scannedByUserId, bob.id);
});
