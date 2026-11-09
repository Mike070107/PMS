/** P4-A 减免/签报统计报表常量。 */

export const SIGNOFF_STATUSES = ['all', 'effective', 'voided', 'open'] as const;
export type SignoffStatus = (typeof SIGNOFF_STATUSES)[number];

export const MISC_REPORT_UNAVAILABLE_MESSAGE =
  'MIS 票据/签报镜像尚未同步，请管理员先执行镜像重灌后再查看该报表';
