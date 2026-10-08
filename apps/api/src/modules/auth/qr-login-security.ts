import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';

const COOKIE_PREFIX = 'pms_qr_';

export function createBrowserBinding() {
  const secret = randomBytes(32).toString('base64url');
  return { secret, hash: hashBrowserSecret(secret) };
}

export function hashBrowserSecret(secret: string) {
  return createHash('sha256').update(secret).digest('hex');
}

export function browserSecretMatches(secret: string | undefined, expectedHash: string | null) {
  if (!secret || !expectedHash) return false;
  const actual = Buffer.from(hashBrowserSecret(secret), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function qrCookieName(ticket: string) {
  return `${COOKIE_PREFIX}${ticket}`;
}

export function setQrBrowserCookie(
  req: Request,
  res: Response,
  ticket: string,
  secret: string,
  maxAgeSec: number,
) {
  const secure = process.env.NODE_ENV === 'production' || req.secure;
  res.cookie(qrCookieName(ticket), secret, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeSec * 1000,
  });
}

export function clearQrBrowserCookie(req: Request, res: Response, ticket: string) {
  const secure = process.env.NODE_ENV === 'production' || req.secure;
  res.clearCookie(qrCookieName(ticket), {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
  });
}

export function readQrBrowserSecret(req: Request, ticket: string): string | undefined {
  const name = qrCookieName(ticket);
  const raw = String(req.headers.cookie || '');
  for (const item of raw.split(';')) {
    const separator = item.indexOf('=');
    if (separator < 0) continue;
    if (item.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(item.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}
