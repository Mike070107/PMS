/**
 * 把写接口翻译成业务人员能看懂、也能长期统计的操作事件。
 * action code 一旦上线就不随文案改名；中文 label 可以持续优化。
 */
export interface BusinessAction {
  code: string;
  label: string;
  area: string;
  objectType?: string;
  objectId?: number;
  detail?: Record<string, unknown>;
}

interface Rule {
  method: string;
  pattern: RegExp;
  code: string;
  label: string;
  area: string;
  objectType?: string;
}

const RULES: Rule[] = [
  { method: 'POST', pattern: /^\/repair-requests\/parse-address$/, code: 'repair_ai_recognize', label: '使用 AI 识别报修', area: '报修', objectType: 'repair_request' },
  { method: 'POST', pattern: /^\/repair-requests\/office$/, code: 'repair_create_office_form', label: '办公室填表报修', area: '报修', objectType: 'repair_request' },
  { method: 'POST', pattern: /^\/work-orders\/(\d+)\/assign$/, code: 'work_order_assign', label: '派单', area: '工单', objectType: 'work_order' },
  { method: 'POST', pattern: /^\/work-orders\/(\d+)\/accept$/, code: 'work_order_accept', label: '接单', area: '工单', objectType: 'work_order' },
  { method: 'POST', pattern: /^\/work-orders\/(\d+)\/complete$/, code: 'work_order_complete', label: '完工提交', area: '工单', objectType: 'work_order' },
  { method: 'POST', pattern: /^\/work-orders\/(\d+)\/need-material$/, code: 'work_order_need_material', label: '提报缺料', area: '工单', objectType: 'work_order' },
  { method: 'POST', pattern: /^\/work-orders\/(\d+)\/missing-materials$/, code: 'work_order_missing_material_update', label: '更新工单缺料', area: '工单', objectType: 'work_order' },
  { method: 'DELETE', pattern: /^\/work-orders\/(\d+)\/materials\/\d+$/, code: 'work_order_material_delete', label: '删除工单用料', area: '工单', objectType: 'work_order' },
  { method: 'POST', pattern: /^\/work-orders\/(\d+)\/review$/, code: 'work_order_review', label: '验收工单', area: '工单', objectType: 'work_order' },
  { method: 'POST', pattern: /^\/work-orders\/(\d+)\/cancel$/, code: 'work_order_cancel', label: '撤销工单', area: '工单', objectType: 'work_order' },
  { method: 'POST', pattern: /^\/work-orders\/(\d+)\/urge(?:-repair)?$/, code: 'work_order_urge', label: '催修', area: '工单', objectType: 'work_order' },
  { method: 'PATCH', pattern: /^\/work-orders\/(\d+)\/sla-due$/, code: 'work_order_sla_update', label: '修改工单时限', area: '工单', objectType: 'work_order' },
  { method: 'PATCH', pattern: /^\/work-orders\/(\d+)\/repair-type$/, code: 'work_order_type_update', label: '修改报修类型', area: '工单', objectType: 'work_order' },
  { method: 'POST', pattern: /^\/repair-type-rules$/, code: 'repair_type_rule_create', label: '新增报修类型', area: '报修配置', objectType: 'repair_type_rule' },
  { method: 'PATCH', pattern: /^\/repair-type-rules\/(\d+)$/, code: 'repair_type_rule_update', label: '修改报修类型配置', area: '报修配置', objectType: 'repair_type_rule' },
  { method: 'DELETE', pattern: /^\/repair-type-rules\/(\d+)$/, code: 'repair_type_rule_delete', label: '删除报修类型', area: '报修配置', objectType: 'repair_type_rule' },
  { method: 'POST', pattern: /^\/repair-type-rules\/reorder$/, code: 'repair_type_rule_reorder', label: '调整报修类型排序', area: '报修配置', objectType: 'repair_type_rule' },
  { method: 'PATCH', pattern: /^\/repair-type-rules\/offices\/(\d+)\/suggestion-settings$/, code: 'repair_suggestion_settings_update', label: '修改报修联想设置', area: '报修配置', objectType: 'office' },
  { method: 'PATCH', pattern: /^\/stocks\/(\d+)$/, code: 'stock_update', label: '修改库存', area: '库存', objectType: 'stock' },
  { method: 'POST', pattern: /^\/goods-receipts(?:\/general)?$/, code: 'stock_receive', label: '办理入库', area: '库存', objectType: 'goods_receipt' },
  { method: 'POST', pattern: /^\/transfer-orders$/, code: 'stock_transfer_create', label: '新建库存调拨', area: '库存', objectType: 'transfer_order' },
  { method: 'POST', pattern: /^\/transfer-orders\/(\d+)\/approve$/, code: 'stock_transfer_approve', label: '审批库存调拨', area: '库存', objectType: 'transfer_order' },
  { method: 'POST', pattern: /^\/transfer-orders\/(\d+)\/receive$/, code: 'stock_transfer_receive', label: '确认调拨收货', area: '库存', objectType: 'transfer_order' },
  { method: 'POST', pattern: /^\/stocktakes$/, code: 'stocktake_create', label: '发起库存盘点', area: '盘点', objectType: 'stocktake' },
  { method: 'POST', pattern: /^\/stocktakes\/(\d+)\/items\/(\d+)\/count$/, code: 'stocktake_count', label: '录入实盘数量', area: '盘点', objectType: 'stocktake' },
  { method: 'POST', pattern: /^\/stocktakes\/(\d+)\/submit$/, code: 'stocktake_submit', label: '提交盘点结果', area: '盘点', objectType: 'stocktake' },
  { method: 'POST', pattern: /^\/stocktakes\/(\d+)\/review$/, code: 'stocktake_review', label: '复核盘点', area: '盘点', objectType: 'stocktake' },
  { method: 'POST', pattern: /^\/purchase-requests$/, code: 'purchase_request_create', label: '提交采购申请', area: '采购', objectType: 'purchase_request' },
  { method: 'POST', pattern: /^\/purchase-requests\/submit-to-manager$/, code: 'purchase_request_submit_manager', label: '采购申请提交主管', area: '采购', objectType: 'purchase_request' },
  { method: 'PATCH', pattern: /^\/purchase-requests\/(\d+)\/items$/, code: 'purchase_request_items_update', label: '修改采购申请明细', area: '采购', objectType: 'purchase_request' },
  { method: 'POST', pattern: /^\/purchase-requests\/(\d+)\/reject-item$/, code: 'purchase_request_item_reject', label: '驳回采购申请明细', area: '采购', objectType: 'purchase_request' },
  { method: 'POST', pattern: /^\/purchase-requests\/(\d+)\/(?:manager-approve|purchaser-approve)$/, code: 'purchase_request_approve', label: '审批采购申请', area: '采购', objectType: 'purchase_request' },
  { method: 'POST', pattern: /^\/purchase-requests\/(\d+)\/reject$/, code: 'purchase_request_reject', label: '驳回采购申请', area: '采购', objectType: 'purchase_request' },
  { method: 'POST', pattern: /^\/purchase-orders$/, code: 'purchase_order_create', label: '生成采购单', area: '采购', objectType: 'purchase_order' },
  { method: 'POST', pattern: /^\/materials$/, code: 'material_create', label: '新增材料 SKU', area: '材料', objectType: 'material' },
  { method: 'PATCH', pattern: /^\/materials\/(\d+)$/, code: 'material_update', label: '修改材料 SKU', area: '材料', objectType: 'material' },
  { method: 'POST', pattern: /^\/materials\/(\d+)\/update$/, code: 'material_update', label: '修改材料 SKU', area: '材料', objectType: 'material' },
  { method: 'POST', pattern: /^\/material-categories$/, code: 'material_category_create', label: '新增材料分类', area: '材料', objectType: 'material_category' },
  { method: 'PATCH', pattern: /^\/material-categories\/(\d+)$/, code: 'material_category_update', label: '修改材料分类', area: '材料', objectType: 'material_category' },
  { method: 'DELETE', pattern: /^\/material-categories\/(\d+)$/, code: 'material_category_delete', label: '删除材料分类', area: '材料', objectType: 'material_category' },
  { method: 'POST', pattern: /^\/warehouses$/, code: 'warehouse_create', label: '新增仓库', area: '库存', objectType: 'warehouse' },
  { method: 'PATCH', pattern: /^\/warehouses\/(\d+)$/, code: 'warehouse_update', label: '修改仓库', area: '库存', objectType: 'warehouse' },
  { method: 'POST', pattern: /^\/warehouse-locations$/, code: 'warehouse_location_create', label: '新增仓库库位', area: '库存', objectType: 'warehouse_location' },
  { method: 'PATCH', pattern: /^\/warehouse-locations\/(\d+)$/, code: 'warehouse_location_update', label: '修改仓库库位', area: '库存', objectType: 'warehouse_location' },
  { method: 'POST', pattern: /^\/suppliers$/, code: 'supplier_create', label: '新增供应商', area: '采购', objectType: 'supplier' },
  { method: 'PATCH', pattern: /^\/suppliers\/(\d+)$/, code: 'supplier_update', label: '修改供应商', area: '采购', objectType: 'supplier' },
  { method: 'POST', pattern: /^\/transfer-orders\/(\d+)\/reject$/, code: 'stock_transfer_reject', label: '驳回库存调拨', area: '库存', objectType: 'transfer_order' },
  { method: 'POST', pattern: /^\/settings\/ai\/samples$/, code: 'ai_sample_create', label: '新增 AI 识别样例', area: 'AI 配置', objectType: 'ai_sample' },
  { method: 'PATCH', pattern: /^\/settings\/ai\/samples\/(\d+)$/, code: 'ai_sample_update', label: '修改 AI 识别样例', area: 'AI 配置', objectType: 'ai_sample' },
  { method: 'DELETE', pattern: /^\/settings\/ai\/samples\/(\d+)$/, code: 'ai_sample_delete', label: '删除 AI 识别样例', area: 'AI 配置', objectType: 'ai_sample' },
  { method: 'POST', pattern: /^\/settings\/ai\/feedback\/(\d+)\/promote$/, code: 'ai_feedback_promote', label: '采纳 AI 纠错样例', area: 'AI 配置', objectType: 'ai_feedback' },
  { method: 'POST', pattern: /^\/settings\/ai\/feedback\/(\d+)\/ignore$/, code: 'ai_feedback_ignore', label: '忽略 AI 纠错记录', area: 'AI 配置', objectType: 'ai_feedback' },
  { method: 'POST', pattern: /^\/settings\/ai\/fee-rules$/, code: 'ai_fee_rule_create', label: '新增 AI 收费规则', area: 'AI 配置', objectType: 'ai_fee_rule' },
  { method: 'PATCH', pattern: /^\/settings\/ai\/fee-rules\/(\d+)$/, code: 'ai_fee_rule_update', label: '修改 AI 收费规则', area: 'AI 配置', objectType: 'ai_fee_rule' },
  { method: 'DELETE', pattern: /^\/settings\/ai\/fee-rules\/(\d+)$/, code: 'ai_fee_rule_delete', label: '删除 AI 收费规则', area: 'AI 配置', objectType: 'ai_fee_rule' },
  { method: 'PATCH', pattern: /^\/settings$/, code: 'settings_update', label: '修改系统设置', area: '系统', objectType: 'settings' },
  { method: 'POST', pattern: /^\/staff$/, code: 'staff_create', label: '新增员工', area: '用户权限', objectType: 'staff' },
  { method: 'PATCH', pattern: /^\/staff\/(\d+)$/, code: 'staff_update', label: '修改员工', area: '用户权限', objectType: 'staff' },
  { method: 'POST', pattern: /^\/roles$/, code: 'role_create', label: '新增业务角色', area: '用户权限', objectType: 'role' },
  { method: 'PATCH', pattern: /^\/roles\/(\d+)$/, code: 'role_update', label: '修改业务角色权限', area: '用户权限', objectType: 'role' },
  { method: 'POST', pattern: /^\/audits\/(\d+)\/approve$/, code: 'owner_audit_approve', label: '通过业主入驻审核', area: '业主', objectType: 'owner_audit' },
  { method: 'POST', pattern: /^\/audits\/(\d+)\/reject$/, code: 'owner_audit_reject', label: '驳回业主入驻审核', area: '业主', objectType: 'owner_audit' },
  { method: 'POST', pattern: /^\/audits\/(\d+)\/revert$/, code: 'owner_audit_revert', label: '撤回业主审核结果', area: '业主', objectType: 'owner_audit' },
  { method: 'POST', pattern: /^\/owners-mgmt$/, code: 'owner_create', label: '新增业主档案', area: '业主', objectType: 'owner' },
  { method: 'POST', pattern: /^\/owners-mgmt\/import$/, code: 'owner_import', label: '导入业主档案', area: '业主', objectType: 'owner' },
  { method: 'PATCH', pattern: /^\/owners-mgmt\/(\d+)$/, code: 'owner_update', label: '修改业主档案', area: '业主', objectType: 'owner' },
  { method: 'DELETE', pattern: /^\/owners-mgmt\/(\d+)$/, code: 'owner_delete', label: '删除业主档案', area: '业主', objectType: 'owner' },
  { method: 'POST', pattern: /^\/fees\/bills$/, code: 'fee_bill_create', label: '新增物业费账单', area: '收费', objectType: 'fee_bill' },
  { method: 'PATCH', pattern: /^\/fees\/bills\/(\d+)$/, code: 'fee_bill_update', label: '修改物业费账单', area: '收费', objectType: 'fee_bill' },
  { method: 'DELETE', pattern: /^\/fees\/bills\/(\d+)$/, code: 'fee_bill_delete', label: '删除物业费账单', area: '收费', objectType: 'fee_bill' },
  { method: 'POST', pattern: /^\/fees\/bills\/pay$/, code: 'fee_bill_pay', label: '登记物业费收款', area: '收费', objectType: 'fee_bill' },
  { method: 'POST', pattern: /^\/fees\/bills\/unpay$/, code: 'fee_bill_unpay', label: '撤销物业费收款', area: '收费', objectType: 'fee_bill' },
  { method: 'POST', pattern: /^\/fees\/bills\/cancel$/, code: 'fee_bill_cancel', label: '作废物业费账单', area: '收费', objectType: 'fee_bill' },
  { method: 'POST', pattern: /^\/fees\/bills\/restore$/, code: 'fee_bill_restore', label: '恢复物业费账单', area: '收费', objectType: 'fee_bill' },
  { method: 'POST', pattern: /^\/fees\/bills\/generate$/, code: 'fee_bill_generate', label: '批量生成物业费账单', area: '收费', objectType: 'fee_bill' },
  { method: 'POST', pattern: /^\/fees\/standards$/, code: 'fee_standard_create', label: '新增物业费标准', area: '收费', objectType: 'fee_standard' },
  { method: 'PATCH', pattern: /^\/fees\/standards\/(\d+)$/, code: 'fee_standard_update', label: '修改物业费标准', area: '收费', objectType: 'fee_standard' },
  { method: 'DELETE', pattern: /^\/fees\/standards\/(\d+)$/, code: 'fee_standard_delete', label: '删除物业费标准', area: '收费', objectType: 'fee_standard' },
  { method: 'POST', pattern: /^\/fees\/import$/, code: 'fee_bill_import', label: '导入物业费账单', area: '收费', objectType: 'fee_bill' },
  { method: 'POST', pattern: /^\/business\/complete$/, code: 'frontdesk_business_complete', label: '办理前台收费业务', area: '收费', objectType: 'business_order' },
  { method: 'POST', pattern: /^\/business\/rules$/, code: 'business_rule_create', label: '新增收费业务规则', area: '收费', objectType: 'business_rule' },
  { method: 'PATCH', pattern: /^\/business\/rules\/(\d+)$/, code: 'business_rule_update', label: '修改收费业务规则', area: '收费', objectType: 'business_rule' },
  { method: 'POST', pattern: /^\/maintenance-orders$/, code: 'maintenance_order_create', label: '新建计划维保单', area: '维保', objectType: 'maintenance_order' },
  { method: 'PATCH', pattern: /^\/maintenance-orders\/(\d+)$/, code: 'maintenance_order_update', label: '修改计划维保单', area: '维保', objectType: 'maintenance_order' },
  { method: 'DELETE', pattern: /^\/maintenance-orders\/(\d+)$/, code: 'maintenance_order_delete', label: '删除计划维保单', area: '维保', objectType: 'maintenance_order' },
  { method: 'POST', pattern: /^\/maintenance-orders\/(\d+)\/inspect$/, code: 'maintenance_order_inspect', label: '提交维保验收', area: '维保', objectType: 'maintenance_order' },
  { method: 'POST', pattern: /^\/maintenance-orders\/(\d+)\/(?:sign-token|inspect-token)$/, code: 'maintenance_order_sign_prepare', label: '生成维保签字凭证', area: '维保', objectType: 'maintenance_order' },
  { method: 'POST', pattern: /^\/quota-items$/, code: 'maintenance_quota_create', label: '新增维保定额', area: '维保', objectType: 'quota_item' },
  { method: 'PATCH', pattern: /^\/quota-items\/(\d+)$/, code: 'maintenance_quota_update', label: '修改维保定额', area: '维保', objectType: 'quota_item' },
  { method: 'DELETE', pattern: /^\/quota-items\/(\d+)$/, code: 'maintenance_quota_delete', label: '删除维保定额', area: '维保', objectType: 'quota_item' },
  { method: 'PUT', pattern: /^\/quota-params$/, code: 'maintenance_quota_params_update', label: '修改维保定额参数', area: '维保', objectType: 'quota_params' },
  { method: 'POST', pattern: /^\/offices$/, code: 'office_create', label: '新增管理处', area: '基础档案', objectType: 'office' },
  { method: 'PATCH', pattern: /^\/offices\/(\d+)$/, code: 'office_update', label: '修改管理处', area: '基础档案', objectType: 'office' },
  { method: 'DELETE', pattern: /^\/offices\/(\d+)$/, code: 'office_delete', label: '删除管理处', area: '基础档案', objectType: 'office' },
  { method: 'POST', pattern: /^\/communities$/, code: 'community_create', label: '新增小区', area: '基础档案', objectType: 'community' },
  { method: 'PATCH', pattern: /^\/communities\/(\d+)$/, code: 'community_update', label: '修改小区', area: '基础档案', objectType: 'community' },
  { method: 'DELETE', pattern: /^\/communities\/(\d+)$/, code: 'community_delete', label: '删除小区', area: '基础档案', objectType: 'community' },
  { method: 'POST', pattern: /^\/buildings$/, code: 'building_create', label: '新增楼栋', area: '基础档案', objectType: 'building' },
  { method: 'PATCH', pattern: /^\/buildings\/(\d+)$/, code: 'building_update', label: '修改楼栋', area: '基础档案', objectType: 'building' },
  { method: 'DELETE', pattern: /^\/buildings\/(\d+)$/, code: 'building_delete', label: '删除楼栋', area: '基础档案', objectType: 'building' },
  { method: 'POST', pattern: /^\/houses$/, code: 'house_create', label: '新增房屋', area: '基础档案', objectType: 'house' },
  { method: 'PATCH', pattern: /^\/houses\/(\d+)$/, code: 'house_update', label: '修改房屋', area: '基础档案', objectType: 'house' },
  { method: 'DELETE', pattern: /^\/houses\/(\d+)$/, code: 'house_delete', label: '删除房屋', area: '基础档案', objectType: 'house' },
  { method: 'POST', pattern: /^\/community-spots$/, code: 'community_spot_create', label: '新增公区点位', area: '基础档案', objectType: 'community_spot' },
  { method: 'PATCH', pattern: /^\/community-spots\/(\d+)$/, code: 'community_spot_update', label: '修改公区点位', area: '基础档案', objectType: 'community_spot' },
  { method: 'DELETE', pattern: /^\/community-spots\/(\d+)$/, code: 'community_spot_delete', label: '删除公区点位', area: '基础档案', objectType: 'community_spot' },
  { method: 'POST', pattern: /^\/roles\/templates$/, code: 'role_template_create', label: '新增权限模板', area: '用户权限', objectType: 'role_template' },
  { method: 'POST', pattern: /^\/roles\/templates\/import-built-in$/, code: 'role_template_import', label: '导入内置权限模板', area: '用户权限', objectType: 'role_template' },
  { method: 'PATCH', pattern: /^\/roles\/templates\/(\d+)$/, code: 'role_template_update', label: '修改权限模板', area: '用户权限', objectType: 'role_template' },
  { method: 'DELETE', pattern: /^\/roles\/templates\/(\d+)$/, code: 'role_template_delete', label: '删除权限模板', area: '用户权限', objectType: 'role_template' },
  { method: 'POST', pattern: /^\/roles\/(\d+)\/save-as-template$/, code: 'role_save_template', label: '角色另存为权限模板', area: '用户权限', objectType: 'role' },
  { method: 'DELETE', pattern: /^\/roles\/(\d+)$/, code: 'role_delete', label: '删除业务角色', area: '用户权限', objectType: 'role' },
  { method: 'POST', pattern: /^\/staff\/(\d+)\/unbind-wx$/, code: 'staff_unbind_wechat', label: '解绑员工微信', area: '用户权限', objectType: 'staff' },
];

