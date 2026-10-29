/**
 * 停车目标目录：收费规则绑定其中一个（business_rules.config.parkingTarget），执行层据此把续期交给对应系统。
 * 对应关系经物业确认（2026-10-28）：
 *  - 德立云：枫桦景苑二期人防车库（德立云项目名「枫桦景苑」）、永南、永德、吴泾小区、吴泾一村、上海新家；
 *  - 本地停车库（现场助手执行）：枫桦景苑一期地面（parking1）、二期地面与二期大车库（parking2）；
 *  - 馨香臣寓各店停车费在旧公寓收费台收取，不在此目录；马桥店暂无停车系统。
 */
export type ParkingSystem = 'deliyun' | 'local';

export interface ParkingTarget {
  key: string;
  label: string;
  system: ParkingSystem;
  /** 德立云停车场名（与德立云 unitName 完全一致） */
  deliyunPark?: string;
  /** 本地停车库 */
  database?: 'parking1' | 'parking2';
  /** 本地库授权目标（见 docs/parking-management-design.md §3） */
  localTarget?: 'phase1_parking' | 'phase2_parking' | 'phase2_main_garage';
  /** 适用小区（PMS 小区名） */
  communities: string[];
  /** 收费主体 */
  billing: 'vehicle' | 'space';
  /** 前台按钮用的短名（一期地面 / 二期大车库…） */
  short?: string;
}

/** 枫桦景苑一期、二期是同一片停车场：两期住户都可以办任一车库（与亲情车一致） */
const FENGHUA = ['枫桦景苑一期', '枫桦景苑二期'];

export const PARKING_TARGETS: ParkingTarget[] = [
  { key: 'local:phase1_parking', label: '枫桦景苑一期 地面车库', system: 'local', database: 'parking1', localTarget: 'phase1_parking', communities: FENGHUA, billing: 'vehicle', short: '一期地面' },
  { key: 'local:phase2_parking', label: '枫桦景苑二期 地面车库', system: 'local', database: 'parking2', localTarget: 'phase2_parking', communities: FENGHUA, billing: 'vehicle', short: '二期地面' },
  { key: 'local:phase2_main_garage', label: '枫桦景苑二期 大车库', system: 'local', database: 'parking2', localTarget: 'phase2_main_garage', communities: FENGHUA, billing: 'space', short: '二期大车库' },
  { key: 'deliyun:枫桦景苑', label: '枫桦景苑二期 人防车库', system: 'deliyun', deliyunPark: '枫桦景苑', communities: FENGHUA, billing: 'vehicle', short: '二期人防车库' },
  { key: 'deliyun:上海永南小区', label: '永南小区', system: 'deliyun', deliyunPark: '上海永南小区', communities: ['永南140弄', '永南150弄', '永南5511弄'], billing: 'vehicle' },
  { key: 'deliyun:上海永德小区', label: '永德小区', system: 'deliyun', deliyunPark: '上海永德小区', communities: ['永北150弄', '永北5511弄'], billing: 'vehicle' },
  { key: 'deliyun:上海吴泾小区', label: '吴泾小区', system: 'deliyun', deliyunPark: '上海吴泾小区', communities: ['吴泾新村'], billing: 'vehicle' },
  { key: 'deliyun:吴泾一村', label: '吴泾一村', system: 'deliyun', deliyunPark: '吴泾一村', communities: ['吴泾一村'], billing: 'vehicle' },
  { key: 'deliyun:上海新家', label: '上海新家', system: 'deliyun', deliyunPark: '上海新家', communities: ['上海新家'], billing: 'vehicle' },
];

export function findParkingTarget(key: unknown): ParkingTarget | null {
  if (typeof key !== 'string') return null;
  return PARKING_TARGETS.find((t) => t.key === key) ?? null;
}

/** 规则配置校验：停车月租规则若绑定目标，目标必须存在且适用于规则所在小区 */
export function validateRuleTarget(input: { targetKey: unknown; communityName: string | null }): string | null {
  if (input.targetKey === undefined || input.targetKey === null || input.targetKey === '') return null;
  const target = findParkingTarget(input.targetKey);
  if (!target) return `不认识的停车目标：${String(input.targetKey)}`;
  if (!input.communityName) return '绑定停车目标的收费规则必须指定小区';
  if (!target.communities.includes(input.communityName)) {
    return `「${target.label}」不适用于小区「${input.communityName}」（适用：${target.communities.join('、')}）`;
  }
  return null;
}

/** 某小区可选的停车目标 */
export function targetsForCommunity(communityName: string | null): ParkingTarget[] {
  if (!communityName) return [];
  return PARKING_TARGETS.filter((t) => t.communities.includes(communityName));
}
