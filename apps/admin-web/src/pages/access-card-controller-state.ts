export function shouldRetryHistoricalControllerUpload(
  accessStatus: string,
  latestAuthorizationStatus?: string | null,
): boolean {
  // .88 权限表已读到该卡时，旧失败任务不得继续覆盖当前读回结果。
  return accessStatus !== 'controller_uploaded' && latestAuthorizationStatus === 'failed';
}

export function controllerBuildingResults(task: {
  operation: string;
  status: string;
  targetBuildings: Array<{ buildingNo: string }>;
  controllerResults: Array<Record<string, unknown>>;
}) {
  const expected = task.operation === 'controller_revoke' ? 'controller_removed' : 'controller_uploaded';
  return task.targetBuildings.map((building) => {
    const result = task.controllerResults.find((row) => String(row.buildingNo) === building.buildingNo);
    return {
      buildingNo: building.buildingNo,
      succeeded: result?.status === expected,
      detail: result?.status === expected ? (task.operation === 'controller_revoke' ? '已删除权限' : '已下发成功')
        : result?.error ? String(result.error)
          : task.status === 'failed' ? '未完成，请重试' : '等待处理',
    };
  });
}
