/**
 * 停车库查询结果的字段解析 + 车库授权位解码。
 *
 * 旧 SQL Server 的列名又乱又有历史拼写（Sart_Time、Car_Beand…），
 * 这里照旧 parking 页的 fieldAliases 规则：大小写不敏感、去掉 [\s_-./]，
 * 先精确再子串；房号/电话/备注优先取 Owner__ 开头的连表列。
 * 车库授权藏在 P_Effective / P_Download 两串 256 位的 '0'/'1' 里，
 * 位号 = 通道号（1 起算，字符下标 = 通道-1）。通道映射三方一致：
 * 后端 garageBitsMatch、现场助手 GarageChannels、旧页面 garageRows。
 */
import type { ParkingQueryRow } from '@pms/api-client/src/endpoints/access-card-issuance';

type Fields = Record<string, string | number | boolean | null>;

const ALIASES = {
  plate: ['carno', 'carcode', 'carnumber', 'plateno', 'plate', 'license', '车牌'],
  room: ['ownername', 'roomno', 'owneradd', 'address', 'room', '房号', '地址'],
  phone: ['mobile', 'ownertel', 'ownerphone', '手机', '电话'],
  space: ['parkno', 'parkingno', 'spaceno', 'berth', 'garage', 'pspaces', '车位', '地库'],
  begin: ['stratime', 'sarttime', 'starttime', 'startdate', 'begindate'],
  expiry: ['enddate', 'expiredate', 'endtime', '到期', '有效期'],
  // 顺序即优先级：Car_Brand 是真正的“车辆授权类型”，Car_Lei 只是分类码(1/2)，放在后面
  identity: ['carbrand', 'carbeand', '车辆类型', '车辆身份', '身份', '性质', 'carlei'],
  note: ['pnote', 'remark', 'note', '备注'],
  effective: ['peffective'],
  download: ['pdownload'],
  ownerId: ['ownerid', '住户编号', '业主编号'],
} as const;

export type FieldGroup = keyof typeof ALIASES;

const norm = (s: string) => s.toLowerCase().replace(/[\s_\-./]/g, '');

/** 按别名组取值；房号/电话/备注这类连表列优先取 Owner__ 开头的 */
export function field(fields: Fields | undefined, group: FieldGroup, preferOwner = false): string {
  if (!fields) return '';
  const aliases = ALIASES[group] as readonly string[];
  const keys = Object.keys(fields).filter((k) => {
    const v = fields[k];
    return v !== null && v !== undefined && v !== '';
  });
  const matches = keys.filter((k) => {
    const nk = norm(k);
    return aliases.some((a) => nk === a || nk.includes(a));
  });
  if (!matches.length) return '';
  if (preferOwner) {
    const owned = matches.find((k) => norm(k).includes('owner'));
    if (owned) return String(fields[owned]);
  }
  return String(fields[matches[0]]);
}

/** 原始位串（不裁剪、不去空格），用于车库通道解码 */
export function rawBits(fields: Fields | undefined, group: 'effective' | 'download'): string {
  if (!fields) return '';
  const aliases = ALIASES[group] as readonly string[];
  const k = Object.keys(fields).find((key) => {
    const nk = norm(key);
    return aliases.some((a) => nk === a || nk.includes(a));
  });
  return k && typeof fields[k] === 'string' ? (fields[k] as string) : '';
}

/** 车辆授权类型：旧库 Car_Brand 归一 */
export function vehicleIdentity(raw: string): string {
  const s = (raw || '').toString();
  if (s.includes('亲情')) return '亲情车';
  if (s.includes('租')) return '租户车';
  if (s.includes('业主') || s.includes('住户')) return '住户车';
  return s ? `旧库车辆类型 ${s}` : '未标注';
}

/** 车辆类别固定配色；按可见类别而非旧库来源着色。 */
export function identityTone(value?: string | null): 'property' | 'ok' | 'acc' | 'warn' | 'mute' {
  const text = value || '';
  if (text.includes('产权')) return 'property';
  if (text.includes('亲情')) return 'acc';
  if (text.includes('租')) return 'warn';
  if (text.includes('住户') || text.includes('业主')) return 'ok';
  return 'mute';
}

export interface GarageDef {
  /** 依赖的车库：选它就必须同时选这个（二期大车库/人防都要过二期地面） */
  requires?: 'phase1' | 'phase2';
  key: 'phase1' | 'phase2' | 'main' | 'civil';
  label: string;
  db: 'parking1' | 'parking2' | 'deliyun';
  channels: number[];
}

/** 车库 → 通道映射（三方一致：phase1=5,7 / phase2=9,11,13 / main=15,17,19,21；人防在德立云不走位串） */
export const GARAGES: GarageDef[] = [
  { key: 'phase1', label: '一期地面车库', db: 'parking1', channels: [5, 7] },
  { key: 'phase2', label: '二期地面车库', db: 'parking2', channels: [9, 11, 13] },
  // 二期大车库 / 二期人防车库 都在二期小区里，进库必须先过二期地面入口，
  // 所以授权它们时二期地面必须一起授权（requires = 自动带上、且不能单独取消）
  { key: 'main', label: '二期大车库', db: 'parking2', channels: [15, 17, 19, 21], requires: 'phase2' },
  { key: 'civil', label: '二期人防车库', db: 'deliyun', channels: [], requires: 'phase2' },
];

const bitOn = (str: string, ch: number) => typeof str === 'string' && str.charAt(ch - 1) === '1';

export interface GarageState {
  authorized: boolean;
  downloaded: boolean;
  present: boolean; // 该车库所在库里有没有这条车牌记录
}

/** 单个车库在某车牌分组里的授权 / 下发状态 */
export function garageState(rows: ParkingQueryRow[], g: GarageDef): GarageState {
  if (g.key === 'civil') return { authorized: false, downloaded: false, present: false };
  const row = rows.find((r) => r.database === g.db);
  if (!row) return { authorized: false, downloaded: false, present: false };
  const eff = rawBits(row.fields, 'effective');
  const dl = rawBits(row.fields, 'download');
  const onChannels = g.channels.filter((c) => bitOn(eff, c));
  const authorized = onChannels.length > 0;
  const downloaded = authorized && onChannels.every((c) => bitOn(dl, c));
  return { authorized, downloaded, present: true };
}

/** 车牌归一：大写、去空格和分隔符，用于把 parking1 / parking2 同一车牌并成一组 */
export function normPlate(p: string): string {
  return (p || '').toString().toUpperCase().replace(/[\s·\-]/g, '');
}

export interface PlateGroup {
  plate: string;
  rows: ParkingQueryRow[];
}

/** 把查询结果按车牌分组（一张车牌可能同时在一期/二期库里） */
export function groupByPlate(rows: ParkingQueryRow[]): PlateGroup[] {
  const map = new Map<string, PlateGroup>();
  for (const r of rows) {
    const plate = field(r.fields, 'plate');
    const key = normPlate(plate) || `__row_${map.size}`;
    const g = map.get(key);
    if (g) g.rows.push(r);
    else map.set(key, { plate: plate || '（无车牌）', rows: [r] });
  }
  return [...map.values()];
}
