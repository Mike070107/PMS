/**
 * 车位 2.5D 示意图的布局与状态计算（纯函数，不依赖 three，可直接单测）。
 *
 * 现状：车位档案只有车位号、车牌、房号、有效期，没有空间坐标，
 * 所以示意图按「车位号自然顺序」排成双排 + 车道；它是示意布局，
 * 不是现场实测的平面图。真实坐标以后由车位平面配置提供。
 */

export const BAY_W = 2.7;
export const BAY_D = 5.0;
/** 车位之间的缝隙（世界单位，米） */
export const BAY_GAP = 0.14;
/** 双排车位之间的车道宽度 */
export const AISLE_D = 6.0;
/** 一排车位 + 一条车道 = 一对车位的纵向进深 */
export const PAIR_PITCH = BAY_D * 2 + AISLE_D;

export type SpaceStatus = 'bound' | 'free' | 'expiring' | 'expired';

export interface GarageCell<T> {
  row: T;
  /** 自然排序后的全局序号 */
  index: number;
  col: number;
  rowIndex: number;
  /** 车位中心世界坐标（x 向右，z 向前/向入口） */
  x: number;
  z: number;
}

export interface GarageAisle {
  /** 车道起点 z（车道中心线 = zStart + depth / 2） */
  zStart: number;
  depth: number;
}

export interface GarageLayout<T> {
  cells: GarageCell<T>[];
  perRow: number;
  rowCount: number;
  /** 整排车位总宽（米） */
  width: number;
  /** 车库总进深（米） */
  depth: number;
  aisles: GarageAisle[];
  bayW: number;
  bayD: number;
}

/** 车位号自然排序：1、2、10 而不是 1、10、2；非数字部分按字典序兜底。 */
export function naturalCompare(a: string, b: string): number {
  const left = String(a ?? '');
  const right = String(b ?? '');
  const re = /(\d+|\D+)/g;
  const la = left.match(re) ?? [];
  const lb = right.match(re) ?? [];
  const len = Math.min(la.length, lb.length);
  for (let i = 0; i < len; i += 1) {
    const x = la[i];
    const y = lb[i];
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      const diff = Number(x) - Number(y);
      if (diff) return diff;
    } else if (x !== y) {
      return x.localeCompare(y, 'zh-Hans-CN');
    }
  }
  if (la.length !== lb.length) return la.length - lb.length;
  return left.localeCompare(right);
}

export interface GarageLayoutOptions {
  /** 指定每排车位数；不传时按总数自动取接近横屏构图的值 */
  perRow?: number;
}

/** 双排车位布局；total 决定每排车位数，让整块示意接近横屏构图。 */
export function layoutGarage<T extends { id: number; spaceNo: string }>(
  rows: T[],
  options: GarageLayoutOptions = {},
): GarageLayout<T> {
  const sorted = [...rows].sort((a, b) => naturalCompare(a.spaceNo, b.spaceNo) || a.id - b.id);
  const total = sorted.length;
  const preferred = Number.isFinite(options.perRow) && Number(options.perRow) > 0
    ? Math.round(Number(options.perRow))
    : 0;
  const perRow = total ? Math.max(4, preferred || Math.round(Math.sqrt(total) * 2)) : 1;
  const rowCount = total ? Math.ceil(total / perRow) : 0;
  const width = total ? perRow * BAY_W : 0;
  const pairCount = Math.ceil(rowCount / 2);
  const lastRowIndex = Math.max(0, rowCount - 1);
  const lastStart = Math.floor(lastRowIndex / 2) * PAIR_PITCH + (lastRowIndex % 2) * BAY_D;
  const depth = rowCount ? lastStart + BAY_D : 0;
  const zShift = -depth / 2;

  const cells: GarageCell<T>[] = sorted.map((row, index) => {
    const rowIndex = Math.floor(index / perRow);
    const col = index % perRow;
    const x = (col - (perRow - 1) / 2) * BAY_W;
    const zStart = Math.floor(rowIndex / 2) * PAIR_PITCH + (rowIndex % 2) * BAY_D;
    return { row, index, col, rowIndex, x, z: zStart + BAY_D / 2 + zShift };
  });

  const aisles: GarageAisle[] = [];
  for (let pair = 0; pair < pairCount - 1; pair += 1) {
    aisles.push({ zStart: pair * PAIR_PITCH + BAY_D * 2 + zShift, depth: AISLE_D });
  }

  return { cells, perRow, rowCount, width, depth, aisles, bayW: BAY_W, bayD: BAY_D };
}

/** 把 'YYYY-MM-DD' 或 ISO 时间串按自然日解析成本地时间零点；解析不了返回 null。 */
export function parseSpaceDate(value?: string | null): number | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value).trim());
  if (!match) return null;
  const time = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime();
  return Number.isFinite(time) ? time : null;
}

/** 车位展示状态：空位 / 已绑 / 7 天内到期 / 已过期。 */
export function spaceStatus(
  row: { plate?: string | null; endDate?: string | null },
  today: Date = new Date(),
): SpaceStatus {
  const plate = String(row.plate ?? '').trim();
  if (!plate) return 'free';
  const end = parseSpaceDate(row.endDate);
  if (end === null) return 'bound';
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (end < todayStart) return 'expired';
  if (end - todayStart <= 7 * 24 * 60 * 60 * 1000) return 'expiring';
  return 'bound';
}

/** 四个状态在示意图、图例、tooltip 里共用同一套文案和颜色。 */
export const STATUS_META: Record<SpaceStatus, { label: string; color: string; soft: string }> = {
  bound: { label: '已绑有效', color: '#3f6f9e', soft: 'rgba(63, 111, 158, .12)' },
  free: { label: '空车位', color: '#bfcbda', soft: 'rgba(191, 203, 218, .35)' },
  expiring: { label: '7 天内到期', color: '#bd8417', soft: 'rgba(189, 132, 23, .14)' },
  expired: { label: '已过期', color: '#bd352c', soft: 'rgba(189, 53, 44, .12)' },
};
