import DateInput from '@/components/DateInput';
import { useEffect, useMemo, useRef, useState } from 'react';
import { accessCardIssuance } from '@pms/api-client';
import type { ParkingQueryRow, ParkingRates, DeliyunVehicle } from '@pms/api-client/src/endpoints/access-card-issuance';
import { Sheet, toast } from '@/components/ui';
import Icon from '@/components/Icon';
import { dayjs } from '@/lib/format';
import { field, vehicleIdentity } from '@/lib/parking-fields';
import { createIdempotencyKey, renewalEndDate, allocateRenewalAmounts, rateKeyOf, submitAndPoll, type OpOutcome } from '@/lib/parking-ops';
import RenewalMonths from '@/components/cashier/RenewalMonths';

type CloudState = 'loading' | DeliyunVehicle | null | undefined;


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
  const [rates, setRates] = useState<ParkingRates | null>(null);
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
    accessCardIssuance.parkingFeeRates().then(r => { if (alive) setRates(r); }).catch((e) => { if (alive) setRatesErr(e instanceof Error ? e.message : '费率读取失败'); });
    return () => { alive = false; };
  }, []);

  const identity = vehicleIdentity(field(rows[0]?.fields, 'identity'));
  const isFamily = identity === '亲情车';
  const rateKey = rateKeyOf(identity);
  const targets = useMemo(() => rows.filter((r) => r.database === 'parking1' || r.database === 'parking2'), [rows]);
  const baseEnd = useMemo(() => {
    const ends = targets.map((r) => ymd(field(r.fields, 'expiry'))).filter(Boolean).sort();
    return ends.length ? ends[ends.length - 1] : '';
  }, [targets]);

  const context = JSON.stringify([plate, targets, identity]);
  const [formContext, setFormContext] = useState(context);
  useEffect(() => {
    setFormContext(context); setMonths(1); setMonthsValid(true); setAmountStr(''); setEndOverride(''); setErr(''); setLog([]);
    submitted.current = false;
  }, [context]);
  const rateAmount = isFamily ? 0 : (rates?.[rateKey]?.[String(months)] ?? null);
  const manualAmount = amountStr.trim() !== '';
  const amount = manualAmount ? (/^\d+(?:\.\d{1,2})?$/.test(amountStr) ? Number(amountStr) : NaN) : rateAmount;
  const newEnd = endOverride || renewalEndDate(baseEnd || undefined, months);
  const cloudKnown = cloud !== undefined && cloud !== 'loading';
  const civil = cloudKnown && cloud ? (cloud as DeliyunVehicle) : null;

  // 人防（德立云）只服务二期人防车库：这辆车没开人防就直接续旧库，不等人防状态、不碰德立云
  const [syncCivil, setSyncCivil] = useState(false);
  useEffect(() => { setSyncCivil(!!civil?.civilDefenseAuthorized); }, [civil?.civilDefenseAuthorized]);
  const canSubmit = formContext === context && targets.length > 0 && !running && !submitted.current && monthsValid && Number.isInteger(months) && months >= 1 && months <= 60 && amount !== null && Number.isFinite(amount) && amount >= 0 && amount <= 1000000 && dayjs(newEnd).isValid() && (!baseEnd || newEnd >= baseEnd);

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

        <div className="muted" style={{ fontSize: 13, marginBottom: 6 }}>续期月数</div>
        <RenewalMonths value={months} disabled={running || submitted.current} onValidityChange={setMonthsValid}
          onChange={m => { setMonths(m); setMonthsValid(true); setAmountStr(''); setEndOverride(''); }} />

        <div className="veh-dl" style={{ gridTemplateColumns: 'auto 1fr', gap: '10px 12px', marginBottom: 14 }}>
          <dt className="muted">当前到期</dt><dd>{baseEnd || '—（按10号及自然月末规则）'}</dd>
          <dt className="muted">续到</dt>
          <dd><DateInput className="in" type="date" disabled={running || submitted.current} value={newEnd} onChange={(e) => setEndOverride(e.target.value)} style={{ width: 180 }} /></dd>
          <dt className="muted">实收金额</dt>
          <dd style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            ¥<input className="in" aria-label="续期实收金额" disabled={running || submitted.current} value={amountStr} onChange={(e) => setAmountStr(e.target.value)}
              placeholder={rateAmount === null ? '请明确填写' : String(rateAmount)} style={{ width: 120 }} inputMode="decimal" />
            {isFamily ? <span className="pill s-info">亲情车免费</span> : <span className="muted" style={{ fontSize: 12 }}>{rateAmount === null ? '此月数未配置价格，可手工填写；免费填0' : `默认 ¥${rateAmount}（${rateKey === 'owner' ? '业主' : '租户'}价）`}</span>}
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
