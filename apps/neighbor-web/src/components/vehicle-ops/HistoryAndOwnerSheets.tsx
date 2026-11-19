import './vehicle-type-sheet.css';
import { formatBeijingDateTime } from '@pms/shared-types';
import { useEffect, useState } from 'react';
import { accessCardIssuance, request } from '@pms/api-client';
import type {
  ParkingQueryRow, DeliyunVehicle, ParkingHistoryEntry,
} from '@pms/api-client/src/endpoints/access-card-issuance';
import { Sheet, toast } from '@/components/ui';
import Icon from '@/components/Icon';
import HousePicker, { type PickedHouse } from '@/components/HousePicker';
import { useAddressTree } from '@/lib/address-tree';
import { dayjs } from '@/lib/format';
import { field } from '@/lib/parking-fields';
import { createIdempotencyKey, pidOf, dbShort, freshRows } from '@/lib/parking-ops';

type CloudState = 'loading' | DeliyunVehicle | null | undefined;

interface OpProps {
  plate: string;
  rows: ParkingQueryRow[];
  cloud?: CloudState;
  onClose: () => void;
  onDone: (requeryTerm?: string) => void;
}

const targetsOf = (rows: ParkingQueryRow[]) => rows.filter((r) => r.database === 'parking1' || r.database === 'parking2');
const externalOwnerOf = (r: ParkingQueryRow) => r.historyRef?.externalOwnerId || field(r.fields, 'ownerId') || '';
const roomOf = (r: ParkingQueryRow) => field(r.fields, 'room', true) || '';
const phoneOf = (r: ParkingQueryRow) => field(r.fields, 'phone', true) || '';
const noteOf = (r: ParkingQueryRow) => field(r.fields, 'note') || '';

const EVENT_LABEL: Record<string, string> = {
  plate_change: '变更车牌',
  owner_rebind: '变更绑定用户',
  owner_info_update: '更新住户资料',
  vehicle_added: '新增车辆',
  vehicle_renewed: '续期',
  garage_authorization: '调整车库授权',
  vehicle_type_update: '修改授权类型',
  vehicle_deleted: '注销车辆',
  vehicle_download: '下发设备',
  vehicle_sync: '同步',
};