export function resolveBusinessAction(
  method: string,
  rawPath: string,
  body?: any,
  result?: any,
): BusinessAction {
  const verb = String(method || '').toUpperCase();
  const path = normalizeBusinessPath(rawPath);

  if (verb === 'POST' && path === '/repair-requests') {
    const quick = body?.entryMode === 'quick_ai';
    return {
      code: quick ? 'repair_create_quick_ai' : 'repair_create_form',
      label: quick ? 'AI 随手拍报修' : '填写表单报修',
      area: '报修',
      objectType: 'work_order',
      objectId: positiveInt(result?.workOrder?.id),
      detail: safeBusinessDetail(body, result),
    };
  }

  for (const rule of RULES) {
    if (rule.method !== verb) continue;
    const match = path.match(rule.pattern);
    if (!match) continue;
    return {
      code: rule.code,
      label: rule.label,
      area: rule.area,
      objectType: rule.objectType,
      objectId: positiveInt(match[1]) || resultObjectId(result),
      detail: safeBusinessDetail(body, result),
    };
  }

  const generic = verb === 'DELETE' ? '删除' : verb === 'POST' ? '新增/提交' : '修改';
  const firstSegment = path.split('/').filter(Boolean)[0] || 'business';
  const moduleLabel = FALLBACK_MODULE_LABELS[firstSegment] || '业务';
  const routeCode = path
    .split('/')
    .filter(Boolean)
    .map((part) => /^\d+$/.test(part) ? 'id' : part.replace(/[^a-zA-Z0-9]+/g, '_'))
    .join('_') || 'business';
  return {
    code: `${verb.toLowerCase()}_${routeCode}`.slice(0, 120),
    label: `${generic}${moduleLabel}`,
    area: moduleLabel,
    objectId: positiveInt(path.match(/\/(\d+)(?:\/|$)/)?.[1]),
    detail: safeBusinessDetail(body, result),
  };
}

