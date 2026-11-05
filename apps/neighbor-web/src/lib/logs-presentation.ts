const SENSITIVE_ROUTES = [
  { pattern: /^\/vehicle-intake-form\/[^/]+$/, prefix: 'post_vehicle_intake_form_', action: 'post_vehicle_intake_form_token', path: '/vehicle-intake-form/:token' },
  { pattern: /^\/external-access-agent\/frp-plugin\/[^/]+$/, prefix: 'post_external_access_agent_frp_plugin_', action: 'post_external_access_agent_frp_plugin_pluginSecret', path: '/external-access-agent/frp-plugin/:pluginSecret' },
];
/** 防御旧API/历史响应中的凭据动作；不将技术原文直接放进DOM。 */
export function safeLogTechnical(row: {action: string; requestPath?: string | null; message: string}) {
  const rawPath = row.requestPath || row.action.match(/^\w+\s+(\/\S+)/)?.[1] || '';
  const path = rawPath.split('?')[0].replace(/^\/api\/v\d+/, '').replace(/\/+$/, '');
  const sensitive = SENSITIVE_ROUTES.find(rule => rule.pattern.test(path) || row.action.startsWith(rule.prefix));
  return sensitive
    ? {action: sensitive.action, path: sensitive.path, message: '敏感接口请求（原始详情已隐藏）'}
    : {action: row.action, path: rawPath.split('?')[0] || '—', message: row.message};
}

export interface LogPresentation {
  actionLabel: string; moduleLabel: string; objectType: string | null; objectId: number | null;
  requestResult: string; businessResult: string | null; auditClass: string | null;
  historyNotice: string; completionNotice: string;
}
const OBJECT_NAMES: Record<string,string> = {house:'房屋',role:'角色',role_template:'权限模板',staff:'员工',owner:'业主',owner_audit:'业主入驻申请',work_order:'工单',repair_request:'报修',stocktake:'盘点单',transfer_order:'调拨单',purchase_request:'采购申请',purchase_order:'采购单',fee_bill:'收费账单',business_order:'业务单',vehicle_intake:'车辆登记单',family_car:'亲情车申请',external_access_app:'内网应用',external_access_agent:'内网客户端'};
export function logObjectLabel(p?: LogPresentation | null) {
  if (!p) return '对象未记录';
  const type = p.objectType ? OBJECT_NAMES[p.objectType] || `${p.moduleLabel}对象` : '业务对象';
  return p.objectId != null ? `${type} #${p.objectId}` : `${type}（对象ID未记录）`;
}
