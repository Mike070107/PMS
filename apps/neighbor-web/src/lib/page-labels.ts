/** 使用统计的展示层名称；不改变埋点、路径、聚合或下钻参数。菜单来源：Shell.NAV 与两端 app/page.json。 */
export const WEB_PAGE_LABELS: Readonly<Record<string, string>> = {
  '/today': '今日工作', '/meters': '抄表管理', '/apartment': '公寓收费台', '/apartment-cashier': '公寓收费台',
  '/cashier': '收银台', '/vehicles': '车辆管理', '/access-cards': '门禁发卡', '/access-devices': '设备管理',
  '/plates': '车牌登记审核', '/family-cars': '亲情车管理', '/parking/main': '大车库车位', '/parking/civil': '人防车位',
  '/records': '办理记录', '/pending': '待处理', '/bills': '账单与待缴', '/work-orders': '工单调度', '/maint': '养护单',
  '/experience': '维修经验', '/purchase': '采购流程', '/stock': '库存', '/stocktakes': '盘点', '/materials': '材料SKU',
  '/devices': '系统与设备', '/reports': '收费报表', '/statistics': '统计汇总', '/screen': '收费大屏',
  '/screen-settings': '大屏设置', '/apartment-standards': '公寓收费标准', '/standards': '收费标准',
  '/houses': '房产', '/owners': '业主', '/staff': '员工与权限', '/offices': '管理处', '/settings': '系统设置',
  '/qr': '楼栋报修码', '/intranet': '内网应用', '/logs': '日志', '/fees': '物业费', '/login': '登录',
};
export const STAFF_PAGE_LABELS: Readonly<Record<string, string>> = {
  login: '员工登录', pool: '工单池 / 派单台', 'my-orders': '在手工单', 'order-detail': '工单详情',
  'repair-create': '报修', 'quick-repair': '语音报修', approvals: '采购审批 / 养护待办', 'purchase-request': '采购申请',
  inventory: '材料与库存', stocktake: '库存盘点', 'stocktake-count': '现场盘点', 'stocktake-review': '盘点确认',
  'material-inbound': '新增材料入库', meters: '抄表', 'meter-read': '拍照抄表', 'meter-detail': '仪表档案',
  'apartment-cashier': '公寓收费工作台', messages: '消息', feedback: '意见与建议', 'experience-notes': '经验本',
  'experience-note': '经验文档', 'maintenance-sign': '养护单查验签字', 'web-sign': '养护单查验',
  me: '我的 / 更多', 'web-login': '确认网页登录', 'external-access': '内网应用', index: '邻修工作台',
};
export const OWNER_PAGE_LABELS: Readonly<Record<string, string>> = {
  index: '首页', onboard: '完善入驻信息', 'quick-repair': 'AI随手拍报修', 'repair-create': '一键报修',
  messages: '消息', orders: '我的报修', 'order-detail': '工单详情', me: '我的', login: '邻修',
};

function text(value: unknown): string { return typeof value === 'string' ? value.trim() : ''; }
function knownLabel(value: string): string | undefined {
  const clean = value.split(/[?#]/)[0].replace(/\/+$/, '') || '/';
  const mini = /^\/(miniapp-staff|miniapp-owner)\/(?:pages\/)?([^/]+)(?:\/\2)?$/.exec(clean);
  if (mini) return (mini[1] === 'miniapp-staff' ? STAFF_PAGE_LABELS : OWNER_PAGE_LABELS)[mini[2]];
  // 只认完整路由；未知子路径不能碰瓷已知菜单。
  return WEB_PAGE_LABELS[clean];
}
/** 已知路径优先准确菜单名；未知路径可用服务端中文名，否则明确未知且保留可辨识原值。 */
export function usagePageLabel(path: unknown, name?: unknown): string {
  const rawPath = text(path), rawName = text(name);
  const known = knownLabel(rawPath) || knownLabel(rawName);
  if (known) return known;
  if (rawName && !/^\/?(?:miniapp-|pages\/)|^\/|^https?:\/\//.test(rawName) && /[\u3400-\u9fff]/.test(rawName)) return rawName;
  if (!rawPath && !rawName) return '未命名页面';
  return `未知页面（${rawPath || rawName}）`;
}
