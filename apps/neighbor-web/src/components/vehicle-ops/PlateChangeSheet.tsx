import PlateNumberField from '@/components/PlateNumberField';
import { useId, useRef, useState } from 'react';
import { accessCardIssuance, request } from '@pms/api-client';
import type { ParkingOperation, ParkingQueryRow, DeliyunVehicle } from '@pms/api-client/src/endpoints/access-card-issuance';
import { Sheet, toast } from '@/components/ui';
import { useSession } from '@/lib/auth';
import { can } from '@/lib/perm';
import { field, normPlate } from '@/lib/parking-fields';
import { createIdempotencyKey, dbShort, pidOf } from '@/lib/parking-ops';

type Target = { database: 'parking1' | 'parking2'; sourceRecordId: string; id?: number };
type Plan = { batchId: string; sourceQueryId: number; plate: string; newPlate: string; targets: Target[]; cloudId: string | null; cloudDone?: boolean };
const wait = () => new Promise<void>(resolve => window.setTimeout(resolve, 800));
export function ChangePlateSheet({ plate, rows, cloud, onClose, onDone }: {
  plate: string; rows: ParkingQueryRow[]; cloud: 'loading' | DeliyunVehicle | null | undefined;
  onClose: () => void; onDone: (plate?: string) => void;
}) {
  const session = useSession();
  const key = `pms-plate-preservation-v1:${session.actingTenant?.id ?? session.user?.tenantId}:${session.user?.id}:${normPlate(plate)}`;
  const [initial] = useState(() => {
    try {
      const raw = localStorage.getItem(key); if (!raw) return { plan: null as Plan | null, error: '' };
      const p: Plan = JSON.parse(raw);
      if (p.plate !== normPlate(plate) || !p.batchId || !Number.isSafeInteger(p.sourceQueryId) || !p.newPlate || !Array.isArray(p.targets) || !p.targets.length ||
          p.targets.some(t => !['parking1', 'parking2'].includes(t.database) || !t.sourceRecordId)) throw new Error();
      return { plan: p, error: '' };
    } catch { return { plan: null as Plan | null, error: '原请求无法读取，已禁止新提交；请先核对办理记录。' }; }
  });
  const [plan, setPlan] = useState<Plan | null>(initial.plan);
  const inputId = useId();
  const [plateError, setPlateError] = useState('');
  const [newPlate, setNewPlate] = useState(initial.plan?.newPlate || '');
  const [busy, setBusy] = useState(false), [err, setErr] = useState(initial.error), [progress, setProgress] = useState('');
  const lock = useRef(false);
  const writable = can('business', 'edit');
  const cloudKnown = cloud !== undefined && cloud !== 'loading';
  const targets = rows.filter(r => ['parking1', 'parking2'].includes(r.database) && normPlate(field(r.fields, 'plate')) === normPlate(plate));
  const store = (p: Plan) => { localStorage.setItem(key, JSON.stringify(p)); setPlan({ ...p }); };
  const run = async () => {
    if (lock.current || !writable || initial.error) return;
    if (!plan) {
      const next = normPlate(newPlate);
      const message = next.length < 7 || next.length > 8 ? '请输入完整的 7 位或 8 位车牌' : next === normPlate(plate) ? '新车牌与原车牌相同' : '';
      if (message) { setPlateError(message); document.getElementById(inputId)?.focus(); return; }
    }
    lock.current = true; setBusy(true); setErr('');
    try {
      let active = plan;
      if (!active) {
        const np = normPlate(newPlate);
        if (!cloudKnown) throw new Error('人防状态未知或查询失败，请重新查询，不能当成无记录');
        if (!targets.length || targets.some(t => !pidOf(t.fields)) || new Set(targets.map(t => t.database)).size !== targets.length)
          throw new Error('旧库车辆记录缺失或不唯一，请重新查询');
        setProgress('正在按原车牌重新完整查询双库，锁定原批次来源…');
        let source = await accessCardIssuance.createParkingQuery(normPlate(plate));
        for (let i = 0; !['completed', 'failed'].includes(source.status) && i < 30; i++) { await wait(); source = await accessCardIssuance.parkingQuery(source.id); }
        if (source.status !== 'completed') throw new Error('原车牌双库查询未完成，没有提交换牌');
        const fresh = source.rows.filter(r => normPlate(field(r.fields, 'plate')) === normPlate(plate));
        if (fresh.length !== targets.length || fresh.some(r => !targets.some(t => t.database === r.database && pidOf(t.fields) === pidOf(r.fields))))
          throw new Error('原车牌来源已变化，请关闭并重新查询，没有提交换牌');
        active = { batchId: createIdempotencyKey(), sourceQueryId: source.id, plate: normPlate(plate), newPlate: np,
          targets: targets.map(t => ({ database: t.database as Target['database'], sourceRecordId: pidOf(t.fields) })),
          cloudId: cloud ? cloud.id : null };
        store(active); // before POST: lost response must reuse the same request.
      }
      const review = await request<{id:number;status:string}>({method:'POST',url:'/access-card-issuance/plate-reviews',data:{
        plate:active.plate,newPlate:active.newPlate,sourceQueryId:active.sourceQueryId,batchId:active.batchId,
      }});
      localStorage.removeItem(key); setPlan(null);
      toast(`换牌申请 #${review.id} 已登记，请在待处理查看审核进度`);
      onClose();
    } catch (e) { setErr(e instanceof Error ? e.message : '尚未确认成功；输入与原请求已保留'); }
    finally { lock.current = false; setBusy(false); setProgress(''); }
  };
  return <Sheet open onClose={() => { if (!lock.current) onClose(); }} title={`变更车牌 · ${plate}`} width={520}>
    <div style={{ display: 'grid', gap: 14, overflowWrap: 'anywhere' }}>
      <div className="note">经理审核通过后，系统按原车授权逐库换牌，并核对车位及亲情车档案。</div>
      <PlateNumberField label="新车牌" inputId={inputId} value={newPlate} invalid={!!plateError} errorMessage={plateError}
        disabled={busy || !!plan || !writable} onChange={value => { setNewPlate(value); setPlateError(''); }} />
      <div className="muted">办理来源：{(plan?.targets || targets).map(t => dbShort(t.database)).join(' + ') || '无旧库记录'}</div>
      {!cloudKnown && !plan ? <div role="alert" className="note">人防状态未知，请先重新查询；当前禁止换牌。</div> : null}
      {progress ? <div role="status" className="note">{progress}</div> : null}
      {err ? <div role="alert" className="note" style={{ color: 'var(--dang)' }}>{err}</div> : null}
      {plan ? <div className="note">原请求已保留。再次核对只使用原任务和同一幂等键；已成功来源不重复办理。明确失败请到办理记录核对处理。</div> : null}
      {!writable ? <div role="alert">当前账号没有业务编辑权限。</div> : null}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}><button className="btn p" style={{ minHeight: 44 }} disabled={busy || !writable || !!initial.error || (!plan && !cloudKnown)} onClick={() => void run()}>{busy ? '现场核对中…' : plan ? '核对原请求（不重复办理）' : '提交经理审核'}</button><button className="btn" style={{ minHeight: 44 }} disabled={busy} onClick={onClose}>关闭</button></div>
    </div>
  </Sheet>;
}
