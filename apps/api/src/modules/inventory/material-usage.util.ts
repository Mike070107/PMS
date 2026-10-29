/**
 * 材料SKU 的「已被使用」口径与编辑锁定规则（纯逻辑 + 查询清单，便于单测）。
 *
 * 一条 SKU 一旦被任何单据引用，名称/规格/单位/分类/参数就不能再改、SKU 也不能删：
 * 历史单据按 materialId 关联回来显示「这是什么料」，改了或删了，旧单就查不到/对不上。
 * 已使用时仍可改：参考价格（工单扣料扣的是库存批次成本，不受参考价影响）、图片、别名、启停用。
 */

export interface MaterialLike {
  name: string;
  spec: string | null;
  unit: string;
  category: string | null;
  params: string | null;
}

export interface MaterialEditInput {
  name?: string;
  spec?: string | null;
  unit?: string;
  category?: string | null;
  params?: string | null;
}

/** 已使用后锁定的栏位 */
export const LOCKED_WHEN_USED: Array<[keyof MaterialEditInput, string]> = [
  ['name', '名称'],
  ['spec', '规格型号'],
  ['unit', '单位'],
  ['category', '分类'],
  ['params', '参数'],
];

const norm = (v: unknown) => (typeof v === 'string' ? v.trim() : v ?? null) || null;

/** 这次编辑实际改动了哪些锁定栏位（改成同样的值不算） */
export function lockedChanges(current: MaterialLike, dto: MaterialEditInput): string[] {
  const out: string[] = [];
  for (const [key, label] of LOCKED_WHEN_USED) {
    if (dto[key] === undefined) continue;
    if (norm(dto[key]) !== norm(current[key])) out.push(label);
  }
  return out;
}

/** 有 material_id 列的表 */
export const MATERIAL_ID_TABLES: Array<[string, string]> = [
  ['stocks', '库存'],
  ['stock_lots', '入库批次'],
  ['stock_movements', '出入库流水'],
  ['work_order_materials', '工单用料'],
  ['stocktake_items', '盘点'],
  ['supplier_materials', '供应商报价'],
];

/** 明细存在 jsonb 数组里的表（元素带 materialId） */
export const MATERIAL_JSON_COLUMNS: Array<[string, string, string]> = [
  ['purchase_requests', 'items', '采购申请'],
  ['purchase_orders', 'items', '采购单'],
  ['transfer_orders', 'items', '调拨单'],
  ['work_orders', 'used_materials', '工单用料'],
  ['work_orders', 'missing_materials', '工单缺料'],
];

export function usageMessage(where: string[], action: 'delete' | 'edit', fields: string[] = []): string {
  const at = [...new Set(where)].join('、');
  return action === 'delete'
    ? `此SKU已被使用（${at}），不能删除；不再使用可以停用`
    : `此SKU已被使用（${at}），${fields.join('、')}不能修改；参考价格、图片、别名可以改`;
}
