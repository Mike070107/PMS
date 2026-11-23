import { readPlateBillingClass } from './propertyCarBilling';
import { parkingIdentityForBillingClass } from '@pms/shared-types';
import VehicleClassChoices, { vehicleClassLabel } from '../cashier/VehicleClassChoices';
import './vehicle-type-sheet.css';
import { useEffect, useRef, useState } from 'react';
import { accessCardIssuance, request } from '@pms/api-client';
import type { ParkingOperation, ParkingQueryRow } from '@pms/api-client/src/endpoints/access-card-issuance';
import { Sheet, toast } from '@/components/ui';
import { useSession } from '@/lib/auth';
import { can } from '@/lib/perm';
import { field, normPlate, vehicleIdentity } from '@/lib/parking-fields';
import { createIdempotencyKey, dbShort, pidOf, freshRows } from '@/lib/parking-ops';

const IDENTITIES = ['住户车', '租户车', '亲情车', '产权车'];
type Database = 'parking1' | 'parking2';
interface Plan {
  database: Database; sourceRecordId: string; idempotencyKey: string; id?: number;
  payload: { plate: string; ownerRoom: string; identity: string; propertyBillingClass?: string; billingClass?: string };
}
const wait = (ms: number) => new Promise<void>(resolve => window.setTimeout(resolve, ms));
function uniqueRow(rows: ParkingQueryRow[], database: string, sourceRecordId: string) {
  const hits = rows.filter(row => row.database === database);
  if (hits.length !== 1 || pidOf(hits[0].fields) !== sourceRecordId) throw new Error('现场车辆记录已变化或不唯一，请关闭后重新查询；未确认修改成功');
  return hits[0];
}

