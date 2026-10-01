export interface ApiErrorAlertInput {
  source: string;
  errors: number;
  requests: number;
  path?: string | null;
  statusCode?: number | null;
  reason?: string | null;
}

const CLIENT_SOURCE_LABELS: Record<string, string> = {
  'admin-web': '管理后台',
  'miniapp-staff': '员工端小程序',
  'miniapp-owner': '业主端小程序',
};

/** 把技术路由换成管理员能直接判断的业务动作。 */
export function apiEndpointLabel(path?: string | null): string {
  const normalized = String(path || '').split('?')[0].replace(/\/+$/, '');
  if (/\/external-access\/apps\/[^/]+\/sync$/.test(normalized)) return '外部访问应用同步';
  if (/\/auth\/oidc\/\.well-known\/openid-configuration$/.test(normalized)) return '内网应用登录配置';
  if (/\/notifications\/templates\/test$/.test(normalized)) return '消息通知测试';
  if (/\/upload$/.test(normalized)) return '附件上传';
  return normalized ? `接口 ${normalized.replace(/^\/api\/v1/, '') || '/'}` : '业务接口';
}

/** 告警文案必须同时说清“哪里失败、多少次、原因和处理出口”。 */
export function buildApiErrorAlert(input: ApiErrorAlertInput): { title: string; message: string } {
  const endpoint = apiEndpointLabel(input.path);
  const source = CLIENT_SOURCE_LABELS[input.source] || input.source || '未知客户端';
  const status = input.statusCode ? `HTTP ${input.statusCode}` : '服务端异常';
  const rawReason = String(input.reason || '').trim();
  const usefulReason = rawReason && !/^API 返回 \d+$/.test(rawReason) ? rawReason : '';
  const reason = usefulReason ? `原因：${usefulReason.slice(0, 160)}。` : '';
  return {
    title: `${endpoint}失败`,
    message: `最近10分钟，${source}的“${endpoint}”失败 ${input.errors} 次（${status}，共 ${input.requests} 次请求）。${reason}请到日志管理查看并处理。`,
  };
}