/** 车牌 / 住户的变更历史（旧停车系统 Up_Issue + PMS 写操作记录） */
export function HistorySheet({ plate, rows, onClose }: OpProps) {
  const [entries, setEntries] = useState<{ vehicle: ParkingHistoryEntry[]; owner: ParkingHistoryEntry[] }>({vehicle:[], owner:[]});
  const [tab, setTab] = useState<'vehicle' | 'owner'>('vehicle');
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    async function load() {
      setBusy(true); setError('');
      const warnings = new Set<string>();
      let sources = targetsOf(rows);
      if (sources.length && (attempt || sources.some(r => r.fields.PmsMeta__PlateHistory == null))) {
        try { sources = await freshRows(plate); }
        catch { warnings.add('旧库流水未能刷新'); }
      }
      const vehicle = new Map<string, ParkingHistoryEntry>();
      const owner = new Map<number, ParkingHistoryEntry>();
      const local = new Map<string, ParkingHistoryEntry>();
      const eventKey = (e: ParkingHistoryEntry) => JSON.stringify([e.database,e.sourceRecordId,e.plateAfter,Date.parse(e.occurredAt)]);
      const refs = sources.length ? sources : [null];
      for (const row of refs) {
        if (!active) return;
        const ref = row?.historyRef;
        const database = row?.database ?? null;
        const sourceRecordId = ref?.sourceRecordId || (row && pidOf(row.fields)) || null;
        try {
          const result = await accessCardIssuance.parkingHistory({plate,database,sourceRecordId,
            externalOwnerId:ref?.externalOwnerId || (row && externalOwnerOf(row)) || null,
            pmsUserId:ref?.pmsUserId || row?.pmsMatch?.userId || null});
          for (const item of result.vehicleHistory) vehicle.set(String(item.id), item);
          for (const item of result.userHistory) owner.set(item.id, item);
        } catch { warnings.add('PMS 历史未能加载'); }
        if (!row) continue;
        const raw = row.fields.PmsMeta__PlateHistory;
        try {
          if (typeof raw !== 'string') warnings.add('现场助手尚未返回旧库明细');
          const events = typeof raw === 'string' ? JSON.parse(raw) : row.fields.PmsMeta__PlateChangedAt
            ? [{at:row.fields.PmsMeta__PlateChangedAt,after:plate}] : [];
          if (events.length === 100) warnings.add('每个停车库最多显示最近 100 条流水');
          for (const e of events) {
            if (!e.after || !Number.isFinite(Date.parse(e.at))) continue;
            const item: ParkingHistoryEntry = { id:0,eventType:'plate_change',source:'parking_gateway',database,sourceRecordId,
              pmsUserId:null,externalOwnerId:null,plateBefore:e.before || null,plateAfter:e.after,summary:'旧停车系统换牌',
              changes:[],operator:typeof e.operatorName === 'string' ? e.operatorName : '',occurredAt:e.at,timeBasis:'operation' };
            local.set(eventKey(item),item);
          }
        } catch { warnings.add('旧库流水格式异常'); }
      }
      for (const item of vehicle.values()) {
        if (item.eventType === 'plate_change' && item.timeBasis === 'operation') local.delete(eventKey(item));
      }
      const newest = (a: ParkingHistoryEntry,b: ParkingHistoryEntry) => Date.parse(b.occurredAt)-Date.parse(a.occurredAt) || b.id-a.id;
      if (active) {
        setEntries({vehicle:[...vehicle.values(),...local.values()].sort(newest),owner:[...owner.values()].sort(newest)});
        setError([...warnings].join('；')); setBusy(false);
      }
    }
    void load();
    return () => { active = false; };
  },[plate,rows,attempt]);
  return <Sheet open onClose={onClose} title="变更历史" subtitle={plate} width={540}>
    <div className="veh-history-tabs">
      <button className="btn" aria-pressed={tab==='vehicle'} onClick={() => setTab('vehicle')}>车辆记录</button>
      <button className="btn" aria-pressed={tab==='owner'} onClick={() => setTab('owner')}>住户记录</button>
      <button className="btn sm" disabled={busy} onClick={() => setAttempt(n=>n+1)}>刷新</button>
    </div>
    {busy ? <p role="status">正在读取变更记录…</p> : <>
      {error && <p role="status" className="muted">{error}</p>}
      {!entries[tab].length && <p className="muted">{error ? '暂无可展示的记录' : '暂无变更记录'}</p>}
      {entries[tab].map((h,i) => <details className="veh-history-event" key={h.id || i+'-legacy'}>
        <summary><b>{EVENT_LABEL[h.eventType] || h.eventType}</b>
          <span>{[h.plateBefore,h.plateAfter].filter((v,j,a)=>v && a.indexOf(v)===j).join(' → ') || h.summary}</span>
          <small>{h.source==='parking_gateway' ? '旧停车系统' : 'PMS'} · {h.database ? dbShort(h.database)+' · ' : ''}
            {h.timeBasis==='detected' ? '发现于 ' : ''}{formatBeijingDateTime(h.occurredAt,'YYYY-MM-DD HH:mm')}</small></summary>
        {h.summary && <p>{h.summary}</p>}
        {h.operator && <p>{h.operator}</p>}
        {h.changes.map((c,j)=><p key={j}>{c.label}　{c.before || '—'} → {c.after || '—'}</p>)}
      </details>)}
    </>}
  </Sheet>;
}

