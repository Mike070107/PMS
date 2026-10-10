import assert from 'node:assert/strict';
import test from 'node:test';
import {
  externalAccessConfigurationChanged,
  mergeIngressRules,
  normalizeExternalRoute,
  resolveExternalAccessProvider,
} from './external-access.util';

test('does not treat an unchanged published application as a new client revision', () => {
  const current = {
    name: '公寓物业管理系统', publicHostname: 'wyglxt.prsznh.cn', originUrl: 'http://192.168.110.249:5000', entryPath: '/login',
    sessionDuration: '12h', enabled: true, agentId: 1,
  };
  assert.equal(externalAccessConfigurationChanged(current, { ...current }), false);
  assert.equal(externalAccessConfigurationChanged(current, { ...current, entryPath: '/' }), true);
  assert.equal(externalAccessConfigurationChanged(current, { ...current, agentId: 2 }), true);
});

test('selects domestic gateway only when explicitly configured', () => {
  assert.equal(resolveExternalAccessProvider('domestic'), 'domestic');
  assert.equal(resolveExternalAccessProvider(' DOMESTIC '), 'domestic');
  assert.equal(resolveExternalAccessProvider('cloudflare'), 'cloudflare');
  assert.equal(resolveExternalAccessProvider(undefined), 'cloudflare');
});

test('normalizes a valid external route', () => {
  assert.deepEqual(
    normalizeExternalRoute(' CaiWu.PRSZNH.cn/ ', 'http://192.168.1.20:8080/', 'prsznh.cn'),
    {
      publicHostname: 'caiwu.prsznh.cn',
      originUrl: 'http://192.168.1.20:8080',
      entryPath: '/',
    },
  );
});

test('separates the launch path from the tunnel origin', () => {
  assert.deepEqual(
    normalizeExternalRoute(
      'caiwu.prsznh.cn',
      'http://192.168.110.251:8050/tplus/view/login.html?from=pms',
      'prsznh.cn',
    ),
    {
      publicHostname: 'caiwu.prsznh.cn',
      originUrl: 'http://192.168.110.251:8050',
      entryPath: '/tplus/view/login.html?from=pms',
    },
  );
});

test('rejects invalid hostnames and credential-bearing origins', () => {
  assert.throws(
    () => normalizeExternalRoute('bad..prsznh.cn', 'http://192.168.1.20', 'prsznh.cn'),
    /有效一级子域名/,
  );
  assert.throws(
    () => normalizeExternalRoute('caiwu.prsznh.cn', 'http://user:pass@192.168.1.20', 'prsznh.cn'),
    /不含账号密码/,
  );
  assert.throws(
    () => normalizeExternalRoute('second.caiwu.prsznh.cn', 'http://192.168.1.20', 'prsznh.cn'),
    /一级子域名/,
  );
  assert.throws(
    () => normalizeExternalRoute('api.prsznh.cn', 'http://192.168.1.20', 'prsznh.cn'),
    /平台保留名称/,
  );
});

test('merges managed routes without removing unrelated tunnel routes', () => {
  const result = mergeIngressRules(
    [
      { hostname: 'other.example.com', service: 'http://10.0.0.8' },
      { hostname: 'old.prsznh.cn', service: 'http://10.0.0.9' },
      { service: 'http_status:404' },
    ],
    [
      { publicHostname: 'new.prsznh.cn', originUrl: 'http://10.0.0.10', enabled: true },
      { publicHostname: 'off.prsznh.cn', originUrl: 'http://10.0.0.11', enabled: false },
    ],
    'old.prsznh.cn',
  );
  assert.deepEqual(result, [
    { hostname: 'other.example.com', service: 'http://10.0.0.8' },
    { hostname: 'new.prsznh.cn', service: 'http://10.0.0.10', originRequest: {} },
    { service: 'http_status:404' },
  ]);
});
