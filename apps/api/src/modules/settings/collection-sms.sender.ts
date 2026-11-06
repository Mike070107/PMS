import { createHmac, randomUUID } from 'node:crypto';

/**
 * 阿里云短信（SendSms）请求构造与签名。
 *
 * 只做纯函数：给定参数返回 URL 与签名，方便用固定向量做单元测试；
 * 真正发请求的地方在 CollectionSmsSender.send()，没有网络时不会被执行。
 *
 * 签名算法（阿里云 RPC 风格）：
 *   1. 公共参数 + 业务参数按 key 字典序排序
 *   2. RFC3986 编码后拼成 canonicalized query
 *   3. stringToSign = "GET&%2F&" + percentEncode(canonicalized)
 *   4. Signature = base64(HMAC-SHA1(accessKeySecret + "&", stringToSign))
 */

export interface AliyunSmsRequest {
  accessKeyId: string;
  accessKeySecret: string;
  phone: string;
  signName: string;
  templateCode: string;
  /** 模板变量，会 JSON.stringify 后作为 TemplateParam */
  templateParam: Record<string, string>;
  /** 固定值便于测试；不传则用当前时间与随机串 */
  timestamp?: string;
  nonce?: string;
  regionId?: string;
}

/** 阿里云要求的 RFC3986 编码：空格→%20、*→%2A、~ 不编码 */
export function percentEncode(value: string): string {
  return encodeURIComponent(value)
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%7E/g, '~');
}

export function buildAliyunSmsQuery(input: AliyunSmsRequest): {
  url: string;
  signature: string;
  params: Record<string, string>;
} {
  const params: Record<string, string> = {
    AccessKeyId: input.accessKeyId,
    Action: 'SendSms',
    Format: 'JSON',
    RegionId: input.regionId ?? 'cn-hangzhou',
    SignatureMethod: 'HMAC-SHA1',
    SignatureNonce: input.nonce ?? randomUUID(),
    SignatureVersion: '1.0',
    Timestamp: input.timestamp ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    Version: '2017-05-25',
    PhoneNumbers: input.phone,
    SignName: input.signName,
    TemplateCode: input.templateCode,
    TemplateParam: JSON.stringify(input.templateParam),
  };

  const canonicalized = Object.keys(params)
    .sort()
    .map((k) => `${percentEncode(k)}=${percentEncode(params[k])}`)
    .join('&');

  const stringToSign = `GET&%2F&${percentEncode(canonicalized)}`;
  const signature = createHmac('sha1', `${input.accessKeySecret}&`).update(stringToSign).digest('base64');

  return {
    url: `https://dysmsapi.aliyuncs.com/?Signature=${percentEncode(signature)}&${canonicalized}`,
    signature,
    params,
  };
}

/** 渲染模板变量：与设置页约定的四个变量保持一致 */
export function renderSmsContent(
  template: string,
  vars: { date: string; address: string; period: string; amount: string },
): string {
  return template
    .replace(/\$\{date\}/g, vars.date)
    .replace(/\$\{address\}/g, vars.address)
    .replace(/\$\{period\}/g, vars.period)
    .replace(/\$\{amount\}/g, vars.amount);
}

/** 中文短信计费条数：70 字一条，超出按 67 字拼接 */
export function smsSegments(content: string): number {
  const len = content.length;
  return len <= 70 ? 1 : Math.ceil(len / 67);
}

export type AliyunSmsResult =
  | { ok: true; bizId: string | null; requestId: string | null; dryRun?: boolean }
  | { ok: false; error: string };

/**
 * 真正调用通道。没有配置时返回失败而不是抛异常，调用方按逐户失败记录。
 * 目前只做单条发送，批量在调用方按户循环（阿里云支持批量但计费与回执按条，
 * 逐条发送能对上每户的回执，排错也简单）。
 */
export async function sendAliyunSms(
  input: AliyunSmsRequest,
  options?: { dryRun?: boolean; timeoutMs?: number },
): Promise<AliyunSmsResult> {
  if (options?.dryRun) return { ok: true, bizId: null, requestId: null, dryRun: true };

  const { url } = buildAliyunSmsQuery(input);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  timer = setTimeout(() => controller.abort(), options?.timeoutMs ?? 15_000);
  try {
    const request = (globalThis as any).fetch as typeof fetch;
    const res = await request(url, { method: 'GET', signal: controller.signal });
    const text = await res.text();
    let data: any = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
    if (!res.ok) return { ok: false, error: `通道 HTTP ${res.status}` };
    if (data?.Code && data.Code !== 'OK') {
      return { ok: false, error: String(data.Message || data.Code).slice(0, 180) };
    }
    return { ok: true, bizId: data?.BizId ? String(data.BizId) : null, requestId: data?.RequestId ? String(data.RequestId) : null };
  } catch (e) {
    const msg = e instanceof Error ? (e.name === 'AbortError' ? '短信通道超时' : e.message) : '短信通道调用失败';
    return { ok: false, error: msg.slice(0, 180) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
