import assert from 'node:assert/strict';
import test from 'node:test';
import { UserRole } from '../../common/enums';
import { WebLoginTicketPurpose, WebLoginTicketStatus } from '../../entities/web-login-ticket.entity';
import { createBrowserBinding } from './qr-login-security';
import { QrLoginService } from './qr-login.service';

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
  const service = new QrLoginService(
    repo as any,
    { findOne: async () => ({ id: 11, name: '叶双', role: UserRole.STAFF }) } as any,
    {} as any,
    {} as any,
    { get: (_key: string, fallback: string) => fallback } as any,
    {
      requireExternalAccessUser: async (userId: number, required: any) => {
        checked.push({ userId, required });
        return { user: { id: userId }, appSlugs: ['caiwu'] };
      },
    } as any,
    { createAuthorizationCode: async () => 'https://caiwu.prsznh.cn/oauth2/callback?code=x' } as any,
  );
  return { service, row, browser, checked };
}

const alice: any = { id: 11, role: UserRole.STAFF, tenantId: 7 };
const bob: any = { id: 12, role: UserRole.STAFF, tenantId: 7 };

test('a copied QR ticket cannot be polled from a browser without its private binding', async () => {
  const { service, browser } = fixture();
  await assert.rejects(service.pollExternalOidcStatus('ticket-1', 'wrong-secret', '203.0.113.10'), /浏览器不匹配/);
  assert.equal((await service.pollExternalOidcStatus('ticket-1', browser.secret, '203.0.113.9')).status, 'pending');
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