const FALLBACK_MODULE_LABELS: Record<string, string> = {
  auth: '账号', notifications: '消息通知', upload: '附件', sign: '电子签字',
  platform: '租户管理', settings: '系统设置', properties: '基础档案', qr: '二维码',
  repair: '报修', reports: '报表', business: '业务数据',
};

export function normalizeBusinessPath(value: string) {
  const raw = String(value || '/').split('?')[0].replace(/\/+$/, '') || '/';
  return raw.replace(/^\/api\/v\d+/, '') || '/';
}

function safeBusinessDetail(body?: any, result?: any): Record<string, unknown> {
  const detail: Record<string, unknown> = {};
  const copy = (key: string) => {
    const value = body?.[key];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      detail[key] = typeof value === 'string' ? value.slice(0, 100) : value;
    }
  };
  [
    'communityId', 'buildingId', 'houseId', 'assigneeId', 'warehouseId',
    'materialId', 'repairType', 'entryMode', 'urgent', 'status',
  ].forEach(copy);
  if (Array.isArray(body?.items)) detail.itemCount = body.items.length;
  if (Array.isArray(body?.materials)) detail.materialCount = body.materials.length;
  const orderNo = result?.workOrder?.orderNo || result?.orderNo || result?.requestNo;
  if (orderNo) detail.businessNo = String(orderNo).slice(0, 80);
  return detail;
}

function resultObjectId(result: any) {
  return positiveInt(result?.id || result?.workOrder?.id || result?.request?.id);
}

function positiveInt(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}