/** 更新旧停车系统住户资料：从 PMS 房号带出姓名/电话/房号，写回旧库并读回验证 */
export function OwnerInfoSheet({ plate, rows, onClose, onDone }: OpProps) {
  const targets = targetsOf(rows);
  const { communities } = useAddressTree();
  const [picked, setPicked] = useState<PickedHouse | null>(null);
  const [room, setRoom] = useState(roomOf(targets[0]));
  const [name, setName] = useState('');
  const [phone, setPhone] = useState(phoneOf(targets[0]));
  const [note, setNote] = useState(noteOf(targets[0]));
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!picked) return;
    if (picked.ownerName) setName(picked.ownerName);
    if (picked.ownerPhone) setPhone(picked.ownerPhone);
    setRoom(`${picked.lane || ''}/${picked.buildingNo}/${picked.roomNo}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picked?.houseId]);

  const missingOwnerId = targets.filter((t) => !externalOwnerOf(t));

  const run = async () => {
    setErr('');
    if (!targets.length) { setErr('这张车牌不在一期/二期旧库里'); return; }
    if (missingOwnerId.length) { setErr(`${missingOwnerId.map((t) => dbShort(t.database)).join('、')} 读不到住户编号，无法写回，请在旧页处理`); return; }
    if (!room.trim()) { setErr('请填写房号'); return; }
    setRunning(true); setLog([]);
    for (const t of targets) {
      const label = dbShort(t.database);
      setLog((l) => [...l, `正在写 ${label} …`]);
      try {
        const created = await accessCardIssuance.createParkingOwnerUpdate({
          database: t.database as 'parking1' | 'parking2',
          externalOwnerId: externalOwnerOf(t),
          plate,
          pmsUserId: picked?.ownerId ?? t.pmsMatch?.userId ?? null,
          idempotencyKey: createIdempotencyKey(),
          expected: { name: null, phone: phoneOf(t) || null, room: roomOf(t) || null, note: noteOf(t) || null },
          values: { name: name.trim() || null, phone: phone.trim() || null, room: room.trim() || null, note: note.trim() || null },
        });
        let task = created;
        for (let i = 0; i < 112 && (task.status === 'pending' || task.status === 'running'); i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 800));
          task = await accessCardIssuance.parkingOwnerUpdate(created.id);
        }
        if (task.status === 'completed') setLog((l) => [...l, `✓ ${label} 已更新并读回验证`]);
        else { setErr(`${label} 更新失败：${task.error || '现场助手未完成'}`); setRunning(false); return; }
      } catch (e) {
        setErr(`${label} 更新失败：${e instanceof Error ? e.message : '失败'}`);
        setRunning(false);
        return;
      }
    }
    toast('旧停车系统住户资料已更新');
    onDone();
  };

  return (
    <Sheet open onClose={() => (running ? null : onClose())} width={560}
      title={`更新旧库住户资料 · ${plate}`}
      subtitle={targets.map((t) => dbShort(t.database)).join(' + ')}>
      <div style={{ padding: '4px 2px' }}>
        <div className="note" style={{ marginBottom: 12, fontSize: 13 }}>房号和电话从 PMS 业主档案带出，写入旧停车系统后由现场助手读回验证。不会改到期日、收费类型和车库授权。</div>
        <div className="muted" style={{ fontSize: 13, marginBottom: 6 }}>从 PMS 房号带出（可选）</div>
        <HousePicker communities={communities} value={picked} placeholder="输入 228/4/501 或业主姓名" onPick={setPicked} onClear={() => setPicked(null)} />
        <div style={{ height: 12 }} />
        <div className="veh-dl" style={{ gridTemplateColumns: 'auto 1fr', gap: '10px 12px' }}>
          <dt className="muted">旧库房号</dt>
          <dd><input className="in" value={room} onChange={(e) => setRoom(e.target.value)} placeholder="198/6/501" style={{ width: 180 }} /></dd>
          <dt className="muted">住户姓名</dt>
          <dd><input className="in" value={name} onChange={(e) => setName(e.target.value)} style={{ width: 180 }} /></dd>
          <dt className="muted">电话</dt>
          <dd><input className="in" value={phone} onChange={(e) => setPhone(e.target.value)} style={{ width: 180 }} /></dd>
          <dt className="muted">备注</dt>
          <dd><input className="in" value={note} onChange={(e) => setNote(e.target.value)} style={{ width: '100%' }} placeholder="可留空" /></dd>
        </div>
        {missingOwnerId.length ? <div className="note" style={{ background: 'var(--warn-w)', color: 'var(--warn)', margin: '10px 0', fontSize: 13 }}>{missingOwnerId.map((t) => dbShort(t.database)).join('、')} 读不到住户编号，无法在本页写回</div> : null}
        {log.length ? <div className="card" style={{ padding: '10px 12px', margin: '12px 0', background: 'var(--bg)' }}>{[...log].reverse().map((l, i) => <div key={i} style={{ fontSize: 13, lineHeight: 1.9 }}>{l}</div>)}</div> : null}
        {err ? <div className="note" style={{ background: 'var(--dang-w)', color: 'var(--dang)', margin: '12px 0' }}>{err}</div> : null}
        <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
          <button className="btn p" style={{ flex: 1 }} disabled={running || !!missingOwnerId.length} onClick={() => void run()}>
            <Icon name="users" size={16} />{running ? '现场写入中…' : '写入旧库并读回'}
          </button>
          <button className="btn" disabled={running} onClick={onClose}>取消</button>
        </div>
      </div>
    </Sheet>
  );
}

/** 旧库有这个住户、PMS 里没有业主档案：一键补建 PMS 业主 */
export function CreatePmsOwnerSheet({ plate, rows, onClose, onDone }: OpProps) {
  const targets = targetsOf(rows);
  const { communities } = useAddressTree();
  const [picked, setPicked] = useState<PickedHouse | null>(null);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState(phoneOf(targets[0]));
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState('');

  const existingPms = targets.find((t) => t.pmsMatch?.userId)?.pmsMatch;
  const oldRoom = roomOf(targets[0]) || '—';

  useEffect(() => {
    if (!picked) return;
    if (picked.ownerName && !name) setName(picked.ownerName);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picked?.houseId]);

  const run = async () => {
    setErr('');
    if (!picked?.houseId) { setErr('请从 PMS 房号里选一套房'); return; }
    if (!name.trim()) { setErr('请填写业主姓名'); return; }
    if (!phone.trim()) { setErr('请填写手机号'); return; }
    setRunning(true);
    try {
      await request({
        method: 'POST', url: '/owners-mgmt',
        data: {
          name: name.trim(), phone: phone.trim(), houseId: picked.houseId,
          contactNote: `旧停车系统 ${oldRoom}（车牌 ${plate}）`,
        },
      });
      toast('已补建 PMS 业主档案');
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : '创建失败');
      setRunning(false);
    }
  };

  return (
    <Sheet open onClose={() => (running ? null : onClose())} width={540}
      title={`补建 PMS 业主 · ${plate}`} subtitle={`旧库房号 ${oldRoom}`}>
      <div style={{ padding: '4px 2px' }}>
        {existingPms ? (
          <div className="note" style={{ background: 'var(--warn-w)', color: 'var(--warn)', marginBottom: 12, fontSize: 13 }}>
            这辆车在 PMS 已经匹配到业主「{existingPms.name || '#' + existingPms.userId}」，不用重复建。要去改资料请到「业主」页。
          </div>
        ) : (
          <div className="note" style={{ marginBottom: 12, fontSize: 13 }}>旧停车系统有这个住户，但 PMS 里还没建档。选一套 PMS 房号、确认姓名电话即可补建；不会改动旧库数据。</div>
        )}
        {!existingPms ? (
          <>
            <div className="muted" style={{ fontSize: 13, marginBottom: 6 }}>绑定到哪套房</div>
            <HousePicker communities={communities} value={picked} placeholder="输入 228/4/501 或业主姓名" onPick={setPicked} onClear={() => setPicked(null)} />
            <div style={{ height: 12 }} />
            <div className="veh-dl" style={{ gridTemplateColumns: 'auto 1fr', gap: '10px 12px' }}>
              <dt className="muted">姓名</dt>
              <dd><input className="in" value={name} onChange={(e) => setName(e.target.value)} style={{ width: 180 }} placeholder="业主姓名" /></dd>
              <dt className="muted">手机号</dt>
              <dd><input className="in" value={phone} onChange={(e) => setPhone(e.target.value)} style={{ width: 180 }} placeholder="13900001111" /></dd>
            </div>
          </>
        ) : null}
        {err ? <div className="note" style={{ background: 'var(--dang-w)', color: 'var(--dang)', margin: '12px 0' }}>{err}</div> : null}
        <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
          {!existingPms ? (
            <button className="btn p" style={{ flex: 1 }} disabled={running} onClick={() => void run()}>
              <Icon name="plus" size={16} />{running ? '创建中…' : '补建业主档案'}
            </button>
          ) : null}
          <button className="btn" disabled={running} onClick={onClose}>{existingPms ? '知道了' : '取消'}</button>
        </div>
      </div>
    </Sheet>
  );
}
