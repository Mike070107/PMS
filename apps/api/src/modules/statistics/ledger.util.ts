/** P3-A 基础台账报表（房产汇总 / 住户台账 / 楼房台账）纯函数层。 */

/** 台账地址：路+弄+楼号+室号（与镜像收费明细 address 的拼接规则一致）。 */
export function ledgerAddress(
  road?: string | null,
  lane?: string | null,
  buildingNo?: string | null,
  roomNo?: string | null,
): string | null {
  const parts = [road, lane, buildingNo, roomNo].map((part) => (part ?? '').trim());
  if (parts.every((part) => !part)) return null;
  const [roadPart, lanePart, buildingPart, roomPart] = parts;
  return [
    roadPart,
    lanePart ? `${lanePart}弄` : '',
    buildingPart ? `${buildingPart}号` : '',
    roomPart,
  ].join('');
}

/** 自然数字顺序（楼栋/房号 1,2,3,10 而不是 1,10,2）。 */
export function naturalCompare(left?: string | null, right?: string | null): number {
  return (left ?? '').localeCompare(right ?? '', 'zh-CN', { numeric: true, sensitivity: 'base' });
}

/** 面积保留 2 位小数（镜像 numeric 可能在 JS 求和后出现浮点尾差）。 */
export function roundArea(value: number): number {
  return Math.round(Number(value || 0) * 100) / 100;
}

/** SQL ILIKE 参数：转义 %、_、\ 后由调用方拼 %kw%。 */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}
