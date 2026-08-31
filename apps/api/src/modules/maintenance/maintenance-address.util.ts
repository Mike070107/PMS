/**
 * 养护单地址格的单位字（村 / 路 / 弄 / 号 / 室）是纸上预印好的，填进去的值就不能再带一遍。
 *
 * 房产库里 `houses.road_name` 存的是「永德路」，直接抄到纸上会印成「永德路 路」
 * （2026-08-31 线上第一张真单子上实拍到）。开单预填和保存时都过一道这个函数。
 */
export function stripAddrUnit(
  value: string | null | undefined,
  unit: string,
): string | null {
  const text = (value ?? '').trim();
  if (!text) return null;
  // 只剥结尾那一个字；剥完不能为空 —— 「村」这种孤零零一个字原样留着，让人自己改
  if (text.length > 1 && text.endsWith(unit)) return text.slice(0, -1).trim() || null;
  return text;
}
