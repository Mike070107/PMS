import DateInput from '@/components/DateInput';
import { useEffect, useMemo, useRef, useState } from 'react';
import { accessCardIssuance, request } from '@pms/api-client';
import type { ParkingQueryRow, DeliyunVehicle } from '@pms/api-client/src/endpoints/access-card-issuance';
import { Sheet, toast } from '@/components/ui';
import Icon from '@/components/Icon';
import { dayjs } from '@/lib/format';
import { field, vehicleIdentity } from '@/lib/parking-fields';
import { createIdempotencyKey, renewalEndDate, allocateRenewalAmounts, submitAndPoll, type OpOutcome } from '@/lib/parking-ops';
import RenewalMonths from '@/components/cashier/RenewalMonths';

type CloudState = 'loading' | DeliyunVehicle | null | undefined;
interface FeeCommunity { id: number; name: string }
interface FeeRule { id: number; communityId: number | null; serviceType: string; enabled: boolean; name: string; unitPriceCents: number; config?: { vehicleClass?: string; parkingTarget?: string; parkingTargets?: string[] } | null }
interface FeeQuote { quantity: number; amountCents: number; startDate: string; endDate: string }



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
  plate, rows, cloud, onClose, onDone,
}: {
  plate: string;
  rows: ParkingQueryRow[];
  cloud: CloudState;
  onClose: () => void;
  onDone: () => void;
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
  const submitted = useRef(false);

  useEffect(() => {
    let alive = true;
    Promise.all([
      request<FeeRule[]>({ url: '/business/rules', query: { serviceType: 'parking_monthly' } }),
      request<FeeCommunity[]>({ url: '/business/communities' }),
    ]).then(([rs, cs]) => {
      if (!alive) return;
      setRules(rs); setCommunities(cs); setCommunityId(cs.length === 1 ? cs[0].id : null);
    }).catch(() => { if (alive) setRatesErr('车辆类别和收费标准读取失败，请关闭后重试'); });
    return () => { alive = false; };
  }, []);

  const identity = vehicleIdentity(field(rows[0]?.fields, 'identity'));
  // 旧库身份只作资料展示，收费类别由本次明确选择的规则决定。
  const targets = useMemo(() => rows.filter((r) => r.database === 'parking1' || r.database === 'parking2'), [rows]);
  const localBaseEnd = useMemo(() => {
    const ends = targets.map((r) => ymd(field(r.fields, 'expiry'))).filter(Boolean).sort();
    return ends.length ? ends[ends.length - 1] : '';
  }, [targets]);

  const context = JSON.stringify([plate, targets, identity]);
  const [formContext, setFormContext] = useState(context);
  useEffect(() => {
    setFormContext(context); setMonths(1); setMonthsValid(true); setAmountStr(''); setEndOverride(''); setErr(''); setLog([]);
    submitted.current = false; setRuleId(null); setQuote(null); setQuoteError(''); quoteGeneration.current++;
  }, [context]);
  const applicableRules = rules.filter(r => r.enabled && r.serviceType === 'parking_monthly' && communityId != null && (r.communityId == null || r.communityId === communityId) && (() => {
    const keys = r.config?.parkingTargets ?? (r.config?.parkingTarget ? [r.config.parkingTarget] : []);
    return !keys.length || targets.some(t => keys.includes(t.database === 'parking1' ? 'local:phase1_parking' : 'local:phase2_parking') || t.database === 'parking2' && keys.includes('local:phase2_main_garage'));
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
  const amount = manualAmount ? (/^\d+(?:\.\d{1,2})?$/.test(amountStr) ? Number(amountStr) : NaN) : rateAmount;
  const selectRule = (value: string) => { quoteGeneration.current++; setRuleId(value ? Number(value) : null); setQuote(null); setQuoteError(''); setAmountStr(''); setEndOverride(''); };

  const canSubmit = !!selectedRule && formContext === context && targets.length > 0 && !running && !submitted.current && monthsValid && Number.isInteger(months) && months >= 1 && months <= 60 && amount !== null && Number.isFinite(amount) && amount >= 0 && amount <= 1000000 && dayjs(newEnd).isValid() && (!baseEnd || newEnd >= baseEnd);

  const run = async () => {
      if (submitted.current || running) return;
      setErr('');
    if (!canSubmit) { setErr('请核对月份、到期日和金额；未配置档位可手工填写金额，免费办理请明确填写 0'); return; }
    if (!targets.length) { setErr('这张车牌不在一期/二期旧库里，无法续期'); return; }
    if (syncCivil && civil?.civilDefenseAuthorized && civil.endDate && dayjs(newEnd).isBefore(dayjs(ymd(civil.endDate)))) {
      setErr(`新到期日 ${newEnd} 早于人防到期日 ${ymd(civil.endDate)}，请核对`); return;
    }
    if (amount === null || !Number.isFinite(amount) || amount < 0) { setErr('金额不对'); return; }
    submitted.current = true;
    setRunning(true);
    setLog([]);
    const batch = createIdempotencyKey();
    const amounts = allocateRenewalAmounts(amount, targets.length);
    try {
      for (let i = 0; i < targets.length; i += 1) {
        const t = targets[i];
        const db = t.database as 'parking1' | 'parking2';
        setLog((l) => [...l, `正在续 ${dbName(db)}…`]);
        const outcome: OpOutcome = await submitAndPoll({
          database: db,
          kind: 'renew_vehicle',
          sourceRecordId: pidOf(t.fields) || undefined,
          idempotencyKey: targets.length > 1 ? `${batch}-${db}` : batch,
          payload: {
            plate,
            endDate: newEnd,
            previousEndDate: ymd(field(t.fields, 'expiry')),
            amount: amounts[i],
            months,
            identity,
            vehicleClass: selectedRule!.config?.vehicleClass || selectedRule!.name,
            ruleId: selectedRule!.id,
          },
        });
        if (outcome.kind === 'failed') { setErr(`${dbName(db)} 续期失败：${outcome.error}`); setLog((l) => [...l, `✗ ${dbName(db)} 失败`]); setRunning(false); return; }
        if (outcome.kind === 'timeout') { setErr(`${dbName(db)} 现场网关响应超时，任务已保留，请稍后在办理记录查看，勿重复续期`); setLog((l) => [...l, `… ${dbName(db)} 超时，任务保留`]); setRunning(false); return; }
        setLog((l) => [...l, `✓ ${dbName(db)} 已续到 ${newEnd}`]);
      }
      // 人防同步：旧库都成功后，若人防已授权且到期日不同，补一笔德立云续期
      if (syncCivil && civil?.civilDefenseAuthorized && ymd(civil.endDate || '') !== newEnd) {
        setLog((l) => [...l, '正在同步人防（德立云）到期日…']);
        try {
          await accessCardIssuance.renewDeliyunVehicle({
            vehicleId: civil.id,
            plate,
            previousEndDate: ymd(civil.endDate || '') || newEnd,
            endDate: newEnd,
            idempotencyKey: `${batch}-deliyun`,
          });
          setLog((l) => [...l, '✓ 人防已同步']);
        } catch (e) {
          setErr(`旧库续期已完成，但人防同步未完成：${e instanceof Error ? e.message : '失败'}。请在办理记录只重试人防，勿重复收费`);
          setRunning(false);
          return;
        }
      }
      toast(`已续期到 ${newEnd}`);
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : '续期失败');
    } finally {
      setRunning(false);
    }
  };

  return (
    <Sheet open onClose={() => (running ? null : onClose())} title={`续期收费 · ${plate}`}
      subtitle={`${identity} · ${targets.map((t) => dbName(t.database)).join(' + ') || '不在旧库'}`} width={560}>
      <div style={{ padding: '4px 2px' }}>
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
          <dd><DateInput className="in" type="date" disabled={running || submitted.current} value={newEnd} onChange={(e) => setEndOverride(e.target.value)} style={{ width: 180 }} /></dd>
          <dt className="muted">实收金额</dt>
          <dd style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            ¥<input className="in" aria-label="续期实收金额" disabled={running || submitted.current} value={amountStr} onChange={(e) => setAmountStr(e.target.value)}
              placeholder={rateAmount === null ? '请明确填写' : String(rateAmount)} style={{ width: 120 }} inputMode="decimal" />
            <span className="muted" style={{ fontSize: 12 }}>{!selectedRule ? '先选择车辆类别' : quoteError || (rateAmount === null ? '正在按所选类别试算…' : `标准 ¥${rateAmount}（${selectedRule.config?.vehicleClass || selectedRule.name}）`)}</span>
          </dd>
        </div>

        {/* 人防只在开通时才有意义：没开通就不查、不等、不写德立云 */}
        {civil?.civilDefenseAuthorized ? (
          <label className="note" style={{ marginBottom: 12, display: 'flex', gap: 8, alignItems: 'flex-start', background: 'var(--bg)', color: 'var(--ink2)', fontSize: 13, cursor: 'pointer' }}>
            <input type="checkbox" disabled={running || submitted.current} checked={syncCivil} onChange={(e) => setSyncCivil(e.target.checked)} style={{ marginTop: 2 }} />
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

        {err ? <div className="note" style={{ background: 'var(--dang-w)', color: 'var(--dang)', marginBottom: 12 }}>{err}</div> : null}

        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn p" style={{ flex: 1 }} disabled={!canSubmit} onClick={() => void run()}>
            <Icon name="cash" size={16} />{running ? '现场执行中…' : submitted.current ? '已提交，请到办理记录核对' : amount === null || !Number.isFinite(amount) ? '请填写实收金额' : amount === 0 ? '确认0元续期' : `确认续期收费 ¥${amount}`}
          </button>
          <button className="btn" disabled={running} onClick={onClose}>取消</button>
        </div>
      </div>
    </Sheet>
  );
}
