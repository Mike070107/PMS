import { useCallback, useEffect, useMemo, useState } from 'react';
import { address, request } from '@pms/api-client';
import type { AddressBuilding, AddressCommunity, AddressHouse } from '@pms/shared-types';
import { sortedBuildings, sortedHouses } from '@pms/shared-types';
import { Btn, Card, ErrorNote, Field, Loading, toast } from '@/components/ui';
import { useSession } from '@/lib/auth';
import { dayjs, money } from '@/lib/format';

type ServiceType = 'parking_monthly' | 'access_card';

interface BusinessRule {
  id: number;
  serviceType: ServiceType;
  name: string;
  communityId: number | null;
  billingUnit: 'month' | 'card';
  unitPriceCents: number;
  enabled: boolean;
}
interface HouseHit {
  id: number;
  roomNo: string;
  lane: string | null;
  buildingNo: string;
  communityId: number | null;
  communityName: string;
  owner: { id: number; name: string | null; phone: string | null } | null;
}
interface Vehicle {
  id: number;
  plateNo: string;
  houseId: number;
  ownerId: number | null;
  validUntil: string | null;
}
interface AccessCard { id: number; cardNo: string; houseId: number; ownerId: number | null; status: string }
interface SearchResult { houses: HouseHit[]; vehicles: Vehicle[]; accessCards: AccessCard[] }
interface Estimate { unitPriceCents: number; quantity: number; startDate: string | null; endDate: string | null; amountCents: number; summary: string }
interface Bill { id: number; feeName: string; period: string; amountCents: number; status: string; roomNo: string }

const PAYMENTS = ['微信', '支付宝', '现金', '转账', '其他'];

/**
 * 收银台：先找到房，再选要收的项目。
 *
 * 停车月租和门禁卡走 /business/* 接口（收费规则、试算、收款都在服务端算）。
 * 物业费账单是另一套（/fees/bills），这里只做欠费提示并给去物业费页的入口——
 * 把两套账合并成一张收据需要后端新增接口，不在这一版里假装能做。
 */
