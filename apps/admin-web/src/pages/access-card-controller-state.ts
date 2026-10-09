export function shouldRetryHistoricalControllerUpload(
  accessStatus: string,
  latestAuthorizationStatus?: string | null,
): boolean {
  // .88 权限表已读到该卡时，旧失败任务不得继续覆盖当前读回结果。
  return accessStatus !== 'controller_uploaded' && latestAuthorizationStatus === 'failed';
}