/** 单车牌、单停车库修改；不把一期二期不同身份悄悄覆盖成同一个。 */
export default function VehicleTypeSheet({ plate, rows, onClose, onDone }: {
  plate: string; rows: ParkingQueryRow[]; onClose: () => void; onDone: () => void;
}) {
  const session = useSession();
  const journalKey = `pms-vehicle-type-v1:${session.actingTenant?.id ?? session.user?.tenantId}:${session.user?.id}:${normPlate(plate)}`;
  const [initial] = useState(() => {
    try {
      const raw = localStorage.getItem(journalKey);
      if (!raw) return { plan: null as Plan | null, error: '' };
      const plan: Plan = JSON.parse(raw);
      if (!['parking1', 'parking2'].includes(plan.database) || !plan.sourceRecordId || !plan.idempotencyKey ||
          normPlate(plan.payload?.plate || '') !== normPlate(plate) || !IDENTITIES.includes(plan.payload.identity)) throw new Error();
      return { plan, error: '' };
    } catch { return { plan: null as Plan | null, error: '原任务记录无法读取，已暂停新提交；请在办理记录核对，不要重复修改。' }; }
  });
  const targets = rows.filter(row => ['parking1', 'parking2'].includes(row.database) && normPlate(field(row.fields, 'plate')) === normPlate(plate));
  const [database, setDatabase] = useState(initial.plan?.database || (targets.length === 1 ? targets[0].database : ''));
  const target = targets.find(row => row.database === database);
  const [choice, setChoice] = useState(initial.plan?.payload.billingClass || initial.plan?.payload.propertyBillingClass || initial.plan?.payload.identity || '');
  const identity = parkingIdentityForBillingClass(choice);
  const [rules, setRules] = useState<Array<{enabled:boolean; serviceType:string; communityId?: number; name?: string; config?: {vehicleClass?: string}}>>([]);
  const [ruleError, setRuleError] = useState('');
  const [loadingRules, setLoadingRules] = useState(true);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setLoadingRules(true); setRuleError('');
    request<typeof rules>({url:'/business/rules', query:{serviceType:'parking_monthly'}})
      .then(rows => { if (active) setRules(rows.filter(row => row.enabled && row.serviceType === 'parking_monthly')); })
      .catch(() => { if (active) setRuleError('收费规则读取失败'); })
      .finally(() => { if (active) setLoadingRules(false); });
    return () => { active = false; };
  },[attempt]);
  const applicable = rules.filter(rule => !rule.communityId || rule.communityId === target?.pmsMatch?.house?.communityId);
  const classes = [...new Set(applicable.map(r => r.config?.vehicleClass || '').filter(v => parkingIdentityForBillingClass(v)))];
  const hasProperty = classes.some(v => vehicleClassLabel(v) === '产权车');
  const conflictingClasses = classes.filter(value => classes.some(other =>
    other !== value && vehicleClassLabel(other) === vehicleClassLabel(value)));
  const disabledClasses = hasProperty ? conflictingClasses : [...conflictingClasses, '产权车'];
  const canSelect = !!identity && classes.includes(choice) && !conflictingClasses.includes(choice) && !loadingRules && !ruleError;
  const ruleNames = [...new Set(applicable.filter(r => r.config?.vehicleClass === choice).map(r => r.name).filter(Boolean))];
  const [plan, setPlan] = useState<Plan | null>(initial.plan);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [err, setErr] = useState(initial.error || (initial.plan ? '有已提交的修改，请先核对原任务；不会另建任务。' : ''));
  const [billing, setBilling] = useState('');
  useEffect(() => {
    let current = true;
    request<Array<{vehicleClass:string}>>({url:'/business/plate-tags',query:{plates:plate}})
      .then(rows=>{if(current) setBilling(rows[0]?.vehicleClass || '未设置');}).catch(()=>{if(current) setBilling('未读取');});
    return ()=>{current=false;};
  },[plate]);
  const [progress, setProgress] = useState('');
  const writable = can('business', 'edit');
  const sourceRecordId = target ? pidOf(target.fields) : '';
  const ownerRoom = target ? field(target.fields, 'room', true) : '';
  const targetIssue = !targets.length ? '仅德立云记录或旧库无此车牌：不能从此入口修改车辆身份。'
    : !database ? '请选择本次修改的停车库。'
      : targets.filter(row => row.database === database).length !== 1 ? '同一库存在重复车牌记录，请先核对。'
        : !sourceRecordId || !ownerRoom ? '缺少车辆记录编号或房号，不能安全修改，请重新查询。' : '';
  const store = (next: Plan) => { localStorage.setItem(journalKey, JSON.stringify(next)); setPlan(next); };
  const clear = () => { localStorage.removeItem(journalKey); setPlan(null); };

  const run = async (recover: boolean) => {
    if (lock.current || !can('business', 'edit') || initial.error) return;
    if (!recover && (plan || targetIssue || !canSelect || !identity)) return;
    lock.current = true; setBusy(true); setErr('');
    let active = plan;
    try {
      if (!recover) {
        setProgress('提交前重新核对车牌、记录编号及房号…');
        const current = uniqueRow(await freshRows(plate), database, sourceRecordId);
        if (field(current.fields, 'room', true) !== ownerRoom || field(current.fields, 'identity') !== field(target?.fields, 'identity'))
          throw new Error('现场房号或车辆类型已变化，请重新查询后再修改；未提交任务');
        if (!identity || !canSelect) throw new Error('请选择已启用的收费档位');
        if (field(current.fields, 'identity') === identity && await readPlateBillingClass(plate) === choice)
          throw new Error('当前车辆已使用该收费档位');
        active = { database: database as Database, sourceRecordId, idempotencyKey: createIdempotencyKey(),
          payload: { plate: field(current.fields, 'plate'), ownerRoom, identity, billingClass: choice } };
        // Persist BEFORE POST: response loss/reload must retain the original key and immutable payload.
        store(active);
      }
      if (!active) return;
      setProgress(active.id ? `正在核对原任务 #${active.id}…` : '正在提交原请求（同一幂等键）…');
      let operation = active.id ? await accessCardIssuance.parkingOperation(active.id) : await accessCardIssuance.createParkingOperation({ ...active, kind: 'update_vehicle_type' });
      const assertOperation = (op: ParkingOperation) => {
        if (op.kind !== 'update_vehicle_type' || op.database !== active!.database || op.sourceRecordId !== active!.sourceRecordId ||
            normPlate(String(op.payload.plate || '')) !== normPlate(active!.payload.plate) || op.payload.identity !== active!.payload.identity || op.payload.billingClass !== active!.payload.billingClass || op.payload.propertyBillingClass !== active!.payload.propertyBillingClass || op.payload.ownerRoom !== active!.payload.ownerRoom)
          throw new Error('原任务与本次车牌、记录或类型不一致，已停止；请核对办理记录');
      };
      active = { ...active, id: operation.id }; store(active);
      assertOperation(operation);
      for (let i = 0; ['pending', 'running'].includes(operation.status) && i < 112; i++) {
        setProgress(`任务 #${operation.id} · 等待现场助手执行并读回，尚未完成…`);
        await wait(800); operation = await accessCardIssuance.parkingOperation(operation.id); assertOperation(operation);
      }
      if (['failed', 'cancelled'].includes(operation.status)) {
        throw new Error(`原任务 #${operation.id} ${operation.status === 'cancelled' ? '已取消' : '失败'}：${operation.error || '现场未完成'}。输入及原请求已保留；请核对现场和办理记录，不会另建请求或重复修改。`);
      }
      if (operation.status !== 'completed') throw new Error(`任务 #${operation.id} 仍在等待，结果未知；请核对原任务，勿重复提交`);
      if (operation.result?.verified !== true || operation.result.preserved !== true || operation.result.preservationContract !== 1 ||
          operation.result.database !== active.database || operation.result.identity !== active.payload.identity ||
          normPlate(String(operation.result.plate || '')) !== normPlate(active.payload.plate) || String(operation.result.issueId) !== active.sourceRecordId)
        throw new Error('现场回执的车牌、记录编号或车辆类型不一致，不能确认成功；请核对原任务');
      setProgress(`任务 #${operation.id} 已回报，正在独立查询现场读回…`);
      const after = uniqueRow(await freshRows(plate), active.database, active.sourceRecordId);
      if (field(after.fields, 'identity') !== active.payload.identity) throw new Error('写后独立读回类型不一致，尚未确认成功；请核对原任务，不会重新修改');
      if (operation.result.familyAuthorizationExpired === true &&
          field(after.fields, 'expiry').slice(0, 10) !== operation.result.endDate)
        throw new Error('写后独立读回到期日不一致，尚未确认停用旧有效期；请核对原任务');
      const savedClass = active.payload.billingClass || active.payload.propertyBillingClass;
      if (savedClass && await readPlateBillingClass(plate) !== savedClass)
        throw new Error('停车库身份已核对，PMS 收费档位读回不一致，请核对原任务');
      clear(); toast(savedClass ? `已改为${vehicleClassLabel(savedClass)}，收费档位与停车库身份均已核对` : '停车库车辆类型已核对'); onDone();
    } catch (e) { setErr(e instanceof Error ? e.message : '修改未确认，输入与原请求已保留'); }
    finally { lock.current = false; setBusy(false); setProgress(''); }
  };

  return <Sheet open onClose={() => { if (!lock.current) onClose(); }} width={520} title="修改车辆类型" subtitle="车辆管理">
    <div className="vehicle-type-sheet">
      <header className="vt-current"><strong>{plate}</strong><div>当前收费档位 <b>{vehicleClassLabel(billing) || '读取中…'}</b></div></header>
      <fieldset className="vt-fields" disabled={busy || !!plan || !writable || !!initial.error}>
        <label className="fl">办理停车库<select className="in" aria-label="修改停车库（仅所选库）" value={database} onChange={e => { setDatabase(e.target.value); setChoice(''); setErr(''); }}>
          <option value="">请选择停车库</option>{Array.from(new Set(targets.map(row => row.database))).map(db => <option key={db} value={db}>{dbShort(db)}</option>)}
        </select></label>
        {target && <span className="muted">{ownerRoom} · 当前库内身份 {vehicleIdentity(field(target.fields, 'identity'))}</span>}
        <VehicleClassChoices options={hasProperty ? classes : [...classes,'产权车']} disabledOptions={disabledClasses} value={choice}
          disabled={loadingRules || !!ruleError} onChange={value => { setChoice(value); setErr(''); }} />
      </fieldset>
      {loadingRules ? <span role="status">正在读取收费档位…</span> : ruleError ? <div role="alert">{ruleError} <button className="btn sm" onClick={() => setAttempt(a => a + 1)}>重新读取</button></div>
        : !hasProperty && <small className="muted">当前范围未配置产权车收费档位</small>}
      {conflictingClasses.length > 0 && <small className="muted">同名档位存在多份配置，请先核对收费规则。</small>}
      {choice && <section className="vt-result" aria-live="polite"><h3>变更后</h3>
        <dl><dt>收费档位</dt><dd>{vehicleClassLabel(choice)}</dd>
          {ruleNames.length > 0 && <><dt>收费规则</dt><dd>{ruleNames.join('、')}</dd></>}
          <dt>停车库身份</dt><dd>{identity}</dd>
          {target && field(target.fields, 'identity').trim() === '亲情车' && identity && identity !== '亲情车' ? <><dt>停车库到期日</dt><dd>改为昨天，旧有效期立即结束</dd></> : null}</dl></section>}
      {!writable ? <div role="alert" className="note">当前账号没有业务编辑权限，不能修改车辆类型。</div> : null}
      {targetIssue && !plan && (!!database || !targets.length) ? <div className="note">{targetIssue}</div> : null}
      {progress ? <div role="status" className="note">{progress}</div> : null}
      {err ? <div role="alert" className="note" style={{ color: 'var(--dang)', background: 'var(--dang-w)' }}>{err}</div> : null}
      {plan ? <div className="note">原请求：{dbShort(plan.database)} · {vehicleClassLabel(plan.payload.billingClass || plan.payload.propertyBillingClass || plan.payload.identity)}{plan.id ? ` · 任务 #${plan.id}` : ' · 提交响应未知'}。核对将沿用原请求及幂等键，不创建另一笔修改。</div> : null}
      <div className="vt-actions">
        {plan ? <button className="btn p" style={{ minHeight: 44 }} disabled={busy || !writable || !!initial.error} onClick={() => void run(true)}>核对原任务（同一请求）</button>
          : <button className="btn p" style={{ minHeight: 44 }} disabled={busy || !writable || !!targetIssue || !canSelect || !!initial.error} onClick={() => void run(false)}>{busy ? '现场执行中…' : '确认修改车辆类型'}</button>}

      </div>
    </div>
  </Sheet>;
}
