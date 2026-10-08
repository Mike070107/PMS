import assert from 'node:assert/strict';
import test from 'node:test';
import { browserSecretMatches, createBrowserBinding, qrCookieName } from './qr-login-security';

test('browser binding only accepts the secret created for this browser', () => {
  const first = createBrowserBinding();
  const second = createBrowserBinding();
  assert.equal(browserSecretMatches(first.secret, first.hash), true);
  assert.equal(browserSecretMatches(second.secret, first.hash), false);
  assert.equal(browserSecretMatches(undefined, first.hash), false);
});

test('cookie name is isolated per ticket', () => {
  assert.equal(qrCookieName('Ab12'), 'pms_qr_Ab12');
  assert.notEqual(qrCookieName('Ab12'), qrCookieName('Cd34'));
});
