/**
 * 是否必须配置“可代报的小区”。
 *
 * 该限制只服务于代住户创建报修：角色拥有报修创建入口、但没有工单池或
 * 派单台时，才需要限制其可代报范围。纯内网应用、维修工等不应被此表单
 * 校验拦住。
 */
export function needsReportCommunitySelection(appPageKeys: Iterable<string>): boolean {
  const keys = new Set(appPageKeys);
  return (
    keys.has('app:repair-create') &&
    !keys.has('app:pool') &&
    !keys.has('app:dispatch')
  );
}
