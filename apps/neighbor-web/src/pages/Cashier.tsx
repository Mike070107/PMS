import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ParkingTab, { payCode, type ParkingCart } from '@/components/cashier/ParkingTab';
import PaidHistory from '@/components/cashier/PaidHistory';
import { accessCardIssuance, address, request } from '@pms/api-client';
import type { AddressCommunity } from '@pms/shared-types';
import HousePicker, { type PickedHouse } from '@/components/HousePicker';
import UniSearch, { type UniPick } from '@/components/cashier/UniSearch';
import PayMethods from '@/components/PayMethods';
import MisCollectionPanel from '@/components/cashier/MisCollectionPanel';
import Icon from '@/components/Icon';
import type { IconName } from '@/components/Icon';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { INTAKE_STATUS, TXN_STATUS, type Intake } from '@/components/cashier/NewPlateCard';
import { ErrorNote, Loading, toast } from '@/components/ui';
import { useSession } from '@/lib/auth';
import { dayjs, money } from '@/lib/format';
import { accessStatusLabel, legacyStatusLabel, rawTitle } from '@/lib/access-card-status';
import NewOrderSheet, { type RepairPrefill } from '@/components/NewOrderSheet';
import FeeIcon from '@/components/FeeIcon';
import ToneIcon from '@/components/ToneIcon';
import '@/components/cashier/mis-remarks.css';

type ServiceType = 'parking_monthly' | 'access_card';
type Tab = 'wy' | 'bw' | 'pk' | 'ac';
/** 泊位费和物业费同在 MIS 账单里，按费项名区分，分成两个同级收费项 */
const isBerth = (feeName: string) => /泊位/.test(feeName);

interface BusinessRule {
  id: number; serviceType: ServiceType; name: string; communityId: number | null;
  billingUnit: 'month' | 'card'; unitPriceCents: number; enabled: boolean;
  config?: { parkingTarget?: string } | null;
}
interface HouseHit {
  id: number; roomNo: string; lane: string | null; buildingNo: string;
  communityId: number | null; communityName: string;
  owner: { id: number; name: string | null; phone: string | null } | null;
}
interface Vehicle { id: number; plateNo: string; houseId: number; ownerId: number | null; validUntil: string | null }
interface AccessCard { id: number; cardNo: string; houseId: number; ownerId: number | null; status: string }
interface SearchResult { houses: HouseHit[]; vehicles: Vehicle[]; accessCards: AccessCard[] }
interface Estimate { unitPriceCents: number; quantity: number; startDate: string | null; endDate: string | null; amountCents: number; summary: string }
/** 物业费/泊位费应收：实时读 MIS（/fees/mis/bills），id 是 MIS 侧单据号 */
interface Bill { id: string; feeName: string; period: string; amountCents: number; status: string; remark?: string | null }
interface MisRow { id: string; feeName: string | null; feeCode: string; period: string; amountCents: number; status: string; remark?: string | null }

interface ResultTask { icon: IconName; title: string; note: string; state: 'done' | 'queued' }
interface ChargeResult { title: string; amountCents: number; receiptNo: string; tasks: ResultTask[] }

/** 执行层状态 → 收银结果页提示 */
const syncNote = (st: string, err?: string | null) => ({
  // 文案不要一律写德立云：只续一期/二期停车库时根本没有德立云这一步
  queued: '已排队，等待现场助手写停车库…', running: '正在写入停车库并回读核对…',
  retry: `停车库写入暂时不可用，稍后自动重试${err ? `（${err}）` : ''}`,
  synced: '停车库到期日已更新并回读核对一致',
  dry_run: '演练模式：已核对并记下将要写入的到期日，未实际写入（在「待处理」查看）',
  manual: `需人工处理：${err || '停车库数据对不上'}（在「待处理」查看）`,
  failed: `多次失败：${err || '请稍后在「待处理」重试'}`,
  mocked: '未开启自动同步，请在德立云手动续期',
} as Record<string, string>)[st] || '已提交，在「待处理」查看进展';

const PAYMENTS: Array<{ k: string; icon: IconName }> = [
  { k: '现金', icon: 'cash' }, { k: '微信', icon: 'wechat' }, { k: '支付宝', icon: 'alipay' },
];

const maskPhone = (p?: string | null) => (p && p.length >= 7 ? `${p.slice(0, 3)}****${p.slice(-4)}` : p || '无电话');

/**
 * 社区收银台（新版）：找住户 → 一屏看清欠费/车/卡 → 按项目独立办理 → 一次确认 → 结果与后续任务。
 * 物业费、停车、门禁按 Tab 独立收款，不合并；只汇总当前 Tab 所选。
 * 金额一律服务端试算；收款只登记，后续 MIS/停车/写卡在「待处理」跟踪，不在这里谎称已核验。
 */
