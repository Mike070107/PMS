import { businessActionRules, normalizeBusinessPath, resolveBusinessAction } from './business-action';

/** 路径里的凭据只保留固定模板占位符；不回写历史行。 */
export function safeLogPath(value: string) {
  const path = normalizeBusinessPath(value);
  const secretRule = businessActionRules.find(rule => 'template' in rule && typeof rule.template === 'string' && /:(?:token|pluginSecret)(?:\/|$)/.test(rule.template) && rule.pattern.test(path));
  return secretRule && 'template' in secretRule ? String(secretRule.template) : String(value || '/').split('?')[0];
}
const credentialRules = businessActionRules.flatMap(rule =>
  'template' in rule && typeof rule.template === 'string' && /:(?:token|pluginSecret)(?:\/|$)/.test(rule.template)
    ? [{ method: rule.method, pattern: rule.pattern, code: rule.code, template: rule.template }]
    : []);

/** 历史凭据可藏在 action/message/detail；只读整行投影，不改数据库。 */
export function redactSensitiveLog(row: Parameters<typeof presentOperation>[0]) {
  const legacyPath = row.action.match(/^(?:POST|PUT|PATCH|DELETE|GET)\s+(\/\S+)/i)?.[1];
  const path = normalizeBusinessPath(row.requestPath || legacyPath || '');
  const rule = credentialRules.find(item => item.pattern.test(path))
    || credentialRules.find(item => row.action === item.code || row.action.startsWith(item.code.replace(/_(?:token|pluginSecret)$/, '_')));
  if (!rule) return null;
  const presentation = presentOperation({ ...row, requestMethod: rule.method, requestPath: rule.template, detail: null });
  return {
    action: rule.code,
    requestPath: rule.template,
    message: presentation?.actionLabel || '敏感接口请求（原始详情已隐藏）',
    detail: presentation ? {
      operationLabel: presentation.actionLabel,
      businessArea: presentation.moduleLabel,
      objectType: presentation.objectType,
      objectId: presentation.objectId,
    } : null,
    presentation,
  };
}

const OBJECT_ROUTES: Array<[RegExp, string]> = [
  [/^\/vehicle-intakes(?:\/|$)/, 'vehicle_intake'], [/^\/family-cars(?:\/|$)/, 'family_car'],
  [/^\/external-access\/apps(?:\/|$)/, 'external_access_app'], [/^\/external-access\/agents(?:\/|$)/, 'external_access_agent'],
  [/^\/houses(?:\/|$)/, 'house'], [/^\/business\/transactions(?:\/|$)/, 'business_order'],
  [/^\/access-card-issuance\/parking\/proof-uploads(?:\/|$)/, 'parking_proof'],
];

/** SQL 端在 LIMIT/OFFSET 前使用同一字典，包含历史泛化 code；所有值参数化。 */
export function auditClassPredicate(auditClass: AuditClass) {
  const rules = businessActionRules.filter(rule => classifyBusinessAction(rule) === auditClass);
  const params: Record<string, unknown> = {};
  const path = "regexp_replace(regexp_replace(split_part(COALESCE(NULLIF(log.request_path, ''), regexp_replace(log.action, '^\\w+\\s+', '')), '?', 1), '/+$', ''), '^/api/v[0-9]+', '')";
  const conditions = rules.map((rule, i) => {
    params[`auditMethod${i}`] = rule.method;
    params[`auditPath${i}`] = rule.pattern.source.replace(/\\\//g, '/');
    return `(UPPER(COALESCE(NULLIF(log.request_method, ''), split_part(log.action, ' ', 1))) = :auditMethod${i} AND ${path} ~ :auditPath${i})`;
  });
  return { sql: `(log.category = 'operation' AND (${conditions.join(' OR ') || 'FALSE'}))`, params };
}

export const AUDIT_CLASSES = ['approval', 'archive_delete', 'permission'] as const;
export type AuditClass = (typeof AUDIT_CLASSES)[number];
/** 按已核实字典分类；未知未来路由不凭 approve/delete 字符猜业务。 */
export function classifyBusinessAction(business: {known?: boolean; label: string; area: string; code: string}): AuditClass | null {
  if (business.known === false) return null;
  if (/审核|验收|复核/.test(business.label) && !/提交|凭证|设置/.test(business.label)) return 'approval';
  if (business.area === '用户权限' || /角色权限|权限模板|数据范围/.test(business.label)) return 'permission';
  if (/归档|删除|恢复房屋|恢复.*档案|作废/.test(business.label)) return 'archive_delete';
  return null;
}
const decisionLabels: Record<string, string> = {approve:'通过',approved:'通过',reject:'拒绝',rejected:'拒绝',return:'退回',reupload:'退回补资料',void:'作废'};
const positiveId = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
/** 只读展示投影；不更新历史数据库，不信任旧 operationLabel。 */
export function presentOperation(row: {category: string; action: string; requestMethod?: string | null; requestPath?: string | null; detail?: Record<string, any> | null; statusCode?: number | null; success: boolean}) {
  if (row.category !== 'operation') return null;
  const detail = row.detail || {};
  const business = resolveBusinessAction(row.requestMethod || row.action.split(' ')[0], row.requestPath || row.action.replace(/^\w+\s+/, ''), {entryMode: detail.entryMode});
  const auditClass = classifyBusinessAction(business);
  const ok = row.statusCode != null ? row.statusCode >= 200 && row.statusCode < 400 : row.success;
  let businessResult: string | null = null;
  if (auditClass === 'approval') {
    businessResult = !ok ? (row.statusCode === 403 ? '未执行审批' : '审批未成功，结果未确认')
      : (typeof detail.decision === 'string' && Object.prototype.hasOwnProperty.call(decisionLabels, detail.decision) ? decisionLabels[detail.decision] : null)
        || (typeof detail.approved === 'boolean' ? (detail.approved ? '通过' : '退回') : null)
        || (/（通过）/.test(business.label) ? '通过' : /（拒绝）/.test(business.label) ? '拒绝' : '审批结果未记录');
  }
  return {
    actionLabel: auditClass === 'approval' ? business.label.replace(/（(?:通过|拒绝)）/g, '') : business.label,
    moduleLabel: business.area,
    objectType: business.objectType || (business.known ? OBJECT_ROUTES.find(([pattern]) => pattern.test(normalizeBusinessPath(row.requestPath || '')))?.[1] : null) || null,
    objectId: business.objectId || positiveId(detail.objectId),
    requestResult: row.statusCode === 403 ? '无权操作，未执行' : ok ? '请求执行成功' : '请求执行失败（业务结果未确认）',
    businessResult,
    auditClass,
    historyNotice: '变更前后值未记录；本日志不是完整审计快照',
    completionNotice: 'HTTP 成功仅说明请求执行成功，不代表设备完成、消息送达或纸张打印完成',
  };
}
