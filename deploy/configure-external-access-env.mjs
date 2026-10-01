#!/usr/bin/env node
/**
 * Idempotently prepares the production API environment for the external-access OIDC provider.
 * Secrets are generated on the server and are never printed. Cloudflare identifiers may be
 * supplied through process environment variables and are only persisted when present.
 */
import { chmodSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { generateKeyPairSync, randomBytes } from 'node:crypto';

const envPath = process.argv[2] || '/opt/pms-repair/apps/api/.env';
const redirectUri = process.argv[3] || '';
const original = readFileSync(envPath, 'utf8');
const values = new Map();
for (const line of original.split(/\r?\n/)) {
  const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
  if (match) values.set(match[1], match[2]);
}

const setIfMissing = (key, create) => {
  if (!values.get(key)?.trim()) values.set(key, create());
};
const setIfProvided = (key, value) => {
  if (value?.trim()) values.set(key, value.trim());
};

values.set('EXTERNAL_OIDC_ISSUER', 'https://prsznh.cn/api/v1/auth/oidc');
setIfMissing('EXTERNAL_OIDC_CLIENT_ID', () => `pms-cloudflare-${randomBytes(12).toString('hex')}`);
setIfMissing('EXTERNAL_OIDC_CLIENT_SECRET', () => randomBytes(32).toString('base64url'));
setIfMissing('EXTERNAL_OIDC_PRIVATE_KEY_B64', () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return privateKey.export({ type: 'pkcs8', format: 'pem' }).toString('base64');
});
setIfProvided('EXTERNAL_OIDC_REDIRECT_URIS', redirectUri);
values.set('CLOUDFLARE_ZONE_NAME', 'prsznh.cn');
for (const key of [
  'CLOUDFLARE_ACCOUNT_ID',
  'CLOUDFLARE_ZONE_ID',
  'CLOUDFLARE_TUNNEL_ID',
  'CLOUDFLARE_ACCESS_IDP_ID',
  'CLOUDFLARE_API_TOKEN',
]) {
  setIfProvided(key, process.env[key]);
}

const rendered = [];
const written = new Set();
for (const line of original.split(/\r?\n/)) {
  const match = /^([A-Z0-9_]+)=/.exec(line);
  if (!match || !values.has(match[1])) {
    rendered.push(line);
    continue;
  }
  rendered.push(`${match[1]}=${values.get(match[1])}`);
  written.add(match[1]);
}
for (const [key, value] of values) {
  if (!written.has(key)) rendered.push(`${key}=${value}`);
}

const backupPath = `${envPath}.bak-external-access-${Date.now()}`;
copyFileSync(envPath, backupPath);
writeFileSync(envPath, `${rendered.filter((line, index, all) => line || index < all.length - 1).join('\n')}\n`, {
  mode: 0o600,
});
chmodSync(envPath, 0o600);
console.log(`Configured external-access environment keys; backup: ${backupPath}`);
