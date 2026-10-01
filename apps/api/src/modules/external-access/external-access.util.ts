import { BadRequestException } from '@nestjs/common';

export type ExternalIngressRule = {
  hostname?: string;
  service: string;
  originRequest?: Record<string, unknown>;
};

export type ExternalRouteInput = {
  publicHostname: string;
  originUrl: string;
  enabled: boolean;
};

/** 规范化并校验一条外网域名 → 内网 HTTP 服务的路由。 */
export function normalizeExternalRoute(
  publicHostname: string,
  originUrl: string,
  zone: string,
) {
  const hostname = publicHostname
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/$/, '');
  const normalizedZone = zone.trim().toLowerCase();
  const label = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
  const hostnamePattern = new RegExp(`^(?:${label}\\.)+${normalizedZone.replace(/\./g, '\\.')}$`);
  if (hostname.length > 253 || !hostnamePattern.test(hostname)) {
    throw new BadRequestException(`外网域名必须是 ${normalizedZone} 的有效子域名`);
  }

  let origin: URL;
  try {
    origin = new URL(originUrl.trim());
  } catch {
    throw new BadRequestException('内网地址格式错误，例如 http://192.168.1.20:8080');
  }
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password) {
    throw new BadRequestException('内网地址只支持不含账号密码的 HTTP/HTTPS URL');
  }
  if (origin.hash) {
    throw new BadRequestException('内网入口地址不能包含 # 锚点');
  }
  const entryPath = `${origin.pathname || '/'}${origin.search}`;
  return {
    publicHostname: hostname,
    // Tunnel 的 service 只能是源站根地址；用户请求中的路径会由 Cloudflare 原样转发。
    originUrl: origin.origin,
    entryPath,
  };
}

/** 保留非本模块管理的 Tunnel 路由，替换已管理路由，并始终放置最终 404。 */
export function mergeIngressRules(
  current: ExternalIngressRule[],
  apps: ExternalRouteInput[],
  oldHostname?: string,
): ExternalIngressRule[] {
  const managed = new Set(apps.map((item) => item.publicHostname));
  if (oldHostname) managed.add(oldHostname);
  const preserved = current.filter((rule) => rule.hostname && !managed.has(rule.hostname));
  const enabled = apps
    .filter((item) => item.enabled)
    .map((item) => ({
      hostname: item.publicHostname,
      service: item.originUrl,
      originRequest: {},
    }));
  return [...preserved, ...enabled, { service: 'http_status:404' }];
}
