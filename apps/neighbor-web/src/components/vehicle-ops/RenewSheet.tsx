import DateInput from '@/components/DateInput';
import OwnerBusinessContact from '@/components/OwnerBusinessContact';
import { useEffect, useMemo, useRef, useState } from 'react';
import { accessCardIssuance, request } from '@pms/api-client';
import type { ParkingQueryRow, DeliyunVehicle, ParkingOperation } from '@pms/api-client/src/endpoints/access-card-issuance';
import { Sheet, toast } from '@/components/ui';
import Icon from '@/components/Icon';
import { dayjs } from '@/lib/format';
import { field, vehicleIdentity, garageState, GARAGES, normPlate } from '@/lib/parking-fields';
import { createIdempotencyKey, renewalEndDate, allocateRenewalAmounts, submitAndPoll, type OpOutcome } from '@/lib/parking-ops';
import RenewalMonths from '@/components/cashier/RenewalMonths';

type CloudState = 'loading' | DeliyunVehicle | null | undefined;
interface FeeCommunity { id: number; name: string }
interface FeeRule { id: number; communityId: number | null; serviceType: string; enabled: boolean; name: string; unitPriceCents: number; config?: { vehicleClass?: string; parkingTarget?: string; parkingTargets?: string[] } | null }
interface FeeQuote { quantity: number; amountCents: number; startDate: string; endDate: string }

interface RenewalPlan {
  batch: string; plate: string; endDate: string; months: number;
  locals: Array<{ database: 'parking1' | 'parking2'; pid: string; amount: number; id?: number; status?: string }>;
  civil: { vehicleId: string; previousEndDate: string; id?: number; status?: string } | null;
}
const journalKey = (plate: string) => `pms-parking-renewal-v1:${normPlate(plate)}`;
function loadPlan(plate: string): RenewalPlan | null {
  try { return JSON.parse(window.localStorage.getItem(journalKey(plate)) || 'null'); } catch { return null; }
}
function storePlan(plan: RenewalPlan) {
  // Store before any request; a lost POST response must remain locked even after reopening.
  window.localStorage.setItem(journalKey(plan.plate), JSON.stringify(plan));
}
const wait = (ms: number) => new Promise<void>(resolve => window.setTimeout(resolve, ms));
async function freshRows(plate: string): Promise<ParkingQueryRow[]> {
  let q = await accessCardIssuance.createParkingQuery(plate);
  for (let i = 0; q.status !== 'completed' && q.status !== 'failed' && i < 30; i++) {
    await wait(500); q = await accessCardIssuance.parkingQuery(q.id);
  }
  if (q.status !== 'completed') throw new Error(q.error || '写后读回仍在等待，不能确认续期成功');
  return q.rows.filter(row => normPlate(field(row.fields, 'plate')) === normPlate(plate));
}

function pidOf(f: ParkingQueryRow['fields']): string {
  const k = Object.keys(f).find((key) => /^pid$/i.test(key.replace(/[\s_\-]/g, '')));
  return k && f[k] != null ? String(f[k]) : '';
}
function ymd(v: string): string {
  return v && dayjs(v).isValid() ? dayjs(v).format('YYYY-MM-DD') : '';
}
const dbName = (db: string) => (db === 'parking1' ? '一期库' : db === 'parking2' ? '二期库' : db);

