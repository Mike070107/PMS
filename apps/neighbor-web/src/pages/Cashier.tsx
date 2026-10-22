import { useCallback, useEffect, useMemo, useState } from 'react';
import { request } from '@pms/api-client';
import { Btn, Card, ErrorNote, Field, Loading, toast } from '@/components/ui';
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
  const [q, setQ] = useState('');
  const [searching, setSearching] = useState(false);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [house, setHouse] = useState<HouseHit | null>(null);
  const [rules, setRules] = useState<BusinessRule[]>([]);
  const [bills, setBills] = useState<Bill[] | null>(null);
  const [err, setErr] = useState('');

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
  }, []);

  const search = useCallback(async () => {
    const kw = q.trim();
    if (!kw) return;
    setSearching(true);
    setErr('');
    try {
      // 两种业务各查一次：同一个搜索框要能同时找出房和车牌
      const [park, card] = await Promise.all([
        request<SearchResult>({ url: '/business/search', query: { q: kw, serviceType: 'parking_monthly' } }),
        request<SearchResult>({ url: '/business/search', query: { q: kw, serviceType: 'access_card' } }),
      ]);
      const merged: SearchResult = {
        houses: [...park.houses, ...card.houses].filter((h, i, arr) => arr.findIndex((x) => x.id === h.id) === i),
        vehicles: [...park.vehicles, ...card.vehicles].filter((v, i, arr) => arr.findIndex((x) => x.id === v.id) === i),
        accessCards: [...park.accessCards, ...card.accessCards].filter((c, i, arr) => arr.findIndex((x) => x.id === c.id) === i),
      };
      setResult(merged);
      const first = merged.vehicles[0]?.houseId && merged.houses.find((h) => h.id === merged.vehicles[0].houseId);
      const target = (first || merged.houses[0]) ?? null;
      applyHouse(target, merged);
    } catch (e) {
      setErr(e instanceof Error ? e.message : '查询失败');
    } finally {
      setSearching(false);
    }
  }, [q]);

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
          <p>先找到房，再选要收的项目；停车续期与门禁卡当场收款，物业费欠费单独结算</p>
        </div>
        <div className="act">
          <button className="btn" onClick={() => { window.location.href = '/fees'; }}>今日流水 / 红冲</button>
        </div>
      </div>

      {err ? <ErrorNote>{err}</ErrorNote> : null}

      <div className="hsearch" style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
        <input className="in" value={q} placeholder="房号（228/6/502）、业主姓名、手机号或车牌"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void search(); }} />
        <Btn kind="p" size="lg" disabled={searching} onClick={() => void search()}>{searching ? '查询中…' : '查找'}</Btn>
      </div>

      {!house ? (
        <Card style={{ padding: '56px 20px' }}>
          <div className="empty">输入房号、姓名、手机号或车牌开始收费</div>
        </Card>
      ) : (
        <div className="cash" style={{ display: 'grid', gridTemplateColumns: '1fr 340px', gap: 16, alignItems: 'start' }}>
          <div>
            <Card style={{ padding: '16px 18px', display: 'flex', alignItems: 'flex-start', gap: 16 }}>
              <div style={{ flex: 1 }}>
                <div className="muted" style={{ fontSize: 12.5 }}>{house.communityName}</div>
                <h2 style={{ margin: '2px 0 10px', fontSize: 20 }}>
                  {house.buildingNo}/{house.roomNo}
                  <span className="muted" style={{ fontSize: 14, fontWeight: 400, marginLeft: 10 }}>
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
                <span className="muted" style={{ fontSize: 12.5 }}>{parkRule ? `${money(parkRule.unitPriceCents / 100)} / 月` : '未配收费规则'}</span>
              </button>
              <button className={`tile ${pickCard ? 'on' : ''}`} onClick={() => { setPickCard((v) => !v); setPickPark(false); }}
                style={{ textAlign: 'left', padding: '14px 16px', border: '1px solid var(--line)', borderRadius: 10, background: pickCard ? 'var(--acc-w)' : '#fff' }}>
                <b style={{ display: 'block' }}>门禁卡</b>
                <span className="muted" style={{ fontSize: 12.5 }}>{cardRule ? `${money(cardRule.unitPriceCents / 100)} / 张` : '未配收费规则'}</span>
              </button>
              <button className="tile" onClick={() => { window.location.href = `/fees?q=${encodeURIComponent(`${house.buildingNo}/${house.roomNo}`)}`; }}
                style={{ textAlign: 'left', padding: '14px 16px', border: '1px solid var(--line)', borderRadius: 10, background: '#fff' }}>
                <b style={{ display: 'block' }}>物业费</b>
                <span className="muted" style={{ fontSize: 12.5 }}>{bills?.length ? `欠 ${bills.length} 笔 · ${money(arrears / 100)}` : '无欠费'} · 去账单页收</span>
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

            <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>
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
