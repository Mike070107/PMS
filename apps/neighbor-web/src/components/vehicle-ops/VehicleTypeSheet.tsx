import { useRef, useState } from 'react';
import { accessCardIssuance } from '@pms/api-client';
import type { ParkingOperation, ParkingQueryRow } from '@pms/api-client/src/endpoints/access-card-issuance';
import { Sheet, toast } from '@/components/ui';
import { useSession } from '@/lib/auth';
import { can } from '@/lib/perm';
import { field, normPlate, vehicleIdentity } from '@/lib/parking-fields';
import { createIdempotencyKey, dbShort, pidOf } from '@/lib/parking-ops';

const IDENTITIES = ['住户车', '租户车', '亲情车'];
type Database = 'parking1' | 'parking2';
interface Plan {
  database: Database; sourceRecordId: string; idempotencyKey: string; id?: number;
  payload: { plate: string; ownerRoom: string; identity: string };
}
const wait = (ms: number) => new Promise<void>(resolve => window.setTimeout(resolve, ms));
async function freshRows(plate: string) {
  let query = await accessCardIssuance.createParkingQuery(plate);
  for (let i = 0; !['completed', 'failed'].includes(query.status) && i < 30; i++) {
    await wait(500); query = await accessCardIssuance.parkingQuery(query.id);
  }
  if (query.status !== 'completed') throw new Error(query.error || '现场查询仍在等待，暂不能确认结果');
  return query.rows.filter(row => normPlate(field(row.fields, 'plate')) === normPlate(plate));
}
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
  const [identity, setIdentity] = useState(initial.plan?.payload.identity || '');
  const [plan, setPlan] = useState<Plan | null>(initial.plan);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [err, setErr] = useState(initial.error || (initial.plan ? '有已提交的修改，请先核对原任务；不会另建任务。' : ''));
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
    if (!recover && (plan || targetIssue || !IDENTITIES.includes(identity))) return;
    lock.current = true; setBusy(true); setErr('');
    let active = plan;
    try {
      if (!recover) {
        setProgress('提交前重新核对车牌、记录编号及房号…');
        const current = uniqueRow(await freshRows(plate), database, sourceRecordId);
        if (field(current.fields, 'room', true) !== ownerRoom || field(current.fields, 'identity') !== field(target?.fields, 'identity'))
          throw new Error('现场房号或车辆类型已变化，请重新查询后再修改；未提交任务');
        if (field(current.fields, 'identity') === identity) throw new Error('所选类型与现场相同，无需修改；未提交任务');
        active = { database: database as Database, sourceRecordId, idempotencyKey: createIdempotencyKey(), payload: { plate: field(current.fields, 'plate'), ownerRoom, identity } };
        // Persist BEFORE POST: response loss/reload must retain the original key and immutable payload.
        store(active);
      }
      if (!active) return;
      setProgress(active.id ? `正在核对原任务 #${active.id}…` : '正在提交原请求（同一幂等键）…');
      let operation = active.id ? await accessCardIssuance.parkingOperation(active.id) : await accessCardIssuance.createParkingOperation({ ...active, kind: 'update_vehicle_type' });
      const assertOperation = (op: ParkingOperation) => {
        if (op.kind !== 'update_vehicle_type' || op.database !== active!.database || op.sourceRecordId !== active!.sourceRecordId ||
            normPlate(String(op.payload.plate || '')) !== normPlate(active!.payload.plate) || op.payload.identity !== active!.payload.identity || op.payload.ownerRoom !== active!.payload.ownerRoom)
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
      clear(); toast(`${dbShort(active.database)} ${plate} 已改为${active.payload.identity}，现场读回一致`); onDone();
    } catch (e) { setErr(e instanceof Error ? e.message : '修改未确认，输入与原请求已保留'); }
    finally { lock.current = false; setBusy(false); setProgress(''); }
  };

  return <Sheet open onClose={() => { if (!lock.current) onClose(); }} width={540} title={`修改车辆类型 · ${plate}`} subtitle="按车牌修改旧库车辆身份 · 仅本次所选停车库">
    <div style={{ display: 'grid', gap: 14, minWidth: 0, overflowWrap: 'anywhere' }}>
      <div className="note">此处修改住户车／租户车等车辆身份，不是车位“产权／租赁／空”，也不是德立云车型。不收费、不续期、不调整授权或下发设备；不改同户其他车牌。</div>
      <div className="card" style={{ padding: 12 }}>
        {targets.map((row, index) => <div key={`${row.database}-${index}`} style={{ lineHeight: 1.9 }}><b>{dbShort(row.database)}</b> · {vehicleIdentity(field(row.fields, 'identity'))} · 记录 {pidOf(row.fields) || '缺失'}</div>)}
        {targets.length > 1 ? <div className="muted" style={{ marginTop: 6 }}>一期、二期分开办理；本次不会自动同步另一库或德立云。</div> : null}
      </div>
      <fieldset disabled={busy || !!plan || !writable || !!initial.error} style={{ display: 'grid', gap: 14, border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        <label className="fl">修改停车库（仅所选库）<select className="in" style={{ minHeight: 44 }} value={database} onChange={e => { setDatabase(e.target.value); setIdentity(''); setErr(''); }}>
          <option value="">请选择停车库</option>{Array.from(new Set(targets.map(row => row.database))).map(db => <option key={db} value={db}>{dbShort(db)}</option>)}
        </select></label>
        <label className="fl">新的车辆类型<select className="in" style={{ minHeight: 44 }} value={identity} onChange={e => { setIdentity(e.target.value); setErr(''); }}>
          <option value="">请选择车辆类型</option>{IDENTITIES.map(value => <option key={value} value={value}>{value}</option>)}
        </select></label>
      </fieldset>
      {!writable ? <div role="alert" className="note">当前账号没有业务编辑权限，不能修改车辆类型。</div> : null}
      {targetIssue && !plan ? <div className="note">{targetIssue}</div> : null}
      {progress ? <div role="status" className="note">{progress}</div> : null}
      {err ? <div role="alert" className="note" style={{ color: 'var(--dang)', background: 'var(--dang-w)' }}>{err}</div> : null}
      {plan ? <div className="note">原请求：{dbShort(plan.database)} · {plan.payload.identity}{plan.id ? ` · 任务 #${plan.id}` : ' · 提交响应未知'}。核对将沿用原请求及幂等键，不创建另一笔修改。</div> : null}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
        {plan ? <button className="btn p" style={{ minHeight: 44 }} disabled={busy || !writable || !!initial.error} onClick={() => void run(true)}>核对原任务（同一请求）</button>
          : <button className="btn p" style={{ minHeight: 44 }} disabled={busy || !writable || !!targetIssue || !identity || !!initial.error} onClick={() => void run(false)}>{busy ? '现场执行中…' : '确认修改车辆类型'}</button>}
        <button className="btn" style={{ minHeight: 44 }} disabled={busy} onClick={onClose}>关闭</button>
      </div>
    </div>
  </Sheet>;
}
