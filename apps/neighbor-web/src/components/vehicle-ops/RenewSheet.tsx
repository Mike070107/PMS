import { useEffect, useMemo, useState } from 'react';
import { accessCardIssuance } from '@pms/api-client';
import type { ParkingQueryRow, ParkingRates, DeliyunVehicle } from '@pms/api-client/src/endpoints/access-card-issuance';
import { Sheet, toast } from '@/components/ui';
import Icon from '@/components/Icon';
import { dayjs } from '@/lib/format';
import { field, vehicleIdentity } from '@/lib/parking-fields';
import { createIdempotencyKey, renewalEndDate, allocateRenewalAmounts, rateKeyOf, submitAndPoll, type OpOutcome } from '@/lib/parking-ops';

type CloudState = 'loading' | DeliyunVehicle | null | undefined;
const MONTHS = [1, 2, 3, 6, 12];

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
  const [amountStr, setAmountStr] = useState('');
  const [endOverride, setEndOverride] = useState('');
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [err, setErr] = useState('');

  useEffect(() => {
    accessCardIssuance.parkingFeeRates().then(setRates).catch((e) => setRatesErr(e instanceof Error ? e.message : '费率读取失败'));
  }, []);

  const identity = vehicleIdentity(field(rows[0]?.fields, 'identity'));
  const isFamily = identity === '亲情车';
  const rateKey = rateKeyOf(identity);
  const targets = useMemo(() => rows.filter((r) => r.database === 'parking1' || r.database === 'parking2'), [rows]);
  const baseEnd = useMemo(() => {
    const ends = targets.map((r) => ymd(field(r.fields, 'expiry'))).filter(Boolean).sort();
    return ends.length ? ends[ends.length - 1] : '';
  }, [targets]);

  const rateAmount = isFamily ? 0 : (rates?.[rateKey]?.[String(months)] ?? 0);
  const amount = amountStr.trim() !== '' ? Number(amountStr) : rateAmount;
  const newEnd = endOverride || renewalEndDate(baseEnd || undefined, months);
  const cloudKnown = cloud !== undefined && cloud !== 'loading';
  const civil = cloudKnown && cloud ? (cloud as DeliyunVehicle) : null;

  const canSubmit = targets.length > 0 && !running && rates !== null && cloudKnown && Number.isFinite(amount) && amount >= 0;

  const run = async () => {
    setErr('');
    if (!targets.length) { setErr('这张车牌不在一期/二期旧库里，无法续期'); return; }
    if (!cloudKnown) { setErr('人防（德立云）状态还在查，请稍候再续期'); return; }
    if (civil?.civilDefenseAuthorized && civil.endDate && dayjs(newEnd).isBefore(dayjs(ymd(civil.endDate)))) {
      setErr(`新到期日 ${newEnd} 早于人防到期日 ${ymd(civil.endDate)}，请核对`); return;
    }
    if (!Number.isFinite(amount) || amount < 0) { setErr('金额不对'); return; }
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
      if (civil?.civilDefenseAuthorized && ymd(civil.endDate || '') !== newEnd) {
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
        <div className="chips" style={{ marginBottom: 14 }}>
          {MONTHS.map((m) => {
            const amt = isFamily ? 0 : (rates?.[rateKey]?.[String(m)] ?? null);
            return (
              <button key={m} className={`chip ${months === m ? 'on' : ''}`} onClick={() => { setMonths(m); setAmountStr(''); setEndOverride(''); }}>
                {m} 个月{amt !== null ? ` · ¥${amt}` : ''}
              </button>
            );
          })}
        </div>

        <div className="veh-dl" style={{ gridTemplateColumns: 'auto 1fr', gap: '10px 12px', marginBottom: 14 }}>
          <dt className="muted">当前到期</dt><dd>{baseEnd || '—（按今天起算）'}</dd>
          <dt className="muted">续到</dt>
          <dd><input className="in" type="date" value={newEnd} onChange={(e) => setEndOverride(e.target.value)} style={{ width: 180 }} /></dd>
          <dt className="muted">实收金额</dt>
          <dd style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            ¥<input className="in" value={amountStr} onChange={(e) => setAmountStr(e.target.value.replace(/[^\d.]/g, ''))}
              placeholder={String(rateAmount)} style={{ width: 120 }} inputMode="decimal" />
            {isFamily ? <span className="pill s-info">亲情车免费</span> : <span className="muted" style={{ fontSize: 12 }}>默认 ¥{rateAmount}（{rateKey === 'owner' ? '业主' : '租户'}价）</span>}
          </dd>
        </div>

        {/* 人防状态提示 */}
        <div className="note" style={{ marginBottom: 12, background: !cloudKnown ? 'var(--warn-w)' : 'var(--bg)', color: !cloudKnown ? 'var(--warn)' : 'var(--ink2)', fontSize: 13 }}>
          {!cloudKnown ? '人防（德立云）状态还在查，查明前不能续期（避免旧库先收费而人防没同步）'
            : civil?.civilDefenseAuthorized ? `人防已授权，到期 ${ymd(civil.endDate || '') || '未知'}；续期后会一并同步到 ${newEnd}`
              : '该车未开通人防车库，只续旧库'}
        </div>

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
            <Icon name="cash" size={16} />{running ? '现场执行中…' : `确认续期收费 ¥${Number.isFinite(amount) ? amount : 0}`}
          </button>
          <button className="btn" disabled={running} onClick={onClose}>取消</button>
        </div>
      </div>
    </Sheet>
  );
}
