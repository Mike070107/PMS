import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from './auth.service';

function fixture() {
  const jwt = new JwtService({ secret: 'isolated-web-day-fixture-only', signOptions: { expiresIn: '2h' } });
  const service: any = Object.create(AuthService.prototype);
  service.jwt = jwt;
  service.config = { get: (_k: string, fallback: any) => fallback };
  return { service, jwt };
}
const user: any = { id: 7, tenantId: 3, role: 'admin', name: 'fixture', credentialVersion: 4 };

test('真实网页签发：北京时间次日零点精确过期，独立于服务器TZ及毫秒取整', () => {
  const { service, jwt } = fixture();
  const originalNow = Date.now;
  const oldTZ = process.env.TZ;
  try {
    for (const tz of ['UTC', 'America/New_York', 'Asia/Shanghai']) {
      process.env.TZ = tz;
      for (const [at, deadline] of [
        ['2026-11-05T12:00:00.789+08:00', '2026-11-06T00:00:00+08:00'],
        ['2026-11-05T23:59:59.999+08:00', '2026-11-06T00:00:00+08:00'],
        ['2026-11-30T23:59:59.123+08:00', '2026-12-01T00:00:00+08:00'],
        ['2026-12-31T23:59:59.999+08:00', '2027-01-01T00:00:00+08:00'],
      ]) {
        const now = Date.parse(at), exp = Date.parse(deadline) / 1000;
        Date.now = () => now;
        for (const method of ['password', 'wechat']) {
          const response = service.issueTokens(user, method);
          const decoded = jwt.verify(response.accessToken, { clockTimestamp: exp - 1 });
          assert.equal(decoded.exp, exp, `${tz} ${at}`);
          assert.equal(decoded.iat, Math.floor(now / 1000));
          assert.equal(decoded.authMethod, method);
          assert.equal(decoded.credentialVersion, 4);
          assert.equal(response.refreshToken, undefined);
          assert.throws(() => jwt.verify(response.accessToken, { clockTimestamp: exp }), /jwt expired/);
        }
      }
    }
  } finally { Date.now = originalNow; if (oldTZ === undefined) delete process.env.TZ; else process.env.TZ = oldTZ; }
});

test('小程序仍为2小时access/30日refresh，不受网页日会话影响', () => {
  const { service, jwt } = fixture();
  const result = service.issueWxTokens(user);
  const access = jwt.verify(result.accessToken);
  const refresh = jwt.verify(result.refreshToken, { secret: 'change-me-in-prod:refresh' });
  assert.equal(access.exp - access.iat, 7200);
  assert.equal(refresh.exp - refresh.iat, 30 * 86400);
  assert.equal(refresh.typ, 'refresh');
  assert.equal(refresh.credentialVersion, 4);
});
