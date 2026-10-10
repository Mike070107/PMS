#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { createHmac } from 'node:crypto';

const [payloadPath] = process.argv.slice(2);
const apiUrl = process.env.PMS_IMPORT_API_URL || 'http://127.0.0.1:4000/api/v1/fees/import';
const userId = Number(process.env.PMS_IMPORT_USER_ID);
const tenantId = Number(process.env.PMS_IMPORT_TENANT_ID);
const secret = process.env.JWT_SECRET;

if (!payloadPath || !secret || !Number.isInteger(userId) || !Number.isInteger(tenantId)) {
  throw new Error('缺少导入文件、JWT_SECRET、PMS_IMPORT_USER_ID 或 PMS_IMPORT_TENANT_ID');
}

const payload = await readFile(payloadPath, 'utf8');
const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const unsigned = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({
  sub: userId,
  tenantId: null,
  role: 'superadmin',
  iat: now,
  exp: now + 600,
})}`;
const signature = createHmac('sha256', secret).update(unsigned).digest('base64url');
const token = `${unsigned}.${signature}`;
const response = await fetch(apiUrl, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    'x-acting-tenant-id': String(tenantId),
  },
  body: payload,
  signal: AbortSignal.timeout(300_000),
});
const body = await response.text();
if (!response.ok) {
  throw new Error(`导入接口返回 HTTP ${response.status}: ${body.slice(0, 2000)}`);
}
console.log(body);
