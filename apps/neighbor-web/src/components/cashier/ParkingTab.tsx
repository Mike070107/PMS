import { useContext, useId } from 'react';
import { ChargeAttempted } from './charge-validation';
import { moneyInputProps } from '@/lib/money-input';
import RegistrationPermit from './RegistrationPermit';
import DateInput from '@/components/DateInput';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { accessCardIssuance, request } from '@pms/api-client';
import VehicleActions from '../vehicle-ops/VehicleActions';
import type { DeliyunVehicle, ParkingQuery } from '@pms/api-client/src/endpoints/access-card-issuance';
import Icon from '@/components/Icon';
import { dayjs, money } from '@/lib/format';
import { field as fieldOf, vehicleIdentity, identityTone, deliyunVehicleIdentity as deliyunIdentity } from '@/lib/parking-fields';
import NewPlateCard, { canEnterVehicleDetails, type Intake } from './NewPlateCard';
import VehicleClassChoices from './VehicleClassChoices';
import RenewalMonths from './RenewalMonths';
import { Sheet } from '@/components/ui';
import { vehicleIntakeOperation } from '@/lib/vehicle-intake-operation';



/** 旧库车辆身份：列名有 Car_Brand / Car_Beand / CarLei / 车辆类型 多种写法，走别名组读 */
const identityOf = (f: Record<string, unknown>): string | null => {
  const raw = fieldOf(f as never, 'identity');
  return raw ? vehicleIdentity(raw) : null;
};

/* ───── 类型 ───── */
export interface ParkRule { id: number; serviceType: string; name: string; communityId: number | null; unitPriceCents: number; enabled: boolean; config?: { parkingTarget?: string; parkingTargets?: string[]; vehicleClass?: string; isDefault?: boolean; priceMode?: 'table' | 'monthly'; tiers?: Array<{ months: number; amountCents: number }> } | null }
export interface ParkTarget { key: string; label: string; short?: string; system: 'deliyun' | 'local'; billing: 'vehicle' | 'space'; deliyunPark?: string; database?: string }
export interface ParkHouse { id: number; communityId: number | null; lane?: string | null; buildingNo: string; roomNo: string; communityName?: string | null; owner?: { id: number; name?: string | null; phone?: string | null } | null }
export type SystemRef =
  | { kind: 'local'; database: 'parking1' | 'parking2'; sourceRecordId: string; previousEndDate: string | null; label: string }
  | { kind: 'deliyun'; park: string; label: string };
interface Estimate { unitPriceCents: number; quantity: number; startDate: string | null; endDate: string | null; amountCents: number; standardAmountCents?: number | null; requiresReview?: boolean; summary: string; breakdown?: string; vehicleClass?: string | null }

/** 一辆车在某套停车系统里的一条登记 */
interface Lot {
  key: string; system: 'local' | 'deliyun'; label: string; targetKey: string | null;
  space: string | null; spaceFromNote: boolean; endDate: string | null; garages: string[];
  ref: SystemRef;
}
export interface Car { rows?: ParkingQuery['rows']; plate: string; identity: string | null; lots: Lot[]; mismatch?: { dates: string[]; latest: string } | null }
export type { Lot };

export interface ParkingCart {
  plate: string; rule: ParkRule; months: number; currentEndDate: string | null;
  estimate: Estimate; systems: SystemRef[]; systemsLabel: string;
  /** 新办车牌：扫码登记单编号（车牌由业主填，可能还没填） */
  intakeId?: number;
  /** 非标准续期：自定起止日期 + 手填实收金额，提交后等物业经理审核 */
  custom?: { startDate: string; endDate: string; manualAmountCents: number; reason: string; standardAmountCents: number | null } | null;
}

interface DeliyunRow { id: string; plate: string; parkingSpace?: string | null; cardNo: string | null; cardType: string | null; endDate: string | null; garageNames: string[]; civilDefenseAuthorized: boolean; cardPoolId: string | null }
interface Household {
  boundPlates?: string[];
  room: string; roomTerm: string | null; targets: ParkTarget[]; localDatabases: string[];
  deliyun: Array<{ targetKey: string; label: string; park: string; ok: boolean; error: string | null; rows: DeliyunRow[] }>;
}

