import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

function aad(tenantId: number, appId: number, userId: number) {
  return Buffer.from(`${tenantId}:${appId}:${userId}`, 'utf8');
}

export function encryptExternalCredential(
  plaintext: string,
  key: Buffer,
  scope: { tenantId: number; appId: number; userId: number },
) {
  if (key.length !== 32) throw new Error('内网账号加密密钥必须是 32 字节');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad(scope.tenantId, scope.appId, scope.userId));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

export function decryptExternalCredential(
  payload: string,
  key: Buffer,
  scope: { tenantId: number; appId: number; userId: number },
) {
  if (key.length !== 32) throw new Error('内网账号加密密钥必须是 32 字节');
  const [version, ivValue, tagValue, ciphertextValue, extra] = String(payload || '').split('.');
  if (version !== 'v1' || !ivValue || !tagValue || ciphertextValue === undefined || extra) {
    throw new Error('内网账号密文格式无效');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivValue, 'base64url'));
  decipher.setAAD(aad(scope.tenantId, scope.appId, scope.userId));
  decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextValue, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}
