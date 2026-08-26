/**
 * 角色相关的展示文案，后台只此一份。
 *
 * 2026-08-26 业务身份与后台角色合并：后台只剩「角色」一个概念，角色自带业务身份
 * （roles.business_role），用户管理页因此只选角色、不再单独选身份。
 * 角色管理页和用户管理页都要把「选了这个身份，他在小程序里能干什么」讲清楚，
 * 两边各抄一份必然走样（此前 admin 的显示名就在两处写得不一样，导致给管理处
 * 建负责人时误选了企业超管），所以标签、颜色、说明都收在这里，新入口直接引这份。
 */
import { REPORTER_ROLES, UserRole } from '@pms/shared-types';

/**
 * admin 的显示名必须叫全称：之前写成「物业管理员」，导致给管理处建负责人时
 * 误选了它 —— 而业务身份 admin 按设计直通全公司、无视数据范围。
 */
export const roleLabel: Record<string, string> = {
  technician: '维修工',
  office: '物业办公室',
  manager: '物业经理',
  purchaser: '采购经理',
  admin: '企业超级管理员（全公司）',
  guard: '保安',
  neighborhood: '居委会',
  owner_committee: '业委会',
  property_staff: '物业工作人员',
};

export const roleColor: Record<string, string> = {
  technician: 'blue',
  office: 'cyan',
  manager: 'gold',
  purchaser: 'magenta',
  admin: 'red',
  guard: 'geekblue',
  neighborhood: 'green',
  owner_committee: 'purple',
  property_staff: 'orange',
};

/**
 * 选了这个身份，他在员工端小程序里看到什么 —— 配角色的人未必装过小程序，
 * 不写出来就只能靠猜（底部 tab 正是按身份变的）。
 */
export const identityHint: Record<string, string> = {
  technician: '员工端：工单池接单、完工、报缺料。',
  office: '员工端：派单台、材料与库存。',
  manager: '员工端：派单台、材料与库存、采购审批。',
  purchaser: '员工端：派单台、材料与库存、采购审批。',
  admin: '员工端功能同办公室，后台权限直通全公司。',
  guard: '员工端：只能替住户报修。',
  neighborhood: '员工端：只能替住户报修。',
  owner_committee: '员工端：只能替住户报修。',
  property_staff: '员工端：只能替住户报修。',
};

/**
 * 代报角色：登记后由本人在员工端小程序用微信手机号认领，不发后台账号。
 * 四个角色要写全 —— 漏掉 PROPERTY_STAFF 时，物业工作人员那行的角色标签会露出
 * 枚举原文，编辑时也不给「可代报的小区」，等于建了个报不了修的账号。
 */
export const REPORTER_ROLE_SET = new Set<string>(REPORTER_ROLES);

export const isReporterRole = (role?: string | null) =>
  !!role && REPORTER_ROLE_SET.has(role);

export const isAdminIdentity = (role?: string | null) => role === UserRole.ADMIN;

/**
 * 角色在下拉/标签里怎么显示：角色名打头，只在「看不出它属于哪一类」时补类型。
 *
 * 直接拼 `${name}（${roleLabel[type]}）` 会拼出「维修工（维修工）」，
 * admin 更惨 —— 角色名「企业超级管理员」配标签「企业超级管理员（全公司）」，
 * 拼成「企业超级管理员（企业超级管理员（全公司））」。所以要判包含关系。
 */
export function roleOptionLabel(
  name: string,
  businessRole?: string | null,
  opts: { unavailable?: boolean } = {},
) {
  const suffix = opts.unavailable ? ' · 已停用' : '';
  if (!businessRole) return `${name}（仅后台）${suffix}`;
  const type = roleLabel[businessRole] ?? businessRole;
  if (type === name) return `${name}${suffix}`;
  // 「企业超级管理员」这种角色名是类型名的前缀：显示更完整的那个（带「（全公司）」）
  if (type.startsWith(name)) return `${type}${suffix}`;
  // 「保安组长」已经能看出是保安一类：显示角色名本身，别压成「保安」把「组长」弄丢
  if (name.includes(type)) return `${name}${suffix}`;
  return `${name}（${type}）${suffix}`;
}
