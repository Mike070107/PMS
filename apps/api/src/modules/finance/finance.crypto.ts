import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

export function resolveFinanceKey(raw: string): Buffer {
  if (!raw || raw.length < 16) throw new Error('FINANCE_SECRET_KEY_MISSING');
  return createHash('sha256').update(raw, 'utf8').digest();
}

export function encryptFinanceSecret(value: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString('base64url')).join('.');
}

export function decryptFinanceSecret(value: string, key: Buffer): string {
  const [iv, tag, encrypted] = value.split('.').map((part) => Buffer.from(part, 'base64url'));
  if (!iv || !tag || !encrypted) throw new Error('INVALID_FINANCE_SECRET');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}
