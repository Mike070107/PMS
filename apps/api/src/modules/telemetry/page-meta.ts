/** 后端维护的页面中文名与菜单 pageKey 映射；前端只展示接口返回的 name，不再各自维护一份。 */
export const PAGE_META: Record<string, { name: string; pageKey?: string }> = {
  '/today': { name: '今日工作' },
  '/work-orders': { name: '工单调度', pageKey: 'work-orders' },
  '/cashier': { name: '收银台', pageKey: 'business' },
  '/records': { name: '办理记录' },
  '/pending': { name: '待处理' },
  '/standards': { name: '收费标准' },
  '/houses': { name: '房产', pageKey: 'properties' },
  '/owners': { name: '业主', pageKey: 'properties' },
  '/experience': { name: '维修经验', pageKey: 'experience-notes' },
  '/apartment': { name: '公寓收费台', pageKey: 'apartment-cashier' },
  '/apartment-cashier': { name: '公寓收费台', pageKey: 'apartment-cashier' },
  '/meters': { name: '抄表管理', pageKey: 'meters' },
  '/fees': { name: '物业费', pageKey: 'fees' },
  '/parking/main': { name: '大车库车位' },
  '/parking/civil': { name: '人防车位' },
  '/reports': { name: '收费报表', pageKey: 'reports' },
  '/materials': { name: '材料SKU', pageKey: 'materials' },
  '/stocktakes': { name: '盘点', pageKey: 'stocktakes' },
  '/staff': { name: '员工与权限', pageKey: 'users' },
  '/offices': { name: '管理处', pageKey: 'offices' },
  '/qr': { name: '楼栋报修码', pageKey: 'qr' },
  '/intranet': { name: '内网应用' },
  '/logs': { name: '日志', pageKey: 'logs' },
  '/bills': { name: '账单与待缴', pageKey: 'bills' },
  '/maint': { name: '养护单', pageKey: 'maintenance-orders' },
  '/vehicles': { name: '车辆管理' },
  '/access-cards': { name: '门禁卡管理' },
  '/devices': { name: '系统与设备' },
  '/purchase': { name: '采购流程', pageKey: 'inventory' },
  '/stock': { name: '库存', pageKey: 'inventory' },
  '/settings': { name: '系统设置', pageKey: 'settings' },
  '/plates': { name: '车牌登记审核' },
  '/family-cars': { name: '亲情车管理', pageKey: 'family-cars' },
  '/screen': { name: '收费大屏', pageKey: 'fees' },
  '/screen-settings': { name: '大屏设置', pageKey: 'fees' },
};

export function pageName(path: string): string {
  return PAGE_META[path]?.name || path || '未命名页面';
}

export function pageKey(path: string, provided?: string | null): string | null {
  const explicit = String(provided ?? '').trim();
  if (explicit) return explicit.slice(0, 60);
  return PAGE_META[path]?.pageKey || null;
}
