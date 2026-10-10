import assert from 'node:assert/strict';
import test from 'node:test';
import { decryptExternalCredential, encryptExternalCredential } from './external-account-credential';

test('内网密码只能在原租户、应用和用户范围内解密', () => {
  const key = Buffer.alloc(32, 7);
  const scope = { tenantId: 1, appId: 2, userId: 3 };
  const payload = encryptExternalCredential('secret-password', key, scope);
  assert.equal(payload.includes('secret-password'), false);
  assert.equal(decryptExternalCredential(payload, key, scope), 'secret-password');
  assert.throws(() => decryptExternalCredential(payload, key, { ...scope, userId: 4 }));
  assert.throws(() => decryptExternalCredential(payload, Buffer.alloc(32, 8), scope));
});
