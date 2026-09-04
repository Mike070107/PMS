import { isApiEnvelope } from './envelope';
import { diagnosticRequestPath } from './request-diagnostic';

import { compressImageIfNeeded } from './compress';

export interface RequestConfig {
  baseURL: string;
  getToken: () => string | undefined;
  onUnauthorized?: () => void;
  /** 每次请求附加的头（平台超管租户切换的 x-acting-tenant-id 走这里） */
  getExtraHeaders?: () => Record<string, string>;
}

let config: RequestConfig | null = null;

export function configure(c: RequestConfig) {
  config = c;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  data?: any;
  query?: Record<string, string | number | boolean | undefined>;
  anonymous?: boolean;
  timeout?: number;
}

export class ApiError extends Error {
  constructor(
    public code: number,
    message: string,
    public httpStatus?: number,
    /** 网络层失败（超时、断网、服务重启），不是服务端返回的业务错误。只读请求可以重试 */
    public networkFailure = false,
  ) {
    super(message);
  }
}

export interface LastApiFailure {
  method: string;
  url: string;
  message: string;
  code: number;
  httpStatus?: number;
  at: string;
  route?: string;
}

let lastApiFailure: LastApiFailure | null = null;

/** 供“反馈异常”自动附带最近一次请求失败，不包含请求表单和个人信息。 */
export function getLastApiFailure(): LastApiFailure | null {
  return lastApiFailure ? { ...lastApiFailure } : null;
}

function buildUrl(
  base: string,
  path: string,
  query?: Record<string, string | number | boolean | undefined>,
) {
  let url = base.replace(/\/$/, '') + (path.startsWith('/') ? path : '/' + path);
  if (query) {
    const qs = Object.entries(query)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join('&');
    if (qs) url += (url.includes('?') ? '&' : '?') + qs;
  }
  return url;
}

/** 是不是 `{ code, data, message }` 包装 —— 判断口径见 envelope.ts */
function unwrap(raw: any) {
  if (!isApiEnvelope(raw)) return raw;
  const r = raw as { code: number; data?: any; message?: string };
  if (r.code === 0) return r.data;
  throw new ApiError(r.code, r.message || '请求失败');
}

/** 从后端错误响应里取真实提示（Nest 的 message 可能是字符串或字符串数组） */
function serverMessage(body: any): string | undefined {
  if (!body) return undefined;
  const raw = typeof body === 'string' ? tryParseJson(body) : body;
  const msg = raw?.message ?? raw?.error;
  if (Array.isArray(msg)) return msg.filter(Boolean).join('；');
  return typeof msg === 'string' && msg ? msg : undefined;
}

function tryParseJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function hasWxRequest(): boolean {
  // @ts-ignore — 小程序运行时注入
  return typeof wx !== 'undefined' && typeof wx.request === 'function';
}

/**
 * 把微信的原始 errMsg 翻成人话。
 *
 * 不翻的话用户看到的就是 `request:fail fail:time out`（2026-09-04 反馈就是这一条），
 * 既不知道发生了什么，也不知道下一步该干嘛。每条都要给出**下一步动作**。
 */
function networkMessage(errMsg?: string): string {
  const raw = String(errMsg || '');
  if (/time\s*out/i.test(raw)) return '网络超时，请检查网络后下拉刷新重试';
  if (/abort/i.test(raw)) return '请求被中断，请重试';
  if (/not in domain list|domain/i.test(raw)) return '小程序服务器域名没配好，请联系管理员在公众平台加白名单';
  if (/ssl|certificate|cert/i.test(raw)) return '安全连接失败，请检查手机日期时间是否准确';
  if (/fail/i.test(raw)) return '网络连接失败，请检查网络后重试';
  return raw || '网络异常';
}

/**
 * 只读请求（GET）失败时自动重试一次。
 *
 * 服务端每次发版 pm2 reload 有十几秒不可用，手机在电梯里、地库里也常断一下 ——
 * 这种一次性抖动不该让人看到一屏报错。**只重试 GET**：POST 重试等于重复提交，
 * 完工那条就是被重复提交坑过的（见 order-detail 的幂等令牌）。
 */
function shouldRetry(opts: RequestOptions): boolean {
  return (opts.method ?? 'GET') === 'GET';
}

function requestViaWx<T>(
  url: string,
  opts: RequestOptions,
  header: Record<string, string>,
): Promise<T> {
  // wx.request 不支持 PATCH（仅 OPTIONS/GET/HEAD/POST/PUT/DELETE/TRACE/CONNECT），
  // 小程序端如需部分更新，后端要另提供 POST/PUT 接口。
  if (opts.method === 'PATCH') {
    return Promise.reject(new ApiError(-1, '小程序不支持 PATCH 请求，请使用 POST/PUT 接口'));
  }
  const wxMethod = opts.method ?? 'GET';
  return new Promise<T>((resolve, reject) => {
    // @ts-ignore
    wx.request({
      url,
      method: wxMethod,
      data: opts.data,
      header,
      timeout: opts.timeout ?? 15000,
      success: (res: any) => {
        const { statusCode, data } = res;
        if (statusCode === 401) {
          // 匿名请求（登录类）的 401 是凭据不对，不是登录态过期，不能踢回登录页
          if (!opts.anonymous) config?.onUnauthorized?.();
          return reject(
            new ApiError(401, serverMessage(data) || '未登录或登录已过期', statusCode),
          );
        }
        if (statusCode < 200 || statusCode >= 300) {
          return reject(
            new ApiError(statusCode, serverMessage(data) || `HTTP ${statusCode}`, statusCode),
          );
        }
        try {
          resolve(unwrap(data));
        } catch (e) {
          reject(e);
        }
      },
      fail: (err: any) =>
        reject(new ApiError(-1, networkMessage(err?.errMsg), undefined, true)),
    });
  });
}

