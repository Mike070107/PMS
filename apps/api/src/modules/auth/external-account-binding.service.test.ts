import assert from 'node:assert/strict';
import test from 'node:test';
import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { ExternalAccountBindingStatus } from '../../entities/external-account-binding.entity';
import { decryptExternalCredential } from './external-account-credential';
import { ExternalAccountBindingService } from './external-account-binding.service';

const key = Buffer.alloc(32, 9);
const app: any = {
  id: 2,
  loginAdapter: 'bearer_json',
  loginPath: '/api/login',
  gatewayPort: 18051,
  publicHostname: 'wyglxt.prsznh.cn',
};
const user = { id: 11, tenantId: 1 };

function fixture() {
  const rows: any[] = [];
  const appUpdates: any[] = [];
  const repo = {
    findOne: async ({ where }: any) => rows.find((row) => Object.entries(where).every(([name, value]) => row[name] === value)) ?? null,
    create: (value: any) => ({ ...value }),
    save: async (value: any) => {
      if (!value.id) value.id = rows.length + 1;
      const index = rows.findIndex((row) => row.id === value.id);
      if (index >= 0) rows[index] = value;
      else rows.push(value);
      return value;
    },
  };
  const service = new ExternalAccountBindingService(
    repo as any,
    { update: async (where: any, patch: any) => { appUpdates.push({ where, patch }); } } as any,
    { get: () => key.toString('base64') } as any,
  );
  (service as any).authenticate = async (_app: any, username: string) => ({
    token: 'target-token',
    expiresAt: Date.now() + 60 * 60_000,
    remoteUserId: `id-${username}`,
    remoteUsername: username,
    remoteDisplayName: '公寓用户',
    browserProfile: { id: 20, username, real_name: '公寓用户', community: '测试公寓', role: '操作员' },
  });
  return { service, rows, appUpdates };
}

test('startup enables only the verified apartment adapter when schema sync created default columns', async () => {
  const { service, appUpdates } = fixture();
  await service.onModuleInit();
  assert.equal(appUpdates.length, 1);
  assert.equal(appUpdates[0].where.publicHostname, 'wyglxt.prsznh.cn');
  assert.equal(appUpdates[0].where.loginAdapter, 'none');
  assert.deepEqual(appUpdates[0].patch, { loginAdapter: 'bearer_json', loginPath: '/api/login' });
});

test('binding stores an authenticated password only as tenant-scoped ciphertext', async () => {
  const { service, rows } = fixture();
  await service.bind(app, user, 'remote-user', 'plain-password');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].credentialPayload.includes('plain-password'), false);
  assert.equal(rows[0].status, ExternalAccountBindingStatus.ACTIVE);
  assert.equal(
    decryptExternalCredential(rows[0].credentialPayload, key, { tenantId: 1, appId: 2, userId: 11 }),
    'plain-password',
  );
  const authorization = await service.gatewayAuthorization(app, user.id);
  assert.deepEqual(authorization.headers, { authorization: 'Bearer target-token' });
  assert.equal(authorization.browserSession?.token.includes('target-token'), false);
  assert.equal(authorization.browserSession?.user.username, 'remote-user');
});

test('a rejected target login writes nothing and leaves an existing binding usable', async () => {
  const { service, rows } = fixture();
  await service.bind(app, user, 'remote-user', 'right-password');
  const stored = rows[0].credentialPayload;
  (service as any).authenticate = async () => {
    throw new UnauthorizedException('内网用户名或密码错误');
  };
  await assert.rejects(
    service.bind(app, { id: 12, tenantId: 1 }, 'another-user', 'wrong-password'),
    UnauthorizedException,
  );
  await assert.rejects(service.bind(app, user, 'remote-user', 'wrong-password'), UnauthorizedException);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].credentialPayload, stored);
  assert.equal(rows[0].status, ExternalAccountBindingStatus.ACTIVE);
});

test('one active target account cannot be claimed by another PMS user', async () => {
  const { service } = fixture();
  await service.bind(app, user, 'remote-user', 'first-password');
  await assert.rejects(
    service.bind(app, { id: 12, tenantId: 1 }, 'remote-user', 'second-password'),
    ConflictException,
  );
});