export default function Cashier() {
  const session = useSession();
  const [q, setQ] = useState('');
  const [searching, setSearching] = useState(false);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [house, setHouse] = useState<HouseHit | null>(null);
  const [rules, setRules] = useState<BusinessRule[]>([]);
  const [bills, setBills] = useState<Bill[] | null>(null);
  const [err, setErr] = useState('');

  // 选房号（小区 → 楼栋 → 房号），只在权限范围内列
  const [tree, setTree] = useState<AddressCommunity[] | null>(null);
  const [treeErr, setTreeErr] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [selCommunity, setSelCommunity] = useState<number | 0>(0);
  const [selBuilding, setSelBuilding] = useState<number | 0>(0);
  const [roomFilter, setRoomFilter] = useState('');

  const [pickPark, setPickPark] = useState(false);
  const [vehicleId, setVehicleId] = useState<number | null>(null);
  const [months, setMonths] = useState(3);
  const [pickCard, setPickCard] = useState(false);
  const [cardQty, setCardQty] = useState(1);

  const [parkEst, setParkEst] = useState<Estimate | null>(null);
  const [cardEst, setCardEst] = useState<Estimate | null>(null);
  const [payment, setPayment] = useState(PAYMENTS[0]);
  const [remark, setRemark] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    request<BusinessRule[]>({ url: '/business/rules' })
      .then((r) => setRules(r.filter((x) => x.enabled)))
      .catch(() => undefined);
    // 地址树：服务端按当前身份与「管理处视角」返回可访问的小区/楼栋/房号
    address.tree()
      .then((t) => setTree(t))
      .catch((e) => setTreeErr(e instanceof Error ? e.message : '地址加载失败'));
  }, []);

  /**
   * 权限范围：scopeAll = 不限；否则只允许 communityIds 里的小区。
   * access 还没拉到（老会话）时按「可见」处理，真正的收窄由服务端兜底——
   * 和后台其它页面的 pagePerm 口径一致。
   */
  const allowedIds = useMemo(() => {
    const a = session.access;
    if (!a || a.scopeAll) return null;
    return new Set(a.communityIds ?? []);
  }, [session.access]);

  const communities = useMemo(() => {
    const list = (tree ?? []).filter((c) => !c.isGroup);
    return allowedIds ? list.filter((c) => allowedIds.has(c.id)) : list;
  }, [tree, allowedIds]);

  const buildings = useMemo(
    // 楼栋和房号都按数字排：1、2、3、11、21，不是字典序的 1、10、11、2
    () => sortedBuildings(communities.find((c) => c.id === selCommunity)?.buildings ?? []),
    [communities, selCommunity],
  );

  const roomList = useMemo(() => {
    const b = buildings.find((x) => x.id === selBuilding);
    const list = sortedHouses(b?.houses ?? []);
    const kw = roomFilter.trim();
    if (!kw) return list;
    return list.filter((h) => h.roomNo.includes(kw) || (h.ownerName || '').includes(kw));
  }, [buildings, selBuilding, roomFilter]);

  const scopeLabel = useMemo(() => {
    const a = session.access;
    if (!a) return '按当前账号权限';
    if (a.scopeAll) return '全部管理处';
    if (session.actingOffice?.name) return session.actingOffice.name;
    if (a.communityIds?.length) return `${a.communityIds.length} 个小区`;
    return '未配置数据范围';
  }, [session.access, session.actingOffice]);

  /** 同一个搜索框按两种业务各查一次，合并去重 */
  const searchByQ = useCallback(async (kw: string): Promise<SearchResult> => {
    const [park, card] = await Promise.all([
      request<SearchResult>({ url: '/business/search', query: { q: kw, serviceType: 'parking_monthly' } }),
      request<SearchResult>({ url: '/business/search', query: { q: kw, serviceType: 'access_card' } }),
    ]);
    return {
      houses: [...park.houses, ...card.houses].filter((h, i, arr) => arr.findIndex((x) => x.id === h.id) === i),
      vehicles: [...park.vehicles, ...card.vehicles].filter((v, i, arr) => arr.findIndex((x) => x.id === v.id) === i),
      accessCards: [...park.accessCards, ...card.accessCards].filter((c, i, arr) => arr.findIndex((x) => x.id === c.id) === i),
    };
  }, []);

  const search = useCallback(async () => {
    const kw = q.trim();
    if (!kw) return;
    setSearching(true);
    setErr('');
    try {
      const merged = await searchByQ(kw);
      setResult(merged);
      const first = merged.vehicles[0]?.houseId && merged.houses.find((h) => h.id === merged.vehicles[0].houseId);
      const target = (first || merged.houses[0]) ?? null;
      if (!target && merged.vehicles.length) {
        setErr('查到了车辆，但没有匹配到房号，请在「选房号」里按小区楼栋找一次');
      }
      applyHouse(target, merged);
    } catch (e) {
      setErr(e instanceof Error ? e.message : '查询失败');
    } finally {
      setSearching(false);
    }
  }, [q, searchByQ]);

  const applyHouse = (h: HouseHit | null, from = result) => {
    setHouse(h);
    setPickPark(false);
    setPickCard(false);
    setParkEst(null);
    setCardEst(null);
    setVehicleId(from?.vehicles.find((v) => v.houseId === h?.id)?.id ?? null);
    setBills(null);
    if (!h) return;
    request<{ rows: Bill[] }>({ url: '/fees/bills', query: { q: `${h.buildingNo}/${h.roomNo}`, status: 'unpaid', page: 1, pageSize: 50 } })
      .then((r) => setBills(r.rows.filter((b) => b.roomNo === h.roomNo)))
      .catch(() => setBills([]));
  };

  /**
   * 从地址树里选房号：先按树上的数据把人名/电话带出来，立刻能收费；
   * 再按「楼号/房号」查一次业务数据把车辆和门禁卡补上（查不到不影响收款）。
   */
  const chooseHouse = async (c: AddressCommunity, b: AddressBuilding, h: AddressHouse) => {
    const hit: HouseHit = {
      id: h.id,
      roomNo: h.roomNo,
      lane: b.lane,
      buildingNo: b.buildingNo,
      communityId: c.id,
      communityName: c.name,
      owner: h.ownerId ? { id: h.ownerId, name: h.ownerName ?? null, phone: h.ownerPhone ?? null } : null,
    };
    setPickerOpen(false);
    setQ(`${b.buildingNo}/${h.roomNo}`);
    const only: SearchResult = { houses: [hit], vehicles: [], accessCards: [] };
    setResult(only);
    applyHouse(hit, only);

    try {
      const r = await searchByQ(`${b.buildingNo}/${h.roomNo}`);
      const exact = r.houses.find((x) => x.id === h.id) ?? hit;
      const merged: SearchResult = {
        houses: [exact],
        vehicles: r.vehicles.filter((v) => v.houseId === h.id),
        accessCards: r.accessCards.filter((x) => x.houseId === h.id),
      };
      setResult(merged);
      applyHouse(exact, merged);
    } catch {
      // 车辆/门禁卡查不到就按空处理，房号本身已经选定
    }
  };

  const parkRule = useMemo(
    () => rules.find((r) => r.serviceType === 'parking_monthly' && (r.communityId == null || r.communityId === house?.communityId)),
    [rules, house],
  );
  const cardRule = useMemo(
    () => rules.find((r) => r.serviceType === 'access_card' && (r.communityId == null || r.communityId === house?.communityId)),
    [rules, house],
  );

  const cars = useMemo(() => (result?.vehicles ?? []).filter((v) => v.houseId === house?.id), [result, house]);
  const cards = useMemo(() => (result?.accessCards ?? []).filter((c) => c.houseId === house?.id), [result, house]);
  const arrears = useMemo(() => (bills ?? []).reduce((s, b) => s + b.amountCents, 0), [bills]);

  // 选择变化就重新试算：金额必须由服务端算，端上不自己乘
  useEffect(() => {
    if (!pickPark || !house || !parkRule || !vehicleId) { setParkEst(null); return; }
    let alive = true;
    request<Estimate>({
      method: 'POST', url: '/business/estimate',
      data: { serviceType: 'parking_monthly', ruleId: parkRule.id, houseId: house.id, ownerId: house.owner?.id, vehicleId, plateNo: cars.find((c) => c.id === vehicleId)?.plateNo, months },
    }).then((e) => { if (alive) setParkEst(e); }).catch(() => { if (alive) setParkEst(null); });
    return () => { alive = false; };
  }, [pickPark, house, parkRule, vehicleId, months, cars]);

  useEffect(() => {
    if (!pickCard || !house || !cardRule) { setCardEst(null); return; }
    let alive = true;
    request<Estimate>({
      method: 'POST', url: '/business/estimate',
      data: { serviceType: 'access_card', ruleId: cardRule.id, houseId: house.id, ownerId: house.owner?.id, quantity: cardQty },
    }).then((e) => { if (alive) setCardEst(e); }).catch(() => { if (alive) setCardEst(null); });
    return () => { alive = false; };
  }, [pickCard, house, cardRule, cardQty]);

  const total = (parkEst?.amountCents ?? 0) + (cardEst?.amountCents ?? 0);

  const charge = async () => {
    if (!house || !parkEst && !cardEst) return;
    setBusy(true);
    try {
      if (parkEst && parkRule) {
        await request({
          method: 'POST', url: '/business/complete',
          data: {
            serviceType: 'parking_monthly', ruleId: parkRule.id, houseId: house.id, ownerId: house.owner?.id,
            vehicleId, plateNo: cars.find((c) => c.id === vehicleId)?.plateNo, months,
            paymentMethod: payment, remark: remark || undefined,
          },
        });
      }
      if (cardEst && cardRule) {
        await request({
          method: 'POST', url: '/business/complete',
          data: {
            serviceType: 'access_card', ruleId: cardRule.id, houseId: house.id, ownerId: house.owner?.id,
            quantity: cardQty, paymentMethod: payment, remark: remark || undefined,
          },
        });
      }
      toast(`已收款 ${money(total / 100)}（${payment}）`);
      setPickPark(false);
      setPickCard(false);
      setRemark('');
      void search();
      if (cardEst) toast('门禁卡需去发卡页写卡');
    } catch (e) {
      toast(e instanceof Error ? e.message : '收款失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="ph">
        <div>
          <h1>收银台</h1>
          <p>
            先找到房，再选要收的项目；停车续期与门禁卡当场收款，物业费欠费单独结算
            <span className="pill s-off plain" style={{ marginLeft: 10 }}>数据范围：{scopeLabel}</span>
          </p>
        </div>
        <div className="act">
          <button className="btn" onClick={() => { window.location.href = '/fees'; }}>今日流水 / 红冲</button>
        </div>
      </div>

      {err ? <ErrorNote>{err}</ErrorNote> : null}

      <div className="hsearch" style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
        <input className="in" value={q} placeholder="输房号（228/6/502）、业主姓名、手机号或车牌"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void search(); }} />
        <Btn kind="p" size="lg" disabled={searching} onClick={() => void search()}>{searching ? '查询中…' : '查找'}</Btn>
        <Btn size="lg" onClick={() => setPickerOpen((v) => !v)} disabled={!!treeErr && !tree}>
          {pickerOpen ? '收起选房号' : '选房号'}
        </Btn>
      </div>

      {pickerOpen ? (
        <Card style={{ padding: '16px 18px', marginBottom: 16 }}>
          <div className="sec-t">
            选房号
            <span className="r muted">只列你可以访问的小区 / 楼栋 / 房号</span>
          </div>
          {treeErr ? <ErrorNote>{treeErr}</ErrorNote> : null}
          {tree === null ? <Loading text="加载小区与楼栋…" /> : (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1.1fr', gap: 12 }}>
                <Field label="小区">
                  <select className="in" value={selCommunity}
                    onChange={(e) => { setSelCommunity(Number(e.target.value)); setSelBuilding(0); setRoomFilter(''); }}>
                    <option value={0}>请选择</option>
                    {communities.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </Field>
                <Field label="楼栋">
                  <select className="in" value={selBuilding} disabled={!selCommunity}
                    onChange={(e) => { setSelBuilding(Number(e.target.value)); setRoomFilter(''); }}>
                    <option value={0}>{selCommunity ? '请选择' : '先选小区'}</option>
                    {buildings.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.lane ? `${b.lane}弄${b.buildingNo}号` : `${b.buildingNo}号楼`}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="房号（可输入过滤）">
                  <input className="in" value={roomFilter} disabled={!selBuilding}
                    placeholder="502 或业主姓名"
                    onChange={(e) => setRoomFilter(e.target.value)} />
                </Field>
              </div>

              {!selBuilding ? (
                <div className="muted" style={{ padding: '6px 0' }}>
                  {communities.length ? '选楼栋后列出房号' : '当前账号范围内没有可收费的小区'}
                </div>
              ) : roomList.length ? (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(172px,1fr))', gap: 8, maxHeight: 300, overflow: 'auto', paddingBottom: 4 }}>
                  {roomList.map((h) => {
                    const c = communities.find((x) => x.id === selCommunity);
                    const b = buildings.find((x) => x.id === selBuilding);
                    return (
                      <button key={h.id} className="btn" style={{ justifyContent: 'space-between', height: 48 }}
                        onClick={() => { if (c && b) void chooseHouse(c, b, h); }}>
                        <b>{h.roomNo}</b>
                        <span className="muted" style={{ fontSize: 13.5 }}>{h.ownerName || '空户'}</span>
                      </button>
                    );
                  })}
                </div>
              ) : <div className="empty" style={{ padding: 18 }}>没有匹配的房号</div>}
            </>
          )}
        </Card>
      ) : null}

      {!house ? (
        <Card style={{ padding: '56px 20px' }}>
          <div className="empty">输入房号、姓名、手机号或车牌开始收费</div>
        </Card>
      ) : (
        <div className="cash" style={{ display: 'grid', gridTemplateColumns: '1fr 340px', gap: 16, alignItems: 'start' }}>
          <div>
            <Card style={{ padding: '16px 18px', display: 'flex', alignItems: 'flex-start', gap: 16 }}>
              <div style={{ flex: 1 }}>
                <div className="muted" style={{ fontSize: 14 }}>{house.communityName}</div>
                <h2 style={{ margin: '2px 0 10px', fontSize: 20 }}>
                  {house.buildingNo}/{house.roomNo}
                  <span className="muted" style={{ fontSize: 15, fontWeight: 400, marginLeft: 10 }}>
                    {house.owner?.name || '未登记业主'} · {house.owner?.phone || '无电话'}
                  </span>
                </h2>
                <div className="chips">
                  {bills === null ? <span className="pill s-off">查欠费…</span> : bills.length
                    ? <span className="pill urg">欠物业费 {bills.length} 笔 · {money(arrears / 100)}</span>
                    : <span className="pill s-done">无欠费</span>}
                  {cars.map((c) => {
                    const expired = c.validUntil ? dayjs(c.validUntil).isBefore(dayjs(), 'day') : true;
                    return <span key={c.id} className={`pill ${expired ? 'urg' : 's-off'}`}>{c.plateNo} 到期 {c.validUntil || '—'}</span>;
                  })}
                  <span className="pill s-off">门禁卡 {cards.length} 张</span>
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <Btn size="sm" onClick={() => { window.location.href = '/parking'; }}>车辆与门禁档案</Btn>
                <Btn size="sm" kind="g" onClick={() => { setHouse(null); setResult(null); setQ(''); }}>换一个房号</Btn>
              </div>
            </Card>

            <div className="tiles" style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 10, margin: '14px 0' }}>
              <button className={`tile ${pickPark ? 'on' : ''}`} onClick={() => { setPickPark((v) => !v); setPickCard(false); }}
                style={{ textAlign: 'left', padding: '14px 16px', border: '1px solid var(--line)', borderRadius: 10, background: pickPark ? 'var(--acc-w)' : '#fff' }}>
                <b style={{ display: 'block' }}>停车月租</b>
                <span className="muted" style={{ fontSize: 14 }}>{parkRule ? `${money(parkRule.unitPriceCents / 100)} / 月` : '未配收费规则'}</span>
              </button>
              <button className={`tile ${pickCard ? 'on' : ''}`} onClick={() => { setPickCard((v) => !v); setPickPark(false); }}
                style={{ textAlign: 'left', padding: '14px 16px', border: '1px solid var(--line)', borderRadius: 10, background: pickCard ? 'var(--acc-w)' : '#fff' }}>
                <b style={{ display: 'block' }}>门禁卡</b>
                <span className="muted" style={{ fontSize: 14 }}>{cardRule ? `${money(cardRule.unitPriceCents / 100)} / 张` : '未配收费规则'}</span>
              </button>
              <button className="tile" onClick={() => { window.location.href = `/fees?q=${encodeURIComponent(`${house.buildingNo}/${house.roomNo}`)}`; }}
                style={{ textAlign: 'left', padding: '14px 16px', border: '1px solid var(--line)', borderRadius: 10, background: '#fff' }}>
                <b style={{ display: 'block' }}>物业费</b>
                <span className="muted" style={{ fontSize: 14 }}>{bills?.length ? `欠 ${bills.length} 笔 · ${money(arrears / 100)}` : '无欠费'} · 去账单页收</span>
              </button>
            </div>

            {pickPark ? (
              <Card style={{ padding: '14px 16px' }}>
                <div className="sec-t">停车续期<Btn size="sm" kind="g" onClick={() => setPickPark(false)}>移除</Btn></div>
                {cars.length ? (
                  <>
                    <div className="chips" style={{ marginBottom: 10 }}>
                      {cars.map((c) => (
                        <button key={c.id} className={`chip ${vehicleId === c.id ? 'on' : ''}`} onClick={() => setVehicleId(c.id)}>{c.plateNo}</button>
                      ))}
                    </div>
                    <div className="chips" style={{ marginBottom: 10 }}>
                      {[1, 3, 6, 12].map((m) => (
                        <button key={m} className={`chip ${months === m ? 'on' : ''}`} onClick={() => setMonths(m)}>{m} 个月</button>
                      ))}
                    </div>
                    <div className="note">
                      {parkEst ? `${parkEst.summary} · 续至 ${parkEst.endDate || '—'}` : '未配收费规则的房号无法续期，请先在系统设置里配置。'}
                    </div>
                  </>
                ) : <div className="empty" style={{ padding: 18 }}>这个房号下没有登记车辆</div>}
              </Card>
            ) : null}

            {pickCard ? (
              <Card style={{ padding: '14px 16px', marginTop: 12 }}>
                <div className="sec-t">门禁卡<Btn size="sm" kind="g" onClick={() => setPickCard(false)}>移除</Btn></div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <Btn size="sm" onClick={() => setCardQty((n) => Math.max(1, n - 1))}>−</Btn>
                  <b style={{ fontSize: 18 }}>{cardQty}</b>
                  <Btn size="sm" onClick={() => setCardQty((n) => Math.min(20, n + 1))}>＋</Btn>
                  <span className="muted">张{cardRule ? ` × ${money(cardRule.unitPriceCents / 100)}` : ''} · 收款后去发卡页写卡</span>
                </div>
              </Card>
            ) : null}
          </div>

          <Card style={{ padding: '16px 18px', position: 'sticky', top: 16 }}>
            <div className="sec-t">本次收费<span className="r muted">{house.buildingNo}/{house.roomNo}</span></div>
            {pickPark && parkEst ? <div className="ln" style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0' }}><span>停车月租 · {months} 个月</span><b>{money(parkEst.amountCents / 100)}</b></div> : null}
            {pickCard && cardEst ? <div className="ln" style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0' }}><span>门禁卡 × {cardQty}</span><b>{money(cardEst.amountCents / 100)}</b></div> : null}
            {!parkEst && !cardEst ? <div className="muted" style={{ padding: '20px 0' }}>选择左侧收费项目</div> : null}

            <div className="tot" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', borderTop: '1px solid var(--line)', marginTop: 10, paddingTop: 10 }}>
              <span className="sub">合计</span><b style={{ fontSize: 22 }}>{money(total / 100)}</b>
            </div>

            <div className="pays" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '12px 0' }}>
              {PAYMENTS.map((p) => (
                <button key={p} className={`chip ${payment === p ? 'on' : ''}`} onClick={() => setPayment(p)}>{p}</button>
              ))}
            </div>

            <Field label="备注（选填）">
              <input className="in" value={remark} onChange={(e) => setRemark(e.target.value)} />
            </Field>

            <button className="btn p lg" style={{ width: '100%', justifyContent: 'center' }} disabled={busy || (!parkEst && !cardEst)} onClick={() => void charge()}>
              {busy ? '收款中…' : '收款'}
            </button>

            <p className="muted" style={{ fontSize: 13.5, marginTop: 10 }}>
              退款走「红冲」：在物业费/收费流水里对原收据整单红冲，原收据保留。
              {arrears ? <> 本房还有物业费欠款 {money(arrears / 100)}，需在账单页单独收。</> : null}
            </p>
          </Card>
        </div>
      )}

      {searching ? <Loading text="查询中…" /> : null}
    </>
  );
}