/** 续期收费：按费率表选月数计价，一二期库一起续到同一到期日（只在第一库记收款），人防随后同步 */
export default function RenewSheet({
  plate, rows, cloud, onClose, onDone, garage, initialCommunityId,
}: {
  plate: string;
  rows: ParkingQueryRow[];
  cloud: CloudState;
  onClose: () => void;
  onDone: (verifiedEndDate: string) => void;
  garage?: 'main' | 'civil';
  initialCommunityId?: number | null;
}) {
  const [rules, setRules] = useState<FeeRule[]>([]);
  const [communities, setCommunities] = useState<FeeCommunity[]>([]);
  const [communityId, setCommunityId] = useState<number | null>(null);
  const [ruleId, setRuleId] = useState<number | null>(null);
  const [quote, setQuote] = useState<{ key: string; value: FeeQuote } | null>(null);
  const [quoteError, setQuoteError] = useState('');
  const quoteGeneration = useRef(0);
  const [ratesErr, setRatesErr] = useState('');
  const [months, setMonths] = useState(1);
  const [monthsValid, setMonthsValid] = useState(true);
  const [amountStr, setAmountStr] = useState('');
  const [endOverride, setEndOverride] = useState('');
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [err, setErr] = useState('');
  const submitted = useRef(!!loadPlan(plate));
  const planRef = useRef<RenewalPlan | null>(loadPlan(plate));
  const recoveryLock = useRef(false);
  const [canRetryCivil, setCanRetryCivil] = useState(false);

  useEffect(() => {
    let alive = true;
    Promise.all([
      request<FeeRule[]>({ url: '/business/rules', query: { serviceType: 'parking_monthly' } }),
      request<FeeCommunity[]>({ url: '/business/communities' }),
    ]).then(([rs, cs]) => {
      if (!alive) return;
      setRules(rs); setCommunities(cs); setCommunityId(initialCommunityId != null && cs.some(c => c.id === initialCommunityId) ? initialCommunityId : cs.length === 1 ? cs[0].id : null);
    }).catch(() => { if (alive) setRatesErr('车辆类别和收费标准读取失败，请关闭后重试'); });
    return () => { alive = false; };
  }, []);

  const identity = vehicleIdentity(field(rows[0]?.fields, 'identity'));
  const pmsContact = rows.find(r => r.pmsMatch?.houseId)?.pmsMatch;
  // 旧库身份只作资料展示，收费类别由本次明确选择的规则决定。
  const targets = useMemo(() => rows.filter(r =>
    normPlate(field(r.fields, 'plate')) === normPlate(plate) && !!pidOf(r.fields) &&
    GARAGES.some(g => g.db === r.database && garageState([r], g).authorized)), [rows, plate]);
  const localBaseEnd = useMemo(() => {
    const ends = targets.map((r) => ymd(field(r.fields, 'expiry'))).filter(Boolean).sort();
    return ends.length ? ends[ends.length - 1] : '';
  }, [targets]);

  const context = JSON.stringify([plate, targets, identity]);
  const [formContext, setFormContext] = useState(context);
  useEffect(() => {
    setFormContext(context); setMonths(1); setMonthsValid(true); setAmountStr(''); setEndOverride(''); setErr(''); setLog([]);
    planRef.current = loadPlan(plate); submitted.current = !!planRef.current; setCanRetryCivil(false);
    if (submitted.current) setErr('这张车牌有已提交的续期，先核对原任务；结果未知时禁止重新收费。');
    setRuleId(null); setQuote(null); setQuoteError(''); quoteGeneration.current++;
  }, [context]);
  const applicableRules = rules.filter(r => r.enabled && r.serviceType === 'parking_monthly' && communityId != null && (r.communityId == null || r.communityId === communityId) && (() => {
    const keys = r.config?.parkingTargets ?? (r.config?.parkingTarget ? [r.config.parkingTarget] : []);
    return !keys.length || targets.some(t => GARAGES.some(g => g.db === t.database && garageState([t], g).authorized && keys.includes(g.key === 'phase1' ? 'local:phase1_parking' : g.key === 'phase2' ? 'local:phase2_parking' : 'local:phase2_main_garage'))) || !!(cloud && cloud !== 'loading' && cloud.civilDefenseAuthorized && keys.includes('deliyun:枫桦景苑'));
  })());
  const selectedRule = applicableRules.find(r => r.id === ruleId) ?? null;
  const cloudKnown = cloud !== undefined && cloud !== 'loading';
  const civil = cloudKnown && cloud ? (cloud as DeliyunVehicle) : null;

  // 人防（德立云）只服务二期人防车库：这辆车没开人防就直接续旧库，不等人防状态、不碰德立云
  const [syncCivil, setSyncCivil] = useState(false);
  useEffect(() => { setSyncCivil(!!civil?.civilDefenseAuthorized); }, [civil?.civilDefenseAuthorized]);
  const civilEnd = syncCivil && civil?.civilDefenseAuthorized ? ymd(civil.endDate || '') : '';
  const baseEnd = [localBaseEnd, civilEnd].filter(Boolean).sort().pop() || '';
  const newEnd = endOverride || renewalEndDate(baseEnd || undefined, months);
  const quoteKey = JSON.stringify([context, communityId, selectedRule, months, monthsValid, baseEnd]);
  const currentQuoteKey = useRef(quoteKey);
  if (currentQuoteKey.current !== quoteKey) { currentQuoteKey.current = quoteKey; quoteGeneration.current++; }
  useEffect(() => {
    const generation = ++quoteGeneration.current;
    setQuote(null); setQuoteError('');
    if (!selectedRule || !monthsValid) return;
    let alive = true;
    request<FeeQuote>({ method: 'POST', url: '/business/estimate', data: { serviceType: 'parking_monthly', ruleId: selectedRule.id, plateNo: plate, months, currentEndDate: baseEnd || undefined } })
      .then(value => {
        if (!alive || generation !== quoteGeneration.current) return;
        if (value.quantity !== months || !Number.isSafeInteger(value.amountCents) || value.amountCents < 0) { setQuoteError('试算结果与当前月份不一致，请重新选择'); return; }
        setQuote({ key: quoteKey, value });
      }).catch(() => { if (alive && generation === quoteGeneration.current) setQuoteError('当前类别和月份试算失败，请重新选择或核对收费标准'); });
    return () => { alive = false; };
  }, [quoteKey]);
  const rateAmount = quote?.key === quoteKey ? quote.value.amountCents / 100 : null;
  const manualAmount = amountStr.trim() !== '';
  const amount = manualAmount ? (/^\d+(?:\.\d{1,2})?$/.test(amountStr) ? Number(amountStr) : NaN) : endOverride ? null : rateAmount;
  const selectRule = (value: string) => { quoteGeneration.current++; setRuleId(value ? Number(value) : null); setQuote(null); setQuoteError(''); setAmountStr(''); setEndOverride(''); };

  const entryAuthorized = !garage || (garage === 'main' ? garageState(rows, GARAGES.find(g => g.key === 'main')!).authorized : !!civil?.civilDefenseAuthorized);
  const canSubmit = !!selectedRule && entryAuthorized && cloudKnown && (garage !== 'civil' || syncCivil) && new Set(targets.map(t => t.database)).size === targets.length && formContext === context && targets.length > 0 && !running && !submitted.current && monthsValid && Number.isInteger(months) && months >= 1 && months <= 60 && amount !== null && Number.isFinite(amount) && amount >= 0 && amount <= 1000000 && /^\d{4}-\d{2}-\d{2}$/.test(newEnd) && dayjs(newEnd).isValid() && dayjs(newEnd).format('YYYY-MM-DD') === newEnd && (!baseEnd || newEnd > baseEnd);

  const verify = async (plan: RenewalPlan) => {
    const readback = await freshRows(plan.plate);
    for (const t of plan.locals) {
      const row = readback.find(r => r.database === t.database && pidOf(r.fields) === t.pid);
      if (!row || !GARAGES.some(g => g.db === row.database && garageState([row], g).authorized) || ymd(field(row.fields, 'expiry')) !== plan.endDate) throw new Error(`${dbName(t.database)}读回日期不一致，结果待核对，勿重复收费`);
    }
    if (plan.civil) {
      const cloudRows = await accessCardIssuance.deliyunVehiclesByPlate(plan.plate);
      const hit = cloudRows.rows.find(r => r.id === plan.civil!.vehicleId && normPlate(r.plate) === normPlate(plan.plate));
      if (!hit?.civilDefenseAuthorized || ymd(hit.endDate || '') !== plan.endDate) throw new Error('人防读回日期或授权不一致，结果待核对，勿重复收费');
    }
    window.localStorage.removeItem(journalKey(plan.plate));
    setLog(l => [...l, `全部已完成并读回核对到 ${plan.endDate}`]);
    toast(`已续期并读回到 ${plan.endDate}`); onDone(plan.endDate);
  };

  const validateLocal = (op: ParkingOperation, target: RenewalPlan['locals'][number], plan: RenewalPlan) => {
    if (!Number.isFinite(target.amount) || !op.payload || op.payload.endDate !== plan.endDate || Number(op.payload.amount) !== target.amount)
      throw new Error(`原任务 #${op.id} 的日期或金额与原提交不一致，必须到办理记录人工核对，不会解锁或再次收费`);
  };

  const checkOriginal = async () => {
    const plan = planRef.current; if (!plan || running || recoveryLock.current) return;
    recoveryLock.current = true; setRunning(true); setErr('');
    try {
      let complete = true;
      for (const t of [...plan.locals, ...(plan.civil ? [plan.civil] : [])]) {
        if (t.id == null) { complete = false; continue; }
        const op = await accessCardIssuance.parkingOperation(t.id);
        const local = plan.locals.find(target => target === t);
        if (local) validateLocal(op, local, plan);
        else if (!op.payload || op.payload.endDate !== plan.endDate) throw new Error(`原人防任务 #${op.id} 日期不一致，必须人工核对`);
        t.status = op.status;
        setLog(l => [...l, `原任务 #${op.id}：${op.status}`]);
        if (op.status !== 'completed') complete = false;
      }
      storePlan(plan);
      setCanRetryCivil(plan.locals.every(t => t.status === 'completed') && plan.civil?.status === 'failed');
      if (!complete) throw new Error('原任务未全部完成，或提交响应丢失无任务号；请在办理记录核对，禁止重新收费。');
      await verify(plan);
    } catch (e) { setErr(e instanceof Error ? e.message : '核对失败，保留原任务'); }
    finally { recoveryLock.current = false; setRunning(false); }
  };

  const syncCloud = async (plan: RenewalPlan, retry = false) => {
    if (!plan.civil) return;
    // A failed response may still have changed the device. Read before any human-requested retry.
    const live = await accessCardIssuance.deliyunVehiclesByPlate(plan.plate);
    const hit = live.rows.find(r => r.id === plan.civil!.vehicleId && normPlate(r.plate) === normPlate(plan.plate));
    if (!hit?.civilDefenseAuthorized) throw new Error('人防当前未授权，不执行续期或新授权');
    if (ymd(hit.endDate || '') === plan.endDate) { plan.civil.status = 'completed'; storePlan(plan); return; }
    if (ymd(hit.endDate || '') !== plan.civil.previousEndDate) throw new Error('人防当前日期已改变，停止补办，请人工核对');
    plan.civil.status = 'submitting'; storePlan(plan);
    const op: ParkingOperation = await accessCardIssuance.renewDeliyunVehicle({
      vehicleId: hit.id, plate: plan.plate, previousEndDate: plan.civil.previousEndDate,
      endDate: plan.endDate, idempotencyKey: retry ? `${plan.batch}-deliyun-retry-${createIdempotencyKey()}` : `${plan.batch}-deliyun`,
    });
    plan.civil.id = op.id; plan.civil.status = op.status; storePlan(plan);
    if (op.status !== 'completed') {
      setCanRetryCivil(op.status === 'failed');
      throw new Error(`人防任务 #${op.id} ${op.status === 'failed' ? '失败' : '等待或结果未知'}：${op.error || '请核对原任务'}。旧库不重复续费，只处理人防。`);
    }
    setLog(l => [...l, `人防任务 #${op.id} 已完成，正在读回…`]);
  };

  const retryCivil = async () => {
    const plan = planRef.current;
    if (running || recoveryLock.current || !canRetryCivil || !plan?.civil || !plan.locals.every(t => t.status === 'completed')) return;
    recoveryLock.current = true; setRunning(true); setCanRetryCivil(false); setErr('');
    try { await syncCloud(plan, true); await verify(plan); }
    catch (e) { setErr(e instanceof Error ? e.message : '人防补办结果未知，请核对原任务'); }
    finally { recoveryLock.current = false; setRunning(false); }
  };

  const run = async () => {
      if (submitted.current || running) return;
      setErr('');
    if (!canSubmit) { setErr('请核对月份、到期日和金额；未配置档位可手工填写金额，免费办理请明确填写 0'); return; }
    if (!targets.length) { setErr('这张车牌不在一期/二期旧库里，无法续期'); return; }
    if (syncCivil && civil?.civilDefenseAuthorized && civil.endDate && dayjs(newEnd).isBefore(dayjs(ymd(civil.endDate)))) {
      setErr(`新到期日 ${newEnd} 早于人防到期日 ${ymd(civil.endDate)}，请核对`); return;
    }
    if (amount === null || !Number.isFinite(amount) || amount < 0) { setErr('金额不对'); return; }
    if (loadPlan(plate)) { submitted.current = true; planRef.current = loadPlan(plate); setErr('已有提交，先核对原任务，禁止重复收费'); return; }
    // Same plate/window uses the same server idempotency key even across tabs.
    const batch = `pms-renew-v1-${normPlate(plate)}-${baseEnd || 'none'}-${newEnd}`;
    const amounts = allocateRenewalAmounts(amount, targets.length);
    const plan: RenewalPlan = { batch, plate, endDate: newEnd, months,
      locals: targets.map((t, i) => ({ database: t.database as 'parking1' | 'parking2', pid: pidOf(t.fields), amount: amounts[i] })),
      civil: syncCivil && civil?.civilDefenseAuthorized ? { vehicleId: civil.id, previousEndDate: ymd(civil.endDate || '') } : null };
    try { storePlan(plan); } catch { setErr('无法保存防重复办理记录，未提交，请检查浏览器存储设置'); return; }
    planRef.current = plan; submitted.current = true;
    setRunning(true); setLog([]);
    try {
      for (let i = 0; i < targets.length; i += 1) {
        const t = targets[i];
        const db = t.database as 'parking1' | 'parking2';
        setLog((l) => [...l, `正在续 ${dbName(db)}…`]);
        const outcome: OpOutcome = await submitAndPoll({
          database: db,
          kind: 'renew_vehicle',
          sourceRecordId: pidOf(t.fields) || undefined,
          idempotencyKey: `${batch}-${db}-${pidOf(t.fields)}`,
          payload: {
            plate,
            endDate: newEnd,
            previousEndDate: ymd(field(t.fields, 'expiry')),
            amount: amounts[i],
            months,
            identity,
            vehicleClass: selectedRule!.config?.vehicleClass || selectedRule!.name,
            ruleId: selectedRule!.id,
            communityId,
            customEndDate: !!endOverride,
          },
        }, op => {
          plan.locals[i].id = op.id; plan.locals[i].status = op.status; storePlan(plan);
          validateLocal(op, plan.locals[i], plan);
        });
        if (outcome.kind === 'failed') { setErr(`${dbName(db)} 原任务 #${outcome.operation.id} 续期失败：${outcome.error}；保留输入，请核对原任务，勿重复收费`); setLog((l) => [...l, `✗ ${dbName(db)} 失败`]); setRunning(false); return; }
        if (outcome.kind === 'timeout') { setErr(`${dbName(db)} 现场网关响应超时，任务已保留，请稍后在办理记录查看，勿重复续期`); setLog((l) => [...l, `… ${dbName(db)} 超时，任务保留`]); setRunning(false); return; }
        setLog((l) => [...l, `✓ ${dbName(db)} 已续到 ${newEnd}`]);
      }
      await syncCloud(plan);
      setLog(l => [...l, '任务完成，正在发起独立读回核对…']);
      await verify(plan);
    } catch (e) {
      setErr(`${e instanceof Error ? e.message : '提交结果未知'}。原提交已保留，先核对原任务，勿重复续期或收费。`);
    } finally {
      setRunning(false);
    }
  };

  return (
    <Sheet open onClose={() => (running ? null : onClose())} title={`续期收费 · ${plate}`}
      subtitle={`${identity} · ${targets.map((t) => dbName(t.database)).join(' + ') || '不在旧库'}`} width={560}>
      <div style={{ padding: '4px 2px', minWidth: 0, overflowWrap: 'anywhere' }}>
        {pmsContact?.houseId ? <OwnerBusinessContact key={pmsContact.houseId} houseId={pmsContact.houseId} preferredOwnerId={pmsContact.userId} source="parking" disabled={running || submitted.current} /> : null}
        {ratesErr ? <div className="note" style={{ background: 'var(--dang-w)', color: 'var(--dang)' }}>{ratesErr}</div> : null}

        <label style={{ display: 'block', marginBottom: 12 }}>适用小区
          <select className="in" aria-label="续期适用小区" style={{ width: '100%', marginTop: 6 }} value={communityId ?? ''} disabled={running || submitted.current} onChange={e => { setCommunityId(e.target.value ? Number(e.target.value) : null); selectRule(''); }}>
            <option value="">请选择小区</option>{communities.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <label style={{ display: 'block', marginBottom: 12 }}>车辆类别（决定收费标准）
          <select className="in" aria-label="续期车辆类别" style={{ width: '100%', marginTop: 6 }} value={selectedRule?.id ?? ''} disabled={running || submitted.current || communityId == null} onChange={e => selectRule(e.target.value)}>
            <option value="">请先选择车辆类别</option>{applicableRules.map(r => <option key={r.id} value={r.id}>{r.config?.vehicleClass || r.name}</option>)}
          </select>
        </label>
        <div className="muted" style={{ fontSize: 13, marginBottom: 6 }}>续期月数</div>
        <RenewalMonths value={months} disabled={running || submitted.current || !selectedRule} onValidityChange={setMonthsValid}
          onChange={m => { quoteGeneration.current++; setQuote(null); setMonths(m); setMonthsValid(true); setAmountStr(''); setEndOverride(''); }} />

        <div className="veh-dl" style={{ gridTemplateColumns: 'auto 1fr', gap: '10px 12px', marginBottom: 14 }}>
          <dt className="muted">当前到期</dt><dd>{baseEnd || '—（按10号及自然月末规则）'}</dd>
          <dt className="muted">续到</dt>
          <dd style={{ minWidth: 0 }}><DateInput className="in" aria-label="续期结束日期" type="date" disabled={running || submitted.current} value={newEnd} onChange={(e) => { setEndOverride(e.target.value); setAmountStr(''); }} style={{ width: '100%', maxWidth: 180 }} /></dd>
          <dt className="muted">实收金额</dt>
          <dd style={{ display: 'flex', flexWrap: 'wrap', minWidth: 0, alignItems: 'center', gap: 6 }}>
            ¥<input className="in" aria-label="续期实收金额" disabled={running || submitted.current} value={amountStr} onChange={(e) => setAmountStr(e.target.value)}
              placeholder={rateAmount === null ? '请明确填写' : String(rateAmount)} style={{ width: 120 }} inputMode="decimal" />
            <span className="muted" style={{ fontSize: 12 }}>{endOverride ? '自定义日期：请明确填写本次实收金额，0元请填0；月份快捷可恢复规则日期。' : !selectedRule ? '先选择车辆类别' : quoteError || (rateAmount === null ? '正在按所选类别试算…' : `标准 ¥${rateAmount}（${selectedRule.config?.vehicleClass || selectedRule.name}）`)}</span>
          </dd>
        </div>

        {/* 人防只在开通时才有意义：没开通就不查、不等、不写德立云 */}
        {civil?.civilDefenseAuthorized ? (
          <label className="note" style={{ marginBottom: 12, display: 'flex', gap: 8, alignItems: 'flex-start', background: 'var(--bg)', color: 'var(--ink2)', fontSize: 13, cursor: 'pointer' }}>
            <input type="checkbox" disabled={running || submitted.current || garage === 'civil'} checked={syncCivil} onChange={(e) => setSyncCivil(e.target.checked)} style={{ marginTop: 2 }} />
            <span>这辆车开通了二期人防车库（当前到期 {ymd(civil.endDate || '') || '未知'}）。勾选会把德立云一并续到 {newEnd}；不勾选只续旧库。</span>
          </label>
        ) : (
          <div className="note" style={{ marginBottom: 12, background: 'var(--bg)', color: 'var(--ink2)', fontSize: 13 }}>
            {!cloudKnown ? '人防状态未查明，本次只续旧库（一期/二期停车库）；不需要等它。' : '该车未开通二期人防车库，只续旧库，不写德立云。'}
          </div>
        )}

        {targets.length > 1 ? (
          <div className="muted" style={{ fontSize: 12.5, marginBottom: 12 }}>一期二期都有这张牌，会一起续到同一到期日，收款只记一笔（在第一库）。</div>
        ) : null}

        {log.length ? (
          <div className="card" style={{ padding: '10px 12px', marginBottom: 12, background: 'var(--bg)' }}>
            {log.map((line, i) => <div key={i} style={{ fontSize: 13, lineHeight: 1.9 }}>{line}</div>)}
          </div>
        ) : null}

        {!entryAuthorized || new Set(targets.map(t => t.database)).size !== targets.length ? <div role="alert" className="note">当前入口未授权或查询记录不唯一，不能收费，请先核对车辆。</div> : null}
        {err ? <div role="alert" className="note" style={{ background: 'var(--dang-w)', color: 'var(--dang)', marginBottom: 12 }}>{err}</div> : null}
        {submitted.current ? <div className="note" style={{ marginBottom: 12 }}>
          <div>已提交结果不会自动重发。关闭或重新打开仍保留防重复锁；若响应丢失没有任务号，请到办理记录人工核对。</div>
          <button className="btn" disabled={running} onClick={() => void checkOriginal()}>核对原任务（不重新收费）</button>
          {canRetryCivil ? <button className="btn" disabled={running} onClick={() => void retryCivil()}>只补办人防（不重复收费）</button> : null}
        </div> : null}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
          <button className="btn p" style={{ flex: 1 }} disabled={!canSubmit} onClick={() => void run()}>
            <Icon name="cash" size={16} />{running ? '现场执行中…' : submitted.current ? '已提交，请到办理记录核对' : amount === null || !Number.isFinite(amount) ? '请填写实收金额' : amount === 0 ? '确认0元续期' : `确认续期收费 ¥${amount}`}
          </button>
          <button className="btn" disabled={running} onClick={onClose}>取消</button>
        </div>
      </div>
    </Sheet>
  );
}
