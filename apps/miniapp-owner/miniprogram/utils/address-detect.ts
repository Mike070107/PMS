/**
 * 描述文字里的报修地址识别 —— 判断口径的唯一出处，新增报修入口直接引这里
 * （目前接了：随手拍 quick-repair、一键报修 repair-create）。
 *
 * 为什么这样做：
 * - 端上只做「值不值得问服务端」的粗筛（描述里出现 期/弄/号 才发请求）；
 *   真正的识别在服务端拿本租户真实的分期/楼栋/房号来对
 *   （POST /repair-requests/parse-address），撞上库里存在的地址才算识别到，
 *   端上绝不自己猜地址。
 * - 识别结果必须明示给用户并可一键撤掉（点 ×），提交时 communityId/buildingId/
 *   houseId 要跟着识别结果一起换，不能只换显示文案。
 */
import { repairs } from '@pms/api-client';
import type { ParsedRepairAddress } from '@pms/api-client/src/endpoints/repairs';

/** 描述里疑似出现地址（一期 / 198弄 / 24号）才值得问服务端 */
export const ADDRESS_HINT_RE = /[0-9一二三四五六七八九十两]+\s*[期弄号]/;

/**
 * 这句话值不值得问服务端。
 *
 * 原来只看「数字 + 期/弄/号」，但公区点位（监控室、水泵房、门卫室）一个数字都没有，
 * 卡在这一步就永远认不出来 —— 后台登记了点位也白登记。所以放宽成：
 * 出现地址数字，**或者**话已经说到 5 个字（能提交的最短长度）。
 * 服务端撞不上库一律返回「没识别」，多问一次没有副作用，只是一个请求。
 */
export function shouldDetectAddress(text: string): boolean {
  const value = String(text || '').trim();
  return value.length >= 5 || ADDRESS_HINT_RE.test(value);
}

/** 地址没撞上时仍保留 AI 的语义草稿；调用方必须看 matched 决定能不能采用地址 */
export async function detectRepairAddress(
  text: string,
  communityId?: number,
): Promise<ParsedRepairAddress | null> {
  try {
    const res = await repairs.parseAddress({ text, communityId });
    return res.matched || res.ai ? res : null;
  } catch {
    return null;
  }
}

/**
 * 识别地址 + 用户补的「具体位置」拼成上门地址。
 * 服务端在没有室号时会缀「公共区域」占位；用户明说了具体在哪（大门/楼道），
 * 就用那句替掉占位，别拼出「…公共区域 大门」这种重复话。
 */
export function composeDetectedAddress(
  detected: ParsedRepairAddress,
  spotText = '',
): string {
  const base = detected.addressText || '';
  const spot = spotText.trim();
  if (!spot) return base;
  return `${base.replace(/ ?公共区域$/, '')} ${spot}`;
}
