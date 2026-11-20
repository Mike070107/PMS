import type { ParkingQueryRow } from '@pms/api-client/src/endpoints/access-card-issuance';
import { field, normPlate, vehicleIdentity } from './parking-fields';

interface Community { id: number; name: string }
interface Rule { id: number; name: string; config?: { vehicleClass?: string } | null }
const unique = <T,>(values: T[]) => [...new Set(values)];
const classKey = (value: string) => value.trim().replace(/[\s－—–-]/g, '').replace(/业主车/g, '住户车');

/** 只复用当前车牌的明确房屋归属，不用停车库来源猜所属小区。 */
export function renewalCommunity(plate: string, rows: ParkingQueryRow[], communities: Community[], initial?: number | null): number | null {
  if (initial != null && communities.some(c => c.id === initial)) return initial;
  const vehicleRows = rows.filter(r => normPlate(field(r.fields, 'plate')) === normPlate(plate));
  const ids = unique(vehicleRows.map(r => r.pmsMatch?.house?.communityId).filter((id): id is number => id != null));
  if (ids.length) return ids.length === 1 && communities.some(c => c.id === ids[0]) ? ids[0] : null;
  const lanes = unique(vehicleRows.map(r => /^(198|228)(?=[/弄-])/.exec(field(r.fields, 'room', true).trim())?.[1]).filter(Boolean));
  if (lanes.length) {
    if (lanes.length !== 1) return null;
    const name = lanes[0] === '198' ? '枫桦景苑一期' : '枫桦景苑二期';
    const matches = communities.filter(c => c.name === name);
    return matches.length === 1 ? matches[0].id : null;
  }
  return communities.length === 1 ? communities[0].id : null;
}

/** 收费分组优先于旧库宽泛身份；住户车不能直接猜成住户车-1/2/3。 */
export function renewalRule(plate: string, rows: ParkingQueryRow[], rules: Rule[], savedClass: string | null): number | null {
  if (savedClass === null) return null; // 分组尚未读到（或读取失败），不抢先试算。
  const one = (matches: Rule[]) => matches.length === 1 ? matches[0].id : null;
  if (savedClass.trim()) return one(rules.filter(r => classKey(r.config?.vehicleClass || r.name) === classKey(savedClass)));
  const raw = unique(rows.filter(r => normPlate(field(r.fields, 'plate')) === normPlate(plate))
    .map(r => field(r.fields, 'identity').trim()).filter(Boolean));
  if (raw.length !== 1) return null;
  const exact = rules.filter(r => classKey(r.config?.vehicleClass || r.name) === classKey(raw[0]));
  if (exact.length) return one(exact);
  const identity = vehicleIdentity(raw[0]);
  if (!['住户车', '租户车', '亲情车'].includes(identity)) return null;
  return one(rules.filter(r => vehicleIdentity(r.config?.vehicleClass || r.name) === identity));
}
