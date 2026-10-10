import assert from 'node:assert/strict';
import test from 'node:test';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import {
  createGatewayDeviceToken,
  createGatewayInstallCode,
  gatewaySecretMatches,
  hashGatewaySecret,
  signGatewayConfiguration,
} from './lan-gateway-security';
import { ExternalAccessService } from './external-access.service';
import { ExternalAccessAgentController } from './external-access.controller';
import { GatewayAccessController } from './gateway-access.controller';

test('FRP admission endpoint returns the protocol-required HTTP 200', () => {
  const status = Reflect.getMetadata(
    HTTP_CODE_METADATA,
    ExternalAccessAgentController.prototype.frpPlugin,
  );
  assert.equal(status, 200);
});

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

test('gateway session supports the configured 12-hour workday duration', () => {
  process.env.LAN_GATEWAY_SESSION_SECRET = 'gateway-session-secret-for-test-must-have-32-characters';
  const service = new ExternalAccessService({} as any, {} as any, {} as any, {} as any, {} as any);
  const session = service.createGatewaySession({ id: 9, slug: 'finance', sessionDuration: '12h' } as any, 7);
  assert.equal(session.maxAge, 43_200);
});

test('FRP admission binds every proxy name and port to the authenticated device', async () => {
  process.env.LAN_GATEWAY_FRP_PLUGIN_SECRET = 'plugin-secret-for-test';
  const deviceToken = 'device-token-for-test';
  const agent = { id: 7, tenantId: 1, deviceKey: 'lan-test', tokenHash: hashGatewaySecret(deviceToken), enabled: true };
  const agentRepo = { findOne: async ({ where }: any) => where.deviceKey === agent.deviceKey ? agent : null };
  const appRepo = { findOne: async ({ where }: any) => where.agentId === agent.id && where.gatewayPort === 18050 && where.slug === 'finance' ? { id: 9 } : null };
  const service = new ExternalAccessService(appRepo as any, {} as any, agentRepo as any, {} as any, {} as any);
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
  const service = new ExternalAccessService(appRepo as any, {} as any, agentRepo as any, {} as any, {} as any);
  assert.equal((await service.resolveGatewayApplication('finance.prsznh.cn')).id, 9);

  app.originCheckedAt = new Date(Date.now() - 91_000);
  await assert.rejects(() => service.resolveGatewayApplication('finance.prsznh.cn'), /公网 HTTPS 检查返回 302/);
});

test('内网应用图标入口只返回当前用户已授权且已启用的应用', async () => {
  let where: any;
  const appRepo = {
    find: async (options: any) => {
      where = options.where;
      return [{
        id: 9,
        name: '用友财务系统',
        publicHostname: 'caiwu.prsznh.cn',
        entryPath: '/tplus/view/login.html',
        publishStatus: 'online',
      }];
    },
  };
  const access = { externalAppIdsOfUser: async () => [9] };
  const service = new ExternalAccessService(
    appRepo as any,
    {} as any,
    {} as any,
    {} as any,
    access as any,
  );

  const apps = await service.listMyApps({ id: 7, tenantId: 1 } as any);
  assert.equal(where.tenantId, 1);
  assert.equal(where.enabled, true);
  assert.equal(apps[0].url, 'https://caiwu.prsznh.cn/tplus/view/login.html');
});

test('gateway login page offers a same-phone WeChat launch action without removing the desktop QR', () => {
  const controller = new GatewayAccessController({} as any, {} as any);
  const html = (controller as any).renderLogin(
    'ticket123',
    'data:image/png;base64,abc',
    'weixin://dl/business/?t=launch123',
    '用友财务系统',
    'caiwu.prsznh.cn',
    'https://caiwu.prsznh.cn/tplus/view/login.html',
    'nonce',
  );

  assert.match(html, /打开微信授权登录/);
  assert.match(html, /href="weixin:\/\/dl\/business\/\?t=launch123"/);
  assert.match(html, /微信小程序登录二维码/);
});

test('gateway verification rejects callers without the private router secret', async () => {
  process.env.LAN_GATEWAY_ROUTER_SECRET = 'router-secret-for-test';
  const controller = new GatewayAccessController({ verifyGatewaySession: () => ({}) } as any, {} as any);
  assert.throws(
    () => controller.verify('finance.prsznh.cn', { headers: {} } as any),
    /内网网关调用身份无效/,
  );
});