async function requestViaFetch<T>(
  url: string,
  opts: RequestOptions,
  header: Record<string, string>,
): Promise<T> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), opts.timeout ?? 15000);
  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? 'GET',
      headers: header,
      body:
        opts.data !== undefined && opts.method && opts.method !== 'GET'
          ? JSON.stringify(opts.data)
          : undefined,
      signal: controller.signal,
    });
  } catch (e: any) {
    clearTimeout(t);
    throw new ApiError(-1, e?.message || '网络异常');
  }
  clearTimeout(t);

  if (res.status === 401) {
    if (!opts.anonymous) config?.onUnauthorized?.();
    const body = await res.json().catch(() => null);
    throw new ApiError(401, serverMessage(body) || '未登录或登录已过期', 401);
  }
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      msg = j?.message || j?.error || msg;
    } catch {}
    throw new ApiError(res.status, msg, res.status);
  }
  const body = await res.json().catch(() => null);
  return unwrap(body);
}

export interface UploadFileResp {
  bucket: string;
  objectKey: string;
  /** 可直接展示、也可写入 attachments 的地址（经后端代理读私有桶） */
  publicUrl: string;
  /** 同 publicUrl，保留旧字段名兼容 */
  displayUrl: string;
  /** COS 规范地址，私有桶直连会 403，只作排障参考 */
  cosUrl?: string;
}

/**
 * 小程序上传本地临时文件（wx.uploadFile → POST /upload，multipart）。
 * 只在小程序环境可用；Web 端请直接用 FormData + fetch。
 */
export function uploadFile(tempFilePath: string, timeout = 60000): Promise<UploadFileResp> {
  if (!config) throw new Error('[api-client] configure() must be called before uploadFile()');
  if (!hasWxRequest()) {
    return Promise.reject(new ApiError(-1, 'uploadFile 仅在小程序环境可用'));
  }
  // 压缩挂在这一条路上，全端所有选图入口都会经过，新入口不用记得自己压。
  // 压不动会原样返回，绝不因此上传失败（见 compress.ts）
  return compressImageIfNeeded(tempFilePath).then((filePath) => uploadTempFile(filePath, timeout));
}

function uploadTempFile(tempFilePath: string, timeout: number): Promise<UploadFileResp> {
  const url = buildUrl(config!.baseURL, '/upload');
  const header: Record<string, string> = {};
  const token = config!.getToken();
  if (token) header['Authorization'] = `Bearer ${token}`;
  return new Promise<UploadFileResp>((resolve, reject) => {
    // @ts-ignore — 小程序运行时注入
    wx.uploadFile({
      url,
      filePath: tempFilePath,
      name: 'file',
      header,
      timeout,
      success: (res: any) => {
        const { statusCode, data } = res;
        if (statusCode === 401) {
          config?.onUnauthorized?.();
          return reject(
            new ApiError(401, serverMessage(data) || '未登录或登录已过期', statusCode),
          );
        }
        if (statusCode < 200 || statusCode >= 300) {
          return reject(
            new ApiError(statusCode, serverMessage(data) || `上传失败 HTTP ${statusCode}`, statusCode),
          );
        }
        const parsed = tryParseJson(data);
        if (!parsed) return reject(new ApiError(-1, '上传返回格式异常'));
        try {
          resolve(unwrap(parsed));
        } catch (e) {
          reject(e);
        }
      },
      fail: (err: any) => reject(new ApiError(-1, err.errMsg || '上传失败')),
    });
  });
}

export function request<T = unknown>(opts: RequestOptions): Promise<T> {
  if (!config) throw new Error('[api-client] configure() must be called before request()');
  const url = buildUrl(config.baseURL, opts.url, opts.query);
  const header: Record<string, string> = { 'Content-Type': 'application/json' };
  if (!opts.anonymous) {
    const token = config.getToken();
    if (token) header['Authorization'] = `Bearer ${token}`;
    Object.assign(header, config.getExtraHeaders?.() ?? {});
  }
  const send = () =>
    hasWxRequest() ? requestViaWx<T>(url, opts, header) : requestViaFetch<T>(url, opts, header);
  // 只读请求碰上网络抖动（超时、断网、服务端发版重启）自动重试一次；
  // 写请求绝不重试 —— 那等于重复提交
  const pending = shouldRetry(opts)
    ? send().catch((error: any) => {
        if (!error?.networkFailure) throw error;
        return new Promise<T>((resolve, reject) => {
          setTimeout(() => send().then(resolve, reject), 600);
        });
      })
    : send();
  return pending.catch((error: any) => {
    lastApiFailure = {
      method: opts.method || 'GET',
      url: diagnosticRequestPath(opts.url, opts.query),
      message: String(error?.message || '请求失败').slice(0, 500),
      code: Number(error?.code || -1),
      httpStatus: error?.httpStatus,
      at: new Date().toISOString(),
      route: currentClientRoute(),
    };
    throw error;
  });
}

function currentClientRoute(): string | undefined {
  try {
    if (hasWxRequest()) {
      // @ts-ignore — 小程序运行时全局函数
      const pages = getCurrentPages();
      const current = pages[pages.length - 1];
      return current?.route ? `/${current.route}` : undefined;
    }
    if (typeof window !== 'undefined') return `${window.location.pathname}${window.location.search}`;
  } catch {}
  return undefined;
}
