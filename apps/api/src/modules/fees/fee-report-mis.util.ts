/**
 * 收费报表接入旧 MIS 镜像的映射与口径常量。
 *
 * 来源（Lead 2026-11-10 生产核实）：
 * - 01 枫桦景苑一期 → PMS community 1
 * - 02 枫桦景苑二期A + 03 枫桦景苑二期B → PMS community 2
 * - 04 上海新家 → PMS community 16
 * - 05 馨香北桥-二期：无镜像账单，不接
 * MIS 实收口径 = mis_mirror_bill 中 refund_date IS NULL 且 paid_date ∈ [from, to+1) 的 amount_cents。
 */
export interface MisOfficeMapping {
  officeCode: string;
  officeName: string;
  communityId: number;
  communityName: string;
}

export const MIS_OFFICE_MAPPINGS: MisOfficeMapping[] = [
  { officeCode: '01', officeName: '枫桦景苑一期', communityId: 1, communityName: '枫桦景苑一期' },
  { officeCode: '02', officeName: '枫桦景苑二期A', communityId: 2, communityName: '枫桦景苑二期' },
  { officeCode: '03', officeName: '枫桦景苑二期B', communityId: 2, communityName: '枫桦景苑二期' },
  { officeCode: '04', officeName: '上海新家', communityId: 16, communityName: '上海新家' },
];

/** MIS 行的小区列 label：管理处名（旧系统）。 */
export function misOfficeLabel(officeCode: string): string {
  const mapping = MIS_OFFICE_MAPPINGS.find((row) => row.officeCode === officeCode);
  return mapping ? `${mapping.officeName}（旧系统）` : `管理处${officeCode}（旧系统）`;
}

/** 本次请求可返回的 MIS 管理处（按数据范围 + communityId 过滤）。 */
export function misOfficesForScope(scope: number[] | null, communityId?: number): MisOfficeMapping[] {
  let mappings = MIS_OFFICE_MAPPINGS.filter((mapping) => !scope || scope.includes(mapping.communityId));
  if (communityId) mappings = mappings.filter((mapping) => mapping.communityId === communityId);
  return mappings;
}

/** 管理处 → PMS communityId。 */
export function misOfficeCommunityId(officeCode: string): number | null {
  return MIS_OFFICE_MAPPINGS.find((row) => row.officeCode === officeCode)?.communityId ?? null;
}

/** 空收款方式/收款人统一显示「未记录」（与 MIS 报表口径一致）。 */
export const MIS_UNRECORDED = '未记录';

export function misLabel(value?: string | null): string {
  return (value ?? '').trim() || MIS_UNRECORDED;
}
