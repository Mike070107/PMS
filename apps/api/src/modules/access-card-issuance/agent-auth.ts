import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export function issueAgentSecret(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: hashAgentToken(token) };
}

export function hashAgentToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function agentTokenMatches(token: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashAgentToken(token), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function bearerToken(authorization?: string): string {
  const match = /^Bearer\s+([^\s]+)$/i.exec((authorization || '').trim());
  return match?.[1] || '';
}
