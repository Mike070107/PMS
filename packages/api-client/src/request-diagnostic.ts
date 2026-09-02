/**
 * 异常反馈用的请求摘要。只保留排障所需的枚举/编号参数，
 * 搜索词、地址等自由文本不进日志。
 */
export function diagnosticRequestPath(
  path: string,
  query?: Record<string, string | number | boolean | undefined>,
): string {
  const allowed = new Set([
    'scope', 'status', 'communityId', 'buildingId', 'warehouseId', 'officeId',
    'page', 'pageSize', 'limit',
  ]);
  const entries = Object.entries(query || {}).filter(
    ([key, value]) => allowed.has(key) && value !== undefined && value !== null && value !== '',
  );
  if (!entries.length) return path;
  return `${path}?${entries
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&')}`;
}