/* ───── 工具 ───── */
/** 业主手机填写页的地址（和当前前端同源，部署在哪个子路径都对） */
export const formBase = () => `${window.location.origin}${import.meta.env.BASE_URL.replace(/\/+$/, '')}/m/plate`;
const normPlate = (p: string) => (p || '').replace(/[\s·.．・]/g, '').toUpperCase();
const day = (v: unknown) => { const s = String(v ?? '').trim(); return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null; };
const roomKey = (v: string) => {
  const parts = (v || '').trim().split(/[/\-－—\s]+/).filter(Boolean).map((p) => p.replace(/^0+(?=\d)/, ''));
  return parts.length >= 2 ? parts.slice(-3).join('/') : '';
};
const sameRoom = (a: string, b: string) => {
  const x = roomKey(a); const y = roomKey(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const xs = x.split('/'); const ys = y.split('/');
  return xs.length !== ys.length && xs.slice(-2).join('/') === ys.slice(-2).join('/');
};
const field = (f: Record<string, unknown>, re: RegExp) => {
  const k = Object.keys(f).find((x) => re.test(x));
  const v = k ? f[k] : null;
  return v === null || v === undefined || String(v).trim() === '' ? null : String(v).trim();
};
/** 旧库 P_Effective：256 位，第 n 位为 1 = 通道 n 已授权（与旧停车页同一套映射） */
const channels = (bits: string | null) => (bits ? Array.from(bits).flatMap((b, i) => (b === '1' ? [i + 1] : [])) : []);
function localGarages(database: string, effective: string | null): Array<{ label: string; targetKey: string }> {
  const on = channels(effective);
  const has = (cs: number[]) => cs.some((c) => on.includes(c));
  if (database === 'parking1') return has([5, 7]) ? [{ label: '一期地面车库', targetKey: 'local:phase1_parking' }] : [];
  const out: Array<{ label: string; targetKey: string }> = [];
  if (has([9, 11, 13])) out.push({ label: '二期地面车库', targetKey: 'local:phase2_parking' });
  if (has([15, 17, 19, 21])) out.push({ label: '二期大车库', targetKey: 'local:phase2_main_garage' });
  return out;
}
const spaceFromNote = (note: string | null) => {
  const m = (note || '').match(/(?:民防|人防|地库|大车库)?\s*([A-Za-z]?\d{1,4}[A-Za-z]?)\s*号?\s*车位/);
  return m ? m[1] : null;
};
const expired = (d: string | null) => !d || dayjs(d).isBefore(dayjs(), 'day');
const PAY_EN: Record<string, string> = { 现金: 'cash', 微信: 'wechat', 支付宝: 'alipay', 银行转账: 'bank', 转账: 'bank' };
export const payCode = (label: string) => PAY_EN[label] || (/微信|wechat/i.test(label) ? 'wechat' : /支付宝|alipay/i.test(label) ? 'alipay' : /现金|cash/i.test(label) ? 'cash' : /银行|转账|bank/i.test(label) ? 'bank' : 'other');

/**
 * 停车缴费：选中住户即查出这一户在各停车系统登记的车（车牌、车库、车位号、有效期），
 * 前台点一辆车、选月数，按收费标准算钱；收款后执行层把同一辆车在各系统的有效期一起续上。
 */
/** Deep-link integration: Cashier passes focusedIntake={linkedIntake}; keep ordinary household checkout unchanged. */
export default function ParkingTab({ house, rules, onCart, initialPlate, selectedVehicle, focusedIntake, staffRegistration = false, onIntakeChange }: { house: ParkHouse; rules: ParkRule[]; onCart: (items: ParkingCart[], ready: boolean) => void; initialPlate?: string | null; selectedVehicle?: { plateNo: string; houseId: number | null }; focusedIntake?: Intake; staffRegistration?: boolean; onIntakeChange?: (intake: Intake) => void }) {
  const [hh, setHh] = useState<Household | null>(null);
  const [hhErr, setHhErr] = useState('');
  const [local, setLocal] = useState<{ state: 'idle' | 'loading' | 'done' | 'failed'; rows: ParkingQuery['rows']; error?: string }>({ state: 'idle', rows: [] });
  const [picked, setPicked] = useState<string[]>([]);
  // 按车牌查到的旧库记录：房号写错（如 198-36-401朋友）也能带出来，旧页就是这么查的
  const [plateRows, setPlateRows] = useState<ParkingQuery['rows']>([]);
  // 房号文本（弄/号/室），hh 没回来也能直接查旧库
  const roomTermOf = (h: ParkHouse) => [h.lane, h.buildingNo, h.roomNo].filter(Boolean).join('/');
  const [missPlate, setMissPlate] = useState('');
  const [carts, setCarts] = useState<Record<string, ParkingCart | null>>({});
  const [lookupDone, setLookupDone] = useState(false);
  const [reload, setReload] = useState(0);
  // 新办车牌 / 亲情车：这一户还没办完的扫码登记
  const [intakes, setIntakes] = useState<Intake[]>([]);
  const [newBusy, setNewBusy] = useState(false);
  const [newErr, setNewErr] = useState('');
  const [entryKind, setEntryKind] = useState<'paid' | 'family' | null>(null);
  const creatingIntake = useRef(false);
  useEffect(() => {
    let alive = true;
    setIntakes([]); setNewErr('');
    // A deep link is one registration, not every unpaid registration in the house.
    // The parent already resolved this exact ID against the authorized address tree.
    if (focusedIntake) {
      if (focusedIntake.houseId !== house.id) setNewErr('本次登记与所选住户不一致，不能收费');
      else setIntakes([focusedIntake]);
    } else {
      request<Intake[]>({ url: '/vehicle-intakes', query: { houseId: house.id, open: '1' } })
        .then((r) => { if (alive) setIntakes(r); })
        .catch((e) => { if (alive) setNewErr(e instanceof Error ? e.message : '读取新办登记失败，请重试'); });
    }
    return () => { alive = false; };
  }, [house.id, focusedIntake]);
  // 车牌分类（业主车 / 租客车 …）：决定续期按哪套收费标准
  const [tags, setTags] = useState<Record<string, string>>({});
  const setTag = useCallback(async (plate: string, cls: string) => {
    await request({ method: 'POST', url: '/business/plate-tags', data: { plate, vehicleClass: cls, houseId: house.id } });
    setTags((t) => ({ ...t, [plate]: cls }));
  }, [house.id]);
  const [selectedEntry, setSelectedEntry] = useState<{ id: number; staff: boolean } | null>(null);
  const createIntake = async (kind: 'paid' | 'family', anotherVehicle = false, staff = true) => {
    if (creatingIntake.current) return;
    creatingIntake.current = true; setNewBusy(true); setNewErr('');
    try {
      const operation = vehicleIntakeOperation(house.id, kind, anotherVehicle);
      const r = await request<Intake>({ method: 'POST', url: '/vehicle-intakes', data: { houseId: house.id, kind, formBase: formBase(), operationKey: operation.operationKey, anotherVehicle: operation.anotherVehicle } });
      operation.resolve();
      setIntakes((l) => [r, ...l.filter(i => i.id !== r.id)]);
      setSelectedEntry({ id: r.id, staff });
      setEntryKind(null);
    } catch (e) { setNewErr(e instanceof Error ? e.message : '生成失败，重试将继续原操作'); }
    finally { creatingIntake.current = false; setNewBusy(false); }
  };

  // 选中住户 → 查德立云（服务端）+ 发起本地旧库查询（现场助手）
  useEffect(() => {
    let alive = true;
    setLookupDone(false); setMissPlate('');
    setHh(null); setHhErr(''); setLocal({ state: 'idle', rows: [] }); setPlateRows([]); setPicked([]); setCarts({}); onCart([], false);
    // 德立云（household-parking）可能十几秒；本地旧库查询不依赖它，先发出去，谁先回谁先显示
    const household = request<Household>({ url: '/business/household-parking', query: { houseId: house.id }, timeout: 40000 })
      .then((r) => { if (alive) setHh(r); return r; })
      .catch((e) => { if (alive) setHhErr(e instanceof Error ? e.message : '查询失败'); });
    void (async () => {
      {
        setLocal({ state: 'loading', rows: [] });
        try {
          // 房号查询和按车牌查询并发发起、轮询间隔 500ms（旧页一圈就出结果，慢在等和串行）
          const poll = async (term: string) => {
            let q = await accessCardIssuance.createParkingQuery(term);
            for (let i = 0; i < 80 && alive && (q.status === 'pending' || q.status === 'running'); i += 1) {
              await new Promise((ok) => { window.setTimeout(ok, 500); });
              if (!alive) return q;
              q = await accessCardIssuance.parkingQuery(q.id);
            }
            return q;
          };
          // 两路各回各显示：按车牌那条先回来就先出这辆车，房号那条回来再补本户其它车
          const queried = new Set<string>();
          async function queryPlate(value: string) {
            const plate = normPlate(value);
            if (!plate || queried.has(plate) || !alive) return;
            queried.add(plate);
            const result = await poll(plate);
            if (!alive) return;
            if (result.status !== 'completed') throw new Error(result.error || '车牌查询未完成，请重查');
            const exact = result.rows.filter(row => normPlate(field(row.fields, /^p_plate$/i) || '') === plate);
            setPlateRows(rows => [...rows, ...exact]);
          }
          const room = roomTermOf(house);
          const roomJob = /^\d+(?:\/\d+){1,2}$/.test(room) ? poll(room).then(result => {
            if (!alive) return;
            if (result.status !== 'completed') throw new Error(result.error || '现场停车库查询未完成，请重查');
            setLocal({ state: 'done', rows: result.rows });
          }) : Promise.resolve();
          const boundJob = household.then(async data => {
            if (!data?.localDatabases.length) return;
            for (const plate of data.boundPlates || []) await queryPlate(plate);
          });
          const outcomes = await Promise.allSettled([roomJob, boundJob, initialPlate ? queryPlate(initialPlate) : Promise.resolve()]);
          if (!alive) return;
          const failed = outcomes.find(o => o.status === 'rejected');
          if (failed?.status === 'rejected') setLocal(prev => ({ ...prev, state: 'failed', error: String(failed.reason?.message || '车牌查询失败') }));
          else { setLocal(prev => ({ ...prev, state: 'done' })); setLookupDone(true); }
        } catch (e) { if (alive) setLocal({ state: 'failed', rows: [], error: e instanceof Error ? e.message : '现场库查询失败' }); }
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [house.id, initialPlate, reload]);

  // 合并成「一辆车 → 多套系统里的登记」
  const cars = useMemo<Car[]>(() => {
    if (!hh && !local.rows.length && !plateRows.length) return [];
    const map = new Map<string, Car>();
    const car = (p: string, identity: string | null) => {
      const k = normPlate(p);
      if (!map.has(k)) map.set(k, { plate: k, identity, lots: [] });
      const c = map.get(k)!;
      if (!c.identity && identity) c.identity = identity;
      return c;
    };
    const bound = new Set((hh?.boundPlates || []).map(normPlate));
    for (const plate of bound) car(plate, null);
    const seenRecord = new Set<string>();
    for (const row of [...local.rows, ...plateRows]) {
      const db = String(row.database || '').toLowerCase();
      // 房号那路和车牌那路会各带回同一条旧库记录 → 按 库+主键 去重，否则「一期地面车库」显示两遍
      const recKey = `${db}:${String((row.fields as Record<string, unknown>).P_id ?? '')}`;
      if (seenRecord.has(recKey)) continue;
      if (hh && !hh.localDatabases.includes(db)) continue;
      const f = row.fields as Record<string, unknown>;
      const owner = field(f, /^owner__owner_name$/i) || field(f, /owner_?name|room|addr/i) || '';
      const p = field(f, /^p_plate$/i) || field(f, /plate|carno/i);
      if (!p) continue;
      const exactSelection = hh?.localDatabases.includes(db) && selectedVehicle?.houseId === house.id && !!initialPlate &&
        normPlate(selectedVehicle.plateNo) === normPlate(initialPlate) && normPlate(p) === normPlate(initialPlate) && plateRows.includes(row);
      if (!exactSelection && !(bound.has(normPlate(p)) && plateRows.includes(row)) && !sameRoom(owner, roomTermOf(house))) continue;
      seenRecord.add(recKey);
      const note = field(f, /^p_note$/i);
      const spaceCol = field(f, /^p_spaces?$/i) || field(f, /parkno|spaceno|berth/i);
      const garages = localGarages(db, field(f, /^p_effective$/i));
      const main = garages.find((g) => g.targetKey === 'local:phase2_main_garage');
      const target = main ?? garages[0] ?? null;
      const end = day(field(f, /^end_time$/i) || field(f, /end|expire/i));
      const label = garages.length ? garages.map((g) => g.label).join('、') : db === 'parking1' ? '一期停车库（未授权车库）' : '二期停车库（未授权车库）';
      const record = car(p, identityOf(f));
      (record.rows ??= []).push(row);
      record.lots.push({
        key: `local:${db}:${field(f, /^p_id$/i)}`, system: 'local', label, targetKey: target?.targetKey ?? (db === 'parking1' ? 'local:phase1_parking' : 'local:phase2_parking'),
        space: spaceCol || spaceFromNote(note), spaceFromNote: !spaceCol && !!spaceFromNote(note), endDate: end, garages: garages.map((g) => g.label),
        ref: { kind: 'local', database: db as 'parking1' | 'parking2', sourceRecordId: String(field(f, /^p_id$/i) || ''), previousEndDate: end, label },
      });
    }
    for (const d of hh?.deliyun ?? []) {
      for (const r of d.rows) {
        car(r.plate, deliyunIdentity(r)).lots.push({
          key: `deliyun:${d.park}:${r.id}`, system: 'deliyun', label: d.label, targetKey: d.targetKey,
          space: r.parkingSpace || r.cardNo || null, spaceFromNote: false, endDate: day(r.endDate), garages: r.garageNames || [],
          ref: { kind: 'deliyun', park: d.park, label: d.label },
        });
      }
    }
    return [...map.values()].sort((a, b) => a.plate.localeCompare(b.plate));
  }, [hh, local.rows, plateRows, house, initialPlate, selectedVehicle]);

  useEffect(() => {
    if (!cars.length) return;
    let active = true;
    request<Array<{ plate: string; vehicleClass: string }>>({ url: '/business/plate-tags', query: { plates: cars.map((c) => c.plate).join(',') } })
      .then((r) => { if (active) setTags(Object.fromEntries(r.map(x => [x.plate, x.vehicleClass]))); }).catch(() => undefined);
    return () => { active = false; };
  }, [cars.map((c) => c.plate).join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  // 只有一辆车时默认勾上；多辆车让前台自己勾（可多选，一次收几辆车的款）
  useEffect(() => {
    if (picked.length) return;
    // 从收银台统一查询框按车牌点进来时，直接选中这辆车
    // 综合查询点过来的车牌：先按归一化（去空格/统一大写）找，别用全等判断
    const want = (initialPlate ?? '').replace(/\s/g, '').toUpperCase();
    if (want) {
      const hit = cars.find((c) => c.plate.replace(/\s/g, '').toUpperCase() === want);
      if (hit?.lots.length) { setMissPlate(''); setPicked([hit.plate]); return; }
      // 找不到就不要替用户选别的车——否则页面显示的是另一块牌，看着像选错了
      setMissPlate(lookupDone && !hhErr && !hit ? initialPlate ?? '' : '');
      setPicked([]);
      return;
    }
    setMissPlate('');
    if (cars.length === 1 && cars[0].lots.length) setPicked([cars[0].plate]);
  }, [cars, initialPlate, lookupDone, hhErr]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = (pl: string) => setPicked((p) => (p.includes(pl) ? p.filter((x) => x !== pl) : [...p, pl]));
  const setCart = useCallback((pl: string, c: ParkingCart | null) => setCarts((m) => (m[pl] === c ? m : { ...m, [pl]: c })), []);
  // 要一起收款的新办车牌（付费、还没收过款、没作废）
  const chargeKeys = intakes.filter((i) => i.kind === 'paid' && !i.transaction && i.status !== 'void').map((i) => `新办#${i.id}`);
  useEffect(() => {
    const keys = [...(focusedIntake ? [] : picked), ...chargeKeys];
    const items = keys.map((pl) => carts[pl]).filter((c): c is ParkingCart => !!c);
    onCart(items, keys.length > 0 && items.length === keys.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picked, carts, chargeKeys.join(','), focusedIntake?.id]);
  const updateIntake = useCallback((x: Intake) => { setIntakes((l) => l.map((i) => (i.id === x.id ? x : i))); onIntakeChange?.(x); }, [onIntakeChange]);
  const dropIntake = useCallback((id: number) => { setIntakes((l) => l.filter((i) => i.id !== id)); setCart(`新办#${id}`, null); }, [setCart]);
  const pickedCars = cars.filter((c) => picked.includes(c.plate));
  const allOn = cars.length > 0 && cars.every((c) => picked.includes(c.plate));

  /* ───── 渲染 ───── */
  const deliyunFails = hh?.deliyun.filter((d) => !d.ok) ?? [];
  const loadingAny = !hh || local.state === 'loading';
  const noSystem = hh && !hh.targets.length;

  return (
    <div className="parking-household" style={{ marginTop: 16 }}>
      {focusedIntake ? staffRegistration ? null : <div className="note2">仅处理本次新办登记 #{focusedIntake.id}，同户其他登记及续费车辆不参与本次收款。</div> : <>
      <div className="panelHd">
        <b>这一户的车</b>
      {missPlate ? (
        <div className="note2" style={{ background: 'var(--warn-w)', color: 'var(--warn)', marginBottom: 8 }}>
          <Icon name="alert" />{missPlate} 尚未匹配到可续费的停车记录。
        </div>
      ) : null}        <span className="tag mute">{hh ? (hh.targets.length ? hh.targets.map((t) => t.label).join(' · ') : '本小区未接停车系统') : '查询中'}</span>
        <button className="btn g sm" style={{ marginLeft: 'auto' }} disabled={loadingAny} onClick={() => setReload((n) => n + 1)}><Icon name="refresh" size={14} />重查</button>
      </div>

      {hhErr ? <div className="note2" style={{ color: 'var(--dang)' }}><Icon name="alert" />车辆查询失败：{hhErr}</div> : null}
      {deliyunFails.map((d) => <div key={d.park} className="note2" style={{ color: 'var(--dang)', marginBottom: 6 }}><Icon name="alert" />{d.label}（德立云）没查成：{d.error}。不代表没有车，请点「重查」。</div>)}
      {local.state === 'failed' ? <div className="note2" style={{ color: 'var(--dang)', marginBottom: 6 }}><Icon name="alert" />本地停车库没查成：{local.error}。不代表没有车。</div> : null}

      <div className="card parking-table-scroll" role="region" aria-label="这一户的车辆列表，可左右滚动查看" tabIndex={0}>
        <table className="tbl park-tbl">
          <thead><tr><th style={{ width: 40 }}>{cars.length > 1 ? <input type="checkbox" className="ck-lg" checked={allOn} onChange={() => setPicked(allOn ? [] : cars.map((c) => c.plate))} title="全选" /> : null}</th><th>车牌</th><th>车辆类别</th><th>停车场 / 车库</th><th>车位号</th><th>有效期至</th><th>状态</th></tr></thead>
          <tbody>
            {cars.map((c) => {
              const on = picked.includes(c.plate);
              const minEnd = c.lots.map((l) => l.endDate).filter(Boolean).sort()[0] ?? null;
              return (
                <tr key={c.plate} className={on ? 'sel' : ''} onClick={() => c.lots.length && toggle(c.plate)}>
                  <td><input type="checkbox" className="ck-lg" checked={on} disabled={!c.lots.length} readOnly /></td>
                  <td>
                    <b className="plate">{c.plate}</b>
                    {c.mismatch ? (
                      <span className="tag warn" style={{ marginLeft: 6 }} title={`各系统到期日：${c.mismatch.dates.join(' / ')}`}>到期日不一致</span>
                    ) : null}
                  </td>
                  <td><span className={`tag ${identityTone(tags[c.plate] || c.identity)}`}>{tags[c.plate] || c.identity || '未标注'}</span></td>
                  <td>{c.lots.map((l) => <div key={l.key} className="lot-line">{l.label}<small className="muted"> · {l.system === 'deliyun' ? '德立云' : '本地库'}</small></div>)}</td>
                  <td>{c.lots.map((l) => <div key={l.key} className="lot-line">{l.space ? <b>{l.space}</b> : <span className="muted">—</span>}{l.spaceFromNote ? <small className="muted">（取自备注）</small> : null}</div>)}</td>
                  <td>{c.lots.map((l) => <div key={l.key} className="lot-line" style={{ color: expired(l.endDate) ? 'var(--dang)' : undefined }}>{l.endDate || '—'}</div>)}</td>
                  <td>{!c.lots.length ? <span className="tag">已绑定 · 待核对授权</span> : expired(minEnd) ? <span className="tag dang"><Icon name="alert" />已过期</span> : dayjs(minEnd).diff(dayjs(), 'day') <= 30 ? <span className="tag warn"><Icon name="clock" />快到期</span> : <span className="tag ok"><Icon name="check" />有效</span>}</td>
                </tr>
              );
            })}
            {!cars.length ? (
              <tr style={{ cursor: 'default' }}><td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 26 }}>
                {loadingAny ? (local.state === 'loading' ? '正在读现场停车库（约 5–20 秒）…' : '正在查询停车系统…')
                  : noSystem ? '这个小区没有接入停车系统（或停车费在别处收）'
                    : deliyunFails.length || local.state === 'failed' ? '部分系统没查成，见上方提示' : '各停车系统里都没有这一户登记的车'}
              </td></tr>
            ) : null}
            {cars.length && local.state === 'loading' ? <tr style={{ cursor: 'default' }}><td colSpan={7} className="muted" style={{ fontSize: 13.5 }}><div className="spin" style={{ width: 14, height: 14, display: 'inline-block', verticalAlign: -2, marginRight: 6 }} />本地停车库还在读，稍后会补上</td></tr> : null}
          </tbody>
        </table>
      </div>

      {pickedCars.length ? (
        <div style={{ marginTop: 12, display: 'grid', gap: 10 }}>
          {pickedCars.map((c) => <div key={c.plate}>
            <CarRenewal car={c} rules={rules} house={house} onCart={setCart} onRemove={() => toggle(c.plate)} vehicleClass={tags[c.plate] || ''} onClass={(v) => setTag(c.plate, v)} />
            {hh && local.state === 'done' && <CashierVehicleActions car={c} onChanged={() => {
              onCart([], false);
              setCarts({});
              setPicked([]);
              setTags({});
              setReload(value => value + 1);
            }} />}
          </div>)}
        </div>
      ) : cars.length ? <div className="muted" style={{ marginTop: 10 }}>勾选要缴费的车（可多选）</div> : null}

      <div className="newplate-bar">
        <button className="btn" disabled={newBusy || !hh || !hh.targets.length} onClick={() => { setNewErr(''); setEntryKind('paid'); }}><Icon name="plus" size={16} />新办车牌（付费）</button>
        <button className="btn" disabled={newBusy} onClick={() => { setNewErr(''); setEntryKind('family'); }}><Icon name="plus" size={16} />亲情车（免费）</button>
        <span className="muted" style={{ fontSize: 13.5 }}>工作人员可直接登记，也可由住户扫码填写。</span>
      </div>
      </>}
      {entryKind ? <Sheet open title="新车登记" width={520} onClose={() => { if (!creatingIntake.current) setEntryKind(null); }}>
        <div className="registration-sheet" style={{ display: 'grid', gap: 14 }}>
          <RegistrationPermit house={house} />
          <div className="note">{entryKind === 'paid' ? '付费新车' : '亲情车'}；默认继续本户同类型最新待填登记，保留原资料与收款关联。</div>
          {newErr ? <div role="alert" style={{ color: 'var(--dang)' }}>{newErr}</div> : null}
          {canEnterVehicleDetails() && <button className="btn p" disabled={newBusy} onClick={() => void createIntake(entryKind)}>工作人员直接登记</button>}
          <button className="btn" disabled={newBusy} onClick={() => void createIntake(entryKind, false, false)}><Icon name="qr" size={16} />{newBusy ? '正在读取原登记…' : '生成/继续登记二维码'}</button>
          <button className="btn" disabled={newBusy} onClick={() => { if (window.confirm('将为另一辆车新建办理单，不是继续原登记。确认再登记一辆？')) void createIntake(entryKind, true); }}>再登记一辆（另建办理单）</button>
        </div>
      </Sheet> : null}
      {!entryKind && newErr ? <div className="note2" role="alert" style={{ color: 'var(--dang)' }}>{newErr}</div> : null}
      {intakes.length ? (
        <div style={{ marginTop: 10, display: 'grid', gap: 10 }}>
          {intakes.map((i) => (
            <section className="registration-workspace" key={i.id}>
            {!staffRegistration && <RegistrationPermit house={house} intakeId={i.id} />}
            <NewPlateCard intake={i} house={house} rules={rules} targets={hh?.targets ?? []} defaultStaffMode entryMode={selectedEntry?.id === i.id ? selectedEntry : undefined}
              onChange={updateIntake} onDrop={dropIntake} onCart={setCart}
              renewal={(car, label, cls, onCls, ready, garages) => <CarRenewal car={car} rules={rules} house={house} onCart={setCart} intakeId={i.id} allowCart={ready} garages={garages} title="新办" label={label} vehicleClass={cls} onClass={onCls} />} />
            </section>
          ))}
        </div>
      ) : null}

      <div className="note2" style={{ marginTop: 14 }}>
        <Icon name="alert" />车位号：大车库取旧库车位字段，人防车库和其他小区取德立云登记的车位号；没登记的显示「—」。没到期的车接着原到期日往后续。新办车牌从收款当天起算。
      </div>
    </div>
  );
}

/** 一辆车的续期设置：续哪几套系统、按哪条收费标准、续几个月；服务端试算后报给上层 */
function CashierVehicleActions({ car, onChanged }: { car: Car; onChanged: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const [cloud, setCloud] = useState<DeliyunVehicle | 'loading' | null>();
  const [error, setError] = useState('');
  useEffect(() => {
    if (!expanded) return;
    let active = true;
    setCloud('loading'); setError('');
    accessCardIssuance.deliyunVehiclesByPlate(car.plate).then(result => {
      const hits = result.rows.filter(row => normPlate(row.plate) === normPlate(car.plate));
      if (hits.length > 1) throw new Error('人防同牌记录不唯一，请核对');
      if (active) setCloud(hits[0] ?? null);
    }).catch(reason => {
      if (active) { setError(reason instanceof Error ? reason.message : '人防状态查询失败'); setCloud(undefined); }
    });
    return () => { active = false; };
  }, [expanded, car.plate]);
  return <details onToggle={e => setExpanded(e.currentTarget.open)}>
    <summary className="btn sm">车辆管理 · {car.plate}</summary>
    {expanded && <div className="veh-actions" style={{display:'flex', flexWrap:'wrap', gap:8, padding:'8px 0'}}>
      {error && <span role="alert">{error}</span>}
      <VehicleActions plate={car.plate} rows={car.rows ?? []} cloud={cloud} onChanged={onChanged} />
    </div>}
  </details>;
}

export function CarRenewal({ car: sel, rules, house, onCart, onRemove, intakeId, allowCart = true, garages, title = '续期', label, vehicleClass = '', onClass }: { car: Car; rules: ParkRule[]; house: ParkHouse; onCart: (plate: string, c: ParkingCart | null) => void; onRemove?: () => void; intakeId?: number; allowCart?: boolean; garages?: React.ReactNode; title?: string; label?: string; vehicleClass?: string; onClass?: (v: string) => Promise<void> | void }) {
  const [months, setMonths] = useState(6);
  const [ruleId, setRuleId] = useState<number | null>(null);
  const [off, setOff] = useState<string[]>([]);
  const [quotedEst, setEst] = useState<Estimate | null>(null);
  const [estimateKey, setEstimateKey] = useState('');
  const [monthsValid, setMonthsValid] = useState(true);
  const [estErr, setEstErr] = useState('');
  const quoteGeneration = useRef(0);
  const [quoteRevision, setQuoteRevision] = useState(0);
  const invalidateQuote = () => { quoteGeneration.current++; setQuoteRevision(value => value + 1); setEst(null); setEstErr(''); onCart(sel.plate, null); };
  // 非标准续期
  const [custom, setCustom] = useState(false);
  const [cs, setCs] = useState('');
  const [ce, setCe] = useState('');
  const [amt, setAmt] = useState('');
  const [reason, setReason] = useState('');
  useEffect(() => () => onCart(sel.plate, null), []); // eslint-disable-line react-hooks/exhaustive-deps

  const lots = sel ? sel.lots.filter((l) => !off.includes(l.key)) : [];
  // 车辆类别：本小区、适用车库与这辆车所在车库有交集的分组（没勾车库 = 全部车库）
  // 车牌归在哪个分组就按哪张价格表收；没归组的按默认分组
  const own = useMemo(() => {
    const keys = new Set(lots.map((l) => l.targetKey).filter(Boolean));
    const tg = (r: ParkRule) => r.config?.parkingTargets ?? (r.config?.parkingTarget ? [r.config.parkingTarget] : []);
    return rules.filter((r) => r.serviceType === 'parking_monthly' && r.enabled && r.communityId === house.communityId && (!keys.size || !tg(r).length || tg(r).some((k) => keys.has(k))));
  }, [sel, lots, rules, house.communityId]); // eslint-disable-line react-hooks/exhaustive-deps
  const classOptions = useMemo(() => [...new Set(own.map((r) => r.config?.vehicleClass || '').filter(Boolean))], [own]);
  const defaultGroup = own.find((r) => r.config?.isDefault)?.config?.vehicleClass || '';
  const group = classOptions.includes(vehicleClass) ? vehicleClass : intakeId ? '' : defaultGroup;
  const [clsBusy, setClsBusy] = useState(false);
  const [clsErr, setClsErr] = useState('');
  const needClass = classOptions.length > 0 && !group;
  const candidates = useMemo(() => {
    const pool = classOptions.length ? (needClass ? [] : own.filter((r) => (r.config?.vehicleClass || '') === group)) : own;
    const rank = (r: ParkRule) => (r.config?.parkingTarget === 'local:phase2_main_garage' ? 0 : r.config?.parkingTarget?.startsWith('local:') ? 1 : 2);
    return [...pool].sort((a, b) => rank(a) - rank(b));
  }, [own, classOptions, group, needClass]);
  const pickClass = async (v: string) => {
    if (!onClass) return;
    invalidateQuote(); setClsBusy(true); setClsErr('');
    try { await onClass(v); } catch (e) { setClsErr(e instanceof Error ? e.message : '分类保存失败'); } finally { setClsBusy(false); }
  };
  const fallback = rules.filter((r) => r.serviceType === 'parking_monthly' && r.enabled && (r.communityId == null || r.communityId === house.communityId) && !r.config?.parkingTarget && !r.config?.parkingTargets?.length);
  const usable = candidates.length ? candidates : needClass ? [] : fallback;
  useEffect(() => { setRuleId(usable[0]?.id ?? null); }, [usable.map((r) => r.id).join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  const rule = usable.find((r) => r.id === ruleId) ?? null;

  const ends = lots.map((l) => l.endDate).filter((d): d is string => !!d).sort();
  const currentEnd = ends[ends.length - 1] ?? null;
  const mismatch = new Set(ends).size > 1;
  const defaultStart = currentEnd && !expired(currentEnd) ? dayjs(currentEnd).add(1, 'day').format('YYYY-MM-DD') : dayjs().format('YYYY-MM-DD');
  useEffect(() => { if (custom && !cs) { setCs(defaultStart); setCe(dayjs(defaultStart).add(1, 'month').subtract(1, 'day').format('YYYY-MM-DD')); } }, [custom]); // eslint-disable-line react-hooks/exhaustive-deps
  const attempted = useContext(ChargeAttempted);
  const errorId = useId();
  const reasonMissing = attempted && !reason.trim();
  const customOk = custom && /^\d{4}-\d{2}-\d{2}$/.test(cs) && /^\d{4}-\d{2}-\d{2}$/.test(ce) && ce >= cs;
  const days = customOk ? dayjs(ce).diff(dayjs(cs), 'day') + 1 : 0;
  const enteredCents = /^\d+(?:\.\d{1,2})?$/.test(amt.trim()) ? Math.round(Number(amt) * 100) : null;
  const manualCents = enteredCents != null && Number.isSafeInteger(enteredCents) && enteredCents >= 0 ? enteredCents : null;
  const amountMissing = attempted && manualCents == null;
  // 绑定完整报价上下文（同 id 规则改价、系统引用或身份变化也必须重新试算）。
  const quoteKey = JSON.stringify([allowCart, quoteRevision, sel.plate, house.id, house.communityId, house.owner?.id, rule, lots, vehicleClass, months, monthsValid, custom, cs, ce, amt, reason, label, clsBusy]);
  const currentQuoteKey = useRef(quoteKey);
  if (currentQuoteKey.current !== quoteKey) { currentQuoteKey.current = quoteKey; quoteGeneration.current++; }
  const est = estimateKey === quoteKey && (custom || monthsValid) && !clsBusy ? quotedEst : null;

  useEffect(() => {
    const generation = ++quoteGeneration.current;
    if (!rule || !lots.length || clsBusy || (!custom && !monthsValid) || (custom && !customOk)) { setEst(null); onCart(sel.plate, null); if (custom && cs && ce && !customOk) setEstErr('结束日期不能早于开始日期'); return; }
    if (custom && (manualCents == null || !reason.trim())) { setEst(null); onCart(sel.plate, null); setEstErr(manualCents == null ? '请输入实收金额（0元请填0）' : '请选择或填写自定日期的原因'); return; }
    let alive = true;
    setEstErr('');
    setEst(null);
    onCart(sel.plate, null);
    const data = custom
      ? { serviceType: 'parking_monthly', ruleId: rule.id, houseId: house.id, ownerId: house.owner?.id, plateNo: sel.plate, startDate: cs, endDate: ce, manualAmountCents: manualCents!, customReason: reason.trim() }
      : { serviceType: 'parking_monthly', ruleId: rule.id, houseId: house.id, ownerId: house.owner?.id, plateNo: sel.plate, months, currentEndDate: currentEnd || undefined };
    request<Estimate>({ method: 'POST', url: '/business/estimate', data })
      .then((e) => {
        if (!alive || generation !== quoteGeneration.current) return;
        if ((!custom && e.quantity !== months) || (custom && (e.startDate !== cs || e.endDate !== ce || e.amountCents !== manualCents)) || !Number.isSafeInteger(e.amountCents) || e.amountCents < 0 || !e.startDate || !e.endDate) {
          setEst(null); onCart(sel.plate, null); setEstErr('试算结果与当前续期不一致，请重新选择月份重试'); return;
        }
        setEst(e); setEstimateKey(quoteKey);
        if (!allowCart) { onCart(sel.plate, null); return; }
        const base = { plate: label ?? sel.plate, rule, months: e.quantity, currentEndDate: currentEnd, systems: lots.map((l) => l.ref), systemsLabel: lots.map((l) => l.label).join(' + '), ...(intakeId ? { intakeId } : {}) };
        if (!custom) { onCart(sel.plate, { ...base, months, estimate: e, custom: null }); return; }
        if (manualCents == null || !reason.trim()) { onCart(sel.plate, null); return; }
        onCart(sel.plate, { ...base, estimate: e, custom: { startDate: cs, endDate: ce, manualAmountCents: manualCents, reason: reason.trim(), standardAmountCents: e.standardAmountCents ?? null } });
      })
      .catch((e) => { if (alive && generation === quoteGeneration.current) { setEst(null); onCart(sel.plate, null); setEstErr(e instanceof Error ? e.message : '试算失败'); } });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quoteKey]);


  return (
        <div className="card" style={{ padding: '14px 16px' }}>
          <div className="side-h" style={{ marginBottom: 10 }}><Icon name="car" size={18} />{title} <b className="plate" style={{ marginLeft: 6 }}>{label ?? sel.plate}</b>
            {est ? <b className="money" style={{ marginLeft: 'auto' }}>{money(est.amountCents / 100)}</b> : <span style={{ marginLeft: 'auto' }} />}
            {onRemove ? <button className="btn g sm" style={{ marginLeft: 8 }} onClick={onRemove} title="这辆不缴">✕</button> : null}</div>
          {sel.lots.length > 1 && !intakeId ? (
            <div style={{ marginBottom: 10 }}>
              <div className="muted" style={{ fontSize: 13.5, marginBottom: 6 }}>{intakeId ? '一笔款同时开通以下车库（不开的取消勾选）：' : '一笔款同时续这辆车在以下系统的有效期（不续的取消勾选）：'}</div>
              {sel.lots.map((l) => (
                <label key={l.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginRight: 16, fontSize: 15 }}>
                  <input type="checkbox" checked={!off.includes(l.key)} onChange={(e) => { invalidateQuote(); setOff((p) => (e.target.checked ? p.filter((x) => x !== l.key) : [...p, l.key])); }} />
                  {l.label}{l.endDate ? <span className="muted">（至 {l.endDate}）</span> : null}
                </label>
              ))}
              {mismatch ? <div className="note2" style={{ marginTop: 8 }}><Icon name="alert" />各系统到期日不一致，按最晚的 {currentEnd} 往后续；比目标还晚的系统会转人工核对，不会被改短。</div> : null}
            </div>
          ) : null}
          {classOptions.length || intakeId ? (
            <div style={{ marginBottom: 16 }}>
              <VehicleClassChoices options={intakeId ? [...classOptions, '亲情车'] : classOptions} value={group} defaultValue={defaultGroup} disabled={clsBusy} onChange={c => { void pickClass(c); }} />
              {needClass ? <span style={{ color: 'var(--warn, #b7791f)', fontSize: 14 }}>先选这辆车属于哪个类别（选了会记住，下次自动带出）</span>
                : group && group !== vehicleClass ? <span className="muted" style={{ fontSize: 13.5 }}>未分类，按默认类别收</span> : null}
              {clsErr ? <span style={{ color: 'var(--dang)', fontSize: 14 }}>{clsErr}</span> : null}
            </div>
          ) : null}
          {garages}
          {usable.length > 1 ? (
            <div className="quickMonths" style={{ marginTop: 0, marginBottom: 10 }}>
              <span style={{ fontSize: 14, color: 'var(--ink2)', marginRight: 4 }}>收费标准：</span>
              {usable.map((r) => <button key={r.id} className={`chip ${ruleId === r.id ? 'on' : ''}`} onClick={() => { invalidateQuote(); setRuleId(r.id); }}>{r.name} · {money(r.unitPriceCents / 100)}/月</button>)}
            </div>
          ) : null}
          {needClass ? null : !usable.length ? (
            <div className="note2" style={{ color: 'var(--dang)' }}><Icon name="alert" />本小区还没有配置车辆类别，无法计算应收。请到「收费标准」新增车辆类别并设价格表。</div>
          ) : !candidates.length ? (
            <div className="note2" style={{ marginBottom: 10 }}><Icon name="alert" />本小区还没有给「{lots.map((l) => l.label).join('、') || '该停车场'}」建车辆类别，暂按通用规则「{rule?.name}」计价。</div>
          ) : null}
          {!lots.length && !intakeId ? <div className="muted">至少勾选一个要续期的系统</div> : (
            <>
              <div className="quickMonths" style={{ marginTop: 0 }}>
                <span style={{ fontSize: 14, color: 'var(--ink2)', marginRight: 4 }}>{intakeId ? '车牌授权期限' : '续：'}</span>
                <RenewalMonths value={months} active={!custom} onValidityChange={valid => { if (!valid) invalidateQuote(); setMonthsValid(valid); }} onChange={m => { invalidateQuote(); setCustom(false); setMonthsValid(true); setMonths(m); }} />
                <button className={`chip ${custom ? 'on' : ''}`} onClick={() => { invalidateQuote(); setCustom(true); }}><Icon name="clock" size={14} />自定日期</button>
                {!custom ? (
                  <span style={{ marginLeft: 'auto', fontSize: 14 }}>
                    {est ? <>{est.startDate} → <b>{est.endDate}</b> · <b className="money">{money(est.amountCents / 100)}</b>{est.breakdown && /套餐/.test(est.breakdown) ? <small className="muted">（{est.breakdown}）</small> : null}</> : estErr ? <span style={{ color: 'var(--dang)' }}>{estErr}</span> : !monthsValid ? <span style={{ color: 'var(--dang)' }}>月份未填写正确，不能试算或收款</span> : !lots.length ? <span className="muted">选好车库后试算</span> : usable.length ? <span className="muted">计算中…</span> : null}
                  </span>
                ) : null}
              </div>
              {custom ? (
                <div className="custom-renew">
                  <div className="cr-grid">
                    <label>开始日期<DateInput className="in" required aria-invalid={attempted && (!cs)} aria-describedby={attempted && (!cs) ? errorId+"-cs" : undefined} type="date" value={cs} onChange={(e) => { invalidateQuote(); setCs(e.target.value); }} />{attempted && (!cs) && <small id={errorId+"-cs"} role="alert">请选择开始日期</small>}</label>
                    <label>结束日期<DateInput className="in" required aria-invalid={attempted && (!ce || (!!cs && ce < cs))} aria-describedby={attempted && (!ce || (!!cs && ce < cs)) ? errorId+"-ce" : undefined} type="date" value={ce} min={cs || undefined} onChange={(e) => { invalidateQuote(); setCe(e.target.value); }} />{attempted && (!ce || (!!cs && ce < cs)) && <small id={errorId+"-ce"} role="alert">请选择有效的结束日期</small>}</label>
                    <label>实收金额（元）<input className="in" type="number" {...moneyInputProps} min={0} step="0.01" value={amt} aria-required="true" aria-invalid={amountMissing} aria-describedby={amountMissing ? errorId+"-amount" : undefined} aria-label="自定日期实收金额" placeholder="请输入金额，0元请填0" onChange={(e) => { invalidateQuote(); setAmt(e.target.value); }} />{amountMissing && <small id={errorId+"-amount"} role="alert">请输入实收金额，零元请填 0</small>}</label>
                  </div>
                  <div className="muted" style={{ fontSize: 13.5, margin: '6px 0' }}>
                    {days ? `共 ${days} 天` : ''}{est?.standardAmountCents != null ? ` · 标准参考 ${money(est.standardAmountCents / 100)}（${est.quantity} 个月）` : est ? ' · 该区间未配置标准价，按明确实收提交审核' : ''}
                    {estErr ? <span style={{ color: 'var(--dang)', marginLeft: 8 }}>{estErr}</span> : null}
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                    <span style={{ fontSize: 14, color: 'var(--ink2)' }}>原因：</span>
                    {['对齐到月底', '补缴差额', '按天计费', '优惠减免'].map((t) => <button key={t} className={`chip ${reason === t ? 'on' : ''}`} onClick={() => { invalidateQuote(); setReason(t); }}>{t}</button>)}
                    <input className="in" style={{ height: 36, flex: 1, minWidth: 180 }} aria-label="自定日期原因" aria-required="true" aria-invalid={reasonMissing} aria-describedby={reasonMissing ? errorId+"-reason" : undefined} value={reason} onChange={(e) => { invalidateQuote(); setReason(e.target.value); }} placeholder="写明为什么不按整月续（必填，经理审核看这句）" />{reasonMissing && <small id={errorId+"-reason"} role="alert">请选择或填写原因</small>}
                  </div>
                  <div className="note2" style={{ marginTop: 8 }}><Icon name="alert" />非标准续期先登记收款，提交物业经理审核；审核通过后系统才续期，驳回则不续期、由前台按原因退款或重办。</div>
                </div>
              ) : null}
            </>
          )}
        </div>
        );
}
