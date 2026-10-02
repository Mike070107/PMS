import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const hashGatewaySecret = (value: string) =>
  createHash('sha256').update(value, 'utf8').digest('hex');

export const gatewaySecretMatches = (value: string, expectedHash: string | null) => {
  if (!value || !expectedHash) return false;
  const actual = Buffer.from(hashGatewaySecret(value), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};

export const createGatewayDeviceToken = () => randomBytes(32).toString('hex');

export const createGatewayInstallCode = () => {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(16);
  const body = Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('');
  return body.match(/.{4}/g)!.join('-');
};

export const signGatewayConfiguration = (payload: string, token: string) =>
  createHmac('sha256', token).update(payload, 'utf8').digest('hex');
