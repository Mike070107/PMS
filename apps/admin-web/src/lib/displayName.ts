/**
 * 「查不到名字时显示什么」—— 全后台只有这一份口径。
 *
 * 2026-09-01 反馈：采购申请单的申请信息里写着「申请人 #2」「来源工单 #19」「申请 ID #7」。
 * **id 是程序拿来定位的，用户不认识它**，写出来既看不懂也帮不上忙。规矩三条：
 *
 * 1. 人看的位置一律显示名字 / 单号；名字该由服务端随行下发，端上不要自己攒字典。
 * 2. 名字确实查不到时写「未知XX」，**不要用 `#id` 冒充一个名字** ——
 *    看到「未知材料」至少知道是数据缺了，看到「#37」只会以为系统坏了。
 * 3. id 只在两种地方出现：用户自己填过的编号（导入表里的房产编号），
 *    以及「一共几行」这种序号。除此之外不要往界面上放。
 */

/** 名字取不到时的统一兜底：`unknown('仓库')` → 「未知仓库」 */
export function unknown(kind: string): string {
  return `未知${kind}`;
}

/**
 * 一句话把「有名字用名字、没名字说未知」写完，省得每处都写一遍三元。
 * `nameOr(warehouseById.get(id)?.name, '仓库')`
 */
export function nameOr(name: string | null | undefined, kind: string): string {
  const trimmed = (name ?? '').trim();
  return trimmed || unknown(kind);
}