export default function Cashier() {
  const navigate = useNavigate();
  const session = useSession();
  const [params] = useSearchParams();
  const intakeParam = params.get('intakeId');
  const validIntakeId = intakeParam !== null && /^[1-9]\d*$/.test(intakeParam) && Number.isSafeInteger(Number(intakeParam));
  const [deep, setDeep] = useState<{ query: string; row?: Intake; error?: string } | null>(null);
  const navigationRevision = useRef(0);
  const [treeError, setTreeError] = useState('');
  const [tree, setTree] = useState<AddressCommunity[] | null>(null);
  const [rules, setRules] = useState<BusinessRule[]>([]);
  const [err, setErr] = useState('');

  const [picked, setPicked] = useState<PickedHouse | null>(null);
  const [house, setHouse] = useState<HouseHit | null>(null);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [bills, setBills] = useState<Bill[] | null>(null);
  const [remoteOpen, setRemoteOpen] = useState(false);
  const [remoteQ, setRemoteQ] = useState('');
  const [searching, setSearching] = useState(false);

  const [tab, setTab] = useState<Tab>('wy');
  const [parkPlate, setParkPlate] = useState<string | null>(null);
  const [cardHistory, setCardHistory] = useState<Array<{ id: number; sequence: number; roomLabel: string; icCardNo: string | null; wgCardNo: string | null; issuedAt: string | null; accessStatus: string; legacySyncStatus: string }> | null>(null);
  const [repairOpen, setRepairOpen] = useState(false);
  const [selBills, setSelBills] = useState<string[]>([]);
  const [billErr, setBillErr] = useState('');
  const [cardQty, setCardQty] = useState(1);
  const [cardFree, setCardFree] = useState(false);
  const [parkCarts, setParkCarts] = useState<ParkingCart[]>([]);
  const [parkReady, setParkReady] = useState(false);
  const onParkCart = useCallback((items: ParkingCart[], ready: boolean) => { setParkCarts(items); setParkReady(ready); }, []);
  const [cardEst, setCardEst] = useState<Estimate | null>(null);

  const [pay, setPay] = useState('现金');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const charging = useRef(false);
  const [done, setDone] = useState<ChargeResult | null>(null);

  useEffect(() => {
    request<BusinessRule[]>({ url: '/business/rules' }).then((r) => setRules(r.filter((x) => x.enabled))).catch(() => undefined);
    address.tree().then(setTree).catch((e) => setTreeError(e instanceof Error ? e.message : '地址加载失败'));
  }, []);

  const allowedIds = useMemo(() => {
    const a = session.access;
    if (!a || a.scopeAll) return null;
    return new Set(a.communityIds ?? []);
  }, [session.access]);
  const communities = useMemo(() => {
    const list = (tree ?? []).filter((c) => !c.isGroup);
    return allowedIds ? list.filter((c) => allowedIds.has(c.id)) : list;
  }, [tree, allowedIds]);
  const scopeLabel = useMemo(() => {
    const a = session.access;
    if (!a) return '按当前账号权限';
    if (a.scopeAll) return '全部管理处';
    if (session.actingOffice?.name) return session.actingOffice.name;
    if (a.communityIds?.length) return `${a.communityIds.length} 个小区`;
    return '未配置数据范围';
  }, [session.access, session.actingOffice]);

  // Only a scope-checked intake may supply the stable house ID. Never GET a query houseId
  // globally, parse houseLabel, or search a room string to guess an owner.
  useEffect(() => {
    const revision = ++navigationRevision.current;
    setDeep(null); setHouse(null); setPicked(null); setResult(null); setDone(null); setErr('');
    setParkPlate(null); setParkCarts([]); setParkReady(false); setConfirmed(false); setBills(null);
    if (intakeParam === null || !validIntakeId) return;
    if (!tree || !session.access) return;
    let alive = true;
    request<Intake>({ url: `/vehicle-intakes/${intakeParam}` }).then(row => {
      if (!alive || revision !== navigationRevision.current) return;
      if (row.id !== Number(intakeParam) || !Number.isSafeInteger(row.houseId) || row.houseId <= 0) throw new Error('登记返回的编号或房屋编号无效');
      for (const community of communities) {
        for (const building of community.buildings) {
          const own = building.houses.find(h => h.id === row.houseId);
          if (!own) continue;
          const hit: HouseHit = { id: own.id, roomNo: own.roomNo, lane: building.lane, buildingNo: building.buildingNo, communityId: community.id, communityName: community.name,
            owner: own.ownerId ? { id: own.ownerId, name: own.ownerName ?? null, phone: own.ownerPhone ?? null } : null };
          setHouse(hit); setResult({ houses: [hit], vehicles: [], accessCards: [] });
          setTab('pk'); setDeep({ query: intakeParam, row });
          return;
        }
      }
      throw new Error('本次登记所属房屋不在当前授权地址范围，无法收费');
    }).catch(e => {
      if (alive && revision === navigationRevision.current) setDeep({ query: intakeParam, error: e instanceof Error ? e.message : '读取本次登记失败' });
    });
    return () => { alive = false; };
  }, [intakeParam, validIntakeId, communities, tree, session.access]);
  const linkedIntake = deep?.query === intakeParam ? deep.row : undefined;
  const deepReady = intakeParam === null || !!linkedIntake;
  const linkedBlocked = !!linkedIntake && (linkedIntake.kind !== 'paid' || linkedIntake.status === 'void' || !!linkedIntake.transaction || !!linkedIntake.familyCarId);

  // 生产 API 有的版本 /business/search 直接返回数组（旧形状），有的返回 {houses,vehicles,accessCards}。
  // 两种都吃下来，绝不让 r.houses 是 undefined 时把页面抛成「T is not iterable」。
  const normSearch = (r: unknown): SearchResult => {
    if (Array.isArray(r)) {
      const rows = r as Array<Record<string, unknown>>;
      const pick = (k: string) => rows.filter((x) => String(x.kind ?? x.type ?? '') === k) as never[];
      return { houses: pick('house'), vehicles: pick('vehicle'), accessCards: pick('card') };
    }
    const o = (r ?? {}) as Partial<SearchResult>;
    return { houses: o.houses ?? [], vehicles: o.vehicles ?? [], accessCards: o.accessCards ?? [] };
  };

  const searchByQ = useCallback(async (kw: string): Promise<SearchResult> => {
    const [parkRaw, cardRaw] = await Promise.all([
      request<unknown>({ url: '/business/search', query: { q: kw, serviceType: 'parking_monthly' } }),
      request<unknown>({ url: '/business/search', query: { q: kw, serviceType: 'access_card' } }),
    ]);
    const park = normSearch(parkRaw);
    const card = normSearch(cardRaw);
    const uniq = <T extends { id: number }>(a: T[], b: T[]) => [...a, ...b].filter((x, i, arr) => arr.findIndex((y) => y.id === x.id) === i);
    const merged: SearchResult = { houses: uniq(park.houses, card.houses), vehicles: uniq(park.vehicles, card.vehicles), accessCards: uniq(park.accessCards, card.accessCards) };
    // 车牌不在 PMS 本地表里（生产 parking_vehicles 基本是空的）：真车在现场旧停车库，
    // 本地没查到时按车牌去现场库查一次，拿到房号再落成一条可续期的“车”。
    const looksPlate = /[\u4e00-\u9fff][A-Za-z]/.test(kw) || /^[A-Za-z0-9]{4,8}$/.test(kw.trim());
    if (!merged.vehicles.length && looksPlate && kw.trim().length >= 3) {
      try {
        let q = await accessCardIssuance.createParkingQuery(kw.trim());
        for (let i = 0; i < 10 && (q.status === 'pending' || q.status === 'running'); i += 1) {
          await new Promise((r) => setTimeout(r, 800));
          q = await accessCardIssuance.parkingQuery(q.id);
        }
        const rows = (q.rows ?? []) as Array<{ database: string; fields: Record<string, unknown> }>;
        for (const row of rows) {
          const f = row.fields || {};
          const plate = String(f.P_plate ?? f.p_plate ?? f.Car_No ?? '').trim().toUpperCase();
          const room = String(f.Owner__owner_Name ?? f.P_note ?? '').trim();
          if (!plate || !room) continue;
          const rr = normSearch(await request<unknown>({ url: '/business/search', query: { q: room } }));
          const hit = rr.houses[0];
          if (!hit) continue;
          if (!merged.houses.some((h) => h.id === hit.id)) merged.houses.push(hit);
          if (!merged.vehicles.some((v) => v.plateNo === plate)) merged.vehicles.push({ id: hit.id * 1000 + merged.vehicles.length, plateNo: plate, houseId: hit.id, ownerId: hit.owner?.id ?? null, validUntil: null });
        }
      } catch { /* 现场库不可用时保持空结果，不报错打断查询 */ }
    }
    return merged;
  }, []);

  const loadBills = (h: HouseHit) => {
    const revision = navigationRevision.current;
    setBills(null); setBillErr('');
    // 按具体房屋 id 实时查 MIS 未收账单（不再按房号模糊查本地导入表：那张表是一次性导入的历史数据，
    // 且同号房会把别的小区也带出来）
    request<{ rows: MisRow[] }>({ url: '/fees/mis/bills', query: { houseId: h.id, status: 'unpaid', page: 1, pageSize: 300 }, timeout: 25000 })
      .then((r) => {
        if (revision !== navigationRevision.current) return;
        const own: Bill[] = r.rows
          .map((m) => ({ id: m.id, feeName: m.feeName || m.feeCode, period: m.period, amountCents: m.amountCents, status: m.status, remark: m.remark }))
          .sort((a, b) => a.period.localeCompare(b.period));
        setBills(own); setSelBills(own.map((b) => b.id));
      })
      .catch((e) => { if (revision === navigationRevision.current) { setBills([]); setBillErr(e instanceof Error ? e.message : 'MIS 查询失败'); } });
  };

  const applyHouse = (h: HouseHit | null, from: SearchResult | null) => {
    navigationRevision.current += 1;
    setHouse(h); setResult(from); setDone(null); setConfirmed(false);
    setParkCarts([]); setParkReady(false); setCardEst(null); setCardQty(1); setCardFree(false); setTab('wy');
    if (h) loadBills(h); else setBills(null);
  };

  const chooseHouse = async (p: PickedHouse) => {
    setPicked(p);
    const hit: HouseHit = {
      id: p.houseId, roomNo: p.roomNo, lane: p.lane, buildingNo: p.buildingNo,
      communityId: p.communityId, communityName: p.communityName,
      owner: p.ownerId ? { id: p.ownerId, name: p.ownerName, phone: p.ownerPhone } : null,
    };
    applyHouse(hit, { houses: [hit], vehicles: [], accessCards: [] });
    const revision = navigationRevision.current;
    try {
      const r = await searchByQ(`${p.buildingNo}/${p.roomNo}`);
      if (revision !== navigationRevision.current) return;
      const exact = r.houses.find((x) => x.id === p.houseId) ?? hit;
      applyHouse(exact, { houses: [exact], vehicles: r.vehicles.filter((v) => v.houseId === p.houseId), accessCards: r.accessCards.filter((x) => x.houseId === p.houseId) });
    } catch { /* 车辆/门禁查不到不影响已选房号 */ }
  };

  const remoteSearch = async () => {
    const kw = remoteQ.trim();
    if (!kw) return;
    setSearching(true); setErr('');
    try {
      const r = await searchByQ(kw);
      const first = (r.vehicles[0]?.houseId && r.houses.find((h) => h.id === r.vehicles[0].houseId)) || r.houses[0] || null;
      if (first) {
        applyHouse(first, { houses: [first], vehicles: r.vehicles.filter((v) => v.houseId === first.id), accessCards: r.accessCards.filter((x) => x.houseId === first.id) });
        setRemoteOpen(false);
      } else setErr('没查到匹配的住户/车辆，换个关键词试试');
    } catch (e) { setErr(e instanceof Error ? e.message : '查询失败'); }
    finally { setSearching(false); }
  };

  /** 统一查询框的结果：房号→物业费；车牌→停车续期并选中该车；门禁卡→门禁 */
  const onUniPick = (p: UniPick) => {
    const all = p.all;
    const byHouse = (houseId: number | null) => (houseId == null ? null : all.houses.find((h) => h.id === houseId) ?? null);
    if (p.kind === 'house') {
      applyHouse(p.hit as HouseHit, { houses: [p.hit as HouseHit], vehicles: all.vehicles.filter((v) => v.houseId === p.hit.id), accessCards: all.accessCards.filter((c) => c.houseId === p.hit.id) } as never);
      setTab('wy');
      return;
    }
    const h = byHouse(p.kind === 'vehicle' ? p.vehicle.houseId : p.card.houseId);
    if (!h) { setErr('这条记录没有关联房号，无法办理'); return; }
    applyHouse(h as HouseHit, {
      houses: [h as HouseHit],
      vehicles: all.vehicles.filter((v) => v.houseId === h.id),
      accessCards: all.accessCards.filter((c) => c.houseId === h.id),
    } as never);
    if (p.kind === 'vehicle') { setParkPlate(p.vehicle.plateNo); setTab('pk'); }
    else setTab('ac');
  };

  const cardRule = useMemo(() => rules.find((r) => r.serviceType === 'access_card' && (r.communityId == null || r.communityId === house?.communityId)), [rules, house]);
  const cards = useMemo(() => (result?.accessCards ?? []).filter((c) => c.houseId === house?.id), [result, house]);
  const wyBills = useMemo(() => (bills ?? []).filter((b) => !isBerth(b.feeName)), [bills]);
  const bwBills = useMemo(() => (bills ?? []).filter((b) => isBerth(b.feeName)), [bills]);
  const tabBills = tab === 'bw' ? bwBills : wyBills;
  const tabArrears = tabBills.reduce((s, b) => s + b.amountCents, 0);
  const isBillTab = tab === 'wy' || tab === 'bw';
  const billLabel = tab === 'bw' ? '泊位费' : '物业费';
  const selBillRows = useMemo(() => tabBills.filter((b) => selBills.includes(b.id)), [tabBills, selBills]);
  const selBillTotal = useMemo(() => selBillRows.reduce((s, b) => s + b.amountCents, 0), [selBillRows]);

  // 门禁卡：读这一户的发卡历史（旧页「门禁发卡」的历史卡片区块同一份数据）
  useEffect(() => {
    if (tab !== 'ac' || !house) { setCardHistory(null); return undefined; }
    let alive = true;
    setCardHistory(null);
    accessCardIssuance.houseContext(house.id)
      .then((c) => { if (alive) setCardHistory((c?.history ?? []) as never); })
      .catch(() => { if (alive) setCardHistory([]); });
    return () => { alive = false; };
  }, [tab, house?.id]);

  // 服务端试算（金额不在端上乘）
  useEffect(() => {
    if (tab !== 'ac' || !house || !cardRule || cardFree) { setCardEst(null); return; }
    let alive = true;
    request<Estimate>({ method: 'POST', url: '/business/estimate', data: { serviceType: 'access_card', ruleId: cardRule.id, houseId: house.id, ownerId: house.owner?.id, quantity: cardQty } })
      .then((e) => { if (alive) setCardEst(e); }).catch(() => { if (alive) setCardEst(null); });
    return () => { alive = false; };
  }, [tab, house, cardRule, cardQty, cardFree]);

  const cartTotal = isBillTab ? selBillTotal : tab === 'pk' ? parkCarts.reduce((t, x) => t + x.estimate.amountCents, 0) : (cardFree ? 0 : (cardEst?.amountCents ?? 0));
  // MIS 写账协议未落地：物业费/泊位费在这里只核对应收，收款仍在物业系统办理，避免两边账对不上
  const canCharge = deepReady && !(tab === 'pk' && linkedBlocked) && (isBillTab ? false : tab === 'pk' ? parkReady : (cardFree || !!cardEst));

  const charge = async () => {
    if (!house || !canCharge || charging.current || (cartTotal > 0 && !confirmed)) return;
    charging.current = true;
    const revision = navigationRevision.current;
    setBusy(true); setErr('');
    try {
      if (tab === 'pk' && parkCarts.length) {
        // 一辆车一笔流水（各自续期、各自重试）；中途失败时已登记的照常保留，没登记的提示重办
        const okList: Array<{ c: ParkingCart; txn: { id: number; txnNo: string; externalSyncStatus: string } }> = [];
        let failMsg = '';
        for (const c of parkCarts) {
          try {
            if (revision !== navigationRevision.current) return;
            if (c.intakeId) {
              const current = await request<Intake>({ url: `/vehicle-intakes/${c.intakeId}` });
              if (revision !== navigationRevision.current) return;
              if (intakeParam === String(current.id)) setDeep({ query: intakeParam, row: current });
              if (current.id !== c.intakeId || current.houseId !== house.id || current.kind !== 'paid' || current.transaction || current.status === 'void' || current.familyCarId) {
                setConfirmed(false); throw new Error('本次登记状态已变化（已收款 / 已撤销 / 已转亲情车或房屋不匹配），请查看登记详情，不要重复收费');
              }
            }
            const txn = await request<{ id: number; txnNo: string; externalSyncStatus: string }>({ method: 'POST', url: '/business/complete', data: {
              serviceType: 'parking_monthly', ruleId: c.rule.id, houseId: house.id, ownerId: house.owner?.id, plateNo: c.plate,
              ...(c.custom
                ? { startDate: c.custom.startDate, endDate: c.custom.endDate, manualAmountCents: c.custom.manualAmountCents, customReason: c.custom.reason }
                : { months: c.months, currentEndDate: c.currentEndDate || undefined }),
              parkingSystems: c.systems, ...(c.intakeId ? { intakeId: c.intakeId } : {}), paymentMethod: payCode(pay), remark: payCode(pay) === 'other' ? `收款方式：${pay}` : undefined,
            } });
            if (revision !== navigationRevision.current) return;
            okList.push({ c, txn });
            if (c.intakeId && intakeParam === String(c.intakeId)) {
              void request<Intake>({ url: `/vehicle-intakes/${c.intakeId}` }).then(row => {
                if (revision === navigationRevision.current) setDeep({ query: intakeParam, row });
              }).catch(() => undefined); // Payment succeeded; refresh failure must never invite a second charge.
            }
          } catch (e) { if (revision !== navigationRevision.current) return; failMsg = `${c.plate} 未登记：${e instanceof Error ? e.message : '提交失败'}`; break; }
        }
        if (!okList.length) throw new Error(failMsg || '收款失败');
        const amt = okList.reduce((t, x) => t + x.c.estimate.amountCents, 0);
        setDone({ title: `停车续期 ${okList.map((x) => x.c.plate).join('、')}`, amountCents: amt, receiptNo: okList.map((x) => x.txn.txnNo).filter(Boolean).join('、') || '—', tasks:
          okList.map((x) => ({ icon: 'car' as const, title: `续期 ${x.c.systemsLabel} · ${x.c.plate} 至 ${x.c.estimate.endDate}`,
            note: x.txn.externalSyncStatus === 'review' ? '非标准续期，已提交物业经理审核；通过后系统自动续期，进度在「待处理」'
              : x.txn.externalSyncStatus === 'awaiting_docs' ? '新办车牌：款已收，等业主扫码填车牌、上传资料并审核通过后自动办理，进度在「车牌登记审核」'
              : syncNote(x.txn.externalSyncStatus), state: 'queued' as const })) });
        okList.filter((x) => !['review', 'awaiting_docs'].includes(x.txn.externalSyncStatus)).forEach((x) => watchSync(x.txn.id, `续期 ${x.c.systemsLabel} · ${x.c.plate} 至 ${x.c.estimate.endDate}`));
        if (failMsg) toast(`${failMsg}；已登记的 ${okList.length} 辆不受影响，没登记的请重新办理`);
      } else if (tab === 'ac' && cardRule) {
        await request({ method: 'POST', url: '/business/complete', data: { serviceType: 'access_card', ruleId: cardRule.id, houseId: house.id, ownerId: house.owner?.id, quantity: cardQty, free: cardFree, paymentMethod: payCode(pay) } });
        setDone({ title: cardFree ? `赠卡 ${cardQty} 张` : `门禁卡 ${cardQty} 张`, amountCents: cartTotal, receiptNo: '—', tasks: [
          { icon: 'key', title: `写卡 ${cardQty} 张`, note: '已排队，去发卡 / 「待处理」看写卡结果', state: 'queued' },
        ] });
      }
      setConfirmed(false);
    } catch (e) { if (revision === navigationRevision.current) { const message = e instanceof Error ? e.message : '收款失败'; setErr(message); toast(message); } }
    finally { charging.current = false; setBusy(false); }
  };

  /** 停车收款后跟踪现场执行：3 秒一轮、最多 3 分钟，并把已等待秒数写在状态里，别让前台干等 */
  const watchSync = (id: number, title: string) => {
    const started = Date.now();
    type TaskState = ChargeResult['tasks'][number]['state'];
    const setTaskNote = (patch: { state?: TaskState; note?: string }) => {
      setDone((d) => (d ? { ...d, tasks: d.tasks.map((k) => (k.title === title ? { ...k, ...patch } : k)) } : d));
    };
    const tick = () => {
      const waited = Math.round((Date.now() - started) / 1000);
      request<Array<{ id: number; externalSyncStatus: string; snapshot?: { execution?: { lastError?: string | null; steps?: Array<{ label: string; status: string }> } } }>>({ url: '/business/transactions' })
        .then((list) => {
          const t = list.find((x) => x.id === id);
          if (!t) return;
          const st = t.externalSyncStatus;
          const steps = t.snapshot?.execution?.steps ?? [];
          const doing = steps.find((x) => x.status === 'pending' || x.status === 'waiting');
          const final = ['synced', 'manual', 'failed', 'dry_run', 'mocked'].includes(st);
          if (final) {
            setTaskNote({ state: st === 'synced' ? 'done' : 'queued', note: syncNote(st, t.snapshot?.execution?.lastError) });
            return;
          }
          setTaskNote({
            state: 'queued',
            note: `已等待 ${waited} 秒${doing ? ` · 正在写 ${doing.label}` : ' · 等待现场助手取任务'}（约 10–40 秒，现场电脑不在线会更久）`,
          });
          if (waited < 180) setTimeout(tick, 3000);
          else setTaskNote({ state: 'queued', note: '现场助手 3 分钟内没有回执，任务已保留：到「待处理」可查看/重试，钱已收、不要重复收款' });
        })
        .catch(() => {
          setTaskNote({ state: 'queued', note: `已等待 ${waited} 秒 · 正在取回执…` });
          if (waited < 180) setTimeout(tick, 3000);
        });
    };
    setTimeout(tick, 1500);
  };

  const reset = () => { navigationRevision.current += 1; setPicked(null); setHouse(null); setResult(null); setBills(null); setDone(null); setErr(''); if (intakeParam !== null) navigate('/cashier'); };

  // ---------- 结果页 ----------
  if (done && deepReady) {
    return (
      <div className="resultWrap">
        <div className="card">
          <div className="resultHero">
            <div className="ring"><Icon name="check" /></div>
            <h2>收款已登记</h2>
            <div className="amt money">{money(done.amountCents / 100)}</div>
            <p>{house?.communityName} {house?.buildingNo}/{house?.roomNo} · {done.title} · {pay}{done.receiptNo !== '—' ? ` · 收据号 ${done.receiptNo}` : ''}</p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginTop: 18 }}>
              {done.receiptNo !== '—' ? <button className="btn" onClick={() => navigate(`/fees?receipt=${encodeURIComponent(done.receiptNo)}`)}><Icon name="print" size={18} />打印收据</button> : null}
              <button className="btn p" onClick={() => { setDone(null); if (house) loadBills(house); }}><Icon name="receipt" size={18} />继续给本户办理</button>
              <button className="btn" onClick={reset}><Icon name="search" size={18} />换一户</button>
            </div>
          </div>
          <hr className="hr" />
          <div style={{ padding: '18px 20px 8px' }}>
            <div className="taskHd"><Icon name="flow" size={16} />后续自动任务（收款已完成，与下列执行相互独立）</div>
          </div>
          <div style={{ paddingBottom: 10 }}>
            {done.tasks.map((t, i) => (
              <div className="taskRow" key={i}>
                <div className={`ti ic ${t.state === 'done' ? 'green' : 'amber'}`}>{t.state === 'done' ? <Icon name="check" /> : <div className="spin" />}</div>
                <div className="tt"><b>{t.title}</b><small>{t.note}</small></div>
                <span className={`tag ${t.state === 'done' ? 'ok' : 'warn'}`}>{t.state === 'done' ? '已完成' : <><Icon name="clock" />已提交</>}</span>
              </div>
            ))}
          </div>
          <div className="note2" style={{ margin: '0 20px 20px' }}><Icon name="alert" />任何一步失败都不退回已收的款，只把失败的那一步放进「待处理」重试；已成功的记账不会重做。</div>
        </div>
      </div>
    );
  }

  const initial = house?.owner?.name?.slice(0, 1) || house?.roomNo?.slice(0, 1) || '房';

  return (
    <>
      <div className="ph" style={{ marginBottom: 14 }}>
        <div>
          <div className="h1row"><ToneIcon kind="cashier" /><h1 style={{ fontSize: 22 }}>收银台</h1></div>
          <p>找到住户 → 按项目办理 → 一次确认收款 <span className="tag mute" style={{ marginLeft: 8 }}><Icon name="building" />数据范围：{scopeLabel}</span></p>
        </div>
        <div className="act"><button className="btn" onClick={() => navigate('/fees')}><Icon name="receipt" size={18} />今日流水 / 红冲</button></div>
      </div>

      {err ? <ErrorNote>{err}</ErrorNote> : null}
      {treeError ? <ErrorNote>{treeError}</ErrorNote> : null}
      {intakeParam !== null ? <section role="region" aria-label={`本次登记 #${intakeParam}`} className="card" style={{ padding: 16, marginBottom: 16 }}>
        <h2 style={{ fontSize: 18, marginBottom: 10 }}>本次登记 #{intakeParam}</h2>
        {!validIntakeId ? <ErrorNote>登记编号必须是正整数</ErrorNote>
          : deep?.query === intakeParam && deep.error ? <ErrorNote>{deep.error}</ErrorNote>
            : !linkedIntake ? <Loading text={treeError ? '地址读取失败，无法定位本次登记' : '正在安全定位本次登记所属住户…'} />
              : <>
                <b>{linkedIntake.plate || '业主尚未填写车牌'}</b> · {linkedIntake.kind === 'family' ? '亲情车（免费）' : '付费新车'} · <span className={`tag ${INTAKE_STATUS[linkedIntake.status][1]}`}>{INTAKE_STATUS[linkedIntake.status][0]}</span>
                <p style={{ marginTop: 8 }}>{linkedIntake.transaction ? `已收款 · ${TXN_STATUS[linkedIntake.transaction.externalSyncStatus] || linkedIntake.transaction.externalSyncStatus}，请勿重复收款。` : linkedIntake.familyCarId ? '已转亲情车办理，不再按付费新车收款。' : linkedIntake.status === 'void' ? '本次登记已撤销，不能收费。' : linkedIntake.kind === 'family' ? '本次为免费亲情车，无需收费；按类型在登记详情转类 / 撤销。' : '已按房屋稳定 ID 定位授权住户。请在下方已有新办登记选择收费标准，不要重复新建；不会自动收款。'}</p>
                {!linkedIntake.qrValid && linkedIntake.status !== 'void' ? <p className="muted">原二维码已失效；资料与收费状态以本次登记为准，需要填写时在登记详情处理二维码。</p> : null}
              </>}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 12 }}>
          {validIntakeId ? <button className="btn" onClick={() => navigate(`/plates?intakeId=${intakeParam}`)}>查看/处理本次登记</button> : null}
          <button className="btn" onClick={reset}>重新选择住户</button>
        </div>
      </section> : null}

      {intakeParam === null ? <div className="findBar">
        <UniSearch
          communities={communities}
          onPick={onUniPick}
          search={(kw) => searchByQ(kw) as never}
          placeholder="房号 / 姓名 / 手机尾号 / 车牌尾号，回车查询"
        />
      </div> : null}

      {!house || !deepReady ? (
        <div className="card" style={{ padding: '64px 20px', marginTop: 16, textAlign: 'center' }}>
          <Icon name="cash" size={44} style={{ color: 'var(--ink4)', strokeWidth: 1.3, marginBottom: 12 }} />
          <div className="muted" style={{ fontSize: 15 }}>{intakeParam === null ? '输入房号点选，或按车牌 / 姓名查找，开始收费办理' : '登记及授权住户确认前不展示收费选择'}</div>
        </div>
      ) : (
        <div className="cash2" style={{ marginTop: 18 }}>
          <div className="cashier-mis-bills">
            <div className="card">
              <div className="ownerHead">
                <div className="ownerAv">{initial}</div>
                <div className="ownerMeta">
                  <div className="nm">{house.owner?.name || '未登记业主'}</div>
                  <div className="addr">
                    <Icon name="home" />{house.communityName} {house.buildingNo}/{house.roomNo}
                    <Icon name="phone" />{maskPhone(house.owner?.phone)}
                  </div>
                </div>
                <button className="btn" style={{ marginLeft: 'auto' }} onClick={() => setRepairOpen(true)}>
                  <Icon name="wrench" size={16} />报修
                </button>
              </div>
            </div>

            <div className="projTabs" style={{ marginTop: 18 }}>
              <button className={`projTab ${tab === 'wy' ? 'on' : ''}`} onClick={() => { setTab('wy'); if (bills === null) loadBills(house); }}>
                <Icon name="home" /><b>物业费</b><small>{bills === null ? '查询中' : billErr ? '查询失败' : wyBills.length ? `待缴 ${wyBills.length} 笔` : '无待缴'}</small>
                {wyBills.length ? <span className="flag">{wyBills.length}</span> : null}
              </button>
              <button className={`projTab ${tab === 'bw' ? 'on' : ''}`} onClick={() => { setTab('bw'); if (bills === null) loadBills(house); }}>
                <Icon name="car" /><b>泊位费</b><small>{bills === null ? '查询中' : billErr ? '查询失败' : bwBills.length ? `待缴 ${bwBills.length} 笔` : '无待缴'}</small>
                {bwBills.length ? <span className="flag">{bwBills.length}</span> : null}
              </button>
              <button className={`projTab ${tab === 'pk' ? 'on' : ''}`} onClick={() => setTab('pk')}>
                <Icon name="car" /><b>停车缴费</b><small>{parkCarts.length ? `已选 ${parkCarts.length} 辆` : '车牌 · 车位 · 有效期'}</small>
              </button>
              <button className={`projTab ${tab === 'ac' ? 'on' : ''}`} onClick={() => setTab('ac')}>
                <Icon name="key" /><b>门禁卡</b><small>{cards.length} 张</small>
              </button>
            </div>

            {isBillTab ? (
              <div style={{ marginTop: 16 }}>
                <div className="panelHd"><b>未缴{billLabel}</b>{tabArrears ? <span className="tag dang">待缴 {tabBills.length} 笔 · {money(tabArrears / 100)}</span> : <span className="tag ok"><Icon name="check" />无待缴</span>}
                  <button className="btn g sm" style={{ marginLeft: 'auto' }} onClick={() => navigate(`/fees?q=${encodeURIComponent(`${house.buildingNo}/${house.roomNo}`)}`)}><Icon name="plus" size={16} />预缴未来月份</button>
                </div>
                {bills === null ? <div className="empty">正在实时查询 MIS 应收…</div>
                  : billErr ? <div className="card" style={{ padding: 28, textAlign: 'center' }}><span style={{ color: 'var(--dang)' }}>MIS 查询未完成：{billErr}</span><div className="muted" style={{ marginTop: 6, fontSize: 13 }}>不代表无待缴，请稍后重新选择该住户再查</div></div>
                  : tabBills.length === 0 ? <div className="card" style={{ padding: 36, textAlign: 'center' }}><span className="muted">MIS 里这一户没有未缴{billLabel}，缴费明细见下方「历史缴费记录」</span></div>
                    : tabBills.map((b) => {
                      const on = selBills.includes(b.id);
                      return (
                        <button key={b.id} className={`billRow ${on ? 'sel' : ''}`} onClick={() => setSelBills((s) => on ? s.filter((x) => x !== b.id) : [...s, b.id])}>
                          <div className="ck"><Icon name="check" /></div>
                          <div className="bt"><span className="feeCell"><FeeIcon name={b.feeName} size={26} /><b>{b.feeName}{b.period ? ` · ${b.period}` : ''}</b></span><small>收据状态：{b.status === 'unpaid' ? '未缴' : b.status}</small><div className="mis-remark"><span className="mis-remark-label">备注</span><span className="mis-remark-value">{b.remark?.trim() ? b.remark : '—'}</span></div></div>
                          <div className="ba money">{money(b.amountCents / 100)}</div>
                        </button>
                      );
                    })}
                <PaidHistory key={`${house.id}-${tab}`} houseId={house.id} label={billLabel} match={(n) => (tab === 'bw' ? isBerth(n) : !isBerth(n))} />
                <div className="note2" style={{ marginTop: 14 }}><Icon name="alert" />{billLabel}应收为 MIS 实时数据；本次收款条件、本人映射和原单状态见右侧。整月缴纳、不拆月、不减免。未来月份生成协议尚未核实，请在原MIS生成正式应收后刷新，不在PMS猜写账。</div>
              </div>
            ) : null}

            {linkedBlocked ? (tab === 'pk' ? <div className="note2" role="status">本次登记不可收费，真实状态见上方。需要转类 / 撤销请进入本次登记详情。</div> : null) : <div style={{ display: tab === 'pk' ? undefined : 'none' }}>
              <ParkingTab key={`${house.id}-${intakeParam ?? ''}`} house={house} rules={rules as never} onCart={onParkCart} initialPlate={parkPlate} focusedIntake={linkedIntake} />
            </div>}

            {tab === 'ac' ? (
              <div style={{ marginTop: 16 }}>
                <div className="panelHd"><b>该住户的门禁卡</b><span className="tag mute">{cardRule ? `新办/补办 ${money(cardRule.unitPriceCents / 100)}/张` : '未配门禁收费规则'}</span></div>
                {cards.length === 0 ? <div className="muted" style={{ padding: '8px 2px' }}>暂无在用门禁卡</div>
                  : cards.map((c) => (
                    <div key={c.id} className="cardItem"><div className="ci"><Icon name="key" /></div><div className="bt" style={{ flex: 1 }}><b>卡号 {c.cardNo}</b><small className="muted">{c.status || '正常'}</small></div><span className="tag ok"><Icon name="check" />有效</span></div>
                  ))}
                <div className="card" style={{ padding: '14px 16px', marginTop: 12 }}>
                  <div className="side-h" style={{ marginBottom: 10 }}><Icon name="plus" size={18} style={{ color: 'var(--acc-t)' }} />新办 / 补办</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    <button className="btn" onClick={() => setCardQty((n) => Math.max(1, n - 1))}>−</button>
                    <b style={{ fontSize: 20, minWidth: 28, textAlign: 'center' }}>{cardQty}</b>
                    <button className="btn" onClick={() => setCardQty((n) => Math.min(20, n + 1))}>＋</button>
                    <span className="muted">张{cardRule && !cardFree ? ` × ${money(cardRule.unitPriceCents / 100)}` : ''}</span>
                    <button className={`confirmLine ${cardFree ? 'on' : ''}`} style={{ width: 'auto', marginLeft: 'auto', marginBottom: 0 }} onClick={() => setCardFree((v) => !v)}>
                      <div className="ck2"><Icon name="check" /></div>赠卡（0 元，需留理由）
                    </button>
                  </div>
                </div>
                <div className="card" style={{ padding: '14px 16px', marginTop: 12 }}>
                  <div className="side-h" style={{ marginBottom: 10 }}>
                    <Icon name="clock" size={18} style={{ color: 'var(--acc-t)' }} />发卡历史
                    {cardHistory?.length ? <span className="tag mute" style={{ marginLeft: 8 }}>{cardHistory.length} 张</span> : null}
                  </div>
                  {cardHistory === null ? <div className="muted">正在读发卡记录…</div>
                    : cardHistory.length === 0 ? <div className="muted">这一户还没有发卡记录</div>
                      : (
                        <table className="tbl" style={{ marginBottom: 0 }}>
                          <thead><tr><th>序号</th><th>卡号</th><th>发卡时间</th><th>门禁授权</th><th>旧库同步</th></tr></thead>
                          <tbody>
                            {cardHistory.map((h) => (
                              <tr key={h.id} style={{ cursor: 'default' }}>
                                <td>{h.sequence}</td>
                                <td>
                                  <b>{h.icCardNo || h.wgCardNo || '—'}</b>
                                  {h.icCardNo && h.wgCardNo ? <small className="muted"> · WG {h.wgCardNo}</small> : null}
                                </td>
                                <td>{h.issuedAt ? dayjs(h.issuedAt).format('YYYY-MM-DD HH:mm') : '—'}</td>
                                <td><span className={`tag ${accessStatusLabel(h.accessStatus).tone}`} title={rawTitle(h.accessStatus)}>{accessStatusLabel(h.accessStatus).text}</span></td>
                                <td><span className={`tag ${legacyStatusLabel(h.legacySyncStatus).tone}`} title={rawTitle(h.legacySyncStatus)}>{legacyStatusLabel(h.legacySyncStatus).text}</span></td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                </div>
                <div className="note2" style={{ marginTop: 14 }}><Icon name="alert" />卡费不写 MIS，收款后排队写卡 + 写旧系统；赠卡计数量不计收入，单独留审计。</div>
              </div>
            ) : null}
          </div>

          {isBillTab?<MisCollectionPanel key={`${house.id}-${tab}`} houseId={house.id} label={billLabel} bills={selBillRows} loading={bills===null||!!billErr} onSaved={()=>{setSelBills([]);void loadBills(house);}}/>:<div className="card cart2">
            <div className="cartHd"><Icon name="receipt" /><b>本次办理</b><span className="cnt">{isBillTab ? billLabel : tab === 'pk' ? '停车缴费' : '门禁卡'}</span></div>
            <div className="cartBody">
              {isBillTab ? (
                selBillRows.length ? selBillRows.map((b) => (
                  <div className="cartItem" key={b.id}><FeeIcon name={b.feeName} size={34} /><div className="cx"><b>{b.feeName}</b><small>{b.period || billLabel}</small></div><div className="cv money">{money(b.amountCents / 100)}</div></div>
                )) : <div className="cartEmpty"><Icon name="receipt" /><div>勾选左侧要收的账单</div></div>
              ) : tab === 'pk' ? (
                parkCarts.length ? (<>
                  {parkCarts.map((pc) => (
                    <div className="cartItem" key={pc.plate}><div className="xi ic green"><Icon name="car" size={18} /></div><div className="cx"><b>{pc.plate} · {pc.custom ? '自定日期' : `${pc.months} 个月`}{pc.custom ? <span className="tag warn" style={{ marginLeft: 6, height: 20 }}>需经理审核</span> : null}</b><small>{pc.systemsLabel} · {pc.estimate.startDate} → {pc.estimate.endDate}</small></div><div className="cv money">{money(pc.estimate.amountCents / 100)}</div></div>
                  ))}
                  {!parkReady ? <div className="muted" style={{ fontSize: 13, padding: '4px 2px' }}>还有勾选的车没算出金额（缺收费标准、没勾系统，或自定日期没填金额/原因），处理后才能收款</div> : null}
                </>) : <div className="cartEmpty"><Icon name="car" /><div>勾选要缴费的车和续期月份</div></div>
              ) : (
                (cardFree || cardEst) ? (
                  <div className={`cartItem ${cardFree ? 'free' : ''}`}><div className="xi ic amber"><Icon name="key" size={18} /></div><div className="cx"><b>{cardFree ? '赠卡' : '门禁卡'} × {cardQty}</b><small>{cardFree ? '免费 · 需留理由' : '新办 / 补办'}</small></div><div className="cv money">{cardFree ? '¥0' : money((cardEst?.amountCents ?? 0) / 100)}</div></div>
                ) : <div className="cartEmpty"><Icon name="key" /><div>选择新办 / 补办数量</div></div>
              )}
            </div>
            <div className="cartFoot">
              <div className="cartTot"><span className="k">本次应收（{isBillTab ? billLabel : tab === 'pk' ? '停车' : '门禁卡'}）</span><span className="v money">{money(cartTotal / 100)}</span></div>
              <div className="payPick">
                <PayMethods value={pay} onChange={(v) => { setPay(v); setConfirmed(true); }} options={PAYMENTS.map((p) => ({ value: p.k, label: p.k }))} />
              </div>
              {cartTotal > 0 ? (
                <button className={`confirmLine ${confirmed ? 'on' : ''}`} onClick={() => setConfirmed((v) => !v)}><div className="ck2"><Icon name="check" /></div>已收到 <b style={{ margin: '0 4px' }}>{pay} {money(cartTotal / 100)}</b>，确认到账</button>
              ) : null}
              <button className="btn p lg" style={{ width: '100%', justifyContent: 'center' }} disabled={busy || !canCharge || (cartTotal > 0 && !confirmed)} onClick={() => void charge()}>
                <Icon name="check" size={20} />{busy ? '处理中…' : isBillTab ? `应收 ${money(cartTotal / 100)} · 请在物业系统收款` : `确认收款 · ${money(cartTotal / 100)}`}
              </button>
              <div className="muted" style={{ fontSize: 12.5, textAlign: 'center', marginTop: 10 }}>系统只登记收款，后续 MIS / 停车 / 写卡自动执行并核验</div>
            </div>
          </div>}
        </div>
      )}

      <NewOrderSheet
        open={repairOpen}
        onClose={() => setRepairOpen(false)}
        initialHouse={house ? {
          communityId: house.communityId,
          addressText: `${house.communityName} ${house.lane ? `${house.lane}弄` : ''}${house.buildingNo}号${house.roomNo}室`,
          contactName: house.owner?.name,
          contactPhone: house.owner?.phone,
        } satisfies RepairPrefill : null}
        onCreated={() => { setRepairOpen(false); toast('报修已登记，可在工单调度查看'); }}
      />
    </>
  );
}
