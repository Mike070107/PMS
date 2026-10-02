import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createGatewayDeviceToken,
  createGatewayInstallCode,
  gatewaySecretMatches,
  hashGatewaySecret,
  signGatewayConfiguration,
} from './lan-gateway-security';
import { ExternalAccessService } from './external-access.service';

test('gateway enrollment codes are human-readable and secrets compare by hash', () => {
  const code = createGatewayInstallCode();
  assert.match(code, /^[A-Z2-9]{4}(?:-[A-Z2-9]{4}){3}$/);
  assert.equal(code.length, 19);
  assert.equal(gatewaySecretMatches(code, hashGatewaySecret(code)), true);
  assert.equal(gatewaySecretMatches(`${code}X`, hashGatewaySecret(code)), false);
});

test('gateway configuration signatures are stable and bound to the device token', () => {
  const token = createGatewayDeviceToken();
  assert.equal(token.length, 64);
  assert.equal(signGatewayConfiguration('{"revision":2}', token), signGatewayConfiguration('{"revision":2}', token));
  assert.notEqual(signGatewayConfiguration('{"revision":3}', token), signGatewayConfiguration('{"revision":2}', token));
});

test('FRP admission binds every proxy name and port to the authenticated device', async () => {
  process.env.LAN_GATEWAY_FRP_PLUGIN_SECRET = 'plugin-secret-for-test';
  const deviceToken = 'device-token-for-test';
  const agent = { id: 7, tenantId: 1, deviceKey: 'lan-test', tokenHash: hashGatewaySecret(deviceToken), enabled: true };
  const agentRepo = { findOne: async ({ where }: any) => where.deviceKey === agent.deviceKey ? agent : null };
  const appRepo = { findOne: async ({ where }: any) => where.agentId === agent.id && where.gatewayPort === 18050 && where.slug === 'finance' ? { id: 9 } : null };
  const service = new ExternalAccessService(appRepo as any, {} as any, {} as any, agentRepo as any, {} as any);
  const metadata = { user: 'lan-test', metas: { deviceToken } };
  assert.deepEqual(await service.authorizeFrpOperation('plugin-secret-for-test', 'Login', { content: metadata }), { reject: false, unchange: true });
  assert.deepEqual(await service.authorizeFrpOperation('plugin-secret-for-test', 'NewProxy', { content: { user: metadata, proxy_name: 'lan-test.finance', proxy_type: 'tcp', remote_port: 18050, use_encryption: true } }), { reject: false, unchange: true });
  assert.equal((await service.authorizeFrpOperation('plugin-secret-for-test', 'NewProxy', { content: { user: metadata, proxy_name: 'lan-test.finance', proxy_type: 'tcp', remote_port: 18051, use_encryption: true } })).reject, true);
});

test('dynamic gateway can bootstrap a freshly verified route before public health turns online', async () => {
  const now = new Date();
  const app = {
    id: 9, tenantId: 1, publicHostname: 'finance.prsznh.cn', publishStatus: 'publishing',
    agentId: 7, gatewayPort: 18050, desiredRevision: 3, appliedRevision: 3, originCheckedAt: now,
    lastSyncError: '内网代理已就绪，公网 HTTPS 检查返回 302', enabled: true,
  };
  const agent = { id: 7, tenantId: 1, enabled: true, desiredRevision: 3, appliedRevision: 3, lastSeenAt: now };
  const appRepo = { findOne: async () => app };
  const agentRepo = { findOne: async () => agent };
  const service = new ExternalAccessService(appRepo as any, {} as any, {} as any, agentRepo as any, {} as any);
  assert.equal((await service.resolveGatewayApplication('finance.prsznh.cn')).id, 9);

  app.originCheckedAt = new Date(Date.now() - 91_000);
  await assert.rejects(() => service.resolveGatewayApplication('finance.prsznh.cn'), /公网 HTTPS 检查返回 302/);
});
