/**
 * 员工端的三类身份，只在这里定义一次。
 *
 * 单独一个文件（不并进 session.ts）是为了 tabBar：它在 attached 里只读本地缓存的
 * 角色、**绝不能碰网络**，所以不该顺带 import 到 api-client 那条链上。
 * 这个文件不 import 任何东西，谁都能安全引。
 *
 * 「能不能点某个按钮」不看这里，看 session.ts 的权限矩阵 —— 这里只回答
 * 「这个人在物业里干哪一行」。
 */

/** 只报修、不接单也不派单：保安 / 居委会 / 业委会 / 物业工作人员 */
export const REPORTER_ROLES: string[] = [
  'guard',
  'neighborhood',
  'owner_committee',
  'property_staff',
];

/** 维修工：接单、完工、报缺料 */
export const TECHNICIAN_ROLE = 'technician';

/**
 * 办公室一侧：不接单，但要派单、管材料与库存。
 * 对他们来说「工单池」是待派单池而不是待接单池，「在手工单」永远是空的
 * （单不会派到自己头上），所以那一格换成「材料与库存」。
 */
export const DISPATCH_ROLES: string[] = ['office', 'manager', 'purchaser', 'admin'];

/** 干物业活的人（能看工单池），代报身份不在内 */
export const WORKER_ROLES: string[] = [TECHNICIAN_ROLE, ...DISPATCH_ROLES];

export const isTechnician = (role: string) => role === TECHNICIAN_ROLE;
export const isDispatcher = (role: string) => DISPATCH_ROLES.indexOf(role) >= 0;
export const isReporter = (role: string) => REPORTER_ROLES.indexOf(role) >= 0;
