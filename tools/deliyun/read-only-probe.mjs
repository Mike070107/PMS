import { createHash } from 'node:crypto';

// Credentials exist only in the process environment. Never print requests or signatures.
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
};
const methods = new Set(['findPunitInfo', 'findParkGarage', 'findCarList', 'findPoolParkList']);
const method = option('--method', 'findPunitInfo');
const version = option('--version', process.env.DELIYUN_API_VERSION);
const encoding = option('--sign-data', 'urlencoded');
const data = option('--data', '{}');
const credentials = {
  accessKeyID: process.env.DELIYUN_ACCESS_KEY_ID,
  commKey: process.env.DELIYUN_COMM_KEY,
};
const secret = process.env.DELIYUN_ACCESS_KEY_SECRET;

try {
  if (!methods.has(method)) throw new Error('Only the four listed read-only parking methods are allowed.');
  if (!version || !secret || Object.values(credentials).some(value => !value)) {
    throw new Error('Set DELIYUN_ACCESS_KEY_ID, DELIYUN_ACCESS_KEY_SECRET, DELIYUN_COMM_KEY and provide --version.');
  }
  if (!['raw', 'urlencoded'].includes(encoding)) throw new Error('--sign-data must be raw or urlencoded.');
  JSON.parse(data);
  const params = { ...credentials, timestamp: String(Math.floor(Date.now() / 1000)), version };
  const signatureParams = {
    ...params,
    data: encoding === 'urlencoded' ? new URLSearchParams({ data }).toString().slice(5) : data,
  };
  const canonical = Object.keys(signatureParams).sort()
    .map(key => `${key}=${signatureParams[key]}`).join('&');
  const sign = createHash('md5').update(`${canonical}&accessKeySecret=${secret}`, 'utf8').digest('hex');
  const url = new URL(`https://openapi.deliyun.cn/parking/${method}`);
  url.search = new URLSearchParams({ ...params, sign }).toString();
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    body: new URLSearchParams({ data }),
    signal: AbortSignal.timeout(12000),
    redirect: 'error',
  });
  const payload = await response.json();
  const success = response.ok && Object.hasOwn(payload, 'ecode') && String(payload.ecode) === '0';
  const summary = value => Array.isArray(value)
    ? { type: 'array', count: value.length, firstItemFields: value[0] && typeof value[0] === 'object' ? Object.keys(value[0]) : [] }
    : value && typeof value === 'object'
      ? { type: 'object', fields: Object.keys(value), arrays: Object.fromEntries(Object.entries(value).filter(([, item]) => Array.isArray(item)).map(([key, item]) => [key, item.length])) }
      : { type: value === null ? 'null' : typeof value };
  let message = String(payload.msg ?? '');
  for (const value of [...Object.values(credentials), secret, sign]) message = message.split(value).join('[REDACTED]');
  console.log(JSON.stringify({ checkedAt: new Date().toISOString(), method, version, signData: encoding,
    httpStatus: response.status, success, ecode: payload.ecode, msg: message, data: summary(payload.data) }));
  if (!success) process.exitCode = 1;
} catch {
  // Network exceptions may contain the credential-bearing URL. Do not print them.
  console.error('Probe failed: check required environment variables, arguments, network and JSON response. No credentials were printed.');
  process.exitCode = 1;
}
