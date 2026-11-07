import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { GatewayAccessController } from './gateway-access.controller';

function harness() {
  let ticketOptions: any = null;
  const externalAccess: any = {
    resolveGatewayApplication: async () => ({ id: 9, name: '用友财务系统', publicHostname: 'caiwu.prsznh.cn' }),
    createGatewayHandoff: () => 'code/with+chars',
  };
  const qrLogin: any = {
    createTicket: async (_ip: string, _ua: string, options: any) => {
      ticketOptions = options;
      return { ticket: 'ticket-1', qrImage: 'data:image/png;base64,AA', launchScheme: null, expiresIn: 120, browserSecret: 'browser-secret' };
    },
    pollExternalGatewayStatus: async () => ({ status: 'confirmed', userId: 7, appId: 9, returnTo: ticketOptions?.returnTo ?? null }),
  };
  const controller = new GatewayAccessController(externalAccess, qrLogin);
  const req: any = { ip: '127.0.0.1', secure: true, headers: { 'user-agent': 'synthetic' } };
  const res: any = { cookie() {}, clearCookie() {}, setHeader() {}, type() { return res; }, send() {} };
  return {
    controller, req, res,
    options: () => ticketOptions,
    async run(returnTo?: string): Promise<any> {
      await controller.start('caiwu.prsznh.cn', returnTo as string, req, res);
      return controller.status('ticket-1', 'caiwu.prsznh.cn', req, res);
    },
  };
}

test('gateway start → status：深路径 returnTo 原样带回，且 URL 编码正确', async () => {
  const h = harness();
  const result = await h.run('/some/deep/path?x=1');
  assert.equal(result.status, 'confirmed');
  assert.equal(h.options()?.returnTo, 'https://caiwu.prsznh.cn/some/deep/path?x=1');
  const next = new URL(result.next!);
  assert.equal(next.origin, 'https://caiwu.prsznh.cn');
  assert.equal(next.pathname, '/_pms_gateway/session');
  assert.equal(next.searchParams.get('code'), 'code/with+chars');
  assert.equal(next.searchParams.get('returnTo'), 'https://caiwu.prsznh.cn/some/deep/path?x=1');
  assert.match(result.next!, /returnTo=https%3A%2F%2Fcaiwu\.prsznh\.cn%2Fsome%2Fdeep%2Fpath%3Fx%3D1/);
});

test('gateway start → status：恶意 returnTo 被 safeReturnTo 拦成同 host 根路径', async () => {
  const h = harness();
  const result = await h.run('https://evil.com/steal');
  assert.equal(h.options()?.returnTo, 'https://caiwu.prsznh.cn/');
  assert.equal(new URL(result.next!).searchParams.get('returnTo'), 'https://caiwu.prsznh.cn/');
});

test('gateway start → status：router 传来的同 host 完整 URL 也原样带回', async () => {
  const h = harness();
  const original = 'https://caiwu.prsznh.cn/tplus/view/login.html?from=gateway';
  const result = await h.run(original);
  assert.equal(h.options()?.returnTo, original);
  assert.equal(new URL(result.next!).searchParams.get('returnTo'), original);
});

test('gateway start → status：无 returnTo 时 next 不带 returnTo，保持回首页行为', async () => {
  const h = harness();
  const result = await h.run();
  assert.equal(h.options()?.returnTo, undefined);
  const next = new URL(result.next!);
  assert.equal(next.searchParams.has('returnTo'), false);
  assert.equal(next.toString(), 'https://caiwu.prsznh.cn/_pms_gateway/session?code=code%2Fwith%2Bchars');
});
